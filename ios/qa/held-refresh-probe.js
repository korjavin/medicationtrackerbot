// Debug qa.test only. Exercise the real account, Health bridge and sync; the
// controls expose state to XCTest without replacing any production handler.
(() => {
  if (location.pathname !== '/') return;
  const s = { phase: 'boot', error: '', document: crypto.randomUUID(), queries: 0, events: [] };
  let out, held;
  const publish = () => out?.setAttribute('aria-label', 'QA held ' + JSON.stringify(s));
  const wait = async (f, name, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = await f(); if (v) return v; await new Promise(r => setTimeout(r, 200)); }
    throw new Error('timeout: ' + name);
  };
  const visible = e => e && e.getClientRects().length && !e.closest('.hidden');
  const run = async (name, fn) => {
    try { s.phase = name + '-running'; s.error = ''; publish(); await fn(); s.phase = name + '-done'; }
    catch (e) { s.phase = name + '-error'; s.error = String(e?.message || e); }
    publish();
  };
  document.addEventListener('visibilitychange', e => { s.events.push(document.visibilityState + ':' + e.isTrusted); publish(); });
  async function setup() {
    await wait(() => window.Health?.isSupported() && window.apiCall && window.WorkoutSessions, 'account and Health');
    const health = window.Health;
    const query = health.query.bind(health);
    health.query = async (...args) => { s.queries++; if (s.returned) s.returnQueries = (s.returnQueries || 0) + 1; publish(); try { return await query(...args); } finally { s.completed = (s.completed || 0) + 1; publish(); } };
    window.switchTab('settings');
    const toggle = await wait(() => document.querySelector('#health-import-toggle'), 'Health switch');
    if (!toggle.checked) toggle.click();
    await wait(() => { s.toggle = { checked: toggle.checked, disabled: toggle.disabled, enabled: localStorage.getItem('wg.health.enabled') }; publish(); return localStorage.getItem('wg.health.enabled') === 'true'; }, 'Health enabled');
    await wait(() => s.queries > 0 && s.completed === s.queries, 'initial Health queries');
    await new Promise(r => setTimeout(r, 3000));
    const ex = await window.apiCall('/api/workout/exercise-library/create', 'POST', { name: 'QA refresh bench', body_part: 'chest' });
    const { session } = await window.apiCall('/api/workout/sessions/adhoc', 'POST');
    await window.apiCall('/api/workout/sessions/logs/create', 'POST', { session_id: session.id, exercise_id: ex.id, sets: [{ reps: 5, weight: 20 }] });
    window.switchTab('health');
    (await wait(() => document.querySelector('[data-health-seg="bp"]'), 'BP segment')).click();
    await wait(() => visible(document.querySelector('#bp-list')), 'BP list');
    await window.WorkoutSessions.open(session.id);
    const input = await wait(() => document.querySelector('#workout-session-modal .wg-workouts-session-exercise__field--notes input'), 'session Notes');
    const sync = await import(new URL('/js/sync.js', location.href).href);
    if (!await sync.flushConfirmed(window.MedTrackerCloud.ctx)) throw new Error('workout did not sync');
    held = { input, exercise: input.closest('.wg-workouts-session-exercise'), modal: document.getElementById('workout-session-modal'), list: document.getElementById('bp-list').innerHTML, removed: 0, notices: [] };
    const original = window.safeToast;
    window.safeToast = (...args) => { held.notices.push(String(args[0])); return original(...args); };
    new MutationObserver(ms => { for (const m of ms) for (const n of m.removedNodes) if (n === input || n.contains?.(input)) held.removed++; })
      .observe(held.modal, { subtree: true, childList: true });
    new MutationObserver(() => { for (const e of document.querySelectorAll('#app-banners > :not(#offline-banner)')) if (visible(e)) held.notices.push(e.innerText); })
      .observe(document.getElementById('app-banners'), { subtree: true, childList: true, attributes: true, characterData: true });
    await wait(() => s.completed === s.queries, 'initial Health pass settled');
    s.beforeQueries = s.queries; s.session = session.id;
    document.addEventListener('visibilitychange', event => {
      if (event.isTrusted && document.visibilityState === 'visible') { s.returned = true; publish(); }
    });
  }
  async function peer() {
    const sync = await import(new URL('/js/sync.js', location.href).href);
    const c = await import(new URL('/js/crypto.js', location.href).href);
    const ctx = window.MedTrackerCloud.ctx;
    if (!await sync.flushConfirmed(ctx)) throw new Error('pending writes before peer');
    const { seq, pending } = await sync.recordsPort(ctx).horizonBasis();
    if (pending || !Number.isInteger(seq)) throw new Error('no synced horizon');
    const id = 'bp_qa_peer_refresh';
    const row = { recordId: id, clientTs: Date.now(), deleted: false, measured_at: new Date().toISOString(), systolic: 168, diastolic: 97, pulse: null, site: '', position: '', category: 'High BP Stage 2', ignore_calc: false, notes: '', tag: '' };
    const enc = await c.encryptRecord({ kData: ctx.kData, accountId: ctx.accountId, recordType: 'bp', recordId: id, seq: seq + 1, plaintext: new TextEncoder().encode(JSON.stringify(row)) });
    const res = await fetch('/api/sync/ops', { method: 'POST', headers: sync.WRITE_HEADERS, body: JSON.stringify({ ops: [{ record_type_tag: `bp:${id}`, nonce: c.toBase64(enc.nonce), ct: c.toBase64(enc.ct) }] }) });
    if (!res.ok || (await res.json()).assigned?.[0] !== seq + 1) throw new Error('peer write failed or raced');
    s.peerSeq = seq + 1;
  }
  async function inspect() {
    await wait(async () => (await window.apiCall('/api/bp?days=2'))?.some(x => x.systolic === 168 && x.diastolic === 97), 'peer BP arrived');
    await wait(() => s.returnQueries > 0, 'foreground Health pass');
    s.held = { sameInput: held.input === document.querySelector('#workout-session-modal .wg-workouts-session-exercise__field--notes input'), sameExercise: held.exercise === document.querySelector('#workout-session-modal .wg-workouts-session-exercise'), connected: held.input.isConnected, open: !held.modal.classList.contains('hidden'), value: held.input.value, sameList: held.list === document.getElementById('bp-list').innerHTML, removed: held.removed, notices: held.notices.filter(x => /new (reading|entr|data)|synced/i.test(x)) };
  }
  async function after() {
    await wait(() => !visible(document.getElementById('workout-session-modal')), 'session closed');
    await wait(() => { const t = document.getElementById('bp-list')?.innerText || ''; return t.includes('168') && t.includes('97'); }, 'peer BP rendered');
    s.bp = document.getElementById('bp-list').innerText;
    window.switchTab('health');
    const vitals = await wait(() => document.querySelector('[data-health-seg="health"]'), 'Vitals tab');
    vitals.click();
    await wait(() => /4000|4,000|7 h|7h/.test(document.getElementById('health-overview-content')?.innerText || ''), 'Health rows rendered');
    s.healthVisible = true;
  }
  document.addEventListener('DOMContentLoaded', () => {
    const bar = document.createElement('div'); bar.style.cssText = 'position:fixed;top:0;right:0;z-index:2147483647;font-size:8px';
    for (const [name, fn] of Object.entries({ setup, peer, inspect, after })) { const b = document.createElement('button'); b.textContent = 'QA held ' + name; b.addEventListener('click', () => run(name, fn)); bar.appendChild(b); }
    out = document.createElement('button'); out.textContent = 'QA held state'; bar.appendChild(out); document.body.appendChild(bar); publish();
  }, { once: true });
})();
