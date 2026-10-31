// Tier 1 of docs/design/ios-visual-testing.md. Evidence, not a gate: probe
// failures are reported, never fatal; no screenshot at all is fatal.
//
//   local: the QA=1 local bundle in WebKit at the two Simulator widths, plus
//          Chromium at desktop 1280x800 and Pixel 7.
//     QA=1 ios/bundle-web.sh ci && node tests/visual/playwright/run.mjs [outDir]
//     WG_QA_SCENES=meds-take-reminder-hint,trial-consent node ... [outDir]
//       selects exact eligible scene names; an unset filter keeps the full run.
//     node tests/visual/playwright/run.mjs --list-scenes
//       validates/list scenes without Playwright or starting a browser/server.
//   cloud: the real cmd/cloud (CLOUD_BIN) on *.localhost, one fresh account per
//          device signed up with Chromium's virtual PRF authenticator; the
//          driver is injected by addInitScript, never served by the cloud.
//     CLOUD_BIN=/tmp/cloud node tests/visual/playwright/run.mjs [outDir] cloud
//
// What it cannot show (Linux WebKit is not WKWebView): focus-zoom, the software
// keyboard and the visualViewport shrink/pan it causes, safe-area insets and
// the shell's native bands, iOS fonts. med-pe9g would not have shown up here.
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../../..');
const root = join(repo, 'ios/LocalApp');
const out = resolve(process.argv[2] || 'visual-web');
const mode = process.argv[3] || 'local';
const listOnly = process.argv.includes('--list-scenes');
if (!listOnly) await mkdir(out, { recursive: true });

// LocalOrigin.file(for:) routing and mime(), plus the shell's CSP with no hosts.
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; worker-src 'self'; media-src 'self'; "
  + "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
