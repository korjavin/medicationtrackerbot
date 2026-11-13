// testscenarios/common/meds-focus-whole-slot.yaml (bd med-88x0.11): five medications all due at
// 08:20 and one dose left pending yesterday; the Timeline focus card holds the whole 08:20 slot
// and one Take takes all five. The fixture goes in through the vault import (core-local's path);
// everything asserted is read off the rendered Timeline, and the Take is a real tap.
const MEDS = ['Amlodipine', 'Metformin', 'Atorvastatin', 'Levothyroxine', 'Omeprazole'];

export default async function medsFocus(ctx) {
  const r = (ctx.results.medsFocus = {});
  await ctx.shell(`pm clear ${ctx.pkg}`);
  // The notification ask after a take is not this scenario's subject (local-smoke's setup).
  await ctx.shell(`pm grant ${ctx.pkg} android.permission.POST_NOTIFICATIONS`);
  const page = await ctx.step('fixture: five meds at 08:20, one dose pending yesterday, clock 08:30', async () => {
    const p = await ctx.launchLocal('today');
    // The 23:00 seed boot sets the ledger cut after 08:20, so no 08:20 dose could be generated
    // today. As core-local does: wipe the origin, boot fresh at 07:00 (the cut), then move to 08:30.
    await p.goto(`${ctx.LOCAL_ORIGIN}/qa/scenes.json`, { waitUntil: 'load' });
    await p.evaluate(async () => {
      localStorage.clear(); sessionStorage.clear();
      const dbs = await indexedDB.databases();
      await Promise.all(dbs.map((d) => new Promise((resolve, reject) => {
        const q = indexedDB.deleteDatabase(d.name);
        q.onsuccess = resolve; q.onerror = () => reject(q.error); q.onblocked = () => reject(new Error(`delete ${d.name} blocked`));
      })));
    });
    await p.goto(`${ctx.LOCAL_ORIGIN}/?qa=today&clock=07:00`, { waitUntil: 'load' });
    await ctx.waitLocalReady(p, 'today');
    // Only these medications exist: the golden ones (and their pile-up of pending doses) go, so
    // "+N more pending" can only count the planted yesterday dose. The yesterday dose is a stored
    // PENDING intake: generation starts at the cut, so the vault is the only way to plant it.
    r.fixture = await p.evaluate(async (names) => {
      window.localStorage.setItem('wg.notifyPermission.asked', '1');
      const vault = JSON.parse(await window.CloudVault.exportAll({ includeSecrets: false }));
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      vault.data.tz = { current: timezone, history: [], transition_plans: [], transitions: [] };
      vault.data.settings.timezone = timezone;
      const iso = (d) => d.toISOString().replace('.000Z', 'Z');
      const created = new Date(); created.setDate(created.getDate() - 3); created.setHours(6, 0, 0, 0);
      const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); yesterday.setHours(8, 20, 0, 0);
      const items = names.map((name, i) => ({
        id: 101 + i, name, dosage: '5 mg', schedule: JSON.stringify({ type: 'daily', times: ['08:20'] }),
        archived: false, supplement: false, start_date: null, end_date: null, tz_shift_policy: 'flexible', created_at: iso(created),
      }));
      const intakes = [{ medication_id: 101, scheduled_at: iso(yesterday), taken_at: null, status: 'PENDING',
        snoozed_until: null, source: 'schedule', tz: timezone }];
      vault.data.medications = { items, intakes, restocks: [], schedules: [], stock: [] };
      await window.CloudVault.importAll(JSON.stringify(vault));
      const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return { timezone, ids: items.map((m) => String(m.id)), yesterday: ymd(yesterday), scheduledAt: intakes[0].scheduled_at };
    }, MEDS);
    await p.goto(`${ctx.LOCAL_ORIGIN}/?qa=today&clock=08:30`, { waitUntil: 'load' });
    await ctx.waitLocalReady(p, 'today');
    r.clock = await p.evaluate(async () => ({ now: new Date().toString(), pinned: !!Date.wgQAPinned,
      cut: (await (await import('/js/sync.js')).localRecordsPort().list('ledgercut')).map((c) => c.at),
      due: (await window.apiCall('/api/doses?status=due,snoozed')).map((d) => `${d.medId} ${d.localDate} ${d.localTime}`) }));
    if (!r.clock.pinned || r.clock.cut.length !== 1 || !r.clock.now.includes('08:3')) throw new Error(`invalid 08:30 setup: ${JSON.stringify(r.clock)}`);
    return p;
  });
  const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  const ids = r.fixture.ids;
  const focusRow = page.locator('#med-timeline-list .wg-tl-focus .wg-timeline__row[data-state="due"]');

  await ctx.step('Meds → Timeline: one 08:20 row naming all five, Skip + Take 5, +1 more pending', async () => {
    await page.evaluate(() => window.switchTab('meds'));
    await page.locator('.med-tab[data-tab="timeline"]').click();
    await focusRow.first().waitFor({ timeout: 20_000 });
    const timeline = () => page.evaluate((ids) => {
      const list = document.getElementById('med-timeline-list');
      const card = list.querySelector('.wg-tl-focus');
      const rows = [...card.querySelectorAll('.wg-timeline__row[data-state="due"]')];
      const t = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
      return {
        rows: rows.map((row) => ({ date: row.dataset.localDate, medIds: row.dataset.medIds.split(' ').sort(),
          title: t(row.querySelector('.wg-row__title')), meta: t(row.querySelector('.wg-row__meta')),
          take: t(row.querySelector('.wg-btn--primary')), skip: t(row.querySelector('.wg-btn--ghost')) })),
        more: t(card.querySelector('.wg-tl-focus__label .wg-meta')),
        // Today's other rows (Pending / Done) outside the card that carry one of the five.
        repeated: [...list.querySelectorAll('.wg-timeline__today .wg-timeline__row')]
          .filter((row) => !row.closest('.wg-tl-focus') && row.dataset.medIds.split(' ').some((id) => ids.includes(id)))
          .map((row) => `${row.dataset.state} ${t(row)}`),
      };
    }, ids);
    const s = (r.before = await timeline());
    const [row] = s.rows;
    if (s.rows.length !== 1 || row.date !== today || row.title !== '08:20' || row.medIds.join() !== [...ids].sort().join()) throw new Error(`focus card is not one 08:20 row of the five: ${JSON.stringify(s)}`);
    const missing = MEDS.filter((n) => !row.meta.includes(n));
    if (missing.length) throw new Error(`focus row does not name ${missing}: ${row.meta}`);
    if (row.take !== 'Take 5' || row.skip !== 'Skip') throw new Error(`focus row buttons: ${JSON.stringify(row)}`);
    if (s.more !== '+1 more pending') throw new Error(`expected "+1 more pending" (yesterday's dose), got ${JSON.stringify(s.more)}`);
    if (s.repeated.length) throw new Error(`the five repeat under Today: ${s.repeated}`);
    // The +1 is yesterday's planted dose, listed on its own day.
    r.yesterdayHead = (await page.locator(`#med-timeline-list section[data-local-date="${r.fixture.yesterday}"] .wg-section__head .wg-meta`).first().textContent()).trim();
    if (r.yesterdayHead !== '1 pending') throw new Error(`yesterday says ${JSON.stringify(r.yesterdayHead)}, not "1 pending"`);
    await ctx.stableShot('focus-take-5');
  });

  await ctx.step('Take 5 takes all five at once', async () => {
    await focusRow.first().locator('.wg-btn--primary').click();
    await page.waitForFunction(({ ids, today }) => {
      const taken = [...document.querySelectorAll(`#med-timeline-list .wg-timeline__row[data-state="taken"][data-local-date="${today}"]`)]
        .flatMap((row) => row.dataset.medIds.split(' '));
      return ids.every((id) => taken.includes(id));
    }, { ids, today }, { timeout: 10_000 });
    // The store, not just the optimistic paint: none of today's five stays open once the write lands.
    for (let i = 0; ; i++) {
      r.after = await page.evaluate(async ({ ids, today }) => ({
        takenRows: [...document.querySelectorAll(`#med-timeline-list .wg-timeline__row[data-state="taken"][data-local-date="${today}"]`)]
          .map((row) => row.textContent.replace(/\s+/g, ' ').trim()),
        stillDue: (await window.apiCall('/api/doses?status=due,snoozed'))
          .filter((d) => ids.includes(String(d.medId)) && d.localDate === today).map((d) => `${d.medId} ${d.localTime}`),
      }), { ids, today });
      if (!r.after.stillDue.length) break;
      if (i === 20) throw new Error(`still due after Take 5: ${r.after.stillDue}`);
      await ctx.sleep(500);
    }
    await ctx.stableShot('after-take-5');
  });
}
