// Share-a-plan sender UI (bd med-uo64.2): token codec + Share icon → modal
// (QR / copy link / navigator.share). Mirrors the print-test patterns in
// features.workout-groups.test.js; the harness lends Response +
// Compression/DecompressionStream to the window so the real gzip codec runs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const GROUP = { id: 5, name: 'Push / Pull', is_rotating: false, active: true, days_of_week: '[1,3]', scheduled_time: '18:00' };

const EXPORT = {
  v: 1,
  plan: {
    name: 'Push / Pull',
    is_rotating: false,
    days_of_week: '[1,3]',
    scheduled_time: '18:00',
    days: [
      {
        name: 'Main',
        exercises: [
          { id: 1, exercise_name: 'Bench press' },
          { id: 2, exercise_name: 'Barbell row' },
        ],
      },
    ],
    library: [],
  },
};

function stubExport(window, payload = EXPORT) {
  window.apiCall = vi.fn(async (url) => {
    if (String(url).startsWith('/api/workout/plans/export')) return payload;
    return null;
  });
}

function stubQr(window) {
  window.WorkoutShare.makeQr = vi.fn(async () => '<svg data-qr="1"></svg>');
}

function modal(window) {
  return window.document.getElementById('workout-share-modal');
}

describe('features/workout/share.js — token codec (med-uo64.2)', () => {
  let env;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    env = loadFrontendEnv({ withWorkout: true });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    env.cleanup();
    env = null;
  });

  it('exposes the WorkoutShare public-API namespace', () => {
    const { window } = env;
    expect(window.WorkoutShare).toBeTypeOf('object');
    for (const key of ['share', 'encode', 'decode', 'buildUrl', 'close']) {
      expect(window.WorkoutShare[key]).toBeTypeOf('function');
    }
  });

  it('encode → decode round-trips; decode is host-agnostic and null on garbage, never throws', async () => {
    const { window } = env;
    const token = await window.WorkoutShare.encode(EXPORT);
    expect(token.startsWith('p1.')).toBe(true);

    // Bare token.
    expect(await window.WorkoutShare.decode(token)).toEqual(EXPORT);

    // Full URL and URL-with-noise (whatever the camera/clipboard delivers).
    const url = window.WorkoutShare.buildUrl(token);
    expect(url).toBe(`https://example.test/#share-plan=${token}`);
    expect(await window.WorkoutShare.decode(url)).toEqual(EXPORT);
    expect(await window.WorkoutShare.decode(`scan says: ${url} (tap to open)`)).toEqual(EXPORT);
    expect(await window.WorkoutShare.decode('https://other.host:8443/some/path#share-plan=' + token)).toEqual(EXPORT);

    // Garbage degrades to null — the printed-sheet QR, random text, a
    // future/wrong prefix, empties. None of these may throw.
    expect(await window.WorkoutShare.decode('workout-plan:1:7')).toBeNull();
    expect(await window.WorkoutShare.decode('hello world')).toBeNull();
    expect(await window.WorkoutShare.decode('p9.' + token.slice(3))).toBeNull();
    expect(await window.WorkoutShare.decode('')).toBeNull();
    expect(await window.WorkoutShare.decode(null)).toBeNull();
    expect(await window.WorkoutShare.decode(undefined)).toBeNull();
  });
});

