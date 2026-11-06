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
//
// Unlike run.mjs this is a gate: a failed assertion fails the run (exit 1).
// One Chromium context (Pixel 7) and one account, flows in that order: each
// starts from the state the previous one leaves. Two stamped builds of
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
import { cloudServer, cloudSignup, driverInit } from './cloud.mjs';

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

// The page is controlled by an activated worker with nothing installing.
async function swSettled(page) {
  await page.waitForFunction(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return Boolean(navigator.serviceWorker.controller && reg && reg.active && reg.active.state === 'activated' && !reg.installing && !reg.waiting);
  }, null, { timeout: 60000, polling: 250 });
}

const buildOf = (page) => page.evaluate(() => document.querySelector('meta[name="medtracker-build-id"]')?.content || '');
const pendingOps = (page) => page.evaluate(async () => (await (await import('/js/sync.js')).getSyncStatus(window.MedTrackerCloud.ctx)).pendingCount);

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
const context = await browser.newContext({ ...devices['Pixel 7'], colorScheme: 'dark', reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'Europe/Berlin', acceptDownloads: true });
await context.addInitScript(await driverInit(repo));
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

const results = [];
async function flow(name, body) {
  const start = Date.now();
  const row = { flow: name, status: 'ok', note: '' };
  try {
    row.note = (await body()) || '';
  } catch (e) {
    row.status = e instanceof Failed ? 'fail' : 'error';
    row.note = String((e && e.message) || e).split('\n')[0];
    await page.screenshot({ path: join(out, `${name}-failed.png`) }).catch(() => {});
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
  await page.waitForFunction(async () => (await (await import('/js/sync.js')).getSyncStatus(window.MedTrackerCloud.ctx)).pendingCount === 0,
    null, { timeout: 30000, polling: 500 });
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
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting), null, { timeout: 60000, polling: 250 });
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
  const empty = page.locator('#food-fooddb-tab').getByText('Some saved data did not load. Reload to fix.');
  await empty.first().waitFor({ timeout: 10000 }).catch(() => {});
  const dbText = (await page.locator('#food-fooddb-tab').innerText()).replace(/\s+/g, ' ');
  check(await empty.count() > 0, `Food DB empty state does not say Reload: ${dbText.slice(0, 300)}`);
  // Its title is still "No cached data yet" (empty-state.js), which the
  // scenario's "not 'no data'" excludes, so the web line stays manual until
  // med-31gk ships; asserted here: the body, no plain empty state, and no
  // promise that reconnecting fixes it.
  check(!/loads once you are back online|Nothing to show yet/i.test(dbText), `Food DB says "no data": ${dbText.slice(0, 300)}`);

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
