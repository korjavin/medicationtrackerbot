// Fresh A client: the only stimulus after B deploys is a real Home/return.
import { control, foreground, prepareAccount, state, waitForWaitingWorker } from './update-banner.mjs';
export const retry = false;

export default async function updateResume(ctx) {
  const r = (ctx.results.updateResume = { lifecycle: [] });
  const page = await prepareAccount(ctx, r);
  await ctx.step('deploy B and resume A without a synthetic event', async () => {
    r.switch = await control('/switch-b', {});
    const version = await page.evaluate(async () => (await (await fetch('/api/version', { cache: 'no-store' })).json()).build_id);
    if (version !== r.bundles.B.stamp) throw new Error('server is not B');
    await foreground(ctx, page, r);
    await page.locator('#cloud-update-banner').waitFor({ timeout: 60_000 });
    await waitForWaitingWorker(page);
    r.waiting = await state(page);
    if (r.waiting.build !== r.bundles.A.stamp || r.waiting.banners !== 1 || r.waiting.waiting !== 'installed') {
      throw new Error('real resume did not show one notice and install waiting B');
    }
    await ctx.stableShot('resume-A-with-B-waiting');
  });
}
