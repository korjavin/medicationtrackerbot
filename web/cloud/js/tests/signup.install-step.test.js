// med-v1z: cloud onboarding never nudged the user to install the PWA. On iOS,
// web push only works once the app is on the Home Screen, so a user who finished
// signup and never installed got no reminders — silently. The wizard now ends
// on a platform-aware "Add to Home Screen" step between the Emergency Kit tail
// and entering the app. These pin: it auto-skips when already installed
// (display-mode: standalone), iOS gets Share → Add to Home Screen instructions,
// Android/desktop get a real one-tap prompt when the browser offers one and a
// menu hint otherwise, and every path has a non-blocking way through to the app.
//
// The cloud shell has no integration entry point, so this follows the pure-unit
// convention of signup.claimed-link.test.js (repo rule 8's documented exception).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

// signup.js registers a module-level `beforeinstallprompt` listener; capture it
// here so tests can fire the event. A window must therefore exist before the
// module evaluates — resetModules + a fresh import each test keeps
// deferredInstallPrompt isolated, and re-registers the listener into this array.
const bipHandlers = [];
globalThis.window = {
  addEventListener: (type, handler) => { if (type === 'beforeinstallprompt') bipHandlers.push(handler); },
};

vi.mock('../unlock.js', () => ({ establishLdkCache: vi.fn(async () => {}) }));
// Telegram self-gates to onDone when disabled; the step after it (install) is
// what's under test, so short-circuit straight into it.
vi.mock('../telegram.js', () => ({ mountTelegram: async (_app, { onDone }) => onDone() }));

// Control the platform probe rather than matchMedia/userAgent. iosInstallStepsHtml
// stands in for the real shared helper (an <ol> the wizard injects verbatim).
let standalone = false;
let ios = false;
vi.mock('../push.js', () => ({
  isStandalone: () => standalone,
  isIOS: () => ios,
  iosInstallStepsHtml: (last) => '<ol><li>Tap the Share button in Safari.</li>' +
    `<li>Choose "Add to Home Screen".</li><li>${last}</li></ol>`,
}));

const CTX = { accountId: 'acct-1', dek: new Uint8Array(32).fill(7) };

let dom;
let renderEmergencyKit;

// Fires the captured event and returns it. `prompt` optionally throws, to prove
// a rejected native prompt still lets the wizard finish.
function fireBeforeInstallPrompt({ throwOnPrompt = false } = {}) {
  const evt = {
    preventDefault: vi.fn(),
    prompt: vi.fn(() => { if (throwOnPrompt) throw new Error('prompt refused'); }),
    userChoice: Promise.resolve({ outcome: throwOnPrompt ? 'dismissed' : 'accepted' }),
  };
  for (const h of bipHandlers) h(evt);
  return evt;
}

beforeEach(async () => {
  vi.resetModules();
  bipHandlers.length = 0;
  standalone = false;
  ios = false;
  // Fresh module instance → deferredInstallPrompt starts null every test.
  ({ renderEmergencyKit } = await import('../signup.js'));

  dom = new JSDOM('<div id="app"></div>');
  globalThis.document = dom.window.document;
  globalThis.location = { origin: 'https://acct.example', href: '' };
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 }));
});

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.document;
  delete globalThis.fetch;
  delete globalThis.location;
});

// Drives the wizard tail (Emergency Kit → Telegram(auto) → install step). The
// Emergency Kit gate itself is covered in signup.emergency-kit.test.js; print
// rather than download to avoid jsdom's "navigation not implemented" on <a download>.
async function reachInstallStep(ctx = CTX) {
  const app = dom.window.document.getElementById('app');
  await renderEmergencyKit(app, ctx);
  app.querySelector('#kit-print').click();
  const checkbox = app.querySelector('#kit-saved-checkbox');
  checkbox.checked = true;
  checkbox.dispatchEvent(new dom.window.Event('change'));
  app.querySelector('#kit-continue').click();
  return app;
}

describe('install step: derived skip', () => {
  it('auto-skips straight to the app when already running standalone', async () => {
    standalone = true;
    const app = await reachInstallStep();
    await vi.waitFor(() => expect(globalThis.location.href).toBe('/'));
    // No install UI was ever rendered — it was a derived no-op.
    expect(app.querySelector('#install-skip')).toBeNull();
  });
});

describe('install step: iOS', () => {
  it('shows Share → Add to Home Screen instructions with both continue and skip', async () => {
    ios = true;
    const app = await reachInstallStep();
    await vi.waitFor(() => expect(app.querySelector('#install-skip')).not.toBeNull());

    expect(app.textContent).toContain('Add to Home Screen');
    expect(app.textContent).toContain('Share button');
    expect(app.querySelector('#install-continue')).not.toBeNull();
    // An instruction list, not the Android one-tap button.
    expect(app.querySelector('#install-now')).toBeNull();
  });

  it('reaches the app from the "I\'ve installed it" button', async () => {
    ios = true;
    const app = await reachInstallStep();
    await vi.waitFor(() => expect(app.querySelector('#install-continue')).not.toBeNull());
    app.querySelector('#install-continue').click();
    await vi.waitFor(() => expect(globalThis.location.href).toBe('/'));
  });

  it('reaches the app from Skip for now', async () => {
    ios = true;
    const app = await reachInstallStep();
    await vi.waitFor(() => expect(app.querySelector('#install-skip')).not.toBeNull());
    app.querySelector('#install-skip').click();
    await vi.waitFor(() => expect(globalThis.location.href).toBe('/'));
  });
});

describe('install step: Android/desktop', () => {
  it('offers a one-tap install when the browser fired beforeinstallprompt', async () => {
    const evt = fireBeforeInstallPrompt();
    const app = await reachInstallStep();
    await vi.waitFor(() => expect(app.querySelector('#install-now')).not.toBeNull());
    // The browser event was captured and suppressed, not left to the default UI.
    expect(evt.preventDefault).toHaveBeenCalled();

    app.querySelector('#install-now').click();
    await vi.waitFor(() => expect(globalThis.location.href).toBe('/'));
    expect(evt.prompt).toHaveBeenCalled();
  });

  it('still reaches the app if the native prompt throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fireBeforeInstallPrompt({ throwOnPrompt: true });
    const app = await reachInstallStep();
    await vi.waitFor(() => expect(app.querySelector('#install-now')).not.toBeNull());

    app.querySelector('#install-now').click();
    await vi.waitFor(() => expect(globalThis.location.href).toBe('/'));
  });

  it('falls back to a browser-menu hint when no install prompt is available', async () => {
    const app = await reachInstallStep();
    await vi.waitFor(() => expect(app.querySelector('#install-skip')).not.toBeNull());

    expect(app.querySelector('#install-now')).toBeNull();
    expect(app.textContent).toContain('Install app');
    // Skip is always present so signup can complete.
    app.querySelector('#install-skip').click();
    await vi.waitFor(() => expect(globalThis.location.href).toBe('/'));
  });
});
