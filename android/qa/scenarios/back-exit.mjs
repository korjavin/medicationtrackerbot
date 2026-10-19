// One Back press on a native screen leaves the app (the activity is no longer the resumed one).
export default async function backExit(ctx) {
  const leaves = async () => {
    await ctx.shell('input keyevent KEYCODE_BACK');
    await ctx.sleep(1500);
    if (await ctx.inForeground()) throw new Error('activity still in the foreground after one Back');
  };
  await ctx.step('launch on first run', () => ctx.launch());
  await ctx.step('Back on first run leaves the app', leaves);
  await ctx.shot('after-back-first-run');
  await ctx.step('launch on first run again', () => ctx.launch());
  await ctx.step('open the error screen', () => ctx.openAccount());
  await ctx.step('Back on the error screen leaves the app', leaves);
  await ctx.shot('after-back-error');
}
