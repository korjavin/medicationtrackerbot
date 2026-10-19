// A link off the account host (a target=_blank anchor, then location.href) leaves the WebView where
// it was and hands the URL to ACTION_VIEW (no browser on the image is fine: the shell swallows it).
export default async function externalLink(ctx) {
  const page = await ctx.step('invite opens the signup wizard', () => ctx.openClaim());
  const before = page.url();
  for (const [how, js] of [
    ['anchor', () => { const a = document.createElement('a'); a.href = 'https://example.com/'; a.target = '_blank'; document.body.append(a); a.click(); }],
    ['location', () => { location.href = 'https://example.com/'; }],
  ]) {
    await ctx.shell('logcat -c');
    await ctx.step(`${how}: WebView URL unchanged`, async () => {
      await page.evaluate(js);
      await ctx.sleep(2500);
      if (page.url() !== before) throw new Error(`WebView moved to ${page.url()}`);
    });
    await ctx.step(`${how}: ACTION_VIEW for example.com in logcat`, async () => {
      const l = await ctx.shell('logcat -d');
      const hit = l.split('\n').find((x) => x.includes('android.intent.action.VIEW') && x.includes('example.com'));
      if (!hit) throw new Error('no ACTION_VIEW line for example.com');
      ctx.log('intent:', hit.trim());
    });
    await ctx.shot(`after-${how}`);
    // A browser on the image would have taken the foreground; come back to the same activity.
    if (!(await ctx.inForeground())) await ctx.shell(`am start -n ${ctx.pkg}/com.example.medtracker.MainActivity`);
  }
}
