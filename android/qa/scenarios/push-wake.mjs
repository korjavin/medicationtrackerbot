// Native push on the shell (bd med-erq1.5, Push.kt): local mode neither lists nor answers push.token;
// the account lists it and answers null (the QA build has no Firebase config); a fake FCM message
// (debug-only QaPush receiver, the same Push.deliver an FCM message runs) with the app in front
// reaches the page as the wg:native-push event and posts nothing; with the app in the background it
// posts the fixed, content-free notification instead. transfer_claimed (bd med-r1j2.15): acked in
// front → nothing posted; in the background its tap lands on Settings → Add a device. results.push has the checks.
// Claims the run's one invite: not in `all` (smoke claims it there), no retry.
import { claimAccount } from './smoke.mjs';

export const retry = false;

const INBOX_TEXT = 'Open the app to record what you sent';
const DRY_TEXT = 'Open the app to keep reminders running';
const TRANSFER_TITLE = 'Approve the new device?';

/** The page's own bridge call (native/index.js): {ok, result} or {ok: false, error}. */
const call = (page, op, args) => page.evaluate(([o, a]) => window.LocalNotifications.__native.call(o, a)
  .then((result) => ({ ok: true, result }), (e) => ({ ok: false, error: String(e && e.message) })), [op, args]);

const expect = (cond, what) => { if (!cond) throw new Error(what); };

export default async function pushWake(ctx) {
  const { shell, pkg, sleep, device } = ctx;
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

  // transfer_claimed (bd med-r1j2.15): cloud-boot does not take it (the web shows its notification
  // even in front), so a QA listener stands in for an ack to check the receipt suppresses it.
  await ctx.step('in front: an acked transfer_claimed posts no notification', async () => {
    await page.evaluate(() => document.addEventListener('wg:native-push', (e) => {
      if (e.detail && e.detail.kind === 'transfer_claimed') e.preventDefault();
    }));
    await wake('transfer_claimed');
    await page.waitForFunction(() => window.__qaPush.includes('transfer_claimed'), null, { timeout: 15_000 });
    await sleep(1500);
    expect(!(await shade()).includes(TRANSFER_TITLE), 'an acked transfer_claimed was posted');
  });

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

  // Each kind has its own PendingIntent: a later wake must not rewrite the kind a shade entry
  // carries (Argus #1361). Order 1: dry-queue after transfer_claimed, then tap Approve.
  await ctx.step('in the background: transfer_claimed posts "Approve the new device?"; its tap opens Add a device', async () => {
    await wake('transfer_claimed');
    await sleep(2000);
    r.transferPosted = (await shade()).includes(TRANSFER_TITLE);
    expect(r.transferPosted, 'no transfer_claimed notification');
    await wake('dry-queue');
    await sleep(1500);
    await shell('cmd statusbar expand-notifications');
    await sleep(1500);
    await device.tap({ text: TRANSFER_TITLE });
    // No live flow in this window: Settings → Add a device on its "not open here" end state.
    await page.getByText("This request isn't open here").waitFor({ state: 'visible', timeout: 30_000 });
  });
  await ctx.shot('transfer-tap');

  // Order 2: transfer_claimed after dry-queue, then tap the dry-queue entry: no add-device route.
  await ctx.step('in the background: a dry-queue tap after a later transfer_claimed does not open Add a device', async () => {
    await page.evaluate(() => {
      window.__qaDeeplink = [];
      const open = window.SettingsView.openDevicesDeeplink;
      window.SettingsView.openDevicesDeeplink = (p) => { window.__qaDeeplink.push(p); return open(p); };
    });
    await shell('input keyevent KEYCODE_HOME');
    await sleep(2000);
    await wake('dry-queue');
    await sleep(1000);
    await wake('transfer_claimed');
    await sleep(1500);
    await shell('cmd statusbar expand-notifications');
    await sleep(1500);
    await device.tap({ text: DRY_TEXT });
    await sleep(3000);
    r.dryTapDeeplinks = await page.evaluate(() => window.__qaDeeplink);
    expect(r.dryTapDeeplinks.length === 0, `the dry-queue tap routed: ${JSON.stringify(r.dryTapDeeplinks)}`);
  });
  await shell('cmd statusbar collapse');

  // The server's FCM block: its tap is the launcher intent + CLEAR_TOP (no SINGLE_TOP) with the data
  // payload as extras. singleTop must hand it to the live activity: the page, its in-memory add-device
  // flow and a window marker survive, and the flow is resumed, not replaced by "not open here".
  await ctx.step('server-style tap with a live add-device flow: same page, flow resumed', async () => {
    // Still on the "not open here" page from the Approve tap: its "Make a new code" starts a flow.
    await page.locator('#transfer-retry').click({ timeout: 30_000 });
    await page.locator('#transfer-confirm').click({ timeout: 30_000 });
    await page.getByText('Scan this with your new device').waitFor({ state: 'visible', timeout: 60_000 });
    await page.evaluate(() => { window.__qaMarker = 'live'; window.__qaDeeplink = []; });
    await shell('input keyevent KEYCODE_HOME');
    await sleep(2000);
    await shell(`am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n ${pkg}/com.example.medtracker.MainActivity --activity-clear-top --es kind transfer_claimed`);
    await sleep(3000);
    // A recreated activity destroys this WebView: the evaluate then throws (target closed).
    r.serverTap = await page.evaluate(() => ({ marker: window.__qaMarker, deeplinks: window.__qaDeeplink }));
    expect(r.serverTap.marker === 'live', `page state lost: ${JSON.stringify(r.serverTap)}`);
    expect(r.serverTap.deeplinks.includes('add-device'), `the tap did not route: ${JSON.stringify(r.serverTap)}`);
    // A tap that found no live flow would push "not open here" over it.
    expect(await page.getByText('Scan this with your new device').isVisible(), 'the live flow is gone or covered');
  });
  await ctx.shot('server-tap-live-flow');
}
