// Fresh A client: assert the actual return, its version check and the B notice.
import { control, foreground, prepareAccount, state, waitForWaitingWorker } from './update-banner.mjs';
import { readFileSync } from 'node:fs';
export const retry = false;

export default async function updateResume(ctx) {
  const r = (ctx.results.updateResume = { lifecycle: [] });
  const page = await prepareAccount(ctx, r);
  await ctx.step('deploy B and resume A without a synthetic event', async () => {
    r.switch = await control('/switch-b', {});
    const version = await page.evaluate(async () => (await (await fetch('/api/version', { cache: 'no-store' })).json()).build_id);
    if (version !== r.bundles.B.stamp) throw new Error('server is not B');
    if (!process.env.QA_RECEIPTS) throw new Error('QA_RECEIPTS unset');
    const observation = await foreground(ctx, page, r);
    const until = Date.now() + 15_000;
    do {
      r.resumeReceipts = readFileSync(process.env.QA_RECEIPTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
        .filter((entry) => entry.path === '/api/version' && entry.host === new URL(page.url()).host && Date.parse(entry.at) >= observation.returnStarted);
      if (r.resumeReceipts.length) break;
      await ctx.sleep(250);
    } while (Date.now() < until);
    if (!r.resumeReceipts.length) throw new Error('no version check received after native return');
    await page.locator('#cloud-update-banner').waitFor({ timeout: 60_000 });
    await waitForWaitingWorker(page);
    r.waiting = await state(page);
    if (r.waiting.build !== r.bundles.A.stamp || r.waiting.banners !== 1 || r.waiting.waiting !== 'installed') {
      throw new Error('real resume did not show one notice and install waiting B');
    }
    await ctx.stableShot('resume-A-with-B-waiting');
  });
}
