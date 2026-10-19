// The local → cloud move's shell ops (bd med-nt9p.32.17, docs/android.md → Local mode: the shell),
// at the bridge: no web UI drives them yet (the web sides are bd med-nt9p.32.15/.18; the user-level
// end-to-end is bd med-nt9p.32.19). Local mode: shell.ops lists move.stash, the account-only ops are
// refused, a bad vault is rejected, a stash lands in no_backup/move/vault.json → local.leave → the
// first run's hint → Only on this device → Start deletes it (an abandoned move) → local.leave shows
// no stale hint → Start → stash again →
// local.leave → the runner's invite → the account: move.stash refused, move.take returns the same
// string and keeps the file, move.clear deletes it, move.take → null. results.moveOps has the checks.
// Claims the run's one invite: not in `all` (smoke claims it there), no retry.
import { claimAccount } from './smoke.mjs';

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
  await claimAccount(ctx, page);

  await ctx.step('account: shell.ops, move.stash refused, take keeps, clear deletes', async () => {
    const ops = await call(page, 'shell.ops');
    expect(ops.ok && ops.result.includes('move.take') && ops.result.includes('move.clear'), `shell.ops ${JSON.stringify(ops)}`);
    expect(!ops.result.includes('move.stash'), `account lists move.stash: ${ops.result}`);
    const stash = await call(page, 'move.stash', { vault: '{}' });
    expect(!stash.ok && stash.error === 'unsupported: move.stash', `stash in account mode: ${JSON.stringify(stash)}`);
    const took = await call(page, 'move.take');
    expect(took.ok && took.result && took.result.vault === vault, `take: ${took.ok} ${took.error || typeof took.result?.vault} ${took.result?.vault?.length}`);
    expect((await stashFiles()) === 'vault.json', 'take deleted the stash');
    const cleared = await call(page, 'move.clear');
    expect(cleared.ok && cleared.result === true, `clear: ${JSON.stringify(cleared)}`);
    expect((await stashFiles()) === '', `clear left: ${await stashFiles()}`);
    const none = await call(page, 'move.take');
    expect(none.ok && none.result === null, `take after clear: ${JSON.stringify(none)}`);
    r.ok = true;
  });
  log('moveOps', JSON.stringify(r));
}
