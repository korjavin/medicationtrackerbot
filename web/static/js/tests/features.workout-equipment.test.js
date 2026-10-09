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

// med-8j5w.2: the list/editor also read the gyms + active gym through
// apiCallDirect; route those URLs to an explicit gym set (none by default)
// so the generic equipment mocks below keep meaning "the inventory".
function gymsAware(fn, gyms = [], activeId = null) {
    return vi.fn(async (url, ...rest) => {
        if (url === '/api/workout/locations') return structuredClone(gyms);
        if (url === '/api/workout/locations/active') return { location_id: activeId, location: null };
        return fn(url, ...rest);
    });
}

function seedOnlineList(window, items) {
    window.apiCallDirect = gymsAware(async () => structuredClone(items));
}

// Types into the in-page gym-name dialog (safePrompt) and presses Save.
async function submitGymName(window, document, value) {
    await vi.waitFor(() => expect(document.querySelector('.mt-confirm-modal__input')).not.toBeNull());
    const input = document.querySelector('.mt-confirm-modal__input');
    input.value = value;
    input.dispatchEvent(new window.Event('input'));
    document.querySelector('.mt-confirm-modal__confirm').click();
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
        const buttons = document.querySelectorAll('#workouts-subtabs .workout-tab');
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
        window.apiCallDirect = gymsAware(async () => [structuredClone(created)]);

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
        expect(calls[0][2]).toEqual({ kind: 'fixed', name: 'Hex DBs', loads_kg: [10, 12, 14, 16], implement: 'barbell' });

        await vi.waitFor(() => {
            expect(rowsOf(document).map((r) => r.querySelector('.wg-equipment-row__steps').textContent))
                .toEqual(['step 2 kg · max 16 kg']);
        });
        expect(window.WorkoutEdit.editingEquipmentId).toBeNull();
    });

    it('creates a plated barbell from the UI with the Type select and plate rows', async () => {
        const { window, document } = env;
        seedOnlineList(window, []);
        const calls = [];
        window.apiCall = vi.fn(async (url, method, body) => {
            calls.push([url, method, body]);
            if (method === 'POST') return { ...PLATED_BAR, id: 9 };
            return null;
        });
        window.apiCallDirect = gymsAware(async () => []);

        document.getElementById('add-workout-equipment-btn').click();
        document.querySelector('#workout-equipment-kind [data-kind="plated"]').click();
        expect(document.getElementById('workout-equipment-fixed-section').hidden).toBe(true);
        expect(document.getElementById('workout-equipment-plated-section').hidden).toBe(false);

        document.getElementById('workout-equipment-name').value = 'Ohio bar';
        document.getElementById('workout-equipment-type').value = 'barbell';
        document.getElementById('workout-equipment-bar').value = '20';
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
            kind: 'plated', name: 'Ohio bar', bar_kg: 20, sides: 2, pair: false,
            plates: [{ kg: 20, count: 2 }, { kg: 10, count: 2 }], implement: 'barbell'
        });
    });

    it('each Type option saves the right sides/pair combination', async () => {
        const { window, document } = env;
        seedOnlineList(window, []);
        const calls = [];
        window.apiCall = vi.fn(async (url, method, body) => {
            calls.push([url, method, body]);
            if (method === 'POST') return { id: 9 };
            return null;
        });
        window.apiCallDirect = gymsAware(async () => []);

        const cases = [
            ['barbell', { sides: 2, pair: false }],
            ['kettlebell', { sides: 1, pair: false }],
            ['dumbbell', { sides: 2, pair: true }],
            ['other', { sides: 2, pair: false }]
        ];
        for (const [type, want] of cases) {
            calls.length = 0;
            document.getElementById('add-workout-equipment-btn').click();
            document.querySelector('#workout-equipment-kind [data-kind="plated"]').click();
            document.getElementById('workout-equipment-name').value = `${type} rig`;
            document.getElementById('workout-equipment-type').value = type;
            document.getElementById('workout-equipment-bar').value = '20';
            const row = document.querySelector('#workout-equipment-plates [data-plate-row]');
            row.querySelector('[data-plate-kg]').value = '10';
            row.querySelector('[data-plate-count]').value = '2';
            await window.WorkoutEquipment.save();
            expect(calls[0][2]).toEqual({
                kind: 'plated', name: `${type} rig`, bar_kg: 20,
                sides: want.sides, pair: want.pair,
                plates: [{ kg: 10, count: 2 }], implement: type
            });
        }
    });

    it('max plates per side: saves the sleeve capacity, alerts on a bad value', async () => {
        const { window, document } = env;
        seedOnlineList(window, []);
        const calls = [];
        window.apiCall = vi.fn(async (url, method, body) => {
            calls.push([url, method, body]);
            if (method === 'POST') return { id: 9 };
            return null;
        });
        window.apiCallDirect = gymsAware(async () => []);
        window.safeAlert = vi.fn();

        document.getElementById('add-workout-equipment-btn').click();
        document.querySelector('#workout-equipment-kind [data-kind="plated"]').click();
        const field = document.getElementById('workout-equipment-max-plates');
        expect(field.closest('#workout-equipment-plated-section')).not.toBeNull();
        expect(field.value).toBe('');
        document.getElementById('workout-equipment-name').value = 'Short sleeve';
        document.getElementById('workout-equipment-bar').value = '20';
        const row = document.querySelector('#workout-equipment-plates [data-plate-row]');
        row.querySelector('[data-plate-kg]').value = '20';
        row.querySelector('[data-plate-count]').value = '10';

        field.value = '2.5';
        await window.WorkoutEquipment.save();
        expect(calls).toHaveLength(0);
        expect(window.safeAlert).toHaveBeenCalledTimes(1);

        field.value = '4';
        await window.WorkoutEquipment.save();
        expect(calls[0][2]).toEqual({
            kind: 'plated', name: 'Short sleeve', bar_kg: 20, sides: 2, pair: false,
            plates: [{ kg: 20, count: 10 }], max_plates_per_side: 4, implement: 'barbell'
        });
    });

    it('max plates per side: edit prefills it, the row explains it, blanking sends null', async () => {
        const { window, document } = env;
        const capped = { ...PLATED_BAR, id: 11, name: 'Short sleeve', max_plates_per_side: 4, max_kg: 100 };
        seedOnlineList(window, [capped]);
        await window.WorkoutEquipment.load();
        expect(rowsOf(document)[0].querySelector('.wg-equipment-row__steps').textContent)
            .toBe('step 2.5 kg · max 100 kg · ≤4 plates/side');

        const calls = [];
        window.apiCall = vi.fn(async (url, method, body) => {
            calls.push([url, method, body]);
            if (method === 'PUT') return true;
            return [structuredClone(capped)];
        });

        await window.WorkoutEquipment.openEdit(capped.id);
        const field = document.getElementById('workout-equipment-max-plates');
        expect(field.value).toBe('4');
        field.value = '';
        await window.WorkoutEquipment.save();
        const put = calls.find((c) => c[1] === 'PUT');
        expect(put[0]).toBe('/api/workout/equipment/11');
        expect(put[2].max_plates_per_side).toBeNull();
    });

    it('max plates per side: a record that never had a limit omits the key when left blank', async () => {
        const { window, document } = env;
        seedOnlineList(window, [PLATED_BAR]);
        await window.WorkoutEquipment.load();

        const calls = [];
        window.apiCall = vi.fn(async (url, method, body) => {
            calls.push([url, method, body]);
            if (method === 'PUT') return true;
            return [structuredClone(PLATED_BAR)];
        });

        await window.WorkoutEquipment.openEdit(PLATED_BAR.id);
        expect(document.getElementById('workout-equipment-max-plates').value).toBe('');
        await window.WorkoutEquipment.save();
        const put = calls.find((c) => c[1] === 'PUT');
        expect(put[0]).toBe('/api/workout/equipment/2');
        expect('max_plates_per_side' in put[2]).toBe(false);
    });

    it('editing a pair:true record reopens with the dumbbell Type selected', async () => {
        const { window, document } = env;
        const pairRecord = { ...PLATED_BAR, id: 7, name: 'Loadable DBs', sides: 2, pair: true };
        seedOnlineList(window, [pairRecord]);
        await window.WorkoutEquipment.load();

        await window.WorkoutEquipment.openEdit(pairRecord.id);

        expect(document.getElementById('workout-equipment-modal-title').textContent).toBe('Edit Equipment');
        expect(document.getElementById('workout-equipment-type').value).toBe('dumbbell');
        expect(document.getElementById('workout-equipment-bar').value).toBe('20');
    });

    it('editing a record outside the three combinations opens kettlebell (sides:1 wins)', async () => {
        const { window, document } = env;
        const oddRecord = { ...PLATED_BAR, id: 8, name: 'Odd bell', sides: 1, pair: true };
        seedOnlineList(window, [oddRecord]);
        await window.WorkoutEquipment.load();

        await window.WorkoutEquipment.openEdit(oddRecord.id);

        expect(document.getElementById('workout-equipment-type').value).toBe('kettlebell');
    });

    it('with kind=fixed the shared Type select stays visible and saves onto the payload', async () => {
        const { window, document } = env;
        seedOnlineList(window, []);
        const calls = [];
        window.apiCall = vi.fn(async (url, method, body) => {
            calls.push([url, method, body]);
            if (method === 'POST') return { ...FIXED_DB, id: 9, implement: 'kettlebell' };
            return null;
        });
        window.apiCallDirect = gymsAware(async () => []);

        document.getElementById('add-workout-equipment-btn').click();
        const type = document.getElementById('workout-equipment-type');
        // Visible under kind=fixed: no hidden ancestor (it left the sectioned halves).
        expect(type.closest('[hidden]')).toBeNull();
        expect(document.getElementById('workout-equipment-fixed-section').hidden).toBe(false);

        document.getElementById('workout-equipment-name').value = 'KB';
        document.getElementById('workout-equipment-loads').value = '8';
        type.value = 'kettlebell';
        await window.WorkoutEquipment.save();

        expect(calls[0][2]).toEqual({ kind: 'fixed', name: 'KB', loads_kg: [8], implement: 'kettlebell' });
    });

    it('editing a legacy sides:1 record without implement preselects kettlebell', async () => {
        const { window, document } = env;
        const legacyBell = { ...PLATED_BAR, id: 11, name: 'Legacy bell', sides: 1, pair: false };
        delete legacyBell.implement; // legacy body: no implement key at all
        seedOnlineList(window, [legacyBell]);
        await window.WorkoutEquipment.load();

        await window.WorkoutEquipment.openEdit(legacyBell.id);

        expect(document.getElementById('workout-equipment-type').value).toBe('kettlebell');
    });

    it('editing a legacy fixed item opens blank and a rename sends no implement', async () => {
        const { window, document } = env;
        seedOnlineList(window, [FIXED_DB]);
        await window.WorkoutEquipment.load();

        const calls = [];
        window.apiCall = vi.fn(async (url, method, body) => {
            calls.push([url, method, body]);
            if (method === 'PUT') return true;
            if (url === '/api/workout/equipment' && method === 'GET') return [structuredClone(FIXED_DB)];
            return null;
        });
        window.apiCallDirect = gymsAware(async () => [structuredClone(FIXED_DB)]);

        await window.WorkoutEquipment.openEdit(FIXED_DB.id);
        expect(document.getElementById('workout-equipment-type').value).toBe('');

        document.getElementById('workout-equipment-name').value = 'Hex DBs v2';
        await window.WorkoutEquipment.save();

        expect(calls[0][1]).toBe('PUT');
        expect(calls[0][2]).toEqual({ kind: 'fixed', name: 'Hex DBs v2', loads_kg: [10, 12, 14, 16] });
        expect('implement' in calls[0][2]).toBe(false);
    });

    it('editing a record with a stored implement preselects it over sides/pair', async () => {
        const { window, document } = env;
        const odd = { ...PLATED_BAR, id: 12, name: 'Odd bar', sides: 2, pair: false, implement: 'other' };
        const kb = { ...FIXED_DB, id: 13, name: 'KB', loads_kg: [8], implement: 'kettlebell' };
        seedOnlineList(window, [odd, kb]);
        await window.WorkoutEquipment.load();

        await window.WorkoutEquipment.openEdit(odd.id);
        expect(document.getElementById('workout-equipment-type').value).toBe('other');
        window.WorkoutEquipment.close();

        await window.WorkoutEquipment.openEdit(kb.id);
        expect(document.getElementById('workout-equipment-type').value).toBe('kettlebell');
    });

    it('list rows prefix the kind tag with the implement label when set', async () => {
        const { window, document } = env;
        seedOnlineList(window, [
            { ...FIXED_DB, id: 21, implement: 'kettlebell' },
            { ...PLATED_BAR, id: 22, implement: 'barbell' }
        ]);

        await window.WorkoutEquipment.load();

        const tags = rowsOf(document).map((r) => r.querySelector('.wg-equipment-row__kind').textContent);
        expect(tags).toEqual(['Kettlebell · Fixed', 'Barbell · Plated']);
    });

    it('list rows show a decorative icon per implement before the name; other/absent show none', async () => {
        const { window, document } = env;
        seedOnlineList(window, [
            { ...PLATED_BAR, id: 30, implement: 'barbell' },
            { ...FIXED_DB, id: 31, implement: 'dumbbell' },
            { ...FIXED_DB, id: 32, implement: 'kettlebell' },
            { ...FIXED_DB, id: 33, implement: 'other' },
            { ...FIXED_DB, id: 34 } // legacy: no implement key
        ]);

        await window.WorkoutEquipment.load();

        const rows = rowsOf(document);
        const icons = rows.map((r) => {
            const icon = r.querySelector('.wg-equipment-row__icon');
            return icon ? icon.getAttribute('data-wg-icon') : null;
        });
        expect(icons).toEqual(['barbell', 'dumbbell', 'kettlebell', null, null]);
        const icon = rows[0].querySelector('.wg-equipment-row__icon');
        expect(icon.getAttribute('aria-hidden')).toBe('true');
        expect(icon.nextElementSibling.classList.contains('wg-equipment-row__name')).toBe(true);
        expect(window.WGIcons.paths.barbell).not.toBe(window.WGIcons.paths.kettlebell);
    });

    it('editor shows one shared Type select and nothing wider than the modal at phone width', () => {
        const { document } = env;
        // The Sides segment + Pair checkbox are gone; one Type select remains.
        expect(document.getElementById('workout-equipment-sides')).toBeNull();
        expect(document.getElementById('workout-equipment-pair')).toBeNull();
        const type = document.getElementById('workout-equipment-type');
        expect(type).not.toBeNull();
        expect(type.tagName.toLowerCase()).toBe('select');
        expect(Array.from(type.querySelectorAll('option')).map((o) => o.value))
            .toEqual(['', 'barbell', 'dumbbell', 'kettlebell', 'other']);
        expect(type.querySelector('option[value=""]').textContent).toBe('—');
        // Shared by both kinds: it lives outside the plated section.
        expect(type.closest('#workout-equipment-plated-section')).toBeNull();
        expect(type.closest('#workout-equipment-fixed-section')).toBeNull();
        // Full-width field like #exercise-library-equipment: sharing a row
        // with Bar would truncate the long option labels at phone width.
        expect(type.closest('.wg-equipment-modal__row')).toBeNull();
        // jsdom has no layout engine, so phone-width fit is pinned at the
        // stylesheet level like the sub-tab strip: the checkbox rules are
        // gone and every modal field shrinks below content instead of
        // pushing the 360px modal into a horizontal scroll.
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        expect(css).not.toContain('.wg-equipment-modal__field--check');
        expect(css).not.toContain('.wg-equipment-modal__check');
        const field = css.match(/\.wg-equipment-modal__field\s*\{([^}]+)\}/);
        expect(field).not.toBeNull();
        expect(field[1]).toContain('min-width: 0;');
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
        window.apiCallDirect = gymsAware(async () => [structuredClone(FIXED_DB)]);

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
        window.apiCallDirect = gymsAware(async () => [structuredClone(updated)]);

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
        expect('implement' in calls[0][2]).toBe(false);

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
        window.apiCallDirect = gymsAware(async () => []);

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
        window.apiCallDirect = gymsAware(async () => [structuredClone(FIXED_DB)]);

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
        window.apiCallDirect = gymsAware(async () => { throw new TypeError('fetch failed'); });

        await window.WorkoutEquipment.load();

        const list = document.getElementById('workout-equipment-list');
        expect(list.textContent).toContain('No cached equipment');
        expect(rowsOf(document)).toHaveLength(0);
    });

    it('five sub-tab options carry no inline style and the strip is the kit scrolling segment', () => {
        const { document } = env;
        const strip = document.getElementById('workouts-subtabs');
        // med-xso6.10: five options exceed a phone-width track, so the strip
        // is .wg-seg--scroll (options keep their width and the strip scrolls)
        // rather than a per-section shrink rule.
        expect(strip.classList.contains('wg-seg')).toBe(true);
        expect(strip.classList.contains('wg-seg--scroll')).toBe(true);
        const buttons = strip.querySelectorAll('.workout-tab');
        expect(buttons.length).toBe(5);
        buttons.forEach((btn) => {
            expect(btn.getAttribute('style')).toBeNull();
        });
    });
});

