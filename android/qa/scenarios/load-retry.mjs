// bd med-wcpg (testscenarios/common/account-load-blink.yaml): a failed main-frame load of the account
// retries quietly under the mark (0.5/1.5/3 s) instead of N4. The failure is synthetic: the debug-only
// `--ei wgQAFailLoads <n>` makes the next n account loads fail as error -1 · net::ERR_FAILED (qa), since
// a navigation the Service Worker answers cannot be failed from the network side. The account is the
// run's reachable invite host, opened at its root (nothing is claimed).
// Known (shown on this phone before, accountShown:<host>): every 10 s after that, never N4; "Opening…"
// at ~10 s, Switch account + Copy diagnostics at ~30 s; a plain switch keeps the flag. First-ever
// open (after pm clear): N4 only after the third retry failed.
import { join } from 'node:path';

// The cover is proven by its lines and buttons (real a11y nodes) and by the shots; every step watches
// that neither N4 nor Chromium's error page shows when it must not.
const N4 = 'Can\'t reach your account';
const OPENING = 'Opening…';
const LONG = 5_000; // a UiAutomator query under the reloading cover takes seconds (see step (b))
const seen = new Set();
const has = (ctx, text, timeout = 300) => ctx.device.wait({ text }, { timeout }).then(() => true, (e) => {
  const msg = String(e?.message || e).split('\n')[0];
  if (!seen.has(msg)) { seen.add(msg); ctx.log('load-retry: wait', String(text), '->', msg); }
  return false;
});

/** launch() with the QA failure count: Switch account (the flag cleared), local mode with F1. */
async function fresh(ctx, n) {
  const go = () => ctx.coldStart(`-a com.example.medtracker.SWITCH_ACCOUNT -n ${ctx.pkg}/com.example.medtracker.MainActivity --ei wgQAFailLoads ${n}`);
  await go();
  await ctx.localPage((p) => p.locator('[data-invite-action="paste"]').waitFor({ state: 'visible', timeout: 90_000 }), go);
}

/** A cold start onto the stored account with the QA failure count. */
const reopen = (ctx, n) => ctx.coldStart(`-n ${ctx.pkg}/com.example.medtracker.MainActivity --ei wgQAFailLoads ${n}`);

/** Watches `ms`: throws on Chromium's error page, and on N4 unless `n4` (then returns once it shows). */
async function watch(ctx, ms, { n4 = false } = {}) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const wait = Math.max(300, Math.min(LONG, end - Date.now())); // short waits miss under the cover
    if (await has(ctx, 'Webpage not available', wait)) throw new Error('the WebView error page showed');
    if (await has(ctx, N4, wait)) {
      if (n4) return true;
      throw new Error('N4 showed');
    }
  }
  return false;
}

/** The WebView holds a loaded page of the account. */
async function onAccount(ctx, host) {
  const page = await ctx.attachPage();
  if (!page) throw new Error('no WebView page (see the run log)');
  await page.waitForURL((u) => u.host === host, { timeout: 15_000 });
  await page.waitForFunction(() => document.readyState === 'complete', null, { timeout: 15_000 });
}

const prefs = async (ctx, file) => {
  await ctx.sleep(1500); // SharedPreferences.apply() writes asynchronously
  return ctx.shell(`run-as ${ctx.pkg} cat shared_prefs/${file}.xml`);
};
const flagged = async (ctx, host) => (await prefs(ctx, 'shell')).includes(`name="accountShown:${host}" value="true"`);