describe('features/workout/share.js — Share icon + modal (med-uo64.2)', () => {
  let env;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    env = loadFrontendEnv({ withWorkout: true });
    env.window.Telegram.WebApp.showAlert = vi.fn();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
    env.cleanup();
    env = null;
  });

  it('every Plan row gets a Share button before Print that calls WorkoutShare.share with that group', () => {
    const { window, document } = env;
    const container = document.getElementById('workout-groups-list');
    window._renderWorkoutGroups(container, [GROUP, { ...GROUP, id: 6, name: 'Full body' }]);

    const buttons = container.querySelectorAll('button[aria-label="Share plan"]');
    expect(buttons.length).toBe(2);

    // Share sits before Print on the card.
    const firstRowActions = container.querySelectorAll('.wg-workouts-groups-row__actions')[0];
    const labels = Array.from(firstRowActions.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'));
    expect(labels[0]).toBe('Share plan');
    expect(labels[1]).toBe('Print plan');

    const shareSpy = vi.fn();
    window.WorkoutShare.share = shareSpy;
    const openEdit = vi.fn();
    window.showEditWorkoutGroupModal = openEdit;
    buttons[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    expect(shareSpy).toHaveBeenCalledTimes(1);
    expect(shareSpy.mock.calls[0][0].id).toBe(5);
    expect(openEdit).not.toHaveBeenCalled();
  });

  it('share(group) renders the modal with name, counts, link, and QR svg', async () => {
    const { window, document } = env;
    stubExport(window);
    stubQr(window);

    await window.WorkoutShare.share({ id: 5, name: 'Push / Pull' });

    expect(window.apiCall.mock.calls[0][0]).toBe('/api/workout/plans/export?id=5');
    expect(modal(window).classList.contains('hidden')).toBe(false);
    expect(document.getElementById('workout-share-title').textContent).toContain('Push / Pull');
    expect(document.getElementById('workout-share-counts').textContent).toBe('1 day · 2 exercises');
    const link = document.getElementById('workout-share-link');
    expect(link.value.startsWith('https://example.test/#share-plan=p1.')).toBe(true);
    // The token the link carries decodes back to the export payload.
    expect(await window.WorkoutShare.decode(link.value)).toEqual(EXPORT);
    expect(document.getElementById('workout-share-qr').querySelector('svg')).not.toBeNull();
    expect(document.getElementById('workout-share-qr-note').classList.contains('hidden')).toBe(true);
    expect(window.WorkoutShare.makeQr).toHaveBeenCalledTimes(1);
  });

  it('token past SHARE_QR_MAX_CHARS hides the QR with a note, copy still works', async () => {
    const { window, document } = env;
    stubExport(window);
    stubQr(window);
    // Deterministic oversize: the codec reads gzipString at call time.
    const realGzip = window.BackupCrypto.gzipString;
    window.BackupCrypto.gzipString = async () => new Uint8Array(5000).fill(7);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      await window.WorkoutShare.share({ id: 5, name: 'Push / Pull' });

      expect(window.WorkoutShare._current.token.length).toBeGreaterThan(1200);
      expect(document.getElementById('workout-share-qr').querySelector('svg')).toBeNull();
      expect(document.getElementById('workout-share-qr').classList.contains('hidden')).toBe(true);
      const note = document.getElementById('workout-share-qr-note');
      expect(note.classList.contains('hidden')).toBe(false);
      expect(note.textContent.length).toBeGreaterThan(0);
      expect(window.WorkoutShare.makeQr).not.toHaveBeenCalled();

      document.getElementById('workout-share-copy-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(String(writeText.mock.calls[0][0]).startsWith('https://example.test/#share-plan=p1.')).toBe(true);
    } finally {
      window.BackupCrypto.gzipString = realGzip;
      delete window.navigator.clipboard;
    }
  });

  it('Share… button only renders when navigator.share exists, and calls it with {title,url}', async () => {
    const { window, document } = env;
    stubExport(window);
    stubQr(window);

    // Absent by default in jsdom: no button.
    expect(window.navigator.share).toBeUndefined();
    await window.WorkoutShare.share({ id: 5, name: 'Push / Pull' });
    expect(document.getElementById('workout-share-native-btn').classList.contains('hidden')).toBe(true);

    // Present: button shows and hands the OS sheet title + url.
    const shareSpy = vi.fn(async () => {});
    window.navigator.share = shareSpy;
    try {
      await window.WorkoutShare.share({ id: 5, name: 'Push / Pull' });
      const nativeBtn = document.getElementById('workout-share-native-btn');
      expect(nativeBtn.classList.contains('hidden')).toBe(false);
      nativeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      expect(shareSpy).toHaveBeenCalledTimes(1);
      expect(shareSpy.mock.calls[0][0].title).toBe('Push / Pull');
      expect(String(shareSpy.mock.calls[0][0].url).startsWith('https://example.test/#share-plan=p1.')).toBe(true);
    } finally {
      delete window.navigator.share;
    }
  });

  it('empty plan toasts and never opens the modal', async () => {
    const { window, document } = env;
    stubExport(window, { v: 1, plan: { name: 'Empty', days: [], library: [] } });
    stubQr(window);
    const toastSpy = vi.fn();
    const realToast = window.safeToast;
    window.safeToast = toastSpy;
    try {
      await window.WorkoutShare.share({ id: 9, name: 'Empty' });
      expect(toastSpy).toHaveBeenCalledWith('Add some exercises to this plan first.', 'info');
      expect(modal(window).classList.contains('hidden')).toBe(true);
      expect(window.WorkoutShare.makeQr).not.toHaveBeenCalled();
    } finally {
      window.safeToast = realToast;
    }
  });

  it('close() hides the modal', async () => {
    const { window } = env;
    stubExport(window);
    stubQr(window);

    await window.WorkoutShare.share({ id: 5, name: 'Push / Pull' });
    expect(modal(window).classList.contains('hidden')).toBe(false);
    window.WorkoutShare.close();
    expect(modal(window).classList.contains('hidden')).toBe(true);
  });

  it('back closes the share modal via ModalManager.closeTopMostVisibleModal', async () => {
    const { window } = env;
    stubExport(window);
    stubQr(window);

    await window.WorkoutShare.share({ id: 5, name: 'Push / Pull' });
    expect(modal(window).classList.contains('hidden')).toBe(false);
    expect(window.ModalManager.closeTopMostVisibleModal()).toBe(true);
    expect(modal(window).classList.contains('hidden')).toBe(true);
  });
});

