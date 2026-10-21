// The local → cloud move's shell ops (bd med-nt9p.32.17, docs/android.md → Local mode: the shell),
// at the bridge (the user-level end-to-end is local-to-cloud-seamless). Local mode: shell.ops lists
// move.stash, the account-only ops are refused, a bad vault is rejected, a stash lands in
// no_backup/move/vault.json → local.leave → still local mode with F1, the stash kept (bd med-ta2n.12)
// → Switch account (a native exit) deletes it (an abandoned move, bd med-nt9p.49) → stash again →
// local.leave → local.leave {url: the runner's invite} keeps it → the account's pickup clears it (bd
// med-nt9p.32.18) → a seeded
// stash: move.stash refused, move.take returns it and keeps the file, move.clear deletes it, → null. Then the leave.* mirror (bd
// med-o7zq.36.3): gates, stash in the account, kept into local mode where take/clear work (under the
// local boot's pickup confirm, bd med-o7zq.36.4, then cancelled), deleted by
// local.reset and by opening an account (seeded via run-as). results.moveOps has the checks.
// Claims the run's one invite: not in `all` (smoke claims it there), no retry.
import { claimAccount, waitForVault } from './smoke.mjs';

export const retry = false;

/** The page's own bridge call (native/index.js): {ok, result} or {ok: false, error}. */
const call = (page, op, args) => page.evaluate(([o, a]) => window.LocalNotifications.__native.call(o, a)
  .then((result) => ({ ok: true, result }), (e) => ({ ok: false, error: String(e && e.message) })), [op, args]);

const expect = (cond, what) => { if (!cond) throw new Error(what); };

