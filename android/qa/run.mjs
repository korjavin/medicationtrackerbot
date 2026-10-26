// Android QA harness driver (bd med-nt9p.23). Run by .github/workflows/android-qa.yml
// on an emulator; never locally. Usage: node run.mjs <scenario|all> <outDir>
// Env: QA_PKG, QA_FONT_SCALE, QA_DARK, QA_LANDSCAPE (the dispatch inputs), QA_CLAIM_URL (the
// runner-minted invite on the local cloud, bd med-nt9p.24).
import { _android as android } from 'playwright';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

// smoke last: it claims the run's one invite (bd med-nt9p.25). local-smoke (bd med-nt9p.32.6) is the
// passkey-free full-app run; local-visual (one shot per scene) and the other local-* run on their own
// (local-to-cloud, local-to-cloud-seamless and move-ops claim the invite too: dispatch them alone).
// reminders-offline (bd med-nt9p.55) follows smoke and reopens its account (alone, it claims the invite).
// It must stay LAST: its final step reboots the emulator, which ends the UiAutomator driver (bd med-nt9p.57).
const SCENARIOS = ['firstrun', 'native-dark', 'native-lock','native-fontscale', 'back-exit', 'back-stack', 'claim-page', 'not-found', 'external-link', 'authn-probe', 'invite-link', 'local-smoke', 'smoke', 'reminders-offline'];
const LOCAL_ORIGIN = 'https://appassets.androidplatform.net';
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
  out,
  LOCAL_ORIGIN,
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
  /**
   * Device screenshot once two frames a second apart match (cap `cap` s): the software-GPU
   * emulator paints seconds behind the DOM. Not for a focused field (the caret blinks: hits the cap).
   * Writes `file` (default screenshots/<scenario>-<name>.png); returns the seconds it waited.
   */
  async stableShot(name, { file, cap = 15 } = {}) {
    const path = file || join(shotsDir, `${ctx.scenario}-${name}.png`);
    await ctx.sleep(700);
    let last = await device.screenshot();
    let n = 0;
    for (; n < cap; n++) {
      await ctx.sleep(1000);
      const next = await device.screenshot();
      if (next.equals(last)) break;
      last = next;
    }
    writeFileSync(path, last);
    shots.push(path.slice(path.lastIndexOf('/') + 1));
    log('shot', path, `stable after ${n}s`);
    return n;
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
   * True when `e` is the shell's page going away under us ("has been closed", no WebView); then logs
   * it and records { scenario, where, error, pid, action } in results.recoveries ('none': the process is gone).
   */
  async pageLost(e, where, action) {
    const error = String(e?.message || e).split('\n')[0];
    if (!/has been closed|no WebView page/.test(error)) return false;
    const pid = (await shell(`pidof ${pkg}`).catch(() => '')) || 'none';
    (results.recoveries ||= []).push({ scenario: ctx.scenario, where, error, pid, action });
    log(`${where}: page lost (${error}), app pid ${pid}; ${action}`);
    return true;
  },
  /**
   * Cold start through the launcher's Switch account (bd med-ta2n.12: there is no native first run):
   * any stored account forgotten, local mode on home?invite=1, so the web's F1 "Have an invite?"
   * sheet is open (over W1 on an empty device). Returns the page.
   * softAuthn: the debug-only QA soft authenticator (bd med-nt9p.25, src/debug/DebugHooks.kt).
   */
  async launch({ softAuthn = false } = {}) {
    const start = () => ctx.coldStart(`-a com.example.medtracker.SWITCH_ACCOUNT -n ${pkg}/com.example.medtracker.MainActivity${softAuthn ? ' --ez qaSoftAuthn true' : ''}`);
    await start();
    return ctx.localPage((page) => page.locator('[data-invite-action="paste"]').waitFor({ state: 'visible', timeout: 90_000 }), start);
  },
  /** am force-stop, then am start -W `args`. */
  async coldStart(args) {
    await shell(`am force-stop ${pkg}`);
    await ctx.sleep(2000); // the dead process's devtools socket must go before attaching
    await shell(`am start -W ${args}`);
  },
  /**
   * The shell's page on the local origin once `ready(page)` resolves. One recovery when the first
   * target closes under us or no WebView shows: `restart` (a cold start) when given, else a re-attach.
   */
  async localPage(ready, restart) {
    // ponytail: one recovery (run 39249851915, right after pm clear: "Target page, context or browser has been closed").
    // bd med-nt9p.62: on a just-settled emulator the first cold start's target closed ~10 s in and no
    // WebView came back within 15 s (runs 40235627692, 40237163180): a re-attach waits on nothing, relaunch.
    for (let attempt = 1; ; attempt++) {
      try {
        const page = await ctx.attachPage();
        if (!page) throw new Error('no WebView page (see the run log)');
        await page.waitForURL((u) => u.href.startsWith(`${LOCAL_ORIGIN}/`), { timeout: 30_000 });
        await ready(page);
        return page;
      } catch (e) {
        if (attempt > 1 || !(await ctx.pageLost(e, 'localPage', restart ? 'relaunch' : 're-attach'))) throw e;
        if (restart) await restart();
        else await ctx.sleep(2000);
      }
    }
  },
  /**
   * Cold start in local mode (bd med-nt9p.32.6) with the debug-only extras of bd med-nt9p.32.4:
   * `--ez wgLocalMode true` (extra: false relaunches on the persisted pref alone) and, with a
   * scene, `--es wgQAScene <scene>` (the QA driver seeds the golden vault, navigates and publishes
   * #wg-qa-ready). Returns the page once the ready node is attached (scene) or the bottom nav shows.
   * softAuthn: also the QA soft authenticator (launch), for a scenario that later claims an invite.
   */
  async launchLocal(scene, { extra = true, softAuthn = false } = {}) {
    const extras = `${extra ? ' --ez wgLocalMode true' : ''}${scene ? ` --es wgQAScene ${scene}` : ''}${softAuthn ? ' --ez qaSoftAuthn true' : ''}`;
    const start = () => ctx.coldStart(`-n ${pkg}/com.example.medtracker.MainActivity${extras}`);
    await start();
    return ctx.localPage((page) => ctx.waitLocalReady(page, scene), start);
  },
  /** The local app is up: #wg-qa-ready attached (scene; the first one seeds + reloads) or the bottom nav visible. */
  async waitLocalReady(page, scene) {
    if (scene) await page.locator('#wg-qa-ready').waitFor({ state: 'attached', timeout: 90_000 });
    else await page.locator('.wg-tabbar').first().waitFor({ state: 'visible', timeout: 60_000 });
  },
  /** A real touch on a DOM element (so the IME opens like a finger's tap): CSS rect → the WebView's screen bounds. */
  async tapElement(page, selector) {
    const rect = await page.evaluate((s) => {
      const b = document.querySelector(s).getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: innerWidth };
    }, selector);
    const { bounds } = await device.info({ clazz: 'android.webkit.WebView' });
    const k = bounds.width / rect.w;
    await device.input.tap({ x: Math.round(bounds.x + rect.x * k), y: Math.round(bounds.y + rect.y * k) });
  },
  async imeShown() {
    return /mInputShown=true|mIsInputViewShown=true|isInputViewShown=true/.test(await shell('dumpsys input_method'));
  },
  /**
   * Wait for a selector, dismissing system "<app> isn't responding" dialogs on the way: the
   * freshly booted software-GPU emulator ANRs its launcher, and UiAutomator then sees only the dialog.
   */
  async waitFor(selector, timeout = 60_000) {
    const end = Date.now() + timeout;
    for (;;) {
      try {
        return await device.wait(selector, { timeout: 10_000 });
      } catch (e) {
        if (Date.now() > end) throw e;
        if (await device.wait({ text: /.*isn['’]t responding.*/ } /* API 34 titles it with ’ (U+2019) */, { timeout: 500 }).then(() => true, () => false)) {
          log('dismissing an ANR dialog');
          await device.tap({ text: 'Wait' }).catch(() => {});
        }
      }
    }
  },
  /**
   * The web's way onto an account (bd med-ta2n.12), on the F1 sheet launch() leaves open: Paste
   * (the emulator's clipboard holds no invite, so the field shows) → type the link → Continue →
   * "Your invite is here" (no records) or "Turn on sync?" (records) → its button, which runs
   * CloudVault.moveToCloud = move.stash + local.leave {url}. move: false (the default) answers
   * move.stash in the page without writing a stash, so the account scenarios test the claim, not
   * the pickup (move-ops and local-to-cloud-seamless own that). The page goes away after the tap.
   */
  async openLink(url, { shotTyped = false, move = false } = {}) {
    const page = ctx.page;
    if (!page) throw new Error('openLink: no page (launch() first)');
    const field = page.locator('[data-invite-field]');
    if (!(await field.isVisible())) {
      await page.locator('[data-invite-action="paste"]').click();
      await field.waitFor({ state: 'visible', timeout: 10_000 });
    }
    // Paste reads the clipboard asynchronously (Copy diagnostics may have left the log there) and can
    // land after fill(): fill until the url stays.
    for (let i = 0; ; i++) {
      await field.fill(url);
      await ctx.sleep(500);
      if ((await field.inputValue()) === url) break;
      if (i === 4) throw new Error(`openLink: the field keeps ${JSON.stringify((await field.inputValue()).slice(0, 80))}`);
    }
    if (shotTyped) await ctx.shot('typed');
    if (!move) {
      await page.evaluate(() => {
        const n = window.LocalNotifications.__native;
        const call = n.call.bind(n);
        n.call = (op, args) => (op === 'move.stash' ? Promise.resolve(true) : call(op, args));
      });
    }
    await page.locator('[data-invite-action="submit"]').click();
    const go = page.locator('[data-invite-action="sign-in"], [data-invite-action="turn-on-sync"]').first();
    await go.waitFor({ state: 'visible', timeout: 30_000 });
    await go.click().catch((e) => log('openLink: the page went during the tap:', String(e?.message).split('\n')[0]));
  },
  /** Open an account whose server answers 503 (tlsfront's down.qa.test) → the load-error screen (N4; every variant has Copy diagnostics). */
  async openAccount(url = 'https://down.qa.test/', opts = {}) {
    await ctx.openLink(url, opts);
    await ctx.waitFor({ text: 'Copy diagnostics' });
  },
  /**
   * Cold start → F1 → the run's invite → the WebView page on /unlock with the signup wizard.
   * kit: append &kit=1 (sync turned on from Settings), so the ceremony ends on the kit offer.
   */
  async openClaim(opts = {}) {
    if (!ctx.claimUrl) throw new Error('QA_CLAIM_URL unset (no local cloud)');
    // bd med-nt9p.64: run 40242381050 lost the app (home screen) right after launch()'s page was
    // ready, so openLink's first locator threw "has been closed". One relaunch, as localPage does;
    // the invite is only claimed later, on /unlock, so a second F1 pass is safe. One recovery in all:
    // none here once launch()'s localPage has already relaunched.
    const before = (results.recoveries || []).length;
    for (let attempt = 1; ; attempt++) {
      try {
        await ctx.launch(opts);
        await ctx.openLink(opts.kit ? `${ctx.claimUrl}&kit=1` : ctx.claimUrl);
        break;
      } catch (e) {
        if (attempt > 1 || (results.recoveries || []).length > before || !(await ctx.pageLost(e, 'openClaim', 'relaunch'))) throw e;
      }
    }
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
  /**
   * Attach Playwright to the shell's WebView (DOM, console, CDP); undefined if it cannot.
   * Each try lands in results.attach (bd med-nt9p.62): ms to the webview target and to the page;
   * on a failure the error and the app's pid then ('none': the process is gone).
   */
  async attachPage() {
    const t0 = Date.now();
    const rec = { scenario: ctx.scenario };
    (results.attach ||= []).push(rec);
    try {
      const wv = await device.webView({ pkg }, { timeout: 15_000 });
      rec.webViewMs = Date.now() - t0;
      // Bounded: a page attach to a process Play services is killing never settled (run 39534712229 hung 40 min).
      ctx.page = await Promise.race([wv.page(), ctx.sleep(30_000).then(() => { throw new Error('page attach timed out'); })]);
      rec.pageMs = Date.now() - t0;
      return ctx.page;
    } catch (e) {
      rec.error = String(e?.message || e).split('\n')[0];
      rec.failedMs = Date.now() - t0;
      rec.pid = (await shell(`pidof ${pkg}`).catch(() => '')) || 'none';
      log('webview attach failed:', rec.error, 'app pid', rec.pid);
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
    // A scenario that consumes the run's one invite exports retry = false (a retry would hit "already claimed").
    const { default: run, retry = true } = await import(`./scenarios/${name}.mjs`);
    const attempts = retry ? 2 : 1;
    // ponytail: one retry absorbs emulator flakiness (Play services dying under the app); the
    // failed attempt stays in the summary as "retried", so a real bug still shows twice.
    for (let attempt = 1; attempt <= attempts; attempt++) {
      log('scenario', name, 'attempt', attempt);
      const from = steps.length;
      try {
        await run(ctx);
        break;
      } catch (e) {
        log(`scenario ${name} failed:`, e?.stack || e);
        const file = `${name}-FAILED${attempt}.png`;
        await device.screenshot({ path: join(shotsDir, file) }).then(() => shots.push(file), () => {});
        if (attempt === attempts) failed = true;
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
