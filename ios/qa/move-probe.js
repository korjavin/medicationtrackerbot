// QA-only account observer for the local-to-cloud test. The user-facing move
// and choice dialogs are driven by XCUITest, not this observer.
(() => {
  if (location.pathname !== '/') return;
  const state = { phase: 'boot', nameEgress: 0, rxnav: 0, uninspected: 0 };
  const rawFetch = window.fetch.bind(window);
  window.fetch = (...args) => {
    const url = String(args[0]?.url || args[0]);
    let text = url + '\n' + (typeof args[1]?.body === 'string' ? args[1].body : '');
    if ((args[0] instanceof Request && !['GET', 'HEAD'].includes(args[0].method)) ||
        (args[1]?.body != null && typeof args[1].body !== 'string')) state.uninspected++;
    try { text = decodeURIComponent(text); } catch (_) { /* inspect raw */ }
    if (/candecor/i.test(text)) state.nameEgress++;
    if (/rxnav\.nlm\.nih\.gov|\/api\/rxnav\//i.test(url)) state.rxnav++;
    return rawFetch(...args);
  };
  const wait = async (f, label) => {
    const end = Date.now() + 60000;
    while (Date.now() < end) { const v = await f(); if (v) return v; await new Promise(r => setTimeout(r, 200)); }
    throw new Error('timeout: ' + label);
  };
  const visible = el => el && el.getClientRects().length;
  let output;
  const publish = () => output?.setAttribute('aria-label', 'QA Move ' + JSON.stringify(state));
  async function inspect() {
    const vault = JSON.parse(await window.CloudVault.exportAll({ includeSecrets: false }));
    const data = vault.data;
    if (data.protection) delete data.protection.last_backup_at;
    state.counts = {};
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(v)) state.counts[k] = v.length;
      else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) {
        if (Array.isArray(vv)) state.counts[`${k}.${kk}`] = vv.length;
      }
    }
    state.register = data.settings.med_register;
  }
  async function save() {
    document.querySelector('.wg-page[aria-label="Features"] .wg-pagebar .wg-back')?.click();
    window.switchTab('meds'); window.showAddModal();
    const input = await wait(() => document.querySelector('#med-name'), 'editor');
    input.value = 'Candecor';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => visible(document.querySelector('#med-eu-chip')), 'EU chip');
    document.querySelector('#med-dosage').value = '8mg';
    document.querySelector('[data-schedule-type="as_needed"]').click();
    document.querySelector('#med-modal-save-btn').click();
    await wait(() => !visible(document.querySelector('#med-modal')), 'save');
    const meds = await window.apiCall('/api/medications');
    if (!meds.some(m => m.name === 'Candecor' && m.ema)) throw new Error('EU medication not saved');
  }
  document.addEventListener('DOMContentLoaded', () => {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;top:0;right:0;z-index:2147483647;font-size:8px';
    for (const [name, fn] of Object.entries({ inspect, save })) {
      const b = document.createElement('button'); b.textContent = 'QA Move ' + name;
      b.addEventListener('click', async () => {
        state.phase = name + '-running'; publish();
        try { await fn(); state.phase = name + '-done'; }
        catch (e) { state.phase = name + '-error'; state.error = String(e?.message || e); }
        publish();
      });
      bar.appendChild(b);
    }
    output = document.createElement('button'); output.textContent = 'QA Move state'; bar.appendChild(output);
    document.body.appendChild(bar); publish();
  }, { once: true });
})();