function fileFor(path) {
  if (!path.startsWith('/') || path.split('/').some((p) => p === '..' || p === '.')) return null;
  if (path === '/') return 'index.html';
  if (path.endsWith('/')) return null;
  if (path.startsWith('/static/') || path.startsWith('/domain/')) return path.slice(1);
  return 'cloud' + path;
}
const server = createServer(async (req, res) => {
  const file = fileFor(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  try {
    if (!file) throw new Error('bad path');
    const body = await readFile(join(root, file));
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'content-security-policy': CSP, 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});

// The iOS shell's wgNative reply handler (ios/App/Shell.swift), so
// native/index.js picks 'ios' and the page takes the shell's code paths
// (noFocusZoom, local egress, local reminders).
function nativeStub() {
  const reply = (op) => {
    if (op === 'ping') return 'pong';
    if (op === 'setEgressHosts') return { changed: false };
    if (op === 'local.reset' || op === 'local.leave' || op === 'notifications.test') return true;
    if (op === 'notifications.permission' || op === 'notifications.requestPermission') return 'granted';
    if (op === 'notifications.schedule') return 0;
    throw new Error(`unsupported: ${op}`); // health.*, attest.*, the rest
  };
  const wgNative = { postMessage: (m) => new Promise((ok) => ok(reply(m && m.op))) };
  Object.defineProperty(window, 'webkit', { configurable: true, value: { messageHandlers: { wgNative } } });
}

const { scenes } = JSON.parse(await readFile(join(repo, 'tests/visual/scenes.json'), 'utf8'));
const nativeOnly = (s) => (s.nativeOnly !== undefined ? s.nativeOnly : s.name.startsWith('native-'));
const eligible = scenes.filter((s) => !nativeOnly(s) && !s.requiresNativeHealth
  && !(mode === 'cloud' ? s.localOnly : s.cloudOnly));
const requested = process.env.WG_QA_SCENES;
let selected = scenes;
if (requested !== undefined) {
  const names = requested.split(',').map((name) => name.trim());
  if (names.some((name) => !name)) throw new Error('WG_QA_SCENES contains an empty scene name');
  const invalid = names.filter((name) => !eligible.some((s) => s.name === name));
  if (invalid.length) throw new Error(`WG_QA_SCENES contains unknown or ineligible scenes: ${invalid.join(', ')}`);
  selected = scenes.filter((s) => names.includes(s.name));
}
if (listOnly) {
  console.log(JSON.stringify(selected.filter((s) => eligible.includes(s)).map((s) => s.name)));
  process.exit(0);
}
const { webkit, chromium, devices } = await import('playwright');
const DESKTOP = { viewport: { width: 1280, height: 800 }, screen: { width: 1280, height: 800 }, deviceScaleFactor: 1 };
const DEVICES = mode === 'cloud' ? {
  'cloud-desktop-1280': [chromium, DESKTOP],
  'cloud-pixel-7': [chromium, devices['Pixel 7']],
} : {
  'iphone-390': [webkit, { ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 3 }],
  'iphone-440': [webkit, { ...devices['iPhone 13'], viewport: { width: 440, height: 956 }, screen: { width: 440, height: 956 }, deviceScaleFactor: 3 }],
  'desktop-1280': [chromium, DESKTOP],
  'pixel-7': [chromium, devices['Pixel 7']],
};

// Web stand-ins for the scene's XCUITest steps: a click and typed text, no
// software keyboard (so `keyboard` is a no-op and keyboardShown stays false).
async function nativeSteps(page, steps) {
  let target = null;
  for (const s of steps) {
    if (s.tap) {
      target = page.locator(s.tap).or(page.getByPlaceholder(s.placeholder || '\u0000')).first();
      await target.click();
    } else if (s.type) await page.keyboard.type(s.type);
    else if (s.clear) await target.fill('');
    // keyboard / tapButton / waitFor: nothing to emulate in a web scene.
  }
  await page.waitForTimeout(600); // the driver re-publishes 150 ms after focus/input
}

// --- cloud mode -----------------------------------------------------------
// The real server on *.localhost (Chromium resolves it to loopback, and it is a
// secure context, so WebAuthn and Secure cookies work over plain http — the
// local dev loop of docs/cloud-mode.md). No external services: no food DB, no
// Telegram, no trial keys.
const PORT = process.env.CLOUD_PORT || '18080';
// Placeholder store ids so the invite landing renders its "Get the app" buttons.
const cloudEnv = { ...process.env, CLOUD_BASE_DOMAIN: 'localhost', PORT, CLOUD_DB_PATH: join(tmpdir(), `visual-cloud-${process.pid}.db`),
  SESSION_SECRET: randomBytes(32).toString('base64'), IOS_APP_STORE_ID: '1234567890', ANDROID_PACKAGE: 'com.example.medtracker' };
async function startCloud() {
  const bin = process.env.CLOUD_BIN;
  if (!bin) throw new Error('CLOUD_BIN is required in cloud mode');
  const log = createWriteStream(join(out, 'cloud-server.log'));
  const proc = spawn(bin, [], { env: cloudEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.pipe(log); proc.stderr.pipe(log);
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error(`cmd/cloud exited ${proc.exitCode} (see cloud-server.log)`);
    try { await fetch(`http://localhost:${PORT}/`); return proc; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('cmd/cloud did not start listening');
}

// `cloud admin invite` against the same DB; its claim URL is the landing form
// https://localhost/i/<sub>#<t> (bd med-ta2n.16).
function mintInvite() {
  const text = execFileSync(process.env.CLOUD_BIN, ['admin', 'invite'], { env: cloudEnv, encoding: 'utf8' });
  const m = /https:\/\/localhost\/i\/([a-z0-9-]+)#([a-f0-9]+)/.exec(text);
  if (!m) throw new Error(`no claim URL in: ${text.slice(0, 200)}`);
  return { sub: m[1], origin: `http://${m[1]}.localhost:${PORT}`, token: m[2] };
}

// The base-domain invite landing (bd med-ta2n.10): L1 on iPhone 390 (WebKit)
// and Pixel 7, L3 (the per-tab flag "Get the app" sets — the tap itself would
// leave for the App Store), L2 on desktop, and the expired state. Shots land in
// <out>/invite/; nothing is tapped that leaves the page.
async function inviteLandingShots() {
  const { sub, token } = mintInvite();
  const landing = `http://localhost:${PORT}/i/${sub}#${token}`;
  await mkdir(join(out, 'invite'), { recursive: true });
  const targets = {
    'iphone-390': [webkit, { ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 3 }],
    'pixel-7': [chromium, devices['Pixel 7']],
    'desktop-1280': [chromium, DESKTOP],
  };
  for (const [device, [engine, desc]] of Object.entries(targets)) {
    const browser = await engine.launch();
    const context = await browser.newContext({ ...desc, colorScheme: 'dark', locale: 'en-US', timezoneId: 'Europe/Berlin' });
    const page = await context.newPage();
    const shot = async (scene, url, ready, before) => {
      const row = { device, scene, status: 'ok' };
      try {
        if (before) await before();
        // Same URL again is a fragment-only navigation (no reload): reload.
        if (url) await page.goto(url);
        else await page.reload();
        await page.locator(ready).waitFor({ timeout: 30000 });
        await page.waitForTimeout(300);
      } catch (e) {
        row.status = 'error';
        row.note = String(e.message || e).split('\n')[0];
      }
      try { await page.screenshot({ path: join(out, 'invite', `${device}-${scene}.png`) }); shots++; } catch { /* page gone */ }
      rows.push(row);
      console.log(`${device} ${scene}: ${row.status} ${row.note || ''}`);
    };
    await shot('invite-l1', landing, '#invite-browser');
    if (device === 'iphone-390') {
      await shot('invite-l3', null, '#invite-open',() => page.evaluate((s) => sessionStorage.setItem(`mt-invite-l3:${s}`, '1'), sub));
    }
    await shot('invite-expired', `http://localhost:${PORT}/i/no-such-invite#00`, '#invite-ask');
    // The add-device hand-off (bd med-r1j2.4, AD8 / AD8 · desktop, then AD8 ·
    // no code): static, so any sub renders it; the code is a placeholder.
    const handoff = `http://localhost:${PORT}/d/${sub}`;
    await shot('handoff-ad8', `${handoff}#AbC_d-1234567890123456.QUJDREVGR0hJSktMTU5PUA`,
      device === 'desktop-1280' ? '#handoff-continue:not([disabled])' : '#handoff-browser');
    await shot('handoff-no-code', handoff, '#handoff-code');
    // /claim's in-app Scan with the camera denied (bd med-r1j2.10, AD13): the
    // page's getUserMedia answers NotAllowedError, as after a refused prompt.
    // Last: the init script stays on this page. Chromium only: it resolves
    // the account host <sub>.localhost to loopback.
    if (engine === chromium) {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true,
          value: { getUserMedia: () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) } });
      });
      await shot('claim-camera-denied', `http://${sub}.localhost:${PORT}/claim#scan`, '#claim-camera-off');
    }
    await context.close();
    await browser.close();
  }
}

