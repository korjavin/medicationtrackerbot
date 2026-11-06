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
    await p.goto(`${ctx.LOCAL_ORIGIN}/?qa=today&clock=07:00`, { waitUntil: 'load' });
    await ctx.waitLocalReady(p, 'today');
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
  await page.goto(`${ctx.LOCAL_ORIGIN}/?qa=today&clock=10:00`, { waitUntil: 'load' });
  await ctx.waitLocalReady(page, 'today');
  const doseTime = await page.evaluate(() => {
    const d = new Date(Date.now() + 120000); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  });
  const dose = await ctx.step('dose: add daily medication through editor and native keyboard', () => editor('QA B1 Dose', [doseTime]));
  await ctx.step('dose: Today Take removes Next up immediately', async () => {
    await go('today');
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
      // Timeline's row Take acts immediately (_tlAct); unlike Today's Take it has no sheet.
      await rows.filter({ hasText: '08:00' }).getByRole('button', { name: 'Take', exact: true }).first().click();
      await page.locator(`#med-timeline-list [data-med-ids~="${med.id}"][data-state="taken"]`).first().waitFor();
    });
    await ctx.step(`schedule ${taken}: editor changes to 09:00/21:00; Timeline keeps correct slots`, async () => {
      await editor(name, ['09:00', '21:00'], med.id);
      const rows = await timeline(med);
      const text = (await rows.allTextContents()).join('\n');
      // Scope to today; the same medication legitimately has 09:00 rows on future days.
      const today = await page.evaluate(() => {
        const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      });
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
