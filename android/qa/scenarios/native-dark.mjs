// The native screens in system dark mode (applied before launch; the runner restores the inputs after).
export default async function nativeDark(ctx) {
  await ctx.shell('cmd uimode night yes');
  await ctx.step('launch on first run (dark)', () => ctx.launch());
  await ctx.shot('first-run');
  await ctx.step('error screen (dark)', () => ctx.openAccount());
  await ctx.shot('error');
}