export default async function loadRetry(ctx) {
  if (!ctx.claimUrl) throw new Error('QA_CLAIM_URL unset (no local cloud)');
  const host = new URL(ctx.claimUrl).host;
  const url = `https://${host}/`;

  await ctx.step('warm-up: the account page commits, accountShown set', async () => {
    await fresh(ctx, 0);
    await ctx.openLink(url);
    await onAccount(ctx, host);
    if (!(await flagged(ctx, host))) throw new Error(`no accountShown:${host} in shell.xml`);
  });

  await ctx.step('known, two failed loads: the mark, then the page; never a bare frame, never N4', async () => {
    // n=2: a ~2 s cycle (retries at 0.5 and 1.5 s), long enough to be shot inside. A burst of device
    // shots spans the cycle and the hand-off to the page: each is the mark or the page, never bare
    // wg_screen (the cover must not drop before the page paints; Argus 27463).
    await reopen(ctx, 2);
    const end = Date.now() + 6_000;
    for (let i = 1; Date.now() < end; i++) {
      await ctx.device.screenshot({ path: join(ctx.out, 'screenshots', `${ctx.scenario}-known-burst-${String(i).padStart(2, '0')}.png`) });
    }
    await watch(ctx, 8_000);
    await onAccount(ctx, host);
    const diag = await prefs(ctx, 'diag');
    if (!diag.includes('shell load retry 2 error -1 net::ERR_FAILED (qa)')) throw new Error('diag lacks retry 2');
  });
  await ctx.shot('known-page');

  await ctx.step('known, every load fails: Opening… ~10 s, Switch account + Copy diagnostics ~30 s, never N4', async () => {
    await reopen(ctx, 99);
    // One UiAutomator query under the reloading cover takes over 2 s (runs 44314911268..44329931145:
    // every ≤2 s wait timed out, a 3 s one in probe run 44328334839 found the nodes), so each wait
    // here is 5 s and the timings come from the cover's own diag lines, measured from this cycle's
    // first failure; UiAutomator proves the lines and buttons are real nodes.
    const t0 = Date.now();
    let opening = false;
    for (;;) {
      const t = Date.now() - t0;
      if (await has(ctx, N4, LONG)) throw new Error(`N4 on a known account at ${t} ms`);
      if (await has(ctx, 'Webpage not available', LONG)) throw new Error('the WebView error page showed');
      if (!opening && (opening = await has(ctx, OPENING, LONG))) await ctx.shot('known-opening');
      if (opening && await has(ctx, 'Switch account', LONG)) break;
      if (t > 60_000) throw new Error(opening ? 'no Switch account in 60 s' : 'no Opening… in 60 s');
    }
    if (!(await has(ctx, 'Copy diagnostics', LONG))) throw new Error('Switch account without Copy diagnostics');
    await ctx.shot('known-switch');
    const diagXml = await prefs(ctx, 'diag');
    const at = (re) => [...diagXml.matchAll(re)].map((m) => Date.parse(m[1])).pop();
    const first = at(/(\d{4}-\d\d-\d\dT[\d:.]+Z) shell load retry 1 error/g);
    const note = at(/(\d{4}-\d\d-\d\dT[\d:.]+Z) shell load cover opening/g) - first;
    const exit = at(/(\d{4}-\d\d-\d\dT[\d:.]+Z) shell load cover exit/g) - first;
    ctx.log('load-retry: since the first failure: Opening…', note, 'ms, Switch account', exit, 'ms');
    if (!(note <= 12_000)) throw new Error(`Opening… at ${note} ms, want by 12 s`);
    if (!(exit >= 28_000 && exit <= 33_000)) throw new Error(`Switch account at ${exit} ms, want 28–33 s`);
    if (await has(ctx, N4, LONG)) throw new Error('N4 on a known account'); // well past 35 s by now
    if (!diagXml.includes('shell load retry 3 error -1')) throw new Error('diag lacks retry 3');
  });

  await ctx.step('Copy diagnostics stays on the cover', async () => {
    await ctx.device.tap({ text: 'Copy diagnostics' });
    await ctx.sleep(1_000);
    for (const t of [OPENING, 'Switch account']) if (!(await has(ctx, t, LONG))) throw new Error(`left the cover: no ${t}`);
    if (await has(ctx, N4, LONG)) throw new Error('N4 after Copy diagnostics');
  });

  await ctx.step('Switch account on the cover: local mode with F1, the flag kept', async () => {
    await ctx.device.tap({ text: 'Switch account' });
    await ctx.sleep(2000);
    await ctx.localPage((p) => p.locator('[data-invite-action="paste"]').waitFor({ state: 'visible', timeout: 60_000 }));
    const xml = await prefs(ctx, 'shell');
    if (/accountHost/.test(xml) || !/name="wgLocalMode" value="true"/.test(xml)) throw new Error(`prefs: ${xml}`);
    if (!xml.includes(`name="accountShown:${host}" value="true"`)) throw new Error(`plain switch dropped the flag: ${xml}`);
  });

  await ctx.step('first-ever open, every try fails: N4 at 4.5–10 s with the last error', async () => {
    await ctx.shell(`pm clear ${ctx.pkg}`); // nothing known: the flag (kept by the switch) and the origin's data go
    await fresh(ctx, 4);
    await ctx.openLink(url);
    await ctx.sleep(1_500);
    await ctx.shot('first-retrying'); // mid-cycle: the mark, no text
    if (!(await watch(ctx, 20_000, { n4: true }))) throw new Error('no N4 in 20 s');
    await ctx.waitFor({ text: /^error -1 · net::ERR_FAILED \(qa\) · \d\d:\d\d$/ }, 5_000);
    // When N4 showed, from the diag (as step (b)): "gave up" is written just before showError.
    const diag = await prefs(ctx, 'diag');
    const at = (re) => [...diag.matchAll(re)].map((m) => Date.parse(m[1])).pop();
    const ms = at(/(\d{4}-\d\d-\d\dT[\d:.]+Z) shell load retry gave up/g) - at(/(\d{4}-\d\d-\d\dT[\d:.]+Z) shell load retry 1 error/g);
    ctx.log('load-retry: N4', ms, 'ms after the first failure');
    if (!(ms >= 4_500 && ms <= 10_000)) throw new Error(`N4 after ${ms} ms, want 4.5–10 s`);
    if (!diag.includes('shell load retry 3 error -1')) throw new Error('diag lacks retry 3');
  });
  await ctx.shot('first-n4');

  await ctx.step('Try again (failures used up): the page commits', async () => {
    await ctx.device.tap({ text: 'Try again' });
    await watch(ctx, 5_000);
    await onAccount(ctx, host);
  });
}
