// Android QA harness driver (bd med-nt9p.23). Run by .github/workflows/android-qa.yml
// on an emulator; never locally. Usage: node run.mjs <scenario|all> <outDir>
// Env: QA_PKG, QA_FONT_SCALE, QA_DARK, QA_LANDSCAPE (the dispatch inputs).
import { _android as android } from 'playwright';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const SCENARIOS = ['firstrun', 'native-dark', 'native-fontscale', 'back-exit'];
const [want = 'all', out = 'out'] = process.argv.slice(2);
const pkg = process.env.QA_PKG || 'com.example.medtracker';
const inputs = {
  scenario: want,
  font_scale: process.env.QA_FONT_SCALE || '1.0',
  dark: process.env.QA_DARK === 'true',
  landscape: process.env.QA_LANDSCAPE === 'true',
};
const names = want === 'all' ? SCENARIOS : [want];
const shotsDir = join(out, 'screenshots');
mkdirSync(shotsDir, { recursive: true });

const steps = [];
const shots = [];
const log = (...a) => console.log('[qa]', ...a);

const [device] = await android.devices();
if (!device) throw new Error('no adb device');
log('device', device.model(), device.serial());

const shell = async (cmd) => (await device.shell(cmd)).toString().trim();

// The dispatch inputs; scenarios that need another value set and restore it themselves.
async function applyInputs() {
  await shell(`settings put system font_scale ${inputs.font_scale}`);
  await shell(`cmd uimode night ${inputs.dark ? 'yes' : 'no'}`);
  await shell('settings put system accelerometer_rotation 0');
  await shell(`settings put system user_rotation ${inputs.landscape ? 1 : 0}`);
}

const ctx = {
  device,
  page: undefined,
  shell,
  log,
  pkg,
  inputs,
  applyInputs,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  /** Full-screen device screenshot (system bars, keyboard) → screenshots/<scenario>-<name>.png. */
  async shot(name) {
    const file = `${ctx.scenario}-${name}.png`;
    await ctx.sleep(700); // let layout and IME animations settle
    await device.screenshot({ path: join(shotsDir, file) });
    shots.push(file);
    log('shot', file);
  },
  /** One reported step; a failure is recorded and rethrown, so the scenario stops there. */
  async step(name, fn) {
    const s = { scenario: ctx.scenario, name, ok: false };
    steps.push(s);
    try {
      const r = await fn();
      s.ok = true;
      return r;
    } catch (e) {
      s.error = String(e?.message || e).split('\n')[0];
      throw e;
    }
  },
  /** Cold start on the first-run screen: the Switch account action forgets any stored account. */
  async launch() {
    await shell(`am force-stop ${pkg}`);
    await shell(`am start -W -a com.example.medtracker.SWITCH_ACCOUNT -n ${pkg}/com.example.medtracker.MainActivity`);
    await ctx.waitFor({ text: 'Open' });
  },
  /**
   * Wait for a selector, dismissing system "<app> isn't responding" dialogs on the way: the
   * freshly booted software-GPU emulator ANRs its launcher, and UiAutomator then sees only the dialog.
   */
  async waitFor(selector, timeout = 30_000) {
    const end = Date.now() + timeout;
    for (;;) {
      try {
        return await device.wait(selector, { timeout: 3_000 });
      } catch (e) {
        if (Date.now() > end) throw e;
        if (await device.wait({ text: /isn't responding/ }, { timeout: 500 }).then(() => true, () => false)) {
          log('dismissing an ANR dialog');
          await device.tap({ text: 'Wait' }).catch(() => {});
        }
      }
    }
  },
  /** First run → type an account link → Open. No server answers *.qa.test yet, so this lands on the error screen. */
  async openAccount(url = 'https://alice.qa.test/', { shotTyped = false } = {}) {
    await device.fill({ clazz: 'android.widget.EditText' }, url);
    if (shotTyped) await ctx.shot('typed');
    await device.tap({ text: 'Open' });
    await ctx.waitFor({ text: /open your account/ });
  },
  /** True while our activity is the resumed (foreground) one. */
  async inForeground() {
    const a = await shell('dumpsys activity activities');
    return a.split('\n').some((l) => /ResumedActivity/.test(l) && l.includes(`${pkg}/`));
  },
  /** Attach Playwright to the shell's WebView (DOM, console, CDP); undefined if it cannot. */
  async attachPage() {
    try {
      const wv = await device.webView({ pkg }, { timeout: 15_000 });
      ctx.page = await wv.page();
      return ctx.page;
    } catch (e) {
      log('webview attach failed:', String(e?.message || e).split('\n')[0]);
      return undefined;
    }
  },
};

let failed = false;
try {
  await shell('settings put global hide_error_dialogs 1'); // see waitFor: no ANR dialogs over the app
  await applyInputs();
  for (const name of names) {
    ctx.scenario = name;
    log('scenario', name);
    try {
      const { default: run } = await import(`./scenarios/${name}.mjs`);
      await run(ctx);
    } catch (e) {
      failed = true;
      log(`scenario ${name} failed:`, e?.stack || e);
      await device.screenshot({ path: join(shotsDir, `${name}-FAILED.png`) }).then(() => shots.push(`${name}-FAILED.png`), () => {});
    }
    await applyInputs().catch(() => {});
  }
} finally {
  await device.close().catch(() => {});
}

writeFileSync(join(out, 'qa-summary.json'), JSON.stringify({ inputs, ok: !failed, steps, screenshots: shots }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = steps.map((s) => `| ${s.scenario} | ${s.name} | ${s.ok ? 'pass' : `FAIL: ${s.error}`} |`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `### Android QA: ${want} — ${failed ? 'FAILED' : 'passed'}`,
    '',
    `Inputs: font_scale=${inputs.font_scale} dark=${inputs.dark} landscape=${inputs.landscape}`,
    '',
    '| scenario | step | result |',
    '|---|---|---|',
    ...rows,
    '',
    `Screenshots (artifact \`android-qa-${want}\`): ${shots.map((s) => `\`${s}\``).join(', ')}`,
    '',
  ].join('\n'));
}
process.exit(failed ? 1 : 0);
