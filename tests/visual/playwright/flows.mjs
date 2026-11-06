// Single-context flows on the real cmd/cloud with its real service worker
// (bd med-sz4k.2.2), the web automation of three testscenarios/common files:
//
//   offline-cold-open     synced boot → host gone → cold open → every section
//                         renders its saved data; a write made offline syncs
//                         once the host is back
//   app-update-banner     bundle A installed → host swapped to bundle B → the
//                         banner shows once (open tab, and newer worker
//                         waiting at load) → Reload lands on B
//   boot-degraded-reload  one module answers 503 once → the degraded banner
//                         (replacing an update banner) → Reload recovers with
//                         the host down, from the service worker's cache
//   meds-timeline-later-on-top (invariant 2)  the meds-timeline-focus-in-view
//                         scene's inView probe as a gate: the overdue dose's
//                         Take/Skip in view with two doses ahead (Pixel 7, 390)
//
// and two-device flows (bd med-sz4k.2.3), device B being a second Chromium
// context that joined the account through Settings → Add a device:
//
//   eu-register-check     A picks EU register → B's pull to refresh → B's
//                         Settings says EU register and its next name check
//                         is the EU one, with no RxNav request, no reload
//   pull-to-refresh       A logs a blood pressure → B's pull brings it with
//                         the "new entries" toast; a pull with nothing new
//                         shows none; never the Health import; the offline
//                         banner only while offline
//
// Unlike run.mjs this is a gate: a failed assertion fails the run (exit 1).
// One Chromium context (Pixel 7) per device and one account, flows in that
// order: each starts from the state the previous one leaves. Two stamped builds of
// cmd/cloud, as deploy.yml stamps them, so the update check and the SW's
// versioned cache behave as in production (an unstamped "dev" build never
// prompts). Needs go on PATH.
//
//   node tests/visual/playwright/flows.mjs [outDir]
import { execFileSync } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, devices } from 'playwright';
import { addPasskeyAuthenticator, cloudServer, cloudSignup, driverInit } from './cloud.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const out = resolve(process.argv[2] || 'visual-web-flows');
await mkdir(out, { recursive: true });
const log = (...a) => console.log(...a);

// --- two stamped builds -----------------------------------------------------
// deploy.yml's three seds, applied through `go build -overlay` so the tree is
// never touched: the ?v= asset fingerprint (the build id /api/version reports),
// the Settings version label, and the SW's versioned cache name.
const BUILD_A = '20990101-0001';
const BUILD_B = '20990101-0002';
async function buildStamped(stamp) {
  const dir = join(tmpdir(), `visual-flows-${process.pid}-${stamp}`); // not in out: no binaries in the artifact
  await mkdir(dir, { recursive: true });
  const index = join(repo, 'web/static/index.html');
  const sw = join(repo, 'web/cloud/sw.js');
  await writeFile(join(dir, 'index.html'), (await readFile(index, 'utf8'))
    .replaceAll('TIMESTAMP_PLACEHOLDER', stamp).replaceAll('VERSION_PLACEHOLDER', stamp));
  await writeFile(join(dir, 'sw.js'), (await readFile(sw, 'utf8')).replaceAll('CACHE_VERSION_PLACEHOLDER', `v${stamp}`));
  await writeFile(join(dir, 'overlay.json'), JSON.stringify({ Replace: { [index]: join(dir, 'index.html'), [sw]: join(dir, 'sw.js') } }));
  const bin = join(dir, 'cloud');
  execFileSync('go', ['build', '-buildvcs=false', '-overlay', join(dir, 'overlay.json'), '-o', bin, './cmd/cloud'],
    { cwd: repo, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'inherit' });
  return bin;
}
const t0 = Date.now();
const binA = await buildStamped(BUILD_A);
const binB = await buildStamped(BUILD_B);
log(`builds: ${Math.round((Date.now() - t0) / 1000)}s`);

// --- helpers ------------------------------------------------------------------
class Failed extends Error {}
function check(ok, what) {
  if (!ok) throw new Failed(what);
}

// The app has booted: the vault is open and the first tab is set.
async function booted(page, timeout = 30000) {
  await page.waitForFunction(() => Boolean(window.MedTrackerCloudReady), null, { timeout });
  await page.evaluate(() => window.MedTrackerCloudReady);
  await page.waitForFunction(() => window.AppStore && window.AppStore.get('currentTab'), null, { timeout });
}

