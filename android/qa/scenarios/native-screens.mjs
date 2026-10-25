// The native screens left on the token mirror (bd med-ckm5.14, docs/design/claude-design/ui_kits/
// app-v2/screens-native.html), one shot per state for reading against the frames: the launch screen
// (bd med-ta2n.12: local mode with the web's F1 — N1/N2 are gone), N4 · 503, N4 · 404 and N4 · local,
// N3 locked, and the Health Connect rationale (its Privacy policy link: https://<QA base>/privacy).
// Dispatch with font_scale=2.0 for the 2x frames.
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

  // The privacy link is built from the build's base domain (bd med-ffuu.4); the QA build's is
  // qa.test (android-qa.yml). Logcat's START line elides the path ("https://qa.test/..."), so the
  // path is read from Chrome's URL bar once its first-run screen is dismissed.
  await ctx.step('Health Connect rationale: Privacy policy → ACTION_VIEW https://qa.test/privacy', async () => {
    const views = async () => (await shell('logcat -d -s ActivityTaskManager'))
      .split('\n').filter((x) => x.includes('android.intent.action.VIEW') && x.includes('qa.test'));
    const seen = (await views()).length;
    await device.tap({ text: 'Privacy policy' });
    await ctx.sleep(2500);
    const hit = (await views())[seen];
    if (!hit) throw new Error('no ACTION_VIEW for qa.test in logcat');
    ctx.log('intent:', hit.trim());
    if (!/dat=https:\/\/qa\.test\/(privacy\b|\.\.\.)/.test(hit)) throw new Error(`not the privacy URL: ${hit.trim()}`);
    const seen2 = (sel) => device.wait(sel, { timeout: 1_000 }).then(() => true, () => false);
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      if (await seen2({ text: /^(https:\/\/)?qa\.test\/privacy$/ })) return;
      for (const text of ['Use without an account', 'No thanks', 'No, thanks']) {
        if (await seen2({ text })) await device.tap({ text });
      }
    }
    throw new Error('Chrome URL bar never showed qa.test/privacy');
  });
  await ctx.shot('hc-rationale-privacy');
}
