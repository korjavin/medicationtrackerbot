// Pull to refresh in the WebView (bd med-y7b4.8; the web gesture is bd med-y7b4.6,
// web/static/js/features/app-refresh.js). MainActivity sets OVER_SCROLL_NEVER and there is no
// SwipeRefreshLayout, so the page's own passive touch listeners must see the whole drag: a real
// finger (input motionevent DOWN / MOVE… / UP) at the top of the page.
// Local mode: Today has nothing to pull (no gesture, no pill); Health with the Health Connect import
// on shows "Release to check Health Connect", then "Checking Health Connect…", and the shell logs a
// health read. Account mode (the run's invite): Today shows "Release to sync" / "Syncing…" and the
// page requests /api/sync/. A touchcancel or no touchmove means the WebView swallowed the gesture.
// results.pullRefresh: pull states and touch counts, plus the held workout, foreground,
// encrypted peer, Health and post-close observations.
import { claimAccount } from './smoke.mjs';
import { READS } from './health-connect.mjs';

export const retry = false; // the account half claims the run's one invite

export default async function pullRefresh(ctx) {
  const { shell, pkg, sleep, device } = ctx;
  const r = (ctx.results.pullRefresh = {});
  let page;

  const healthReads = async () => (await shell(`run-as ${pkg} cat shared_prefs/diag.xml`))
    .split(/&#10;|\n/).filter((l) => / health \S+ \S+ read=/.test(l)); // timestamped lines: a set diff survives the log cap
  const go = async (t) => {
    await page.evaluate((x) => { window.switchTab(x); window.scrollTo(0, 0); }, t);
    await page.waitForFunction((id) => !!document.getElementById(id)?.offsetParent, `${t}-view`, { timeout: 15_000 });
    await sleep(1500);
  };
  // Records every pill state, the touch events the page gets and the toasts it raises.
  const arm = () => page.evaluate(() => {
    const rec = (window.__qaPtr = { pill: [], touch: {}, toasts: [] });
    if (!window.__qaPtrHooked) {
      window.__qaPtrHooked = true;
      for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
        document.addEventListener(t, () => { window.__qaPtr.touch[t] = (window.__qaPtr.touch[t] || 0) + 1; }, { passive: true, capture: true });
      }
      const toast = window.safeToast;
      window.safeToast = (m, type) => { window.__qaPtr.toasts.push([m, type]); return toast(m, type); };
      let last = '';
      // A mutation observer, not a poll: a fast sync paints and drops the busy pill within ms.
      new MutationObserver(() => {
        const p = document.querySelector('.wg-ptr');
        const s = p ? `${p.className}|${p.textContent}` : '';
        if (s !== last) { window.__qaPtr.pill.push(s); last = s; }
      }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'], characterData: true });
    }
    return !!rec;
  });
  const record = () => page.evaluate(() => ({ ...window.__qaPtr, scrollY }));
  // A finger from 30% of the WebView down by 500 device px, held for a screenshot, then lifted.
  const pull = async (label) => {
    await arm();
    const { bounds } = await device.info({ clazz: 'android.webkit.WebView' });
    const x = Math.round(bounds.x + bounds.width / 2);
    const y = Math.round(bounds.y + bounds.height * 0.3);
    await shell(`input motionevent DOWN ${x} ${y}`);
    for (let i = 1; i <= 10; i++) await shell(`input motionevent MOVE ${x} ${y + i * 50}`);
    await ctx.shot(`${label}-pulling`);
    await shell(`input motionevent UP ${x} ${y + 500}`);
    await ctx.shot(`${label}-released`);
    const end = Date.now() + 25_000; // the import's own timeout is 20 s
    while (Date.now() < end && (await page.evaluate(() => !!document.querySelector('.wg-ptr')))) await sleep(250);
    await sleep(500);
    const got = (r[label] = await record());
    if (await page.evaluate(() => !!document.querySelector('.wg-ptr'))) throw new Error(`the refresh never finished: ${JSON.stringify(got.pill)}`);
    if (!got.touch.touchmove) throw new Error(`no touchmove reached the page: ${JSON.stringify(got.touch)}`);
    if (got.touch.touchcancel) throw new Error(`the WebView cancelled the touch: ${JSON.stringify(got.touch)}`);
    const bad = got.toasts.find(([, t]) => t === 'error');
    if (bad) throw new Error(`error toast: ${bad[0]}`);
    return got;
  };
  const expectPill = (got, ...want) => {
    for (const w of want) if (!got.pill.some((s) => s.includes(w))) throw new Error(`no pill "${w}": ${JSON.stringify(got.pill)}`);
  };
  const networkBanner = async (local) => {
    const label = local ? 'local' : 'account';
    const state = () => page.evaluate(() => {
      const visible = (id) => {
        const el = document.getElementById(id);
        return !!el?.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
      };
      return { online: navigator.onLine, banner: visible('offline-banner') };
    });
    const expect = async (online) => {
      await page.waitForFunction((want) => navigator.onLine === want, online, { timeout: 30_000 });
      await page.waitForFunction((want) => {
        const banner = document.getElementById('offline-banner');
        return !!banner?.getClientRects().length === want;
      }, !local && !online, { timeout: 15_000 });
      return state();
    };
    await ctx.step(`${label}: real radios off/on track the offline banner`, async () => {
      const states = (r[`${label}Network`] = {});
      states.before = await expect(true);
      try {
        await shell('svc wifi disable');
        await shell('svc data disable');
        states.offline = await expect(false);
        await ctx.stableShot(`${label}-offline-banner`);
      } finally {
        await shell('svc wifi enable');
        await shell('svc data enable');
      }
      states.online = await expect(true);
      await ctx.stableShot(`${label}-online-banner`);
    });
  };

  await shell(`pm clear ${pkg}`);
  for (const p of READS) await shell(`pm grant ${pkg} android.permission.health.READ_${p}`);

  page = await ctx.step('launch: local mode on Today', () => ctx.launchLocal('today'));
  await sleep(2000);

  await ctx.step('local Today: a pull shows no pill (nothing to sync)', async () => {
    await go('today');
    const got = await pull('local-today');
    if (got.pill.some(Boolean)) throw new Error(`pill in local mode: ${JSON.stringify(got.pill)}`);
  });
  await networkBanner(true);

  await ctx.step('Settings: switch the Health Connect import on', async () => {
    await page.locator('[data-nav-to="settings"]:visible').first().click();
    await page.locator('#health-import-toggle').waitFor({ state: 'attached', timeout: 15_000 });
    await page.evaluate(() => document.getElementById('health-import-toggle').click());
    await page.waitForFunction(() => localStorage.getItem('wg.health.enabled') === 'true', null, { timeout: 15_000 });
    await sleep(10_000); // the switch-on scan settles before the pull
  });

  await ctx.step('local Health: pull → Release / Checking Health Connect → a Health Connect read', async () => {
    await go('health');
    const before = new Set(await healthReads());
    const got = await pull('local-health');
    expectPill(got, 'wg-ptr--ready|Release to check Health Connect', 'wg-ptr--busy|Checking Health Connect');
    got.healthReads = (await healthReads()).filter((l) => !before.has(l));
    if (!got.healthReads.length) throw new Error('the pull ran no Health Connect read');
  });
  await ctx.stableShot('local-health-after');

  page = await ctx.step('account: invite opens the signup wizard', () => ctx.openClaim({ softAuthn: true }));
  await claimAccount(ctx, page);
  await ctx.step('account Today: pull → Release to sync / Syncing… → a sync request', async () => {
    await go('today');
    const urls = [];
    const onReq = (q) => { if (q.url().includes('/api/sync/')) urls.push(q.url().replace(/^https?:\/\/[^/]+/, '')); };
    page.on('request', onReq);
    try {
      const got = await pull('account-today');
      expectPill(got, 'wg-ptr--ready|Release to sync', 'wg-ptr--busy|Syncing');
      got.syncRequests = urls;
      if (!urls.length) throw new Error('the pull made no /api/sync/ request');
    } finally {
      page.off('request', onReq);
    }
  });
  await ctx.stableShot('account-today-after');
  await networkBanner(false);

  // med-sz4k.4.4.4: use the real account, SDK writer and encrypted sync
  // protocol. The native Home return is observed separately from the explicit
  // visibility stimulus (med-jyxy); it is not evidence of native delivery.
  await ctx.step('account: enable Health and open a workout on the BP tab', async () => {
    await shell(`pm grant ${pkg} android.permission.health.WRITE_BLOOD_PRESSURE`);
    await page.locator('[data-nav-to="settings"]:visible').first().click();
    await page.locator('#health-import-toggle').waitFor({ state: 'attached', timeout: 15_000 });
    await page.evaluate(() => document.getElementById('health-import-toggle').click());
    await page.waitForFunction(() => localStorage.getItem('wg.health.enabled') === 'true', null, { timeout: 20_000 });
    await sleep(10_000);
    await go('bp');
    r.session = await page.evaluate(async () => {
      const ex = await window.apiCall('/api/workout/exercise-library/create', 'POST', { name: 'QA refresh bench', body_part: 'chest' });
      const { session } = await window.apiCall('/api/workout/sessions/adhoc', 'POST');
      await window.apiCall('/api/workout/sessions/logs/create', 'POST', { session_id: session.id, exercise_id: ex.id, sets: [{ reps: 5, weight: 20 }] });
      await window.WorkoutSessions.open(session.id);
      const sync = await import('/js/sync.js');
      if (!await sync.flushConfirmed(window.MedTrackerCloud.ctx)) throw new Error('workout did not sync');
      return session.id;
    });
    await page.locator('#workout-session-modal .wg-workouts-session-exercise__field--notes input').waitFor({ state: 'visible', timeout: 20_000 });
  });

  await ctx.step('open session: Home, Health write, peer BP, radio cycle and held refresh', async () => {
    const note = page.locator('#workout-session-modal .wg-workouts-session-exercise__field--notes input');
    await note.fill('Before Home');
    await page.evaluate(() => {
      const input = document.querySelector('#workout-session-modal .wg-workouts-session-exercise__field--notes input');
      window.__qaHeld = { input, exercise: input.closest('.wg-workouts-session-exercise'), modal: document.getElementById('workout-session-modal'), bpList: document.getElementById('bp-list').innerHTML, toasts: [], banners: [], changes: [] };
      const original = window.safeToast;
      window.safeToast = (...args) => { window.__qaHeld.toasts.push(args); return original(...args); };
      new MutationObserver((changes) => {
        for (const m of changes) for (const n of m.removedNodes) {
          if (n === input || (n.contains && n.contains(input))) window.__qaHeld.changes.push('input removed');
        }
      }).observe(document.getElementById('workout-session-modal'), { childList: true, subtree: true });
      new MutationObserver(() => {
        for (const el of document.querySelectorAll('#app-banners > :not(#offline-banner)')) {
          if (el.getClientRects().length && !el.classList.contains('hidden')) window.__qaHeld.banners.push(el.innerText);
        }
      }).observe(document.getElementById('app-banners'), { subtree: true, childList: true, attributes: true, characterData: true });
    });
    r.visibility = { before: await page.evaluate(() => document.visibilityState) };
    await shell('input keyevent KEYCODE_HOME');
    await sleep(3000);
    r.visibility.away = await page.evaluate(() => document.visibilityState);
    await shell(`am start -W -n ${pkg}/com.example.medtracker.QaHealthWrite --ei sys 171 --ei dia 99`);
    await page.waitForFunction(() => document.visibilityState === 'visible', null, { timeout: 20_000 });
    const end = Date.now() + 20_000;
    let writer = '';
    do {
      writer = await shell('logcat -d -s qa-health-write:*');
      if (writer.includes('171.0/99.0') || /qa-health-write.*failed/i.test(writer)) break;
      await sleep(1000);
    } while (Date.now() < end);
    if (!writer.includes('171.0/99.0') || /qa-health-write.*failed/i.test(writer)) throw new Error('Health writer did not confirm the BP');
    await sleep(3000);
    if (!(await ctx.inForeground())) throw new Error('app did not return to foreground after Health writer');
    r.visibility.returned = await page.evaluate(() => document.visibilityState);
    r.peer = await page.evaluate(async () => {
      const sync = await import('/js/sync.js');
      const crypto = await import('/js/crypto.js');
      const ctx = window.MedTrackerCloud.ctx;
      if (!await sync.flushConfirmed(ctx)) throw new Error('pending writes before peer fixture');
      const { seq, pending } = await sync.recordsPort(ctx).horizonBasis();
      if (pending || !Number.isInteger(seq)) throw new Error('peer fixture needs a synced cursor');
      const recordId = 'bp_qa_peer_refresh';
      const record = { recordId, clientTs: Date.now(), deleted: false, measured_at: new Date().toISOString(), systolic: 168, diastolic: 97, pulse: null, site: '', position: '', category: 'High BP Stage 2', ignore_calc: false, notes: '', tag: '' };
      const enc = await crypto.encryptRecord({ kData: ctx.kData, accountId: ctx.accountId, recordType: 'bp', recordId, seq: seq + 1, plaintext: new TextEncoder().encode(JSON.stringify(record)) });
      const res = await fetch('/api/sync/ops', { method: 'POST', headers: sync.WRITE_HEADERS, body: JSON.stringify({ ops: [{ record_type_tag: `bp:${recordId}`, nonce: crypto.toBase64(enc.nonce), ct: crypto.toBase64(enc.ct) }] }) });
      if (!res.ok) throw new Error(`peer BP write HTTP ${res.status}`);
      const assigned = (await res.json()).assigned?.[0];
      if (assigned !== seq + 1) throw new Error('peer BP sequence raced');
      return { recordId, assigned };
    });
    // Continue typing after the other device's write, while the session is open.
    await note.fill('Typing stays here');
    try {
      await shell('svc wifi disable');
      await shell('svc data disable');
      await page.waitForFunction(() => !navigator.onLine, null, { timeout: 30_000 });
    } finally {
      await shell('svc wifi enable');
      await shell('svc data enable');
    }
    await page.waitForFunction(() => navigator.onLine, null, { timeout: 30_000 });
    // Exercise the existing foreground listeners explicitly because native
    // Home/return visibility delivery is the separately tracked med-jyxy gap.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const arrivedBy = Date.now() + 45_000;
    r.arrived = false;
    while (Date.now() < arrivedBy) {
      r.arrived = await page.evaluate(async () => {
        const rows = await window.apiCall('/api/bp?days=2');
        return Array.isArray(rows) && rows.some((x) => x.systolic === 168 && x.diastolic === 97) && rows.some((x) => x.systolic === 171 && x.diastolic === 99);
      });
      if (r.arrived) break;
      await sleep(500);
    }
    if (!r.arrived) throw new Error('peer and Health readings did not both arrive while the session was open');
    await sleep(2000);
    r.held = await page.evaluate(() => ({ sameInput: window.__qaHeld.input === document.querySelector('#workout-session-modal .wg-workouts-session-exercise__field--notes input'), sameExercise: window.__qaHeld.exercise === document.querySelector('#workout-session-modal .wg-workouts-session-exercise'), sameBPList: window.__qaHeld.bpList === document.getElementById('bp-list').innerHTML, value: window.__qaHeld.input.value, connected: window.__qaHeld.input.isConnected, modalOpen: !window.__qaHeld.modal.classList.contains('hidden'), changes: window.__qaHeld.changes, toasts: window.__qaHeld.toasts, banners: window.__qaHeld.banners }));
    const dataNotice = r.held.toasts.find(([message]) => /new (reading|entr|data)|synced/i.test(String(message)));
    const dataBanner = r.held.banners.find((message) => /new (reading|entr|data)|synced/i.test(String(message)));
    if (!r.held.sameInput || !r.held.sameExercise || !r.held.sameBPList || !r.held.connected || !r.held.modalOpen || r.held.value !== 'Typing stays here' || r.held.changes.length || dataNotice || dataBanner) throw new Error(`open session changed: ${JSON.stringify(r.held)}`);
    await ctx.stableShot('account-session-held');
    await page.locator('#workout-session-cancel-btn').click();
    await page.waitForFunction(() => document.getElementById('workout-session-modal').classList.contains('hidden'), null, { timeout: 15_000 });
    await page.waitForFunction(() => {
      const text = document.getElementById('bp-list')?.innerText || '';
      return text.includes('168') && text.includes('97') && text.includes('171') && text.includes('99');
    }, null, { timeout: 30_000 });
    await ctx.stableShot('account-session-closed-bp');
    r.afterClose = await page.locator('#bp-list').innerText();
  });
  ctx.log('pullRefresh', JSON.stringify(r, null, 2));
}
