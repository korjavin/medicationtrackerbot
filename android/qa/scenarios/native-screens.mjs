// The native screens left on the token mirror (bd med-ckm5.14, docs/design/claude-design/ui_kits/
// app-v2/screens-native.html), one shot per state for reading against the frames: the launch screen
// (bd med-ta2n.12: local mode with the web's F1 — N1/N2 are gone), N4 · 503, N4 · 404 and N4 · local,
// N3 locked, and the Health Connect rationale. Dispatch with font_scale=2.0 for the 2x frames.
// No invite used.
export default async function nativeScreens(ctx) {
  const { device, shell, pkg } = ctx;

  await ctx.step('launch: local mode, F1 (no native first run)', async () => {
    await ctx.launch();
    for (const gone of ['Only on this device', 'Paste invite link or address']) {
      if (await device.wait({ text: gone }, { timeout: 1_000 }).then(() => true, () => false)) throw new Error(`native first run: "${gone}"`);
    }
  });
  await ctx.shot('launch-f1');

  await ctx.step('N4 · 503', async () => {
    await ctx.openAccount('https://down.qa.test/');
    await ctx.waitFor({ text: 'Can\'t reach your account' }, 5_000);
  });
  await ctx.shot('n4-503');

  await ctx.step('N4 · 404', async () => {
    await ctx.launch();
    await ctx.openAccount('https://stale.qa.test/');
    await ctx.waitFor({ text: 'We can\'t find this account' }, 5_000);
  });
  await ctx.shot('n4-404');

  await ctx.step('N4 · 404 → Use another invite → F1', async () => {
    await device.tap({ text: 'Use another invite' });
    await ctx.sleep(2000);
    await ctx.localPage((p) => p.locator('[data-invite-action="paste"]').waitFor({ state: 'visible', timeout: 60_000 }));
  });
  await ctx.shot('n4-404-exit');

  await ctx.step('N4 · local', async () => {
    await shell(`am force-stop ${pkg}`);
    await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity --ez wgLocalMode true --ez wgQALocalError true`);
    await ctx.waitFor({ text: 'Can\'t open Med Tracker' });
  });
  await ctx.shot('n4-local');

  await ctx.step('N3 locked', async () => {
    await shell(`am force-stop ${pkg}`);
    await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity --ez wgLocalMode true --ez wgQALock true`);
    await ctx.waitFor({ text: 'Med Tracker is locked' }, 30_000);
  });
  await ctx.shot('n3-locked');

  await ctx.step('Health Connect rationale', async () => {
    await shell(`am force-stop ${pkg}`);
    await shell(`am start -W -a androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE -n ${pkg}/com.example.medtracker.PermissionsRationaleActivity`);
    await ctx.waitFor({ text: 'Health Connect access' }, 10_000);
  });
  await ctx.shot('hc-rationale');
}
