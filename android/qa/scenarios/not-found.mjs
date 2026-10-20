// bd med-nt9p.32.14. The server's "no such account" 404 (X-Account-Gone: 1, faked by tlsfront for
// nobody.qa.test as internal/cloudserver/router.go answers it) → back to the first run with
// "There is no account at …", the stored host forgotten — as on a relaunch after a delete.
// A bare 404 (tlsfront's stale.qa.test: a proxy's during a redeploy) keeps the account and the
// "Can't open your account" screen with Try again.
const storedHost = async (ctx) => {
  // SharedPreferences.apply() writes to disk asynchronously: give it a moment.
  await ctx.sleep(1500);
  const xml = await ctx.shell(`run-as ${ctx.pkg} cat shared_prefs/shell.xml`);
  return /name="accountHost">([^<]*)</.exec(xml)?.[1] ?? null;
};

export default async function notFound(ctx) {
  await ctx.step('launch on first run', () => ctx.launch());
  await ctx.step('Open https://nobody.qa.test/ returns to the first run with the reason', async () => {
    await ctx.openLink('https://nobody.qa.test/');
    await ctx.waitFor({ text: /There is no account at nobody\.qa\.test\./ }, 15_000);
    await ctx.waitFor({ text: 'Only on this device' }, 5_000);
    await ctx.waitFor({ text: 'Continue' }, 5_000);
    const tryAgain = await ctx.device.wait({ text: 'Try again' }, { timeout: 1_500 }).then(() => true, () => false);
    if (tryAgain) throw new Error('the error screen ("Try again") is showing');
  });
  await ctx.shot('no-account');
  await ctx.step('the account host is not stored', async () => {
    const h = await storedHost(ctx);
    if (h !== null) throw new Error(`accountHost still stored: ${h}`);
  });

  await ctx.step('launch on first run again', () => ctx.launch());
  await ctx.step('a bare 404 (stale.qa.test) shows the error screen with Try again', async () => {
    await ctx.openAccount('https://stale.qa.test/');
    await ctx.waitFor({ text: 'Try again' }, 5_000);
  });
  await ctx.shot('bare-404');
  await ctx.step('a bare 404 keeps the account host', async () => {
    const h = await storedHost(ctx);
    if (h !== 'stale.qa.test') throw new Error(`accountHost = ${h}, want stale.qa.test`);
  });
}
