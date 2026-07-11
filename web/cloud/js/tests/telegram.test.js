// C3a Task 5: the Telegram onboarding module drives the real DOM off
// GET /api/telegram/status. These tests exercise the branching that manual
// checking can't cheaply guarantee: the wizard self-gate when Telegram is
// disabled, the Skip consent path, and rendering the linked/test state.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import { mountTelegram } from '../telegram.js';

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

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'https://acct.example.test/' });
  global.document = dom.window.document;
  global.confirm = vi.fn(() => true);
  app = dom.window.document.getElementById('app');
});

afterEach(() => {
  dom.window.close();
  delete global.document;
  delete global.confirm;
  delete global.fetch;
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
});
