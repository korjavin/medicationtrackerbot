// Health Connect: a reading saved after the first import arrives on the next foreground (bd
// med-nt9p.59). Local mode, read access granted by pm grant (no permission sheet), and the debug
// writer QaHealthWrite as "another app" saving a blood pressure into Health Connect while the app
// is in the background: Home, then the writer opens over the app's task, writes and finishes, so
// the app comes back. Steps: write #1 → switch the import on → #1 arrives → force-stop and a
// plain relaunch → write #2 → back in the foreground → the shell logs a bp read → attach → #2 is
// in Vitals. The return runs in a process Playwright never attached to: its focus emulation keeps
// an attached page "visible" (a capturer on the WebContents), so the WebView would never hide.
// If #2 does not arrive, the toggle off/on rescan is tried too, for the evidence.
// Write #1 also seeds steps, a heart-rate series and an SpO2 reading (bd med-0xad.3): the bridge
// must answer them (steps as a daily aggregate), and once the page imports those kinds the Vitals
// Steps / Heart Rate / SpO2 cards must be populated (screenshot vitals-cards).
// results.health: every wait's outcome, the page's visibility events, the wg.health.*
// localStorage and the shell's "health …" diag lines.
export const READS = ['BLOOD_PRESSURE', 'WEIGHT', 'SLEEP', 'EXERCISE', 'HEART_RATE', 'TOTAL_CALORIES_BURNED', 'DISTANCE', 'STEPS', 'OXYGEN_SATURATION'];
const WRITES = ['BLOOD_PRESSURE', 'STEPS', 'HEART_RATE', 'OXYGEN_SATURATION'];