// Polls an async page function from here until it resolves truthy.
// page.waitForFunction cannot: it takes the returned Promise itself as truthy.
async function until(page, fn, what, { timeout = 30000, every = 250 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn).catch(() => false)) return;
    if (Date.now() > end) throw new Failed(`timed out after ${timeout} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

// The page is controlled by an activated worker with nothing installing.
const swSettled = (page) => until(page, async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return Boolean(navigator.serviceWorker.controller && reg && reg.active && reg.active.state === 'activated' && !reg.installing && !reg.waiting);
}, 'an activated, settled service worker', { timeout: 60000 });

const buildOf = (page) => page.evaluate(() => document.querySelector('meta[name="medtracker-build-id"]')?.content || '');
const pendingOps = (page) => page.evaluate(async () => (await (await import('/js/sync.js')).getSyncStatus(window.MedTrackerCloud.ctx)).pendingCount);
// Every local write has reached the server (the pending queue is empty).
const synced = (page) => until(page, async () => (await (await import('/js/sync.js')).getSyncStatus(window.MedTrackerCloud.ctx)).pendingCount === 0,
  'an empty pending queue');

// Document loads (not same-document history changes), counted from the moment
// it is called.
function countLoads(page) {
  const urls = [];
  const on = () => urls.push(page.url());
  page.on('domcontentloaded', on);
  return { get n() { return urls.length; }, urls, stop: () => page.off('domcontentloaded', on) };
}

// The foreground signals update-check.js re-checks on (visibilitychange to
// visible, window focus), as a resumed PWA sends them.
const foreground = (page) => page.evaluate(() => {
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('focus'));
});

// A host that accepts connections and never answers (lie-fi: a dead link after
// device sleep), so any read that waits on the network hangs instead of failing.
function blackHole(port) {
  const sockets = new Set();
  const srv = createTcpServer((s) => { sockets.add(s); s.on('error', () => {}); });
  return new Promise((ok) => srv.listen(Number(port), () => ok({
    close: () => new Promise((done) => { for (const s of sockets) s.destroy(); srv.close(() => done()); }),
  })));
}

// Every section of the scenario, with what proves it shows the golden vault's
// data (tests/fixtures/vault-v1.json as the QA driver seeds it).
const SECTIONS = [
  { name: 'Today', tab: 'today', root: '#today-content', ready: '#today-content > *', text: 'Lisinopril' },
  { name: 'Meds', tab: 'meds', click: '.med-tab[data-tab="schedule"]', root: '#med-schedule-tab', ready: '#med-list > *', text: 'Lisinopril' },
  { name: 'Food log', tab: 'food', click: '.food-tab[data-tab="log"]', root: '#food-log-tab', ready: '#food-list > *', text: 'Greek yogurt' },
  { name: 'Food DB', tab: 'food', click: '.food-tab[data-tab="fooddb"]', root: '#food-fooddb-tab', text: 'Greek yogurt 2%' },
  { name: 'Workout plans', tab: 'workouts', click: '.workout-tab[data-tab="groups"]', root: '#workout-groups-tab', ready: '#workout-groups-list .wg-plan-card', text: 'Push/Pull' },
  { name: 'Workout equipment', tab: 'workouts', click: '.workout-tab[data-tab="equipment"]', root: '#workout-equipment-tab', text: 'Ohio bar' },
  { name: 'Vitals', tab: 'health', click: '.health-tab[data-tab="overview"]', root: '#health-overview-tab', ready: '#health-overview-content:not(.hidden)', text: '8,400' },
  { name: 'BP', tab: 'bp', root: '#bp-view', ready: '#bpChart svg', text: '122' },
  { name: 'Weight', tab: 'weight', root: '#weight-view', ready: '#weight-list > *', text: '82.4' },
  { name: 'Diary', tab: 'health', click: '.health-tab[data-tab="notes"]', root: '#notes-list', text: 'Felt good after the run today.' },
  // Settings → Food targets: the saved calorie target in its field.
  { name: 'Settings', tab: 'settings', page: 'targets', value: ['#food-target-calories', '2200'] },
];
// What a section shows when it rendered without its data.
const EMPTY_OR_ERROR = /No cached data yet|loads once you are back online|Couldn.t load|Something went wrong|Failed to load/i;

// Visits every section; each must show its data within `withinMs` of the tap.
async function sweep(page, withinMs) {
  const times = {};
  for (const s of SECTIONS) {
    const start = Date.now();
    await page.evaluate((tab) => window.switchTab(tab), s.tab);
    if (s.click) await page.locator(s.click).first().click({ timeout: withinMs });
    const left = () => Math.max(1, withinMs - (Date.now() - start));
    if (s.value) {
      const [sel, want] = s.value;
      await page.waitForFunction((p) => window.SettingsView.openSettingsPage(p), s.page, { timeout: left() });
      const got = await page.waitForFunction(([q, v]) => document.querySelector(q)?.value === v, [sel, want], { timeout: left() }).then(() => true, () => false);
      check(got, `${s.name}: ${sel} is "${await page.locator(sel).inputValue().catch(() => '(none)')}" within ${withinMs} ms, expected ${want}`);
      times[s.name] = Date.now() - start;
      await page.locator('.wg-page:visible .wg-back').last().click({ timeout: 5000 });
      continue;
    }
    try {
      if (s.ready) await page.locator(s.ready).first().waitFor({ state: 'attached', timeout: left() });
      await page.locator(s.root).getByText(s.text, { exact: false }).first().waitFor({ state: 'visible', timeout: left() });
    } catch {
      const text = await page.locator(s.root).first().innerText().catch(() => '(no root)');
      throw new Failed(`${s.name}: no "${s.text}" within ${withinMs} ms; shows: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    const text = await page.locator(s.root).first().innerText();
    check(!EMPTY_OR_ERROR.test(text), `${s.name}: shows an empty/error state next to its data: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
    times[s.name] = Date.now() - start;
  }
  return times;
}

// --- setup: one account on build A, the golden vault, the SW installed --------
const server = cloudServer({ out });
await server.start(binA);
const browser = await chromium.launch();
const DEVICE = { ...devices['Pixel 7'], colorScheme: 'dark', reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'Europe/Berlin', acceptDownloads: true };
const context = await browser.newContext(DEVICE);
await context.addInitScript(await driverInit(repo));
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

const results = [];
let pageB = null; // device B, from the second-device step on
async function flow(name, body) {
  const start = Date.now();
  const row = { flow: name, status: 'ok', note: '' };
  try {
    row.note = (await body()) || '';
  } catch (e) {
    row.status = e instanceof Failed ? 'fail' : 'error';
    row.note = String((e && e.message) || e).split('\n')[0];
    await page.screenshot({ path: join(out, `${name}-failed.png`) }).catch(() => {});
    if (pageB) await pageB.screenshot({ path: join(out, `${name}-failed-b.png`) }).catch(() => {});
  } finally {
    // The next flow starts online, with the host up on the last build.
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    await context.setOffline(false);
    if (!server.running) await server.start();
  }
  row.seconds = Math.round((Date.now() - start) / 1000);
  results.push(row);
  log(`${name}: ${row.status} (${row.seconds}s) ${row.note}`);
  return row.status === 'ok';
}

let origin = null;
const setupOk = await flow('setup', async () => {
  origin = await cloudSignup(context, page, server);
  await page.goto(`${origin}/?qa=today`);
  await page.locator('#wg-qa-ready').waitFor({ state: 'attached', timeout: 90000 }); // survives the seed's reload
  await page.goto('about:blank');
  await page.goto(`${origin}/`);
  await booted(page);
  await swSettled(page);
  check(await buildOf(page) === BUILD_A, 'setup did not boot build A');
  check(await pendingOps(page) === 0, 'the seed did not sync');
});

// --- offline-cold-open ----------------------------------------------------------
if (setupOk) await flow('offline-cold-open', async () => {
  await server.stop();
  // 1. Lie-fi: the host accepts and never answers. Every section must still
  //    render at once, so none waits for the network.
  const hole = await blackHole(server.port);
  let lieFi;
  try {
    await page.goto('about:blank');
    await page.goto(`${origin}/`, { waitUntil: 'commit' });
    await booted(page, 15000);
    lieFi = await sweep(page, 2500);
  } finally {
    await hole.close();
  }
  // 2. Airplane mode, a cold open again: every section shows its data, and a
  //    write (a diary note, through the compose box) is accepted.
  await context.setOffline(true);
  await page.goto('about:blank');
  await page.goto(`${origin}/`, { waitUntil: 'commit' });
  await booted(page, 15000);
  check(await page.evaluate(() => !navigator.onLine), 'the page is not offline');
  check(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), 'the cold open was not served by the service worker');
  const airplane = await sweep(page, 2500);
  const note = `Offline note ${Date.now()}`;
  await page.evaluate(() => window.switchTab('health'));
  await page.locator('.health-tab[data-tab="notes"]').click();
  await page.locator('#notes-textarea').fill(note);
  check(await page.locator('#notes-save-btn').isEnabled(), 'Add note is disabled offline');
  await page.locator('#notes-save-btn').click();
  await page.locator('#notes-list').getByText(note).waitFor({ timeout: 5000 });
  check(await pendingOps(page) > 0, 'the offline note was not queued for sync');
  // 3. The host is back: the queued write reaches the server.
  await server.start(binA);
  await context.setOffline(false);
  await synced(page);
  const slowest = (t) => Math.max(...Object.values(t));
  return `slowest section: lie-fi ${slowest(lieFi)} ms, airplane ${slowest(airplane)} ms; offline note synced`;
});

// --- app-update-banner ------------------------------------------------------------
const banners = (page) => page.evaluate(() => ({
  update: document.querySelectorAll('#cloud-update-banner').length,
  degraded: document.querySelectorAll('#boot-degraded-banner').length,
  copies: (document.body.innerText.match(/A new version is available\./g) || []).length,
}));
// Lets every re-check land: /api/version answers in milliseconds locally.
const settle = (page) => page.waitForTimeout(1500);

if (setupOk) await flow('app-update-banner', async () => {
  await page.goto('about:blank');
  await page.goto(`${origin}/`);
  await booted(page);
  await swSettled(page);
  // State A: the running build matches the server — no banner, however often it checks.
  for (let i = 0; i < 3; i++) await foreground(page);
  await settle(page);
  let b = await banners(page);
  check(b.update === 0, `state A: a banner shows while build A runs against server A (${JSON.stringify(b)})`);

  // Deploy B under the open tab. State B: the next foreground shows the banner
  // once; more re-checks, and the new worker finishing its install (the
  // update-found path), add none.
  await server.stop();
  await server.start(binB);
  await foreground(page);
  await page.locator('#cloud-update-banner').waitFor({ timeout: 10000 });
  await until(page, async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting), 'build B\'s worker waiting', { timeout: 60000 });
  for (let i = 0; i < 3; i++) await foreground(page);
  await settle(page);
  b = await banners(page);
  check(b.update === 1 && b.copies === 1, `state B: expected one banner, got ${JSON.stringify(b)}`);

  // State C: a newer worker waiting at load (the old worker serves A's shell).
  // The banner shows once, before or after the body parses.
  await page.reload();
  await booted(page);
  check(await buildOf(page) === BUILD_A, 'state C: the old worker did not serve build A');
  await page.locator('#cloud-update-banner').waitFor({ timeout: 10000 });
  for (let i = 0; i < 3; i++) await foreground(page);
  await settle(page);
  b = await banners(page);
  check(b.update === 1 && b.copies === 1, `state C: expected one banner, got ${JSON.stringify(b)}`);
  check(!pageErrors.some((e) => /update banner failed/.test(e)), 'state C: "[cloud-boot] update banner failed" logged');

  // Reload lands on B in one load: the build id and the Settings version label.
  const loads = countLoads(page);
  await page.locator('#cloud-update-reload').click();
  await page.waitForFunction((stamp) => document.querySelector('meta[name="medtracker-build-id"]')?.content === stamp, BUILD_B, { timeout: 30000 });
  await booted(page);
  await swSettled(page);
  await page.waitForTimeout(2500); // past activateAndReload's 2 s fallback reload
  loads.stop();
  check(loads.n === 1, `Reload took ${loads.n} document loads, expected 1: ${loads.urls.join(' ')}`);
  await page.evaluate(() => window.switchTab('settings'));
  const label = (await page.locator('.wg-settings-version__value').first().textContent()).trim();
  check(label === BUILD_B, `Settings shows version "${label}", expected ${BUILD_B}`);
  for (let i = 0; i < 3; i++) await foreground(page);
  await settle(page);
  b = await banners(page);
  check(b.update === 0, `after Reload a banner shows on the current build (${JSON.stringify(b)})`);
  return `A: none; B: 1; C: 1; Reload → ${label} in 1 load`;
});

// --- boot-degraded-reload ---------------------------------------------------------
if (setupOk) await flow('boot-degraded-reload', async () => {
  // A failed boot, as after a partly cached update: this one load bypasses the
  // worker (so routes see it), /api/version reports a newer build (the update
  // banner goes up first), and /js/apishim.js answers 503 once the update
  // banner is up.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setBypassServiceWorker', { bypass: true });
  let updateWasUp = false;
  await page.route('**/api/version', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ build_id: '20990101-0003' }) }));
  await page.route('**/js/apishim.js*', async (route) => {
    updateWasUp = await page.locator('#cloud-update-banner').waitFor({ timeout: 15000 }).then(() => true, () => false);
    await route.fulfill({ status: 503, body: '' });
  }, { times: 1 });
  await page.goto('about:blank');
  await page.goto(`${origin}/`);
  await page.locator('#boot-degraded-banner').waitFor({ timeout: 30000 });
  await page.unrouteAll({ behavior: 'wait' });
  await cdp.send('Network.setBypassServiceWorker', { bypass: false });
  await settle(page);
  check(updateWasUp, 'the update banner was not up before the failure');
  const b = await banners(page);
  check(b.degraded === 1 && b.update === 0, `expected only the degraded banner, got ${JSON.stringify(b)}`);
  const strip = await page.locator('#app-banners .wg-banner:visible').evaluateAll((els) => els.map((e) => `${e.id || e.className}: ${e.innerText.replace(/\s+/g, ' ')}`));
  check(strip.length === 1, `more than one banner in #app-banners: ${strip.join(' | ')}`);
  const banner = page.locator('#boot-degraded-banner');
  check((await banner.locator('.wg-banner__text').textContent()) === 'Some saved data did not load. Reload to fix.', 'degraded banner copy');
  check(await banner.getByRole('button', { name: 'Reload' }).count() === 1, 'degraded banner has no Reload button');

  // The host goes away. An empty state the failure causes (no shim, nothing
  // cached for that view) says Reload, not "no data".
  await server.stop();
  await context.setOffline(true);
  await page.evaluate(() => window.MedTrackerDB.ApiCache.clear());
  await page.evaluate(() => window.switchTab('food'));
  await page.locator('.food-tab[data-tab="fooddb"]').click();
  const empty = page.locator('#food-fooddb-tab .wg-empty');
  await empty.first().waitFor({ timeout: 10000 }).catch(() => {});
  const dbText = (await page.locator('#food-fooddb-tab').innerText()).replace(/\s+/g, ' ');
  check(await empty.count() === 1, `Food DB shows ${await empty.count()} empty states: ${dbText.slice(0, 300)}`);
  const title = (await empty.locator('.wg-empty__title').textContent().catch(() => '')).trim();
  const body = (await empty.locator('.wg-empty__body').textContent().catch(() => '')).trim();
  check(title === 'Some saved data did not load' && body === 'Reload to fix.',
    `Food DB empty state reads "${title}" / "${body}", expected "Some saved data did not load" / "Reload to fix."`);
  check(!/No cached data yet|loads once you are back online|Nothing to show yet/i.test(dbText), `Food DB says "no data": ${dbText.slice(0, 300)}`);

  // Reload, host still down: one load, the shim installs from the worker's
  // cache, the current build, the vault's data.
  const loads = countLoads(page);
  await banner.getByRole('button', { name: 'Reload' }).click();
  await page.waitForFunction(() => window.offlineAwareApiCall && window.AppStore && window.AppStore.get('currentTab'), null, { timeout: 30000 });
  await booted(page);
  await page.waitForTimeout(2500);
  loads.stop();
  check(loads.n === 1, `Reload took ${loads.n} document loads, expected 1: ${loads.urls.join(' ')}`);
  check(await page.evaluate(() => !window.MedTrackerCloud.degraded && !document.getElementById('boot-degraded-banner')), 'still degraded after Reload');
  check(await buildOf(page) === BUILD_B, 'Reload did not load the current build');
  await page.evaluate(() => window.switchTab('food'));
  await page.locator('.food-tab[data-tab="fooddb"]').click();
  await page.locator('#food-fooddb-tab').getByText('Greek yogurt 2%').first().waitFor({ timeout: 5000 });
  await server.start(binB);
  await context.setOffline(false);
  return 'update banner replaced; Food DB empty state says Reload; Reload recovered offline in 1 load';
});

