// The native lock screen (N3, bd med-nt9p.32.12 / med-ckm5.16), light then dark, via the
// debug-only wgQALock extra: the mark tile at the window's centre, no account name, Unlock the only
// control; then the failed-attempt note (wgQALockFailed). The first frame after a cold start is the
// splash (N6, wg_screen + the mark in the same spot): shot before the lock replaces it.
const start = (ctx, extras) =>
  ctx.shell(`am start -n ${ctx.pkg}/com.example.medtracker.MainActivity --splashscreen-show-icon --ez wgQALock true${extras}`);

export default async function nativeLock(ctx) {
  for (const mode of ['no', 'yes']) {
    await ctx.shell(`cmd uimode night ${mode}`);
    await ctx.shell(`am force-stop ${ctx.pkg}`);
    await start(ctx, '');
    await ctx.sleep(250);
    await ctx.shot(mode === 'yes' ? 'splash-dark' : 'splash-light');
    await ctx.step(`lock screen (night ${mode})`, async () => {
      await ctx.waitFor({ text: 'Unlock' });
      await ctx.waitFor({ text: 'Unlock with your fingerprint, face or screen lock.' }, 5_000);
      const note = await ctx.device.wait({ text: /^Not recognised.*/ }, { timeout: 1_000 }).then(() => true, () => false);
      if (note) throw new Error('the failed note shows before any attempt');
    });
    await ctx.shot(mode === 'yes' ? 'lock-dark' : 'lock-light');
  }
  await ctx.step('failed attempt: the warn note, Unlock still the only action', async () => {
    await ctx.shell(`am force-stop ${ctx.pkg}`);
    await start(ctx, ' --ez wgQALockFailed true');
    await ctx.waitFor({ text: 'Not recognised. Try again, or use your screen lock.' });
    await ctx.waitFor({ text: 'Unlock' }, 5_000);
  });
  await ctx.shot('lock-failed');
}
