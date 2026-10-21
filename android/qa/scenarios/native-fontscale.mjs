// The native error screen at large system font scales, and the web's F1 that replaced the native first
// run (bd med-ta2n.12); applied before launch, the runner restores the inputs after.
export default async function nativeFontscale(ctx) {
  for (const scale of ['1.3', '2.0']) {
    await ctx.shell(`settings put system font_scale ${scale}`);
    await ctx.step(`launch: local mode, F1 (font ${scale})`, () => ctx.launch());
    await ctx.shot(`f1-${scale}`);
    await ctx.step(`error screen (font ${scale})`, () => ctx.openAccount());
    await ctx.shot(`error-${scale}`);
  }
}
