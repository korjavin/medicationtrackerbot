// Apple Health import (bd med-w6gx.6) — iOS app shell; the Android shell
// answers the same window.Health ops from Health Connect (bd med-nt9p.8).
//
// cloud-boot.js imports this only when window.Health.isSupported() (the
// native/ ios or android platform), so on the web nothing here loads or runs. It owns:
//   - the Settings → "Apple Health" (or "Health Connect") toggle row (mounted, like feedback-ui.js,
//     into the Settings home; no index.html change);
//   - the import run: an anchored query per kind through window.Health
//     (CLAUDE.md rule 10), mapped into the vault by web/domain/healthimport.js.
//     Runs at unlock and whenever the app comes back to the foreground; no
//     background delivery in v1.
//
// Device-local state lives in localStorage on purpose: HealthKit anchors (on
// Android, Health Connect change tokens) and the on/off choice belong to this
// device's Health store, not to the vault.
// Losing them only costs a re-scan, which the deterministic recordIds absorb.
// Data path: Health → this page → the encrypted vault, same as a hand-entered
// reading; nothing new leaves the device.
import { recordsPort, ORIGIN_EXTERNAL, flushConfirmed } from './sync.js';
import { createHealthImportDomain } from '../../domain/healthimport.js';
import { diagLine } from './passkey-diag.js';

// Sleep and workouts: bd med-w6gx.7. Steps, HR and SpO2: bd med-0xad.1.
export const HEALTH_KINDS = ['bp', 'weight', 'sleep', 'workout', 'steps', 'hr', 'spo2'];
const DAY_MS = 24 * 3600 * 1000;
// Steps are daily totals read by time window, not by anchor. anchors.steps is
// the ms of the last read that returned days: the next read starts a week
// before it (a day's total keeps growing and a late sync can raise an earlier
// day; the writer keeps the max), so days the app stayed closed are covered.
// No anchors.steps (first run, rescan, reset): the whole last year.
const STEPS_FIRST_DAYS = 365;
const STEPS_DAYS = 7;
// HR/SpO2 are dense: the first anchored read (no anchor yet) starts this far back.
const SAMPLES_FIRST_DAYS = 90;
const WINDOWED_FIRST = { hr: SAMPLES_FIRST_DAYS, spo2: SAMPLES_FIRST_DAYS };
const ENABLED_KEY = 'wg.health.enabled';
const ANCHORS_KEY = 'wg.health.anchors';
const LAST_KEY = 'wg.health.last';
const ASKED_KEY = 'wg.health.asked';
// Start (ms) of the earliest sleep night not settled at the last run: the
// anchor has already moved past its samples, so the next run re-reads sleep
// from there by time window (healthimport.js SLEEP_SETTLE_MS).
const SLEEP_PENDING_KEY = 'wg.health.sleepPending';
// The same margin Health.swift pads an anchored sleep page with, so the night
// lies whole inside the re-read window.
const SLEEP_PAD_MS = 48 * 3600 * 1000;
// An empty re-read (what HealthKit answers once read access is revoked) keeps
// the pending night; it is dropped only past this age.
// ponytail: fixed 7-day cap, a night whose access stays revoked longer is lost.
const SLEEP_PENDING_CAP_MS = 7 * 24 * 3600 * 1000;
const PAGE = 500;
// ponytail: caps one run at 20k samples per kind; the saved anchor resumes the
// rest on the next open.
const MAX_PAGES = 40;
const ROW_ID = 'health-import-row';
const TOGGLE_ID = 'health-import-toggle';

function readJSON(storage, key, fallback) {
    try {
        const v = JSON.parse(storage.getItem(key));
        return v === null || v === undefined ? fallback : v;
    } catch {
        return fallback;
    }
}

function writeJSON(storage, key, value) {
    try { storage.setItem(key, JSON.stringify(value)); } catch { /* private mode / quota: next run re-scans */ }
}

export function isHealthImportEnabled(storage = globalThis.localStorage) {
    return readJSON(storage, ENABLED_KEY, false) === true;
}

// Forget how far this iPhone's Health store was read — the switch-on rescan
// below, kept apart from the on/off choice and the Settings row's tally: after
// a replace-import the records no longer match the anchors, and the next run
// re-reads the whole history (putIfAbsent absorbs what is there).
export function resetHealthAnchors(storage = globalThis.localStorage) {
    writeJSON(storage, ANCHORS_KEY, {});
    try { storage.removeItem(SLEEP_PENDING_KEY); } catch { /* storage blocked: nothing kept */ }
}

