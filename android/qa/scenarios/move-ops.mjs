// The local → cloud move's shell ops (bd med-nt9p.32.17, docs/android.md → Local mode: the shell),
// at the bridge: no web UI drives them yet (the web sides are bd med-nt9p.32.15/.18; the user-level
// end-to-end is bd med-nt9p.32.19). Local mode: shell.ops lists move.stash, the account-only ops are
// refused, a bad vault is rejected, a stash lands in no_backup/move/vault.json → local.leave → the
// first run's hint → Only on this device → Start deletes it (an abandoned move) → local.leave shows
// no stale hint → Start → stash again →
// local.leave → the runner's invite → the account's pickup clears it (bd med-nt9p.32.18) → a seeded
// stash: move.stash refused, move.take returns it and keeps the file, move.clear deletes it, → null. Then the leave.* mirror (bd
// med-o7zq.36.3): gates, stash in the account, kept into local mode where take/clear work (under the
// local boot's pickup confirm, bd med-o7zq.36.4, then cancelled), deleted by
// local.reset and by opening an account (seeded via run-as). results.moveOps has the checks.
// Claims the run's one invite: not in `all` (smoke claims it there), no retry.
import { claimAccount, waitForVault } from './smoke.mjs';

export const retry = false;

// Waited for up to 60 s: the fresh emulator's launcher ANR dialog hid it from UiAutomator for 20 s (first run).
const HINT = /^Your records are ready to move: paste or scan your invite\.$/;

/** The page's own bridge call (native/index.js): {ok, result} or {ok: false, error}. */
const call = (page, op, args) => page.evaluate(([o, a]) => window.LocalNotifications.__native.call(o, a)
  .then((result) => ({ ok: true, result }), (e) => ({ ok: false, error: String(e && e.message) })), [op, args]);

const expect = (cond, what) => { if (!cond) throw new Error(what); };

