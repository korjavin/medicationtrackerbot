// Bundled only in the eu QA part and injected only into Debug qa.test pages.
// Uses the real account shim and encrypted sync protocol; no product code changes.
(() => {
  if (location.pathname !== '/') return;
  const state = { phase: 'boot', error: '', document: crypto.randomUUID(), pulls: 0, blocked: 0, nameEgress: 0, rxnav: 0, uninspected: 0 };
  const rawFetch = window.fetch.bind(window);
  let blockPull = false;
  window.fetch = (...args) => {
    const url = String(args[0]?.url || args[0]);
    let text = url + '\n' + (typeof args[1]?.body === 'string' ? args[1].body : '');
    if ((args[0] instanceof Request && !['GET', 'HEAD'].includes(args[0].method)) ||
        (args[1]?.body != null && typeof args[1].body !== 'string')) state.uninspected++;
    try { text = decodeURIComponent(text); } catch (_) { /* inspect raw */ }
    if (/candecor/i.test(text)) state.nameEgress++;
    if (/rxnav\.nlm\.nih\.gov|\/api\/rxnav\//i.test(url)) state.rxnav++;
    if (String(args[0]).startsWith('/api/sync/ops?')) {
      if (blockPull) { state.blocked++; return Promise.resolve(new Response('', { status: 503 })); }
      state.pulls++;
    }
    return rawFetch(...args);
  };
  const wait = async (f, label, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = await f(); if (v) return v; await new Promise(r => setTimeout(r, 200)); }
    throw new Error('timeout: ' + label);
  };
  const visible = el => el && el.getClientRects().length;
  let output;
  const publish = () => output?.setAttribute('aria-label', 'QA EU ' + JSON.stringify(state));
  const run = async (phase, f) => {
    try { state.phase = phase + '-running'; state.error = ''; publish(); await f(); state.phase = phase + '-done'; }
    catch (e) { state.phase = phase + '-error'; state.error = String(e?.message || e); }
    publish();
  };
  async function editor() {
    window.switchTab('meds');
    window.showAddModal();
    const input = await wait(() => document.querySelector('#med-name'), 'editor');
    input.value = 'Candecor';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => visible(document.querySelector('#med-eu-chip')), 'EU chip');
    state.chip = document.querySelector('#med-eu-chip').textContent.trim();
  }
  async function initial() {
    await window.apiCall('/api/settings/body', 'PATCH', { med_register: 'eu' });
    await editor();
    await wait(async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('medtracker-ema-') && await (await caches.open(name)).match('/static/data/ema-article57-rev90-v1.json')) return true;
      }
      return false;
    }, 'register cache');
    document.querySelector('#med-dosage').value = '8mg';
    document.querySelector('[data-schedule-type="as_needed"]').click();
    document.querySelector('#med-modal-save-btn').click();
    await wait(() => !visible(document.querySelector('#med-modal')), 'save');
    const meds = await window.apiCall('/api/medications');
    const med = meds.find(m => m.name === 'Candecor');
    if (!med?.ema) throw new Error('saved medication has no EU match');
    state.medId = med.id;
    const sync = await import('/js/sync.js');
    if (!await sync.flushConfirmed(window.MedTrackerCloud.ctx)) throw new Error('EU save not synced');
  }
  async function offline() {
    const meds = await window.apiCall('/api/medications');
    const med = meds.find(m => m.name === 'Candecor');
    if (!med?.ema) throw new Error('saved EU match missing after cold open');
    window.switchTab('meds');
    await wait(() => visible(document.querySelector('.med-tab[data-tab="schedule"]')), 'schedule');
    document.querySelector('.med-tab[data-tab="schedule"]').click();
    const row = await wait(() => document.querySelector(`[data-med-id="${med.id}"]`), 'saved row');
    row.click();
    const saved = await wait(() => visible(document.querySelector('#med-eu-saved')) && document.querySelector('#med-eu-saved'), 'saved entry');
    const chip = await wait(() => visible(document.querySelector('#med-eu-chip')) && document.querySelector('#med-eu-chip'), 'offline chip');
    state.saved = saved.textContent.trim(); state.chip = chip.textContent.trim();
  }
  async function peer() {
    await window.apiCall('/api/settings/body', 'PATCH', { med_register: 'us' });
    const sync = await import('/js/sync.js');
    const c = await import('/js/crypto.js');
    const ctx = window.MedTrackerCloud.ctx;
    if (!await sync.flushConfirmed(ctx)) throw new Error('US setting not synced');
    const port = sync.recordsPort(ctx);
    const current = (await port.list('settings')).find(x => x.recordId === 'settings');
    if (current?.med_register !== 'us') throw new Error('US setting not established');
    const { seq, pending } = await port.horizonBasis();
    if (pending || !Number.isInteger(seq)) throw new Error('not at synced horizon');
    blockPull = true; state.pulls = 0; state.blocked = 0;
    const { recordType, ...body } = current;
    const next = { ...body, med_register: 'eu', clientTs: Math.max(Date.now(), body.clientTs + 1) };
    const enc = await c.encryptRecord({ kData: ctx.kData, accountId: ctx.accountId, recordType: 'settings', recordId: 'settings', seq: seq + 1,
      plaintext: new TextEncoder().encode(JSON.stringify(next)) });
    const response = await rawFetch('/api/sync/ops', { method: 'POST', headers: sync.WRITE_HEADERS,
      body: JSON.stringify({ ops: [{ record_type_tag: 'settings:settings', nonce: c.toBase64(enc.nonce), ct: c.toBase64(enc.ct) }] }) });
    if (!response.ok || (await response.json()).assigned?.[0] !== seq + 1) throw new Error('peer write failed or raced');
    state.beforePull = (await port.list('settings')).find(x => x.recordId === 'settings')?.med_register;
    if (state.beforePull !== 'us') throw new Error('peer applied before pull');
    window.switchTab('today'); window.scrollTo(0, 0);
    state.sawPull = false; state.trustedTouchEnd = false;
    new MutationObserver(() => { if (document.querySelector('.wg-ptr--busy')) state.sawPull = true; })
      .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    // Unblock before the real pull-to-refresh touch ends; all earlier automatic pulls fail.
    document.addEventListener('touchend', event => { state.trustedTouchEnd = event.isTrusted; blockPull = false; }, { capture: true, once: true });
    state.peerSeq = seq + 1;
  }
  async function observe() {
    const sync = await import('/js/sync.js');
    const port = sync.recordsPort(window.MedTrackerCloud.ctx);
    await wait(async () => (await port.list('settings')).find(x => x.recordId === 'settings')?.med_register === 'eu', 'peer setting');
    state.afterPull = 'eu';
    window.switchTab('settings');
    await wait(() => window.SettingsView.openSettingsPage('features'), 'features');
    await wait(() => document.querySelector('#med-register-value')?.textContent.trim() === 'EU register', 'EU setting');
    state.setting = document.querySelector('#med-register-value').textContent.trim();
    const back = await wait(() => document.querySelector('.wg-page[aria-label="Features"] .wg-pagebar .wg-back'), 'features back');
    back.click();
    await editor();
  }
  document.addEventListener('DOMContentLoaded', () => {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;top:0;right:0;z-index:2147483647;font-size:8px';
    for (const [name, fn] of Object.entries({ initial, offline, peer, observe })) {
      const b = document.createElement('button'); b.textContent = 'QA EU ' + name;
      b.addEventListener('click', () => run(name, fn)); bar.appendChild(b);
    }
    output = document.createElement('button'); output.textContent = 'QA EU state'; bar.appendChild(output);
    document.body.appendChild(bar); publish();
  }, { once: true });
})();
