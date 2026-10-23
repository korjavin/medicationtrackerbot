// Native push on the shell (bd med-erq1.5, Push.kt): local mode neither lists nor answers push.token;
// the account lists it and answers null (the QA build has no Firebase config); a fake FCM message
// (debug-only QaPush receiver, the same Push.deliver an FCM message runs) with the app in front
// reaches the page as the wg:native-push event and posts nothing; with the app in the background it
// posts the fixed, content-free notification instead. results.push has the checks.
// Claims the run's one invite: not in `all` (smoke claims it there), no retry.
import { claimAccount } from './smoke.mjs';

export const retry = false;

const INBOX_TEXT = 'Open the app to record what you sent';
const DRY_TEXT = 'Open the app to keep reminders running';

/** The page's own bridge call (native/index.js): {ok, result} or {ok: false, error}. */
const call = (page, op, args) => page.evaluate(([o, a]) => window.LocalNotifications.__native.call(o, a)
  .then((result) => ({ ok: true, result }), (e) => ({ ok: false, error: String(e && e.message) })), [op, args]);

const expect = (cond, what) => { if (!cond) throw new Error(what); };

export default async function pushWake(ctx) {
  const { shell, pkg, sleep } = ctx;
  const r = (ctx.results.push = {});
  await shell(`pm clear ${pkg}`);
  // The fallback needs the grant; given before launch, so no false → true 'token' edge below.
  await shell(`pm grant ${pkg} android.permission.POST_NOTIFICATIONS`);
  const wake = (kind) => shell(`am broadcast -n ${pkg}/com.example.medtracker.QaPush --es kind ${kind}`);
  const shade = () => shell('dumpsys notification --noredact');

  let page = await ctx.step('local mode', () => ctx.launchLocal('today'));
  await ctx.step('local: push.token neither listed nor answered', async () => {
    const ops = await call(page, 'shell.ops');
    expect(ops.ok && !ops.result.includes('push.token'), `local shell.ops ${JSON.stringify(ops)}`);
    const t = await call(page, 'push.token');
    expect(!t.ok && t.error === 'unsupported: push.token', `local push.token ${JSON.stringify(t)}`);
  });

  page = await ctx.openClaim({ softAuthn: true });
  await claimAccount(ctx, page);

  await ctx.step('account: push.token listed, null without Firebase', async () => {
    const ops = await call(page, 'shell.ops');
    expect(ops.ok && ops.result.includes('push.token'), `shell.ops ${JSON.stringify(ops)}`);
    const t = await call(page, 'push.token');
    r.token = t;
    expect(t.ok && t.result === null, `push.token ${JSON.stringify(t)}`);
  });

  await ctx.step('in front: inbox-wake reaches the page, no notification', async () => {
    await page.evaluate(() => {
      window.__qaPush = [];
      document.addEventListener('wg:native-push', (e) => window.__qaPush.push(e.detail && e.detail.kind));
    });
    await wake('inbox-wake');
    await page.waitForFunction(() => window.__qaPush.includes('inbox-wake'), null, { timeout: 15_000 });
    r.events = await page.evaluate(() => window.__qaPush);
    await sleep(1500);
    expect(!(await shade()).includes(INBOX_TEXT), 'a notification was posted with the page in front');
  });
  await ctx.shot('front-wake');

  await ctx.step('in the background: dry-queue posts the fixed notification, no page event', async () => {
    await shell('input keyevent KEYCODE_HOME');
    await sleep(2000);
    await wake('dry-queue');
    await sleep(2000);
    const s = await shade();
    r.posted = s.includes(DRY_TEXT);
    expect(r.posted, 'no dry-queue notification');
    expect(!(await page.evaluate(() => window.__qaPush.includes('dry-queue'))), 'the background page got the wake');
  });
  await shell('cmd statusbar expand-notifications');
  await sleep(1500);
  await ctx.shot('background-notification');
  await shell('cmd statusbar collapse');
}
