// bd med-nt9p.32.14. The server's "no such account" 404 (X-Account-Gone: 1, faked by tlsfront for
// nobody.qa.test as internal/cloudserver/router.go answers it) → the stored host forgotten, and (bd
// med-ta2n.12: no native first run) local mode with the web's F1 open — as on a relaunch after a delete.
// A bare 404 (tlsfront's stale.qa.test: a proxy's during a redeploy) keeps the account and the
// N4 "We can't find this account" screen (Use another invite, then Try again; bd med-ckm5.16).
const shellPrefs = async (ctx) => {
  // SharedPreferences.apply() writes to disk asynchronously: give it a moment.
  await ctx.sleep(1500);
  return ctx.shell(`run-as ${ctx.pkg} cat shared_prefs/shell.xml`);
};
const storedHost = async (ctx) => /name="accountHost">([^<]*)</.exec(await shellPrefs(ctx))?.[1] ?? null;

export default async function notFound(ctx) {
  await ctx.step('launch: local mode, F1', () => ctx.launch());
  await ctx.step('Open https://nobody.qa.test/ → local mode with F1, the host forgotten', async () => {
    await ctx.openLink('https://nobody.qa.test/');
    await ctx.sleep(3000);
    await ctx.localPage((p) => p.locator('[data-invite-action="paste"]').waitFor({ state: 'visible', timeout: 60_000 }));
    const tryAgain = await ctx.device.wait({ text: 'Try again' }, { timeout: 1_500 }).then(() => true, () => false);
    if (tryAgain) throw new Error('the error screen ("Try again") is showing');
    const xml = await shellPrefs(ctx);
    if (/accountHost/.test(xml) || /leaveHost/.test(xml) || !/name="wgLocalMode" value="true"/.test(xml)) throw new Error(`prefs: ${xml}`);
  });
  await ctx.shot('no-account');

  await ctx.step('launch: F1 again', () => ctx.launch());
  await ctx.step('a bare 404 (stale.qa.test) shows N4 · 404 with Try again', async () => {
    await ctx.openAccount('https://stale.qa.test/');
    await ctx.waitFor({ text: 'We can\'t find this account' }, 5_000);
    await ctx.waitFor({ text: 'Try again' }, 5_000);
  });
  await ctx.shot('bare-404');
  await ctx.step('a bare 404 keeps the account host', async () => {
    const h = await storedHost(ctx);
    if (h !== 'stale.qa.test') throw new Error(`accountHost = ${h}, want stale.qa.test`);
  });
}
