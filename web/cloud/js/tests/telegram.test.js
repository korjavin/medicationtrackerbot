// C3a Task 5: the Telegram onboarding module drives the real DOM off
// GET /api/telegram/status. These tests exercise the branching that manual
// checking can't cheaply guarantee: the wizard self-gate when Telegram is
// disabled, the Skip consent path, and rendering the linked/test state.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import { mountTelegram } from '../telegram.js';
import { createApiRouter } from '../apishim.js';
import { allowConsoleNoise } from '../../../static/js/tests/helpers/setup.js';

let dom;
let app;

function fetchStub(routes) {
  return vi.fn(async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const handler = routes[`${method} ${url}`] ?? routes[url];
    if (!handler) return { ok: false, status: 404, json: async () => ({}) };
    return typeof handler === 'function' ? handler(opts) : handler;
  });
}

// Records port over an in-memory map, keyed by recordId within each type —
// mirrors inbox-apply.test.js's fakeRecords so the real createApiRouter can
// run against it without IndexedDB/crypto.
function fakeRecords(seed = {}) {
  const store = JSON.parse(JSON.stringify(seed));
  return {
    list: async (type) => (store[type] || []).map((r) => ({ ...r })),
    put: async (type, record) => {
      store[type] = (store[type] || []).filter((r) => r.recordId !== record.recordId);
      store[type].push({ ...record });
      return record;
    },
    del: async (type, id) => {
      store[type] = (store[type] || []).filter((r) => r.recordId !== id);
    },
  };
}

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'https://acct.example.test/' });
  global.document = dom.window.document;
  global.confirm = vi.fn(() => true);
  app = dom.window.document.getElementById('app');
  // DEFAULT_PREFS_PORT reads window.apiCall (the seam apishim.js installs in
  // production). Tests that don't care about the glossary never override
  // prefsPort, so give window.apiCall a harmless default here rather than
  // letting DEFAULT_PREFS_PORT's real load throw ReferenceError: window is
  // not defined on every unrelated linked-state render.
  global.window = dom.window;
  dom.window.apiCall = vi.fn(async () => ({ note: '' }));
});

afterEach(() => {
  dom.window.close();
  delete global.document;
  delete global.confirm;
  delete global.fetch;
  delete global.window;
  vi.useRealTimers();
});