// --- meds-timeline-later-on-top invariant 2 (geometry) -------------------------------
// The visual scene meds-timeline-focus-in-view (06:00: Next today 09:00, Later
// today 21:00, an overdue Pending dose), run here as a gate: its inView probe
// must find the focus card's Take and Skip inside the viewport, above the tab
// bar, on Pixel 7 and at the iPhone 390pt width (the ios-visual and Android
// local-visual runs only report it).
if (setupOk) await flow('meds-timeline-focus-in-view', async () => {
  const sizes = { 'pixel-7': DEVICE.viewport, 'iphone-390': { width: 390, height: 844 } };
  const notes = [];
  try {
    for (const [name, size] of Object.entries(sizes)) {
      await page.setViewportSize(size);
      await page.goto('about:blank');
      await page.goto(`${origin}/?qa=meds-timeline-focus-in-view`);
      const ready = page.locator('#wg-qa-ready');
      await ready.waitFor({ state: 'attached', timeout: 60000 });
      const report = JSON.parse(await ready.getAttribute('aria-label'));
      check(!report.error, `${name}: the scene failed: ${report.error}`);
      const inView = report.probes?.inView || [];
      check(inView.length === 2 && inView.every((v) => v.ok), `${name}: Take/Skip not in view: ${JSON.stringify(inView)}`);
      check(report.ok, `${name}: the scene report failed ${JSON.stringify(report.failed)}`);
      notes.push(`${name} Take/Skip ${Math.round(inView[0].bottom)}/${Math.round(inView[0].floor)} px`);
    }
  } finally {
    await page.setViewportSize(DEVICE.viewport);
  }
  return notes.join('; ');
});