describe('features/workout/equipment.js — gyms (med-8j5w.2)', () => {
    let env;
    const HOME = { id: 41, name: 'Home' };
    const GYM_A = { id: 42, name: 'Gym A' };

    function groupLabels(document) {
        return Array.from(document.querySelectorAll('#workout-equipment-list .wg-equipment-group__label'))
            .map((el) => el.textContent);
    }

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

    it('no gyms: the flat list exactly as before — no group headers', async () => {
        const { window, document } = env;
        window.apiCallDirect = gymsAware(async () => [structuredClone(FIXED_DB)]);

        await window.WorkoutEquipment.load();

        expect(rowsOf(document)).toHaveLength(1);
        expect(document.querySelector('#workout-equipment-list .wg-equipment-group')).toBeNull();
        expect(document.querySelector('#workout-equipment-list .wg-equipment__error')).toBeNull();
    });

    it('groups items per gym with a trailing Portable group; a dangling gym reads as portable', async () => {
        const { window, document } = env;
        const atHome = { ...FIXED_DB, id: 1, location_id: HOME.id };
        const atA = { ...PLATED_BAR, id: 2, location_id: GYM_A.id };
        const dangling = { ...FIXED_DB, id: 3, name: 'Old DBs', location_id: 999 };
        const portable = { ...FIXED_DB, id: 4, name: 'Bands' };
        window.apiCallDirect = gymsAware(async () => [atHome, atA, dangling, portable].map((i) => structuredClone(i)),
            [GYM_A, HOME], GYM_A.id);

        await window.WorkoutEquipment.load();

        expect(groupLabels(document)).toEqual(['Gym A', 'Home', 'Portable / everywhere']);
        const sections = Array.from(document.querySelectorAll('#workout-equipment-list .wg-equipment-group'));
        const namesIn = (s) => Array.from(s.querySelectorAll('.wg-equipment-row__name')).map((n) => n.textContent);
        expect(namesIn(sections[0])).toEqual(['Ohio bar']);
        expect(namesIn(sections[1])).toEqual(['Hex DBs']);
        expect(namesIn(sections[2])).toEqual(['Old DBs', 'Bands']);
        // Active badge on Gym A only; the Portable group has no rename/delete.
        expect(sections[0].querySelector('.wg-equipment-group__active')).not.toBeNull();
        expect(sections[1].querySelector('.wg-equipment-group__active')).toBeNull();
        expect(sections[2].querySelector('.wg-equipment-group__actions')).toBeNull();
    });

    it('a failed gym read shows an error state, never "everything portable"', async () => {
        const { window, document } = env;
        window.apiCallDirect = vi.fn(async (url) => {
            if (url === '/api/workout/locations') throw new Error('boom');
            return [structuredClone({ ...FIXED_DB, location_id: HOME.id })];
        });

        await window.WorkoutEquipment.load();

        expect(document.querySelector('#workout-equipment-list .wg-equipment__error')).not.toBeNull();
        expect(document.querySelector('#workout-equipment-list .wg-equipment-group')).toBeNull();
        expect(rowsOf(document)).toHaveLength(1);
    });

    it('the editor Location select defaults to the active gym and saves location_id', async () => {
        const { window, document } = env;
        window.apiCallDirect = gymsAware(async () => [], [GYM_A, HOME], HOME.id);
        const calls = [];
        window.apiCall = vi.fn(async (url, method, body) => {
            calls.push([url, method, body]);
            if (method === 'POST') return { ...FIXED_DB, id: 9 };
            return null;
        });

        await window.WorkoutEquipment.openAdd();

        const field = document.getElementById('workout-equipment-location-field');
        const select = document.getElementById('workout-equipment-location');
        expect(field.hidden).toBe(false);
        expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Gym A', 'Home', 'Portable / everywhere']);
        expect(select.value).toBe(String(HOME.id));

        document.getElementById('workout-equipment-name').value = 'Hex DBs';
        document.getElementById('workout-equipment-loads').value = '10, 12';
        await window.WorkoutEquipment.save();
        expect(calls[0][2]).toMatchObject({ kind: 'fixed', name: 'Hex DBs', location_id: HOME.id });
    });

    it('editing keeps an untouched gym out of the payload; Portable sends null', async () => {
        const { window, document } = env;
        const item = { ...FIXED_DB, location_id: GYM_A.id };
        window.apiCallDirect = gymsAware(async () => [structuredClone(item)], [GYM_A, HOME], HOME.id);
        await window.WorkoutEquipment.load();
        const calls = [];
        window.apiCall = vi.fn(async (url, method, body) => {
            calls.push([url, method, body]);
            return method === 'PUT' ? true : null;
        });

        await window.WorkoutEquipment.openEdit(item.id);
        expect(document.getElementById('workout-equipment-location').value).toBe(String(GYM_A.id));
        await window.WorkoutEquipment.save();
        expect(calls[0][1]).toBe('PUT');
        expect('location_id' in calls[0][2]).toBe(false);

        calls.length = 0;
        await window.WorkoutEquipment.openEdit(item.id);
        document.getElementById('workout-equipment-location').value = '';
        await window.WorkoutEquipment.save();
        expect(calls[0][2].location_id).toBeNull();
    });

    it('no gyms: the editor Location field stays hidden and the payload has no location_id', async () => {
        const { window, document } = env;
        window.apiCallDirect = gymsAware(async () => []);
        const calls = [];
        window.apiCall = vi.fn(async (url, method, body) => {
            calls.push([url, method, body]);
            return method === 'POST' ? { id: 9 } : null;
        });

        await window.WorkoutEquipment.openAdd();
        expect(document.getElementById('workout-equipment-location-field').hidden).toBe(true);
        document.getElementById('workout-equipment-name').value = 'Hex DBs';
        document.getElementById('workout-equipment-loads').value = '10';
        await window.WorkoutEquipment.save();
        expect('location_id' in calls[0][2]).toBe(false);
    });

    it('add / rename / delete a gym hit the location routes', async () => {
        const { window, document } = env;
        window.apiCallDirect = gymsAware(async () => [], [HOME], null);
        await window.WorkoutEquipment.load();
        const calls = [];
        window.apiCall = vi.fn(async (url, method, body) => {
            calls.push([url, method, body]);
            if (url === '/api/workout/locations' && method === 'POST') return { id: 43, name: body.name };
            if (url === '/api/workout/locations' && method === 'GET') return [HOME];
            return true;
        });

        document.getElementById('add-workout-location-btn').click();
        await submitGymName(window, document, '  Gym B ');
        await vi.waitFor(() => {
            expect(calls.some(([u, m, b]) => u === '/api/workout/locations' && m === 'POST' && b.name === 'Gym B')).toBe(true);
        });

        const renamed = window.WorkoutEquipment.renameLocation(HOME.id);
        await vi.waitFor(() => expect(document.querySelector('.mt-confirm-modal__input')).not.toBeNull());
        expect(document.querySelector('.mt-confirm-modal__input').value).toBe('Home');
        await submitGymName(window, document, 'Garage');
        await renamed;
        expect(calls).toContainEqual([`/api/workout/locations/${HOME.id}`, 'PUT', { name: 'Garage' }]);

        await window.WorkoutEquipment.deleteLocation(HOME.id);
        expect(calls).toContainEqual([`/api/workout/locations/${HOME.id}`, 'DELETE', null]);
    });

    it('the gym name dialog is the in-page modal: blank names error inline, never a native dialog', async () => {
        const { window, document } = env;
        window.apiCallDirect = gymsAware(async () => []);
        window.apiCall = vi.fn(async () => true);
        window.prompt = vi.fn();
        window.alert = vi.fn();

        const pending = window.WorkoutEquipment.addLocation();
        await submitGymName(window, document, '   ');
        const error = document.querySelector('.mt-confirm-modal__error');
        expect(error.hidden).toBe(false);
        expect(error.textContent).toBe('Give the gym a name.');
        expect(document.querySelector('mt-modal.mt-confirm-modal')).not.toBeNull();
        expect(window.apiCall).not.toHaveBeenCalled();

        document.querySelector('.mt-confirm-modal__cancel').click();
        expect(await pending).toBe(false);
        expect(document.querySelector('mt-modal.mt-confirm-modal')).toBeNull();
        expect(window.prompt).not.toHaveBeenCalled();
        expect(window.alert).not.toHaveBeenCalled();
    });

    it('a cancelled gym dialog writes nothing', async () => {
        const { window, document } = env;
        window.apiCallDirect = gymsAware(async () => []);
        window.apiCall = vi.fn(async () => true);
        const pending = window.WorkoutEquipment.addLocation();
        await vi.waitFor(() => expect(document.querySelector('.mt-confirm-modal__cancel')).not.toBeNull());
        document.querySelector('.mt-confirm-modal__cancel').click();
        expect(await pending).toBe(false);
        expect(window.apiCall).not.toHaveBeenCalled();
    });
});