describe('telegram.js onboarding module', () => {
  it('self-hides in the wizard when Telegram is disabled (calls onDone, renders nothing)', async () => {
    // Disabled => routes unregistered => status 404 => module treats as disabled.
    global.fetch = fetchStub({});
    const onDone = vi.fn();
    await mountTelegram(app, { onDone });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(app.querySelector('section')).toBeNull();
  });

  it('renders the consent screen with a Skip button in wizard mode and posts skip', async () => {
    const fetch = fetchStub({
      '/api/telegram/status': { ok: true, json: async () => ({ enabled: true, state: 'none' }) },
      'POST /api/telegram/skip': { ok: true, json: async () => ({ skipped: true }) },
    });
    global.fetch = fetch;
    const onDone = vi.fn();
    await mountTelegram(app, { onDone });

    expect(app.querySelector('#tg-accept')).not.toBeNull();
    const skip = app.querySelector('#tg-skip');
    expect(skip).not.toBeNull();

    skip.dispatchEvent(new dom.window.Event('click'));
    await vi.waitFor(() => {
      if (onDone.mock.calls.length === 0) throw new Error('skip not resolved yet');
    });
    expect(fetch).toHaveBeenCalledWith('/api/telegram/skip', { method: 'POST' });
  });

  it('omits the Skip button in settings mode (no onDone)', async () => {
    global.fetch = fetchStub({
      '/api/telegram/status': { ok: true, json: async () => ({ enabled: true, state: 'none' }) },
    });
    await mountTelegram(app, {});
    expect(app.querySelector('#tg-accept')).not.toBeNull();
    expect(app.querySelector('#tg-skip')).toBeNull();
  });

  // med-vb7: in the wizard the section is the page and owns the <h1>; mounted
  // in Settings it sits under the page's own <h1> next to <h2> siblings, so a
  // second <h1> there would both look wrong and break the heading outline.
  it('titles itself <h1> in the wizard but <h2> in settings mode', async () => {
    const status = {
      '/api/telegram/status': { ok: true, json: async () => ({ enabled: true, state: 'none' }) },
    };

    global.fetch = fetchStub(status);
    await mountTelegram(app, { onDone: () => {} });
    expect(app.querySelector('h1')).not.toBeNull();
    expect(app.querySelector('h2')).toBeNull();

    app.innerHTML = '';
    global.fetch = fetchStub(status);
    await mountTelegram(app, {});
    expect(app.querySelector('h1')).toBeNull();
    expect(app.querySelector('h2').textContent).toBe('Chat with your tracker on Telegram');
  });

  it('pending state renders the deep-link button, not a linkless waiting page', async () => {
    // Regression (med-eas.31): the poll on the 'pending' state used to clobber
    // the create-bot page with a linkless "waiting" page. Status now carries the
    // deep link so the button persists (and survives a reload).
    const deepLink = 'https://t.me/newbot/mt_manager/mt_vzv3ih3d_bot?name=Med+Tracker';
    global.fetch = fetchStub({
      '/api/telegram/status': {
        ok: true,
        json: async () => ({ enabled: true, state: 'pending', suggested_username: 'mt_vzv3ih3d_bot', deep_link: deepLink }),
      },
    });
    await mountTelegram(app, {});
    const link = app.querySelector('#tg-deep-link');
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe(deepLink);
    expect(app.querySelector('#tg-suggested').textContent).toBe('mt_vzv3ih3d_bot');
  });

  it('pending state surfaces the BYO form and Start-over alongside the deep link (med-eas.32)', async () => {
    // The always-works fallbacks must be reachable while pending — a lost
    // managed_bot_created webhook update otherwise strands the account until
    // the 1h TTL expires.
    global.fetch = fetchStub({
      '/api/telegram/status': {
        ok: true,
        json: async () => ({ enabled: true, state: 'pending', suggested_username: 'mt_x_bot', deep_link: 'https://t.me/newbot/mt_manager/mt_x_bot' }),
      },
    });
    await mountTelegram(app, {});
    expect(app.querySelector('#tg-deep-link')).not.toBeNull();
    expect(app.querySelector('#tg-byo-token')).not.toBeNull();
    expect(app.querySelector('#tg-byo-submit')).not.toBeNull();
    expect(app.querySelector('#tg-reset')).not.toBeNull();
  });

  it('Start-over posts /api/telegram/reset and returns to the consent screen', async () => {
    let state = 'pending';
    const fetch = fetchStub({
      '/api/telegram/status': () => ({
        ok: true,
        json: async () => ({ enabled: true, state, suggested_username: 'mt_x_bot', deep_link: 'https://t.me/newbot/mt_manager/mt_x_bot' }),
      }),
      'POST /api/telegram/reset': () => {
        state = 'none';
        return { ok: true, json: async () => ({ reset: true }) };
      },
    });
    global.fetch = fetch;
    await mountTelegram(app, {});

    app.querySelector('#tg-reset').dispatchEvent(new dom.window.Event('click'));
    await vi.waitFor(() => {
      if (!app.querySelector('#tg-accept')) throw new Error('consent screen not rendered yet');
    });
    expect(fetch).toHaveBeenCalledWith('/api/telegram/reset', { method: 'POST' });
    expect(app.querySelector('#tg-deep-link')).toBeNull();
  });

  it('Start-over renders the actual server state when the webhook won the race (bot_created, not consent)', async () => {
    // Reset only deletes the pending row; if the managed_bot_created webhook
    // completed just before the click, reset still succeeds while the bot row
    // exists. The client must show the created bot, not paint consent over it.
    const fetch = fetchStub({
      '/api/telegram/status': (() => {
        let calls = 0;
        return () => ({
          ok: true,
          json: async () => (++calls === 1
            ? { enabled: true, state: 'pending', suggested_username: 'mt_x_bot', deep_link: 'https://t.me/newbot/mt_manager/mt_x_bot' }
            : { enabled: true, state: 'bot_created', bot_username: 'mt_x_bot' }),
        });
      })(),
      'POST /api/telegram/reset': { ok: true, json: async () => ({ reset: true }) },
    });
    global.fetch = fetch;
    await mountTelegram(app, {});

    app.querySelector('#tg-reset').dispatchEvent(new dom.window.Event('click'));
    await vi.waitFor(() => {
      if (!app.querySelector('#tg-bot-link')) throw new Error('open-bot page not rendered yet');
    });
    expect(app.querySelector('#tg-accept')).toBeNull();
    expect(app.querySelector('#tg-bot-link').textContent).toBe('Open @mt_x_bot');
  });

  it('a stale in-flight status poll cannot repaint the pending page after reset', async () => {
    // Race: a poll tick's GET /status is in flight when Start-over completes.
    // The stale response (still 'pending') must not repaint the create-bot
    // page over the consent screen or restart the stopped interval.
    vi.useFakeTimers();
    let state = 'pending';
    let releaseStale;
    const stale = new Promise((r) => { releaseStale = r; });
    let statusCalls = 0;
    const pendingBody = { enabled: true, state: 'pending', suggested_username: 'mt_x_bot', deep_link: 'https://t.me/newbot/mt_manager/mt_x_bot' };
    global.fetch = fetchStub({
      '/api/telegram/status': () => {
        statusCalls++;
        if (statusCalls === 2) {
          // first poll tick — hold it in flight across the reset
          return stale.then(() => ({ ok: true, json: async () => pendingBody }));
        }
        return { ok: true, json: async () => ({ ...pendingBody, state }) };
      },
      'POST /api/telegram/reset': () => {
        state = 'none';
        return { ok: true, json: async () => ({ reset: true }) };
      },
    });
    await mountTelegram(app, {});
    expect(app.querySelector('#tg-deep-link')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(2500); // poll tick fires, status held in flight
    app.querySelector('#tg-reset').dispatchEvent(new dom.window.Event('click'));
    await vi.advanceTimersByTimeAsync(0); // flush reset POST + renderConsent
    expect(app.querySelector('#tg-accept')).not.toBeNull();

    releaseStale();
    await vi.advanceTimersByTimeAsync(0); // stale response lands — must be dropped
    expect(app.querySelector('#tg-accept')).not.toBeNull();
    expect(app.querySelector('#tg-deep-link')).toBeNull();

    const before = statusCalls;
    await vi.advanceTimersByTimeAsync(5000); // interval must not have restarted
    expect(statusCalls).toBe(before);
  });

  it('accept -> provision lands on the deep-link create-bot page', async () => {
    const deepLink = 'https://t.me/newbot/mt_manager/mt_new_bot?name=Med+Tracker';
    global.fetch = fetchStub({
      '/api/telegram/status': { ok: true, json: async () => ({ enabled: true, state: 'none' }) },
      'POST /api/telegram/provision': { ok: true, json: async () => ({ deep_link: deepLink, suggested_username: 'mt_new_bot' }) },
    });
    await mountTelegram(app, {});
    app.querySelector('#tg-accept').dispatchEvent(new dom.window.Event('click'));
    await vi.waitFor(() => {
      if (!app.querySelector('#tg-deep-link')) throw new Error('deep-link page not rendered yet');
    });
    expect(app.querySelector('#tg-deep-link').getAttribute('href')).toBe(deepLink);
  });

  it('renders the linked state with a working test-notification button', async () => {
    const fetch = fetchStub({
      '/api/telegram/status': { ok: true, json: async () => ({ enabled: true, state: 'linked', bot_username: 'mt_abc_bot' }) },
      'POST /api/telegram/test': { ok: true, json: async () => ({ sent: true }) },
    });
    global.fetch = fetch;
    await mountTelegram(app, {});

    expect(app.querySelector('#tg-bot-username').textContent).toBe('@mt_abc_bot');
    app.querySelector('#tg-test').dispatchEvent(new dom.window.Event('click'));
    await vi.waitFor(() => {
      if (!app.querySelector('#tg-test-result').textContent.includes('Sent')) throw new Error('not sent yet');
    });
    expect(fetch).toHaveBeenCalledWith('/api/telegram/test', { method: 'POST' });
  });

  it('surfaces a failing webhook last_error in the linked state (bd med-eas.48)', async () => {
    global.fetch = fetchStub({
      '/api/telegram/status': { ok: true, json: async () => ({ enabled: true, state: 'linked', bot_username: 'mt_abc_bot' }) },
      '/api/telegram/diag': { ok: true, json: async () => ({
        bot_username: 'mt_abc_bot',
        last_error: 'Wrong response from the webhook: 502 Bad Gateway',
        webhook_info: { last_error_date: 1_700_000_000 },
      }) },
    });
    await mountTelegram(app, {});
    await vi.waitFor(() => {
      const el = app.querySelector('#tg-webhook-health');
      if (!el || !el.textContent.includes('502 Bad Gateway')) throw new Error('not yet');
    });
    const el = app.querySelector('#tg-webhook-health');
    expect(el.className).toContain('wizard-error');
    expect(el.textContent).toContain('Webhook delivery error');
  });

  it('shows webhook OK when diag reports no last_error (bd med-eas.48)', async () => {
    global.fetch = fetchStub({
      '/api/telegram/status': { ok: true, json: async () => ({ enabled: true, state: 'linked', bot_username: 'mt_abc_bot' }) },
      '/api/telegram/diag': { ok: true, json: async () => ({ bot_username: 'mt_abc_bot', last_error: '' }) },
    });
    await mountTelegram(app, {});
    await vi.waitFor(() => {
      const el = app.querySelector('#tg-webhook-health');
      if (!el || !el.textContent.includes('OK')) throw new Error('not yet');
    });
    expect(app.querySelector('#tg-webhook-health').className).not.toContain('wizard-error');
  });

  // bd med-vcv.4 — the chat agent glossary editor, Settings-only.
  describe('tgprefs glossary editor (med-vcv.4)', () => {
    function statusFetchStub() {
      return fetchStub({
        '/api/telegram/status': { ok: true, json: async () => ({ enabled: true, state: 'linked', bot_username: 'mt_abc_bot' }) },
      });
    }

    it('is present in settings mode but absent in the wizard', async () => {
      global.fetch = statusFetchStub();
      const prefsPort = { get: vi.fn(async () => ''), set: vi.fn() };
      await mountTelegram(app, { prefsPort });
      expect(app.querySelector('#tg-prefs-note')).not.toBeNull();
      expect(prefsPort.get).toHaveBeenCalledTimes(1);

      app.innerHTML = '';
      global.fetch = statusFetchStub();
      await mountTelegram(app, { onDone: () => {}, prefsPort });
      expect(app.querySelector('#tg-prefs-note')).toBeNull();
      expect(app.querySelector('#tg-continue')).not.toBeNull();
    });

    it('loads the stored note into the textarea', async () => {
      global.fetch = statusFetchStub();
      const prefsPort = { get: vi.fn(async () => '"my usual" = 2 eggs + toast'), set: vi.fn() };
      await mountTelegram(app, { prefsPort });
      await vi.waitFor(() => {
        if (app.querySelector('#tg-prefs-note').value !== '"my usual" = 2 eggs + toast') throw new Error('not loaded yet');
      });
    });

    it('saves a FULL-REPLACE of the note, not an append', async () => {
      global.fetch = statusFetchStub();
      const prefsPort = { get: vi.fn(async () => 'old line'), set: vi.fn(async (note) => note) };
      await mountTelegram(app, { prefsPort });
      await vi.waitFor(() => {
        if (app.querySelector('#tg-prefs-note').value !== 'old line') throw new Error('not loaded yet');
      });

      const textarea = app.querySelector('#tg-prefs-note');
      textarea.value = 'brand new note';
      app.querySelector('#tg-prefs-save').dispatchEvent(new dom.window.Event('click'));

      await vi.waitFor(() => {
        if (!app.querySelector('#tg-prefs-result').textContent.includes('Saved')) throw new Error('not saved yet');
      });
      expect(prefsPort.set).toHaveBeenCalledWith('brand new note');
      expect(prefsPort.set).not.toHaveBeenCalledWith(expect.stringContaining('old line'));
    });

    it('an emptied textarea saves as a clear, not a no-op', async () => {
      global.fetch = statusFetchStub();
      const prefsPort = { get: vi.fn(async () => 'some note'), set: vi.fn(async (note) => note) };
      await mountTelegram(app, { prefsPort });
      await vi.waitFor(() => {
        if (app.querySelector('#tg-prefs-note').value !== 'some note') throw new Error('not loaded yet');
      });

      app.querySelector('#tg-prefs-note').value = '';
      app.querySelector('#tg-prefs-save').dispatchEvent(new dom.window.Event('click'));

      await vi.waitFor(() => {
        if (!app.querySelector('#tg-prefs-result').textContent.includes('Saved')) throw new Error('not saved yet');
      });
      expect(prefsPort.set).toHaveBeenCalledWith('');
      expect(app.querySelector('#tg-prefs-note').value).toBe('');
    });

    it('surfaces a load failure without breaking the rest of the linked screen', async () => {
      allowConsoleNoise(); // deliberately triggers the load-failure console.error path
      global.fetch = statusFetchStub();
      const prefsPort = { get: vi.fn(async () => { throw new Error('boom'); }), set: vi.fn() };
      await mountTelegram(app, { prefsPort });
      await vi.waitFor(() => {
        if (!app.querySelector('#tg-prefs-result').textContent.includes('Could not load')) throw new Error('not surfaced yet');
      });
      expect(app.querySelector('#tg-bot-username').textContent).toBe('@mt_abc_bot');
    });

    // End-to-end through the REAL cloud shim (no prefsPort stub): DEFAULT_PREFS_PORT
    // calls window.apiCall, which apishim.js's createApiRouter serves from
    // web/domain/settings.js's getTGPrefsNote/setTGPrefsNote — the same vault
    // singleton (TG_PREFS_TYPE 'tgprefs') the free-text agent reads/appends to
    // (inbox-apply.js, bd med-vcv.3). Proves the wiring, not just the port shape.
    it('DEFAULT_PREFS_PORT round-trips a full-replace save through the real shim', async () => {
      const records = fakeRecords({
        tgprefs: [{ recordId: 'tgprefs', deleted: false, note: 'old line', clientTs: 1 }],
      });
      global.window = { apiCall: createApiRouter(null, { records, now: () => 2 }) };
      global.fetch = statusFetchStub();
      await mountTelegram(app, {});

      await vi.waitFor(() => {
        if (app.querySelector('#tg-prefs-note').value !== 'old line') throw new Error('not loaded yet');
      });

      app.querySelector('#tg-prefs-note').value = 'new note';
      app.querySelector('#tg-prefs-save').dispatchEvent(new dom.window.Event('click'));
      await vi.waitFor(() => {
        if (!app.querySelector('#tg-prefs-result').textContent.includes('Saved')) throw new Error('not saved yet');
      });

      const rec = (await records.list('tgprefs')).find((r) => r.recordId === 'tgprefs' && !r.deleted);
      expect(rec.note).toBe('new note'); // full-replace, not "old line\nnew note"
    });
  });
});
