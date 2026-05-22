/**
 * native.reminders.test.js
 *
 * Pins the Phase 2b Task 5 Reminders abstraction contract:
 *   - web impl is a no-op shim (browser path is Web Push via push.js).
 *   - Capacitor impl wraps @capacitor/local-notifications with REPLACE-ALL
 *     semantics on every schedule() (cancel pending → schedule new).
 *   - startPreScheduleLoop() polls /api/reminders/upcoming?hours=24 once
 *     immediately and re-runs on every Capacitor appStateChange→active event.
 *   - The notification-tap handler routes through window.handleDeepLinks() so
 *     a tap reuses the existing query-param push/deep-link path rather than
 *     adding a separate Capacitor router.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const NATIVE_INDEX_JS = path.join(REPO_ROOT, 'web/static/js/native/index.js');
const WEB_REM_JS = path.join(REPO_ROOT, 'web/static/js/native/web/reminders.js');
const CAP_REM_JS = path.join(REPO_ROOT, 'web/static/js/native/capacitor/reminders.js');

function loadEnv({ capacitor, handleDeepLinks, fetchImpl, apiCallDirect, offlineAwareApiCall } = {}) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'http://app.example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    if (capacitor !== undefined) window.Capacitor = capacitor;
    if (handleDeepLinks !== undefined) window.handleDeepLinks = handleDeepLinks;
    if (fetchImpl !== undefined) window.fetch = fetchImpl;
    if (apiCallDirect !== undefined) window.apiCallDirect = apiCallDirect;
    if (offlineAwareApiCall !== undefined) window.offlineAwareApiCall = offlineAwareApiCall;
    const evalFile = (file) => {
        const src = fs.readFileSync(file, 'utf8');
        window.eval(`${src}\n//# sourceURL=file://${file}`);
    };
    evalFile(NATIVE_INDEX_JS);
    evalFile(WEB_REM_JS);
    evalFile(CAP_REM_JS);
    return { window, cleanup: () => dom.window.close() };
}

function makeCapacitor({ schedule, cancel, getPending, addAppListener, addLnListener } = {}) {
    return {
        isNativePlatform: () => true,
        Plugins: {
            LocalNotifications: {
                schedule: schedule || vi.fn().mockResolvedValue({}),
                cancel: cancel || vi.fn().mockResolvedValue({}),
                getPending: getPending || vi.fn().mockResolvedValue({ notifications: [] }),
                addListener: addLnListener || vi.fn().mockReturnValue({ remove: vi.fn() }),
            },
            App: {
                addListener: addAppListener || vi.fn().mockReturnValue({ remove: vi.fn() }),
            },
        },
    };
}

describe('native/web/reminders.js — web no-op shim', () => {
    let env;
    afterEach(() => { if (env) env.cleanup(); env = null; });

    it('is selected as window.Reminders when Capacitor is absent', () => {
        env = loadEnv();
        const web = env.window.Reminders.__native.getImpl('Reminders', 'web');
        expect(env.window.Reminders).toBe(web);
    });

    it('schedule() resolves without touching browser notification APIs', async () => {
        env = loadEnv();
        const result = await env.window.Reminders.schedule([
            { intake_id: 1, medication_id: 10, medication_name: 'X', scheduled_at: new Date().toISOString() },
        ]);
        expect(result).toBeDefined();
        expect(result.platform).toBe('web');
        expect(result.scheduled).toBe(0);
    });

    it('cancelAll() resolves to zero canceled on web', async () => {
        env = loadEnv();
        const result = await env.window.Reminders.cancelAll();
        expect(result.platform).toBe('web');
        expect(result.canceled).toBe(0);
    });

    it('startPreScheduleLoop() is a no-op on web (does not throw)', () => {
        env = loadEnv();
        const ret = env.window.Reminders.startPreScheduleLoop();
        expect(ret).toBeNull();
    });
});

describe('native/capacitor/reminders.js — Capacitor impl', () => {
    let env;
    afterEach(() => { if (env) env.cleanup(); env = null; });

    it('is selected as window.Reminders when isNativePlatform() is true', () => {
        env = loadEnv({ capacitor: makeCapacitor() });
        const cap = env.window.Reminders.__native.getImpl('Reminders', 'capacitor');
        expect(env.window.Reminders).toBe(cap);
    });

    it('schedule() maps endpoint response to the LocalNotifications payload shape', async () => {
        const schedule = vi.fn().mockResolvedValue({});
        const cancel = vi.fn().mockResolvedValue({});
        const getPending = vi.fn().mockResolvedValue({ notifications: [] });
        env = loadEnv({ capacitor: makeCapacitor({ schedule, cancel, getPending }) });

        const isoNow = '2026-05-22T08:00:00.000Z';
        const isoLater = '2026-05-22T20:00:00.000Z';
        const result = await env.window.Reminders.schedule([
            { intake_id: 123, medication_id: 456, medication_name: 'Metformin 500mg', scheduled_at: isoNow },
            { intake_id: 124, medication_id: 456, medication_name: 'Metformin 500mg', scheduled_at: isoLater },
        ]);

        expect(result.platform).toBe('capacitor');
        expect(result.scheduled).toBe(2);
        expect(schedule).toHaveBeenCalledTimes(1);
        const call = schedule.mock.calls[0][0];
        expect(call.notifications).toHaveLength(2);
        expect(call.notifications[0]).toMatchObject({
            id: 123,
            title: 'Metformin 500mg',
            body: 'Time to take Metformin 500mg',
            extra: { intake_id: 123, medication_id: 456 },
        });
        // schedule.at is a Date instance from JSDOM's window context, so use a
        // duck-typed check (its toISOString round-trip) rather than instanceof.
        expect(typeof call.notifications[0].schedule.at.toISOString).toBe('function');
        expect(call.notifications[0].schedule.at.toISOString()).toBe(isoNow);
        // allowWhileIdle pins setExactAndAllowWhileIdle so Android Doze can't
        // defer a dose reminder into the next maintenance window. Asserting
        // here so a future refactor can't silently drop the flag from the
        // payload and reintroduce Doze-deferred missed doses.
        expect(call.notifications[0].schedule.allowWhileIdle).toBe(true);
        expect(call.notifications[1].id).toBe(124);
        expect(call.notifications[1].schedule.allowWhileIdle).toBe(true);
    });

    it('schedule() schedules the new batch BEFORE canceling stale pending (fail-safe replace-all)', async () => {
        // Order matters: schedule first so a plugin-level failure (permission
        // denied, exact alarm disabled, invalid payload) doesn't wipe the
        // pre-scheduled queue and strand the user. Pending IDs that aren't
        // in the new batch are canceled after schedule succeeds.
        const callOrder = [];
        const getPending = vi.fn().mockImplementation(() => {
            callOrder.push('getPending');
            return Promise.resolve({ notifications: [{ id: 7 }, { id: 8 }, { id: 9 }] });
        });
        const cancel = vi.fn().mockImplementation(() => { callOrder.push('cancel'); return Promise.resolve({}); });
        const schedule = vi.fn().mockImplementation(() => { callOrder.push('schedule'); return Promise.resolve({}); });
        env = loadEnv({ capacitor: makeCapacitor({ schedule, cancel, getPending }) });

        await env.window.Reminders.schedule([
            { intake_id: 1, medication_id: 10, medication_name: 'Med', scheduled_at: '2026-05-23T08:00:00Z' },
        ]);

        expect(callOrder).toEqual(['getPending', 'schedule', 'cancel']);
        // All three were stale (none of {7,8,9} are in the new batch {1}) and
        // therefore get canceled — same wipe outcome as the old order, but
        // only after the new schedule landed.
        expect(cancel).toHaveBeenCalledWith({ notifications: [{ id: 7 }, { id: 8 }, { id: 9 }] });
    });

    it('schedule() leaves the pending queue intact when plugin.schedule() rejects', async () => {
        // Failure path: POST_NOTIFICATIONS denied / exact alarm disabled /
        // invalid payload. Old code canceled before scheduling, so the same
        // failure stranded the user with zero notifications until the next
        // successful refresh. Fail-safe order means cancel is never reached.
        const getPending = vi.fn().mockResolvedValue({ notifications: [{ id: 7 }, { id: 8 }] });
        const schedule = vi.fn().mockRejectedValue(new Error('User has not granted permission'));
        const cancel = vi.fn();
        env = loadEnv({ capacitor: makeCapacitor({ schedule, cancel, getPending }) });

        let caught;
        try {
            await env.window.Reminders.schedule([
                { intake_id: 1, medication_id: 10, medication_name: 'Med', scheduled_at: '2026-05-23T08:00:00Z' },
            ]);
        } catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('RemindersError');
        expect(caught.code).toBe('PERMISSION_DENIED');
        expect(schedule).toHaveBeenCalledTimes(1);
        expect(cancel).not.toHaveBeenCalled();
    });

    it('schedule() preserves pending IDs that also appear in the new batch (no redundant cancel)', async () => {
        // ID 7 is in both pending and the new batch — schedule() upserts it,
        // so we must not cancel it. Only the orphans (8, 9) get canceled.
        const getPending = vi.fn().mockResolvedValue({ notifications: [{ id: 7 }, { id: 8 }, { id: 9 }] });
        const schedule = vi.fn().mockResolvedValue({});
        const cancel = vi.fn().mockResolvedValue({});
        env = loadEnv({ capacitor: makeCapacitor({ schedule, cancel, getPending }) });

        await env.window.Reminders.schedule([
            { intake_id: 7, medication_id: 10, medication_name: 'Med', scheduled_at: '2026-05-23T08:00:00Z' },
        ]);
        expect(cancel).toHaveBeenCalledWith({ notifications: [{ id: 8 }, { id: 9 }] });
    });

    it('schedule() skips the cancel call when no pending notifications exist', async () => {
        const getPending = vi.fn().mockResolvedValue({ notifications: [] });
        const cancel = vi.fn();
        const schedule = vi.fn().mockResolvedValue({});
        env = loadEnv({ capacitor: makeCapacitor({ schedule, cancel, getPending }) });

        await env.window.Reminders.schedule([
            { intake_id: 1, medication_id: 10, medication_name: 'X', scheduled_at: '2026-05-23T08:00:00Z' },
        ]);
        expect(cancel).not.toHaveBeenCalled();
        expect(schedule).toHaveBeenCalledTimes(1);
    });

    it('schedule() with empty input cancels pending then skips the schedule call', async () => {
        const getPending = vi.fn().mockResolvedValue({ notifications: [{ id: 1 }] });
        const cancel = vi.fn().mockResolvedValue({});
        const schedule = vi.fn();
        env = loadEnv({ capacitor: makeCapacitor({ schedule, cancel, getPending }) });

        const result = await env.window.Reminders.schedule([]);
        expect(cancel).toHaveBeenCalled();
        expect(schedule).not.toHaveBeenCalled();
        expect(result.scheduled).toBe(0);
    });

    it('schedule() drops entries missing intake_id or scheduled_at', async () => {
        const getPending = vi.fn().mockResolvedValue({ notifications: [] });
        const schedule = vi.fn().mockResolvedValue({});
        env = loadEnv({ capacitor: makeCapacitor({ schedule, getPending }) });

        await env.window.Reminders.schedule([
            { intake_id: null, medication_id: 1, medication_name: 'A', scheduled_at: '2026-05-23T08:00:00Z' },
            { intake_id: 2, medication_id: 1, medication_name: 'B', scheduled_at: 'not-a-date' },
            { intake_id: 3, medication_id: 1, medication_name: 'C', scheduled_at: '2026-05-23T09:00:00Z' },
        ]);
        const call = schedule.mock.calls[0][0];
        expect(call.notifications).toHaveLength(1);
        expect(call.notifications[0].id).toBe(3);
    });

    it('schedule() drops entries with non-integer or out-of-int32-range intake_id', async () => {
        const getPending = vi.fn().mockResolvedValue({ notifications: [] });
        const schedule = vi.fn().mockResolvedValue({});
        env = loadEnv({ capacitor: makeCapacitor({ schedule, getPending }) });

        // The Capacitor LocalNotifications plugin requires a positive 32-bit
        // integer id. A NaN / string / out-of-range value would reject the
        // entire batch and strand every reminder; we must drop the bad rows
        // and schedule the rest.
        await env.window.Reminders.schedule([
            { intake_id: 'abc', medication_id: 1, medication_name: 'A', scheduled_at: '2026-05-23T08:00:00Z' },
            { intake_id: 2147483648, medication_id: 1, medication_name: 'B', scheduled_at: '2026-05-23T08:00:00Z' },
            { intake_id: -1, medication_id: 1, medication_name: 'C', scheduled_at: '2026-05-23T08:00:00Z' },
            { intake_id: 1.5, medication_id: 1, medication_name: 'D', scheduled_at: '2026-05-23T08:00:00Z' },
            { intake_id: 42, medication_id: 1, medication_name: 'OK', scheduled_at: '2026-05-23T09:00:00Z' },
        ]);
        const call = schedule.mock.calls[0][0];
        expect(call.notifications).toHaveLength(1);
        expect(call.notifications[0].id).toBe(42);
    });

    it('schedule() falls back to "Medication" body when medication_name is empty', async () => {
        const getPending = vi.fn().mockResolvedValue({ notifications: [] });
        const schedule = vi.fn().mockResolvedValue({});
        env = loadEnv({ capacitor: makeCapacitor({ schedule, getPending }) });

        await env.window.Reminders.schedule([
            { intake_id: 1, medication_id: 1, medication_name: '', scheduled_at: '2026-05-23T08:00:00Z' },
        ]);
        const call = schedule.mock.calls[0][0];
        expect(call.notifications[0].title).toBe('Medication');
        expect(call.notifications[0].body).toBe('Time to take Medication');
    });

    it('cancelAll() cancels every pending notification', async () => {
        const cancel = vi.fn().mockResolvedValue({});
        const getPending = vi.fn().mockResolvedValue({
            notifications: [{ id: 1 }, { id: 2 }, { id: 3 }],
        });
        env = loadEnv({ capacitor: makeCapacitor({ cancel, getPending }) });

        const result = await env.window.Reminders.cancelAll();
        expect(cancel).toHaveBeenCalledWith({ notifications: [{ id: 1 }, { id: 2 }, { id: 3 }] });
        expect(result.canceled).toBe(3);
    });

    it('cancelAll() with nothing pending resolves to zero canceled without calling cancel', async () => {
        const cancel = vi.fn();
        const getPending = vi.fn().mockResolvedValue({ notifications: [] });
        env = loadEnv({ capacitor: makeCapacitor({ cancel, getPending }) });
        const result = await env.window.Reminders.cancelAll();
        expect(cancel).not.toHaveBeenCalled();
        expect(result.canceled).toBe(0);
    });

    it('schedule() normalizes plugin permission-denied errors to RemindersError', async () => {
        const getPending = vi.fn().mockRejectedValue(new Error('User has not granted permission'));
        env = loadEnv({ capacitor: makeCapacitor({ getPending }) });
        let caught;
        try {
            await env.window.Reminders.schedule([
                { intake_id: 1, medication_id: 1, medication_name: 'X', scheduled_at: '2026-05-23T08:00:00Z' },
            ]);
        } catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('RemindersError');
        expect(caught.code).toBe('PERMISSION_DENIED');
    });

    it('rejects with UNAVAILABLE when the LocalNotifications plugin is missing', async () => {
        env = loadEnv({ capacitor: { isNativePlatform: () => true, Plugins: { App: { addListener: vi.fn() } } } });
        let caught;
        try { await env.window.Reminders.schedule([]); } catch (e) { caught = e; }
        expect(caught).toBeDefined();
        expect(caught.name).toBe('RemindersError');
        expect(caught.code).toBe('UNAVAILABLE');
    });

    it('_refreshFromServer() fetches the upcoming endpoint and schedules the response', async () => {
        const sample = [
            { intake_id: 11, medication_id: 22, medication_name: 'A', scheduled_at: '2026-05-23T08:00:00Z' },
        ];
        // Raw window.fetch fallback returns a Response — the impl reads .json()
        // on it when neither offlineAwareApiCall nor apiCallDirect is present.
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(sample),
        });
        const schedule = vi.fn().mockResolvedValue({});
        const cancel = vi.fn().mockResolvedValue({});
        const getPending = vi.fn().mockResolvedValue({ notifications: [] });
        env = loadEnv({
            capacitor: makeCapacitor({ schedule, cancel, getPending }),
            fetchImpl,
        });

        const cap = env.window.Reminders.__native.getImpl('Reminders', 'capacitor');
        const result = await cap._refreshFromServer();
        expect(fetchImpl).toHaveBeenCalledWith('/api/reminders/upcoming?hours=24', expect.objectContaining({ method: 'GET' }));
        expect(schedule).toHaveBeenCalledTimes(1);
        const call = schedule.mock.calls[0][0];
        expect(call.notifications).toHaveLength(1);
        expect(call.notifications[0].id).toBe(11);
        expect(result.scheduled).toBe(1);
    });

    it('_refreshFromServer() prefers window.offlineAwareApiCall when available', async () => {
        // offlineAwareApiCall has signature (endpoint, method, body, opts) and
        // returns the parsed JSON body directly — match the real contract from
        // sync.js so the impl can't drift back to treating it like fetch().
        const upcoming = [
            { intake_id: 1, medication_id: 1, medication_name: 'X', scheduled_at: '2026-05-23T08:00:00Z' },
        ];
        const offlineAwareApiCall = vi.fn().mockResolvedValue(upcoming);
        const schedule = vi.fn().mockResolvedValue({});
        env = loadEnv({
            capacitor: makeCapacitor({ schedule }),
            offlineAwareApiCall,
        });
        const cap = env.window.Reminders.__native.getImpl('Reminders', 'capacitor');
        await cap._refreshFromServer();
        expect(offlineAwareApiCall).toHaveBeenCalledWith('/api/reminders/upcoming?hours=24', 'GET');
        expect(schedule).toHaveBeenCalledTimes(1);
        expect(schedule.mock.calls[0][0].notifications[0].id).toBe(1);
    });

    it('_refreshFromServer() preserves the existing pending queue when the fetch fails', async () => {
        // A transient backend 5xx or sub-second WiFi blip on app resume must
        // not cancel every pre-scheduled medication reminder. Distinguishing
        // "fetch failed" from "server returned empty list" is what guarantees
        // we don't silently wipe doses for the next 24h on a flaky network.
        const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
        const schedule = vi.fn();
        const cancel = vi.fn();
        const getPending = vi.fn().mockResolvedValue({ notifications: [{ id: 1 }] });
        env = loadEnv({
            capacitor: makeCapacitor({ schedule, cancel, getPending }),
            fetchImpl,
        });
        const cap = env.window.Reminders.__native.getImpl('Reminders', 'capacitor');
        const result = await cap._refreshFromServer();
        expect(schedule).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        expect(getPending).not.toHaveBeenCalled();
        expect(result.skipped).toBe('fetch_failed');
        expect(result.scheduled).toBe(0);
    });

    it('_refreshFromServer() preserves pending queue when offlineAwareApiCall returns null (transient failure)', async () => {
        // sync.js:898-905 returns null from offlineAwareApiCall when a GET
        // request fails AND the endpoint isn't registered for offline reads.
        // /api/reminders/upcoming is unregistered, so a transient 5xx / WiFi
        // blip / 429 on app resume surfaces as null — which must NOT be
        // treated as "server returned empty list", otherwise schedule([])
        // wipes every pre-scheduled OS notification for the next 24h.
        const offlineAwareApiCall = vi.fn().mockResolvedValue(null);
        const schedule = vi.fn();
        const cancel = vi.fn();
        const getPending = vi.fn().mockResolvedValue({ notifications: [{ id: 1 }] });
        env = loadEnv({
            capacitor: makeCapacitor({ schedule, cancel, getPending }),
            offlineAwareApiCall,
        });
        const cap = env.window.Reminders.__native.getImpl('Reminders', 'capacitor');
        const result = await cap._refreshFromServer();
        expect(schedule).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        expect(getPending).not.toHaveBeenCalled();
        expect(result.skipped).toBe('fetch_failed');
        expect(result.scheduled).toBe(0);
    });

    it('_refreshFromServer() preserves pending queue when the fetch returns a 5xx response (raw fetch path)', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve(null) });
        const schedule = vi.fn();
        const cancel = vi.fn();
        const getPending = vi.fn().mockResolvedValue({ notifications: [{ id: 1 }] });
        env = loadEnv({
            capacitor: makeCapacitor({ schedule, cancel, getPending }),
            fetchImpl,
        });
        const cap = env.window.Reminders.__native.getImpl('Reminders', 'capacitor');
        const result = await cap._refreshFromServer();
        expect(schedule).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        expect(result.skipped).toBe('fetch_failed');
    });

    it('_refreshFromServer() runs the cancel-all flow when the server returns an empty list (real "no reminders" state)', async () => {
        // Distinguish from the fetch-failed case above: an empty-but-successful
        // response means "the server is authoritative — there are no upcoming
        // reminders". Cancel everything so we don't keep stale OS notifications.
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
        const schedule = vi.fn();
        const cancel = vi.fn().mockResolvedValue({});
        const getPending = vi.fn().mockResolvedValue({ notifications: [{ id: 7 }] });
        env = loadEnv({
            capacitor: makeCapacitor({ schedule, cancel, getPending }),
            fetchImpl,
        });
        const cap = env.window.Reminders.__native.getImpl('Reminders', 'capacitor');
        await cap._refreshFromServer();
        expect(getPending).toHaveBeenCalled();
        expect(cancel).toHaveBeenCalledWith({ notifications: [{ id: 7 }] });
        expect(schedule).not.toHaveBeenCalled();
    });

    it('startPreScheduleLoop() fires an initial refresh and registers an appStateChange listener', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
        const addAppListener = vi.fn().mockReturnValue({ remove: vi.fn() });
        const addLnListener = vi.fn().mockReturnValue({ remove: vi.fn() });
        env = loadEnv({
            capacitor: makeCapacitor({ addAppListener, addLnListener }),
            fetchImpl,
        });

        env.window.Reminders.startPreScheduleLoop();
        // Initial fetch fires synchronously.
        expect(fetchImpl).toHaveBeenCalledWith('/api/reminders/upcoming?hours=24', expect.any(Object));
        expect(addAppListener).toHaveBeenCalledWith('appStateChange', expect.any(Function));
        expect(addLnListener).toHaveBeenCalledWith('localNotificationActionPerformed', expect.any(Function));
    });

    it('startPreScheduleLoop() re-refreshes the queue when the appStateChange listener fires with isActive=true', async () => {
        let registeredHandler;
        const addAppListener = vi.fn().mockImplementation((event, handler) => {
            if (event === 'appStateChange') registeredHandler = handler;
            return { remove: vi.fn() };
        });
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
        env = loadEnv({
            capacitor: makeCapacitor({ addAppListener }),
            fetchImpl,
        });
        env.window.Reminders.startPreScheduleLoop();
        fetchImpl.mockClear();

        // Background event (isActive=false) should not refresh.
        registeredHandler({ isActive: false });
        await Promise.resolve();
        expect(fetchImpl).not.toHaveBeenCalled();

        // Foreground event triggers a fresh fetch.
        registeredHandler({ isActive: true });
        await Promise.resolve();
        await Promise.resolve();
        expect(fetchImpl).toHaveBeenCalledWith('/api/reminders/upcoming?hours=24', expect.any(Object));
    });

    it('startPreScheduleLoop() is idempotent — calling twice does not register listeners twice', () => {
        const addAppListener = vi.fn().mockReturnValue({ remove: vi.fn() });
        const addLnListener = vi.fn().mockReturnValue({ remove: vi.fn() });
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
        env = loadEnv({
            capacitor: makeCapacitor({ addAppListener, addLnListener }),
            fetchImpl,
        });
        env.window.Reminders.startPreScheduleLoop();
        env.window.Reminders.startPreScheduleLoop();
        expect(addAppListener).toHaveBeenCalledTimes(1);
        expect(addLnListener).toHaveBeenCalledTimes(1);
    });

    it('notification-tap handler invokes window.handleDeepLinks with medication_confirm params', () => {
        const handleDeepLinks = vi.fn();
        env = loadEnv({
            capacitor: makeCapacitor(),
            handleDeepLinks,
        });
        const cap = env.window.Reminders.__native.getImpl('Reminders', 'capacitor');
        cap._handleNotificationTap({
            notification: { extra: { intake_id: 555, medication_id: 999 } },
        });
        expect(handleDeepLinks).toHaveBeenCalledTimes(1);
        const search = env.window.location.search;
        expect(search).toContain('action=medication_confirm');
        expect(search).toContain('intake_ids=555');
        expect(search).toContain('ids=999');
    });

    it('notification-tap handler emits scheduled + names params when extra carries them (so showMedicationConfirmModal sees the dose time and label)', () => {
        const handleDeepLinks = vi.fn();
        env = loadEnv({
            capacitor: makeCapacitor(),
            handleDeepLinks,
        });
        const cap = env.window.Reminders.__native.getImpl('Reminders', 'capacitor');
        cap._handleNotificationTap({
            notification: {
                extra: {
                    intake_id: 100,
                    medication_id: 200,
                    medication_name: 'Metformin 500mg',
                    scheduled_at: '2026-05-23T08:00:00.000Z',
                },
            },
        });
        const params = new env.window.URLSearchParams(env.window.location.search);
        expect(params.get('action')).toBe('medication_confirm');
        expect(params.get('intake_ids')).toBe('100');
        expect(params.get('ids')).toBe('200');
        expect(params.get('names')).toBe('Metformin 500mg');
        expect(params.get('scheduled')).toBe('2026-05-23T08:00:00.000Z');
    });

    it('schedule() round-trips medication_name + scheduled_at into the notification extra payload', async () => {
        const getPending = vi.fn().mockResolvedValue({ notifications: [] });
        const schedule = vi.fn().mockResolvedValue({});
        env = loadEnv({ capacitor: makeCapacitor({ schedule, getPending }) });
        await env.window.Reminders.schedule([
            { intake_id: 42, medication_id: 7, medication_name: 'Atorvastatin', scheduled_at: '2026-05-23T20:00:00.000Z' },
        ]);
        const extra = schedule.mock.calls[0][0].notifications[0].extra;
        expect(extra.medication_name).toBe('Atorvastatin');
        expect(extra.scheduled_at).toBe('2026-05-23T20:00:00.000Z');
    });

    it('notification-tap handler is a no-op when the extra payload lacks intake_id', () => {
        const handleDeepLinks = vi.fn();
        env = loadEnv({
            capacitor: makeCapacitor(),
            handleDeepLinks,
        });
        const cap = env.window.Reminders.__native.getImpl('Reminders', 'capacitor');
        cap._handleNotificationTap({ notification: { extra: {} } });
        cap._handleNotificationTap({});
        cap._handleNotificationTap(null);
        expect(handleDeepLinks).not.toHaveBeenCalled();
    });
});

describe('native/index.js — runtime selector after Task 5', () => {
    let env;
    afterEach(() => { if (env) env.cleanup(); env = null; });

    it('selects the web Reminders impl when Capacitor.isNativePlatform() is false', () => {
        env = loadEnv({ capacitor: { isNativePlatform: () => false } });
        const web = env.window.Reminders.__native.getImpl('Reminders', 'web');
        expect(env.window.Reminders).toBe(web);
    });

    it('selects the Capacitor Reminders impl when Capacitor.isNativePlatform() is true', () => {
        env = loadEnv({ capacitor: makeCapacitor() });
        const cap = env.window.Reminders.__native.getImpl('Reminders', 'capacitor');
        expect(env.window.Reminders).toBe(cap);
    });

    it('registers both web and capacitor impls regardless of selection', () => {
        env = loadEnv();
        const web = env.window.Reminders.__native.getImpl('Reminders', 'web');
        const cap = env.window.Reminders.__native.getImpl('Reminders', 'capacitor');
        expect(typeof web.schedule).toBe('function');
        expect(typeof cap.schedule).toBe('function');
        expect(typeof web.cancelAll).toBe('function');
        expect(typeof cap.cancelAll).toBe('function');
    });
});
