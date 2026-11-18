// bd med-wcpg (testscenarios/common/account-load-blink.yaml): a failed main-frame load of the account
// retries quietly under the mark (0.5/1.5/3 s) instead of N4. The failure is synthetic: the debug-only
// `--ei wgQAFailLoads <n>` makes the next n account loads fail as error -1 · net::ERR_FAILED (qa), since
// a navigation the Service Worker answers cannot be failed from the network side. The account is the
// run's reachable invite host, opened at its root (nothing is claimed).
// Known (shown on this phone before, accountShown:<host>): every 10 s after that, never N4; "Opening…"
// at ~10 s, Switch account at ~30 s. First-ever open: N4 only after the third retry failed.
import { join } from 'node:path';

const N4 = 'Can\'t reach your account';
const COVER = { desc: 'Opening Med Tracker' };
const has = (ctx, sel, timeout = 300) =>
  ctx.device.wait(typeof sel === 'string' ? { text: sel } : sel, { timeout }).then(() => true, () => false);

/** launch() with the QA failure count: Switch account (the flag cleared), local mode with F1. */
async function fresh(ctx, n) {
  const go = () => ctx.coldStart(`-a com.example.medtracker.SWITCH_ACCOUNT -n ${ctx.pkg}/com.example.medtracker.MainActivity --ei wgQAFailLoads ${n}`);
  await go();
  await ctx.localPage((p) => p.locator('[data-invite-action="paste"]').waitFor({ state: 'visible', timeout: 90_000 }), go);
}

/** A cold start onto the stored account with the QA failure count. */
const reopen = (ctx, n) => ctx.coldStart(`-n ${ctx.pkg}/com.example.medtracker.MainActivity --ei wgQAFailLoads ${n}`);

/** The cover shows, then: 'page' once it is gone with no N4, or 'n4'. Never the WebView error page. */
async function cycle(ctx, ms) {
  if (!(await has(ctx, COVER, 10_000))) throw new Error('the retry cover never showed');
  const end = Date.now() + ms;
  for (;;) {
    if (await has(ctx, N4)) return 'n4';
    if (await has(ctx, 'Webpage not available')) throw new Error('the WebView error page showed');
    if (!(await has(ctx, COVER))) return 'page';
    if (Date.now() > end) throw new Error(`still retrying after ${ms} ms`);
  }
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
    // The cover is up for ~0.5 s plus one load: too short to wait on, so watch for 8 s that nothing
    // else shows (the long steps below assert the cover itself), shooting it if it is caught.
    const end = Date.now() + 8_000;
    let shot = false;
    while (Date.now() < end) {
      if (await has(ctx, N4)) throw new Error('N4 on a known account');
      if (await has(ctx, 'Webpage not available')) throw new Error('the WebView error page showed');
      if (!shot && await has(ctx, COVER, 100)) {
        shot = true;
        await ctx.device.screenshot({ path: join(ctx.out, 'screenshots', `${ctx.scenario}-known-retrying.png`) });
      }
    }
    ctx.log('load-retry: cover caught on the one-blink retry:', shot);
    await onAccount(ctx, host);
    const diag = await prefs(ctx, 'diag');
    if (!diag.includes('shell load retry 1 error -1 net::ERR_FAILED (qa)')) throw new Error('diag lacks the retry line');
  });
  await ctx.shot('known-page');

  await ctx.step('known, every load fails: Opening… by 12 s, Switch account at 28–33 s, never N4', async () => {
    await reopen(ctx, 99);
    const t0 = Date.now(); // am start -W returned: the first load is under way
    if (!(await has(ctx, COVER, 10_000))) throw new Error('the retry cover never showed');
    let opening = 0, exit = 0;
    while (!exit) {
      const t = Date.now() - t0;
      if (await has(ctx, N4)) throw new Error(`N4 on a known account at ${t} ms`);
      if (await has(ctx, 'Webpage not available')) throw new Error('the WebView error page showed');
      if (!opening && await has(ctx, 'Opening…')) {
        opening = t;
        await ctx.shot('known-opening');
      }
      if (await has(ctx, 'Switch account')) exit = t;
      if (!opening && t > 12_000) throw new Error('no Opening… by 12 s');
      if (t > 33_000) throw new Error('no Switch account by 33 s');
    }
    ctx.log('load-retry: Opening… at', opening, 'ms, Switch account at', exit, 'ms');
    if (!opening) throw new Error('Switch account came before Opening…');
    if (exit < 28_000) throw new Error(`Switch account already at ${exit} ms`);
    await ctx.shot('known-switch');
    await ctx.sleep(2_000); // past 35 s
    if (await has(ctx, N4)) throw new Error('N4 on a known account');
    const diag = await prefs(ctx, 'diag');
    if (!diag.includes('shell load retry 3 error -1')) throw new Error('diag lacks retry 3');
  });

  await ctx.step('Switch account on the cover: local mode with F1, the flag gone', async () => {
    await ctx.device.tap({ text: 'Switch account' });
    await ctx.sleep(2000);
    await ctx.localPage((p) => p.locator('[data-invite-action="paste"]').waitFor({ state: 'visible', timeout: 60_000 }));
    const xml = await prefs(ctx, 'shell');
    if (/accountHost|accountShown/.test(xml) || !/name="wgLocalMode" value="true"/.test(xml)) throw new Error(`prefs: ${xml}`);
  });

  await ctx.step('first-ever open, every try fails: N4 at 4.5–10 s with the last error', async () => {
    await fresh(ctx, 4);
    await ctx.openLink(url);
    const t0 = Date.now();
    if (!(await has(ctx, COVER, 8_000))) throw new Error('the retry cover never showed');
    await ctx.shot('first-retrying');
    const r = await cycle(ctx, 15_000);
    const ms = Date.now() - t0;
    ctx.log('load-retry: N4 after', ms, 'ms');
    if (r !== 'n4') throw new Error(`ended on ${r}`);
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
    const end = Date.now() + 30_000;
    while ((await has(ctx, N4)) || (await has(ctx, COVER))) if (Date.now() > end) throw new Error('Try again did not open the page');
    await onAccount(ctx, host);
  });
}
