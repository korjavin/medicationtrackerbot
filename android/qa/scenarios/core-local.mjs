// B1: real Android editor/IME/Back plus the shipped optimistic writes and durable ledger.
// Fixture setup uses the existing golden-vault driver; all behavior under test goes through UI.
export default async function coreLocal(ctx) {
  const r = (ctx.results.coreLocal = { schedules: {} });
  await ctx.shell(`pm clear ${ctx.pkg}`);
  // Notification permission is not this scenario's subject; use local-smoke's established setup
  // so a write-triggered reminder offer cannot cover the editors being exercised.
  await ctx.shell(`pm grant ${ctx.pkg} android.permission.POST_NOTIFICATIONS`);
  await ctx.shell(`appops set ${ctx.pkg} SCHEDULE_EXACT_ALARM allow`);
  let page = await ctx.step('golden local vault; prepare existing schedules at 07:00', async () => {
    const p = await ctx.launchLocal('today');
    r.initialCut = await p.evaluate(async () => (await import('/js/sync.js')).localRecordsPort().list('ledgercut'));
    // The initial 23:00 visual boot already established a put-if-absent ledger cut. A clock
    // jump backwards cannot generate new doses before it. Reuse local-smoke's neutral-page
    // fresh-origin setup so the FIRST seeded ledger is initialized at the required 07:00.
    await p.goto(`${ctx.LOCAL_ORIGIN}/qa/scenes.json`, { waitUntil: 'load' });
    r.wiped = await p.evaluate(async () => {
      localStorage.clear(); sessionStorage.clear();
      const dbs = await indexedDB.databases();
      await Promise.all(dbs.map((d) => new Promise((resolve, reject) => {
        const q = indexedDB.deleteDatabase(d.name);
        q.onsuccess = resolve; q.onerror = () => reject(q.error); q.onblocked = () => reject(new Error(`delete ${d.name} blocked`));
      })));
      return dbs.map((d) => d.name);
    });
    await p.goto(`${ctx.LOCAL_ORIGIN}/?qa=today&clock=07:00`, { waitUntil: 'load' });
    await ctx.waitLocalReady(p, 'today');
    r.setupClock = await p.evaluate(async () => ({ now: new Date().toISOString(), pinned: !!Date.wgQAPinned,
      cut: await (await import('/js/sync.js')).localRecordsPort().list('ledgercut') }));
    if (!r.setupClock.pinned || r.setupClock.cut.length !== 1 || Date.parse(r.setupClock.cut[0].at) > Date.parse(r.setupClock.now)) throw new Error(`invalid morning ledger setup: ${JSON.stringify(r.setupClock)}`);
    // Keep the golden records, but remove competing due medications from this focused flow.
    await p.evaluate(async () => {
      for (const m of await window.apiCall('/api/medications')) {
        await window.apiCall(`/api/medications/${m.id}`, 'POST', { ...m, archived: true });
      }
      await window.DataStore.invalidateTags(['medications', 'history']);
    });
    return p;
  });
  const go = async (tab) => {
    await page.evaluate((t) => window.switchTab(t), tab);
    await page.locator(`#${tab}-view`).waitFor({ state: 'visible', timeout: 20_000 });
  };
  const backSheet = async (id) => {
    await ctx.waitFor({ clazz: 'android.webkit.WebView' }, 30_000);
    for (let i = 0; i < 2; i++) {
      await ctx.shell('input keyevent KEYCODE_BACK');
      await ctx.sleep(1000);
      if (!(await ctx.inForeground())) throw new Error(`Back left app with ${id} open`);
      if (!(await page.evaluate((x) => window.ModalManager._isVisible(x), id))) return;
    }
    throw new Error(`${id} did not close with native Back`);
  };
  const editor = async (name, times, id) => {
    await go('meds');
    await page.locator('.med-tab[data-tab="schedule"]').click();
    if (id) await page.locator(`[data-med-id="${id}"]`).first().click();
    else await page.evaluate(() => window.showAddModal());
    await page.locator('#med-modal').waitFor({ state: 'visible' });
    if (!id) {
      await ctx.waitFor({ clazz: 'android.webkit.WebView' }, 30_000);
      // The software-GPU emulator paints behind the DOM. Match the established BP keyboard
      // flow's settle before converting a moving editor rect to physical screen coordinates.
      await ctx.sleep(2500);
      await page.locator('#med-name').scrollIntoViewIfNeeded();
      await ctx.tapElement(page, '#med-name');
      for (let n = 0; n < 20 && !(await ctx.imeShown()); n++) await ctx.sleep(500);
      const input = { name, ime: await ctx.imeShown(), focused: await page.evaluate(() => document.activeElement?.id) };
      (r.editorInputs ||= []).push(input);
      if (!input.ime || input.focused !== 'med-name') throw new Error(`medication name tap did not focus input/open IME: ${JSON.stringify(input)}`);
      await ctx.sleep(1000);
      await ctx.shell(`input text '${name.replaceAll(' ', '%s')}'`);
      input.value = await page.inputValue('#med-name');
      if (input.value !== name) throw new Error('native medication name entry differs');
      await ctx.shot(`editor-keyboard-${name.replaceAll(' ', '-').toLowerCase()}`);
      await ctx.shell('input keyevent KEYCODE_BACK');
      await page.fill('#med-dosage', '5mg');
    }
    await page.locator('[data-schedule-type="daily"]').click();
    while (await page.locator('.med-time-input').count() < times.length) await page.click('#add-time-btn');
    for (let i = 0; i < times.length; i++) await page.locator('.med-time-input').nth(i).fill(times[i]);
    await page.click('#med-modal-save-btn');
    await page.locator('#med-modal').waitFor({ state: 'hidden' });
    const meds = await page.evaluate(() => window.apiCall('/api/medications'));
    const med = meds.find((m) => m.name === name);
    if (!med || JSON.parse(med.schedule).times.join() !== times.join()) throw new Error(`schedule not saved: ${name}`);
    (r.savedMeds ||= {})[name] = { id: med.id, schedule: med.schedule, archived: med.archived, createdAt: med.created_at };
    return med;
  };
  const timeline = async (med) => {
    await go('meds');
    await page.locator('.med-tab[data-tab="timeline"]').click();
    await page.locator(`#med-timeline-list [data-med-ids~="${med.id}"]`).first().waitFor({ timeout: 20_000 });
    return page.locator(`#med-timeline-list [data-med-ids~="${med.id}"]`);
  };
  // A medication created after 08:00 correctly has no earlier 08:00 dose. Establish the
  // YAML's existing-medication precondition before its first slot, then advance the QA clock.
  const scheduleMeds = {};
  for (const taken of [true, false]) {
    scheduleMeds[taken] = await ctx.step(`schedule ${taken}: existing 08:00 and 20:00 medication`, () =>
      editor(`QA B1 Schedule ${taken ? 'Taken' : 'Untaken'}`, ['08:00', '20:00']));
  }
  const dose = await ctx.step('dose: add daily medication through editor and native keyboard', () => editor('QA B1 Dose', ['09:59']));
  await page.goto(`${ctx.LOCAL_ORIGIN}/?qa=today&clock=10:00`, { waitUntil: 'load' });
  await ctx.waitLocalReady(page, 'today');
  await ctx.step('dose: Today Take removes Next up immediately', async () => {
    await go('today');
    r.todayBeforeTake = await page.evaluate(() => ({ now: new Date().toISOString(), nextUp: document.querySelector('[data-section="next-up"]')?.textContent }));
    const row = page.locator('[data-section="next-up"] .wg-row').filter({ hasText: dose.name });
    await row.getByRole('button', { name: 'Take', exact: true }).click();
    r.takenClock = await page.evaluate(() => { const d = new Date(); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; });
    await page.locator('#med-confirm-action-btn').click();
    await page.waitForFunction((name) => ![...document.querySelectorAll('[data-section="next-up"] .wg-row')]
      .some((el) => el.textContent.includes(name)), dose.name, { timeout: 5000 });
    r.doseRemovedWithoutReload = true;
  });
  const assertTaken = async () => {
    const rows = await timeline(dose);
    const text = await rows.allTextContents();
    if (!text.some((x) => x.includes(`Taken ${r.takenClock}`))) throw new Error(`Timeline lacks Taken ${r.takenClock}: ${text}`);
    r.takenText = text;
  };
  await ctx.step('dose: Timeline Taken HH:MM survives reload', async () => {
    await assertTaken();
    await ctx.shot('dose-taken');
    await page.reload({ waitUntil: 'load' });
    await ctx.waitLocalReady(page, 'today');
    await assertTaken();
    r.doseDurable = true;
  });
  await ctx.step('editor: native Back closes sheet and app remains open', async () => {
    await go('meds');
    await page.locator('.med-tab[data-tab="schedule"]').click();
    await page.locator(`[data-med-id="${dose.id}"]`).first().click();
    await backSheet('med-modal');
  });
  await ctx.step('meal: save known kcal and immediately assert Food and Today totals', async () => {
    await go('food');
    await page.locator('#food-list').getByText('Greek yogurt', { exact: true }).waitFor();
    await page.locator('#food-macros-card-kcal').waitFor();
    const before = Number(await page.locator('#food-macros-card-kcal').textContent());
    await page.evaluate(() => window.showAddFoodModal());
    await page.click('#food-add-manual-btn');
    await page.locator('#food-modal').waitFor({ state: 'visible' });
    await backSheet('food-modal');
    // openManual closes its parent Add sheet before opening the manual form.
    if (await page.locator('#food-add-sheet').isVisible()) throw new Error('manual close left Add sheet open');
    await page.evaluate(() => window.showAddFoodModal());
    await page.click('#food-add-manual-btn');
    await page.fill('#food-name', 'QA B1 Meal');
    await page.fill('#food-weight', '100');
    await page.locator('[data-per100g="false"]').click();
    await page.fill('#food-calories', '321');
    await page.click('#food-modal-save-btn');
    await page.waitForFunction((n) => Number(document.getElementById('food-macros-card-kcal')?.textContent) === n, before + 321, { timeout: 10_000 });
    await page.locator('#food-list').getByText('QA B1 Meal', { exact: true }).waitFor();
    await ctx.shot('meal-food-total');
    await go('today');
    await page.waitForFunction((n) => Number(document.querySelector('[data-section="fuel"] .wg-stat__value')?.textContent) === n, before + 321, { timeout: 10_000 });
    r.meal = { before, added: 321, foodAndToday: before + 321 };
    await ctx.shot('meal-today-total');
  });
  for (const taken of [true, false]) {
    const name = `QA B1 Schedule ${taken ? 'Taken' : 'Untaken'}`;
    const med = scheduleMeds[taken];
    if (taken) await ctx.step('schedule: take the 08:00 row through Timeline', async () => {
      const rows = await timeline(med);
      // A grouped row's direct Take acts on BOTH slot-mates. Open its sheet and explicitly
      // deselect the Untaken branch, preserving the YAML's distinct morning preconditions.
      await rows.filter({ hasText: '08:00' }).first().locator('.wg-row__body').click();
      await page.locator('#med-confirm-modal').waitFor({ state: 'visible' });
      await page.locator('.med-confirm-check').filter({ hasText: scheduleMeds[false].name }).click();
      const chosen = page.locator('.med-confirm-check[aria-pressed="true"]');
      if (await chosen.count() !== 1 || !(await chosen.innerText()).includes(med.name)) throw new Error('wrong grouped dose selection');
      await ctx.shot('schedule-take-only-selected-med');
      await page.click('#med-confirm-action-btn');
      await page.locator(`#med-timeline-list [data-med-ids~="${med.id}"][data-state="taken"]`).first().waitFor();
      await page.locator(`#med-timeline-list [data-med-ids~="${scheduleMeds[false].id}"][data-state="due"]`).first().waitFor();
      r.untakenBranchStillDue = true;
    });
    await ctx.step(`schedule ${taken}: editor changes to 09:00/21:00; Timeline keeps correct slots`, async () => {
      await editor(name, ['09:00', '21:00'], med.id);
      const rows = await timeline(med);
      const text = (await rows.allTextContents()).join('\n');
      // Scope to today; the same medication legitimately has 09:00 rows on future days.
      const today = await page.evaluate(() => {
        const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      });
      // med-5y49 folds today's non-focus upcoming groups. Expand the real UI before
      // asserting the per-dose identifiers; never confuse a folded summary with missing data.
      const later = page.locator('#med-timeline-list .wg-timeline__later .wg-tl-day[aria-expanded="false"]');
      if (await later.count()) await later.click();
      const dayRows = page.locator(`#med-timeline-list [data-med-ids~="${med.id}"][data-local-date="${today}"]`);
      const dayText = (await dayRows.allTextContents()).join('\n');
      if (!/21:00/.test(dayText) || /20:00/.test(dayText)) throw new Error(`evening pairing: ${dayText} (all: ${text})`);
      if (taken ? !/08:00/.test(dayText) || !/Taken 10:\d\d/.test(dayText) || /09:00/.test(dayText)
        : !/09:00/.test(dayText) || /08:00/.test(dayText)) throw new Error(`morning pairing taken=${taken}: ${dayText}`);
      r.schedules[taken ? 'taken' : 'untaken'] = dayText;
      await ctx.shot(`schedule-${taken ? 'taken' : 'untaken'}`);
    });
  }
}
