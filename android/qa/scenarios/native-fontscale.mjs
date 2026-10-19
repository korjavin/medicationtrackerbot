// The native screens at large system font scales (applied before launch; the runner restores the inputs after).
export default async function nativeFontscale(ctx) {
  for (const scale of ['1.3', '2.0']) {
    await ctx.shell(`settings put system font_scale ${scale}`);
    await ctx.step(`launch on first run (font ${scale})`, () => ctx.launch());
    await ctx.shot(`first-run-${scale}`);
    await ctx.step(`error screen (font ${scale})`, () => ctx.openAccount());
    await ctx.shot(`error-${scale}`);
  }
}
