// Tier 1 of docs/design/ios-visual-testing.md: the QA=1 local bundle in
// Playwright WebKit at the two Simulator widths, on Linux. Evidence, not a gate:
// probe failures are reported, never fatal; no screenshot at all is fatal.
//
//   QA=1 ios/bundle-web.sh ci && node tests/visual/playwright/run.mjs [outDir]
//
// What it cannot show (Linux WebKit is not WKWebView): focus-zoom, the software
// keyboard and the visualViewport shrink/pan it causes, safe-area insets and
// the shell's native bands, iOS fonts. med-pe9g would not have shown up here.
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { webkit, devices } from 'playwright';

const repo = resolve(import.meta.dirname, '../../..');
const root = join(repo, 'ios/LocalApp');
const out = resolve(process.argv[2] || 'visual-web');

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
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

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

const DEVICES = {
  'iphone-390': { ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 3 },
  'iphone-440': { ...devices['iPhone 13'], viewport: { width: 440, height: 956 }, screen: { width: 440, height: 956 }, deviceScaleFactor: 3 },
};

const { scenes } = JSON.parse(await readFile(join(repo, 'tests/visual/scenes.json'), 'utf8'));
const nativeOnly = (s) => (s.nativeOnly !== undefined ? s.nativeOnly : s.name.startsWith('native-'));

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

const browser = await webkit.launch();
const rows = [];
let shots = 0;
for (const [device, desc] of Object.entries(DEVICES)) {
  await mkdir(join(out, device), { recursive: true });
  // One context per device: the first scene seeds the vault (the driver
  // imports it and reloads), every later scene opens on the seeded store.
  const context = await browser.newContext({ ...desc, colorScheme: 'dark', locale: 'en-US', timezoneId: 'Europe/Berlin' });
  await context.addInitScript(nativeStub);
  for (const scene of scenes) {
    if (nativeOnly(scene)) {
      rows.push({ device, scene: scene.name, status: 'skipped', note: 'native-only (SwiftUI screen, Simulator tier only)' });
      continue;
    }
    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    const row = { device, scene: scene.name };
    try {
      await page.goto(`${base}/?qa=${encodeURIComponent(scene.name)}`);
      const ready = page.locator('#wg-qa-ready');
      await ready.waitFor({ state: 'attached', timeout: 90000 }); // survives the seed's reload
      if (scene.native && scene.native.length) await nativeSteps(page, scene.native);
      const report = JSON.parse(await ready.getAttribute('aria-label'));
      row.status = report.error ? 'error' : report.ok ? 'ok' : 'probe';
      row.note = report.error || (report.failed || []).join(', ');
      await writeFile(join(out, device, `${scene.name}.json`), JSON.stringify({ ...report, consoleErrors: errors }, null, 2));
    } catch (e) {
      row.status = 'error';
      row.note = String(e.message || e).split('\n')[0];
    }
    // A shot even on error: an empty or stuck page is itself evidence.
    for (const [suffix, fullPage] of [['', false], ['.full', true]]) {
      try {
        await page.screenshot({ path: join(out, device, `${scene.name}${suffix}.png`), fullPage, animations: 'disabled' });
        shots++;
      } catch (e) {
        row.note = `${row.note || ''} screenshot failed: ${e.message}`.trim();
      }
    }
    if (errors.length) row.note = `${row.note ? row.note + '; ' : ''}${errors.length} console error(s)`;
    rows.push(row);
    console.log(`${device} ${scene.name}: ${row.status} ${row.note || ''}`);
    await page.close();
  }
  await context.close();
}
await browser.close();
server.close();

const md = [
  '## iOS visual — Playwright WebKit (Linux)', '',
  'Evidence only: no focus-zoom, software keyboard, visualViewport shrink, safe areas or iOS fonts in this tier (see docs/design/ios-visual-testing.md).', '',
  '| device | scene | status | notes |', '|---|---|---|---|',
  ...rows.map((r) => `| ${r.device} | ${r.scene} | ${r.status} | ${(r.note || '').replace(/\|/g, '\\|')} |`), '',
  `${shots} screenshot(s) in artifact \`ios-visual-web\`.`,
].join('\n');
await writeFile(join(out, 'summary.md'), md + '\n');
await writeFile(join(out, 'summary.json'), JSON.stringify(rows, null, 2));
for (const r of rows) if (r.status === 'probe' || r.status === 'error') console.log(`::warning title=${r.scene} (${r.device})::${r.status}: ${r.note}`);
if (!shots) { console.error('no screenshots'); process.exit(1); }
