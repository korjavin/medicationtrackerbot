// The agent's default (bd med-nt9p.25): claim the run's invite with the debug-only soft
// authenticator → wizard → Today / Meds / Vitals / Food / Settings → the add-BP sheet with the
// keyboard up (rotated too) → Back closes the sheet → Back on Today leaves the app → cold
// relaunch unlocks from the warm cache. One invite per run, so this claims it: run it last.
// Back steps are findings, not stoppers: they record PASS/FAIL and the scenario goes on.

const TABS = [['today', 'today'], ['meds', 'meds'], ['vitals', 'health'], ['food', 'food'], ['settings', 'settings']];

export default async function smoke(ctx) {
  const r = (ctx.results.smoke = {});
  const { device, shell, sleep } = ctx;
  let page = await ctx.step('invite opens the signup wizard (soft authenticator)', () => ctx.openClaim({ softAuthn: true }));
  await ctx.shot('wizard');

  await ctx.step('create the passkey', async () => {
    await page.click('#create-passkey');
    await page.locator('#loss-ack-checkbox').waitFor({ timeout: 60_000 });
  });
  await ctx.shot('loss-ack');
  await ctx.step('loss-ack → emergency kit', async () => {
    await page.check('#loss-ack-checkbox');
    await page.click('#loss-ack-continue');
    await page.locator('#kit-download').waitFor({ timeout: 30_000 });
  });
  await ctx.shot('kit');
  await ctx.step('kit download offers Save/Share', async () => {
    await page.click('#kit-download');
    await ctx.waitFor({ text: 'Save to device' }, 15_000);
  });
  await ctx.shot('kit-save-share');
  await ctx.step('dismiss Save/Share and continue', async () => {
    await shell('input keyevent KEYCODE_BACK');
    await sleep(1000);
    if (!(await page.isChecked('#kit-saved-checkbox'))) await page.check('#kit-saved-checkbox');
    await page.click('#kit-continue');
    await sleep(1500);
    const skip = page.locator('#install-skip');
    if (await skip.count()) { await ctx.shot('install-nudge'); await skip.click(); }
  });
  await ctx.step('vault opens', () => waitForVault(page));
  // The onboarding wizard (WGFirstRun) covers the app on a fresh account: screenshot it, Skip all.
  await ctx.step('onboarding wizard → Skip all', async () => {
    const skipAll = page.locator('[data-firstrun-action="skip-all"]');
    await skipAll.waitFor({ timeout: 20_000 });
    await ctx.shot('onboarding');
    await skipAll.click();
    await skipAll.waitFor({ state: 'detached', timeout: 15_000 });
    await sleep(1500);
  }).catch(() => {});
  await ctx.shot('first-today');

  for (const [label, tab] of TABS) {
    await ctx.step(`tab ${label}`, async () => {
      await page.evaluate((t) => window.switchTab(t), tab);
      await sleep(1500);
    });
    await ctx.shot(`tab-${label}`);
  }

  await page.evaluate(() => window.switchTab('today'));
  const sheetOpen = () => page.evaluate(() => window.ModalManager._isVisible('bp-modal'));
  r.imeUpBeforeSheet = await imeShown(ctx); // a keyboard left over from an earlier input is a finding
  await ctx.step('add-BP sheet opens', async () => {
    await page.evaluate(() => window.showBPRecordModal());
    await sleep(800);
    if (!(await sheetOpen())) throw new Error('bp-modal not visible');
  });
  const before = await page.evaluate(() => innerHeight);
  await ctx.step('tap systolic → keyboard up', async () => {
    await tapElement(ctx, page, '#bp-systolic');
    const end = Date.now() + 10_000;
    while (Date.now() < end && !(await imeShown(ctx))) await sleep(500);
    r.keyboard = await page.evaluate(() => {
      const el = document.activeElement;
      const b = el && el.getBoundingClientRect();
      const vv = window.visualViewport;
      const bottom = vv ? vv.offsetTop + vv.height : innerHeight;
      return { focused: el && el.id, innerHeight, visualHeight: vv && vv.height, inputBottom: b && b.bottom, inputVisible: !!b && b.bottom <= bottom && b.top >= 0 };
    });
    r.keyboard.imeShown = await imeShown(ctx);
    r.keyboard.innerHeightBefore = before;
    if (!r.keyboard.imeShown) throw new Error(`no IME (${JSON.stringify(r.keyboard)})`);
  }).catch(() => {});
  await ctx.shot('bp-sheet-keyboard');

  // Portrait-locked shells ignore this (bd med-nt9p.29); the shot shows what the user would see.
  await shell(`settings put system user_rotation ${ctx.inputs.landscape ? 0 : 1}`);
  await sleep(1500);
  await ctx.shot('bp-sheet-rotated');
  await shell(`settings put system user_rotation ${ctx.inputs.landscape ? 1 : 0}`);
  await sleep(1500);

  // Back with the keyboard up first hides the keyboard (Android), then closes the sheet.
  r.backPressesToCloseSheet = await ctx.step('Back closes the sheet (keyboard first)', async () => {
    for (let n = 1; n <= 2; n++) {
      await shell('input keyevent KEYCODE_BACK');
      await sleep(1500);
      if (!(await ctx.inForeground())) throw new Error(`app left on Back #${n} with the sheet open`);
      if (!(await sheetOpen())) return n;
    }
    throw new Error('sheet still open after 2 Backs');
  }).catch(() => undefined);
  await ctx.shot('after-back-sheet');

  r.backPressesToLeave = await ctx.step('one Back on Today leaves the app', async () => {
    if (await sheetOpen()) await page.evaluate(() => window.ModalManager.bp.close());
    await page.evaluate(() => window.switchTab('today'));
    await sleep(800);
    for (let n = 1; n <= 6; n++) {
      await shell('input keyevent KEYCODE_BACK');
      await sleep(1500);
      if (!(await ctx.inForeground())) {
        if (n > 1) throw new Error(`took ${n} Backs`);
        return n;
      }
    }
    throw new Error('still in the app after 6 Backs');
  }).catch(() => undefined);
  await ctx.shot('after-back-today');

  // Cold process, warm vault: no SWITCH action, so the stored account reopens.
  await ctx.step('relaunch unlocks', async () => {
    await shell(`am force-stop ${ctx.pkg}`);
    await shell(`am start -W -n ${ctx.pkg}/com.example.medtracker.MainActivity --ez qaSoftAuthn true`);
    page = await ctx.attachPage();
    if (!page) throw new Error('no WebView page after relaunch');
    await waitForVault(page);
    r.relaunchUrl = new URL(page.url()).pathname;
    await sleep(2000);
  });
  await ctx.shot('relaunch-today');
}

// MedTrackerCloudReady resolves once cloud-boot installed the API shim (e2e/vault-roundtrip.mjs).
async function waitForVault(page) {
  await page.waitForFunction(() => Boolean(window.MedTrackerCloudReady), null, { timeout: 60_000 });
  await page.evaluate(() => window.MedTrackerCloudReady);
  if (!(await page.evaluate(() => Boolean(window.MedTrackerCloud && window.MedTrackerCloud.ctx)))) {
    throw new Error('boot resolved without an unlocked vault');
  }
}

// A real touch (so the IME opens like a finger's tap): CSS rect → the WebView's on-screen bounds.
async function tapElement(ctx, page, selector) {
  const rect = await page.evaluate((s) => {
    const b = document.querySelector(s).getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: innerWidth };
  }, selector);
  const { bounds } = await ctx.device.info({ clazz: 'android.webkit.WebView' });
  const k = bounds.width / rect.w;
  await ctx.device.input.tap({ x: Math.round(bounds.x + rect.x * k), y: Math.round(bounds.y + rect.y * k) });
}

async function imeShown(ctx) {
  return /mInputShown=true|mIsInputViewShown=true|isInputViewShown=true/.test(await ctx.shell('dumpsys input_method'));
}
