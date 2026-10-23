// Health Connect: a reading saved after the first import arrives on the next foreground (bd
// med-nt9p.59). Local mode, read access granted by pm grant (no permission sheet), and the debug
// writer QaHealthWrite as "another app" saving a blood pressure into Health Connect while the app
// is in the background (it opens over MainActivity, which stops and resumes when it finishes).
// Steps: write #1 → switch the import on → #1 arrives → write #2 → back in the foreground → #2
// arrives. If #2 does not, the toggle off/on rescan is tried too, for the evidence.
// results.health: every wait's outcome, the page's visibility events and its [health] console
// lines, the wg.health.* localStorage; the shell's "health …" diag lines are in diag.xml.
const READS = ['BLOOD_PRESSURE', 'WEIGHT', 'SLEEP', 'EXERCISE', 'HEART_RATE', 'TOTAL_CALORIES_BURNED', 'DISTANCE'];

export default async function healthConnect(ctx) {
  const { shell, pkg, sleep } = ctx;
  // Fresh values per attempt: Health Connect keeps the first attempt's readings, and a retry's
  // switch-on scan would pick them up and pass for the wrong reason.
  const sys = 150 + Math.floor(Math.random() * 40);
  const FIRST = [sys, 90 + Math.floor(Math.random() * 10)];
  const SECOND = [sys + 1, FIRST[1] + 1];
  const r = (ctx.results.health = { console: [], readings: [FIRST, SECOND] });

  await shell(`pm clear ${pkg}`);
  for (const p of READS) await shell(`pm grant ${pkg} android.permission.health.READ_${p}`);
  await shell(`pm grant ${pkg} android.permission.health.WRITE_BLOOD_PRESSURE`);

  const page = await ctx.step('cold start in local mode', async () => {
    const p = await ctx.launchLocal('today');
    p.on('console', (m) => { if (/health/i.test(m.text())) r.console.push(`${m.type()} ${m.text()}`.slice(0, 300)); });
    await p.evaluate(() => {
      window.__qaVis = [];
      document.addEventListener('visibilitychange', () => window.__qaVis.push(`${Date.now()} ${document.visibilityState}`));
    });
    return p;
  });

  // "Another app" saves a reading: the writer opens over the app, writes, finishes.
  const write = async ([sys, dia]) => {
    await shell(`am start -W -n ${pkg}/com.example.medtracker.QaHealthWrite --ei sys ${sys} --ei dia ${dia}`);
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
  const has = ([sys, dia]) => page.evaluate(async ([s, d]) => {
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
  const toggle = () => page.evaluate(() => document.getElementById('health-import-toggle').click());
  const state = () => page.evaluate(() => ({
    enabled: localStorage.getItem('wg.health.enabled'),
    anchors: localStorage.getItem('wg.health.anchors'),
    last: localStorage.getItem('wg.health.last'),
    vis: window.__qaVis,
    row: document.querySelector('#health-import-row .wg-setting__desc')?.textContent,
  }));

  try {
    await ctx.step('a reading saved before the import: #1', () => write(FIRST));

    await ctx.step('switch the import on → #1 arrives', async () => {
      await page.locator('[data-nav-to="settings"]:visible').first().click();
      await page.locator('#health-import-toggle').waitFor({ state: 'attached', timeout: 15_000 });
      await toggle();
      r.first = await waitFor(FIRST);
      r.afterFirst = await state();
      if (!r.first) throw new Error(`#1 not imported: ${JSON.stringify(r.afterFirst)}`);
    });

    await ctx.step('another app saves #2 while in the background → back in the foreground → #2 arrives', async () => {
      await write(SECOND);
      r.foreground = await waitFor(SECOND);
      r.afterForeground = await state();
      // The shell pauses the WebView on stop (MainActivity.onStart/onStop): the page saw it.
      if (r.foreground && !r.afterForeground.vis.some((v) => v.endsWith('visible'))) throw new Error('no visibilitychange to visible');
      if (r.foreground) return;
      // Evidence only: does the switch-on rescan see it?
      await toggle();
      await sleep(1500);
      await toggle();
      r.rescan = await waitFor(SECOND);
      r.afterRescan = await state();
      throw new Error(`#2 not imported on the foreground (rescan: ${r.rescan}): ${JSON.stringify(r.afterForeground)}`);
    });
    await ctx.stableShot('settings-health-row');
  } finally {
    r.writer = (await shell('logcat -d -s qa-health-write:*')).split('\n').slice(-6);
    r.diag = (await shell(`run-as ${pkg} cat shared_prefs/diag.xml`)).split('\n').filter((l) => / health /.test(l)).slice(-20);
    ctx.log('health', JSON.stringify(r, null, 2));
  }
}
