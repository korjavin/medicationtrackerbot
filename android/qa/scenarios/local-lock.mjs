// B3: real Keyguard PIN and authenticated Settings controls, never wgQALock.
// Disposable emulator only. Every credential mutation is enclosed by verified cleanup.
export const retry = false;

export default async function localLock(ctx) {
  const { shell, pkg, device, sleep } = ctx;
  const r = (ctx.results.localLock = {});
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
    await ctx.waitFor({ clazz: 'android.widget.EditText' }, 20_000);
    await shell(`input text ${pin}`);
    await shell('input keyevent KEYCODE_ENTER');
    await sleep(1500);
  };
  const settingsToggle = async () => {
    await page.locator('[data-nav-to="settings"]:visible').first().click();
    await page.locator('#settings-local-lock-toggle').waitFor({ state: 'attached' });
    await page.locator('#settings-local-lock .wg-toggle').click();
    await credential();
  };
  let pinSet = false;
  try {
    await ctx.step('set device PIN and verify real lock.status.available', async () => {
      const response = await shell('locksettings set-pin 1234');
      if (!/success/i.test(response)) throw new Error(`set-pin: ${response}`);
      pinSet = true;
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
      await ctx.waitFor({ clazz: 'android.widget.EditText' }, 20_000);
      await ctx.shot('system-unlock-prompt');
      await shell('input keyevent KEYCODE_BACK');
      await ctx.waitFor({ text: 'Unlock' }, 10_000);
      await sleep(4000);
      await ctx.waitFor({ text: 'Unlock' }, 2000);
      const web = await device.wait({ clazz: 'android.webkit.WebView' }, { timeout: 1000 }).then(() => true, () => false);
      const prompt = await device.wait({ clazz: 'android.widget.EditText' }, { timeout: 1000 }).then(() => true, () => false);
      if (web || prompt) throw new Error(`cancel revealed WebView or re-prompted: ${web}/${prompt}`);
      r.cancel = { n3: true, webViewAbsent: !web, noPromptLoopAfterMs: 4000 };
      await ctx.shot('cancelled-n3');
    });
    await ctx.step('explicit Unlock retries; wrong PIN conceals data; correct PIN preserves records', async () => {
      await device.tap({ text: 'Unlock' });
      await credential('9999');
      await ctx.waitFor({ clazz: 'android.widget.EditText' }, 5000);
      const web = await device.wait({ clazz: 'android.webkit.WebView' }, { timeout: 1000 }).then(() => true, () => false);
      if (web) throw new Error('wrong PIN revealed data');
      await ctx.shot('wrong-pin');
      r.wrongPin = { systemCredentialRetained: true, webViewAbsent: true };
      // Android clears a wrong PIN; select-all also handles images that retain it.
      await device.fill({ clazz: 'android.widget.EditText' }, '1234');
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
      if (pinSet) {
        await shell('input keyevent KEYCODE_BACK');
        await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity`);
        // On an earlier assertion failure the native lock may still hold.
        const prompt = await device.wait({ clazz: 'android.widget.EditText' }, { timeout: 2000 }).then(() => true, () => false);
        if (prompt) await credential();
        else if (await device.wait({ text: 'Unlock' }, { timeout: 1000 }).then(() => true, () => false)) {
          await device.tap({ text: 'Unlock' });
          await credential();
        }
        page = await ctx.attachPage();
        if (!page) throw new Error('cleanup cannot attach unlocked app');
        await ctx.waitLocalReady(page);
        if ((await status()).on) await settingsToggle();
        if ((await status()).on) throw new Error('cleanup retained app lock');
        const response = await shell('locksettings clear --old 1234');
        if (!/success/i.test(response)) throw new Error(`clear PIN: ${response}`);
      }
      r.cleanup = await status();
      r.cleanup.shellPreference = /name="wgLocalLock" value="true"/.test(await shell(`run-as ${pkg} cat shared_prefs/shell.xml`));
      if (r.cleanup.available || r.cleanup.on || r.cleanup.shellPreference) throw new Error('credential/app-lock cleanup failed');
      r.cleanup.foreground = await ctx.inForeground();
      if (!r.cleanup.foreground) throw new Error('cleanup did not restore app foreground');
      await ctx.shot('cleanup-no-credential');
    });
  }
}