export default async function moveOps(ctx) {
  const { shell, pkg, sleep, log, LOCAL_ORIGIN } = ctx;
  const r = (ctx.results.moveOps = {});
  if (!ctx.claimUrl) throw new Error('QA_CLAIM_URL unset (no local cloud)');
  const stashFiles = () => shell(`run-as ${pkg} sh -c 'ls no_backup/move 2>/dev/null; true'`);
  await shell(`pm clear ${pkg}`);

  let page = await ctx.step('local mode, seeded', () => ctx.launchLocal('today', { softAuthn: true }));
  const vault = await page.evaluate(() => window.CloudVault.exportAll({ includeSecrets: false }));
  r.vaultChars = vault.length;

  await ctx.step('local: shell.ops, mode gates, invalid vault', async () => {
    const ops = await call(page, 'shell.ops');
    expect(ops.ok && ops.result.includes('move.stash'), `shell.ops ${JSON.stringify(ops)}`);
    expect(!ops.result.includes('move.take') && !ops.result.includes('move.clear'), `local lists account ops: ${ops.result}`);
    for (const op of ['move.take', 'move.clear']) {
      const res = await call(page, op);
      expect(!res.ok && res.error === `unsupported: ${op}`, `${op} in local mode: ${JSON.stringify(res)}`);
    }
    for (const args of [{}, { vault: 42 }, { vault: '' }]) {
      const res = await call(page, 'move.stash', args);
      expect(!res.ok && res.error === 'invalid vault', `stash ${JSON.stringify(args)}: ${JSON.stringify(res)}`);
    }
    expect((await stashFiles()) === '', 'a rejected stash wrote a file');
  });

  /**
   * Runs `leave`, then the local page the shell reloaded on home?invite=1 (F1 open). The old page is
   * marked first: it may still show F1 while the reload is on its way.
   */
  const f1Page = async (leave, { f1 = true } = {}) => {
    await page.evaluate(() => { window.__qaOld = true; }).catch(() => {});
    await leave();
    for (let end = Date.now() + 90_000; ; await sleep(2000)) {
      const p = await ctx.attachPage();
      const fresh = await p?.evaluate((f1) => location.origin === 'https://appassets.androidplatform.net' && !window.__qaOld
        && (!f1 || !!document.querySelector('[data-invite-action="paste"]')), f1).catch(() => false);
      if (fresh) { page = p; break; }
      if (Date.now() > end) throw new Error(`no reloaded local page with F1: ${p?.url()}`);
    }
    expect(/name="wgLocalMode" value="true"/.test(await shell(`run-as ${pkg} cat shared_prefs/shell.xml`)), 'left local mode');
  };
  const stashAndLeave = async (label) => {
    await ctx.step(`${label}: move.stash → no_backup/move/vault.json`, async () => {
      const res = await call(page, 'move.stash', { vault });
      expect(res.ok && res.result === true, `stash: ${JSON.stringify(res)}`);
      expect((await stashFiles()) === 'vault.json', `files: ${await stashFiles()}`);
    });
    // bd med-ta2n.12: no native first run. Stays in local mode, F1 opens, the stash waits for its account.
    await ctx.step(`${label}: local.leave → local mode with F1, the stash kept`, async () => {
      await f1Page(() => call(page, 'local.leave').catch(() => {})); // the page goes away right after the reply
      expect((await stashFiles()) === 'vault.json', `local.leave dropped the stash: ${await stashFiles()}`);
    });
    await ctx.shot(`f1-${label}`);
  };

  // A native exit from local mode abandoning the stash (bd med-nt9p.49) is the cold step at the end:
  // a warm `am start` stacks a second MainActivity, and the attach finds the old one's WebView.
  await stashAndLeave('first');
  page = await ctx.step('local.leave {url} → signup wizard, the stash kept for it', async () => {
    await call(page, 'local.leave', { url: ctx.claimUrl }).catch(() => {});
    await sleep(2000);
    expect((await stashFiles()) === 'vault.json', `local.leave {url} dropped the stash: ${await stashFiles()}`);
    const p = await ctx.attachPage();
    if (!p) throw new Error('no WebView page (see the run log)');
    await p.waitForURL(/\/unlock/, { timeout: 30_000 });
    await p.locator('#create-passkey').waitFor({ timeout: 30_000 });
    await sleep(3000);
    return p;
  });
  // The post-unlock pickup (bd med-nt9p.32.18) imports and clears the stash, reloads, and the reloaded
  // boot shows the toast then probes move.take once more (≤ 5 s). The user path is local-to-cloud-seamless.
  const picked = page.getByText(/^Sync is on · \d+ records? (is|are) on your account$/)
    .waitFor({ state: 'visible', timeout: 240_000 }).then(() => true, () => false);
  await claimAccount(ctx, page);

  await ctx.step('account: shell.ops, move.stash refused, take keeps, clear deletes', async () => {
    expect(await picked, 'no pickup toast');
    await waitForVault(page);
    await sleep(10_000); // the reloaded boot's move.take probe, before seeding a stash it would pick up
    expect((await stashFiles()) === '', 'the pickup did not clear the stash');
    // A seeded stash drives take/clear directly.
    await shell(`run-as ${pkg} sh -c 'mkdir -p no_backup/move && echo {} > no_backup/move/vault.json'`);
    const ops = await call(page, 'shell.ops');
    expect(ops.ok && ops.result.includes('move.take') && ops.result.includes('move.clear'), `shell.ops ${JSON.stringify(ops)}`);
    expect(!ops.result.includes('move.stash'), `account lists move.stash: ${ops.result}`);
    const stash = await call(page, 'move.stash', { vault: '{}' });
    expect(!stash.ok && stash.error === 'unsupported: move.stash', `stash in account mode: ${JSON.stringify(stash)}`);
    const took = await call(page, 'move.take');
    expect(took.ok && took.result?.vault?.trim() === '{}', `take: ${took.ok} ${took.error || typeof took.result?.vault} ${took.result?.vault?.length}`);
    expect((await stashFiles()) === 'vault.json', 'take deleted the stash');
    const cleared = await call(page, 'move.clear');
    expect(cleared.ok && cleared.result === true, `clear: ${JSON.stringify(cleared)}`);
    expect((await stashFiles()) === '', `clear left: ${await stashFiles()}`);
    const none = await call(page, 'move.take');
    expect(none.ok && none.result === null, `take after clear: ${JSON.stringify(none)}`);
    r.ok = true;
  });

  // Account → local leave stash (bd med-o7zq.36.3): the same contract in the second dir, no_backup/leave/.
  const leaveFiles = () => shell(`run-as ${pkg} sh -c 'ls no_backup/leave 2>/dev/null; true'`);
  const seedLeave = () => shell(`run-as ${pkg} sh -c 'mkdir -p no_backup/leave && echo {} > no_backup/leave/vault.json'`);
  await ctx.step('account: leave.stash gates and invalid vault, then stash', async () => {
    const ops = await call(page, 'shell.ops');
    expect(ops.ok && ops.result.includes('leave.stash'), `shell.ops ${JSON.stringify(ops)}`);
    expect(!ops.result.includes('leave.take') && !ops.result.includes('leave.clear'), `account lists local ops: ${ops.result}`);
    for (const op of ['leave.take', 'leave.clear']) {
      const res = await call(page, op);
      expect(!res.ok && res.error === `unsupported: ${op}`, `${op} in account mode: ${JSON.stringify(res)}`);
    }
    for (const args of [{}, { vault: 42 }, { vault: '' }]) {
      const res = await call(page, 'leave.stash', args);
      expect(!res.ok && res.error === 'invalid vault', `leave.stash ${JSON.stringify(args)}: ${JSON.stringify(res)}`);
    }
    expect((await leaveFiles()) === '', 'a rejected leave.stash wrote a file');
    const res = await call(page, 'leave.stash', { vault });
    expect(res.ok && res.result === true, `leave.stash: ${JSON.stringify(res)}`);
    expect((await leaveFiles()) === 'vault.json', `leave files: ${await leaveFiles()}`);
    expect((await stashFiles()) === '', 'leave.stash touched the move dir');
  });
  await ctx.step('account.leave {then: local}: the leave stash is kept, local takes and clears it', async () => {
    const accountHost = new URL(page.url()).host;
    await call(page, 'account.leave', { then: 'local' }).catch(() => {});
    await sleep(2000);
    page = await ctx.attachPage();
    if (!page) throw new Error('no WebView page');
    await page.waitForURL((u) => u.href.startsWith(`${LOCAL_ORIGIN}/`), { timeout: 30_000 });
    // The local boot's leave pickup (bd med-o7zq.36.4) has taken the stash (take keeps it) and asks
    // Merge / Replace / Cancel over the seeded records; the bridge checks run under it, then Cancel.
    const title = page.locator('.mt-confirm-modal__title');
    await title.filter({ hasText: 'Records already on this' }).waitFor({ timeout: 60_000 });
    await ctx.shot('leave-pickup-confirm');
    expect((await leaveFiles()) === 'vault.json', 'entering local mode deleted the leave stash');
    const ops = await call(page, 'shell.ops');
    expect(ops.ok && ops.result.includes('leave.take') && ops.result.includes('leave.clear') && !ops.result.includes('leave.stash'), `local shell.ops ${JSON.stringify(ops)}`);
    const stash = await call(page, 'leave.stash', { vault: '{}' });
    expect(!stash.ok && stash.error === 'unsupported: leave.stash', `leave.stash in local mode: ${JSON.stringify(stash)}`);
    const took = await call(page, 'leave.take');
    expect(took.ok && took.result && took.result.vault === vault, `leave.take: ${took.ok} ${took.error || took.result?.vault?.length}`);
    expect((await leaveFiles()) === 'vault.json', 'leave.take deleted the stash');
    // Cancel → leave.clear {back: true} (bd med-o7zq.42): the SAME account reopens, no dialog, stash gone.
    await page.click('.mt-confirm-modal__cancel');
    await sleep(5000);
    page = await ctx.attachPage();
    if (!page) throw new Error('no WebView page');
    await page.waitForURL((u) => !u.href.startsWith(`${LOCAL_ORIGIN}/`), { timeout: 60_000 });
    expect(new URL(page.url()).host === accountHost, `cancel reopened ${page.url()}, not ${accountHost}`);
    await sleep(3000);
    await ctx.shot('leave-cancel-back-in-account');
    const dlg = await page.locator('.mt-confirm-modal__title').count();
    expect(dlg === 0, 'a dialog shows after Cancel');
    expect((await leaveFiles()) === '', `cancel left the leave stash: ${await leaveFiles()}`);
    await sleep(1500); // apply() writes the xml off-thread
    expect(!/leaveHost/.test(await shell(`run-as ${pkg} cat shared_prefs/shell.xml`)), 'cancel kept leaveHost');
    r.cancelBack = true;
  });
  await ctx.step('back in local: the records are intact (nothing merged or replaced)', async () => {
    await call(page, 'account.leave', { then: 'local' }).catch(() => {}); // no stash: no dialog
    await sleep(2000);
    page = await ctx.attachPage();
    if (!page) throw new Error('no WebView page');
    await page.waitForURL((u) => u.href.startsWith(`${LOCAL_ORIGIN}/`), { timeout: 30_000 });
    await ctx.waitLocalReady(page);
    const now = await page.evaluate(() => window.CloudVault.exportAll({ includeSecrets: false }));
    expect(now.length > 0 && Math.abs(now.length - vault.length) < vault.length * 0.1, `local records changed: ${now.length} vs ${vault.length}`);
    expect(/leaveHost/.test(await shell(`run-as ${pkg} cat shared_prefs/shell.xml`)), 'leaving did not remember the account');
  });
  await ctx.step('local.reset deletes the leave stash', async () => {
    await seedLeave();
    expect((await leaveFiles()) === 'vault.json', 'seed failed');
    const res = await call(page, 'local.reset');
    expect(res.ok && res.result === true, `local.reset: ${JSON.stringify(res)}`);
    expect((await leaveFiles()) === '', `local.reset left: ${await leaveFiles()}`);
    for (let i = 0; i < 20 && /leaveHost/.test(await shell(`run-as ${pkg} cat shared_prefs/shell.xml`)); i++) await sleep(1000); // apply() writes off-thread
    expect(!/leaveHost/.test(await shell(`run-as ${pkg} cat shared_prefs/shell.xml`)), 'local.reset kept leaveHost');
  });
  await ctx.step('local.leave keeps it; opening an account deletes it', async () => {
    await seedLeave();
    // The reloaded page offers the seeded leave stash first ("Records already on this phone"), over F1.
    await f1Page(() => call(page, 'local.leave').catch(() => {}), { f1: false });
    expect((await leaveFiles()) === 'vault.json', 'local.leave deleted the leave stash');
    await call(page, 'local.leave', { url: ctx.claimUrl }).catch(() => {}); // enterAccount runs before the page loads
    await sleep(2000);
    expect((await leaveFiles()) === '', `open() left: ${await leaveFiles()}`);
    r.leaveOk = true;
  });
  // A native exit from local mode (Switch account) abandons a pending move
  // (bd med-nt9p.49); the page's local.leave (above) keeps it. Only a fresh stash for the next account may remain.
  await ctx.step('native forget from local mode drops the move stash', async () => {
    // Cold: launch() force-stops and starts Switch account → local mode with F1 (bd med-ta2n.12).
    page = await ctx.launch();
    const res = await call(page, 'move.stash', { vault });
    expect(res.ok && res.result === true, `stash: ${JSON.stringify(res)}`);
    expect((await stashFiles()) === 'vault.json', `files: ${await stashFiles()}`);
    page = await ctx.launch();
    expect((await stashFiles()) === '', `native forget kept the move stash: ${await stashFiles()}`);
    r.forgetDropsCold = true;
  });
  log('moveOps', JSON.stringify(r));
}