// One diagnostics line per kind per run (bd med-w6gx.30), counts only — no
// times, no readings; for sleep the HealthKit value histogram (0 In Bed, 1
// asleep, 2 awake, 3-5 stages), e.g.
// [health] sleep returned=3 samples=3 values={0:1} nights=0 written=0 skip{inBed:1,unsettled:0,clipped:0,exists:0} anchor=moved
function kindLine(kind, st) {
    const obj = (o) => `{${Object.keys(o).map((k) => `${k}:${o[k]}`).join(',')}}`;
    const vals = Object.fromEntries(Object.entries(st.values).sort((a, b) => Number(a[0]) - Number(b[0])));
    return `[health] ${kind} returned=${st.returned} samples=${st.samples}`
        + (kind === 'sleep' ? ` values=${obj(vals)} nights=${st.nights}` : '')
        + ` written=${st.written} skip${obj(st.skip)} anchor=${st.anchor}`
        + (st.error ? ` error=${st.error}` : '');
}

function timeZone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

// One import pass over every kind. Returns { added }, or null when off;
// rejects when every kind failed.
// The anchor is saved after each page's writes are in the local store, so a
// crash mid-run re-reads at most one page — which putIfAbsent makes a no-op.
export async function runHealthImport(ctx, {
    health = globalThis.Health,
    storage = globalThis.localStorage,
    records = recordsPort(ctx, ORIGIN_EXTERNAL, { deferFlush: true }),
    flush = () => flushConfirmed(ctx),
    now = Date.now,
    diag = diagLine,
} = {}) {
    if (!health || !health.isSupported() || !isHealthImportEnabled(storage)) return null;
    const domain = createHealthImportDomain({ records, now, timeZone: timeZone() });
    const anchors = readJSON(storage, ANCHORS_KEY, {});
    const last = readJSON(storage, LAST_KEY, {});
    // Samples ever seen per kind: a kind that never returns any while others
    // do is most likely switched off in Health's per-type access (statusText).
    const seen = { ...(last.seen || {}) };
    let added = 0;
    let lastError = null;
    let failed = 0;
    for (const kind of HEALTH_KINDS) {
        const st = { returned: 0, samples: 0, values: {}, nights: 0, written: 0, skip: {}, anchor: 'kept', error: null };
        // One kind failing (e.g. a type this device was never asked access
        // for) must not stop the others; its anchor stays where it was.
        try {
            const pending = [];
            const take = async (res) => {
                const samples = res && Array.isArray(res.samples) ? res.samples : [];
                st.returned += (res && Number(res.returned)) || 0;
                st.samples += samples.length;
                if (kind === 'sleep') {
                    for (const s of samples) {
                        const v = s && Number.isInteger(s.value) ? s.value : '?';
                        st.values[v] = (st.values[v] || 0) + 1;
                    }
                }
                // The whole result goes along: sleep reads its window ({from, to}).
                const r = await domain.importSamples(kind, res && res.samples, res);
                added += r.added;
                st.written += r.added;
                st.nights += r.nights || 0;
                for (const [k, n] of Object.entries(r.skip || {})) st.skip[k] = (st.skip[k] || 0) + n;
                // Saved before the caller moves the anchor past these samples:
                // a later page failing must not lose an unsettled night.
                if (Number.isFinite(r.pending)) {
                    pending.push(r.pending);
                    writeJSON(storage, SLEEP_PENDING_KEY, Math.min(...pending));
                }
            };
            const since = kind === 'sleep' ? readJSON(storage, SLEEP_PENDING_KEY, null) : null;
            if (Number.isFinite(since)) {
                const res = await health.query({ type: 'sleep', from: since - SLEEP_PAD_MS, to: now() });
                await take(res);
                if (!(res && Array.isArray(res.samples) && res.samples.length) && since > now() - SLEEP_PENDING_CAP_MS) {
                    pending.push(since);
                }
            }
            if (kind === 'steps') {
                const at = now();
                const lastRead = Number(anchors.steps);
                const from = Number.isFinite(lastRead) && lastRead > 0
                    ? Math.min(lastRead, at) - STEPS_DAYS * DAY_MS : at - STEPS_FIRST_DAYS * DAY_MS;
                const res = await health.query({ type: 'steps', from, to: at });
                await take(res);
                // Like an anchor: kept only once days came back (by samples,
                // not `returned`, which a windowed read may leave at 0).
                if (res && Array.isArray(res.samples) && res.samples.length > 0) {
                    anchors.steps = String(at);
                    writeJSON(storage, ANCHORS_KEY, anchors);
                    st.anchor = 'moved';
                }
            }
            for (let page = 0; kind !== 'steps' && page < MAX_PAGES; page++) {
                const q = { type: kind, anchor: anchors[kind] || null, limit: PAGE };
                if (!q.anchor && WINDOWED_FIRST[kind]) q.from = now() - WINDOWED_FIRST[kind] * DAY_MS;
                const res = await health.query(q);
                await take(res);
                // Only an anchor that moved past something we saw is kept: while
                // read access is denied Health returns nothing, and an anchor
                // saved then could skip the history once access is granted.
                if (res && typeof res.anchor === 'string' && res.returned > 0) {
                    anchors[kind] = res.anchor;
                    writeJSON(storage, ANCHORS_KEY, anchors);
                    st.anchor = 'moved';
                }
                if (!res || !res.more) break;
            }
            if (kind === 'sleep') {
                writeJSON(storage, SLEEP_PENDING_KEY, pending.length ? Math.min(...pending) : null);
            }
        } catch (e) {
            console.error(`[health] ${kind} import failed`, e);
            st.error = (e && e.name) || 'Error';
            lastError = e;
            failed++;
            // A shell that predates this kind dropped it from the authorize
            // sheet and rejects its query: forget it was asked, so the build
            // that knows it shows the sheet (startHealthImport re-asks).
            const asked = readJSON(storage, ASKED_KEY, []);
            if (Array.isArray(asked) && asked.includes(kind)) {
                writeJSON(storage, ASKED_KEY, asked.filter((k) => k !== kind));
            }
        }
        seen[kind] = (seen[kind] || 0) + st.samples;
        diag(kindLine(kind, st));
    }
    writeJSON(storage, LAST_KEY, {
        checkedAt: now(),
        addedAt: added > 0 ? now() : last.addedAt || null,
        added,
        total: (last.total || 0) + added,
        seen,
    });
    // One chunked push for the whole batch instead of one POST per reading;
    // a failure leaves the rows pending for the next sync, nothing is lost.
    if (added > 0) await flush().catch(() => {});
    // Every kind failed: the store could not be read at all (pull to refresh
    // shows the fix). One kind failing alone stays a log line.
    if (failed === HEALTH_KINDS.length) throw lastError;
    return { added };
}

