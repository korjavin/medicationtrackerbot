// Back on the launch screen (bd med-ta2n.12: local mode with the web's F1 sheet; it replaced the native
// first run): the first Back closes the sheet, the next leaves the app. One Back on the native error
// screen leaves the app.
export default async function backExit(ctx) {
  const back = async () => {
    await ctx.shell('input keyevent KEYCODE_BACK');
    await ctx.sleep(1500);
  };
  const leaves = async () => {
    await back();
    if (await ctx.inForeground()) throw new Error('activity still in the foreground after one Back');
  };
  const page = await ctx.step('launch: local mode, F1', () => ctx.launch());
  await ctx.step('Back closes F1, the app stays', async () => {
    await back();
    if (!(await ctx.inForeground())) throw new Error('the app left with F1 open');
    await page.locator('[data-invite-action="paste"]').waitFor({ state: 'detached', timeout: 10_000 });
  });
  await ctx.step('the next Back leaves the app', leaves);
  await ctx.shot('after-back-local');
  await ctx.step('launch: F1 again', () => ctx.launch());
  await ctx.step('open the error screen', () => ctx.openAccount());
  await ctx.step('Back on the error screen leaves the app', leaves);
  await ctx.shot('after-back-error');
}
