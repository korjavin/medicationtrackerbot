// Apple Health import (bd med-w6gx.6) — iOS app shell only.
//
// cloud-boot.js imports this only when window.Health.isSupported() (the
// native/ ios platform), so on the web nothing here loads or runs. It owns:
//   - the Settings → "Apple Health" toggle row (mounted, like feedback-ui.js,
//     into the Settings home; no index.html change);
//   - the import run: an anchored query per kind through window.Health
//     (CLAUDE.md rule 10), mapped into the vault by web/domain/healthimport.js.
//     Runs at unlock and whenever the app comes back to the foreground; no
//     background delivery in v1.
//
// Device-local state lives in localStorage on purpose: HealthKit anchors and
// the on/off choice belong to this iPhone's Health store, not to the vault.
// Losing them only costs a re-scan, which the deterministic recordIds absorb.
// Data path: Health → this page → the encrypted vault, same as a hand-entered
// reading; nothing new leaves the device.
import { recordsPort, ORIGIN_EXTERNAL, flushConfirmed } from './sync.js';
import { createHealthImportDomain } from '../../domain/healthimport.js';

// Sleep and workouts: bd med-w6gx.7.
export const HEALTH_KINDS = ['bp', 'weight', 'sleep', 'workout'];
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

function timeZone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

// One import pass over every kind. Returns { added }, or null when off.
// The anchor is saved after each page's writes are in the local store, so a
// crash mid-run re-reads at most one page — which putIfAbsent makes a no-op.
export async function runHealthImport(ctx, {
    health = globalThis.Health,
    storage = globalThis.localStorage,
    records = recordsPort(ctx, ORIGIN_EXTERNAL, { deferFlush: true }),
    flush = () => flushConfirmed(ctx),
    now = Date.now,
} = {}) {
    if (!health || !health.isSupported() || !isHealthImportEnabled(storage)) return null;
    const domain = createHealthImportDomain({ records, now, timeZone: timeZone() });
    const anchors = readJSON(storage, ANCHORS_KEY, {});
    let added = 0;
    for (const kind of HEALTH_KINDS) {
        // One kind failing (e.g. a type this device was never asked access
        // for) must not stop the others; its anchor stays where it was.
        try {
            const pending = [];
            const take = async (res) => {
                // The whole result goes along: sleep reads its window ({from, to}).
                const r = await domain.importSamples(kind, res && res.samples, res);
                added += r.added;
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
            for (let page = 0; page < MAX_PAGES; page++) {
                const res = await health.query({ type: kind, anchor: anchors[kind] || null, limit: PAGE });
                await take(res);
                // Only an anchor that moved past something we saw is kept: while
                // read access is denied Health returns nothing, and an anchor
                // saved then could skip the history once access is granted.
                if (res && typeof res.anchor === 'string' && res.returned > 0) {
                    anchors[kind] = res.anchor;
                    writeJSON(storage, ANCHORS_KEY, anchors);
                }
                if (!res || !res.more) break;
            }
            if (kind === 'sleep') {
                writeJSON(storage, SLEEP_PENDING_KEY, pending.length ? Math.min(...pending) : null);
            }
        } catch (e) {
            console.error(`[health] ${kind} import failed`, e);
        }
    }
    const last = readJSON(storage, LAST_KEY, {});
    writeJSON(storage, LAST_KEY, {
        checkedAt: now(),
        addedAt: added > 0 ? now() : last.addedAt || null,
        added,
        total: (last.total || 0) + added,
    });
    // One chunked push for the whole batch instead of one POST per reading;
    // a failure leaves the rows pending for the next sync, nothing is lost.
    if (added > 0) await flush().catch(() => {});
    return { added };
}

function formatWhen(ms) {
    return new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function healthStatusText(storage = globalThis.localStorage) {
    if (!isHealthImportEnabled(storage)) return 'Import blood pressure, weight, sleep and workouts';
    const last = readJSON(storage, LAST_KEY, {});
    if (!last.checkedAt) return 'Importing…';
    if (!last.total) return `Checked ${formatWhen(last.checkedAt)} · nothing yet. Check access in Settings → Health → Data Access & Devices.`;
    return `Last imported ${formatWhen(last.addedAt || last.checkedAt)} · ${last.total} reading${last.total === 1 ? '' : 's'} so far`;
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
} = {}) {
    if (!health || !health.isSupported()) return null;
    let inFlight = null;
    const refresh = () => {
        const desc = doc.getElementById(ROW_ID)?.querySelector('.wg-setting__desc');
        if (desc) desc.textContent = healthStatusText(storage);
    };
    const importNow = () => {
        if (inFlight) return inFlight;
        inFlight = run({ health, storage })
            .then(async (r) => {
                if (r && r.added > 0) await afterImport().catch((e) => console.error('[health] reminder recompute failed', e));
                return r;
            })
            .catch((e) => { console.error('[health] import failed', e); return null; })
            .finally(() => { inFlight = null; refresh(); });
        return inFlight;
    };

    mountHealthRow(doc, storage, async (on) => {
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
            if (desc) desc.textContent = 'Apple Health is not available on this device.';
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
function mountHealthRow(doc, storage, onToggle) {
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
    title.textContent = 'Apple Health';
    const desc = doc.createElement('span');
    desc.className = 'wg-setting__desc';
    desc.textContent = healthStatusText(storage);
    body.append(title, desc);

    const toggle = doc.createElement('label');
    toggle.className = 'wg-toggle';
    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.id = TOGGLE_ID;
    input.className = 'wg-toggle__input';
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', 'Import from Apple Health');
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
    home.appendChild(group);
    if (globalThis.WGIcons && typeof globalThis.WGIcons.hydrate === 'function') globalThis.WGIcons.hydrate(group);
}
