// System Back walks the page's own back stack (bd med-y7b4.5, web AppBack med-y7b4.3): the shell asks
// the page (wg:native-back) while it reported back.state {canStep: true}, and registers no callback at
// the root, so Back there leaves the app. Local mode: a sheet, a Settings sub-page, the section trail,
// then Today leaves. Account mode (dispatched alone): the section trail, then Today leaves.
import { claimAccount } from './smoke.mjs';

export default async function backStack(ctx) {
  const { sleep } = ctx;
  const r = (ctx.results.backStack = {});
  let page;
  const back = async () => {
    await ctx.shell('input keyevent KEYCODE_BACK');
    await sleep(1500);
    if (!(await ctx.inForeground())) throw new Error('the app left on a Back that had something to step');
  };
  const tab = () => page.evaluate(() => window.AppStore.get('currentTab'));
  const expectTab = async (want) => {
    const t = await tab();
    if (t !== want) throw new Error(`section ${t}, expected ${want}`);
  };
  const go = async (t) => {
    await page.evaluate((x) => window.switchTab(x), t);
    await page.waitForFunction((id) => !!document.getElementById(id)?.offsetParent, `${t}-view`, { timeout: 15_000 });
    await sleep(800);
  };
  const leaves = async () => {
    if (await page.evaluate(() => window.AppBack.canStep())) throw new Error('canStep at Today');
    await ctx.shell('input keyevent KEYCODE_BACK');
    await sleep(1500);
    if (await ctx.inForeground()) throw new Error('activity still in the foreground after Back at Today');
  };
  const trail = async (label) => {
    await ctx.step(`${label}: Today → Meds → Food`, async () => {
      await go('meds');
      await go('food');
    });
    await ctx.shot(`${label}-food`);
    await ctx.step(`${label}: Back returns to Meds`, async () => { await back(); await expectTab('meds'); });
    await ctx.shot(`${label}-back-meds`);
    await ctx.step(`${label}: Back returns to Today`, async () => { await back(); await expectTab('today'); });
    await ctx.shot(`${label}-back-today`);
  };

  page = await ctx.step('launch: local mode on Today', async () => {
    const p = await ctx.launchLocal('today');
    await sleep(2000);
    return p;
  });
  await ctx.shot('local-today');

  const sheetOpen = () => page.evaluate(() => window.ModalManager._isVisible('bp-modal'));
  await ctx.step('add-BP sheet opens', async () => {
    await page.evaluate(() => window.showBPRecordModal());
    await sleep(2500);
    if (!(await sheetOpen())) throw new Error('bp-modal not visible');
  });
  await ctx.shot('local-sheet');
  // Its focus() may raise the keyboard: the first Back then only hides it.
  await ctx.step('Back closes the sheet, the app stays on Today', async () => {
    for (let n = 1; n <= 2; n++) {
      await back();
      if (!(await sheetOpen())) { r.backsToCloseSheet = n; return expectTab('today'); }
    }
    throw new Error('sheet still open after 2 Backs');
  });
  await ctx.shot('local-sheet-closed');

  const unitsOpen = () => page.evaluate(() => !document.querySelector('.wg-settings-pages > [data-settings-page="units"]'));
  await ctx.step('Settings → Units sub-page', async () => {
    await page.locator('[data-nav-to="settings"]:visible').first().click();
    await page.waitForFunction(() => !!document.getElementById('settings-view')?.offsetParent, null, { timeout: 15_000 });
    await page.locator('[data-settings-open="units"]:visible').first().click();
    await page.waitForFunction(() => !document.querySelector('.wg-settings-pages > [data-settings-page="units"]'), null, { timeout: 10_000 });
    await sleep(800);
  });
  await ctx.shot('local-settings-units');
  await ctx.step('Back closes the sub-page, Settings stays', async () => {
    await back();
    if (await unitsOpen()) throw new Error('Units still open');
    await expectTab('settings');
  });
  await ctx.shot('local-settings');
  await ctx.step('Back leaves Settings for Today', async () => { await back(); await expectTab('today'); });

  await trail('local');
  await ctx.step('local: Back at Today leaves the app', leaves);
  await ctx.shot('local-left');

  // Account mode: the run's one invite, claimed with the soft authenticator (smoke.mjs). Dispatched
  // alone only: in `all` it would spend the invite claim-page, invite-link and smoke run on.
  if (ctx.inputs.scenario !== 'back-stack') return;
  page = await ctx.step('account: invite opens the signup wizard', () => ctx.openClaim({ softAuthn: true }));
  await claimAccount(ctx, page);
  await go('today');
  await trail('account');
  await ctx.step('account: Back at Today leaves the app', leaves);
  await ctx.shot('account-left');
}