// --- a second device ----------------------------------------------------------------
// Device B joins the account the way a person adds a computer: A opens
// Settings → Devices → Add a device and unlocks; B types the code at /claim
// with its own passkey; both show the same match code; A approves.
// B's live sync wake (the SSE stream's sync-ready) is cut, as for a phone that
// was in a pocket, so only B's pull to refresh can bring A's writes.
// B's RxNav proxy calls are answered here (and counted), never sent on.
let contextB = null;
const rxnavB = [];
const healthImportB = [];

const secondOk = setupOk && await flow('second-device', async () => {
  await page.goto('about:blank');
  await page.goto(`${origin}/`);
  await booted(page);
  contextB = await browser.newContext(DEVICE);
  await contextB.route('**/api/inbox/events', (route) => route.abort());
  await contextB.route('**/api/rxnav/**', (route) => {
    rxnavB.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"idGroup":{}}' });
  });
  contextB.on('request', (r) => { if (r.url().includes('/js/health-import.js')) healthImportB.push(r.url()); });
  pageB = await contextB.newPage();
  await addPasskeyAuthenticator(contextB, pageB);

  await page.evaluate(() => window.switchTab('settings'));
  await page.waitForFunction(() => window.SettingsView.openSettingsPage('devices'), null, { timeout: 10000 });
  await page.locator('#add-device-button').click({ timeout: 15000 });
  await page.locator('#transfer-confirm').click({ timeout: 10000 });
  await page.locator('#transfer-fallback').waitFor({ timeout: 15000 });
  const code = (await page.locator('#transfer-fallback').textContent()).trim();

  await pageB.goto(`${origin}/claim`);
  await pageB.locator('#claim-code-input').fill(code);
  await pageB.locator('#claim-code-submit').click();
  await page.locator('#transfer-approve').waitFor({ timeout: 30000 });
  await pageB.locator('#claim-matchcode:not(.wg-matchcode--wait)').waitFor({ timeout: 10000 });
  const sas = (p, sel) => p.locator(sel).getAttribute('aria-label');
  const [sasA, sasB] = [await sas(page, '#transfer-matchcode'), await sas(pageB, '#claim-matchcode')];
  check(sasA === sasB, `match codes differ: A "${sasA}", B "${sasB}"`);
  await page.locator('#transfer-approve').click();
  await pageB.locator('#claim-enroll').click({ timeout: 30000 });
  await pageB.waitForFunction(() => Boolean(window.MedTrackerCloudReady) || document.querySelector('#install-skip'), null, { timeout: 60000 });
  if (await pageB.locator('#install-skip').count()) await pageB.locator('#install-skip').click();
  await booted(pageB, 60000);
  await swSettled(pageB);
  await synced(pageB);
  await pageB.evaluate(() => window.switchTab('today'));
  await pageB.locator('#today-content').getByText('Lisinopril').first().waitFor({ timeout: 15000 });
  return 'B joined through Add a device (same match code), booted with the vault';
});

