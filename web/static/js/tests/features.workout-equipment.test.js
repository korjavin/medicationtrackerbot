// Equipment inventory sub-tab UI (med-niix.3): fifth Workouts sub-tab with an
// inventory list (API-computed step/max shown verbatim) + a fixed/plated
// editor modal. Integration through the real app shell
// (tests/helpers/frontend-harness.js): observable DOM + API call shapes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname_, '../../../..');
const CACHED_FETCH_JS = path.join(REPO_ROOT, 'web/static/js/cached-fetch.js');
const CSS_PATH = path.join(REPO_ROOT, 'web/static/css/styles.css');

function installCachedFetch(window) {
    const src = fs.readFileSync(CACHED_FETCH_JS, 'utf8');
    window.eval(`${src}\n//# sourceURL=file://${CACHED_FETCH_JS}`);
}

function installApiCacheMap(window, initialCache = {}) {
    const map = new Map();
    for (const [key, value] of Object.entries(initialCache)) {
        if (value && typeof value === 'object' && 'data' in value && 'timestamp' in value) {
            map.set(key, { id: key, ...value });
        } else {
            map.set(key, { id: key, timestamp: Date.now(), data: value });
        }
    }
    window.MedTrackerDB = window.MedTrackerDB || {};
    window.MedTrackerDB.ApiCache = {
        map,
        async get(key) {
            const entry = map.get(key);
            return entry ? entry.data : null;
        },
        async getWithMeta(key) {
            const entry = map.get(key);
            return entry ? { data: entry.data, timestamp: entry.timestamp } : null;
        },
        async set(key, data) {
            map.set(key, { id: key, timestamp: Date.now(), data });
        },
        async setWithMeta(key, data, timestamp) {
            map.set(key, { id: key, timestamp, data });
        },
        async clear(key) {
            if (key) map.delete(key); else map.clear();
        }
    };
    window.cacheApiSnapshot = async (key, value, _tags = []) => {
        map.set(key, { id: key, timestamp: Date.now(), data: value });
    };
    return map;
}

function setOnline(window, online) {
    Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        get: () => online
    });
}

const FIXED_DB = {
    id: 1, user_id: 1, kind: 'fixed', name: 'Hex DBs',
    loads_kg: [10, 12, 14, 16], min_step_kg: 2, max_kg: 16
};
const PLATED_BAR = {
    id: 2, user_id: 1, kind: 'plated', name: 'Ohio bar',
    bar_kg: 20, sides: 2, pair: false,
    plates: [{ kg: 20, count: 2 }, { kg: 10, count: 2 }],
    loads_kg: [20, 25, 30], min_step_kg: 2.5, max_kg: 120
};

function seedOnlineList(window, items) {
    window.apiCallDirect = vi.fn(async () => structuredClone(items));
}

function rowsOf(document) {
    return Array.from(document.querySelectorAll('#workout-equipment-list .wg-equipment-row'));
}

