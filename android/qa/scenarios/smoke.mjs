// The agent's default (bd med-nt9p.25): claim the run's invite with the debug-only soft
// authenticator → wizard → Today / Meds / Vitals / Food / Settings → the add-BP sheet with the
// keyboard up (rotated too) → Back closes the sheet → Back on Today leaves the app → cold
// relaunch unlocks from the warm cache. One invite per run, so this claims it: run it last.
// Back steps are findings, not stoppers: they record PASS/FAIL and the scenario goes on.

// ponytail: no retry — the passkey consumes the run's one invite; mint one per attempt if flakes bite.
export const retry = false;

const TABS =[['today', 'today'], ['meds', 'meds'], ['vitals', 'health'], ['food', 'food'], ['settings', 'settings']];

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
      // Settings is not a tab in nav v2: the app-bar gear opens it.
      if (tab === 'settings') await page.locator('[data-nav-to="settings"]:visible').first().click();
      else await page.evaluate((t) => window.switchTab(t), tab);
      await sleep(1500);
      if (!(await page.evaluate((id) => !!document.getElementById(id)?.offsetParent, `${tab}-view`))) throw new Error(`#${tab}-view not shown`);
    });
    await ctx.shot(`tab-${label}`);
  }

  await exportBackup(ctx, page, r);

  await page.evaluate(() => window.switchTab('today'));
  const sheetOpen = () => page.evaluate(() => window.ModalManager._isVisible('bp-modal'));
  const before = await page.evaluate(() => innerHeight);
  await ctx.step('add-BP sheet opens', async () => {
    await page.evaluate(() => window.showBPRecordModal());
    // Its programmatic focus() may raise the keyboard: let the resize settle before measuring the tap.
    await sleep(2500);
    if (!(await sheetOpen())) throw new Error('bp-modal not visible');
  });
  r.keyboardUpFromFocus = (await page.evaluate(() => innerHeight)) < before - 100;
  await ctx.step('tap systolic → keyboard up', async () => {
    await tapElement(ctx, page, '#bp-systolic');
    const end = Date.now() + 10_000;
    const up = async () => (await page.evaluate(() => innerHeight)) < before - 100 || imeShown(ctx);
    while (Date.now() < end && !(await up())) await sleep(500);
    r.keyboard = await page.evaluate(() => {
      const el = document.activeElement;
      const b = el && el.getBoundingClientRect();
      const vv = window.visualViewport;
      const bottom = vv ? vv.offsetTop + vv.height : innerHeight;
      return { focused: el && el.id, innerHeight, visualHeight: vv && vv.height, inputBottom: b && b.bottom, inputVisible: !!b && b.bottom <= bottom && b.top >= 0 };
    });
    r.keyboard.imeShown = await up();
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
    // Where each Back lands (bd med-nt9p.33): a press that stays in the app names its page.
    const where = () => page.evaluate(() => ({ path: location.pathname, len: history.length, state: history.state })).catch((e) => String(e?.message || e).split('\n')[0]);
    r.backTrail = [await where()];
    for (let n = 1; n <= 6; n++) {
      await shell('input keyevent KEYCODE_BACK');
      await sleep(1500);
      r.backTrail.push(await where());
      if (!(await ctx.inForeground())) {
        if (n > 1) throw new Error(`took ${n} Backs`);
        return n;
      }
      await ctx.shot(`after-back-today-${n}`);
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
  // bd med-nt9p.36: the relaunch shot showed Today empty below the header. Wait for the content
  // (and record what was there) so an empty shot is a failed step, not a silent screenshot.
  await ctx.step('relaunch Today renders content', async () => {
    try {
      await page.waitForFunction(() => document.getElementById('today-content')?.childElementCount > 0, null, { timeout: 20_000 });
    } finally {
      r.relaunchTodayChildren = await page.evaluate(() => document.getElementById('today-content')?.childElementCount ?? -1);
    }
  });
  await ctx.shot('relaunch-today');
}

// bd med-nvd4: Settings → Backup & import → encrypted "Download backup" must end in the shell's
// Save/Share dialog with visible progress on the way. results.smoke.export has each phase's time
// (exportAll / gzip / age), the status line seen while it ran, and the click → dialog time; a
// ~25 MB blob probe checks the shell's blob: download path at a real vault's size. Findings, not
// stoppers. The temp file the shell wrote is deleted after (cache/downloads).
async function exportBackup(ctx, page, r) {
  const { shell, sleep } = ctx;
  const e = (r.export = {});
  const dismiss = async () => {
    await shell('input keyevent KEYCODE_BACK');
    await sleep(1000);
    await shell(`run-as ${ctx.pkg} rm -rf cache/downloads`).catch(() => {});
  };
  await ctx.step('export: open Backup & import', async () => {
    await page.locator('[data-settings-open="backup"]').click();
    await page.locator('#importexport-export-btn').waitFor({ state: 'visible', timeout: 10_000 });
    await page.fill('#importexport-export-passphrase', 'qa-export-passphrase');
  }).catch(() => {});
  // The same pipeline as the button, timed per phase, without a download.
  e.phases = await page.evaluate(async () => {
    const t = () => performance.now();
    const out = {};
    try {
      let s = t();
      const json = await window.CloudVault.exportAll({ includeSecrets: true });
      out.exportAllMs = Math.round(t() - s); out.jsonBytes = json.length;
      s = t();
      const gz = await window.BackupCrypto.gzipString(json);
      out.gzipMs = Math.round(t() - s); out.gzBytes = gz.length;
      s = t();
      const age = await window.BackupCrypto.encryptBackup(gz, 'qa-export-passphrase');
      out.encryptMs = Math.round(t() - s); out.ageBytes = age.length;
    } catch (err) {
      out.error = String(err && err.message || err);
    }
    return out;
  }).catch((err) => ({ error: String(err?.message || err).split('\n')[0] }));
  await ctx.step('export: Download backup → Save/Share', async () => {
    const t0 = Date.now();
    await page.click('#importexport-export-btn');
    await sleep(700);
    e.statusWhileRunning = await page.evaluate(() => document.getElementById('importexport-export-status')?.textContent || null).catch(() => null);
    await ctx.shot('export-progress');
    try {
      await ctx.waitFor({ text: 'Save to device' }, 180_000);
      e.clickToDialogMs = Date.now() - t0;
      await ctx.shot('export-save-share');
    } finally {
      e.statusAfter = await page.evaluate(() => document.getElementById('importexport-export-status')?.textContent || null).catch(() => null);
    }
    await dismiss();
    await sleep(1000);
    e.statusAfterDismiss = await page.evaluate(() => document.getElementById('importexport-export-status')?.textContent || null).catch(() => null);
    await ctx.shot('export-after');
  }).catch(async () => { await ctx.shot('export-stuck'); });
  // A vault at the owner's scale (Mi Band years: ~60 MB of JSON) through the real button, with
  // CloudVault.exportAll stubbed to return it: the status timeline shows progress and an end.
  await ctx.step('export: large vault shows progress and reaches Save/Share', async () => {
    await page.evaluate(() => {
      const rows = [];
      for (let i = 0; i < 300_000; i++) rows.push({ id: `hr-${i}`, measured_at: new Date(1.6e12 + i * 60_000).toISOString(), bpm: 50 + (i % 70), source: 'miband' });
      const json = JSON.stringify({ format: 'medtracker-vault', version: 1, data: { heart_rate: rows } }, null, 2);
      window.__qaExportAll = window.CloudVault.exportAll;
      window.CloudVault.exportAll = async () => json;
      window.__qaStatus = [];
      const t0 = performance.now();
      const note = document.getElementById('importexport-export-status');
      new MutationObserver(() => window.__qaStatus.push([Math.round(performance.now() - t0), note.textContent])).observe(note, { childList: true, characterData: true, subtree: true });
      return json.length;
    }).then((n) => { e.largeJsonBytes = n; });
    const t0 = Date.now();
    await page.click('#importexport-export-btn');
    await sleep(400);
    await ctx.shot('export-large-progress');
    try {
      await ctx.waitFor({ text: 'Save to device' }, 300_000);
      e.largeClickToDialogMs = Date.now() - t0;
      await ctx.shot('export-large-save-share');
    } finally {
      e.largeStatusTimeline = await page.evaluate(() => window.__qaStatus).catch(() => null);
      await page.evaluate(() => { window.CloudVault.exportAll = window.__qaExportAll; }).catch(() => {});
      await dismiss();
    }
  }).catch(async () => { await ctx.shot('export-large-stuck'); });
  await ctx.step('export: 25 MB blob reaches the shell', async () => {
    const t0 = Date.now();
    await page.evaluate(() => {
      const n = 25 * 1024 * 1024;
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536)));
      window.downloadBlobAsFile(new Blob([b], { type: 'application/octet-stream' }), 'qa-probe.bin');
    });
    try {
      await ctx.waitFor({ text: 'Save to device' }, 120_000);
      e.bigBlobMs = Date.now() - t0;
      await ctx.shot('export-big-blob');
    } finally {
      await dismiss();
    }
  }).catch(() => {});
  // Close the Backup page the way Back does (its WGPage history entry), so the Back-count steps
  // later start from a clean history.
  await page.evaluate(() => { if (history.state && history.state.modal) history.back(); }).catch(() => {});
  await sleep(1000);
  e.historyAfter = await page.evaluate(() => ({ len: history.length, state: history.state })).catch(() => null);
  await page.evaluate(() => window.switchTab('today')).catch(() => {});
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