// What Settings → Features → "Check names in" shows on device p, waiting up
// to `ms` for it to read `want`.
async function registerShown(p, want, ms = 10000) {
  await p.evaluate(() => window.switchTab('settings'));
  await p.waitForFunction(() => window.SettingsView.openSettingsPage('features'), null, { timeout: 10000 });
  const value = p.locator('#med-register-value');
  await p.waitForFunction((w) => document.getElementById('med-register-value')?.textContent.trim() === w, want, { timeout: ms }).catch(() => {});
  const shown = (await value.textContent()).trim();
  await p.locator('.wg-page:visible .wg-back').last().click({ timeout: 5000 });
  return shown;
}

// A finger pull on the current section (touch input over CDP, as a phone
// sends it), starting on the app bar title: a touch's events go to the node it
// started on, so a finger on a card the section re-renders mid-pull is lost
// (seen on Today's time-zone card right after a tab switch). Returns the busy
// pill's label and every toast that showed until the pill went away.
async function pullToRefresh(p) {
  await p.evaluate(() => {
    window.scrollTo(0, 0);
    window.__wgPull = { busy: false, done: false, label: '', toasts: [] };
    const seen = window.__wgPullSeen || (window.__wgPullSeen = new WeakSet());
    for (const t of document.querySelectorAll('.wg-toast__text')) seen.add(t);
    if (window.__wgPullObs) return;
    window.__wgPullObs = new MutationObserver(() => {
      const log = window.__wgPull;
      const busy = document.querySelector('.wg-ptr--busy');
      if (busy) { log.busy = true; log.label = busy.textContent; } else if (log.busy && !document.querySelector('.wg-ptr')) log.done = true;
      for (const t of document.querySelectorAll('.wg-toast__text')) if (!seen.has(t)) { seen.add(t); log.toasts.push(t.textContent); }
    });
    window.__wgPullObs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
  const box = await p.locator('.view.active .wg-appbar__title').boundingBox();
  const x = Math.round(box.x + box.width / 2);
  const y0 = Math.round(box.y + box.height / 2);
  const cdp = await p.context().newCDPSession(p);
  const touch = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: y === undefined ? [] : [{ x, y }] });
  await touch('touchStart', y0);
  for (let dy = 20; dy <= 140; dy += 20) await touch('touchMove', y0 + dy);
  await touch('touchEnd');
  await cdp.detach();
  await p.waitForFunction(() => window.__wgPull.done, null, { timeout: 30000 }).catch(() => {});
  const log = await p.evaluate(() => window.__wgPull);
  check(log.done, `the pull did not run: ${JSON.stringify(log)}`);
  return log;
}

