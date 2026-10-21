// The native error screen in system dark mode, and the web's F1 that replaced the native first run
// (bd med-ta2n.12), applied before launch; the runner restores the inputs after.
export default async function nativeDark(ctx) {
  await ctx.shell('cmd uimode night yes');
  await ctx.step('launch: local mode, F1 (dark)', () => ctx.launch());
  await ctx.shot('f1');
  await ctx.step('error screen (dark)', () => ctx.openAccount());
  await ctx.shot('error');
}
