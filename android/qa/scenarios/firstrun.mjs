// First run → bad-host error screen → Switch account → first run again.
export default async function firstrun(ctx) {
  await ctx.step('launch on first run', () => ctx.launch());
  await ctx.shot('first-run');
  // Discovery only (harness beads 2/3 need it): can Playwright reach the WebView's DevTools socket?
  await ctx.step('playwright attaches to the WebView', async () => {
    const page = await ctx.attachPage();
    if (!page) throw new Error('no WebView page (see the run log)');
    ctx.log('webview url', page.url());
  }).catch(() => {});
  await ctx.step('Open https://down.qa.test/ (503) shows the error screen', () => ctx.openAccount(undefined, { shotTyped: true }));
  await ctx.shot('error');
  await ctx.step('Switch account returns to first run', async () => {
    await ctx.device.tap({ text: 'Switch account' });
    await ctx.waitFor({ text: 'Continue' });
  });
  await ctx.shot('first-run-again');
}
