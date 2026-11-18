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
    if (await has(ctx, 'Webpage not available')) throw new Error('the WebView error page showed');
    if (await has(ctx, N4)) {
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

  await ctx.step('known, one failed load: the mark, then the page; never N4', async () => {
    await reopen(ctx, 1);
    await ctx.sleep(300);
    await ctx.device.screenshot({ path: join(ctx.out, 'screenshots', `${ctx.scenario}-known-retrying.png`) }); // the cycle is ~1 s
    await watch(ctx, 8_000);
    await onAccount(ctx, host);
    const diag = await prefs(ctx, 'diag');
    if (!diag.includes('shell load retry 1 error -1 net::ERR_FAILED (qa)')) throw new Error('diag lacks the retry line');
  });
  await ctx.shot('known-page');

  await ctx.step('known, every load fails: Opening… ~10 s, Switch account + Copy diagnostics ~30 s, never N4', async () => {
    await reopen(ctx, 99);
    // The cover's clocks start at the first failure, which a cold start reaches a second or two after
    // am start returns, so times are taken from that failure's diag line (the emulator's clock is the
    // host's). Runs 44314911268..44326800563 timed from am start and failed at the bound; probe run
    // 44328334839 showed the cover's nodes present (text, desc, bounds) once due.
    const t0 = Date.now();
    let opening = 0, exit = 0;
    while (!exit) {
      const t = Date.now() - t0;
      if (await has(ctx, N4)) throw new Error(`N4 on a known account at ${t} ms`);
      if (await has(ctx, 'Webpage not available')) throw new Error('the WebView error page showed');
      if (!opening && await has(ctx, OPENING, 1_000)) opening = Date.now();
      if (opening && await has(ctx, 'Switch account', 1_000)) {
        exit = Date.now();
        if (!(await has(ctx, 'Copy diagnostics', 1_000))) throw new Error('Switch account without Copy diagnostics');
      }
      if (!opening && t > 25_000) throw new Error('no Opening… 25 s after am start');
      if (t > 45_000) throw new Error('no Switch account 45 s after am start');
      if (opening && !exit && !seen.has('opening-shot')) { seen.add('opening-shot'); await ctx.shot('known-opening'); }
    }
    const fails = [...(await prefs(ctx, 'diag')).matchAll(/(\d{4}-\d\d-\d\dT[\d:.]+Z) shell load retry 1 error/g)];
    if (!fails.length) throw new Error('diag lacks this cycle\'s retry 1');
    const first = Date.parse(fails[fails.length - 1][1]);
    const since = (at) => at - first;
    ctx.log('load-retry: since the first failure: Opening…', since(opening), 'ms, Switch account', since(exit), 'ms');
    if (since(opening) > 12_000) throw new Error(`Opening… at ${since(opening)} ms, want by 12 s`);
    if (since(exit) < 28_000 || since(exit) > 33_000) throw new Error(`Switch account at ${since(exit)} ms, want 28–33 s`);
    await ctx.shot('known-switch');
    await ctx.sleep(3_000); // past 35 s since the first failure
    if (await has(ctx, N4)) throw new Error('N4 on a known account');
    const diag = await prefs(ctx, 'diag');
    if (!diag.includes('shell load retry 3 error -1')) throw new Error('diag lacks retry 3');
  });

  await ctx.step('Copy diagnostics stays on the cover', async () => {
    await ctx.device.tap({ text: 'Copy diagnostics' });
    await ctx.sleep(1_000);
    for (const t of [OPENING, 'Switch account']) if (!(await has(ctx, t, 3_000))) throw new Error(`left the cover: no ${t}`);
    await watch(ctx, 1_000);
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
    const t0 = Date.now();
    await ctx.sleep(1_500);
    await ctx.shot('first-retrying'); // mid-cycle: the mark, no text
    if (!(await watch(ctx, 15_000, { n4: true }))) throw new Error('no N4 by 15 s');
    const ms = Date.now() - t0;
    ctx.log('load-retry: N4 after', ms, 'ms');
    if (ms < 4_500 || ms > 10_000) throw new Error(`N4 after ${ms} ms, want 4.5–10 s`);
    await ctx.waitFor({ text: /^error -1 · net::ERR_FAILED \(qa\) · \d\d:\d\d$/ }, 5_000);
    const diag = await prefs(ctx, 'diag');
    for (const line of ['shell load retry 3 error -1', 'shell load retry gave up']) {
      if (!diag.includes(line)) throw new Error(`diag lacks "${line}"`);
    }
  });
  await ctx.shot('first-n4');

  await ctx.step('Try again (failures used up): the page commits', async () => {
    await ctx.device.tap({ text: 'Try again' });
    await watch(ctx, 5_000);
    await onAccount(ctx, host);
  });
}