function formatWhen(ms) {
    return new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

// The store's name and where its read access is managed come from the
// capability (native/health.js): Apple Health on iOS, Health Connect on Android.
function healthLabel(health) {
    return (health && health.label) || 'Apple Health';
}

export function healthStatusText(storage = globalThis.localStorage, health = globalThis.Health) {
    if (!isHealthImportEnabled(storage)) return 'Import blood pressure, weight, sleep, workouts, steps, heart rate and SpO2';
    const last = readJSON(storage, LAST_KEY, {});
    if (!last.checkedAt) return 'Importing…';
    const hint = (health && health.accessHint) || 'Settings → Health → Data Access & Devices';
    // Health shares each type separately and never says one is off: sleep
    // never returning a sample while BP or weight do points at its switch.
    const seen = last.seen || {};
    const sleepHint = !seen.sleep && (seen.bp > 0 || seen.weight > 0)
        ? ` No sleep found: if you track sleep, turn on Sleep for Med Tracker in ${hint}.` : '';
    if (!last.total) return `Checked ${formatWhen(last.checkedAt)} · nothing yet. Check access in ${hint}.`;
    const n = `${last.total} reading${last.total === 1 ? '' : 's'} so far`;
    const added = last.addedAt ? ` (last new ${formatWhen(last.addedAt)})` : '';
    return `Checked ${formatWhen(last.checkedAt)} · ${n}${added}${sleepHint && `.${sleepHint}`}`;
}

// startHealthImport(ctx): mount the Settings row, run once now and again on
// every return to the foreground. One run at a time.
export function startHealthImport(ctx, {
    health = globalThis.Health,
    storage = globalThis.localStorage,
    doc = globalThis.document,
    afterImport = async () => {
        const { recomputeAndPush } = await import('./reminders.js');
        await recomputeAndPush(ctx);
    },
    run = (opts) => runHealthImport(ctx, opts),
    appRefresh = globalThis.AppRefresh,
} = {}) {
    if (!health || !health.isSupported()) return null;
    let inFlight = null;
    const refresh = () => {
        const desc = doc.getElementById(ROW_ID)?.querySelector('.wg-setting__desc');
        if (desc) desc.textContent = healthStatusText(storage, health);
    };
    // One pass at a time; rejects when the pass failed (pull to refresh toasts it).
    const pass = () => {
        if (inFlight) return inFlight;
        inFlight = Promise.resolve()
            .then(() => run({ health, storage }))
            .then(async (r) => {
                if (r && r.added > 0) await afterImport().catch((e) => console.error('[health] reminder recompute failed', e));
                return r;
            })
            .finally(() => { inFlight = null; refresh(); });
        return inFlight;
    };
    const importNow = () => pass().catch((e) => { console.error('[health] import failed', e); return null; });
    // Pull to refresh on Health (bd med-y7b4.6). An import switched off in
    // Settings has nothing to read: it resolves { added: 0 }. AppRefresh is a
    // classic body script: started mid-parse, register once it has loaded.
    const registerRefresh = () => {
        const ar = appRefresh || globalThis.AppRefresh;
        if (!ar || typeof ar.setImport !== 'function') return;
        ar.setImport(() => pass().then((r) => r || { added: 0 }), healthLabel(health),
            () => isHealthImportEnabled(storage));
    };
    if (!appRefresh && doc && doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', registerRefresh, { once: true });
    } else {
        registerRefresh();
    }

    mountHealthRow(doc, storage, health, async (on) => {
        if (!on) {
            writeJSON(storage, ENABLED_KEY, false);
            refresh();
            return true;
        }
        let available = false;
        try {
            available = await health.requestAuthorization(HEALTH_KINDS);
        } catch (e) {
            console.error('[health] authorization failed', e);
        }
        if (!available) {
            const desc = doc.getElementById(ROW_ID)?.querySelector('.wg-setting__desc');
            if (desc) desc.textContent = `${healthLabel(health)} is not available on this device.`;
            return false;
        }
        writeJSON(storage, ENABLED_KEY, true);
        writeJSON(storage, ASKED_KEY, HEALTH_KINDS);
        // Switching on is also the manual rescan: start from the beginning
        // (known readings are skipped by id).
        writeJSON(storage, ANCHORS_KEY, {});
        refresh();
        importNow();
        return true;
    });

    doc.addEventListener('visibilitychange', () => {
        if (doc.visibilityState === 'visible') importNow();
    });
    // Switched on by a build that read fewer kinds (bp/weight before
    // med-w6gx.7): ask once for the new ones before importing. Health shows
    // its sheet only for types it has not asked about yet.
    const asked = readJSON(storage, ASKED_KEY, []);
    if (isHealthImportEnabled(storage) && !HEALTH_KINDS.every((k) => Array.isArray(asked) && asked.includes(k))) {
        return Promise.resolve()
            .then(() => health.requestAuthorization(HEALTH_KINDS))
            .then(() => writeJSON(storage, ASKED_KEY, HEALTH_KINDS))
            .catch((e) => console.error('[health] authorization failed', e))
            .then(importNow);
    }
    return importNow();
}

// The Settings home row: a kit toggle row in its own .wg-list group.
// onToggle(on) resolves false to flip the switch back.
function mountHealthRow(doc, storage, health, onToggle) {
    const home = doc.querySelector('#settings-view .wg-settings-home');
    if (!home || doc.getElementById(ROW_ID)) return;

    const group = doc.createElement('div');
    group.className = 'wg-list';
    const row = doc.createElement('div');
    row.id = ROW_ID;
    row.className = 'wg-setting';

    const lead = doc.createElement('span');
    lead.className = 'wg-row__lead';
    const ico = doc.createElement('i');
    ico.className = 'wg-ico';
    ico.dataset.icon = 'health';
    lead.appendChild(ico);

    const body = doc.createElement('span');
    body.className = 'wg-setting__body';
    const title = doc.createElement('span');
    title.className = 'wg-setting__title';
    title.textContent = healthLabel(health);
    const desc = doc.createElement('span');
    desc.className = 'wg-setting__desc';
    desc.textContent = healthStatusText(storage, health);
    body.append(title, desc);

    const toggle = doc.createElement('label');
    toggle.className = 'wg-toggle';
    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.id = TOGGLE_ID;
    input.className = 'wg-toggle__input';
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', `Import from ${healthLabel(health)}`);
    input.checked = isHealthImportEnabled(storage);
    input.addEventListener('change', async () => {
        const want = input.checked;
        input.disabled = true;
        try {
            if (!(await onToggle(want))) input.checked = !want;
        } finally {
            input.disabled = false;
        }
    });
    toggle.appendChild(input);

    row.append(lead, body, toggle);
    group.appendChild(row);
    // Kit S6 slot ③ (bd med-ckm5.6).
    (home.querySelector('[data-settings-slot="health"]') || home).appendChild(group);
    if (globalThis.WGIcons && typeof globalThis.WGIcons.hydrate === 'function') globalThis.WGIcons.hydrate(group);
}
