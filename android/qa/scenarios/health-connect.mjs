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
export const READS = ['BLOOD_PRESSURE', 'WEIGHT', 'SLEEP', 'EXERCISE', 'HEART_RATE', 'TOTAL_CALORIES_BURNED', 'DISTANCE', 'STEPS', 'OXYGEN_SATURATION', 'HEALTH_DATA_HISTORY'];
const WRITES = ['BLOOD_PRESSURE', 'WEIGHT', 'STEPS', 'HEART_RATE', 'OXYGEN_SATURATION', 'EXERCISE'];

export default async function healthConnect(ctx) {
  const { shell, pkg, sleep } = ctx;
  // Fresh values per attempt: Health Connect keeps the first attempt's readings, and a retry's
  // switch-on scan would pick them up and pass for the wrong reason.
  const sys = 150 + Math.floor(Math.random() * 40);
  const FIRST = [sys, 90 + Math.floor(Math.random() * 10)];
  const SECOND = [sys + 1, FIRST[1] + 1];
  // Outside the local QA fixture's ranges, so the cards can only move from this import.
  const VITALS = { steps: 20_000 + Math.floor(Math.random() * 5000), hr: 150 + Math.floor(Math.random() * 20), spo2: 80 + Math.floor(Math.random() * 5) };
  const SPO2N = 120; // more than HealthConnect.DENSE_PAGE records: the scan pages
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
      const extra = vitals ? ` --ei steps ${vitals.steps} --ei hr ${vitals.hr} --ei spo2 ${vitals.spo2} --ei spo2n ${SPO2N} --ez workout true` : '';
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
  // What the Vitals cards read: today's steps, the 7-day HR / SpO2 history and averages.
  const overview = () => ctx.page.evaluate(async () => {
    const o = await window.apiCall('/api/health/overview');
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
    return o && {
      steps: ((o.step_stats_7d || []).find((d) => d.day === today) || {}).steps || 0,
      hr: JSON.stringify([o.average_heart_rate_7d, o.heart_rate_history_7d]),
      spo2: JSON.stringify([o.average_spo2_7d, o.spo2_history_7d]),
    };
  });
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
      r.cardsBefore = await overview();
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

    await ctx.step('a dense scan pages by limit: hc1s: anchors with more, then the hc1: changes token', async () => {
      r.paged = await ctx.page.evaluate(async () => {
        const out = { pages: [], uuids: 0 };
        const seen = new Set();
        let res = await window.Health.query({ type: 'spo2', anchor: null, from: Date.now() - 90 * 86400_000, limit: 50 });
        for (let i = 0; i < 20; i++) {
          (res.samples || []).forEach((s) => seen.add(s.uuid));
          out.pages.push({ n: (res.samples || []).length, more: res.more, anchor: String(res.anchor).match(/^hc1s?:/)?.[0] || String(res.anchor) });
          if (!res.more) break;
          res = await window.Health.query({ type: 'spo2', anchor: res.anchor, limit: 50 });
        }
        out.uuids = seen.size;
        return out;
      });
      const { pages, uuids } = r.paged;
      const last = pages[pages.length - 1];
      if (pages.length < 2 || !pages.slice(0, -1).every((p) => p.more && p.anchor === 'hc1s:')) throw new Error(`no paging: ${JSON.stringify(r.paged)}`);
      if (last.more || last.anchor !== 'hc1:' || uuids < SPO2N) throw new Error(`not drained: ${JSON.stringify(r.paged)}`);
    });

    await ctx.step('Vitals: Steps / Heart Rate / SpO2 cards populated', async () => {
      // The page imports these kinds (bd med-0xad.1); the vault also holds the QA fixture, so
      // each card must have moved from this import: today's steps reach the seeded count, and the
      // HR / SpO2 history differs from before the switch-on.
      const b = r.cardsBefore;
      const full = (c) => c && c.steps >= VITALS.steps && c.hr !== b.hr && c.spo2 !== b.spo2;
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

    // med-8f4s.2: use the real page write seam and an independent native reader,
    // not the bridge query (which intentionally hides our own exported rows).
    let readSequence = 0;
    const readNative = async () => {
      const request = `${Date.now()}-${++readSequence}`;
      await shell(`am start -W -n ${pkg}/com.example.medtracker.QaHealthRead --es request ${request}`);
      for (const until = Date.now() + 15_000; Date.now() < until;) {
        const lines = (await shell('logcat -d -s qa-health-read:*')).split('\n');
        const line = lines.findLast((l) => l.includes(`"request":"${request}"`));
        if (line) {
          const result = JSON.parse(line.slice(line.indexOf('{"request":')));
          if (result.error) throw new Error(`native read: ${result.error}`);
          return result.records;
        }
        await sleep(500);
      }
      throw new Error('native reader timed out');
    };
    const waitNative = async (id, accept) => {
      let rows;
      for (const until = Date.now() + 30_000; Date.now() < until;) {
        rows = (await readNative()).filter((row) => row.clientId === id);
        if (accept(rows)) return rows;
        await sleep(1000);
      }
      throw new Error(`native state for ${id}: ${JSON.stringify(rows)}`);
    };
    const api = (path, method, body) => ctx.page.evaluate(
      ([p, m, b]) => window.apiCall(p, m, b), [path, method, body]);
    const native = (method, args) => ctx.page.evaluate(
      ([m, a]) => window.Health[m](a), [method, args]);
    r.writeBack = {};

    await ctx.step('write access uses real grants; HW1 switch on', async () => {
      await ctx.page.evaluate(() => window.switchTab('settings'));
      const toggle = ctx.page.locator('#health-write-row .wg-toggle');
      await toggle.waitFor({ state: 'visible', timeout: 15_000 });
      r.writeBack.grants = await native('writeAccess', ['bp', 'weight', 'hr', 'workout']);
      if (!['bp', 'weight', 'hr', 'workout'].every((k) => r.writeBack.grants.granted.includes(k) && r.writeBack.grants.supported.includes(k))) throw new Error('missing write grants or supported kinds');
      if (await ctx.page.evaluate(() => localStorage.getItem('wg.health.write') === 'true')) throw new Error('write switch was on by default');
      await toggle.click();
      await ctx.page.waitForFunction(() => {
        const input = document.getElementById('health-write-toggle');
        return input?.checked && !input.disabled && localStorage.getItem('wg.health.write') === 'true';
      }, null, { timeout: 15_000 });
      await ctx.page.locator('#health-write-row').scrollIntoViewIfNeeded();
      r.writeBack.hw1 = await ctx.page.locator('#health-write-row').innerText();
      if (/Writing paused|Writing .* only|isn't allowed/.test(r.writeBack.hw1)) throw new Error(`HW1: ${r.writeBack.hw1}`);
      await ctx.stableShot('health-write-hw1');
    });

    let bp;
    await ctx.step('hand-entered BP reaches Health Connect once under the vault id', async () => {
      // The emulator's WebView clock can run a fraction ahead of the Health
      // service. A measured reading in the recent past avoids future-time rejection.
      bp = await api('/api/bp', 'POST', { systolic: 121, diastolic: 81, pulse: 66, measured_at: new Date(Date.now() - 60_000).toISOString(), notes: 'write-back QA' });
      r.writeBack.bp = bp;
      r.writeBack.created = await waitNative(bp.id, (rows) => rows.length === 1 && rows[0].systolic === 121);
      if (r.writeBack.created[0].recordingMethod !== 3) throw new Error('BP is not manually entered');
      r.writeBack.pulseCreated = await waitNative(`${bp.id}/pulse`, (rows) => rows.length === 1 && rows[0].samples?.length === 1 && rows[0].samples[0].bpm === 66);
      const pulse = r.writeBack.pulseCreated[0];
      if (pulse.recordingMethod !== 3 || pulse.version !== r.writeBack.created[0].version || pulse.at !== r.writeBack.created[0].at || pulse.samples[0].at !== pulse.at) throw new Error('pulse identity, provenance, version or timestamp mismatch');
    });

    await ctx.step('editing BP upserts once; equal replay is idempotent and older versions cannot replace it', async () => {
      await api(`/api/bp/${encodeURIComponent(bp.id)}`, 'PUT', { systolic: 126, diastolic: 83, pulse: 67 });
      r.writeBack.edited = await waitNative(bp.id, (rows) => rows.length === 1 && rows[0].systolic === 126);
      const edited = r.writeBack.edited[0];
      if (edited.version <= r.writeBack.created[0].version) throw new Error('edit did not advance the client version');
      // The web emits the same committed payload for an equal version. API34
      // accepts an equal-version replay (despite the stricter SDK guide wording).
      await native('write', { type: 'bp', id: bp.id, version: edited.version,
        at: Date.parse(bp.measured_at), systolic: 126, diastolic: 83 });
      await native('write', { type: 'bp', id: bp.id, version: edited.version - 1,
        at: Date.parse(bp.measured_at), systolic: 111, diastolic: 71 });
      const rows = (await readNative()).filter((row) => row.clientId === bp.id);
      if (rows.length !== 1 || rows[0].systolic !== 126 || rows[0].version !== edited.version) throw new Error(`version regression: ${JSON.stringify(rows)}`);
      r.writeBack.pulseEdited = await waitNative(`${bp.id}/pulse`, (rows) => rows.length === 1 && rows[0].samples[0].bpm === 67 && rows[0].version === edited.version);
      await native('write', { type: 'hr', id: `${bp.id}/pulse`, version: edited.version, at: edited.at, bpm: 67 });
      await native('write', { type: 'hr', id: `${bp.id}/pulse`, version: edited.version - 1, at: edited.at, bpm: 55 });
      await waitNative(`${bp.id}/pulse`, (rows) => rows.length === 1 && rows[0].samples[0].bpm === 67 && rows[0].version === edited.version);
    });

    await ctx.step('pulse scan and changes exclude our copies but preserve the unmarked heart-rate series', async () => {
      const scan = await native('query', { type: 'hr', anchor: null });
      if (scan.samples.some((s) => s.start === r.writeBack.pulseCreated[0].at)) throw new Error('our pulse echoed in scan');
      if (![VITALS.hr, VITALS.hr + 1].every((v) => scan.samples.some((s) => s.value === v))) throw new Error('unmarked HR series was filtered');
      await api(`/api/bp/${encodeURIComponent(bp.id)}`, 'PUT', { pulse: 68 });
      await waitNative(`${bp.id}/pulse`, (rows) => rows.length === 1 && rows[0].samples[0].bpm === 68);
      r.writeBack.pulseChanges = await native('query', { type: 'hr', anchor: scan.anchor });
      if (!r.writeBack.pulseChanges.anchor || r.writeBack.pulseChanges.returned < 1 || r.writeBack.pulseChanges.samples.some((s) => s.start === r.writeBack.pulseCreated[0].at)) throw new Error('our pulse echoed in changes or raw anchor stalled');
    });

    await ctx.step('clearing pulse removes only its own identity; setting it again recreates one sample', async () => {
      await api(`/api/bp/${encodeURIComponent(bp.id)}`, 'PUT', { pulse: null });
      r.writeBack.pulseCleared = await waitNative(`${bp.id}/pulse`, (rows) => rows.length === 0);
      await waitNative(bp.id, (rows) => rows.length === 1);
      await api(`/api/bp/${encodeURIComponent(bp.id)}`, 'PUT', { pulse: 69 });
      r.writeBack.pulseRestored = await waitNative(`${bp.id}/pulse`, (rows) => rows.length === 1 && rows[0].samples.length === 1 && rows[0].samples[0].bpm === 69);
    });

    await ctx.step('scan and changes filter our writes while raw anchors keep moving', async () => {
      const scan = await native('query', { type: 'bp', anchor: null });
      if (scan.samples.some((s) => s.systolic === 126 && s.diastolic === 83)) throw new Error('our BP was imported again');
      if (!scan.samples.some((s) => s.systolic === FIRST[0] && s.diastolic === FIRST[1])) throw new Error('same-package record without client id was filtered');
      await api(`/api/bp/${encodeURIComponent(bp.id)}`, 'PUT', { systolic: 127, diastolic: 84 });
      await waitNative(bp.id, (rows) => rows.length === 1 && rows[0].systolic === 127);
      const changed = await native('query', { type: 'bp', anchor: scan.anchor });
      r.writeBack.filteredChanges = changed;
      if (!changed.anchor || changed.returned < 1 || changed.samples.some((s) => s.systolic === 127 && s.diastolic === 84)) throw new Error(`filtered changes: ${JSON.stringify(changed)}`);
      const stored = await api('/api/bp?days=2', 'GET');
      const rows = Array.isArray(stored) ? stored : stored.items || stored.data || stored.readings || [];
      const own = rows.filter((row) => [121, 126, 127].includes(row.systolic) && row.notes === 'write-back QA');
      if (own.length !== 1 || own[0].id !== bp.id) throw new Error(`duplicate vault BP: ${JSON.stringify(own)}`);
    });

    await ctx.step('delete is idempotent and never treats an imported store UUID as our identity', async () => {
      const imported = (await readNative()).find((row) => row.clientId === null && row.systolic === FIRST[0] && row.diastolic === FIRST[1]);
      if (!imported) throw new Error('native import fixture missing');
      await native('remove', { type: 'bp', id: imported.id });
      if (!(await readNative()).some((row) => row.id === imported.id)) throw new Error('delete erased an imported record by Health UUID');
      await api(`/api/bp/${encodeURIComponent(bp.id)}`, 'DELETE');
      await waitNative(bp.id, (rows) => rows.length === 0);
      r.writeBack.pulseDeleted = await waitNative(`${bp.id}/pulse`, (rows) => rows.length === 0);
      const importedPulse = (await readNative()).find((row) => row.type === 'hr' && row.clientId === null);
      if (!importedPulse) throw new Error('unmarked pulse fixture missing');
      await native('remove', { type: 'hr', id: importedPulse.id });
      if (!(await readNative()).some((row) => row.id === importedPulse.id)) throw new Error('pulse delete erased an imported Health UUID');
      if (await native('remove', { type: 'hr', id: `${bp.id}/pulse` }) !== true) throw new Error('unknown pulse id did not resolve true');
      if (await native('remove', { type: 'bp', id: bp.id }) !== true) throw new Error('unknown client id did not resolve true');
      r.writeBack.importedPreserved = imported.id;
    });

    await ctx.step('weight uses its vault identity and disappears on delete', async () => {
      const weight = await api('/api/weight', 'POST', { weight: 72.25, measured_at: new Date(Date.now() - 60_000).toISOString(), notes: 'write-back QA' });
      r.writeBack.weight = await waitNative(weight.id, (rows) => rows.length === 1 && rows[0].kg === 72.25);
      await api(`/api/weight/${encodeURIComponent(weight.id)}`, 'DELETE');
      await waitNative(weight.id, (rows) => rows.length === 0);
    });

    await ctx.step('revoked write access reports the real partial grant and refuses writes', async () => {
      await shell(`pm revoke ${pkg} android.permission.health.WRITE_BLOOD_PRESSURE`);
      // Android may kill the app on revoke: relaunch from the persisted local-mode state.
      ctx.page = undefined;
      await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity`);
      if (!(await ctx.attachPage())) throw new Error('re-attach after revoke failed');
      r.writeBack.partial = await native('writeAccess', ['bp', 'weight']);
      if (r.writeBack.partial.granted.includes('bp') || !r.writeBack.partial.granted.includes('weight')) throw new Error('partial grant was misreported');
      const denied = await ctx.page.evaluate(async () => {
        try { await window.Health.write({ type: 'bp', id: 'denied-qa', version: 1, at: Date.now(), systolic: 120, diastolic: 80 }); return ''; }
        catch (e) { return String(e.message || e); }
      });
      if (!/denied/.test(denied)) throw new Error(`write was not denied: ${denied}`);
      await shell(`pm grant ${pkg} android.permission.health.WRITE_BLOOD_PRESSURE`);
    });

    await ctx.step('denied heart-rate access holds pulse only; late grant drains existing pending writes', async () => {
      await shell(`pm revoke ${pkg} android.permission.health.WRITE_HEART_RATE`);
      ctx.page = undefined;
      await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity`);
      if (!(await ctx.attachPage())) throw new Error('re-attach after heart-rate revoke failed');
      r.writeBack.hrDeniedAccess = await native('writeAccess', ['bp', 'weight', 'hr']);
      const access = r.writeBack.hrDeniedAccess;
      if (!access.supported.includes('hr') || access.granted.includes('hr') || !['bp', 'weight'].every((k) => access.granted.includes(k))) throw new Error('denied HR blocked BP/weight or hid support');
      const pending = await api('/api/bp', 'POST', { systolic: 124, diastolic: 82, pulse: 70, measured_at: new Date(Date.now() - 60_000).toISOString(), notes: 'pulse denied QA' });
      r.writeBack.hrDeniedBp = await waitNative(pending.id, (rows) => rows.length === 1);
      await waitNative(`${pending.id}/pulse`, (rows) => rows.length === 0);
      const weight = await api('/api/weight', 'POST', { weight: 73.25, measured_at: new Date(Date.now() - 60_000).toISOString() });
      await waitNative(weight.id, (rows) => rows.length === 1 && rows[0].kg === 73.25);
      await ctx.page.evaluate(() => window.switchTab('settings'));
      await ctx.page.locator('#health-write-row').scrollIntoViewIfNeeded();
      r.writeBack.hrHeld = await ctx.page.evaluate(() => ({ ledger: JSON.parse(localStorage.getItem('wg.health.dirty') || '{}'), hint: document.getElementById('health-write-row')?.innerText }));
      // BP and weight went through the real write hooks while HR remained denied.
      if (!/Pulse \(heart rate\) isn't allowed/.test(r.writeBack.hrHeld.hint)) throw new Error(`missing HR refusal hint: ${JSON.stringify(r.writeBack.hrHeld)}`);
      if (!(pending.id in (r.writeBack.hrHeld.ledger.hr || {}))) throw new Error('denied pulse missing from pending ledger');
      if ((await healthDiag()).some((l) => /write hr failed/.test(l))) throw new Error('denied HR generated write failures instead of holding its kind');
      // Saving BP can offer the unrelated reminders nudge. Dismiss it through
      // its normal action so the evidence actually shows the refusal row.
      const notNow = ctx.page.locator('#notify-permission-sheet [data-notify-choice="not-now"]');
      await notNow.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      if (await notNow.isVisible()) await notNow.click();
      await ctx.page.locator('#notify-permission-sheet').waitFor({ state: 'hidden', timeout: 5000 });
      await ctx.page.locator('#health-write-row').scrollIntoViewIfNeeded();
      await ctx.stableShot('health-write-pulse-denied');
      await shell(`pm grant ${pkg} android.permission.health.WRITE_HEART_RATE`);
      // Playwright's attached WebView can stay "visible" under another Activity.
      // Reopen the persisted app to exercise a real next-open drain after granting.
      await shell(`am force-stop ${pkg}`);
      ctx.page = undefined;
      await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity`);
      if (!(await ctx.attachPage())) throw new Error('re-attach after heart-rate grant failed');
      r.writeBack.pulseLateGrant = await waitNative(`${pending.id}/pulse`, (rows) => rows.length === 1 && rows[0].samples[0].bpm === 70);
      await api(`/api/bp/${encodeURIComponent(pending.id)}`, 'DELETE');
      await waitNative(pending.id, (rows) => rows.length === 0);
      await waitNative(`${pending.id}/pulse`, (rows) => rows.length === 0);
      await api(`/api/weight/${encodeURIComponent(weight.id)}`, 'DELETE');
      await waitNative(weight.id, (rows) => rows.length === 0);
    });

    // med-8f4s.9: the page supplies its final span/type; independent SDK reads
    // inspect provider metadata rather than asking the bridge that hides our copies.
    r.workouts = {};
    const complete = (id) => api(`/api/workout/sessions/status?id=${id}`, 'PUT', { status: 'completed' });
    const removeSession = (id) => api(`/api/workout/sessions/delete?id=${id}`, 'DELETE');
    const newSession = async (bodyPart) => {
      const { session } = await api('/api/workout/sessions/adhoc', 'POST');
      const name = `Workout QA ${bodyPart} ${Date.now()}`;
      const exercise = await api('/api/workout/exercise-library/create', 'POST', { name, body_part: bodyPart });
      await api('/api/workout/sessions/logs/create', 'POST', { session_id: session.id,
        exercise_id: exercise.id, exercise_name: name, source: 'library', target_sets: 1, target_reps_min: 5, target_weight_kg: 10 });
      return session;
    };
    const exported = (rows, session) => rows.filter((row) => row.type === 'workout' && row.clientId && row.start === Date.parse(session.started_at));
    const waitSession = async (session) => {
      for (const until = Date.now() + 30_000; Date.now() < until;) {
        const rows = exported(await readNative(), session);
        if (rows.length === 1) return rows[0];
        await sleep(1000);
      }
      throw new Error(`workout did not arrive: ${JSON.stringify(session)}`);
    };
    let strength;
    let strengthRecord;
    let workoutAnchor;
    await ctx.step('open session is absent; completing all-tagged strength writes one minimal manual session', async () => {
      strength = await newSession('chest');
      await sleep(1500);
      if (exported(await readNative(), strength).length) throw new Error('open session was exported');
      await complete(strength.id);
      strengthRecord = await waitSession(strength);
      const detail = await api(`/api/workout/sessions/details?id=${strength.id}`, 'GET');
      const stored = await ctx.page.evaluate(async (id) => {
        const { localRecordsPort } = await import('/js/sync.js');
        return (await localRecordsPort().listRaw('workoutsession')).find((s) => s.id === id);
      }, strength.id);
      r.workouts.strength = { session: strength, detail, stored, record: strengthRecord };
      // AndroidX ExerciseSessionRecord constants: STRENGTH_TRAINING=70,
      // OTHER_WORKOUT=0 (developer.android.com/reference/kotlin/androidx/health/connect/client/records/ExerciseSessionRecord).
      if (strengthRecord.exerciseType !== 70 || strengthRecord.recordingMethod !== 3 || strengthRecord.clientId !== stored.recordId || strengthRecord.version !== stored.clientTs ||
          strengthRecord.end !== Date.parse(detail.session.completed_at) || strengthRecord.end <= strengthRecord.start ||
          strengthRecord.title !== null || strengthRecord.notes !== null || strengthRecord.segments !== 0 || strengthRecord.laps !== 0) {
        throw new Error(`workout metadata: ${JSON.stringify(r.workouts.strength)}`);
      }
      const scan = await native('query', { type: 'workout', anchor: null });
      workoutAnchor = scan.anchor;
      if (scan.samples.some((s) => s.start === strengthRecord.start)) throw new Error('marked workout echoed in scan');
      if (!scan.samples.some((s) => s.activity === 37)) throw new Error('unmarked running fixture was filtered');
      r.workouts.scan = scan;
    });
    await ctx.step('workout edits replace our identity; equal replay and stale versions preserve the committed payload', async () => {
      const edited = { type: 'workout', id: strengthRecord.clientId, version: strengthRecord.version + 1,
        start: strengthRecord.start, end: strengthRecord.end, activity: 3000 };
      await native('write', edited);
      r.workouts.edited = await waitNative(edited.id, (rows) => rows.length === 1 && rows[0].version === edited.version);
      const generic = r.workouts.edited[0];
      if (generic.exerciseType !== 0) throw new Error('other workout mapped to the wrong SDK type');
      await native('write', edited);
      await native('write', { ...edited, version: strengthRecord.version, activity: 50 });
      r.workouts.replayed = await waitNative(edited.id, (rows) => rows.length === 1 && rows[0].version === edited.version && rows[0].exerciseType === generic.exerciseType);
      const changes = await native('query', { type: 'workout', anchor: workoutAnchor });
      if (!changes.anchor || changes.returned < 1 || changes.samples.some((s) => s.start === edited.start)) throw new Error('marked workout echoed or anchor stalled');
      r.workouts.changes = changes;
      r.workouts.imported = await ctx.page.evaluate(async (start) => {
        const { localRecordsPort } = await import('/js/sync.js');
        const { resetHealthAnchors, runHealthImport } = await import('/js/health-import.js');
        const records = localRecordsPort();
        resetHealthAnchors();
        await runHealthImport({ accountId: 'local' }, { records, flush: async () => {} });
        const rows = await records.list('miband');
        return { ownEchoes: rows.filter((r) => r.source_start_ms === start),
          unmarkedRunning: rows.filter((r) => r.source === 'apple_health' && r.activity_name === 'running').length };
      }, edited.start);
      if (r.workouts.imported.ownEchoes.length || !r.workouts.imported.unmarkedRunning) throw new Error('Health import echoed our other workout or lost the running fixture');
      for (const activity of [37, 50.5, '50', null]) {
        const result = await native('write', { ...edited, version: edited.version + 1, activity }).then(() => 'accepted', (e) => String(e.message || e));
        if (!result.includes('bad write: activity')) throw new Error(`malformed activity accepted: ${activity}: ${result}`);
      }
      await removeSession(strength.id);
      await waitNative(edited.id, (rows) => rows.length === 0);
      const scan = await native('query', { type: 'workout', anchor: null });
      if (!scan.samples.some((s) => s.activity === 37)) throw new Error('delete removed unmarked fixture');
    });
    await ctx.step('cardio completion writes other; denied exercise holds workouts while BP pulse and weight continue; late grant drains once', async () => {
      const cardio = await newSession('cardio');
      await sleep(1500);
      await complete(cardio.id);
      const other = await waitSession(cardio);
      r.workouts.other = other;
      if (other.exerciseType !== r.workouts.edited[0].exerciseType) throw new Error('cardio was not other workout');
      await removeSession(cardio.id);
      await waitNative(other.clientId, (rows) => rows.length === 0);
      await shell(`pm revoke ${pkg} android.permission.health.WRITE_EXERCISE`);
      // As for BP/HR above, Android kills the process on a permission revoke.
      ctx.page = undefined;
      await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity`);
      if (!(await ctx.attachPage())) throw new Error('re-attach after exercise revoke failed');
      const access = await native('writeAccess', ['bp', 'weight', 'hr', 'workout']);
      if (access.granted.includes('workout') || !['bp', 'weight', 'hr'].every((k) => access.granted.includes(k))) throw new Error('exercise denial leaked across kinds');
      const pending = await newSession('cardio');
      await sleep(1500);
      await complete(pending.id);
      const reading = await api('/api/bp', 'POST', { systolic: 122, diastolic: 82, pulse: 71, measured_at: new Date(Date.now() - 60_000).toISOString() });
      const weight = await api('/api/weight', 'POST', { weight: 74.25, measured_at: new Date(Date.now() - 60_000).toISOString() });
      await waitNative(reading.id, (rows) => rows.length === 1);
      await waitNative(`${reading.id}/pulse`, (rows) => rows.length === 1 && rows[0].samples[0].bpm === 71);
      await waitNative(weight.id, (rows) => rows.length === 1 && rows[0].kg === 74.25);
      if (exported(await readNative(), pending).length) throw new Error('denied workout was written');
      await ctx.page.evaluate(() => window.switchTab('settings'));
      const notNow = ctx.page.locator('#notify-permission-sheet [data-notify-choice="not-now"]');
      if (await notNow.isVisible()) await notNow.click();
      await ctx.page.locator('#health-write-row').scrollIntoViewIfNeeded();
      r.workouts.held = await ctx.page.evaluate(() => ({ ledger: JSON.parse(localStorage.getItem('wg.health.dirty') || '{}'), hint: document.getElementById('health-write-row')?.innerText }));
      if (!/Workouts aren't allowed/.test(r.workouts.held.hint) || !Object.keys(r.workouts.held.ledger.workout || {}).length) throw new Error('workout denial missing from UI/ledger');
      await ctx.stableShot('health-write-workout-denied');
      await shell(`pm grant ${pkg} android.permission.health.WRITE_EXERCISE`);
      await shell(`am force-stop ${pkg}`);
      ctx.page = undefined;
      await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity`);
      if (!(await ctx.attachPage())) throw new Error('re-attach after exercise grant failed');
      r.workouts.lateGrant = await waitSession(pending);
      await removeSession(pending.id);
      await waitNative(r.workouts.lateGrant.clientId, (rows) => rows.length === 0);
      await api(`/api/bp/${encodeURIComponent(reading.id)}`, 'DELETE');
      await api(`/api/weight/${encodeURIComponent(weight.id)}`, 'DELETE');
    });

    await ctx.step('Health Connect rationale names the pulse and completed workout copy', async () => {
      await shell(`am start -W -a androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE -n ${pkg}/com.example.medtracker.PermissionsRationaleActivity`);
      await ctx.waitFor({ text: 'Health Connect access' }, 10_000);
      await ctx.stableShot('workout-rationale');
    });
  } finally {
    r.writer = (await shell('logcat -d -s qa-health-write:*')).split('\n').slice(-6);
    r.diag = (await healthDiag()).slice(-20);
    ctx.log('health', JSON.stringify(r, null, 2));
  }
}
