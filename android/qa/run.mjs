// Android QA harness driver (bd med-nt9p.23). Run by .github/workflows/android-qa.yml
// on an emulator; never locally. Usage: node run.mjs <scenario|all> <outDir>
// Env: QA_PKG, QA_FONT_SCALE, QA_DARK, QA_LANDSCAPE (the dispatch inputs), QA_CLAIM_URL (the
// runner-minted invite on the local cloud, bd med-nt9p.24).
import { _android as android } from 'playwright';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

// smoke last: it claims the run's one invite (bd med-nt9p.25).
const SCENARIOS = ['firstrun', 'native-dark', 'native-fontscale', 'back-exit', 'claim-page', 'not-found', 'external-link', 'authn-probe', 'smoke'];
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
const results = {}; // scenario verdicts that are findings, not failures (authn-probe)
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
  claimUrl: process.env.QA_CLAIM_URL,
  results,
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
  /**
   * Cold start on the first-run screen: the Switch account action forgets any stored account.
   * softAuthn: the debug-only QA soft authenticator (bd med-nt9p.25, src/debug/DebugHooks.kt).
   */
  async launch({ softAuthn = false } = {}) {
    await shell(`am force-stop ${pkg}`);
    await shell(`am start -W -a com.example.medtracker.SWITCH_ACCOUNT -n ${pkg}/com.example.medtracker.MainActivity${softAuthn ? ' --ez qaSoftAuthn true' : ''}`);
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
        if (await device.wait({ text: /.*isn't responding.*/ }, { timeout: 500 }).then(() => true, () => false)) {
          log('dismissing an ANR dialog');
          await device.tap({ text: 'Wait' }).catch(() => {});
        }
      }
    }
  },
  /** First run → type a link → Open. */
  async openLink(url, { shotTyped = false } = {}) {
    await device.fill({ clazz: 'android.widget.EditText' }, url);
    if (shotTyped) await ctx.shot('typed');
    await device.tap({ text: 'Open' });
  },
  /** Open an account the local cloud does not have (a 404) → the "Can't open your account" screen. */
  async openAccount(url = 'https://alice.qa.test/', opts = {}) {
    await ctx.openLink(url, opts);
    await ctx.waitFor({ text: /.*open your account.*/ });
  },
  /** Cold start → Open the run's invite → the WebView page on /unlock with the signup wizard. */
  async openClaim(opts) {
    if (!ctx.claimUrl) throw new Error('QA_CLAIM_URL unset (no local cloud)');
    await ctx.launch(opts);
    await ctx.openLink(ctx.claimUrl);
    const page = await ctx.attachPage();
    if (!page) throw new Error('no WebView page (see the run log)');
    await page.waitForURL(/\/unlock/, { timeout: 30_000 });
    await page.locator('#create-passkey').waitFor({ timeout: 30_000 });
    // The software-GPU emulator paints seconds behind the DOM; without this the device shot still
    // shows "Checking your invite…" or a blank page.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await ctx.sleep(3000);
    return page;
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
  // A freshly booted emulator keeps restarting Play services for a while, which can kill the app.
  log('settling'); await ctx.sleep(45_000);
  for (const name of names) {
    ctx.scenario = name;
    const { default: run } = await import(`./scenarios/${name}.mjs`);
    // ponytail: one retry absorbs emulator flakiness (Play services dying under the app); the
    // failed attempt stays in the summary as "retried", so a real bug still shows twice.
    for (let attempt = 1; attempt <= 2; attempt++) {
      log('scenario', name, 'attempt', attempt);
      const from = steps.length;
      try {
        await run(ctx);
        break;
      } catch (e) {
        log(`scenario ${name} failed:`, e?.stack || e);
        const file = `${name}-FAILED${attempt}.png`;
        await device.screenshot({ path: join(shotsDir, file) }).then(() => shots.push(file), () => {});
        if (attempt === 2) failed = true;
        else for (const s of steps.slice(from)) s.retried = true;
      } finally {
        await applyInputs().catch(() => {});
      }
    }
  }
} finally {
  await device.close().catch(() => {});
}

writeFileSync(join(out, 'qa-summary.json'), JSON.stringify({ inputs, ok: !failed, results, steps, screenshots: shots }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = steps.map((s) => `| ${s.scenario} | ${s.name} | ${s.ok ? "pass" : `FAIL${s.retried ? " (retried)" : ""}: ${s.error}`} |`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `### Android QA: ${want} — ${failed ? 'FAILED' : 'passed'}`,
    '',
    `Inputs: font_scale=${inputs.font_scale} dark=${inputs.dark} landscape=${inputs.landscape}`,
    '',
    '| scenario | step | result |',
    '|---|---|---|',
    ...rows,
    '',
    ...Object.entries(results).map(([k, v]) => `**${k}**: ${typeof v === 'string' ? v : JSON.stringify(v)}\n`),
    `Screenshots (artifact \`android-qa-${want}\`): ${shots.map((s) => `\`${s}\``).join(', ')}`,
    '',
  ].join('\n'));
}
process.exit(failed ? 1 : 0);
