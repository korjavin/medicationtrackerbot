import { afterEach, describe, expect, it, vi } from 'vitest';
import { forwardableShareFragment, runUnlockFlow } from '../unlock.js';

// Unlock-shell side of the shared-plan fragment round-trip (bd med-uo64.3):
// only #share-plan= rides between / and /unlock (cloud-boot.js forwards it
// here; the warm/cold success paths hand it back to /). Anything else —
// notably #claim= — must not forward, or the two shells ping-pong forever.
// runUnlockFlow is exercised with a fake document: no cached LDK (no
// indexedDB under node) falls through to the cold renderLocked screen.
describe('unlock share-plan fragment (med-uo64.3)', () => {
  it('forwardableShareFragment passes through only #share-plan=', () => {
    expect(forwardableShareFragment('#share-plan=p1.abc')).toBe('#share-plan=p1.abc');
    expect(forwardableShareFragment('#claim=tok123')).toBe('');
    expect(forwardableShareFragment('#other=x')).toBe('');
    expect(forwardableShareFragment('')).toBe('');
    expect(forwardableShareFragment(null)).toBe('');
    expect(forwardableShareFragment(undefined)).toBe('');
  });

  describe('cold unlock hint', () => {
    // Node 21+ ships navigator/location as getter-only globals — plain
    // assignment throws, so install fakes via defineProperty and restore
    // the original descriptors afterwards.
    const GLOBAL_KEYS = ['document', 'location', 'navigator'];
    const savedDesc = {};
    for (const key of GLOBAL_KEYS) {
      savedDesc[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    }
    function setGlobal(key, value) {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    afterEach(() => {
      for (const key of GLOBAL_KEYS) {
        if (!savedDesc[key]) delete globalThis[key];
        else Object.defineProperty(globalThis, key, savedDesc[key]);
      }
    });

    function fakeApp() {
      const listeners = {};
      const buttons = {
        '#unlock-button': { addEventListener: (ev, fn) => { listeners[`unlock:${ev}`] = fn; }, textContent: '' },
        '#share-plan-copy-button': { addEventListener: (ev, fn) => { listeners[`copy:${ev}`] = fn; }, textContent: 'Copy link' },
      };
      return {
        innerHTML: '',
        _listeners: listeners,
        _buttons: buttons,
        querySelector: (sel) => buttons[sel] || null,
      };
    }

    async function runColdUnlock({ hash, href }) {
      const app = fakeApp();
      setGlobal('location', { hash, href });
      setGlobal('document', { getElementById: (id) => (id === 'app' ? app : null) });
      await runUnlockFlow();
      return app;
    }

    it('renders the paste hint + Copy button when the fragment is present, and Copy copies the link', async () => {
      const href = 'https://acct.example.test/unlock#share-plan=p1.abc';
      const app = await runColdUnlock({ hash: '#share-plan=p1.abc', href });
      expect(app.innerHTML).toContain('share-plan-copy-button');
      expect(app.innerHTML).toContain('Import plan');

      const writeText = vi.fn(async () => {});
      setGlobal('navigator', { clipboard: { writeText } });
      await app._listeners['copy:click']();
      expect(writeText).toHaveBeenCalledWith(href);
      expect(app._buttons['#share-plan-copy-button'].textContent).toBe('Copied');
    });

    it('copy falls back to a by-hand hint when no clipboard is available', async () => {
      const app = await runColdUnlock({ hash: '#share-plan=p1.abc', href: 'https://acct.example.test/unlock#share-plan=p1.abc' });
      setGlobal('navigator', undefined);
      await app._listeners['copy:click']();
      expect(app._buttons['#share-plan-copy-button'].textContent).toBe('Copy this link by hand');
    });

    it('renders no hint without the fragment, and none for #claim=', async () => {
      const plain = await runColdUnlock({ hash: '', href: 'https://acct.example.test/unlock' });
      expect(plain.innerHTML).not.toContain('share-plan-copy-button');
      expect(plain.innerHTML).toContain('unlock-button');

      const claim = await runColdUnlock({ hash: '#claim=tok123', href: 'https://acct.example.test/unlock#claim=tok123' });
      expect(claim.innerHTML).not.toContain('share-plan-copy-button');
    });
  });
});