export default async function healthConnect(ctx) {
  const { shell, pkg, sleep } = ctx;
  // Fresh values per attempt: Health Connect keeps the first attempt's readings, and a retry's
  // switch-on scan would pick them up and pass for the wrong reason.
  const sys = 150 + Math.floor(Math.random() * 40);
  const FIRST = [sys, 90 + Math.floor(Math.random() * 10)];
  const SECOND = [sys + 1, FIRST[1] + 1];
  const VITALS = { steps: 1000 + Math.floor(Math.random() * 5000), hr: 60 + Math.floor(Math.random() * 30), spo2: 90 + Math.floor(Math.random() * 9) };
  const r = (ctx.results.health = { readings: [FIRST, SECOND], vitals: VITALS });

  await shell(`pm clear ${pkg}`);
  for (const p of READS) await shell(`pm grant ${pkg} android.permission.health.READ_${p}`);
  for (const p of WRITES) await shell(`pm grant ${pkg} android.permission.health.WRITE_${p}`);

  const healthDiag = async () => (await shell(`run-as ${pkg} cat shared_prefs/diag.xml`))
    .split(/&#10;|\n/).filter((l) => / health /.test(l));

  // "Another app" saves a reading while the app is in the background.
  const write = async ([sys, dia], vitals) => {
    await shell('input keyevent KEYCODE_HOME');
    await sleep(3000);
    const extra = vitals ? ` --ei steps ${vitals.steps} --ei hr ${vitals.hr} --ei spo2 ${vitals.spo2}` : '';
    await shell(`am start -W -n ${pkg}/com.example.medtracker.QaHealthWrite --ei sys ${sys} --ei dia ${dia}${extra}`);
    const end = Date.now() + 20_000;
    while (Date.now() < end) {
      const log = await shell('logcat -d -s qa-health-write:*');
      const line = log.split('\n').find((l) => l.includes(`${sys}.0/${dia}.0`) || /failed/.test(l));
      if (line) {
        if (/failed/.test(line)) throw new Error(`writer: ${line}`);
        break;
      }
      await sleep(1000);
    }
    await sleep(3000); // MainActivity resumes once the writer is gone
    if (!(await ctx.inForeground())) throw new Error('the app is not back in the foreground');
  };
  const has = ([sys, dia]) => ctx.page.evaluate(async ([s, d]) => {
    const res = await window.apiCall('/api/bp?days=2');
    const rows = Array.isArray(res) ? res : (res && (res.items || res.data || res.readings)) || [];
    return rows.some((b) => b.systolic === s && b.diastolic === d);
  }, [sys, dia]);
  const waitFor = async (reading, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await has(reading)) return true;
      await sleep(1000);
    }
    return false;
  };
  const toggle = () => ctx.page.evaluate(() => document.getElementById('health-import-toggle').click());
  const state = () => ctx.page.evaluate(() => ({
    enabled: localStorage.getItem('wg.health.enabled'),
    anchors: localStorage.getItem('wg.health.anchors'),
    last: localStorage.getItem('wg.health.last'),
    vis: window.__qaVis,
  }));

  try {
    await ctx.step('cold start in local mode', async () => {
      const p = await ctx.launchLocal('today');
      await p.evaluate(() => {
        window.__qaVis = [];
        document.addEventListener('visibilitychange', () => window.__qaVis.push(document.visibilityState));
      });
    });

    await ctx.step('a reading saved before the import: #1 (+ steps, HR, SpO2)', () => write(FIRST, VITALS));

    await ctx.step('switch the import on → #1 arrives', async () => {
      await ctx.page.locator('[data-nav-to="settings"]:visible').first().click();
      await ctx.page.locator('#health-import-toggle').waitFor({ state: 'attached', timeout: 15_000 });
      await toggle();
      r.first = await waitFor(FIRST);
      r.afterFirst = await state();
      if (!r.first) throw new Error(`#1 not imported: ${JSON.stringify(r.afterFirst)}`);
    });

    await ctx.step('the bridge answers steps (daily aggregate), hr and spo2', async () => {
      r.bridge = await ctx.page.evaluate(async () => {
        const now = Date.now();
        const q = (a) => window.Health.query(a).catch((e) => ({ error: String(e && e.message || e) }));
        return {
          steps: await q({ type: 'steps', from: now - 2 * 86400_000, to: now }),
          hr: await q({ type: 'hr', anchor: null, from: now - 90 * 86400_000 }),
          spo2: await q({ type: 'spo2', anchor: null, from: now - 90 * 86400_000 }),
        };
      });
      const { steps, hr, spo2 } = r.bridge;
      const total = (steps.samples || []).reduce((n, d) => n + d.steps, 0);
      const days = (steps.samples || []).every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day) && typeof d.tz === 'string' && d.tz);
      if (total < VITALS.steps || !days || steps.more !== false) throw new Error(`steps: ${JSON.stringify(steps)}`);
      if (!(hr.samples || []).some((s) => s.value === VITALS.hr) || !(hr.samples || []).some((s) => s.value === VITALS.hr + 1)) throw new Error(`hr: ${JSON.stringify(hr)}`);
      if (!(hr.samples || []).every((s) => /-\d+$/.test(s.uuid) && Number.isFinite(s.start))) throw new Error(`hr shape: ${JSON.stringify(hr.samples)}`);
      if (!(spo2.samples || []).some((s) => s.value === VITALS.spo2)) throw new Error(`spo2: ${JSON.stringify(spo2)}`);
    });

    await ctx.step('Vitals: Steps / Heart Rate / SpO2 cards populated', async () => {
      // The page imports these kinds from bd med-0xad.1 on; before that only the bridge is checked.
      const seen = () => ctx.page.evaluate(() => (JSON.parse(localStorage.getItem('wg.health.last') || '{}').seen) || {});
      const end = Date.now() + 30_000;
      while (Date.now() < end && !('spo2' in (await seen()))) await sleep(1000);
      r.seen = await seen();
      if (!('steps' in r.seen)) { r.cards = 'skipped: the page does not import steps yet'; return; }
      const overview = async () => ctx.page.evaluate(async () => {
        const o = await window.apiCall('/api/health/overview');
        return o && { steps: o.average_steps_7d, hr: (o.heart_rate_history_7d || []).length, spo2: (o.spo2_history_7d || []).length };
      });
      const full = (c) => c && c.steps > 0 && c.hr > 0 && c.spo2 > 0;
      for (const until = Date.now() + 30_000; !full(r.cards = await overview()) && Date.now() < until;) await sleep(1000);
      if (!full(r.cards)) throw new Error(`cards: ${JSON.stringify(r.cards)}`);
      await ctx.page.evaluate(() => window.switchTab('health'));
      await ctx.page.waitForFunction(() => !!document.getElementById('health-view')?.offsetParent, null, { timeout: 15_000 });
      await sleep(1500);
      await ctx.stableShot('vitals-cards');
    });

    await ctx.step('another app saves #2 while in the background → back in the foreground → #2 arrives', async () => {
      // A process Playwright never attached to: force-stop, start on the persisted local-mode pref
      // and let its boot import run, all through adb.
      ctx.page = undefined;
      await shell(`am force-stop ${pkg}`);
      await sleep(2000);
      await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity`);
      await sleep(20_000);
      const before = (await healthDiag()).length;
      await write(SECOND);
      await sleep(15_000);
      r.diagOnReturn = (await healthDiag()).slice(before);
      if (!(await ctx.attachPage())) throw new Error('re-attach failed');
      r.foreground = await waitFor(SECOND, 15_000);
      r.afterForeground = await state();
      if (r.foreground && !r.diagOnReturn.some((l) => / health bp /.test(l))) throw new Error('#2 is there but the return read nothing');
      if (r.foreground) return;
      // Evidence only: does the switch-on rescan see it?
      await toggle();
      await sleep(1500);
      await toggle();
      r.rescan = await waitFor(SECOND);
      r.afterRescan = await state();
      throw new Error(`#2 not imported on the return (rescan: ${r.rescan}; shell on return: ${JSON.stringify(r.diagOnReturn)})`);
    });
    await ctx.stableShot('settings-health-row');
  } finally {
    r.writer = (await shell('logcat -d -s qa-health-write:*')).split('\n').slice(-6);
    r.diag = (await healthDiag()).slice(-20);
    ctx.log('health', JSON.stringify(r, null, 2));
  }
}