describe('features/workout/equipment.js — inventory list + editor (med-niix.3)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv({ withWorkout: true });
        installCachedFetch(env.window);
        installApiCacheMap(env.window);
        setOnline(env.window, true);
        env.window.safeConfirm = async (_msg, cb) => { await cb(true); };
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('exposes the WorkoutEquipment public-API namespace + WorkoutEdit accessor', () => {
        const { window } = env;
        expect(window.WorkoutEquipment).toBeTypeOf('object');
        expect(window.WorkoutEquipment.load).toBeTypeOf('function');
        expect(window.WorkoutEquipment.save).toBeTypeOf('function');
        expect(window.WorkoutEquipment.openAdd).toBeTypeOf('function');
        expect(window.WorkoutEquipment.openEdit).toBeTypeOf('function');
        expect(window.WorkoutEquipment.close).toBeTypeOf('function');
        expect(window.WorkoutEquipment.delete).toBeTypeOf('function');

        expect('editingEquipmentId' in window.WorkoutEdit).toBe(true);
        expect(window.WorkoutEdit.editingEquipmentId).toBeNull();
    });

    it('renders the fifth sub-tab button with the equipment panel', () => {
        const { document } = env;
        const buttons = document.querySelectorAll('.wg-workouts-subtabs .workout-tab');
        expect(buttons.length).toBe(5);
        const equipmentBtn = document.querySelector('.workout-tab[data-tab="equipment"]');
        expect(equipmentBtn).not.toBeNull();
        expect(equipmentBtn.textContent).toBe('Equipment');
        expect(document.getElementById('workout-equipment-tab')).not.toBeNull();
        expect(document.getElementById('workout-equipment-list')).not.toBeNull();
        expect(document.getElementById('workout-equipment-modal')).not.toBeNull();
    });

    it('list renders the API min_step/max verbatim with kind badges', async () => {
        const { window, document } = env;
        seedOnlineList(window, [FIXED_DB, PLATED_BAR]);

        await window.WorkoutEquipment.load();

        expect(window.apiCallDirect).toHaveBeenCalledWith('/api/workout/equipment', 'GET', null);
        const rows = rowsOf(document);
        expect(rows).toHaveLength(2);
        const stepLines = rows.map((r) => r.querySelector('.wg-equipment-row__steps').textContent);
        // Verbatim from the response fields — the client never derives these.
        expect(stepLines).toEqual([
            `step ${FIXED_DB.min_step_kg} kg · max ${FIXED_DB.max_kg} kg`,
            `step ${PLATED_BAR.min_step_kg} kg · max ${PLATED_BAR.max_kg} kg`
        ]);
        const kinds = rows.map((r) => r.querySelector('.wg-equipment-row__kind').textContent);
        expect(kinds).toEqual(['Fixed', 'Plated']);
        const names = rows.map((r) => r.querySelector('.wg-equipment-row__name').textContent);
        expect(names).toEqual(['Hex DBs', 'Ohio bar']);
    });

    it('creates a fixed dumbbell set from the UI and shows the API step/max after save', async () => {
        const { window, document } = env;
        seedOnlineList(window, []);
        const created = { ...FIXED_DB };
        const calls = [];
        window.apiCall = vi.fn(async (url, method, body) => {
            calls.push([url, method, body]);
            if (url === '/api/workout/equipment' && method === 'POST') return structuredClone(created);
            if (url === '/api/workout/equipment' && method === 'GET') return [structuredClone(created)];
            return null;
        });
        // The post-save reload revalidates through apiCallDirect.
        window.apiCallDirect = vi.fn(async () => [structuredClone(created)]);

        document.getElementById('add-workout-equipment-btn').click();
        expect(document.getElementById('workout-equipment-modal-title').textContent).toBe('Add Equipment');

        document.getElementById('workout-equipment-name').value = 'Hex DBs';
        document.getElementById('workout-equipment-loads').value = '10, 12, 14, 16';
        document.getElementById('workout-equipment-save-btn').click();

        await vi.waitFor(() => {
            expect(calls.length).toBeGreaterThan(0);
        });
        expect(calls[0][0]).toBe('/api/workout/equipment');
        expect(calls[0][1]).toBe('POST');
        expect(calls[0][2]).toEqual({ kind: 'fixed', name: 'Hex DBs', loads_kg: [10, 12, 14, 16] });

        await vi.waitFor(() => {
            expect(rowsOf(document).map((r) => r.querySelector('.wg-equipment-row__steps').textContent))
                .toEqual(['step 2 kg · max 16 kg']);
        });
        expect(window.WorkoutEdit.editingEquipmentId).toBeNull();
    });

    it('creates a plated barbell from the UI with sides, pair toggle and plate rows', async () => {
        const { window, document } = env;
        seedOnlineList(window, []);
        const calls = [];
        window.apiCall = vi.fn(async (url, method, body) => {
            calls.push([url, method, body]);
            if (method === 'POST') return { ...PLATED_BAR, id: 9 };
            return null;
        });
        window.apiCallDirect = vi.fn(async () => []);

        document.getElementById('add-workout-equipment-btn').click();
        document.querySelector('#workout-equipment-kind [data-kind="plated"]').click();
        expect(document.getElementById('workout-equipment-fixed-section').hidden).toBe(true);
        expect(document.getElementById('workout-equipment-plated-section').hidden).toBe(false);

        document.getElementById('workout-equipment-name').value = 'Ohio bar';
        document.getElementById('workout-equipment-bar').value = '20';
        document.getElementById('workout-equipment-pair').checked = true;
        const firstRow = document.querySelector('#workout-equipment-plates [data-plate-row]');
        firstRow.querySelector('[data-plate-kg]').value = '20';
        firstRow.querySelector('[data-plate-count]').value = '2';
        document.getElementById('workout-equipment-plate-add').click();
        const plateRows = document.querySelectorAll('#workout-equipment-plates [data-plate-row]');
        expect(plateRows).toHaveLength(2);
        plateRows[1].querySelector('[data-plate-kg]').value = '10';
        plateRows[1].querySelector('[data-plate-count]').value = '2';

        document.getElementById('workout-equipment-save-btn').click();

        await vi.waitFor(() => {
            expect(calls.length).toBeGreaterThan(0);
        });
        expect(calls[0][2]).toEqual({
            kind: 'plated', name: 'Ohio bar', bar_kg: 20, sides: 2, pair: true,
            plates: [{ kg: 20, count: 2 }, { kg: 10, count: 2 }]
        });
    });

    it('kind segmented control toggles the fixed/plated sections', () => {
        const { document } = env;
        document.getElementById('add-workout-equipment-btn').click();

        const fixedBtn = document.querySelector('#workout-equipment-kind [data-kind="fixed"]');
        const platedBtn = document.querySelector('#workout-equipment-kind [data-kind="plated"]');
        expect(fixedBtn.getAttribute('aria-pressed')).toBe('true');

        platedBtn.click();
        expect(platedBtn.getAttribute('aria-pressed')).toBe('true');
        expect(fixedBtn.getAttribute('aria-pressed')).toBe('false');
        expect(document.getElementById('workout-equipment-fixed-section').hidden).toBe(true);
        expect(document.getElementById('workout-equipment-plated-section').hidden).toBe(false);

        fixedBtn.click();
        expect(document.getElementById('workout-equipment-fixed-section').hidden).toBe(false);
        expect(document.getElementById('workout-equipment-plated-section').hidden).toBe(true);
    });

    it('plate rows can be added and removed', () => {
        const { document } = env;
        document.getElementById('add-workout-equipment-btn').click();
        document.querySelector('#workout-equipment-kind [data-kind="plated"]').click();

        expect(document.querySelectorAll('#workout-equipment-plates [data-plate-row]')).toHaveLength(1);
        document.getElementById('workout-equipment-plate-add').click();
        document.getElementById('workout-equipment-plate-add').click();
        expect(document.querySelectorAll('#workout-equipment-plates [data-plate-row]')).toHaveLength(3);

        const rows = document.querySelectorAll('#workout-equipment-plates [data-plate-row]');
        rows[0].querySelector('.wg-equipment-plate-row__remove').click();
        expect(document.querySelectorAll('#workout-equipment-plates [data-plate-row]')).toHaveLength(2);
    });

    it('fixed min/max/step generator fills the loads list', () => {
        const { document, window } = env;
        window.safeAlert = vi.fn();
        document.getElementById('add-workout-equipment-btn').click();

        document.getElementById('workout-equipment-gen-min').value = '10';
        document.getElementById('workout-equipment-gen-max').value = '15';
        document.getElementById('workout-equipment-gen-step').value = '2.5';
        document.getElementById('workout-equipment-gen-fill').click();

        expect(document.getElementById('workout-equipment-loads').value).toBe('10, 12.5, 15');
        expect(window.safeAlert).not.toHaveBeenCalled();
    });

    it('generator refuses a runaway range instead of building it', () => {
        const { document, window } = env;
        window.safeAlert = vi.fn();
        document.getElementById('add-workout-equipment-btn').click();

        document.getElementById('workout-equipment-gen-min').value = '1';
        document.getElementById('workout-equipment-gen-max').value = '500';
        document.getElementById('workout-equipment-gen-step').value = '0.5';
        document.getElementById('workout-equipment-gen-fill').click();

        expect(window.safeAlert).toHaveBeenCalledTimes(1);
        expect(document.getElementById('workout-equipment-loads').value).toBe('');
    });

    it('save validates the required name field without calling the API', async () => {
        const { window, document } = env;
        window.apiCall = vi.fn();
        window.safeAlert = vi.fn();

        document.getElementById('add-workout-equipment-btn').click();
        document.getElementById('workout-equipment-name').value = '';
        document.getElementById('workout-equipment-loads').value = '10, 12';
        await window.WorkoutEquipment.save();

        expect(window.apiCall).not.toHaveBeenCalled();
        expect(window.safeAlert).toHaveBeenCalledTimes(1);
    });

    it('save rejects a non-numeric loads token without calling the API', async () => {
        const { window, document } = env;
        window.apiCall = vi.fn();
        window.safeAlert = vi.fn();

        document.getElementById('add-workout-equipment-btn').click();
        document.getElementById('workout-equipment-name').value = 'Hex DBs';
        document.getElementById('workout-equipment-loads').value = '10, twelve, 15';
        await window.WorkoutEquipment.save();

        expect(window.apiCall).not.toHaveBeenCalled();
        expect(window.safeAlert).toHaveBeenCalledTimes(1);
    });

    it('save rolls back the optimistic create when the POST returns null', async () => {
        const { window, document } = env;
        seedOnlineList(window, [FIXED_DB]);
        await window.WorkoutEquipment.load();
        expect(rowsOf(document)).toHaveLength(1);

        const alerts = [];
        window.safeAlert = (msg) => alerts.push(msg);
        window.apiCall = vi.fn(async () => null);

        document.getElementById('add-workout-equipment-btn').click();
        document.getElementById('workout-equipment-name').value = 'Ghost bar';
        document.getElementById('workout-equipment-loads').value = '10, 12';
        await window.WorkoutEquipment.save();

        expect(alerts.length).toBeGreaterThan(0);
        // Rollback restored the seeded cache row — no lingering local_ phantom.
        const cached = await window.DataStore.getCached('workout_equipment');
        expect(cached.map((e) => e.name)).toEqual(['Hex DBs']);
        expect(cached.some((e) => String(e.id).startsWith('local_'))).toBe(false);
        const names = rowsOf(document).map((r) => r.querySelector('.wg-equipment-row__name').textContent);
        expect(names).toEqual(['Hex DBs']);
    });

    it('save rolls back the optimistic create when the POST throws', async () => {
        const { window, document } = env;
        seedOnlineList(window, [FIXED_DB]);
        await window.WorkoutEquipment.load();

        const alerts = [];
        window.safeAlert = (msg) => alerts.push(msg);
        window.apiCall = vi.fn(async () => { throw new Error('boom'); });

        document.getElementById('add-workout-equipment-btn').click();
        document.getElementById('workout-equipment-name').value = 'Ghost bar';
        document.getElementById('workout-equipment-loads').value = '10, 12';
        await window.WorkoutEquipment.save();

        expect(alerts.length).toBeGreaterThan(0);
        const cached = await window.DataStore.getCached('workout_equipment');
        expect(cached.map((e) => e.name)).toEqual(['Hex DBs']);
        expect(cached.some((e) => String(e.id).startsWith('local_'))).toBe(false);
        const names = rowsOf(document).map((r) => r.querySelector('.wg-equipment-row__name').textContent);
        expect(names).toEqual(['Hex DBs']);
    });

    it('edit with a failed reconcile shows Saving… instead of stale step/max', async () => {
        const { window, document } = env;
        seedOnlineList(window, [FIXED_DB]);
        await window.WorkoutEquipment.load();

        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'PUT') return true;
            return null; // reconcile GET fails -> commit keeps the nulled projection
        });
        window.apiCallDirect = vi.fn(async () => [structuredClone(FIXED_DB)]);

        rowsOf(document)[0].querySelector('.wg-equipment-row__edit').click();
        document.getElementById('workout-equipment-loads').value = '10, 12';
        await window.WorkoutEquipment.save();

        await vi.waitFor(() => {
            expect(rowsOf(document).map((r) => r.querySelector('.wg-equipment-row__steps').textContent))
                .toEqual(['Saving…']);
        });
    });

    it('editing a second item does not leak the first item\'s plates into a kind conversion', async () => {
        const { window, document } = env;
        seedOnlineList(window, [FIXED_DB, PLATED_BAR]);
        await window.WorkoutEquipment.load();

        await window.WorkoutEquipment.openEdit(PLATED_BAR.id);
        expect(document.querySelectorAll('#workout-equipment-plates [data-plate-row]')).toHaveLength(2);
        window.WorkoutEquipment.close();

        await window.WorkoutEquipment.openEdit(FIXED_DB.id);
        expect(document.getElementById('workout-equipment-loads').value).toBe('10, 12, 14, 16');
        // Convert to plated mid-edit: the form must start from a clean slate,
        // not Ohio bar's plate inventory (a fixed item has no plates, so the
        // converted half starts empty — the user adds rows via + Plate).
        document.querySelector('#workout-equipment-kind [data-kind="plated"]').click();
        expect(document.querySelectorAll('#workout-equipment-plates [data-plate-row]')).toHaveLength(0);
        expect(document.getElementById('workout-equipment-bar').value).toBe('');
        document.getElementById('workout-equipment-plate-add').click();
        const plateRows = document.querySelectorAll('#workout-equipment-plates [data-plate-row]');
        expect(plateRows).toHaveLength(1);
        expect(plateRows[0].querySelector('[data-plate-kg]').value).toBe('');
    });

    it('edit prefills the form and PUTs the update', async () => {
        const { window, document } = env;
        seedOnlineList(window, [FIXED_DB]);
        await window.WorkoutEquipment.load();
        expect(rowsOf(document)).toHaveLength(1);

        const calls = [];
        window.apiCall = vi.fn(async (url, method, body) => {
            calls.push([url, method, body]);
            if (method === 'PUT') return true;
            if (url === '/api/workout/equipment' && method === 'GET') return [structuredClone(updated)];
            return null;
        });
        const updated = { ...FIXED_DB, name: 'Hex DBs v2', loads_kg: [10, 12], max_kg: 12 };
        window.apiCallDirect = vi.fn(async () => [structuredClone(updated)]);

        rowsOf(document)[0].querySelector('.wg-equipment-row__edit').click();
        expect(document.getElementById('workout-equipment-modal-title').textContent).toBe('Edit Equipment');
        expect(document.getElementById('workout-equipment-name').value).toBe('Hex DBs');
        expect(document.getElementById('workout-equipment-loads').value).toBe('10, 12, 14, 16');

        document.getElementById('workout-equipment-name').value = 'Hex DBs v2';
        document.getElementById('workout-equipment-loads').value = '10, 12';
        document.getElementById('workout-equipment-save-btn').click();

        await vi.waitFor(() => {
            expect(calls.length).toBeGreaterThan(0);
        });
        expect(calls[0][0]).toBe('/api/workout/equipment/1');
        expect(calls[0][1]).toBe('PUT');
        expect(calls[0][2]).toEqual({ kind: 'fixed', name: 'Hex DBs v2', loads_kg: [10, 12] });

        await vi.waitFor(() => {
            expect(rowsOf(document).map((r) => r.querySelector('.wg-equipment-row__name').textContent))
                .toEqual(['Hex DBs v2']);
        });
    });

    it('delete removes the row optimistically on success', async () => {
        const { window, document } = env;
        seedOnlineList(window, [FIXED_DB]);
        await window.WorkoutEquipment.load();
        expect(rowsOf(document)).toHaveLength(1);

        window.apiCall = vi.fn(async () => true);
        window.apiCallDirect = vi.fn(async () => []);

        rowsOf(document)[0].querySelector('.wg-equipment-row__delete').click();

        await vi.waitFor(() => {
            expect(window.apiCall).toHaveBeenCalledWith(
                '/api/workout/equipment/1', 'DELETE', null, expect.anything()
            );
        });
        await vi.waitFor(() => {
            expect(rowsOf(document)).toHaveLength(0);
        });
    });

    it('delete rolls back and restores the row when the API fails', async () => {
        const { window, document } = env;
        seedOnlineList(window, [FIXED_DB]);
        await window.WorkoutEquipment.load();
        expect(rowsOf(document)).toHaveLength(1);

        const alerts = [];
        window.safeAlert = (msg) => alerts.push(msg);
        window.apiCall = vi.fn(async () => null);
        // Background revalidation after rollback resolves empty; the
        // rollback-restored cache paints first and wins the assertion below.
        window.apiCallDirect = vi.fn(async () => [structuredClone(FIXED_DB)]);

        rowsOf(document)[0].querySelector('.wg-equipment-row__delete').click();

        await vi.waitFor(() => {
            expect(window.apiCall).toHaveBeenCalled();
        });
        await vi.waitFor(() => {
            expect(alerts.length).toBeGreaterThan(0);
        });
        expect(rowsOf(document)).toHaveLength(1);
        expect(rowsOf(document)[0].querySelector('.wg-equipment-row__name').textContent).toBe('Hex DBs');
    });

    it('warm-cache offline render paints cached rows without hitting the network', async () => {
        const { window, document } = env;
        installApiCacheMap(window, {
            workout_equipment: { data: [FIXED_DB], timestamp: Date.now() - 10 * 60 * 1000 }
        });
        setOnline(window, false);
        window.apiCallDirect = vi.fn();

        await window.WorkoutEquipment.load();

        expect(window.apiCallDirect).not.toHaveBeenCalled();
        const rows = rowsOf(document);
        expect(rows).toHaveLength(1);
        expect(rows[0].querySelector('.wg-equipment-row__steps').textContent).toBe('step 2 kg · max 16 kg');
    });

    it('no-cache offline render shows the explicit empty state', async () => {
        const { window, document } = env;
        setOnline(window, false);
        window.apiCallDirect = vi.fn(async () => { throw new TypeError('fetch failed'); });

        await window.WorkoutEquipment.load();

        const list = document.getElementById('workout-equipment-list');
        expect(list.textContent).toContain('No cached equipment');
        expect(rowsOf(document)).toHaveLength(0);
    });

    it('five sub-tab pills carry no inline style and the strip has the no-scroll compaction rule', () => {
        const { document } = env;
        const buttons = document.querySelectorAll('.wg-workouts-subtabs .workout-tab');
        expect(buttons.length).toBe(5);
        buttons.forEach((btn) => {
            expect(btn.getAttribute('style')).toBeNull();
        });
        // jsdom has no layout engine, so phone-width fit is pinned at the
        // stylesheet level: the .wg-workouts-subtabs__btn rule itself must
        // carry flex-1 (share the track), min-width: 0 (shrink below content
        // instead of pushing the strip into a horizontal scroll) and the
        // compact mono size.
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        const match = css.match(/\.wg-workouts-subtabs__btn\s*\{([^}]+)\}/);
        expect(match).not.toBeNull();
        expect(match[1]).toContain('flex: 1;');
        expect(match[1]).toContain('min-width: 0;');
        expect(match[1]).toContain('font-size: var(--font-size-xs);');
    });
});
