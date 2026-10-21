// The run's invite on the local cloud → /unlock signup wizard inside the app, with the page-coloured
// bands and the web-owned exit bar at the top (N5, bd med-ckm5.2; the native bar and its AlertDialog
// are gone, bd med-ckm5.16) → "Not your account?" → its in-page confirm → Cancel keeps the wizard.
// Default, font 1.3, dark; the last variant confirms → account.leave → local mode with F1 (bd med-ta2n.12).
const storedHost = async (ctx) => {
  await ctx.sleep(1500); // SharedPreferences.apply() writes asynchronously
  const xml = await ctx.shell(`run-as ${ctx.pkg} cat shared_prefs/shell.xml`);
  return /name="accountHost">([^<]*)</.exec(xml)?.[1] ?? null;
};

export default async function claimPage(ctx) {
  const variants = [
    ['default', ''],
    ['font-1.3', 'settings put system font_scale 1.3'],
    ['dark', 'cmd uimode night yes'],
  ];
  for (const [i, [label, cmd]] of variants.entries()) {
    await ctx.applyInputs(); // each variant changes one setting from the dispatch inputs
    if (cmd) await ctx.shell(cmd);
    const page = await ctx.step(`invite opens the signup wizard (${label})`, () => ctx.openClaim());
    await ctx.step(`the web exit bar is at the top, no native bar (${label})`, async () => {
      const bar = await page.evaluate(() => {
        const el = document.querySelector('.wg-exitbar');
        return el && { first: document.body.firstElementChild === el, top: el.getBoundingClientRect().top };
      });
      if (!bar || !bar.first || bar.top > 1) throw new Error(`exit bar ${JSON.stringify(bar)}`);
      const native = await ctx.device.wait({ text: 'Not your account? Use another invite' }, { timeout: 1_500 }).then(() => true, () => false);
      if (native) throw new Error('the native ceremony bar is still showing');
    });
    await ctx.shot(`wizard-${label}`);
    await ctx.step(`"Not your account?" asks to confirm (${label})`, async () => {
      await ctx.tapElement(page, '.wg-exitbar__leave');
      await page.locator('.mt-confirm-modal__confirm').waitFor({ state: 'visible', timeout: 10_000 });
      await ctx.sleep(800); // the emulator paints behind the DOM
    });
    await ctx.shot(`dialog-${label}`);
    if (i < variants.length - 1) {
      await ctx.step(`Cancel keeps the wizard (${label})`, async () => {
        await ctx.tapElement(page, '.mt-confirm-modal__cancel');
        await page.locator('.mt-confirm-modal__confirm').waitFor({ state: 'detached', timeout: 10_000 });
        if (!/\/unlock/.test(page.url())) throw new Error(`left the wizard: ${page.url()}`);
      });
    } else {
      await ctx.step(`Use another invite → local mode with F1, host forgotten (${label})`, async () => {
        await ctx.tapElement(page, '.mt-confirm-modal__confirm');
        await ctx.sleep(2000);
        await ctx.localPage((p) => p.locator('[data-invite-action="paste"]').waitFor({ state: 'visible', timeout: 60_000 }));
        const h = await storedHost(ctx);
        if (h !== null) throw new Error(`accountHost still stored: ${h}`);
      });
      await ctx.shot(`left-${label}`);
    }
  }
}
