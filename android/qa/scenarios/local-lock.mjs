// B3: real Keyguard PIN and authenticated Settings controls, never wgQALock.
// Disposable emulator only. Every credential mutation is enclosed by verified cleanup.
export const retry = false;
const CREDENTIAL_FIELD = { clazz: 'android.widget.EditText', pkg: /^com\.android\.(systemui|settings)$/ };

export default async function localLock(ctx) {
  const { shell, pkg, device, sleep } = ctx;
  const r = (ctx.results.localLock = {});
  const radios = async () => ({ airplane: await shell('settings get global airplane_mode_on'),
    wifi: await shell('settings get global wifi_on'), data: await shell('settings get global mobile_data') });
  r.radiosBefore = await radios();
  await shell(`pm clear ${pkg}`);
  let page = await ctx.launchLocal('today');
  await page.goto(`${ctx.LOCAL_ORIGIN}/`, { waitUntil: 'load' });
  await ctx.waitLocalReady(page);
  const status = () => page.evaluate(() => window.LocalNotifications.__native.call('lock.status'));
  r.initial = await status();
  if (r.initial.available || r.initial.on) throw new Error('requires disposable emulator with no secure credential/app lock');
  const before = await page.evaluate(() => window.apiCall('/api/medications'));
  const credential = async (pin = '1234') => {
    // BiometricPrompt falls back to Android's real credential activity on this image.
    await ctx.waitFor(CREDENTIAL_FIELD, 20_000);
    const field = await device.info(CREDENTIAL_FIELD);
    (r.credentialPrompts ||= []).push({ pkg: field.pkg, res: field.res, clazz: field.clazz });
    if (!field.pkg || field.pkg === pkg) throw new Error('credential entry is not in the Android system UI');
    await device.fill(CREDENTIAL_FIELD, '');
    await shell(`input text ${pin}`);
    await shell('input keyevent KEYCODE_ENTER');
    await sleep(1500);
  };
  const settingsToggle = async () => {
    if (!(await page.locator('#settings-local-lock').isVisible())) {
      await page.locator('[data-nav-to="settings"]:visible').first().click();
    }
    await page.locator('#settings-local-lock-toggle').waitFor({ state: 'attached' });
    await page.locator('#settings-local-lock .wg-toggle').click();
    await credential();
  };
  let pinSet = false;
  try {
    await ctx.step('set device PIN and verify real lock.status.available', async () => {
      pinSet = true;
      r.setPinResult = await shell('locksettings set-pin 1234');
      for (let i = 0; i < 20 && !(await status()).available; i++) await sleep(500);
      if (!(await status()).available) throw new Error('device credential did not become available');
      await page.reload({ waitUntil: 'load' });
      await ctx.waitLocalReady(page);
    });
    await ctx.step('Settings app lock on through real system credential check', async () => {
      await settingsToggle();
      r.enabled = await status();
      if (!r.enabled.on) throw new Error('authenticated Settings did not enable lock');
      await ctx.shot('enabled-settings');
    });
    await ctx.step('Home → return conceals WebView; cancel stays N3 locked without prompt loop', async () => {
      await shell('input keyevent KEYCODE_HOME');
      await sleep(3000);
      await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity`);
      await ctx.waitFor(CREDENTIAL_FIELD, 20_000);
      await ctx.shot('system-unlock-prompt');
      // On Android the first Back can dismiss the PIN keyboard. A second is the
      // actual credential cancellation; stop as soon as the native N3 button returns.
      await shell('input keyevent KEYCODE_BACK');
      const cancelled = await device.wait({ text: 'Unlock' }, { timeout: 2000 }).then(() => true, () => false);
      if (!cancelled) await shell('input keyevent KEYCODE_BACK');
      await ctx.waitFor({ text: 'Unlock' }, 10_000);
      await sleep(4000);
      await ctx.waitFor({ text: 'Unlock' }, 2000);
      const web = await device.wait({ clazz: 'android.webkit.WebView' }, { timeout: 1000 }).then(() => true, () => false);
      const prompt = await device.wait(CREDENTIAL_FIELD, { timeout: 1000 }).then(() => true, () => false);
      if (web || prompt) throw new Error(`cancel revealed WebView or re-prompted: ${web}/${prompt}`);
      r.cancel = { n3: true, webViewAbsent: !web, noPromptLoopAfterMs: 4000 };
      await ctx.shot('cancelled-n3');
    });
    await ctx.step('explicit Unlock retries; wrong PIN conceals data; correct PIN preserves records', async () => {
      await device.tap({ text: 'Unlock' });
      await credential('9999');
      await ctx.waitFor(CREDENTIAL_FIELD, 5000);
      const web = await device.wait({ clazz: 'android.webkit.WebView' }, { timeout: 1000 }).then(() => true, () => false);
      if (web) throw new Error('wrong PIN revealed data');
      await ctx.shot('wrong-pin');
      r.wrongPin = { systemCredentialRetained: true, webViewAbsent: true };
      // Android clears a wrong PIN; select-all also handles images that retain it.
      await device.fill(CREDENTIAL_FIELD, '1234');
      await shell('input keyevent KEYCODE_ENTER');
      await ctx.waitFor({ clazz: 'android.webkit.WebView' }, 20_000);
      page = await ctx.attachPage();
      if (!page) throw new Error('no WebView after correct PIN');
      await ctx.waitLocalReady(page);
      const after = await page.evaluate(() => window.apiCall('/api/medications'));
      if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('unlock changed medication records');
      r.recordsIntact = true;
      await ctx.shot('unlocked-data');
    });
  } finally {
    await ctx.step('finally: authenticated app-lock off, clear PIN, verify no secure credential or retained lock', async () => {
      const errors = (r.cleanupErrors = []);
      // Each action/check runs even after an earlier cleanup failure. Fail once all
      // recovery and verification attempts have completed; never turn recovery green.
      const attempt = async (name, fn) => {
        try { await fn(); }
        catch (error) { errors.push(`${name}: ${String(error.message).split('\n')[0]}`); }
      };
      if (pinSet) {
        await attempt('authenticated lock off', async () => {
          try {
            await shell('input keyevent KEYCODE_BACK');
            await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity`);
            // On an earlier assertion failure the native lock may still hold.
            const prompt = await device.wait(CREDENTIAL_FIELD, { timeout: 2000 }).then(() => true, () => false);
            if (prompt) await credential();
            else if (await device.wait({ text: 'Unlock' }, { timeout: 1000 }).then(() => true, () => false)) {
              await device.tap({ text: 'Unlock' });
              await credential();
            }
            page = await ctx.attachPage();
            if (!page) throw new Error('cleanup cannot attach unlocked app');
            await ctx.waitLocalReady(page);
            const wasOn = (await status()).on;
            if (wasOn) await settingsToggle();
            if ((await status()).on) throw new Error('cleanup retained app lock');
            r.cleanupAuthenticatedDisable = wasOn;
          } catch (error) {
            r.cleanupAuthenticatedControlError = String(error.message).split('\n')[0];
            throw error;
          }
        });
        await attempt('clear PIN', async () => {
          const response = await shell('locksettings clear --old 1234');
          if (!/success|credential cleared/i.test(response)) throw new Error(`clear PIN: ${response}`);
        });
        if (r.cleanupAuthenticatedControlError) {
          await attempt('recovery through Settings after clear', async () => {
            page = await ctx.launchLocal(undefined);
            if ((await status()).on) {
              if (!(await page.locator('#settings-local-lock').isVisible())) {
                await page.locator('[data-nav-to="settings"]:visible').first().click();
              }
              await page.locator('#settings-local-lock .wg-toggle').click();
            }
          });
          // Last resort if navigation failed: the same real lock.set control, after
          // OS credential removal. This cannot count as authenticated UI coverage:
          // the original error is retained and the whole scenario still fails.
          await attempt('last-resort real lock control', async () => {
            const current = await status();
            if (!current.available && current.on) {
              await page.evaluate(() => window.LocalNotifications.__native.call('lock.set', { on: false }));
              r.cleanupUsedNativeRecovery = true;
            }
          });
        }
      }
      r.cleanup = {};
      await attempt('native secure/lock verification', async () => {
        Object.assign(r.cleanup, await status());
        if (r.cleanup.available !== false || r.cleanup.on !== false) throw new Error('credential/app lock remains enabled');
      });
      await attempt('persisted lock preference verification', async () => {
        r.cleanup.shellPreference = /name="wgLocalLock" value="true"/.test(await shell(`run-as ${pkg} cat shared_prefs/shell.xml`));
        if (r.cleanup.shellPreference) throw new Error('enabled shell lock preference remains');
      });
      await attempt('foreground verification', async () => {
        r.cleanup.foreground = await ctx.inForeground();
        if (!r.cleanup.foreground) throw new Error('app not foreground');
      });
      await attempt('radio verification', async () => {
        r.cleanup.radios = await radios();
        if (JSON.stringify(r.cleanup.radios) !== JSON.stringify(r.radiosBefore)) throw new Error('radio state changed');
      });
      await attempt('cleanup screenshot', () => ctx.shot('cleanup-no-credential'));
      if (errors.length) throw new Error(`cleanup failed: ${errors.join('; ')}`);
    });
  }
}
