import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

describe('app.js refresh dispatch behavior', () => {
  beforeEach(() => {
    allowConsoleNoise();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reloadCurrentTab dispatches to loader based on active tab and med subtab', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const loadMedsSpy = vi.fn();
      const loadTimelineSpy = vi.fn();
      const loadWeightSpy = vi.fn();

      window.loadMeds = loadMedsSpy;
      window.loadTimeline = loadTimelineSpy;
      window.loadWeightLogs = loadWeightSpy;

      window.AppStore.set('currentTab', 'meds');
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      document.getElementById('meds-view').classList.add('active');

      document.querySelectorAll('.med-tab').forEach((t) => t.classList.remove('active'));
      document.querySelector('.med-tab[data-tab="schedule"]').classList.add('active');

      window.reloadCurrentTab();
      expect(loadMedsSpy).toHaveBeenCalledTimes(1);
      expect(loadTimelineSpy).toHaveBeenCalledTimes(0);

      document.querySelectorAll('.med-tab').forEach((t) => t.classList.remove('active'));
      document.querySelector('.med-tab[data-tab="timeline"]').classList.add('active');
      window.reloadCurrentTab();
      expect(loadTimelineSpy).toHaveBeenCalledTimes(1);

      window.AppStore.set('currentTab', 'weight');
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      document.getElementById('weight-view').classList.add('active');
      window.reloadCurrentTab();
      expect(loadWeightSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('committed provider activation prevents new refresh work, including direct and optimistic Settings refresh', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      window.AppStore.set('currentTab', 'settings');
      window.loadSettings = vi.fn();
      document.documentElement.setAttribute('data-provider-reload-committed', '');
      window.requestTabRefresh({ source: 'optimistic-commit' });
      window.requestTabRefresh({ source: 'changes' });
      window.reloadCurrentTab();
      expect(window.loadSettings).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  // bd med-vhdk: the "New data is available" bar covered an open workout
  // session. Every non-UI refresh is now held silently while a sheet is open
  // and applied once when the last one closes through ModalManager.
  it('holds every background refresh while the workout session is open and reloads once on close', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const reloadSpy = vi.fn();
      window.reloadCurrentTab = reloadSpy;

      window.ModalManager.workoutSession.open();
      window.requestTabRefresh({ source: 'online' });                   // network flap (SyncManager.handleOnline)
      window.DataStore.requestTabRefresh(['workout'], 'cloud-write');   // pulled ops / Health pass
      window.DataStore.requestTabRefresh(['intake'], 'cloud-write');    // dose clock
      await vi.advanceTimersByTimeAsync(2000);
      expect(document.getElementById('data-refresh-banner')).toBeNull();
      expect(reloadSpy).not.toHaveBeenCalled();

      // A field inside the session losing focus is not "done".
      const notes = document.createElement('textarea');
      document.getElementById('workout-session-modal').appendChild(notes);
      notes.focus();
      notes.blur();
      await vi.advanceTimersByTimeAsync(1000);
      expect(reloadSpy).not.toHaveBeenCalled();

      window.ModalManager.workoutSession.close();
      await vi.advanceTimersByTimeAsync(500);
      expect(reloadSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2000);
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    } finally { cleanup(); }
  });

  it('holds a refresh under an in-page confirm dialog, also once its parent sheet closes, and applies it when the dialog settles', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const reloadSpy = vi.fn();
      window.reloadCurrentTab = reloadSpy;

      window.ModalManager.workoutSession.open();
      const answer = window.safeConfirm('Discard this set?');
      window.requestTabRefresh({ source: 'cloud-write' });
      window.ModalManager.workoutSession.close();
      await vi.advanceTimersByTimeAsync(1000);
      expect(reloadSpy).not.toHaveBeenCalled();

      document.querySelector('mt-modal.mt-confirm-modal .mt-confirm-modal__cancel').click();
      await answer;
      await vi.advanceTimersByTimeAsync(500);
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    } finally { cleanup(); }
  });

  it('drops an online refresh that arrives under an open sheet: nothing new to show on close', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      const reloadSpy = vi.fn();
      window.reloadCurrentTab = reloadSpy;
      window.ModalManager.workoutSession.open();
      window.requestTabRefresh({ source: 'online' });
      window.ModalManager.workoutSession.close();
      await vi.advanceTimersByTimeAsync(2000);
      expect(reloadSpy).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it('holds a refresh while a field is focused with no sheet and applies it on blur', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const reloadSpy = vi.fn();
      window.reloadCurrentTab = reloadSpy;

      const medName = document.getElementById('med-name');
      medName.focus();
      window.requestTabRefresh({ source: 'cloud-write' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(document.getElementById('data-refresh-banner')).toBeNull();
      expect(reloadSpy).not.toHaveBeenCalled();

      medName.blur();
      await vi.advanceTimersByTimeAsync(500);
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    } finally { cleanup(); }
  });

  it('a safe page still reloads an external change within 500 ms, unless a sheet opened meanwhile', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      const reloadSpy = vi.fn();
      window.reloadCurrentTab = reloadSpy;

      window.requestTabRefresh({ source: 'cloud-write' });
      await vi.advanceTimersByTimeAsync(500);
      expect(reloadSpy).toHaveBeenCalledTimes(1);

      window.requestTabRefresh({ source: 'cloud-write' });
      window.ModalManager.workoutSession.open();
      await vi.advanceTimersByTimeAsync(1000);
      expect(reloadSpy).toHaveBeenCalledTimes(1);
      window.ModalManager.workoutSession.close();
      await vi.advanceTimersByTimeAsync(500);
      expect(reloadSpy).toHaveBeenCalledTimes(2);
    } finally { cleanup(); }
  });

  it.each(['optimistic', 'optimistic-commit', 'optimistic-rollback'])('forwards %s provenance to the Settings loader only', (source) => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      window.AppStore.set('currentTab', 'settings');
      window.loadSettings = vi.fn();
      window.requestTabRefresh({ source });
      expect(window.loadSettings).toHaveBeenCalledExactlyOnceWith({ source });
      window.loadSettings.mockClear();
      window.reloadCurrentTab();
      expect(window.loadSettings).toHaveBeenCalledExactlyOnceWith({});
    } finally { cleanup(); }
  });

  it('requestTabRefresh source=self-echo is dropped with a modal open, not replayed on close', async () => {
    // An echo of the user's own write: the optimistic commit already painted it.
    const { window, cleanup } = loadFrontendEnv();

    try {
      const reloadSpy = vi.fn();
      window.reloadCurrentTab = reloadSpy;

      window.showBPRecordModal();
      window.requestTabRefresh({ changedTags: ['bp'], source: 'self-echo' });
      expect(reloadSpy).toHaveBeenCalledTimes(0);

      window.closeBPRecordModal();
      await vi.advanceTimersByTimeAsync(1000);
      expect(reloadSpy).toHaveBeenCalledTimes(0);
    } finally {
      cleanup();
    }
  });

  it('requestTabRefresh defers while the BP modal is open and reloads the BP tab when it closes', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const loadBPSpy = vi.fn();
      window.loadBPReadings = loadBPSpy;

      window.AppStore.set('currentTab', 'bp');
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      document.getElementById('bp-view').classList.add('active');

      window.showBPRecordModal();
      window.requestTabRefresh({ source: 'changes' });
      expect(loadBPSpy).toHaveBeenCalledTimes(0);

      await vi.advanceTimersByTimeAsync(1000);
      expect(loadBPSpy).toHaveBeenCalledTimes(0);

      window.closeBPRecordModal();
      await vi.advanceTimersByTimeAsync(500);
      expect(loadBPSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });
});