describe('features/workout/share.js — import receive path (med-uo64.3)', () => {
  let env;
  let consoleErrorSpy;

  const IMPORT_RES = { id: 42, name: 'Push / Pull', days: 1, exercises: 2, exercises_created: 2, exercises_matched: 0 };

  function stubImport(window, res = IMPORT_RES) {
    window.apiCall = vi.fn(async (url) => {
      if (String(url).startsWith('/api/workout/plans/import')) {
        if (res instanceof Error) throw res;
        return res;
      }
      return null;
    });
  }

  // Hermetic receive env: confirm + toast + every post-write refresh target
  // stubbed (mirrors workout.subtabs' loader stubs). The real
  // switchWorkoutTab still runs so the Plans-sub-tab persistence is proven.
  function stubReceiveEnv(window, { confirm = true } = {}) {
    vi.spyOn(window, 'safeConfirm').mockImplementation(async () => confirm);
    const toastSpy = vi.fn();
    window.SyncManager = { showToast: toastSpy };
    window.WorkoutGroups.load = vi.fn();
    window.WorkoutGroups.openEdit = vi.fn();
    window.switchTab = vi.fn();
    window.loadWorkoutGroups = vi.fn();
    window.invalidateWorkoutCache = vi.fn(async () => {});
    return toastSpy;
  }

  function importModal(document) {
    return document.getElementById('workout-share-import-modal');
  }

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    env = loadFrontendEnv({ withWorkout: true });
    env.window.Telegram.WebApp.showAlert = vi.fn();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
    env.cleanup();
    env = null;
  });

  it('receive() with a valid token confirms with name/counts, POSTs the decoded payload, refreshes, and opens Edit', async () => {
    const { window, document } = env;
    stubImport(window);
    const toastSpy = stubReceiveEnv(window);

    const token = await window.WorkoutShare.encode(EXPORT);
    await window.WorkoutShare.receive(token);

    expect(window.safeConfirm).toHaveBeenCalledWith('Import "Push / Pull"? 1 day(s), 2 exercise(s).');
    expect(window.apiCall).toHaveBeenCalledWith('/api/workout/plans/import', 'POST', EXPORT, { suppressWriteAlert: true });
    expect(toastSpy).toHaveBeenCalledWith('Added "Push / Pull"', 'info');
    expect(window.invalidateWorkoutCache).toHaveBeenCalledTimes(1);
    expect(window.WorkoutGroups.load).toHaveBeenCalledTimes(1);
    expect(window.switchTab).toHaveBeenCalledWith('workouts');
    // Real switchWorkoutTab ran: Plans sub-tab persisted + groups reloaded.
    expect(window.localStorage.getItem('mt-workouts-subtab')).toBe('groups');
    expect(window.loadWorkoutGroups).toHaveBeenCalled();
    expect(window.WorkoutGroups.openEdit).toHaveBeenCalledWith(42);
    // Success closes the import modal.
    expect(importModal(document).classList.contains('hidden')).toBe(true);
  });

  it('receive() with garbage toasts and never POSTs', async () => {
    const { window } = env;
    stubImport(window);
    const toastSpy = stubReceiveEnv(window);

    await window.WorkoutShare.receive('hello world');

    expect(toastSpy).toHaveBeenCalledWith("That's not a workout plan link.", 'error');
    expect(window.safeConfirm).not.toHaveBeenCalled();
    expect(window.apiCall).not.toHaveBeenCalled();
    expect(window.WorkoutGroups.openEdit).not.toHaveBeenCalled();
  });

  it('receive() cancelled at confirm never POSTs', async () => {
    const { window } = env;
    stubImport(window);
    const toastSpy = stubReceiveEnv(window, { confirm: false });

    const token = await window.WorkoutShare.encode(EXPORT);
    await window.WorkoutShare.receive(token);

    expect(window.safeConfirm).toHaveBeenCalledTimes(1);
    expect(window.apiCall).not.toHaveBeenCalled();
    expect(toastSpy).not.toHaveBeenCalled();
    expect(window.WorkoutGroups.openEdit).not.toHaveBeenCalled();
  });

  it('receive() with printed-sheet QR text gives the sheet-specific toast, no POST', async () => {
    const { window } = env;
    stubImport(window);
    const toastSpy = stubReceiveEnv(window);

    await window.WorkoutShare.receive('workout-plan:1:7');

    expect(toastSpy).toHaveBeenCalledWith("That's a printed sheet code — use Scan filled sheet.", 'info');
    expect(window.safeConfirm).not.toHaveBeenCalled();
    expect(window.apiCall).not.toHaveBeenCalled();
  });

  it('a 400 from the import route toasts the message and never opens Edit', async () => {
    const { window } = env;
    stubImport(window, new Error('plan.days must be an array'));
    const toastSpy = stubReceiveEnv(window);

    const token = await window.WorkoutShare.encode(EXPORT);
    await window.WorkoutShare.receive(token);

    expect(toastSpy).toHaveBeenCalledWith('plan.days must be an array', 'error');
    expect(window.WorkoutGroups.openEdit).not.toHaveBeenCalled();
  });

  it('a null import result toasts the offline message', async () => {
    const { window } = env;
    stubImport(window, null);
    const toastSpy = stubReceiveEnv(window);

    const token = await window.WorkoutShare.encode(EXPORT);
    await window.WorkoutShare.receive(token);

    expect(toastSpy).toHaveBeenCalledWith("Couldn't import the plan — try again online.", 'error');
    expect(window.WorkoutGroups.openEdit).not.toHaveBeenCalled();
  });

  it('paste-field Import triggers receive with the field value', async () => {
    const { window, document } = env;
    stubImport(window);
    stubReceiveEnv(window);

    const token = await window.WorkoutShare.encode(EXPORT);
    document.getElementById('workout-share-import-input').value = token;
    document.getElementById('workout-share-import-submit-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() => expect(window.apiCall).toHaveBeenCalledWith(
      '/api/workout/plans/import', 'POST', EXPORT, { suppressWriteAlert: true }));
    expect(window.WorkoutGroups.openEdit).toHaveBeenCalledWith(42);
  });

  it('Scan button live-decodes via window.Barcode, receives the URL, and stops the stream', async () => {
    const { window, document } = env;
    stubImport(window);
    stubReceiveEnv(window);
    try { Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true }); } catch (_) { window.isSecureContext = true; }

    const token = await window.WorkoutShare.encode(EXPORT);
    const url = window.WorkoutShare.buildUrl(token);
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] };
    window.MediaCapture = { openCameraStream: vi.fn(async () => stream) };
    const scanSpy = vi.fn(async () => ({ rawValue: url }));
    window.Barcode = { scan: scanSpy, supportsLiveScan: () => true };
    const video = document.getElementById('workout-share-import-video');
    Object.defineProperty(video, 'readyState', { configurable: true, value: 4 });
    video.play = vi.fn(async () => {});

    document.getElementById('workout-share-import-scan-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() => expect(window.apiCall).toHaveBeenCalledWith(
      '/api/workout/plans/import', 'POST', EXPORT, { suppressWriteAlert: true }));
    expect(window.MediaCapture.openCameraStream).toHaveBeenCalledWith({ facingMode: 'environment' });
    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(scanSpy.mock.calls[0][0].source).toBe(video);
    expect(scanSpy.mock.calls[0][0].formats).toEqual(['qr_code']);
    expect(window.WorkoutGroups.openEdit).toHaveBeenCalledWith(42);
    // First decode stops the camera: tracks stopped, state cleared, preview hidden.
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(window.WorkoutShare._scan.stream).toBeNull();
    expect(window.WorkoutShare._scan.running).toBe(false);
    expect(video.classList.contains('hidden')).toBe(true);
  });

  it('Import plan button opens the modal and clears the field; back closes it and stops the camera', async () => {
    const { window, document } = env;
    const modal = importModal(document);
    expect(modal.classList.contains('hidden')).toBe(true);

    document.getElementById('workout-share-import-input').value = 'stale';
    document.getElementById('import-workout-plan-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(modal.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('workout-share-import-input').value).toBe('');

    // A live stream in progress must die with the modal (back gesture).
    const stopTrack = vi.fn();
    window.WorkoutShare._scan.stream = { getTracks: () => [{ stop: stopTrack }] };
    window.WorkoutShare._scan.running = true;
    expect(window.ModalManager.closeTopMostVisibleModal()).toBe(true);
    expect(modal.classList.contains('hidden')).toBe(true);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(window.WorkoutShare._scan.running).toBe(false);
    expect(window.WorkoutShare._scan.stream).toBeNull();
  });
});