export default async function moveOps(ctx) {
  const { shell, pkg, sleep, device, log, LOCAL_ORIGIN } = ctx;
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

  const stashAndLeave = async (label) => {
    await ctx.step(`${label}: move.stash → no_backup/move/vault.json`, async () => {
      const res = await call(page, 'move.stash', { vault });
      expect(res.ok && res.result === true, `stash: ${JSON.stringify(res)}`);
      expect((await stashFiles()) === 'vault.json', `files: ${await stashFiles()}`);
    });
    await ctx.step(`${label}: local.leave → first run with the hint`, async () => {
      await call(page, 'local.leave').catch(() => {}); // the page goes away right after the reply
      await ctx.waitFor({ text: HINT }, 60_000);
    });
    await ctx.shot(`hint-${label}`);
  };

  const start = async () => {
    await device.tap({ text: 'Only on this device' });
    await ctx.waitFor({ text: 'Start' });
    await device.tap({ text: 'Start' });
    page = await ctx.attachPage();
    if (!page) throw new Error('no WebView page');
    await page.waitForURL((u) => u.href.startsWith(`${LOCAL_ORIGIN}/`), { timeout: 30_000 });
    await ctx.waitLocalReady(page);
  };

  await stashAndLeave('first');
  await ctx.step('Only on this device → Start: the abandoned stash is deleted', async () => {
    await start();
    expect((await stashFiles()) === '', `stash survived local mode: ${await stashFiles()}`);
  });
  await ctx.step('local.leave without a stash → first run without the hint', async () => {
    await call(page, 'local.leave').catch(() => {});
    await ctx.waitFor({ text: 'Open' }, 20_000);
    await sleep(1500);
    const stale = await device.wait({ text: HINT }, { timeout: 1_000 }).then(() => true, () => false);
    expect(!stale, 'the hint outlived the stash');
    await start();
  });

  await stashAndLeave('second');
  page = await ctx.step('open the invite → signup wizard', async () => {
    await ctx.openLink(ctx.claimUrl);
    const p = await ctx.attachPage();
    if (!p) throw new Error('no WebView page (see the run log)');
    await p.waitForURL(/\/unlock/, { timeout: 30_000 });
    await p.locator('#create-passkey').waitFor({ timeout: 30_000 });
    await sleep(3000);
    return p;
  });
  // The post-unlock pickup (bd med-nt9p.32.18) imports and clears the stash, reloads, and the reloaded
  // boot shows the toast then probes move.take once more (≤ 5 s). The user path is local-to-cloud-seamless.
  const picked = page.getByText('Your records from this phone are in your account.')
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
    await call(page, 'account.leave', { then: 'local' }).catch(() => {});
    await sleep(2000);
    page = await ctx.attachPage();
    if (!page) throw new Error('no WebView page');
    await page.waitForURL((u) => u.href.startsWith(`${LOCAL_ORIGIN}/`), { timeout: 30_000 });
    // The local boot's leave pickup (bd med-o7zq.36.4) has taken the stash (take keeps it) and asks the
    // typed replace confirm over the seeded records; the bridge checks run under it, then Cancel.
    const title = page.locator('.mt-confirm-modal__title');
    await title.filter({ hasText: 'Replace the records on this' }).waitFor({ timeout: 60_000 });
    await ctx.shot('leave-pickup-confirm');
    expect((await leaveFiles()) === 'vault.json', 'entering local mode deleted the leave stash');
    const ops = await call(page, 'shell.ops');
    expect(ops.ok && ops.result.includes('leave.take') && ops.result.includes('leave.clear') && !ops.result.includes('leave.stash'), `local shell.ops ${JSON.stringify(ops)}`);
    const stash = await call(page, 'leave.stash', { vault: '{}' });
    expect(!stash.ok && stash.error === 'unsupported: leave.stash', `leave.stash in local mode: ${JSON.stringify(stash)}`);
    const took = await call(page, 'leave.take');
    expect(took.ok && took.result && took.result.vault === vault, `leave.take: ${took.ok} ${took.error || took.result?.vault?.length}`);
    expect((await leaveFiles()) === 'vault.json', 'leave.take deleted the stash');
    const cleared = await call(page, 'leave.clear');
    expect(cleared.ok && cleared.result === true, `leave.clear: ${JSON.stringify(cleared)}`);
    expect((await leaveFiles()) === '', `leave.clear left: ${await leaveFiles()}`);
    const none = await call(page, 'leave.take');
    expect(none.ok && none.result === null, `leave.take after clear: ${JSON.stringify(none)}`);
    // Cancel → the pickup clears (already empty) and says the records were not copied → OK.
    await page.click('.mt-confirm-modal__cancel');
    await title.filter({ hasText: 'Records not copied' }).waitFor({ timeout: 15_000 });
    await page.click('.mt-confirm-modal__cancel');
    await ctx.waitLocalReady(page);
  });
  await ctx.step('local.reset deletes the leave stash', async () => {
    await seedLeave();
    expect((await leaveFiles()) === 'vault.json', 'seed failed');
    const res = await call(page, 'local.reset');
    expect(res.ok && res.result === true, `local.reset: ${JSON.stringify(res)}`);
    expect((await leaveFiles()) === '', `local.reset left: ${await leaveFiles()}`);
  });
  await ctx.step('local.leave keeps it; opening an account deletes it', async () => {
    await seedLeave();
    await call(page, 'local.leave').catch(() => {});
    await ctx.waitFor({ text: 'Open' }, 60_000);
    expect((await leaveFiles()) === 'vault.json', 'leaving local mode deleted the leave stash');
    await ctx.openLink(ctx.claimUrl); // open() runs before the page loads
    await sleep(2000);
    expect((await leaveFiles()) === '', `open() left: ${await leaveFiles()}`);
    r.leaveOk = true;
  });
  log('moveOps', JSON.stringify(r));
}
