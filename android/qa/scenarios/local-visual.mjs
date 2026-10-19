// Android tier of visual QA (bd med-nt9p.32.6; the twin of ios/UITests/VisualQATests.swift, consumed
// by med-y5xx.9): one screenshot per scene of tests/visual/scenes.json. Web scenes launch local mode
// with `--es wgQAScene <name>` (debug-only, bd med-nt9p.32.4), the QA=1 bundle's driver seeds the
// golden vault, navigates and publishes #wg-qa-ready; the scene's native steps run on the device;
// then visual/<scene>.png (full device) + visual/<scene>.json (the ready node's report). Native-only
// scenes open first run. Dark / font scale / landscape are the dispatch inputs, applied to every scene.
// A failed scene still attaches its shot; the rest still run; the scenario fails at the end.
// Not in `all` (~20 cold starts).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const retry = false; // per-scene retry below; a whole-scenario retry would redo every scene

const here = dirname(fileURLToPath(import.meta.url));

export default async function localVisual(ctx) {
  const { shell, pkg, device, sleep } = ctx;
  const doc = JSON.parse(readFileSync(join(here, '../../../tests/visual/scenes.json'), 'utf8'));
  const scenes = doc.scenes;
  const dir = join(ctx.out, 'visual');
  mkdirSync(dir, { recursive: true });
  const r = (ctx.results.localVisual = {});
  await shell(`pm clear ${pkg}`); // the golden vault exactly, whatever ran before

  for (const scene of scenes) {
    const nativeOnly = scene.nativeOnly ?? scene.name.startsWith('native-');
    const s = (r[scene.name] = {});
    for (let attempt = 1; attempt <= 2; attempt++) {
      // A retry starts from the golden vault again: attempt 1 may have changed it (journey turns
      // gamification on, so its retry could never find the unchecked toggle).
      if (attempt > 1) await shell(`pm clear ${pkg}`);
      try {
        await runScene(scene, nativeOnly);
        s.error = undefined;
      } catch (e) {
        s.error = String(e?.message || e).split('\n')[0];
        ctx.log(`scene ${scene.name} attempt ${attempt}:`, s.error);
      }
      // The shot is taken either way: a failed scene shows what was on screen.
      const typing = (scene.native || []).some((n) => n.keyboard || n.type || n.tap);
      s.stableAfter = await ctx.stableShot(scene.name, { file: join(dir, `${scene.name}.png`), cap: typing ? 0 : 15 });
      if (!nativeOnly && ctx.page) {
        const json = await ctx.page.evaluate(() => document.getElementById('wg-qa-ready')?.getAttribute('aria-label')).catch(() => null);
        if (json) {
          writeFileSync(join(dir, `${scene.name}.json`), json);
          const rep = JSON.parse(json);
          s.ok = rep.ok; s.failed = rep.failed;
          // As iOS: only lost ready content fails the scene; the probes are findings for med-y5xx.9.
          if (!s.error && rep.failed?.includes('ready')) s.error = `ready content gone at the shot: ${rep.probes?.readyLost}`;
        }
      }
      if (!s.error) break;
      if (attempt === 1) s.firstError = s.error; // a flake that passed on retry still shows
    }
  }
  await ctx.step('every scene shot', async () => {
    const bad = Object.entries(r).filter(([, s]) => s.error).map(([n, s]) => `${n}: ${s.error}`);
    if (bad.length) throw new Error(bad.join(' | '));
  });

  async function runScene(scene, nativeOnly) {
    if (nativeOnly) {
      await ctx.launch(); // first run (Switch account leaves local mode; the local data stays)
      ctx.page = undefined;
    } else {
      const page = await ctx.launchLocal(scene.name);
      const rep = JSON.parse(await page.locator('#wg-qa-ready').getAttribute('aria-label'));
      if (rep.error) throw new Error(`driver: ${rep.error}`);
    }
    for (const step of scene.native || []) await nativeStep(step);
    await sleep(1000); // keyboard and sheet animations settle; the driver re-publishes
  }

  async function nativeStep(step) {
    const page = ctx.page;
    if (step.tap) {
      // The driver's `tag` keeps an element's own id and puts the alias in aria-label.
      const id = step.tap.replace(/^#/, '');
      const sel = `[id="${id}"], [aria-label="${id}"]`;
      await page.locator(sel).first().waitFor({ state: 'visible', timeout: 10_000 });
      await ctx.tapElement(page, sel);
    } else if (step.type !== undefined) {
      await shell(`input text '${step.type.replace(/ /g, '%s')}'`);
      await waitIme();
    } else if (step.clear) {
      await shell(`input keyevent KEYCODE_MOVE_END ${'KEYCODE_DEL '.repeat(32)}`);
    } else if (step.tapButton) {
      await ctx.waitFor({ text: step.tapButton }, 10_000);
      await device.tap({ text: step.tapButton });
    } else if (step.waitFor) {
      await ctx.waitFor({ text: step.waitFor }, 10_000);
    } else if (step.keyboard) {
      await waitIme();
    } else {
      throw new Error(`unknown native step ${JSON.stringify(step)}`);
    }
  }

  async function waitIme() {
    const end = Date.now() + 5_000;
    while (!(await ctx.imeShown())) {
      if (Date.now() > end) throw new Error('the software keyboard never appeared');
      await sleep(300);
    }
  }
}