// The signup wizard as a person runs it (e2e/vault-roundtrip.mjs's flow): claim
// (with &kit=1, as from Settings) → sign in (PRF passkey) → Emergency Kit offer
// → vault open. The authenticator is per page (CDP), so the cloud run keeps one
// page per device. shot(name) captures the two ceremony screens (bd med-ta2n.8).
async function cloudSignup(context, page, shot) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal',
    hasResidentKey: true, hasUserVerification: true, hasPrf: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const { origin, token } = mintInvite();
  await page.goto(`${origin}/#claim=${token}&kit=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/unlock/, { timeout: 30000 });
  await page.locator('#create-passkey').waitFor({ timeout: 30000 });
  await shot('signup-signin');
  await page.click('#create-passkey', { timeout: 30000 });
  // The W5 kit offer: Save kit, then Done (an offer, no acknowledgement).
  await page.locator('#kit-done').waitFor({ timeout: 30000 });
  await shot('signup-kit-offer');
  const download = page.waitForEvent('download').catch(() => null);
  await page.click('#kit-download');
  await download;
  await page.click('#kit-done');
  const skip = page.locator('#install-skip');
  await page.waitForFunction(() => Boolean(window.MedTrackerCloudReady) || document.querySelector('#install-skip'), null, { timeout: 60000 });
  if (await skip.count()) await skip.click();
  await page.waitForFunction(() => Boolean(window.MedTrackerCloudReady), null, { timeout: 60000 });
  await page.evaluate(() => window.MedTrackerCloudReady);
  if (!(await page.evaluate(() => Boolean(window.MedTrackerCloud && window.MedTrackerCloud.ctx)))) throw new Error('signup did not open the vault');
  return origin;
}

// The driver, its scene list and the golden vault, injected rather than served:
// the cloud never carries /qa/*. __wgQACloud lets the driver seed a non-local
// vault (a fresh, empty test account only — the driver still refuses to import
// over content).
const driverInit = mode === 'cloud' ? [
  'window.__wgQACloud = true;',
  `window.__wgQAFiles = ${JSON.stringify({
    '/qa/scenes.json': JSON.parse(await readFile(join(repo, 'tests/visual/scenes.json'), 'utf8')),
    '/qa/vault-v1.json': JSON.parse(await readFile(join(repo, 'tests/fixtures/vault-v1.json'), 'utf8')),
  })};`,
  await readFile(join(repo, 'tests/visual/driver.js'), 'utf8'),
].join('\n') : null;

let base = null;
let cloud = null;
if (mode === 'cloud') cloud = await startCloud();
else {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}

const browsers = new Map();
const rows = [];
let shots = 0;
if (mode === 'cloud' && requested === undefined) await inviteLandingShots();
for (const [device, [engine, desc]] of Object.entries(DEVICES)) {
  if (!browsers.has(engine)) browsers.set(engine, await engine.launch());
  const browser = browsers.get(engine);
  await mkdir(join(out, device), { recursive: true });
  // One context per device: the first scene seeds the vault (the driver
  // imports it and reloads), every later scene opens on the seeded store.
  // reducedMotion: the app's prefers-reduced-motion rules settle chart draw-ins
  // and pulses, so a shot never catches a line mid-draw (med-ipps); it is a media
  // emulation, so unlike injected screenshot styles the page CSP can't refuse it.
  const context = await browser.newContext({ ...desc, colorScheme: 'dark', reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'Europe/Berlin', acceptDownloads: true });
  if (mode === 'cloud') await context.addInitScript(driverInit);
  else await context.addInitScript(nativeStub);
  // One page per device, so the virtual authenticator (cloud) outlives scenes.
  // A crashed page is replaced before the next scene (bd med-y5xx.14): the
  // crashed scene reports its error, the rest still run on the same context
  // (the seeded store survives). A replacement page has no authenticator.
  let page = null;
  let crashed = false;
  let errors = [];
  const openPage = async () => {
    page = await context.newPage();
    crashed = false;
    page.on('crash', () => { crashed = true; });
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  };
  await openPage();
  let appBase = base;
  if (mode === 'cloud') {
    try {
      appBase = await cloudSignup(context, page, async (name) => {
        await page.screenshot({ path: join(out, device, `${name}.png`) });
        shots++;
      });
    } catch (e) {
      // A harness break (admin invite printed no claim URL) must fail the run,
      // not leave an "error" row and skip every cloud scene silently.
      if (String(e && e.message).startsWith('no claim URL')) throw e;
      rows.push({ device, scene: 'signup', status: 'error', note: String(e.message || e).split('\n')[0] });
      try { await page.screenshot({ path: join(out, device, 'signup.png') }); shots++; } catch { /* page gone */ }
      await context.close();
      continue;
    }
  }
  for (const scene of selected) {
    if (nativeOnly(scene) || scene.requiresNativeHealth) {
      rows.push({ device, scene: scene.name, status: 'skipped', note: 'native-only (SwiftUI screen, Simulator tier only)' });
      continue;
    }
    if (mode === 'cloud' && scene.localOnly) {
      rows.push({ device, scene: scene.name, status: 'skipped', note: 'local-only (a local-mode control)' });
      continue;
    }
    if (mode !== 'cloud' && scene.cloudOnly) {
      rows.push({ device, scene: scene.name, status: 'skipped', note: 'cloud-only (an account control)' });
      continue;
    }
    // Not page.close(): on a crashed WebKit page it never resolves. The dead
    // page goes with context.close().
    if (crashed) await openPage();
    errors = [];
    const row = { device, scene: scene.name };
    let report = null;
    try {
      // Leave the last scene's document through about:blank: Playwright's
      // WebKit dies on a libstdc++ assertion (std::optional, not engaged) when
      // the app navigates straight to itself from some states (after
      // meds-timeline-pending, earlier after journey); the hop never crashes.
      await page.goto('about:blank');
      await page.goto(`${appBase}/?qa=${encodeURIComponent(scene.name)}${scene.clock ? `&clock=${encodeURIComponent(scene.clock)}` : ''}`);
      const ready = page.locator('#wg-qa-ready');
      await ready.waitFor({ state: 'attached', timeout: 90000 }); // survives the seed's reload
      if (scene.native && scene.native.length) await nativeSteps(page, scene.native);
      report = JSON.parse(await ready.getAttribute('aria-label'));
      row.status = report.error ? 'error' : report.ok ? 'ok' : 'probe';
      row.note = report.error || (report.failed || []).join(', ');
    } catch (e) {
      row.status = 'error';
      row.note = String(e.message || e).split('\n')[0];
    }
    // A shot even on error: an empty or stuck page is itself evidence.
    // Errors the screenshot itself triggers (Playwright's injected styles vs
    // the CSP) are kept apart from the app's.
    const pre = errors.length;
    for (const [suffix, fullPage] of [['', false], ['.full', true]]) {
      try {
        await page.screenshot({ path: join(out, device, `${scene.name}${suffix}.png`), fullPage, caret: 'initial' }); // no injected <style>: the page's CSP refuses it
        shots++;
      } catch (e) {
        row.note = `${row.note || ''} screenshot failed: ${e.message}`.trim();
      }
    }
    await writeFile(join(out, device, `${scene.name}.json`), JSON.stringify({ ...report, consoleErrors: errors.slice(0, pre), screenshotErrors: errors.slice(pre) }, null, 2));
    if (pre) row.note = `${row.note ? row.note + '; ' : ''}${pre} console error(s)`;
    rows.push(row);
    console.log(`${device} ${scene.name}: ${row.status} ${row.note || ''}`);
  }
  await context.close();
}
for (const b of browsers.values()) await b.close();
server.close();
if (cloud) cloud.kill();

const md = [
  mode === 'cloud' ? '## Web visual — cloud mode (cmd/cloud + Chromium)' : '## Web visual — QA local bundle (WebKit iPhone, Chromium desktop / Pixel 7)', '',
  'Evidence only: no focus-zoom, software keyboard, visualViewport shrink, safe areas or iOS fonts in this tier (see docs/design/ios-visual-testing.md).', '',
  '| device | ok | probe | error | skipped |', '|---|---|---|---|---|',
  ...Object.keys(DEVICES).map((d) => {
    const n = (st) => rows.filter((r) => r.device === d && r.status === st).length;
    return `| ${d} | ${n('ok')} | ${n('probe')} | ${n('error')} | ${n('skipped')} |`;
  }), '',
  '| device | scene | status | notes |', '|---|---|---|---|',
  ...rows.map((r) => `| ${r.device} | ${r.scene} | ${r.status} | ${(r.note || '').replace(/\|/g, '\\|')} |`), '',
  `${shots} screenshot(s) in artifact \`${mode === 'cloud' ? 'visual-web-cloud' : 'ios-visual-web'}\`.`,
].join('\n');
await writeFile(join(out, 'summary.md'), md + '\n');
await writeFile(join(out, 'summary.json'), JSON.stringify(rows, null, 2));
for (const r of rows) if (r.status === 'probe' || r.status === 'error') console.log(`::warning title=${r.scene} (${r.device})::${r.status}: ${r.note}`);
if (!shots) { console.error('no screenshots'); process.exit(1); }