// --- eu-register-check (account choice reaching another device) ----------------------
if (secondOk) await flow('eu-register-check', async () => {
  let shown = await registerShown(pageB, 'US register');
  check(shown === 'US register', `before: B shows "${shown}", expected US register`);
  // A picks EU register.
  await page.goto('about:blank');
  await page.goto(`${origin}/`);
  await booted(page);
  await page.evaluate(() => window.switchTab('settings'));
  await page.waitForFunction(() => window.SettingsView.openSettingsPage('features'), null, { timeout: 10000 });
  await page.locator('#med-register-choose').click();
  await page.locator('.mt-confirm-modal__choice', { hasText: 'EU register' }).click();
  await page.waitForFunction(() => document.getElementById('med-register-value')?.textContent.trim() === 'EU register', null, { timeout: 10000 });
  await synced(page);

  // B pulls on Today: its Settings follows, with no reload.
  const loads = countLoads(pageB);
  await pageB.evaluate(() => window.switchTab('today'));
  await pullToRefresh(pageB);
  shown = await registerShown(pageB, 'EU register');
  check(shown === 'EU register', `after B's pull: B shows "${shown}", expected EU register`);

  // B's next name check is the EU one: a new medication named Candecor shows
  // the EU chip, and saving it sends nothing to RxNav.
  await pageB.evaluate(() => window.switchTab('meds'));
  await pageB.locator('.med-tab[data-tab="schedule"]').first().click();
  await pageB.evaluate(() => window.showAddModal());
  await pageB.locator('#med-name').fill('Candecor');
  await pageB.locator('#med-name').dispatchEvent('change');
  await pageB.locator('#med-eu-chip', { hasText: 'EU · Candesartan Cilexetil' }).waitFor({ timeout: 60000 });
  await pageB.locator('#med-dosage').fill('8mg');
  await pageB.locator('#med-modal-save-btn').click();
  await pageB.locator('#med-modal').waitFor({ state: 'hidden', timeout: 10000 });
  await pageB.locator('#med-list').getByText('Candecor').first().waitFor({ timeout: 10000 });
  await synced(pageB);
  loads.stop();
  check(loads.n === 0, `B reloaded ${loads.n} time(s): ${loads.urls.join(' ')}`);
  check(rxnavB.length === 0, `B sent ${rxnavB.length} RxNav request(s): ${rxnavB.join(' ')}`);
  return 'B: US → EU register after its pull; Candecor → EU chip, saved; 0 RxNav requests, 0 reloads';
});

