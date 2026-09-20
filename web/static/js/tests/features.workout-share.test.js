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
