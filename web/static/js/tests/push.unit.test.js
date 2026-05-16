import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPushEnv } from './helpers/push-harness.js';

describe('push.js PushManager', () => {
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('initialize returns false when push is not supported', async () => {
    const { window, cleanup } = loadPushEnv({ support: false });

    try {
      const ok = await window.MedTrackerPush.initialize();
      expect(ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('initialize loads VAPID key and existing subscription', async () => {
    const { window, registration, makeSubscription, cleanup } = loadPushEnv();

    try {
      const existingSub = makeSubscription();
      const getSubSpy = vi.fn().mockResolvedValue(existingSub);
      registration.pushManager.getSubscription = getSubSpy;

      window.fetch = vi.fn().mockResolvedValue({
        ok: true,
        async json() { return { public_key: 'BEl6nA' }; }
      });

      const ok = await window.MedTrackerPush.initialize();

      expect(ok).toBe(true);
      expect(window.MedTrackerPush.vapidPublicKey).toBe('BEl6nA');
      expect(window.MedTrackerPush.subscription).toBe(existingSub);
      expect(window.fetch).toHaveBeenCalledWith('/api/webpush/vapid-public-key', expect.objectContaining({
        headers: expect.any(Object)
      }));
      expect(getSubSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('initialize returns false when VAPID key fetch throws', async () => {
    const { window, cleanup } = loadPushEnv();

    try {
      window.fetch = vi.fn().mockRejectedValue(new Error('network down'));

      const ok = await window.MedTrackerPush.initialize();

      expect(ok).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('initialize tolerates getSubscription failure and still returns true', async () => {
    const { window, registration, cleanup } = loadPushEnv();

    try {
      registration.pushManager.getSubscription = vi.fn().mockRejectedValue(new Error('subscription broken'));
      window.fetch = vi.fn().mockResolvedValue({
        ok: true,
        async json() { return { public_key: 'BEl6nA' }; }
      });

      const ok = await window.MedTrackerPush.initialize();

      expect(ok).toBe(true);
      expect(window.MedTrackerPush.vapidPublicKey).toBe('BEl6nA');
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('subscribe returns false when notification permission is denied', async () => {
    const { window, cleanup } = loadPushEnv();

    try {
      window.MedTrackerPush.vapidPublicKey = 'BEl6nA';
      window.Notification.requestPermission = vi.fn().mockResolvedValue('denied');

      const ok = await window.MedTrackerPush.subscribe();

      expect(ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('subscribe creates subscription and posts it to backend', async () => {
    const { window, registration, makeSubscription, cleanup } = loadPushEnv();

    try {
      const sub = makeSubscription();
      registration.pushManager.subscribe = vi.fn().mockResolvedValue(sub);
      window.MedTrackerPush.vapidPublicKey = 'BEl6nA';
      window.Notification.requestPermission = vi.fn().mockResolvedValue('granted');

      window.fetch = vi.fn().mockResolvedValue({ ok: true });

      const ok = await window.MedTrackerPush.subscribe();

      expect(ok).toBe(true);
      expect(window.MedTrackerPush.subscription).toBe(sub);
      expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1);

      expect(window.fetch).toHaveBeenCalledWith('/api/webpush/subscribe', expect.objectContaining({
        method: 'POST'
      }));
    } finally {
      cleanup();
    }
  });

  it('subscribe returns false when browser subscribe throws', async () => {
    const { window, registration, cleanup } = loadPushEnv();

    try {
      window.MedTrackerPush.vapidPublicKey = 'BEl6nA';
      window.MedTrackerPush.subscription = { endpoint: 'https://push.example/existing' };
      window.Notification.requestPermission = vi.fn().mockResolvedValue('granted');
      registration.pushManager.subscribe = vi.fn().mockRejectedValue(new Error('subscribe failed'));

      const ok = await window.MedTrackerPush.subscribe();

      expect(ok).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('unsubscribe returns true when there is no active subscription', async () => {
    const { window, cleanup } = loadPushEnv();

    try {
      window.MedTrackerPush.subscription = null;
      const ok = await window.MedTrackerPush.unsubscribe();
      expect(ok).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('unsubscribe calls browser and backend unsubscribe and clears local state', async () => {
    const { window, makeSubscription, cleanup } = loadPushEnv();

    try {
      const sub = makeSubscription();
      const unsubSpy = vi.spyOn(sub, 'unsubscribe').mockResolvedValue(true);
      window.MedTrackerPush.subscription = sub;
      window.fetch = vi.fn().mockResolvedValue({ ok: true });

      const ok = await window.MedTrackerPush.unsubscribe();

      expect(ok).toBe(true);
      expect(unsubSpy).toHaveBeenCalledTimes(1);
      expect(window.fetch).toHaveBeenCalledWith('/api/webpush/unsubscribe', expect.objectContaining({ method: 'POST' }));
      expect(window.MedTrackerPush.subscription).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('unsubscribe returns false when browser unsubscribe throws', async () => {
    const { window, makeSubscription, cleanup } = loadPushEnv();

    try {
      const sub = makeSubscription();
      vi.spyOn(sub, 'unsubscribe').mockRejectedValue(new Error('cannot unsubscribe'));
      window.MedTrackerPush.subscription = sub;

      const ok = await window.MedTrackerPush.unsubscribe();

      expect(ok).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  describe('auth-header routing (auth-header consolidation plan)', () => {
    it('initialize sends X-Telegram-Init-Data via makeAuthHeaders on the VAPID fetch', async () => {
      const { window, cleanup } = loadPushEnv();

      try {
        window.userInitData = 'init=stub';
        window.fetch = vi.fn().mockResolvedValue({
          ok: true,
          async json() { return { public_key: 'BEl6nA' }; }
        });

        await window.MedTrackerPush.initialize();

        const [, init] = window.fetch.mock.calls[0];
        expect(init).toBeDefined();
        expect(init.headers).toBeDefined();
        expect(init.headers['X-Telegram-Init-Data']).toBe('init=stub');
      } finally {
        cleanup();
      }
    });

    it('subscribe sends X-Telegram-Init-Data via makeAuthHeaders on POST /subscribe', async () => {
      const { window, registration, makeSubscription, cleanup } = loadPushEnv();

      try {
        window.userInitData = 'init=stub';
        const sub = makeSubscription();
        registration.pushManager.subscribe = vi.fn().mockResolvedValue(sub);
        window.MedTrackerPush.vapidPublicKey = 'BEl6nA';
        window.Notification.requestPermission = vi.fn().mockResolvedValue('granted');
        window.fetch = vi.fn().mockResolvedValue({ ok: true });

        await window.MedTrackerPush.subscribe();

        const [url, init] = window.fetch.mock.calls[0];
        expect(url).toBe('/api/webpush/subscribe');
        expect(init.headers['X-Telegram-Init-Data']).toBe('init=stub');
        expect(init.headers['Content-Type']).toBe('application/json');
      } finally {
        cleanup();
      }
    });

    it('unsubscribe sends X-Telegram-Init-Data via makeAuthHeaders on POST /unsubscribe', async () => {
      const { window, makeSubscription, cleanup } = loadPushEnv();

      try {
        window.userInitData = 'init=stub';
        const sub = makeSubscription();
        vi.spyOn(sub, 'unsubscribe').mockResolvedValue(true);
        window.MedTrackerPush.subscription = sub;
        window.fetch = vi.fn().mockResolvedValue({ ok: true });

        await window.MedTrackerPush.unsubscribe();

        const [url, init] = window.fetch.mock.calls[0];
        expect(url).toBe('/api/webpush/unsubscribe');
        expect(init.headers['X-Telegram-Init-Data']).toBe('init=stub');
        expect(init.headers['Content-Type']).toBe('application/json');
      } finally {
        cleanup();
      }
    });

    it('omits X-Telegram-Init-Data when userInitData is absent (cookie-auth path)', async () => {
      const { window, registration, makeSubscription, cleanup } = loadPushEnv();

      try {
        delete window.userInitData;
        const sub = makeSubscription();
        registration.pushManager.subscribe = vi.fn().mockResolvedValue(sub);
        window.MedTrackerPush.vapidPublicKey = 'BEl6nA';
        window.Notification.requestPermission = vi.fn().mockResolvedValue('granted');
        window.fetch = vi.fn().mockResolvedValue({ ok: true });

        await window.MedTrackerPush.subscribe();

        const [, init] = window.fetch.mock.calls[0];
        expect(init.headers['X-Telegram-Init-Data']).toBeUndefined();
        expect(init.headers['Content-Type']).toBe('application/json');
      } finally {
        cleanup();
      }
    });
  });

  it('urlBase64ToUint8Array and arrayBufferToBase64 convert payloads consistently', () => {
    const { window, cleanup } = loadPushEnv();

    try {
      const bytes = window.MedTrackerPush.urlBase64ToUint8Array('AQID');
      expect(Array.from(bytes)).toEqual([1, 2, 3]);

      const encoded = window.MedTrackerPush.arrayBufferToBase64(new Uint8Array([4, 5, 6]).buffer);
      expect(encoded).toBe('BAUG');
    } finally {
      cleanup();
    }
  });
});
