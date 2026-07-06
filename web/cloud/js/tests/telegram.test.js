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
