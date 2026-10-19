// The native lock screen (bd med-nt9p.32.12), light then dark, via the debug-only wgQALock extra.
export default async function nativeLock(ctx) {
  for (const mode of ['no', 'yes']) {
    await ctx.shell(`cmd uimode night ${mode}`);
    await ctx.step(`lock screen (night ${mode})`, async () => {
      await ctx.shell(`am force-stop ${ctx.pkg}`);
      await ctx.shell(`am start -W -n ${ctx.pkg}/com.example.medtracker.MainActivity --ez wgQALock true`);
      await ctx.waitFor({ text: 'Unlock' });
    });
    await ctx.shot(mode === 'yes' ? 'lock-dark' : 'lock-light');
  }
}
