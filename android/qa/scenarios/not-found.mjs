// An account the local cloud does not have: the server's 404 → back to the first run with
// "There is no account at …", the stored host forgotten (bd med-nt9p.32.14) — the same as a
// relaunch after the account was deleted.
export default async function notFound(ctx) {
  await ctx.step('launch on first run', () => ctx.launch());
  await ctx.step('Open https://nobody.qa.test/ returns to the first run with the reason', async () => {
    await ctx.openLink('https://nobody.qa.test/');
    await ctx.waitFor({ text: /There is no account at nobody\.qa\.test\./ }, 15_000);
    await ctx.waitFor({ text: 'Only on this device' }, 5_000);
    await ctx.waitFor({ text: 'Open' }, 5_000);
    const tryAgain = await ctx.device.wait({ text: 'Try again' }, { timeout: 1_500 }).then(() => true, () => false);
    if (tryAgain) throw new Error('the error screen ("Try again") is showing');
  });
  await ctx.shot('no-account');
  await ctx.step('the account host is not stored', async () => {
    let xml = '';
    // SharedPreferences.apply() writes to disk asynchronously.
    for (let i = 0; i < 10; i++) {
      xml = await ctx.shell(`run-as ${ctx.pkg} cat shared_prefs/shell.xml`);
      if (!xml.includes('accountHost')) return;
      await ctx.sleep(500);
    }
    throw new Error(`accountHost still in shell.xml: ${xml}`);
  });
}
