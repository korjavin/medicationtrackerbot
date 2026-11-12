// Debug-only qa.test probe. The account and encrypted peer operation are real;
// UI gestures and confirmation are driven by XCUITest.
(() => {
  if (location.pathname !== '/') return;
  const rawFetch = window.fetch.bind(window);
  const state = { phase: 'boot', document: crypto.randomUUID(), pulls: 0, blocked: 0, pill: [], toasts: [], touch: [] };
  let blockPull = false, output;
  window.fetch = (...args) => {
    if (String(args[0]).startsWith('/api/sync/ops?')) {
      if (blockPull) { state.blocked++; return Promise.resolve(new Response('', { status: 503 })); }
      state.pulls++;
    }
    return rawFetch(...args);
  };
  const publish = () => output?.setAttribute('aria-label', 'QA Pull ' + JSON.stringify(state));
  const wait = async (f, name, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = await f(); if (value) return value; await new Promise(r => setTimeout(r, 200)); }
    throw new Error('timeout: ' + name);
  };
  const visible = el => !!el?.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const run = async (name, fn) => {
    if (state.phase === name + '-running') return; // a re-tap must not start a second run
    try { state.phase = name + '-running'; publish(); await fn(); state.phase = name + '-done'; }
    catch (e) { state.phase = name + '-error'; state.error = String(e?.message || e); }
    publish();
  };
  function arm() {
    state.pill = []; state.toasts = []; state.touch = []; state.pulls = 0;
    window.switchTab('today'); window.scrollTo(0, 0);
  }
  async function peer() {
    const sync = await import(new URL('/js/sync.js', location.href).href);
    const c = await import(new URL('/js/crypto.js', location.href).href);
    const ctx = window.MedTrackerCloud.ctx;
    if (!await sync.flushConfirmed(ctx)) throw new Error('pending writes before peer');
    const { seq, pending } = await sync.recordsPort(ctx).horizonBasis();
    if (pending || !Number.isInteger(seq)) throw new Error('no synced horizon');
    blockPull = true; arm();
    const recordId = 'bp_qa_pull_634';
    const record = { recordId, clientTs: Date.now(), deleted: false, measured_at: new Date().toISOString(), systolic: 167, diastolic: 96, pulse: null, site: '', position: '', category: 'High BP Stage 2', ignore_calc: false, notes: '', tag: '' };
    const enc = await c.encryptRecord({ kData: ctx.kData, accountId: ctx.accountId, recordType: 'bp', recordId, seq: seq + 1, plaintext: new TextEncoder().encode(JSON.stringify(record)) });
    const response = await rawFetch('/api/sync/ops', { method: 'POST', headers: sync.WRITE_HEADERS,
      body: JSON.stringify({ ops: [{ record_type_tag: `bp:${recordId}`, nonce: c.toBase64(enc.nonce), ct: c.toBase64(enc.ct) }] }) });
    if (!response.ok || (await response.json()).assigned?.[0] !== seq + 1) throw new Error('peer write failed or raced');
    state.before = (await window.apiCall('/api/bp?days=2')).some(x => x.systolic === 167 && x.diastolic === 96);
    if (state.before) throw new Error('peer appeared before pull');
  }
  async function observed() {
    await wait(() => state.touch.includes('touchend') && !document.querySelector('.wg-ptr'), 'pull completed');
    await wait(async () => (await window.apiCall('/api/bp?days=2')).some(x => x.systolic === 167 && x.diastolic === 96), 'peer BP');
    window.switchTab('bp');
    await wait(() => document.querySelector('#bp-list')?.innerText.includes('167'), 'BP rendered');
    state.row = document.querySelector('#bp-list').innerText;
  }
  async function quiet() { arm(); }
  async function quietDone() { await wait(() => state.touch.includes('touchend') && !document.querySelector('.wg-ptr'), 'quiet pull'); }
  async function network() {
    state.online = navigator.onLine;
    state.banner = visible(document.getElementById('offline-banner'));
  }
  async function cancel() { localStorage.setItem('qa-softauthn:cancel', '1'); }
  // The delete flow's last step is CloudVault.leaveAccount (settings.js,
  // after the verified clearLocalVault); the page is gone right after, so the
  // wipe state goes out as a tlsfront receipt path (no query or body kept).
  async function wipe() {
    const vault = window.CloudVault, leave = vault.leaveAccount;
    vault.leaveAccount = async (...args) => {
      const dbs = indexedDB.databases ? (await indexedDB.databases()).map(d => d.name) : null;
      const left = [...(dbs ? dbs.filter(n => n === 'medtracker-cloud' || n === 'MedTrackerDB') : ['no-databases-api']), ...(typeof caches === 'undefined' ? [] : await caches.keys())];
      await rawFetch('/qa-wipe/' + (left.length ? 'dirty-' + encodeURIComponent(left.join(',')) : 'clean'), { cache: 'no-store' }).catch(() => {});
      return leave.apply(vault, args);
    };
  }
  async function verify() {
    const rows = await wait(async () => {
      const bp = await window.apiCall('/api/bp?days=2');
      return Array.isArray(bp) && bp.some(x => x.systolic === 167 && x.diastolic === 96) && bp;
    }, 'BP restored after cancellation');
    state.restored = rows.some(x => x.systolic === 167 && x.diastolic === 96);
  }
  document.addEventListener('DOMContentLoaded', () => {
    const original = window.safeToast;
    window.safeToast = (...args) => { state.toasts.push(args[0]); return original(...args); };
    new MutationObserver(() => {
      const pill = document.querySelector('.wg-ptr');
      if (pill) state.pill.push(pill.textContent.trim());
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) document.addEventListener(type, e => {
      if (!e.isTrusted) return;
      state.touch.push(type);
      if (type === 'touchend') blockPull = false;
    }, { capture: true, passive: true });
    const bar = document.createElement('div'); bar.style.cssText = 'position:fixed;top:0;right:0;z-index:2147483647;font-size:8px;pointer-events:none';
    for (const [name, fn] of Object.entries({ peer, observed, quiet, quietDone, network, cancel, verify, wipe })) {
      const b = document.createElement('button'); b.style.pointerEvents = 'auto'; b.textContent = 'QA Pull ' + name;
      b.addEventListener('click', () => run(name, fn)); bar.appendChild(b);
    }
    output = document.createElement('button'); output.style.pointerEvents = 'auto'; output.textContent = 'QA Pull state'; bar.appendChild(output);
    document.body.appendChild(bar); publish();
  }, { once: true });
})();
