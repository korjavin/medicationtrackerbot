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
import { healthRecordId, sleepDayOf, sleepDayOfRow } from '../../../web/domain/healthsource.js';

export const READS = ['BLOOD_PRESSURE', 'WEIGHT', 'SLEEP', 'EXERCISE', 'HEART_RATE', 'TOTAL_CALORIES_BURNED', 'DISTANCE', 'STEPS', 'OXYGEN_SATURATION', 'HEALTH_DATA_HISTORY'];
const WRITES = ['BLOOD_PRESSURE', 'WEIGHT', 'SLEEP', 'STEPS', 'HEART_RATE', 'OXYGEN_SATURATION', 'EXERCISE'];

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
      let p = await ctx.launchLocal('today');
      // Stop the visual clock/seed driver before native Instant comparisons or scans.
      await p.goto(`${ctx.LOCAL_ORIGIN}/`, { waitUntil: 'load' });
      await ctx.waitLocalReady(p);
      await p.evaluate(() => {
        window.__qaVis = [];
        document.addEventListener('visibilitychange', () => window.__qaVis.push(document.visibilityState));
      });
      r.cardsBefore = await overview();
    });

    const windowAccess = async (types = ['bp', 'weight']) => {
      // The visual fixture freezes page Date; bracket the real native clock
      // using the emulator's Unix time, rather than comparing it to that fixture.
      const before = Number((await shell('date +%s')).trim()) * 1000;
      const access = await ctx.page.evaluate((types) => window.Health.writeAccess(types), types);
      const after = Number((await shell('date +%s')).trim()) * 1000 + 999;
      if (!Number.isFinite(before) || !Number.isFinite(after)) throw new Error('invalid device clock diagnostic');
      return { ...access, before, after };
    };
    const assertWindow = (access, history = false) => {
      if (history) {
        if (access.readableFrom !== 0) throw new Error(`history window: ${JSON.stringify(access)}`);
      } else if (!Number.isFinite(access.readableFrom) || access.readableFrom === 0 ||
          access.readableFrom < access.before - 30 * 86400_000 - 2000 || access.readableFrom > access.after - 30 * 86400_000 + 2000) {
        throw new Error(`rolling window: ${JSON.stringify(access)}`);
      }
    };
    const sdkAccess = async () => {
      const request = `access-${Date.now()}`;
      await shell(`am start -W -n ${pkg}/com.example.medtracker.QaHealthRead --ez access true --es request ${request}`);
      for (const until = Date.now() + 15_000; Date.now() < until;) {
        const line = (await shell('logcat -d -s qa-health-read:*')).split('\n').findLast((l) => l.includes(`"request":"${request}"`));
        if (line) {
          const result = JSON.parse(line.slice(line.indexOf('{"request":')));
          if (result.error) throw new Error(`SDK access: ${result.error}`);
          return result.access;
        }
        await sleep(500);
      }
      throw new Error('SDK access diagnostic timed out');
    };
    await ctx.step('empty and write-only grants use todays conservative window; real SDK history access selects the branch', async () => {
      r.window = {};
      r.window.empty = await windowAccess();
      assertWindow(r.window.empty);
      if (r.window.empty.granted.length) throw new Error('fresh install had write grants');
      await shell(`pm grant ${pkg} android.permission.health.WRITE_WEIGHT`);
      r.window.writeOnly = await windowAccess();
      assertWindow(r.window.writeOnly);
      if (r.window.writeOnly.granted.join(',') !== 'weight') {
        throw new Error(`write-only window: ${JSON.stringify(r.window)}`);
      }
      for (const p of READS.filter((p) => p !== 'HEALTH_DATA_HISTORY')) await shell(`pm grant ${pkg} android.permission.health.READ_${p}`);
      for (const p of WRITES) await shell(`pm grant ${pkg} android.permission.health.WRITE_${p}`);
      await shell(`am force-stop ${pkg}`);
      ctx.page = undefined;
      await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity`);
      if (!(await ctx.attachPage())) throw new Error('re-attach for history window failed');
      await ctx.waitLocalReady(ctx.page);
      r.window.deniedHistory = await windowAccess();
      assertWindow(r.window.deniedHistory);
      await shell(`pm grant ${pkg} android.permission.health.READ_HEALTH_DATA_HISTORY`);
      r.window.provider = await sdkAccess();
      r.window.history = await windowAccess();
      if (r.window.provider.historyAvailable && !r.window.provider.historyGranted) throw new Error('available history permission was not granted');
      assertWindow(r.window.history, r.window.provider.historyGranted);
      await ctx.page.evaluate(() => window.Health.requestAuthorization(['bp'], { write: ['weight'] }));
      r.window.afterReask = await windowAccess();
      assertWindow(r.window.afterReask, r.window.provider.historyGranted);
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

    await ctx.step('B3 real SDK BP/weight/settled sleep → explicit rescan → exact source labels and dedupe', async () => {
      // Source-label proof uses the accepted same-package/null-client-ID stand-in;
      // dataOrigin is assigned by the SDK, never spoofed. No Home/foreground claim.
      const access = await sdkAccess();
      for (const permission of ['READ_WEIGHT', 'WRITE_WEIGHT', 'READ_SLEEP', 'WRITE_SLEEP']) {
        if (!access.granted.includes(`android.permission.health.${permission}`)) throw new Error(`SDK lacks ${permission}`);
      }
      const beforeClock = Number(await shell('date +%s')) * 1000;
      const prior = await ctx.page.evaluate(async () => ({
        pinned: !!Date.wgQAPinned, now: Date.now(),
        vault: JSON.parse(await window.CloudVault.exportAll({ includeSecrets: false })).data.vitals.sleep,
        provider: await window.Health.query({ type: 'sleep', from: Date.now() - 7 * 86400_000, to: Date.now() }),
        overview: await window.apiCall('/api/health/overview'),
      }));
      const afterClock = Number(await shell('date +%s')) * 1000 + 999;
      if (prior.pinned || prior.now < beforeClock - 2000 || prior.now > afterClock + 2000) throw new Error('Health assertion page is not on native real clock');
      const occupied = new Set([...prior.vault.map((s) => s.day), ...(prior.provider.samples || []).map((s) => new Date(s.end).toISOString().slice(0, 10))]);
      const sleepDays = [2, 3, 4, 5, 6].find((days) => !occupied.has(new Date(beforeClock - days * 86400_000).toISOString().slice(0, 10)));
      if (!sleepDays) throw new Error('no distinct readable fixture sleep day');
      const manualOffset = [1, 2, 3, 4, 5, 6].find((days) => days !== sleepDays && !occupied.has(new Date(beforeClock - days * 86400_000).toISOString().slice(0, 10)));
      if (!manualOffset) throw new Error('no distinct manual comparison sleep day');
      // A bounded hand-authored non-Health DAY ROW, not a claim of a Sleep editor.
      // Use the canonical day id intentionally: healthsource.unifySleep projects EVERY
      // non-Health legacy session as Mi Band, hiding the unknown-source comparison.
      // This unused day differs from all golden/provider/SDK days, so no Health row can
      // overwrite it in this fixture. The golden Mi Band night is asserted separately.
      const manualDay = new Date(beforeClock - manualOffset * 86400_000).toISOString().slice(0, 10);
      prior.overview = await ctx.page.evaluate(async (day) => {
        const end = Date.parse(`${day}T06:00:00Z`);
        await (await import('/js/sync.js')).localRecordsPort().put('sleep', {
          recordId: `sleep-hk-${day}`, clientTs: Date.now(), deleted: false, day,
          start_time: new Date(end - 7 * 3600_000).toISOString(), end_time: new Date(end).toISOString(),
          timezone_offset: 0, total_minutes: 420, source: 'unknown', user_modified: true,
          notes: 'B3 hand-authored comparison',
        });
        return window.apiCall('/api/health/overview');
      }, manualDay);
      const request = `b3-${Date.now()}`;
      const kg = 130 + Math.floor(Math.random() * 200) / 10;
      const sys = SECOND[0] + 2;
      const before = Number(await shell('date +%s')) * 1000;
      await shell(`am start -W -n ${pkg}/com.example.medtracker.QaHealthWrite --es request ${request} --ei sys ${sys} --ei dia 101 --ei grams ${Math.round(kg * 1000)} --ei sleepDays ${sleepDays}`);
      let inserted;
      for (const until = Date.now() + 20_000; Date.now() < until;) {
        const line = (await shell('logcat -d -s qa-health-write:*')).split('\n').findLast((l) => l.includes(`"request":"${request}"`));
        if (line) { inserted = JSON.parse(line.slice(line.indexOf('{"request":'))); break; }
        await sleep(500);
      }
      const after = Number(await shell('date +%s')) * 1000 + 999;
      if (!inserted || inserted.now < before || inserted.now > after || inserted.records.length !== 3) throw new Error('SDK insertion/real timestamp evidence missing');
      const bp = inserted.records.find((s) => s.type === 'BloodPressureRecord');
      const weight = inserted.records.find((s) => s.type === 'WeightRecord');
      const night = inserted.records.find((s) => s.type === 'SleepSessionRecord');
      if (inserted.records.some((s) => !s.id || s.clientId !== null) || night.end > before - 3 * 3600_000) throw new Error('fixture identity/settling boundary invalid');
      const provider = await ctx.page.evaluate(async ({ from, to }) => {
        const out = {};
        for (const type of ['bp', 'weight', 'sleep']) out[type] = await window.Health.query({ type, from, to, anchor: null });
        return out;
      }, { from: night.start - 86400_000, to: after });
      for (const [type, record] of [['bp', bp], ['weight', weight], ['sleep', night]]) {
        if (!provider[type].samples.some((s) => s.uuid === record.id)) throw new Error(`SDK-assigned ${type} UUID absent from real bridge scan`);
      }
      const sleepSample = provider.sleep.samples.find((s) => s.uuid === night.id);
      if (sleepSample.source !== pkg || sleepSample.start !== night.start || sleepSample.end !== night.end) throw new Error('SDK-assigned sleep origin/window mismatch');
      r.b3 = { stage: 'SDK rows verified', access, before, after, inserted, sleepOrigin: sleepSample.source,
        providerIds: Object.fromEntries(Object.entries(provider).map(([k, v]) => [k, v.samples.map((s) => s.uuid)])),
        provenance: 'same package, SDK-assigned dataOrigin' };
      await ctx.page.locator('[data-nav-to="settings"]:visible').first().click();
      await toggle(); await sleep(1000); await toggle();
      const imported = async () => ctx.page.evaluate(async () => JSON.parse(await window.CloudVault.exportAll({ includeSecrets: false })).data);
      let data;
      const day = new Date(night.end).toISOString().slice(0, 10);
      for (const until = Date.now() + 30_000; Date.now() < until;) {
        data = await imported();
        if (data.bp.readings.some((s) => s.source_id === bp.id) && data.weight.logs.some((s) => s.source_id === weight.id) && data.vitals.sleep.some((s) => s.source_id === day)) break;
        await sleep(500);
      }
      const importedBp = data.bp.readings.find((s) => s.source_id === bp.id);
      const importedWeight = data.weight.logs.find((s) => s.source_id === weight.id);
      const importedSleep = data.vitals.sleep.find((s) => s.source_id === day);
      if (importedBp?.source !== 'apple_health' || importedBp.systolic !== sys || importedWeight?.source !== 'apple_health' || importedWeight.weight !== kg ||
        importedSleep?.source !== 'apple_health' || Date.parse(importedSleep.start_time) !== night.start || Date.parse(importedSleep.end_time) !== night.end || importedSleep.total_minutes !== 480) throw new Error('exact SDK fixture not imported');
      // Public BP/weight responses expose record `id`, not the vault-only source_id.
      // Use the owning domain identity transform to join the exact SDK UUID to the UI.
      const identities = await ctx.page.evaluate(async ({ bpId, weightId, sys, kg }) => {
        const rows = (r, kind) => Array.isArray(r) ? r : (r.items || r.data || r[kind] || []);
        const bp = rows(await window.apiCall('/api/bp?days=60'), 'readings');
        const weight = rows(await window.apiCall('/api/weight?days=0&limit=1000'), 'logs');
        return { bp: bp.find((s) => s.id === bpId && s.source === 'apple_health' && s.systolic === sys)?.id,
          weight: weight.find((s) => s.id === weightId && s.source === 'apple_health' && s.weight === kg)?.id,
          manualBp: bp.find((s) => s.source !== 'apple_health')?.id, manualWeight: weight.find((s) => s.source !== 'apple_health')?.id };
      }, { bpId: healthRecordId('bp', bp.id), weightId: healthRecordId('weight', weight.id), sys, kg });
      if (Object.values(identities).some((id) => id == null) || Object.keys(identities).length !== 4) throw new Error('missing imported/manual UI identities');
      await ctx.page.evaluate(() => window.switchTab('bp'));
      const bpRow = ctx.page.locator(`.wg-bp-reading-row[data-reading-id="${identities.bp}"]`);
      await bpRow.locator('.wg-source-label').getByText('Health import', { exact: true }).waitFor();
      const manualBp = ctx.page.locator(`.wg-bp-reading-row[data-reading-id="${identities.manualBp}"]`);
      await manualBp.waitFor();
      if (await manualBp.locator('.wg-source-label').count()) throw new Error('manual BP comparison row carries Health import label');
      await ctx.stableShot('b3-bp-source-label');
      await ctx.page.evaluate(() => window.switchTab('weight'));
      const weightRow = ctx.page.locator(`.wg-weight-history-row[data-weight-id="${identities.weight}"]`);
      await weightRow.locator('.wg-source-label').getByText('Health import', { exact: true }).waitFor();
      const manualWeight = ctx.page.locator(`.wg-weight-history-row[data-weight-id="${identities.manualWeight}"]`);
      await manualWeight.waitFor();
      if (await manualWeight.locator('.wg-source-label').count()) throw new Error('manual weight comparison row carries Health import label');
      await ctx.stableShot('b3-weight-source-label');
      await ctx.page.evaluate(() => window.switchTab('health'));
      await ctx.page.locator('.wg-sleep-card__sources').getByText(/Health import/).waitFor();
      await ctx.page.locator('.wg-sleep-card__sources').getByText(/Mi Band/).waitFor();
      if (await ctx.page.locator('#health-import-miband, #importexport-nxk-btn').count()) throw new Error('removed Mi Band import control reappeared');
      const overview = await ctx.page.evaluate(() => window.apiCall('/api/health/overview'));
      const stats = overview.sleep_stats_7d;
      const retainedMiBand = prior.vault.filter((s) => s.source === 'miband');
      if (!retainedMiBand.length || retainedMiBand.some((old) => !data.vitals.sleep.some((s) => JSON.stringify(s) === JSON.stringify(old)))) throw new Error('SDK import lost/changed retained Mi Band night');
      if (!stats.some((s) => s.date === day && s.sources.includes('apple_health') && s.total_mins === 480)) throw new Error('matching SDK sleep day/source absent from rendered overview');
      const manualDays = prior.overview.sleep_stats_7d.filter((s) => s.date === manualDay && s.sources.length === 1 && s.sources[0] === 'unknown' && s.total_mins === 420);
      if (!manualDays.length || manualDays.some((m) => !stats.some((s) => s.date === m.date && !s.sources.includes('apple_health')))) throw new Error('manual sleep comparison day lost or mislabeled');
      // Sleep's source hint aggregates the visible days; it is not a per-row label.
      await ctx.stableShot('b3-sleep-sources');
      await ctx.page.locator('[data-nav-to="settings"]:visible').first().click();
      await toggle(); await sleep(1000); await toggle();
      await sleep(4000);
      const again = await imported();
      const matches = (d) => ({ bp: d.bp.readings.filter((s) => s.source_id === bp.id), weight: d.weight.logs.filter((s) => s.source_id === weight.id), sleep: d.vitals.sleep.filter((s) => s.source_id === day) });
      if (JSON.stringify(matches(again)) !== JSON.stringify(matches(data)) || Object.values(matches(again)).some((rows) => rows.length !== 1)) throw new Error('explicit rescan duplicated/changed imported fixture');
      Object.assign(r.b3, { stage: 'complete',
        day, kg, sys, identities, labels: ['BP row', 'Weight row', 'Sleep per-day source aggregation'], manualSleepDays: manualDays.map((s) => s.date),
        manualSleepBoundary: 'hand-authored non-Health day row at an unused canonical day ID; no Sleep editor claimed', dedupe: true,
      });
    });

    // testscenarios/common/health-deleted-in-health.yaml (bd med-88x0.12). QaHealthWrite as
    // "another app" deletes by Health Connect id (ordinary DeletionChanges, no Health Connect UI):
    // a fresh BP, weight and workout, plus B3's night and B3's weight after an in-app edit. After a
    // force-stop and relaunch the import tombstones the four, while the app-edited weight, the
    // hand-entered readings and the untouched B3 BP stay and the import count does not move. A
    // Health night on a day with a seeded Mi Band session, deleted too, keeps its day row (the ledger guard).
    // A second, older night stays in Health Connect: the night reconcile needs a read reaching back
    // before the deleted night (an empty read proves nothing).
    async function deletedInHealth() {
      const writer = async (request, extras) => {
        await shell(`am start -W -n ${pkg}/com.example.medtracker.QaHealthWrite --es request ${request} ${extras}`);
        for (const until = Date.now() + 20_000; Date.now() < until;) {
          const log = (await shell('logcat -d -s qa-health-write:*')).split('\n');
          const line = log.findLast((l) => l.includes(`"request":"${request}"`));
          if (line) return JSON.parse(line.slice(line.indexOf('{"request":')));
          await sleep(500);
        }
        throw new Error(`writer ${request}: ${(await shell('logcat -d -s qa-health-write:*')).split('\n').slice(-3).join(' | ')}`);
      };
      const vault = () => ctx.page.evaluate(async () => {
        const { localRecordsPort } = await import('/js/sync.js');
        const port = localRecordsPort();
        const out = { last: JSON.parse(localStorage.getItem('wg.health.last') || '{}') };
        for (const t of ['bp', 'weight', 'miband', 'sleep']) out[t] = await port.listRaw(t);
        return out;
      });
      const call = (path, method, body) => ctx.page.evaluate(([p, m, b]) => window.apiCall(p, m, b), [path, method, body]);
      const row = (v, type, id) => v[type].find((x) => x.recordId === id);
      const live = (v, type, id) => { const x = row(v, type, id); return !!x && !x.deleted; };
      const d = (r.deleted = {});
      // A workout slot clear of every workout row, so the import cannot skip it as an overlap.
      const workoutStart = await ctx.page.evaluate(async () => {
        const { localRecordsPort } = await import('/js/sync.js');
        const taken = (await localRecordsPort().list('miband')).map((w) => [Number(w.source_start_ms), Number(w.source_end_ms)]);
        for (let k = 3; k < 48; k++) {
          const s = Date.now() - k * 1800_000;
          if (!taken.some(([a, b]) => s < b && a < s + 600_000)) return s;
        }
        return null;
      });
      if (!workoutStart) throw new Error('no free workout slot in the last day');
      const kg = 150 + Math.floor(Math.random() * 200) / 10;
      const inserted = await writer(`hd-${Date.now()}`, `--ei sys ${SECOND[0] + 3} --ei dia 102 --ei grams ${Math.round(kg * 1000)} --ei sleepDays 10 --ez workout true --el workoutStart ${workoutStart}`);
      const rec = (type) => inserted.records.find((x) => x.type === type);
      const fresh = { bp: rec('BloodPressureRecord'), weight: rec('WeightRecord'), workout: rec('ExerciseSessionRecord'), keeper: rec('SleepSessionRecord') };
      const b3 = Object.fromEntries(['BloodPressureRecord', 'WeightRecord', 'SleepSessionRecord'].map((t) => [t, r.b3.inserted.records.find((x) => x.type === t)]));
      if (Object.values(fresh).some((x) => !x?.id) || fresh.keeper.start >= b3.SleepSessionRecord.start) throw new Error(`writer fixture: ${JSON.stringify(inserted)}`);
      const id = {
        bp: healthRecordId('bp', fresh.bp.id), weight: healthRecordId('weight', fresh.weight.id),
        workout: healthRecordId('miband', fresh.workout.id.toLowerCase()), night: healthRecordId('sleep', r.b3.day),
        b3Weight: healthRecordId('weight', b3.WeightRecord.id), b3Bp: healthRecordId('bp', b3.BloodPressureRecord.id),
      };
      // A Health night on a day the fixture's Mi Band ledger already holds: deleting it in
      // Health must leave the day row live and the day unchanged (the reconcile's ledger guard).
      // The writer's night ends 06:00 UTC sleepDays ago; days 2..9 are settled and after the
      // keeper night, so the reconcile read reaches back before it.
      // The fixture's Mi Band nights sit on unsettled days, so the step seeds its own ledger
      // session (a non -hk- row, the shape a Mi Band import leaves) on a free day.
      const sleepRows = (await vault()).sleep;
      const today = new Date(Number((await shell('date +%s')).trim()) * 1000).toISOString().slice(0, 10);
      const nightEnd = (n) => Date.parse(`${today}T06:00:00Z`) - n * 86400_000;
      const used = new Set(sleepRows.map(sleepDayOfRow)); // tombstones too: a deleted day stays deleted
      const mbDays = [2, 3, 4, 5, 6, 7, 8, 9].find((n) => !used.has(sleepDayOf(nightEnd(n), 0)));
      if (!mbDays) throw new Error(`no free sleep day in days 2..9: ${JSON.stringify([...used])}`);
      id.mbDay = sleepDayOf(nightEnd(mbDays), 0);
      await ctx.page.evaluate(async ({ day, end }) => {
        await (await import('/js/sync.js')).localRecordsPort().put('sleep', {
          recordId: `sleep-mbqa-${day}`, clientTs: Date.now(), deleted: false, day,
          start_time: new Date(end - 5 * 3600_000).toISOString(), end_time: new Date(end).toISOString(),
          timezone_offset: 0, total_minutes: 300, source: 'miband', notes: 'health-deleted Mi Band ledger QA',
        });
      }, { day: id.mbDay, end: nightEnd(mbDays) });
      const mbNight = (await writer(`hmb-${Date.now()}`, `--ei sys ${SECOND[0] + 4} --ei dia 103 --ei sleepDays ${mbDays}`)).records.find((x) => x.type === 'SleepSessionRecord');
      id.mbNight = healthRecordId('sleep', id.mbDay);
      d.inserted = inserted;
      d.ids = id;

      // Import them (switch-on rescan): the anchors then sit on changes tokens, so the deletions
      // below arrive as DeletionChanges on the next open, not as an absence in a scan.
      await ctx.page.evaluate(() => window.switchTab('settings'));
      await ctx.page.locator('#health-import-toggle').waitFor({ state: 'attached', timeout: 15_000 });
      const t0 = await ctx.page.evaluate(() => Date.now());
      await toggle(); await sleep(1000); await toggle();
      const imported = (v) => ({ bp: live(v, 'bp', id.bp), weight: live(v, 'weight', id.weight), workout: live(v, 'miband', id.workout),
        night: live(v, 'sleep', id.night), mbNight: live(v, 'sleep', id.mbNight), b3Bp: live(v, 'bp', id.b3Bp), b3Weight: live(v, 'weight', id.b3Weight), run: v.last.checkedAt >= t0 });
      let before;
      for (const until = Date.now() + 45_000; Date.now() < until; await sleep(1000)) {
        before = await vault();
        if (Object.values(imported(before)).every(Boolean)) break;
      }
      d.importedBefore = imported(before);
      if (!Object.values(d.importedBefore).every(Boolean)) throw new Error(`fixture not imported: ${JSON.stringify(d.importedBefore)}`);

      // Edit B3's imported weight in the app the way the Weight form does: the replacement first
      // (an edit stays "from Health" but drops source_id), then the original goes.
      const b3WeightRow = row(before, 'weight', id.b3Weight);
      const edited = await call(`/api/weight?replaces=${encodeURIComponent(id.b3Weight)}`, 'POST',
        { weight: b3WeightRow.weight + 1, measured_at: b3WeightRow.measured_at, notes: 'edited in app QA' });
      await call(`/api/weight/${encodeURIComponent(id.b3Weight)}`, 'DELETE');
      id.edited = edited.id;
      const manual = { bp: r.b3.identities.manualBp, weight: r.b3.identities.manualWeight };
      const after0 = await vault();
      if (!live(after0, 'weight', id.edited) || !live(after0, 'bp', manual.bp) || !live(after0, 'weight', manual.weight)) throw new Error('edited/manual rows missing before the deletes');
      d.totalBefore = after0.last.total;
      const mbDayStat = async () => {
        const s = (await ctx.page.evaluate(() => window.apiCall('/api/health/overview'))).sleep_stats_7d.find((x) => x.date === id.mbDay);
        return s ? { sources: s.sources, total_mins: s.total_mins } : null;
      };
      d.mbDayStatBefore = await mbDayStat();

      d.writerDelete = await writer(`hdel-${Date.now()}`, `--es delete bp:${fresh.bp.id},weight:${fresh.weight.id},workout:${fresh.workout.id},sleep:${b3.SleepSessionRecord.id},weight:${b3.WeightRecord.id},sleep:${mbNight.id}`);
      if (d.writerDelete.deleted?.length !== 6) throw new Error(`writer delete: ${JSON.stringify(d.writerDelete)}`);
      // Still there in this (attached, never hidden) process: the removal below is the next open's.
      d.beforeRelaunch = imported(await vault());
      if (!['bp', 'weight', 'workout', 'night', 'mbNight'].every((k) => d.beforeRelaunch[k])) throw new Error(`removed before the relaunch: ${JSON.stringify(d.beforeRelaunch)}`);

      // The next open: a process Playwright starts fresh, whose boot import reads the changes.
      ctx.page = undefined;
      await shell(`am force-stop ${pkg}`);
      await sleep(2000);
      await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity`);
      if (!(await ctx.attachPage())) throw new Error('re-attach after the Health deletes failed');
      await ctx.waitLocalReady(ctx.page);
      const gone = (v) => ({ bp: !live(v, 'bp', id.bp), weight: !live(v, 'weight', id.weight), workout: !live(v, 'miband', id.workout), night: !live(v, 'sleep', id.night) });
      let after;
      for (const until = Date.now() + 60_000; Date.now() < until; await sleep(1000)) {
        after = await vault();
        if (Object.values(gone(after)).every(Boolean) && after.last.checkedAt > before.last.checkedAt) break;
      }
      d.gone = gone(after);
      d.stays = { edited: live(after, 'weight', id.edited), manualBp: live(after, 'bp', manual.bp), manualWeight: live(after, 'weight', manual.weight), b3Bp: live(after, 'bp', id.b3Bp),
        mbNight: live(after, 'sleep', id.mbNight) };
      // The Mi Band day shows exactly what it showed before the delete (the overview's sources).
      d.mbDayStat = await mbDayStat();
      if (JSON.stringify(d.mbDayStat) !== JSON.stringify(d.mbDayStatBefore)) throw new Error(`Mi Band-day night changed: ${JSON.stringify([d.mbDayStatBefore, d.mbDayStat])}`);
      d.last = after.last;
      d.diag = (await healthDiag()).slice(-12);
      d.state = await state();
      if (!Object.values(d.gone).every(Boolean)) throw new Error(`not removed on the next open: ${JSON.stringify(d.gone)}`);
      // Tombstones, not floor rows: a user-grade delete, so every synced device follows.
      if (![['bp', id.bp], ['weight', id.weight], ['miband', id.workout], ['sleep', id.night]].every(([t, x]) => row(after, t, x)?.deleted === true && row(after, t, x).clientTs > 0)) throw new Error('deleted rows are not tombstones');
      if (!Object.values(d.stays).every(Boolean)) throw new Error(`a row that must stay went: ${JSON.stringify(d.stays)}`);
      if (after.last.total !== d.totalBefore) throw new Error(`import count moved: ${d.totalBefore} → ${after.last.total}`);

      await ctx.page.evaluate(() => window.switchTab('bp'));
      await ctx.page.locator(`.wg-bp-reading-row[data-reading-id="${manual.bp}"]`).waitFor();
      if (await ctx.page.locator(`.wg-bp-reading-row[data-reading-id="${id.bp}"]`).count()) throw new Error('deleted BP still rendered');
      await ctx.stableShot('health-deleted-bp');
      await ctx.page.evaluate(() => window.switchTab('weight'));
      await ctx.page.locator(`.wg-weight-history-row[data-weight-id="${id.edited}"]`).waitFor();
      if (await ctx.page.locator(`.wg-weight-history-row[data-weight-id="${id.weight}"]`).count()) throw new Error('deleted weight still rendered');
      await ctx.stableShot('health-deleted-weight');
    }
    await ctx.step('health-deleted-in-health: BP, weight, workout and a night deleted in Health Connect are gone on the next open', deletedInHealth);

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
      await ctx.waitLocalReady(ctx.page);
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
      // readableFrom enables the real one-time Copy offer on this shell. This
      // step tests the live-write switch, not historical copying.
      const copyOffer = ctx.page.locator('.mt-confirm-modal .mt-confirm-modal__cancel');
      await copyOffer.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      if (await copyOffer.isVisible()) await copyOffer.click();
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

    await ctx.step('one mixed entries call returns ordered per-entry results and persists only valid bodies', async () => {
      const prefix = `batch-qa-${Date.now()}`;
      const at = Date.now() - 60_000;
      const entries = [
        { type: 'bp', id: `${prefix}-bp`, version: 17, at, systolic: 119, diastolic: 79 },
        { type: 'hr', id: `${prefix}-bad`, version: 17, at, bpm: 0 },
        { type: 'weight', id: `${prefix}-weight`, version: 17, at, kg: 73.5 },
        { type: 'hr', id: `${prefix}-hr`, version: 17, at, bpm: 65 },
        { type: 'workout', id: `${prefix}-workout`, version: 17, start: at - 60_000, end: at, activity: 50 },
      ];
      r.batch = { entries, result: await native('write', { entries }) };
      if (!Array.isArray(r.batch.result) || r.batch.result.length !== entries.length ||
          r.batch.result[1] !== 'invalid heart rate' || ![0, 2, 3, 4].every((i) => r.batch.result[i] === true)) throw new Error(`batch reply: ${JSON.stringify(r.batch)}`);
      r.batch.records = (await readNative()).filter((row) => row.clientId?.startsWith(prefix));
      if (r.batch.records.length !== 4 || r.batch.records.some((row) => row.clientId === `${prefix}-bad` || row.version !== 17)) throw new Error(`batch persistence: ${JSON.stringify(r.batch.records)}`);
      // Same SDK replay semantics as the legacy path; no native read-before-write.
      await native('write', { entries: entries.filter((_, i) => i !== 1).map((body) => ({ ...body, version: 16 })) });
      const replayed = (await readNative()).filter((row) => row.clientId?.startsWith(prefix));
      if (replayed.length !== 4 || replayed.some((row) => row.version !== 17)) throw new Error('batch replay duplicated or downgraded records');
      for (const body of entries.filter((_, i) => i !== 1)) await native('remove', { type: body.type, id: body.id });
      if ((await readNative()).some((row) => row.clientId?.startsWith(prefix))) throw new Error('batch cleanup left records');
    });

    await ctx.step('revoked write access reports the real partial grant and refuses writes', async () => {
      await shell(`pm revoke ${pkg} android.permission.health.WRITE_BLOOD_PRESSURE`);
      // Android may kill the app on revoke: relaunch from the persisted local-mode state.
      ctx.page = undefined;
      await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity`);
      if (!(await ctx.attachPage())) throw new Error('re-attach after revoke failed');
      await ctx.waitLocalReady(ctx.page);
      r.writeBack.partial = await native('writeAccess', ['bp', 'weight']);
      if (r.writeBack.partial.granted.includes('bp') || !r.writeBack.partial.granted.includes('weight')) throw new Error('partial grant was misreported');
      const denied = await ctx.page.evaluate(async () => {
        try { await window.Health.write({ type: 'bp', id: 'denied-qa', version: 1, at: Date.now(), systolic: 120, diastolic: 80 }); return ''; }
        catch (e) { return String(e.message || e); }
      });
      if (!/denied/.test(denied)) throw new Error(`write was not denied: ${denied}`);
      const at = Date.now() - 60_000;
      r.batch.partial = await native('write', { entries: [
        { type: 'bp', id: 'batch-denied-qa', version: 1, at, systolic: 120, diastolic: 80 },
        { type: 'weight', id: 'batch-allowed-qa', version: 1, at, kg: 74 },
      ] });
      if (r.batch.partial[0] !== 'denied' || r.batch.partial[1] !== true) throw new Error(`partial batch: ${JSON.stringify(r.batch.partial)}`);
      await waitNative('batch-allowed-qa', (rows) => rows.length === 1);
      await native('remove', { type: 'weight', id: 'batch-allowed-qa' });
      await shell(`pm grant ${pkg} android.permission.health.WRITE_BLOOD_PRESSURE`);
    });

    await ctx.step('denied heart-rate access holds pulse only; late grant drains existing pending writes', async () => {
      await shell(`pm revoke ${pkg} android.permission.health.WRITE_HEART_RATE`);
      ctx.page = undefined;
      await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity`);
      if (!(await ctx.attachPage())) throw new Error('re-attach after heart-rate revoke failed');
      await ctx.waitLocalReady(ctx.page);
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
      await ctx.waitLocalReady(ctx.page);
      r.writeBack.pulseLateGrant = await waitNative(`${pending.id}/pulse`, (rows) => rows.length === 1 && rows[0].samples[0].bpm === 70);
      await api(`/api/bp/${encodeURIComponent(pending.id)}`, 'DELETE');
      await waitNative(pending.id, (rows) => rows.length === 0);
      await waitNative(`${pending.id}/pulse`, (rows) => rows.length === 0);
      await api(`/api/weight/${encodeURIComponent(weight.id)}`, 'DELETE');
      await waitNative(weight.id, (rows) => rows.length === 0);
    });

    // bd med-8f4s.11 section 6 / med-8f4s.15 (f): copy 1,010 past entries
    // (700 BP with pulse, 300 weights, plus ~10 left by the steps above) and
    // ~300 completed workouts (3-5 logs each) through the real writer, all
    // inside the rolling 30-day window (no history permission on this image),
    // and record how long the counts (the dedupe read; workouts alone first)
    // and the copy take, how many bridge calls it made (batched: ≈ ids / 50),
    // and whether Health Connect's rate limit paused it. Evidence: never fails
    // the run. Run last of the write steps (below): it spends the write quota.
    async function copyMeasurement() {
      const access = await native('writeAccess', ['bp', 'weight', 'hr', 'workout']);
      if (!Number.isFinite(access.readableFrom)) throw new Error(`measurement needs readableFrom: ${JSON.stringify(access)}`);
      r.copy.readableFrom = access.readableFrom;
      await ctx.page.evaluate(() => localStorage.setItem('wg.health.write', 'false'));
      r.copy.workoutSeedMs = await ctx.page.evaluate(async () => {
        const t = Date.now();
        const ex = await window.apiCall('/api/workout/exercise-library/create', 'POST', { name: `Copy QA bench ${t}`, body_part: 'chest' });
        for (let i = 0; i < 300; i++) {
          const { session } = await window.apiCall('/api/workout/sessions/adhoc', 'POST');
          for (let j = 0; j < 3 + (i % 3); j++) {
            await window.apiCall('/api/workout/sessions/logs/create', 'POST', { session_id: session.id, exercise_id: ex.id,
              exercise_name: ex.name, source: 'library', target_sets: 1, target_reps_min: 5, target_weight_kg: 10 });
          }
          await window.apiCall(`/api/workout/sessions/status?id=${session.id}`, 'PUT', { status: 'completed' });
        }
        return Date.now() - t;
      });
      const settings = async () => {
        // A reload, not a force-stop: a force-stop right after setItem can drop
        // the WebView's not yet flushed localStorage (the switch came back off).
        await ctx.page.evaluate(() => localStorage.setItem('wg.health.write', 'true'));
        await ctx.page.reload({ waitUntil: 'load' });
        await ctx.page.waitForFunction(() => typeof window.switchTab === 'function', null, { timeout: 60_000 });
        await ctx.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await ctx.page.evaluate(() => window.switchTab('settings'));
        const notNow = ctx.page.locator('#notify-permission-sheet [data-notify-choice="not-now"]');
        if (await notNow.isVisible().catch(() => false)) await notNow.click();
        const row = ctx.page.locator('#health-copy-row[data-state="ready"]');
        await row.waitFor({ state: 'visible', timeout: 30_000 });
        await row.scrollIntoViewIfNeeded();
        return row;
      };
      const confirm = ctx.page.locator('.mt-confirm-modal .mt-confirm-modal__confirm');
      // Workouts alone: planCopy's count time for them (copyRows awaits
      // workoutSpan + workoutActivity per session; > 2 s → a follow-up).
      let row = await settings();
      let t0 = Date.now();
      await row.click();
      await confirm.waitFor({ state: 'visible', timeout: 120_000 });
      r.copy.workoutCountMs = Date.now() - t0;
      r.copy.workoutOffer = await ctx.page.locator('.mt-confirm-modal').innerText();
      const cancel = ctx.page.locator('.mt-confirm-modal .mt-confirm-modal__cancel');
      if (await cancel.isVisible()) await cancel.click();
      else await confirm.click();
      await ctx.page.evaluate(() => localStorage.setItem('wg.health.write', 'false'));
      await ctx.page.evaluate(async () => {
        const base = Date.now() - 28 * 864e5;
        for (let i = 0; i < 700; i++) await window.apiCall('/api/bp', 'POST', { systolic: 100 + (i % 40), diastolic: 60 + (i % 9), pulse: 60 + (i % 20), measured_at: new Date(base + i * 50 * 6e4).toISOString(), notes: 'copy QA' });
        for (let i = 0; i < 300; i++) await window.apiCall('/api/weight', 'POST', { weight: 70 + (i % 50) / 10, measured_at: new Date(base + i * 2 * 36e5).toISOString() });
      });
      row = await settings();
      // Count the bridge calls the copy makes (the page's writer reads these
      // methods at call time).
      await ctx.page.evaluate(() => {
        const h = window.Health;
        const write = h.write.bind(h);
        const remove = h.remove.bind(h);
        const c = window.__qaCopyCalls = { write: 0, single: 0, entries: 0, remove: 0 };
        h.write = (a) => {
          c.write++;
          if (a && Array.isArray(a.entries)) c.entries += a.entries.length;
          else c.single++;
          return write(a);
        };
        h.remove = (a) => { c.remove++; return remove(a); };
      });
      t0 = Date.now();
      await row.click();
      await confirm.waitFor({ state: 'visible', timeout: 120_000 });
      r.copy.countMs = Date.now() - t0;
      r.copy.offer = await ctx.page.locator('.mt-confirm-modal').innerText();
      await ctx.stableShot('health-copy-offer');
      const t1 = Date.now();
      await confirm.click();
      r.copy.states = [];
      for (const until = Date.now() + 15 * 60_000; Date.now() < until;) {
        const s = await ctx.page.evaluate(() => {
          const el = document.getElementById('health-copy-row');
          return el ? `${el.dataset.state} ${el.querySelector('.wg-setting__desc')?.textContent || ''}` : 'none';
        }).catch(() => 'detached');
        if (r.copy.states.at(-1) !== s) r.copy.states.push(s);
        if (/^(done|refused)/.test(s)) break;
        await sleep(2000);
      }
      r.copy.copyMs = Date.now() - t1;
      r.copy.paused = r.copy.states.some((s) => s.startsWith('paused'));
      r.copy.ledgerLeft = await ctx.page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('wg.health.dirty') || '{}')).reduce((n, m) => n + Object.keys(m).length, 0));
      r.copy.calls = await ctx.page.evaluate(() => window.__qaCopyCalls);
      r.copy.job = await ctx.page.evaluate(() => {
        const j = JSON.parse(localStorage.getItem('wg.health.backfill') || 'null');
        return j && { total: j.total, failed: j.failed || 0, fails: j.fails || 0 };
      });
      await ctx.stableShot('health-copy-result');
      ctx.log('health-copy', JSON.stringify({ workoutCountMs: r.copy.workoutCountMs, countMs: r.copy.countMs, copyMs: r.copy.copyMs, paused: r.copy.paused,
        calls: r.copy.calls, job: r.copy.job, ledgerLeft: r.copy.ledgerLeft, last: r.copy.states.at(-1) }));
    }

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
      await ctx.waitLocalReady(ctx.page);
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
      await ctx.waitLocalReady(ctx.page);
      r.workouts.lateGrant = await waitSession(pending);
      await removeSession(pending.id);
      await waitNative(r.workouts.lateGrant.clientId, (rows) => rows.length === 0);
      await api(`/api/bp/${encodeURIComponent(reading.id)}`, 'DELETE');
      await api(`/api/weight/${encodeURIComponent(weight.id)}`, 'DELETE');
    });

    await ctx.step('without history permission Copy excludes an older entry and names the cutoff', async () => {
      await ctx.page.evaluate(() => localStorage.setItem('wg.health.write', 'false'));
      const old = await api('/api/bp', 'POST', { systolic: 118, diastolic: 78,
        measured_at: new Date(Date.now() - 31 * 86400_000).toISOString(), notes: 'history cutoff QA' });
      await shell(`pm revoke ${pkg} android.permission.health.READ_HEALTH_DATA_HISTORY`);
      ctx.page = undefined;
      await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity`);
      if (!(await ctx.attachPage())) throw new Error('re-attach after history revoke failed');
      await ctx.waitLocalReady(ctx.page);
      r.window.afterRevoke = await windowAccess(['bp', 'weight', 'hr', 'workout']);
      assertWindow(r.window.afterRevoke);
      await ctx.page.evaluate(() => {
        localStorage.setItem('wg.health.write', 'true');
        document.dispatchEvent(new Event('visibilitychange'));
        window.switchTab('settings');
      });
      const row = ctx.page.locator('#health-copy-row[data-state="ready"]');
      await row.waitFor({ state: 'visible', timeout: 30_000 });
      await row.scrollIntoViewIfNeeded();
      await row.click();
      const modal = ctx.page.locator('.mt-confirm-modal');
      await modal.waitFor({ state: 'visible', timeout: 30_000 });
      r.window.cutoffDialog = await modal.innerText();
      if (!/before .*won't be copied/.test(r.window.cutoffDialog) || !/Allow past data/.test(r.window.cutoffDialog)) throw new Error(`missing cutoff: ${r.window.cutoffDialog}`);
      await ctx.stableShot('health-copy-history-cutoff');
      const cancel = modal.locator('.mt-confirm-modal__cancel');
      if (await cancel.isVisible()) await cancel.click();
      else await modal.locator('.mt-confirm-modal__confirm').click();
      await ctx.page.evaluate(() => localStorage.setItem('wg.health.write', 'false'));
      await api(`/api/bp/${encodeURIComponent(old.id)}`, 'DELETE');
      await shell(`pm grant ${pkg} android.permission.health.READ_HEALTH_DATA_HISTORY`);
      r.window.providerAfterRetry = await sdkAccess();
      r.window.afterRetry = await windowAccess(['bp']);
      assertWindow(r.window.afterRetry, r.window.providerAfterRetry.historyGranted);
      await ctx.page.evaluate(() => localStorage.setItem('wg.health.write', 'true'));
    });

    await ctx.step('copy past entries: 1,010 entries + 300 workouts in batches, timed (measurement)', async () => {
      r.copy = {};
      try {
        await copyMeasurement();
      } catch (e) {
        r.copy.error = String(e?.message || e).split('\n')[0];
        ctx.log('health-copy', JSON.stringify({ error: r.copy.error, states: r.copy.states }));
        await ctx.stableShot('health-copy-error').catch(() => {});
      }
    });

    await ctx.step('Health Connect rationale names the pulse and completed workout copy', async () => {
      await shell(`am start -W -a androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE -n ${pkg}/com.example.medtracker.PermissionsRationaleActivity`);
      await ctx.waitFor({ text: 'Health Connect access' }, 10_000);
      await ctx.stableShot('workout-rationale');
      // A short viewport as well: the longer approved disclosure must remain
      // readable by scrolling, with the privacy link reachable at the bottom.
      await shell('wm size 1080x1600');
      try {
        await sleep(1500);
        await ctx.stableShot('workout-rationale-short');
        await shell('input swipe 540 1400 540 350 500');
        await sleep(500);
        await ctx.stableShot('workout-rationale-short-bottom');
      } finally {
        await shell('wm size reset');
      }
    });
  } finally {
    r.writer = (await shell('logcat -d -s qa-health-write:*')).split('\n').slice(-6);
    r.diag = (await healthDiag()).slice(-20);
    ctx.log('health', JSON.stringify(r, null, 2));
  }
}
