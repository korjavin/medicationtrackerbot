// N4 load error (bd med-ckm5.16, screens-native.html): the three variants with their mono meta line.
// 503 (tlsfront's down.qa.test): "Can't reach your account", Try again / Switch account / Copy
// diagnostics. A bare 404 (stale.qa.test): "We can't find this account", Use another invite leads.
// Local mode (the debug-only wgQALocalError extra; a real bundle never fails): "Can't open Med
// Tracker" with "Use an account instead" and never Switch account. Every exit (Switch account,
// Use an account instead, Use another invite) lands in local mode with F1. No invite used.
const has = (ctx, text) => ctx.device.wait({ text }, { timeout: 1_500 }).then(() => true, () => false);
async function f1(ctx) {
  await ctx.sleep(2000);
  await ctx.localPage((p) => p.locator('[data-invite-action="paste"]').waitFor({ state: 'visible', timeout: 60_000 }));
  await ctx.sleep(1500); // SharedPreferences.apply() writes asynchronously
  const xml = await ctx.shell(`run-as ${ctx.pkg} cat shared_prefs/shell.xml`);
  if (/accountHost/.test(xml) || !/name="wgLocalMode" value="true"/.test(xml)) throw new Error(`prefs: ${xml}`);
}

export default async function loadError(ctx) {
  await ctx.step('503: Can\'t reach your account', async () => {
    await ctx.launch();
    await ctx.openAccount('https://down.qa.test/');
    await ctx.waitFor({ text: 'Can\'t reach your account' }, 5_000);
    await ctx.waitFor({ text: /^503 · service unavailable · \d\d:\d\d$/ }, 5_000);
    for (const t of ['Try again', 'Switch account']) await ctx.waitFor({ text: t }, 5_000);
  });
  await ctx.shot('error-503');
  await ctx.step('Copy diagnostics copies the log', async () => {
    await ctx.device.tap({ text: 'Copy diagnostics' });
    await ctx.sleep(500);
    await ctx.waitFor({ text: 'Can\'t reach your account' }, 5_000); // stays on the screen
  });
  await ctx.step('Switch account → local mode with F1 (bd med-ta2n.12)', async () => {
    await ctx.device.tap({ text: 'Switch account' });
    await f1(ctx);
  });

  await ctx.step('bare 404: We can\'t find this account', async () => {
    await ctx.launch();
    await ctx.openAccount('https://stale.qa.test/');
    await ctx.waitFor({ text: 'We can\'t find this account' }, 5_000);
    await ctx.waitFor({ text: /^404 · not found · \d\d:\d\d$/ }, 5_000);
    for (const t of ['Use another invite', 'Try again']) await ctx.waitFor({ text: t }, 5_000);
    if (await has(ctx, 'Switch account')) throw new Error('404 offers Switch account');
  });
  await ctx.shot('error-404');

  await ctx.step('local: Can\'t open Med Tracker, never Switch account', async () => {
    await ctx.shell(`am force-stop ${ctx.pkg}`);
    await ctx.shell(`am start -W -n ${ctx.pkg}/com.example.medtracker.MainActivity --ez wgLocalMode true --ez wgQALocalError true`);
    await ctx.waitFor({ text: 'Can\'t open Med Tracker' });
    await ctx.waitFor({ text: /^local · bundle failed to load · \d\d:\d\d$/ }, 5_000);
    for (const t of ['Try again', 'Use an account instead', 'Copy diagnostics']) await ctx.waitFor({ text: t }, 5_000);
    if (await has(ctx, 'Switch account')) throw new Error('local mode offers Switch account');
  });
  await ctx.shot('error-local');
  await ctx.step('Use an account instead → local mode with F1', async () => {
    await ctx.device.tap({ text: 'Use an account instead' });
    await f1(ctx);
  });
  await ctx.step('bare 404: Use another invite → local mode with F1', async () => {
    await ctx.launch();
    await ctx.openAccount('https://stale.qa.test/');
    await ctx.device.tap({ text: 'Use another invite' });
    await f1(ctx);
  });
}
