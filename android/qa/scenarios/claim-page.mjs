// The run's invite on the local cloud → /unlock signup wizard inside the app, with the page-coloured
// bands and the native "Use another invite" exit bar → its dialog → Cancel. Default, font 1.3, dark.
export default async function claimPage(ctx) {
  for (const [label, cmd] of [
    ['default', ''],
    ['font-1.3', 'settings put system font_scale 1.3'],
    ['dark', 'cmd uimode night yes'],
  ]) {
    if (cmd) await ctx.shell(cmd);
    await ctx.step(`invite opens the signup wizard (${label})`, () => ctx.openClaim());
    await ctx.shot(`wizard-${label}`);
    await ctx.step(`ceremony bar asks to confirm (${label})`, async () => {
      await ctx.device.tap({ text: 'Not your account? Use another invite' });
      await ctx.waitFor({ text: 'Use another invite?' }, 10_000);
    });
    await ctx.shot(`dialog-${label}`);
    await ctx.step(`Cancel keeps the wizard (${label})`, async () => {
      await ctx.device.tap({ text: 'Cancel' });
      await ctx.sleep(1000);
      if (!/\/unlock/.test(ctx.page.url())) throw new Error(`left the wizard: ${ctx.page.url()}`);
    });
  }
}
