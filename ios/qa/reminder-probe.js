// Debug qa.test only: create a real medication and observe the real native
// scheduling bridge. The page and device clocks are not pinned.
(() => {
  if (location.pathname !== '/') return;
  const state = { phase: 'boot', error: '' };
  const wait = async (f, name, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = await f(); if (v) return v; await new Promise(r => setTimeout(r, 200)); }
    throw new Error('timeout: ' + name);
  };
  let output;
  const publish = () => output?.setAttribute('aria-label', 'QA reminder ' + JSON.stringify(state));
  async function schedule() {
    try {
      state.phase = 'running'; publish();
      const local = await wait(() => window.LocalNotifications?.isSupported?.() && window.LocalNotifications, 'native notifications');
      const original = local.schedule.bind(local);
      let observed;
      local.schedule = async items => {
        const count = await original(items);
        observed = { items, count }; return count;
      };
      const at = new Date(Math.ceil((Date.now() + 150000) / 60000) * 60000);
      const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
      const result = await window.apiCall('/api/medications', 'POST', {
        name: 'QA Offline Reminder', dosage: '5mg', archived: false, supplement: false,
        schedule: JSON.stringify({ type: 'daily', times: [time] }),
      });
      if (!result?.id) throw new Error('medication creation failed');
      const match = await wait(() => observed?.items?.find(item => item.fireAtUnix === Math.floor(at.getTime() / 1000)), 'native schedule');
      if (!(observed.count > 0) || !match.url?.includes('med')) throw new Error('native schedule did not accept the dose');
      state.phase = 'done'; state.fireAt = match.fireAtUnix; state.body = match.body; state.url = match.url; state.count = observed.count;
    } catch (e) { state.phase = 'error'; state.error = String(e?.message || e); }
    publish();
  }
  document.addEventListener('DOMContentLoaded', () => {
    const button = document.createElement('button'); button.textContent = 'QA schedule reminder';
    button.style.cssText = 'position:fixed;right:0;top:0;z-index:2147483647;font-size:8px';
    button.addEventListener('click', schedule);
    const inspect = document.createElement('button'); inspect.textContent = 'QA inspect notification settings';
    inspect.style.cssText = 'position:fixed;right:0;top:30px;z-index:2147483647;font-size:8px';
    inspect.addEventListener('click', () => {
      state.phase = 'inspected'; state.cardHidden = document.querySelector('#cloud-push-card')?.hidden;
      state.warning = document.querySelector('#cloud-push-chip')?.classList.contains('wg-chip--warn');
      state.note = document.querySelector('#cloud-push-note [data-notify-denied]')?.textContent.trim(); publish();
    });
    output = document.createElement('button'); output.textContent = 'QA reminder state';
    output.style.cssText = 'position:fixed;right:0;top:15px;z-index:2147483647;font-size:8px';
    document.body.append(button, output, inspect); publish();
  }, { once: true });
})();