describe('features/workout/share.js — review regressions (med-uo64.3 round 01)', () => {
  let env;
  let consoleErrorSpy;

  const IMPORT_RES = { id: 42, name: 'Push / Pull', days: 1, exercises: 2, exercises_created: 2, exercises_matched: 0 };

  function stubImport(window) {
    window.apiCall = vi.fn(async (url) => {
      if (String(url).startsWith('/api/workout/plans/import')) return IMPORT_RES;
      return null;
    });
  }

  function stubReceiveEnv(window) {
    vi.spyOn(window, 'safeConfirm').mockImplementation(async () => true);
    const toastSpy = vi.fn();
    window.SyncManager = { showToast: toastSpy };
    window.WorkoutGroups.openEdit = vi.fn();
    window.switchTab = vi.fn();
    window.loadWorkoutGroups = vi.fn();
    window.invalidateWorkoutCache = vi.fn(async () => {});
    return toastSpy;
  }

  function stubCamera(window, document, { rawValue }) {
    try { Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true }); } catch (_) { window.isSecureContext = true; }
    window.Barcode = { scan: vi.fn(async () => ({ rawValue })), supportsLiveScan: () => true };
    const video = document.getElementById('workout-share-import-video');
    Object.defineProperty(video, 'readyState', { configurable: true, value: 4 });
    video.play = vi.fn(async () => {});
    return video;
  }

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    env = loadFrontendEnv({ withWorkout: true });
    env.window.Telegram.WebApp.showAlert = vi.fn();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
    env.cleanup();
    env = null;
  });

  it('openEdit runs only after the Plans reload lands (Edit screen no longer skipped)', async () => {
    const { window } = env;
    stubImport(window);
    stubReceiveEnv(window);

    // A slow reload: if receive() didn't await load(), openEdit would run first.
    const order = [];
    window.WorkoutGroups.load = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('load');
    });
    window.WorkoutGroups.openEdit = vi.fn(() => { order.push('openEdit'); });

    const token = await window.WorkoutShare.encode(EXPORT);
    await window.WorkoutShare.receive(token);

    expect(order).toEqual(['load', 'openEdit']);
  });

  it('oversize input is rejected before the gunzip', async () => {
    const { window } = env;
    stubImport(window);
    const toastSpy = stubReceiveEnv(window);
    // Pins SHARE_IMPORT_MAX_TOKEN_CHARS: 100000 As is over the cap yet
    // valid base64 length (100000 % 4 == 0), so with the cap deleted decode
    // would reach gunzipToString and this spy would fire.
    const gunzipSpy = vi.spyOn(window.BackupCrypto, 'gunzipToString');

    await window.WorkoutShare.receive(`p1.${'A'.repeat(100000)}`);

    expect(toastSpy).toHaveBeenCalledWith("That's not a workout plan link.", 'error');
    expect(gunzipSpy).not.toHaveBeenCalled();
    expect(window.apiCall).not.toHaveBeenCalled();
  });

  it('a second Scan tap while the camera request is in flight opens no second stream', async () => {
    const { window, document } = env;
    stubImport(window);
    stubReceiveEnv(window);
    const token = await window.WorkoutShare.encode(EXPORT);
    stubCamera(window, document, { rawValue: window.WorkoutShare.buildUrl(token) });

    let resolveStream;
    const stopTrack = vi.fn();
    window.MediaCapture = {
      openCameraStream: vi.fn(() => new Promise((r) => { resolveStream = r; })),
    };

    const scanBtn = document.getElementById('workout-share-import-scan-btn');
    scanBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    scanBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(window.MediaCapture.openCameraStream).toHaveBeenCalledTimes(1);

    resolveStream({ getTracks: () => [{ stop: stopTrack }] });
    await vi.waitFor(() => expect(window.apiCall).toHaveBeenCalled());
    expect(window.WorkoutGroups.openEdit).toHaveBeenCalledWith(42);
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });


  it('a superseded acquire releases its stream instead of hijacking the new scan', async () => {
    // tap1 (S1 deferred) → cancel → tap2 (S2 deferred) → S1 resolves late.
    // Without generations S1 lands in tap2's tenure, overwrites st.stream,
    // and orphans S2's camera (released never, scanning on the wrong stream).
    const { window, document } = env;
    stubImport(window);
    stubReceiveEnv(window);
    const token = await window.WorkoutShare.encode(EXPORT);
    stubCamera(window, document, { rawValue: window.WorkoutShare.buildUrl(token) });

    const stopTrack1 = vi.fn();
    const stopTrack2 = vi.fn();
    let resolveS1;
    let resolveS2;
    window.MediaCapture = {
      openCameraStream: vi.fn()
        .mockImplementationOnce(() => new Promise((r) => { resolveS1 = r; }))
        .mockImplementationOnce(() => new Promise((r) => { resolveS2 = r; })),
    };

    const scanBtn = document.getElementById('workout-share-import-scan-btn');
    scanBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(window.MediaCapture.openCameraStream).toHaveBeenCalledTimes(1));
    document.getElementById('workout-share-import-cancel-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    scanBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(window.MediaCapture.openCameraStream).toHaveBeenCalledTimes(2));

    // The stale acquire resolves into the new start's tenure: released.
    resolveS1({ getTracks: () => [{ stop: stopTrack1 }] });
    await vi.waitFor(() => expect(stopTrack1).toHaveBeenCalledTimes(1));
    expect(window.WorkoutShare._scan.stream).toBeNull();
    expect(window.WorkoutShare._scan.running).toBe(false);

    // The current acquire delivers end to end on its own stream.
    resolveS2({ getTracks: () => [{ stop: stopTrack2 }] });
    await vi.waitFor(() => expect(window.apiCall).toHaveBeenCalledWith(
      '/api/workout/plans/import', 'POST', EXPORT, { suppressWriteAlert: true }));
    expect(window.WorkoutGroups.openEdit).toHaveBeenCalledWith(42);
    expect(stopTrack1).toHaveBeenCalledTimes(1);
  });

  it('closing during preview warm-up releases everything and leaves Scan working', async () => {
    const { window, document } = env;
    stubImport(window);
    stubReceiveEnv(window);
    const token = await window.WorkoutShare.encode(EXPORT);
    stubCamera(window, document, { rawValue: window.WorkoutShare.buildUrl(token) });

    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] };
    window.MediaCapture = { openCameraStream: vi.fn(async () => stream) };
    const video = document.getElementById('workout-share-import-video');
    let resolvePlay;
    video.play = vi.fn(() => new Promise((r) => { resolvePlay = r; }));

    document.getElementById('workout-share-import-scan-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    // Wait for play(), not just the open call: waitFor can pass
    // synchronously right after the stub is invoked, before the awaiting
    // continuation assigns the stream and reaches preview warm-up.
    await vi.waitFor(() => expect(video.play).toHaveBeenCalledTimes(1));
    // Camera acquired, preview still warming up — Cancel now.
    document.getElementById('workout-share-import-cancel-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    resolvePlay();
    await Promise.resolve();
    await Promise.resolve();

    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(window.WorkoutShare._scan.stream).toBeNull();
    expect(window.WorkoutShare._scan.running).toBe(false);
    expect(window.Barcode.scan).not.toHaveBeenCalled();
    expect(window.apiCall).not.toHaveBeenCalled();

    // Not bricked: Scan starts a fresh stream afterwards. The second
    // decode pends so `running` stays put for the assertion (an instant
    // decode would stop the loop again before the poll lands).
    window.Barcode.scan = vi.fn(() => new Promise(() => {}));
    video.play.mockResolvedValue();
    document.getElementById('workout-share-import-scan-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(window.WorkoutShare._scan.running).toBe(true));
    expect(window.MediaCapture.openCameraStream).toHaveBeenCalledTimes(2);
    window.WorkoutShare.closeImport();
  });

  it('closing while the camera request is in flight releases the late stream and never scans', async () => {
    const { window, document } = env;
    stubImport(window);
    stubReceiveEnv(window);
    const token = await window.WorkoutShare.encode(EXPORT);
    const video = stubCamera(window, document, { rawValue: window.WorkoutShare.buildUrl(token) });
    void video;

    let resolveStream;
    const stopTrack = vi.fn();
    window.MediaCapture = {
      openCameraStream: vi.fn(() => new Promise((r) => { resolveStream = r; })),
    };

    document.getElementById('workout-share-import-scan-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    document.getElementById('workout-share-import-cancel-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    resolveStream({ getTracks: () => [{ stop: stopTrack }] });
    await vi.waitFor(() => expect(stopTrack).toHaveBeenCalledTimes(1));

    expect(window.WorkoutShare._scan.stream).toBeNull();
    expect(window.WorkoutShare._scan.running).toBe(false);
    expect(window.Barcode.scan).not.toHaveBeenCalled();
    expect(window.apiCall).not.toHaveBeenCalled();
  });

  it('a guard early-return leaves Scan re-tappable (starting stays false, med-uo64.5)', async () => {
    // Non-secure context: the isSecureContext guard fires before any camera
    // request. starting must stay false so the second Scan tap re-attempts
    // (re-renders the hint) instead of hitting the re-entrancy guard inert.
    const { window, document } = env;
    stubImport(window);
    stubReceiveEnv(window);
    try { Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true }); } catch (_) { window.isSecureContext = false; }
    window.MediaCapture = { openCameraStream: vi.fn(async () => ({ getTracks: () => [] })) };

    const scanBtn = document.getElementById('workout-share-import-scan-btn');
    const status = document.getElementById('workout-share-import-status');
    scanBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(window.MediaCapture.openCameraStream).not.toHaveBeenCalled();
    expect(window.WorkoutShare._scan.starting).toBe(false);
    expect(status.textContent).toContain('HTTPS');

    // Clear the hint: only a second tap that passes the re-entrancy guard and
    // reaches the isSecureContext guard rewrites it. An inert second tap
    // (e.g. a sticky flag set before the guards) would leave this empty.
    status.textContent = '';
    scanBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(window.MediaCapture.openCameraStream).not.toHaveBeenCalled();
    expect(window.WorkoutShare._scan.starting).toBe(false);
    expect(status.textContent).toContain('HTTPS');
    expect(window.apiCall).not.toHaveBeenCalled();
  });
});