// --- pull-to-refresh (an entry from the other device) -------------------------------
const BP_ROW = { sys: '137', dia: '91' };
const bpRow = (p) => p.locator('#bp-view .wg-bp-reading-row__value', { hasText: `${BP_ROW.sys}/${BP_ROW.dia}` });

if (secondOk) await flow('pull-to-refresh', async () => {
  try {
    // A logs a blood pressure reading.
    await page.goto('about:blank');
    await page.goto(`${origin}/`);
    await booted(page);
    await page.evaluate(() => { window.switchTab('bp'); window.showBPRecordModal(); });
    await page.locator('#bp-systolic').fill(BP_ROW.sys);
    await page.locator('#bp-diastolic').fill(BP_ROW.dia);
    await page.locator('#bp-pulse').fill('66');
    await page.locator('#bp-modal-save-btn').click();
    await bpRow(page).first().waitFor({ timeout: 10000 });
    await synced(page);

    await pageB.evaluate(() => window.switchTab('bp'));
    await pageB.locator('#bp-view .wg-bp-reading-row').first().waitFor({ timeout: 10000 });
    check(await bpRow(pageB).count() === 0, 'B shows A\'s reading before any pull');

    // B pulls on Today: a sync pull (not a Health import), the toast, the row.
    await pageB.evaluate(() => window.switchTab('today'));
    const first = await pullToRefresh(pageB);
    check(first.label === 'Syncing…', `the pull's pill says "${first.label}", expected Syncing…`);
    check(first.toasts.length === 1 && first.toasts[0] === 'Synced · new entries', `toasts after the pull: ${JSON.stringify(first.toasts)}`);
    await pageB.evaluate(() => window.switchTab('bp'));
    await bpRow(pageB).first().waitFor({ timeout: 10000 });

    // Nothing new: no toast.
    await pageB.evaluate(() => window.switchTab('today'));
    const second = await pullToRefresh(pageB);
    check(second.toasts.length === 0, `a pull with nothing new toasted: ${JSON.stringify(second.toasts)}`);
    check(healthImportB.length === 0, `B loaded the Health import: ${healthImportB.join(' ')}`);

    // The offline banner only while offline.
    const banner = pageB.locator('#offline-banner');
    check(!(await banner.isVisible()), 'the offline banner shows while online');
    await contextB.setOffline(true);
    await banner.waitFor({ state: 'visible', timeout: 5000 });
    await contextB.setOffline(false);
    await banner.waitFor({ state: 'hidden', timeout: 10000 });
    return 'B: 137/91 arrived with "Synced · new entries"; nothing new → no toast; no Health import; offline banner on/off';
  } finally {
    await contextB.setOffline(false);
  }
});

if (contextB) await contextB.close();
await context.close();
await browser.close();
await server.stop();

const md = [
  '## Web flows — cloud mode (cmd/cloud + Chromium Pixel 7, real service worker)', '',
  '| flow | status | seconds | notes |', '|---|---|---|---|',
  ...results.map((r) => `| ${r.flow} | ${r.status} | ${r.seconds} | ${r.note.replace(/\|/g, '\\|')} |`), '',
  `Total ${Math.round((Date.now() - t0) / 1000)} s including both builds.`,
].join('\n');
await writeFile(join(out, 'summary.md'), md + '\n');
await writeFile(join(out, 'summary.json'), JSON.stringify(results, null, 2));
if (results.some((r) => r.status !== 'ok')) process.exit(1);