describe('features/workout/share.js — blind short link (med-1yi5.3)', () => {
  let env;
  let consoleErrorSpy;

  // Epic med-1yi5 golden vector (WebCrypto-produced). The trailing '.' in the
  // epic text is sentence punctuation, not wire bytes — the constant below is
  // the dotless std-base64 wire value.
  const GOLDEN_K = 'ABEiM0RVZneImaq7zN3u_w';
  const GOLDEN_NONCE = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const GOLDEN_PLAINTEXT = 'p1.H4sIAAAAAAAAA6tWSkksSVSyUlAqSy0qzszPU9JRUEpJLElUslIqTUlXqgUAcx1dxx4AAAA';
  const GOLDEN_PACKED = 'AQIDBAUGBwgJCgsMlrcA1gUMJUwCZ2azpTvldqBeivRyBn8Egd/HzcfKBxiMz6ddeZ1b7GVg3mXNe+7fy4twqSSKFUK2gukPwV4h5cTEpgLiSx4+ugIkgK12YG+cp1M3fJstai2c';
  const GOLDEN_SHORT = `https://cloud.example.com/s/Ab3kZ9xQ2m#${GOLDEN_K}`;

  function goldenKeyBytes() {
    return Uint8Array.from([...Array(16)].map((_, i) => i * 0x11));
  }

  // jsdom's window.crypto has getRandomValues but no subtle — lend Node's
  // full WebCrypto (the same pattern the harness uses for Response and the
  // Compression streams). jsdom exposes crypto as a configurable getter, so
  // this replaces it for the life of the env.
  function lendWebCrypto(window) {
    Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true });
  }

  const IMPORT_RES = { id: 42, name: 'Push / Pull', days: 1, exercises: 2, exercises_created: 2, exercises_matched: 0 };

  function stubReceiveEnv(window, { confirm = true } = {}) {
    vi.spyOn(window, 'safeConfirm').mockImplementation(async () => confirm);
    const toastSpy = vi.fn();
    window.SyncManager = { showToast: toastSpy };
    window.WorkoutGroups.load = vi.fn();
    window.WorkoutGroups.openEdit = vi.fn();
    window.switchTab = vi.fn();
    window.loadWorkoutGroups = vi.fn();
    window.invalidateWorkoutCache = vi.fn(async () => {});
    return toastSpy;
  }

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    env = loadFrontendEnv({ withWorkout: true });
    env.window.Telegram.WebApp.showAlert = vi.fn();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
    env.cleanup();
    env = null;
  });

  it('golden vector: encrypt reproduces the epic packed blob; decrypt yields the epic plaintext', async () => {
    const { window } = env;
    lendWebCrypto(window);

    const packed = await window.WorkoutShare._shortLink.encrypt(GOLDEN_PLAINTEXT, goldenKeyBytes(), GOLDEN_NONCE);
    expect(Buffer.from(packed).toString('base64')).toBe(GOLDEN_PACKED);
    expect(await window.WorkoutShare._shortLink.decrypt(GOLDEN_K, GOLDEN_PACKED)).toBe(GOLDEN_PLAINTEXT);
  });

  it('decrypt is null (never throws) on wrong K, corrupt ct, and oversize blobs', async () => {
    const { window } = env;
    lendWebCrypto(window);
    const { decrypt } = window.WorkoutShare._shortLink;

    const wrongK = `AA${GOLDEN_K.slice(2)}`;
    expect(await decrypt(wrongK, GOLDEN_PACKED)).toBeNull();
    expect(await decrypt(GOLDEN_K, GOLDEN_PACKED.slice(0, -4) + 'AAAA')).toBeNull();
    expect(await decrypt(GOLDEN_K, '!!!not-base64!!!')).toBeNull();
    expect(await decrypt('short', GOLDEN_PACKED)).toBeNull();
    // 16385 zero bytes as std base64 — over the 16384 cap, never decrypted.
    const huge = Buffer.alloc(16385).toString('base64');
    expect(await decrypt(GOLDEN_K, huge)).toBeNull();
  });

  it('cloud mode mints a short link: modal shows url#K, QR renders it, POSTed ct decrypts with the fragment K', async () => {
    const { window, document } = env;
    lendWebCrypto(window);
    window.__MEDTRACKER_CLOUD__ = true;
    stubExport(window);
    stubQr(window);

    let postedBody = null;
    let postedOpts = null;
    window.fetch = vi.fn(async (url, opts) => {
      postedBody = JSON.parse(opts.body);
      postedOpts = opts;
      return { ok: true, status: 200, json: async () => ({ id: 'Ab3kZ9xQ2m', url: 'https://cloud.example.com/s/Ab3kZ9xQ2m', expires_at: '2026-10-20T00:00:00Z' }) };
    });

    await window.WorkoutShare.share({ id: 5, name: 'Push / Pull' });

    expect(window.fetch).toHaveBeenCalledTimes(1);
    expect(window.fetch.mock.calls[0][0]).toBe('/api/share');
    expect(postedOpts.method).toBe('POST');
    expect(postedOpts.credentials).toBe('same-origin');
    expect(postedOpts.headers).toEqual({ 'Content-Type': 'application/json' });
    // Padded STD base64 (a Go []byte field) — never the base64url fragment form.
    expect(postedBody.ct).not.toMatch(/[-_]/);
    expect(postedBody.ct).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);

    // Modal shows ONE link: the short one, ~65 chars.
    const link = document.getElementById('workout-share-link');
    const m = /^https:\/\/cloud\.example\.com\/s\/Ab3kZ9xQ2m#([A-Za-z0-9_-]{22})$/.exec(link.value);
    expect(m).not.toBeNull();
    expect(link.value.length).toBeLessThan(100);
    expect(window.WorkoutShare._current.url).toBe(link.value);
    expect(window.WorkoutShare._current.short).toBe(true);

    // The POSTed ct decrypts with the fragment K (+ AAD mt/v1/share) back to
    // the exact p1 token — this pins the contract bead B decodes.
    expect(await window.WorkoutShare._shortLink.decrypt(m[1], postedBody.ct))
      .toBe(window.WorkoutShare._current.token);

    // QR encodes the short link (a short link always passes the length
    // check); the too-large note stays hidden; the 30-day note shows.
    expect(window.WorkoutShare.makeQr).toHaveBeenCalledTimes(1);
    expect(window.WorkoutShare.makeQr.mock.calls[0][0]).toBe(link.value);
    expect(document.getElementById('workout-share-qr').querySelector('svg')).not.toBeNull();
    expect(document.getElementById('workout-share-qr-note').classList.contains('hidden')).toBe(true);
    const shortNote = document.getElementById('workout-share-short-note');
    expect(shortNote.classList.contains('hidden')).toBe(false);
    expect(shortNote.textContent).toBe('Link works for 30 days.');

    // Copy uses the short url.
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      document.getElementById('workout-share-copy-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText.mock.calls[0][0]).toBe(link.value);
    } finally {
      delete window.navigator.clipboard;
    }
  });

  it('POST failure keeps the long link, hides the short note, and toasts nothing', async () => {
    const { window, document } = env;
    lendWebCrypto(window);
    window.__MEDTRACKER_CLOUD__ = true;
    stubExport(window);
    stubQr(window);
    const toastSpy = vi.fn();
    window.safeToast = toastSpy;

    for (const fetchImpl of [
      async () => ({ ok: false, status: 404, json: async () => ({}) }),
      async () => { throw new Error('down'); },
    ]) {
      window.fetch = vi.fn(fetchImpl);
      await window.WorkoutShare.share({ id: 5, name: 'Push / Pull' });
      const link = document.getElementById('workout-share-link');
      expect(link.value.startsWith('https://example.test/#share-plan=p1.')).toBe(true);
      expect(await window.WorkoutShare.decode(link.value)).toEqual(EXPORT);
      expect(window.WorkoutShare._current.short).toBe(false);
      expect(document.getElementById('workout-share-short-note').classList.contains('hidden')).toBe(true);
      // The modal still renders the (long-link) QR.
      expect(document.getElementById('workout-share-qr').querySelector('svg')).not.toBeNull();
    }
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('bot mode never POSTs and shows the long link', async () => {
    const { window, document } = env;
    lendWebCrypto(window);
    expect(window.__MEDTRACKER_CLOUD__).toBeFalsy();
    stubExport(window);
    stubQr(window);
    window.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));

    await window.WorkoutShare.share({ id: 5, name: 'Push / Pull' });

    expect(window.fetch).not.toHaveBeenCalled();
    expect(document.getElementById('workout-share-link').value.startsWith('https://example.test/#share-plan=p1.')).toBe(true);
  });

  it('a hanging POST aborts and the modal still opens with the long link', async () => {
    const { window, document } = env;
    lendWebCrypto(window);
    window.__MEDTRACKER_CLOUD__ = true;
    stubExport(window);
    stubQr(window);
    window.fetch = vi.fn((url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));

    await window.WorkoutShare.share({ id: 5, name: 'Push / Pull' });

    expect(document.getElementById('workout-share-modal').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('workout-share-link').value.startsWith('https://example.test/#share-plan=p1.')).toBe(true);
  }, 10000);

  it('receive() resolves a short link end to end: same-origin GET, fragment-K decrypt, confirm → import → Edit', async () => {
    const { window } = env;
    lendWebCrypto(window);
    const toastSpy = stubReceiveEnv(window);
    window.apiCall = vi.fn(async (url) => {
      if (String(url).startsWith('/api/workout/plans/import')) return IMPORT_RES;
      return null;
    });

    // Mint the server blob through the real encrypt path with a fixed K.
    const token = await window.WorkoutShare.encode(EXPORT);
    const kBytes = Uint8Array.from([...Array(16)].map((_, i) => i + 1));
    const nonce = Uint8Array.from([...Array(12)].map((_, i) => i + 41));
    const packed = await window.WorkoutShare._shortLink.encrypt(token, kBytes, nonce);
    const ct = Buffer.from(packed).toString('base64');
    const frag = Buffer.from(kBytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(frag).toHaveLength(22);

    window.fetch = vi.fn(async (url, opts) => {
      expect(String(url)).toBe('/api/s/Ab3kZ9xQ2m');
      expect(opts).toMatchObject({ cache: 'no-store' });
      return { ok: true, status: 200, json: async () => ({ ct, expires_at: '2026-10-20T00:00:00Z' }) };
    });

    // A foreign host in the pasted text: the resolve still hits OUR origin.
    await window.WorkoutShare.receive(`https://cloud.example.com/s/Ab3kZ9xQ2m#${frag}`);

    expect(window.safeConfirm).toHaveBeenCalledWith('Import "Push / Pull"? 1 day(s), 2 exercise(s).');
    expect(window.apiCall).toHaveBeenCalledWith('/api/workout/plans/import', 'POST', EXPORT, { suppressWriteAlert: true });
    expect(toastSpy).toHaveBeenCalledWith('Added "Push / Pull"', 'info');
    expect(window.WorkoutGroups.openEdit).toHaveBeenCalledWith(42);
  });

  it('receive() with the golden blob hands decodeShareToken the golden plaintext (gunzip then fails its CRC → generic toast, no import)', async () => {
    const { window } = env;
    lendWebCrypto(window);
    const toastSpy = stubReceiveEnv(window);
    window.apiCall = vi.fn(async () => null);

    // Record what decodeShareToken feeds the gunzip.
    const seen = [];
    const realGunzip = window.BackupCrypto.gunzipToString;
    window.BackupCrypto.gunzipToString = async (bytes) => {
      seen.push(bytes);
      return realGunzip(bytes);
    };
    try {
      window.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ct: GOLDEN_PACKED, expires_at: '2026-10-20T00:00:00Z' }) }));
      await window.WorkoutShare.receive(GOLDEN_SHORT);

      expect(seen).toHaveLength(1);
      const asB64url = Buffer.from(seen[0]).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      expect(`p1.${asB64url}`).toBe(GOLDEN_PLAINTEXT);
      // The golden payload's gzip body fails its CRC, so the import never
      // starts — exactly one generic toast, no POST.
      expect(toastSpy).toHaveBeenCalledWith("That's not a workout plan link.", 'error');
      expect(window.apiCall).not.toHaveBeenCalled();
      expect(window.WorkoutGroups.openEdit).not.toHaveBeenCalled();
    } finally {
      window.BackupCrypto.gunzipToString = realGunzip;
    }
  });

  it('receive() on a 404 short link toasts expired/other-server and never imports', async () => {
    const { window } = env;
    lendWebCrypto(window);
    const toastSpy = stubReceiveEnv(window);
    window.apiCall = vi.fn(async () => null);
    window.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));

    await window.WorkoutShare.receive(GOLDEN_SHORT);

    expect(toastSpy).toHaveBeenCalledWith(
      'This short link has expired or belongs to another Med Tracker server — ask for the plan code instead.',
      'error',
    );
    expect(window.safeConfirm).not.toHaveBeenCalled();
    expect(window.apiCall).not.toHaveBeenCalled();
    expect(window.WorkoutGroups.openEdit).not.toHaveBeenCalled();
  });

  it('receive() on a short link whose K is wrong toasts the generic message and never imports', async () => {
    const { window } = env;
    lendWebCrypto(window);
    const toastSpy = stubReceiveEnv(window);
    window.apiCall = vi.fn(async () => null);
    window.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ct: GOLDEN_PACKED, expires_at: '2026-10-20T00:00:00Z' }) }));

    await window.WorkoutShare.receive('https://cloud.example.com/s/Ab3kZ9xQ2m#AAAAAAAAAAAAAAAAAAAAAA');

    expect(toastSpy).toHaveBeenCalledWith("That's not a workout plan link.", 'error');
    expect(window.apiCall).not.toHaveBeenCalled();
  });
});
