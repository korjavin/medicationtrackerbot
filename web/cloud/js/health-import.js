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
import { recordsPort, ORIGIN_EXTERNAL, flushConfirmed, onLocalWrite, localWritesSettled } from './sync.js';
import { createHealthImportDomain, OPEN_SESSION_MS, STRENGTH_TYPES, overlaps } from '../../domain/healthimport.js';
import { findLibraryRowByName, exerciseKey } from '../../domain/workout.js';
import { localWallToUtcMs } from '../../domain/medschedule.js';
import { createSettingsDomain } from '../../domain/settings.js';
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
// One-time heal (bd med-y1gh): a device that already read sleep re-reads the
// last 30 days by window once, so a day stuck on a short first night (before a
// fuller one replaced it) heals. anchors.sleepHeal marks it done; a reset
// anchor re-reads the whole history anyway. 30 days = Android's first read.
// ponytail: a day stuck longer ago needs the switch-off/on rescan.
const SLEEP_HEAL_MS = 30 * 24 * 3600 * 1000;
const PAGE = 500;
// ponytail: caps one run at 20k samples per kind; the saved anchor resumes the
// rest on the next open.
const MAX_PAGES = 40;
// Write-back (bd med-8f4s.1): the device-local switch and the per-id ledger of
// what Health still owes, { bp: { recordId: clientTs }, weight: { … }, hr: { … }, workout: { … } }.
const WRITE_KEY = 'wg.health.write';
const DIRTY_KEY = 'wg.health.dirty';
// hr (bd med-8f4s.6) is the pulse of a bp row: no record type of its own, its
// ledger is keyed by the bp recordId, its Health key is `<recordId>/pulse`.
// workout (bd med-8f4s.5) is a completed workoutsession: start, end, type only.
const WRITE_KINDS = ['bp', 'weight', 'hr', 'workout'];
const RECORD_TYPE = { bp: 'bp', weight: 'weight', hr: 'bp', workout: 'workoutsession' };
// The write kinds a record type's put/del marks.
const MARKS = { bp: ['bp', 'hr'], weight: ['weight'], workoutsession: ['workout'] };
// HK traditionalStrengthTraining / HC EXERCISE_TYPE_STRENGTH_TRAINING, and HK
// .other / HC EXERCISE_TYPE_OTHER_WORKOUT (the import's own codes).
const ACTIVITY_STRENGTH = 50;
const ACTIVITY_OTHER = 3000;
// What a shell can write when its writeAccess reply has no `supported` (the
// shipped med-8f4s.2/.3 shells).
const DEFAULT_SUPPORTED = ['bp', 'weight'];
// The write kinds the write sheet has asked for on this device; absent on a
// device switched on before hr existed = the old sheet's two.
const WRITE_ASKED_KEY = 'wg.health.writeAsked';
// ponytail: 50 ledger ids per pass; the rest waits for the next pass. On a
// shell with readableFrom their writes go as ONE health.write({ entries })
// (bd med-8f4s.15; Health Connect's quota is per call), else one call per id.
const WRITE_BATCH = 50;
// The shells' permanent write errors (a reading the store always rejects):
// Health Connect "bad write: …" / "unknown write type" / "invalid …", HealthKit
// "bad write…" / "unknown type". A Copy id failing so is dropped, not retried.
const PERMANENT_RE = /^(bad write|unknown|invalid)\b/;
const ROW_ID = 'health-import-row';
const TOGGLE_ID = 'health-import-toggle';
const WRITE_ROW_ID = 'health-write-row';
const WRITE_TOGGLE_ID = 'health-write-toggle';
const KIND_NAMES = { bp: 'blood pressure', weight: 'weight', hr: 'pulse (heart rate)', workout: 'workouts' };
// Copy past entries (bd med-8f4s.11, kit HW6-HW9b). An entry is a bp reading
// (its pulse rides along as the hr mark), a weight or a completed workout.
const ENTRY_KINDS = ['bp', 'weight', 'workout'];
// The HW6 offer, once per device.
const OFFERED_KEY = 'wg.health.backfillOffered';
// The open copy: { startedAt, total, ids: { kind: [recordId] }, blocked: { kind: [recordId] } }.
// blocked = a kind whose read Health denied: the ids the user confirmed, not
// marked; re-read on each pass until it can be, then only those ids join (an
// entry synced in later never rides on an old Copy).
const JOB_KEY = 'wg.health.backfill';
// What this device has written to Health, { kind: { recordId: clientTs } }
// (entry kinds): the shells hide our own records from health.query, so a
// recount would offer them again. Any version counts; later edits are the
// hook's. Device-local: a reinstall or a second device recounts and replays
// (the shells' own-id upsert absorbs it).
const COPIED_KEY = 'wg.health.copied';
// The dedupe read pages until Health says it is done; past this many pages it
// gives up and the count fails (nothing marked) rather than copy from a
// partial list. 1,000 × PAGE samples is decades of readings.
const COPY_MAX_PAGES = 1000;
// A past entry another app already put into Health: the same values this close.
const MATCH_MS = { bp: 30 * 60 * 1000, weight: DAY_MS };
const COPY_GAP_MS = 1500;
const COPY_BACKOFF_MS = 60 * 1000;
// The back-off doubles up to 15× its first step (1 → 15 min).
const COPY_BACKOFF_CAP = 15;
// Failed passes in a row (1, 2, 4, 8, 15, then once more at 15) after which
// the copy counts as stuck.
const COPY_STUCK_FAILS = 6;
// The store's rate limit (Health Connect: "API call quota exceeded").
const QUOTA_RE = /quota|rate.?limit/i;
// The diagnostic log gets a class word, never the shell's error text (bd
// med-vjxz.1): that text can carry values or names.
const failClass = (text) => (/denied/.test(text) ? 'denied' : QUOTA_RE.test(text) ? 'quota' : 'other');
const errClass = (e) => failClass(String(e && e.message));
const COPY_ROW_ID = 'health-copy-row';

function readJSON(storage, key, fallback) {
    try {
        const v = JSON.parse(storage.getItem(key));
        return v === null || v === undefined ? fallback : v;
    } catch {
        return fallback;
    }
}

function writeJSON(storage, key, value) {
    try {
        storage.setItem(key, JSON.stringify(value));
        return true;
    } catch {
        return false; // private mode / quota: next run re-scans
    }
}

export function isHealthImportEnabled(storage = globalThis.localStorage) {
    return readJSON(storage, ENABLED_KEY, false) === true;
}

// "Also write my entries" (bd med-8f4s.1): only ever on with the import on;
// set by the Settings write row (startHealthImport).
export function isHealthWriteEnabled(storage = globalThis.localStorage) {
    return isHealthImportEnabled(storage) && readJSON(storage, WRITE_KEY, false) === true;
}

// The one eligibility rule for marking a local write: the boundary of what is
// mirrored is the operation (Archie 14798). Any put or delete made on this
// device of a bp/weight row without `source`, switch on: a new entry, an edit
// of a row synced in from another device, an old entry first edited after
// opt-in. Passive sync apply never reaches the seam. A tombstone carries no
// source, so it is always marked (its remove is a no-op for an id never written).
// A workout session is marked only once it is, or was, completed (a
// completed_at survives an un-complete, which must remove its copy): creating,
// starting, snoozing or skipping one has nothing to mirror.
function writeBackEligible(recordType, row, storage) {
    if (!MARKS[recordType] || !isHealthWriteEnabled(storage)) return false;
    if (row.deleted) return true;
    if (recordType === 'workoutsession') return row.status === 'completed' || Boolean(row.completed_at);
    return !row.source;
}

// A plan day marked Done without a start (push/Telegram Done, MCP, History
// Finish), bd med-8f4s.12 rule D: 5 minutes per exercise of the day from its
// scheduled time; the Done tap is never used.
const UNSTARTED_MS_PER_EXERCISE = 5 * 60 * 1000;

// The account's zone, as the workout domain resolves it (completionInstant):
// the pinned/floored settings zone, else this device's.
async function accountZone(records) {
    return (await createSettingsDomain({ records, now: Date.now, timeZone: timeZone() }).getGeneral()).timezone;
}

// A workout in Health is a finished span: completed, started, and ending after
// it started. Archie 15658: a span longer than OPEN_SESSION_MS (a session left
// open and finished hours later) ends at its last log if that is after the
// start, else at start + OPEN_SESSION_MS.
// Completed with no started_at: a plan day with a scheduled_time spans
// scheduled_date + scheduled_time (account zone) + 5 min × its exercises: the
// distinct exercises logged on it when any, else its exercise_snapshot (a
// legacy row without one: the plan's live exercises). Zero exercises, or no
// scheduled_time (ad-hoc), → no span.
async function workoutSpan(records, row) {
    if (row.status !== 'completed') return null;
    const logs = async () => (await records.listRaw('exerciselog')).filter((l) => !l.deleted && l.session_id === row.id);
    let start;
    let end;
    if (row.started_at) {
        if (!row.completed_at) return null;
        start = Date.parse(row.started_at);
        end = Date.parse(row.completed_at);
    } else {
        const day = String(row.scheduled_date || '').slice(0, 10);
        const hhmm = /^(\d{2}):(\d{2})$/.exec(row.scheduled_time || '');
        if (!hhmm || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
        const logged = await logs();
        let count = new Set(logged.map((l) => (l.exercise_id > 0 ? `id:${l.exercise_id}` : `name:${exerciseKey(l.exercise_name)}`))).size;
        if (!count) {
            count = Array.isArray(row.exercise_snapshot)
                ? row.exercise_snapshot.length
                : (await records.listRaw('workoutexercise')).filter((e) => !e.deleted && e.variant_id === row.variant_id).length;
        }
        if (!count) return null;
        const wall = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), +hhmm[1], +hhmm[2]);
        start = localWallToUtcMs(wall, await accountZone(records));
        end = start + count * UNSTARTED_MS_PER_EXERCISE;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    if (end - start > OPEN_SESSION_MS) {
        const last = Math.max(-Infinity, ...(await logs())
            .filter((l) => l.logged_at)
            .map((l) => Date.parse(l.logged_at))
            .filter(Number.isFinite));
        end = last > start ? Math.min(last, end) : start + OPEN_SESSION_MS;
    }
    return { start, end };
}

// Archie 15360: a plan day is strength; an ad-hoc session (group -1: Telegram,
// voice, "just log") is strength only if it has logs and every log's exercise
// is a library row tagged with a strength body part, else "other workout".
// ponytail: read at write time; a later tag or log edit is not re-sent until the session is.
async function workoutActivity(records, session) {
    if (session.group_id > 0) return ACTIVITY_STRENGTH;
    const logs = (await records.listRaw('exerciselog')).filter((l) => !l.deleted && l.session_id === session.id);
    if (!logs.length) return ACTIVITY_OTHER;
    const library = (await records.listRaw('exerciselibrary')).filter((r) => !r.deleted);
    const strength = logs.every((l) => {
        const item = (l.source === 'library' && l.exercise_id > 0 && library.find((r) => r.id === l.exercise_id))
            || findLibraryRowByName(library, l.exercise_name);
        const part = String((item && item.body_part) || '').trim();
        return part !== '' && part !== 'cardio';
    });
    return strength ? ACTIVITY_STRENGTH : ACTIVITY_OTHER;
}

// The Health key of a ledger entry: the hr object sits next to the bp
// correlation's <id> (and iOS's <id>/sys, <id>/dia) under its own key.
function healthId(kind, recordId) {
    return kind === 'hr' ? `${recordId}/pulse` : recordId;
}

function pulseOf(row) {
    const bpm = Number(row.pulse);
    return Number.isFinite(bpm) && bpm > 0 ? bpm : null;
}

function healthBody(kind, row) {
    const base = { type: kind, id: healthId(kind, row.recordId), version: row.clientTs, at: Date.parse(row.measured_at) };
    if (kind === 'bp') return { ...base, systolic: row.systolic, diastolic: row.diastolic };
    if (kind === 'hr') return { ...base, bpm: pulseOf(row) };
    return { ...base, kg: row.weight };
}

// Health write-back (bd med-8f4s.1). sync.js onLocalWrite reports every bp /
// weight / workoutsession put or delete made on this device; with the switch on, the hook marks
// the id in the ledger (synchronously, before the vault commit), then kicks
// that id's chain. A chain step waits for the commit, reads the raw row and
// makes Health match it: live → write, tombstone or absent → remove (a no-op
// where nothing was written). The entry is cleared only if it still holds the
// version the step started from, so a later edit survives an earlier success;
// a failure keeps it (moved to the back) for the next pass. Switch off: no
// marking, no delivery; the ledger is kept. No eviction, ever.
// Nothing reaches Health for a kind the last writeAccess read did not grant:
// its ids stay marked until a pass reads it granted. No write op at all on a
// shell whose shell.ops lacks health.write (an Android call has no timeout).
// Returns { drain, readAccess, supported, markAsked }: drain is one pass over
// at most WRITE_BATCH ledger ids (batched, see sendBatch); readAccess re-reads writeAccess alone
// (both hand each answer to onAccess(granted, supported)); supported resolves
// canWrite(); markAsked records the switch-on sheet's kinds.
export function startHealthWriteBack({
    health = globalThis.Health,
    storage = globalThis.localStorage,
    records,
    hook = onLocalWrite,
    settled = localWritesSettled,
    diag = diagLine,
    onAccess = () => {},
    // (kind, id) → true when the id is a Copy's and was dropped from its job
    // after a permanent error (startHealthImport); the ledger entry then goes too.
    onPermanent = () => false,
} = {}) {
    const ledger = () => readJSON(storage, DIRTY_KEY, {});
    // readableFrom of the last access read; null = an older shell, which
    // gets no entries batch.
    let readable = null;
    const chains = new Map();
    const supported = Promise.resolve()
        .then(() => typeof health.canWrite === 'function' && health.canWrite())
        .then((v) => v === true, () => false);
    // The last writeAccess answer: granted kinds, null when it could not be read.
    let access = null;
    // The kinds the last reply said this shell can write.
    let kindsSupported = DEFAULT_SUPPORTED;
    const readAccess = () => (access = supported
        .then((ok) => (ok ? health.writeAccess(WRITE_KINDS) : { granted: [] }))
        .then((r) => {
            // A malformed reply is a failed read, not "nothing granted".
            if (!r || !Array.isArray(r.granted)) throw new Error('malformed writeAccess reply');
            kindsSupported = Array.isArray(r.supported) ? r.supported : DEFAULT_SUPPORTED;
            // How far back the shell can read other apps' records (ms, 0 =
            // all; med-8f4s.13/.14). null = an older shell: no Copy at all.
            const readableFrom = Number.isFinite(r.readableFrom) && r.readableFrom >= 0 ? r.readableFrom : null;
            readable = readableFrom;
            onAccess(r.granted, kindsSupported, readableFrom);
            return r.granted;
        }).catch((e) => {
            diag(`[health] write access failed ${errClass(e)}`);
            return null;
        }));

    // A write kind this shell supports but the write sheet never asked for
    // (a shell updated after the switch went on): ask once, then re-read.
    // Mirrors the read side's ASKED_KEY rule.
    let asking = null;
    const askNewKinds = () => {
        const asked = readJSON(storage, WRITE_ASKED_KEY, DEFAULT_SUPPORTED);
        const fresh = kindsSupported.filter((k) => WRITE_KINDS.includes(k) && !(Array.isArray(asked) && asked.includes(k)));
        if (!fresh.length) return null;
        if (!asking) {
            asking = Promise.resolve()
                .then(() => {
                    // Recorded first: asked once, even when the sheet rejects.
                    writeJSON(storage, WRITE_ASKED_KEY, [...(Array.isArray(asked) ? asked : []), ...fresh]);
                    return health.requestAuthorization(HEALTH_KINDS, { write: fresh });
                })
                .then(() => readAccess(), (e) => {
                    diag(`[health] write authorization failed ${errClass(e)}`);
                    return null;
                })
                .finally(() => { asking = null; });
        }
        return asking;
    };

    const step = async (kind, id) => {
        const from = ledger()[kind]?.[id];
        if (from === undefined || !isHealthWriteEnabled(storage)) return;
        await settled();
        const granted = await (access || readAccess());
        if (!granted || !granted.includes(kind)) return; // kept for the next pass
        try {
            const row = (await records.listRaw(RECORD_TYPE[kind])).find((r) => r.recordId === id);
            const span = kind === 'workout' && row && !row.deleted ? await workoutSpan(records, row) : null;
            const activity = span ? await workoutActivity(records, row) : null;
            // Switched off, or a newer access read dropped the kind, while we
            // waited: keep the entry, send nothing.
            const latest = await access;
            if (!isHealthWriteEnabled(storage) || !latest || !latest.includes(kind)) return;
            let wrote = false;
            if (kind === 'workout') {
                // Not (or no longer) a finished span: remove, a no-op for an id never written.
                if (span) wrote = await health.write({ type: kind, id, version: row.clientTs, ...span, activity }) !== false;
                else await health.remove({ type: kind, id });
            } else if (row && !row.deleted) {
                // A bp row without a pulse (an edit cleared it) owes Health no
                // heart-rate entry: remove, a no-op for an id never written.
                if (row.source) { /* came from Health: never written */ }
                else if (kind === 'hr' && pulseOf(row) === null) await health.remove({ type: kind, id: healthId(kind, id) });
                else wrote = await health.write(healthBody(kind, row)) !== false;
            } else {
                await health.remove({ type: kind, id: healthId(kind, id) });
            }
            if (ENTRY_KINDS.includes(kind)) {
                const c = readJSON(storage, COPIED_KEY, {});
                if (wrote) (c[kind] = c[kind] || {})[id] = row.clientTs;
                else if (c[kind]) delete c[kind][id];
                // Not saved: the id stays queued (catch below) and is resent.
                if (!writeJSON(storage, COPIED_KEY, c)) throw new Error('copied write failed');
            }
        } catch (e) {
            // Revoked since the last read: hold the kind back until the next one.
            if (/denied/.test(e && e.message)) access = access.then((g) => g && g.filter((k) => k !== kind));
            // Kept, moved to the back: a refused id cannot hold up the rest.
            // A Copy id the store always rejects is dropped instead (its job counts it).
            const now = ledger();
            const v = now[kind]?.[id];
            if (v !== undefined) {
                delete now[kind][id];
                if (v === from && PERMANENT_RE.test(String(e && e.message)) && onPermanent(kind, id)) dropped = true;
                else now[kind][id] = v;
                writeJSON(storage, DIRTY_KEY, now);
            }
            throw e;
        }
        const now = ledger();
        if (now[kind]?.[id] === from) {
            delete now[kind][id];
            writeJSON(storage, DIRTY_KEY, now);
        }
    };
    // Set when a call since the last drain started hit the store's rate limit
    // (Health Connect "API call quota exceeded"): the copy then pauses even if
    // a few calls of the pass got through.
    let quotaHit = false;
    // Set when a Copy id was dropped as permanent since the last drain
    // started: that pass resolved something, so it is no step toward stuck.
    let dropped = false;
    const deliver = (kind, id) => {
        const next = (chains.get(id) || Promise.resolve())
            .then(() => step(kind, id))
            .then(() => true, (e) => {
                if (QUOTA_RE.test(String(e && e.message))) quotaHit = true;
                diag(`[health] write ${kind} failed ${errClass(e)}`);
                return false;
            });
        chains.set(id, next);
        next.then(() => { if (chains.get(id) === next) chains.delete(id); });
        return next;
    };

    // Synchronous, inside the records lock: no awaits, no Health calls here.
    hook((recordType, row) => {
        if (!writeBackEligible(recordType, row, storage)) return;
        // A bp row marks its pulse too, always: the hook does not see the
        // previous row, so an edit that cleared the pulse must still remove it.
        const kinds = MARKS[recordType];
        const l = ledger();
        for (const k of kinds) l[k] = { ...l[k], [row.recordId]: row.clientTs };
        if (!writeJSON(storage, DIRTY_KEY, l)) {
            diag('[health] ledger write failed');
            return;
        }
        // One chain per recordId: bp, then hr.
        queueMicrotask(() => kinds.forEach((k) => deliver(k, row.recordId)));
    });

    const drain = async () => {
        if (!isHealthWriteEnabled(storage)) return null;
        let granted = await readAccess();
        if (!granted) return null;
        const asked = askNewKinds();
        if (asked) granted = (await asked) || granted;
        quotaHit = false;
        dropped = false;
        const l = ledger();
        // Interleave the kinds so one refused kind cannot starve the other.
        const lists = WRITE_KINDS.filter((k) => granted.includes(k))
            .map((k) => Object.keys(l[k] || {}).map((id) => [k, id]));
        const picked = [];
        for (let i = 0; picked.length < WRITE_BATCH && lists.some((x) => i < x.length); i++) {
            for (const x of lists) if (i < x.length && picked.length < WRITE_BATCH) picked.push(x[i]);
        }
        // The ids delivered: 0 = the pass made no progress.
        if (readable !== null && picked.length > 1) return sendBatch(picked);
        return (await Promise.all(picked.map(([k, id]) => deliver(k, id)))).filter(Boolean).length;
    };

    // One pass on a shell with readableFrom (bd med-8f4s.15): the writes of
    // `picked` go as ONE health.write({ entries }), each body exactly step()'s
    // single write; removes, rows from Health and single writes go per id
    // through deliver(). Reply: one result per entry, in order: true, "denied"
    // (Android: that kind's grant is gone: kept, kind held back) or another
    // error string (permanent: a Copy id is dropped, else kept and moved back);
    // a missing result is not delivered. A thrown call keeps every id. The
    // ledger and wg.health.copied are written once for the pass.
    const sendBatch = async (picked) => {
        // Live edits of these ids queue behind this pass, and it waits for theirs.
        const ids = [...new Set(picked.map(([, id]) => id))];
        const prior = ids.map((id) => chains.get(id)).filter(Boolean);
        let open;
        const gate = new Promise((r) => { open = r; });
        for (const id of ids) chains.set(id, gate);
        const rest = [];
        let delivered = 0;
        try {
            await Promise.all(prior);
            const byType = new Map();
            const rowsOf = (t) => {
                if (!byType.has(t)) byType.set(t, records.listRaw(t).then((rows) => new Map(rows.map((r) => [r.recordId, r]))));
                return byType.get(t);
            };
            let writes = [];
            // A failed commit wait or row read goes per id through deliver(),
            // whose step() keeps and moves back the id that fails again.
            const ready = await settled().then(() => true, () => false);
            for (const [kind, id] of picked) {
                const from = ledger()[kind]?.[id];
                if (from === undefined) continue;
                let body = null;
                let row;
                try {
                    if (!ready) throw new Error('not settled');
                    row = (await rowsOf(RECORD_TYPE[kind])).get(id);
                    if (row && !row.deleted && kind === 'workout') {
                        const span = await workoutSpan(records, row);
                        if (span) body = { type: kind, id, version: row.clientTs, ...span, activity: await workoutActivity(records, row) };
                    } else if (row && !row.deleted && !row.source && !(kind === 'hr' && pulseOf(row) === null)) {
                        body = healthBody(kind, row);
                    }
                } catch {
                    body = null;
                }
                if (body) writes.push({ kind, id, from, version: row.clientTs, body });
                else rest.push([kind, id]);
            }
            if (writes.length < 2) {
                rest.push(...writes.map((w) => [w.kind, w.id]));
                writes = [];
            }
            // Switched off, or a newer access read dropped a kind, while we
            // read: those entries are kept, not sent.
            const latest = await access;
            const send = writes.filter((w) => isHealthWriteEnabled(storage) && latest && latest.includes(w.kind));
            if (send.length) delivered = await writeEntries(send);
        } finally {
            open();
            for (const id of ids) if (chains.get(id) === gate) chains.delete(id);
        }
        return delivered + (await Promise.all(rest.map(([k, id]) => deliver(k, id)))).filter(Boolean).length;
    };
    // The batched call itself → the number of true results.
    const writeEntries = async (send) => {
        let reply;
        try {
            reply = await health.write({ entries: send.map((w) => w.body) });
        } catch (e) {
            const msg = String(e && e.message);
            if (QUOTA_RE.test(msg)) quotaHit = true;
            // HealthKit refuses the whole call on a revoked kind: read again.
            if (/denied/.test(msg)) readAccess();
            diag(`[health] write batch of ${send.length} failed ${failClass(msg)}`);
            return 0;
        }
        const results = Array.isArray(reply) ? reply : [];
        if (results.length !== send.length) diag(`[health] write batch reply ${results.length} of ${send.length}`);
        const l = ledger();
        const c = readJSON(storage, COPIED_KEY, {});
        let copied = false;
        const cleared = []; // entry ids this pass takes off the ledger
        let delivered = 0;
        const denied = new Set();
        const back = [];
        send.forEach((w, i) => {
            const r = results[i];
            if (r === true) {
                delivered++;
                const mine = l[w.kind]?.[w.id] === w.from;
                if (mine) delete l[w.kind][w.id];
                if (ENTRY_KINDS.includes(w.kind)) {
                    (c[w.kind] = c[w.kind] || {})[w.id] = w.version;
                    copied = true;
                    if (mine) cleared.push(w);
                }
                return;
            }
            diag(`[health] write ${w.kind} failed ${typeof r === 'string' ? failClass(r) : 'no result'}`);
            if (typeof r === 'string' && /denied/.test(r)) denied.add(w.kind);
            else if (typeof r === 'string' && l[w.kind]?.[w.id] === w.from && onPermanent(w.kind, w.id)) {
                delete l[w.kind][w.id];
                dropped = true;
                return;
            }
            back.push(w);
        });
        // Kept, moved to the back, in reply order.
        for (const w of back) {
            const v = l[w.kind]?.[w.id];
            if (v === undefined) continue;
            delete l[w.kind][w.id];
            l[w.kind][w.id] = v;
        }
        // wg.health.copied first, as step() does: a page that dies between the
        // two writes resends (Health upserts by our id) instead of losing the
        // markers. A failed copied write keeps the entries queued, no progress.
        if (copied && !writeJSON(storage, COPIED_KEY, c)) {
            diag('[health] copied write failed');
            for (const w of cleared) l[w.kind][w.id] = w.from;
            delivered -= cleared.length;
        }
        writeJSON(storage, DIRTY_KEY, l);
        if (denied.size) access = access.then((g) => g && g.filter((k) => !denied.has(k)));
        return delivered;
    };
    // Copy past entries: rows [{ recordType, recordId, clientTs }] marked
    // exactly as the hook marks them, in one ledger write; an id already
    // marked keeps its entry (step reads the row as it is at delivery anyway).
    // A bp row without a pulse (pulse: false) marks no hr: nothing to remove
    // in a Copy (the hook still marks it always).
    const mark = (rows) => {
        const l = ledger();
        for (const r of rows) {
            for (const k of MARKS[r.recordType]) {
                if (k === 'hr' && r.pulse === false) continue;
                l[k] = l[k] || {};
                if (l[k][r.recordId] === undefined) l[k][r.recordId] = r.clientTs;
            }
        }
        return writeJSON(storage, DIRTY_KEY, l);
    };
    // The switch-on sheet asked every write kind: markAsked(WRITE_KINDS)
    // before it opens (a pass racing the turn-on, e.g. the Health Connect
    // activity's resume, must not show a second sheet), then markAsked()
    // narrows it to the kinds the shell then supported (an older shell
    // ignores a kind it does not know, so the build that knows it asks again).
    const markAsked = (kinds = kindsSupported) => writeJSON(storage, WRITE_ASKED_KEY, kinds.filter((k) => WRITE_KINDS.includes(k)));
    return { drain, readAccess, supported, markAsked, mark, ledger, quotaHit: () => quotaHit, dropped: () => dropped };
}

// What other apps already put into Health for one kind, since `from`: the
// import's own query with no anchor, paged with an anchor that lives only in
// this read: wg.health.anchors, the import's cursor, never moves. The shells
// leave out what this app wrote. null = read denied (Android answers no
// samples and no anchor; HealthKit cannot tell, it answers empty).
async function otherAppSamples(health, type, from) {
    const out = [];
    let anchor = null;
    for (let page = 0; page < COPY_MAX_PAGES; page++) {
        const res = await health.query(anchor ? { type, from, limit: PAGE, anchor } : { type, from, limit: PAGE });
        if (!res || typeof res.anchor !== 'string') return page === 0 ? null : out;
        if (Array.isArray(res.samples)) out.push(...res.samples.filter(Boolean));
        if (!res.more) return out;
        anchor = res.anchor;
    }
    throw new Error(`${type} read did not finish in ${COPY_MAX_PAGES} pages`);
}

// The rows of `samples` held by a Health record: same key, within tol ms,
// one-to-one, nearest in time first (two genuine readings minutes apart with
// the same numbers never fold into one Health record). Sorted lists + a binary
// search per row: no scan over years of readings per row.
function heldRows(rows, samples, tol) {
    const byKey = new Map();
    for (const s of samples) {
        if (!Number.isFinite(s.at)) continue;
        if (!byKey.has(s.key)) byKey.set(s.key, []);
        byKey.get(s.key).push(s.at);
    }
    for (const l of byKey.values()) l.sort((a, b) => a - b);
    const pairs = [];
    for (const r of rows) {
        const l = byKey.get(r.key);
        if (!l || !Number.isFinite(r.at)) continue;
        let lo = 0;
        let hi = l.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (l[mid] < r.at - tol) lo = mid + 1;
            else hi = mid;
        }
        for (let j = lo; j < l.length && l[j] <= r.at + tol; j++) pairs.push([Math.abs(l[j] - r.at), r.recordId, `${r.key}#${j}`]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const held = new Set();
    const used = new Set();
    for (const [, id, s] of pairs) {
        if (held.has(id) || used.has(s)) continue;
        held.add(id);
        used.add(s);
    }
    return held;
}

// The past entries of one kind the hook would have marked: live, made in the
// app (no `source`; rows synced from another device are the user's own), a
// workout only as a finished span. Each with its match key / span.
async function copyRows(records, kind) {
    const live = (await records.listRaw(RECORD_TYPE[kind])).filter((r) => !r.deleted);
    const base = (r) => ({ recordType: RECORD_TYPE[kind], recordId: r.recordId, clientTs: r.clientTs, at: Date.parse(r.measured_at) });
    if (kind === 'bp') return live.filter((r) => !r.source).map((r) => ({ ...base(r), pulse: pulseOf(r) !== null, key: `${Math.round(r.systolic)}/${Math.round(r.diastolic)}` }));
    if (kind === 'weight') return live.filter((r) => !r.source).map((r) => ({ ...base(r), key: Math.round(Number(r.weight) * 10) }));
    const out = [];
    // ponytail: a few awaits per session; workouts are hundreds, not the thousands bp is.
    for (const r of live) {
        const span = await workoutSpan(records, r);
        if (span) out.push({ recordType: RECORD_TYPE[kind], recordId: r.recordId, clientTs: r.clientTs, span, activity: await workoutActivity(records, r) });
    }
    return out;
}

// planCopy → { rows: { kind: [row] } (to mark), blocked: { kind: [recordId] }, total, cut }.
// only (optional) { kind: [recordId] }: plan just those ids of each kind.
// Leaves out what this device already wrote (wg.health.copied) or still owes
// (the ledger), and, cut = how many, rows older than readableFrom: the shell
// cannot read that far back, so it could not tell whether Health holds them.
// Throws when a read fails (store busy): no count, nothing marked.
async function planCopy(health, records, kinds, { only = null, storage = null, readableFrom = 0 } = {}) {
    const rows = {};
    const blocked = {};
    let total = 0;
    let cut = 0;
    const copied = storage ? readJSON(storage, COPIED_KEY, {}) : {};
    const dirty = storage ? readJSON(storage, DIRTY_KEY, {}) : {};
    for (const kind of kinds) {
        let mine = (await copyRows(records, kind))
            .filter((r) => copied[kind]?.[r.recordId] === undefined && dirty[kind]?.[r.recordId] === undefined);
        if (only) {
            const keep = new Set(only[kind] || []);
            mine = mine.filter((r) => keep.has(r.recordId));
        }
        // Where a row's dedupe read starts (bd med-8f4s.19): the row is
        // eligible only when that whole lookback is readable, so the shell is
        // never asked for a slice it does not serve (the boundary is raw).
        const lookbackStart = (r) => (r.span ? r.span.start - DAY_MS : r.at - MATCH_MS[kind]);
        if (readableFrom > 0) {
            const n = mine.length;
            mine = mine.filter((r) => lookbackStart(r) >= readableFrom);
            cut += n - mine.length;
        }
        if (!mine.length) continue;
        const starts = mine.map(lookbackStart).filter(Number.isFinite);
        const theirs = await otherAppSamples(health, kind, starts.length ? Math.min(...starts) : 0);
        if (!theirs) {
            blocked[kind] = mine.map((r) => r.recordId);
            total += mine.length;
            continue;
        }
        let held;
        if (kind === 'workout') {
            // The importer's overlap rule in reverse: a Health strength workout
            // overlapping a session is never imported, so a strength session
            // it overlaps is never sent; a session typed Other yields to any.
            const spans = theirs.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end));
            const strength = spans.filter((s) => STRENGTH_TYPES.has(s.activity));
            held = new Set(mine.filter((r) => overlaps(r.span, r.activity === ACTIVITY_STRENGTH ? strength : spans)).map((r) => r.recordId));
        } else {
            const valid = kind === 'bp'
                ? (s) => Number.isFinite(s.systolic) && Number.isFinite(s.diastolic)
                : (s) => Number.isFinite(s.kg);
            const key = kind === 'bp'
                ? (s) => `${Math.round(s.systolic)}/${Math.round(s.diastolic)}`
                : (s) => Math.round(s.kg * 10);
            held = heldRows(mine, theirs.filter(valid).map((s) => ({ at: s.start, key: key(s) })), MATCH_MS[kind]);
        }
        rows[kind] = mine.filter((r) => !held.has(r.recordId));
        total += rows[kind].length;
    }
    return { rows, blocked, total, cut };
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
            const heal = kind === 'sleep' && anchors.sleepHeal !== 1 && Boolean(anchors.sleep);
            let healed = false;
            if (Number.isFinite(since) || heal) {
                const from = Math.min(Number.isFinite(since) ? since : Infinity, heal ? now() - SLEEP_HEAL_MS : Infinity);
                const res = await health.query({ type: 'sleep', from: from - SLEEP_PAD_MS, to: now() });
                await take(res);
                // Empty is also what a denied read answers: keep both retries.
                healed = Boolean(res && Array.isArray(res.samples) && res.samples.length);
                if (!healed && Number.isFinite(since) && since > now() - SLEEP_PENDING_CAP_MS) {
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
                // Marked once the heal read returned samples (a failure or a
                // denied, empty read retries it), or once a first read without
                // a sleep anchor, which covered the history itself, set one.
                // ponytail: a device with no sleep in 30 days re-asks each run, one empty query.
                if (anchors.sleep && anchors.sleepHeal !== 1 && (healed || !heal)) {
                    anchors.sleepHeal = 1;
                    writeJSON(storage, ANCHORS_KEY, anchors);
                }
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

function accessHint(health) {
    return (health && health.accessHint) || 'Settings → Health → Data Access & Devices';
}

// HW3: refused at turn-on; the switch goes back off.
function writeRefusedText(health) {
    return `Writing isn't allowed yet. Allow it in ${accessHint(health)}, then turn this on.`;
}

// The write row's line while on (kit HW4/HW5): '' when every kind is granted.
// Only a kind the shell supports can be missing: an older shell cannot write
// hr, and there is nothing the user could allow.
function writeHintText(health, granted, supported = DEFAULT_SUPPORTED) {
    const kinds = WRITE_KINDS.filter((k) => supported.includes(k));
    const missing = kinds.filter((k) => !granted.includes(k));
    if (!missing.length) return '';
    if (missing.length === kinds.length) return `Writing paused: access was removed. Allow it in ${accessHint(health)}.`;
    const have = kindNames(kinds.filter((k) => granted.includes(k)));
    return `Writing ${have} only. ${notAllowed(missing)} in ${accessHint(health)}.`;
}

// "a", "a and b", "a, b and c".
function kindNames(ks) {
    return ks.map((k) => KIND_NAMES[k]).join(', ').replace(/, ([^,]*)$/, ' and $1');
}

// "Weight isn't allowed: allow it", "Workouts aren't allowed: allow them".
function notAllowed(ks) {
    const names = kindNames(ks);
    const plural = ks.length > 1 || ks[0] === 'workout';
    return `${names[0].toUpperCase()}${names.slice(1)} ${plural ? "aren't allowed: allow them" : "isn't allowed: allow it"}`;
}

const entriesText = (n) => `${n} ${n === 1 ? 'entry' : 'entries'}`;

// The copy dialog's line for rows older than what the shell can read (Miles
// 16121); the date as dd.mm, with the year when it is not this year's.
function cutText(n, from, label) {
    const d = new Date(from);
    const pad = (x) => String(x).padStart(2, '0');
    const date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}${d.getFullYear() === new Date().getFullYear() ? '' : `.${d.getFullYear()}`}`;
    return `${entriesText(n)} before ${date} won't be copied: ${label} needs access to past data to check ${n === 1 ? 'it' : 'them'}.`;
}

// The copy row's line (kit HW8/HW8b/HW9/HW9b) for copyState() `st`.
function copyText(health, st, paused) {
    const label = healthLabel(health);
    if (st.running && !paused) return { title: 'Copying past entries…', desc: `${st.done} of ${st.total}`, meter: true };
    if (st.running) return { title: 'Copy paused', desc: `${label} is busy. ${st.done} of ${st.total} so far; it continues when the app is open.` };
    // Entries the store always rejected (bd med-8f4s.15).
    const failed = st.failed > 0 ? ` ${entriesText(st.failed)} couldn't be copied. ${st.failed === 1 ? "It's" : "They're"} still in the app.` : '';
    if (!st.refused.length) return { title: `Copied to ${label}`, desc: `${entriesText(st.done)}.${failed}` };
    return { title: `Copied to ${label}`, desc: `${entriesText(st.done)}.${failed} ${notAllowed(st.refused)} in ${label} settings, then tap Copy past entries again.` };
}

export function healthStatusText(storage = globalThis.localStorage, health = globalThis.Health) {
    if (!isHealthImportEnabled(storage)) return 'Import blood pressure, weight, sleep, workouts, steps, heart rate and SpO2';
    const last = readJSON(storage, LAST_KEY, {});
    if (!last.checkedAt) return 'Importing…';
    const hint = accessHint(health);
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
    records = recordsPort(ctx, ORIGIN_EXTERNAL),
    toast = (msg, type) => globalThis.safeToast && globalThis.safeToast(msg, type),
    ask = (msg, opts) => globalThis.safeConfirm(msg, null, opts),
    tell = (msg, opts) => globalThis.safeAlert(msg, opts),
    copyGapMs = COPY_GAP_MS,
    copyBackoffMs = COPY_BACKOFF_MS,
} = {}) {
    if (!health || !health.isSupported()) return null;
    const label = healthLabel(health);
    // "Also write my entries" (kit HW0-HW5): shown only while the import is on
    // and the shell answers health.write; its line only for HW3/HW4/HW5.
    let canWrite = false;
    let writeHint = '';
    let writeRow = null;
    // Bumped by import off: a write opt-in still waiting on its sheet is void.
    let writeEpoch = 0;
    const renderWrite = () => {
        if (!writeRow) return;
        if (canWrite && isHealthImportEnabled(storage)) group.appendChild(writeRow.row);
        else writeRow.row.remove();
        writeRow.input.checked = isHealthWriteEnabled(storage);
        writeRow.desc.textContent = writeHint;
        if (writeHint) writeRow.body.appendChild(writeRow.desc);
        else writeRow.desc.remove();
        renderCopy();
    };
    // The last writeAccess answer, for the copy row's refused kinds.
    let lastGranted = null;
    let lastSupported = DEFAULT_SUPPORTED;
    // readableFrom of the last answer; null (an older shell, or not read yet):
    // no Copy row and no offer (Archie 16124, R6).
    let lastReadable = null;
    // Each writeAccess answer sets the line: a kind missing is named (HW4),
    // nothing granted reads as paused (HW5). A pass never turns the switch
    // off: it resumes by itself once access returns (Miles 15063, Iris 15065).
    const onAccess = (granted, supported, readableFrom) => {
        lastGranted = granted;
        lastSupported = supported;
        lastReadable = readableFrom;
        if (!isHealthWriteEnabled(storage)) return;
        writeHint = writeHintText(health, granted, supported);
        renderWrite();
    };
    // A Copy id the store always rejects (bd med-8f4s.15): moved from job.ids
    // to job.dropped, which the result counts (a pulse is not an entry:
    // dropped, not counted; its bp, kept or dropped, keeps it the Copy's);
    // an id outside the job keeps the live rule (kept, retried).
    const onPermanent = (kind, id) => {
        const job = readJob();
        if (!job) return false;
        const entry = kind === 'hr' ? 'bp' : kind;
        const ids = Array.isArray(job.ids[entry]) ? job.ids[entry] : [];
        const dropped = (job.dropped && job.dropped[entry]) || [];
        // Already dropped (the page died before the ledger write): drop again, count once.
        if (kind === 'hr' || dropped.includes(id)) return ids.includes(id) || dropped.includes(id);
        if (!ids.includes(id)) return false;
        job.ids[entry] = ids.filter((x) => x !== id);
        job.dropped = { ...job.dropped, [entry]: [...dropped, id] };
        // Not saved: the caller keeps the id queued, and the next rejection drops it.
        return writeJSON(storage, JOB_KEY, job);
    };
    const writeBack = startHealthWriteBack({ health, storage, records, onAccess, onPermanent });
    // Copy rows marked into the ledger and the job that owns them, crash-atomic
    // (bd med-8f4s.20): the job is saved first with the rows as `marking` (the
    // intent), then the ledger mark (idempotent), then the job without it. A
    // death or failed write after the first save leaves `marking`, which
    // reconcileMarking() finishes before every pass and at load; a failed first
    // save changed nothing. True once the job is stored: the copy has started.
    const markWithJob = (rows, job) => {
        if (!rows.length) return writeJSON(storage, JOB_KEY, job);
        if (!writeJSON(storage, JOB_KEY, { ...job, marking: rows })) return false;
        if (writeBack.mark(rows)) writeJSON(storage, JOB_KEY, job);
        return true;
    };
    // The only reader of job.marking: mark its rows, then clear it. A row
    // already delivered (a copied marker: the clear failed after an earlier
    // mark and drain) is not marked again, so a failing job write never
    // resends it (Argus 22238 #3); nor is a row already dropped.
    const reconcileMarking = () => {
        const j = readJob();
        if (!j || !Array.isArray(j.marking)) return;
        const c = readJSON(storage, COPIED_KEY, {});
        // A row dropped as permanently rejected is resolved too (Argus 22243 #1).
        const done = (r) => {
            const k = MARKS[r.recordType][0];
            return c[k]?.[r.recordId] !== undefined || (Array.isArray(j.dropped?.[k]) && j.dropped[k].includes(r.recordId));
        };
        const rows = j.marking.filter((r) => r && MARKS[r.recordType] && !done(r));
        if (rows.length && !writeBack.mark(rows)) return;
        delete j.marking;
        writeJSON(storage, JOB_KEY, j);
    };

    // Copy past entries (bd med-8f4s.11, kit HW6-HW9b): mark every past entry
    // Health does not already hold into the write-back ledger, then let the
    // drain deliver it, WRITE_BATCH per pass. Device-local, nothing touches the
    // vault; the ledger and the job persist, so a relaunch resumes.
    const readJob = () => {
        const j = readJSON(storage, JOB_KEY, null);
        return j && typeof j === 'object' && j.ids && typeof j.ids === 'object' ? j : null;
    };
    // Entries done = ledger ids cleared; left per kind (blocked reads count as
    // left); refused = left in a kind Health won't let us read or write.
    const copyState = () => {
        const job = readJob();
        if (!job) return null;
        const l = writeBack.ledger();
        const blocked = job.blocked || {};
        let done = 0;
        const left = {};
        // Ids still being marked (job.marking) are left, never done.
        const marking = new Set(Array.isArray(job.marking) ? job.marking.map((r) => r && r.recordId) : []);
        for (const [kind, ids] of Object.entries(job.ids)) {
            for (const id of Array.isArray(ids) ? ids : []) {
                if (marking.has(id) || (l[kind] && l[kind][id] !== undefined)) left[kind] = (left[kind] || 0) + 1;
                else done++;
            }
        }
        for (const [kind, ids] of Object.entries(blocked)) left[kind] = (left[kind] || 0) + (Array.isArray(ids) ? ids.length : 0);
        // A dropped id still in the ledger (the page died mid-drop): the job
        // stays open until a pass drops it again.
        for (const [kind, ids] of Object.entries(job.dropped || {})) {
            for (const id of Array.isArray(ids) ? ids : []) if (l[kind] && l[kind][id] !== undefined) left[kind] = (left[kind] || 0) + 1;
        }
        const refused = ENTRY_KINDS.filter((k) => left[k] && (blocked[k] || (lastGranted && !lastGranted.includes(k))));
        const running = Object.keys(left).some((k) => !refused.includes(k));
        // A pulse is not an entry, but its copy is part of this job: while one
        // the store may take is still dirty, the passes go on (the row already
        // shows the result).
        const hrOk = !lastGranted || lastGranted.includes('hr');
        const bpIds = [...(Array.isArray(job.ids.bp) ? job.ids.bp : []), ...((job.dropped && job.dropped.bp) || [])];
        const pulses = hrOk && bpIds.some((id) => l.hr && l.hr[id] !== undefined);
        const failed = Object.values(job.dropped || {}).reduce((n, ids) => n + (Array.isArray(ids) ? ids.length : 0), 0);
        return { job, done, total: Number(job.total) || 0, left, refused, running, pending: running || pulses, failed };
    };
    let copyRow = null;
    let paused = false;
    let opening = false;
    const renderCopy = () => {
        if (copyRow) copyRow.remove();
        copyRow = null;
        if (!writeRow || !canWrite || !isHealthWriteEnabled(storage)) return;
        // No readableFrom, no Copy, a saved job included: its marked ids drain
        // as ledger entries, its blocked ids wait (retryBlocked).
        if (lastReadable === null) return;
        const st = copyState();
        const row = doc.createElement(st ? 'div' : 'button');
        row.id = COPY_ROW_ID;
        row.className = 'wg-setting';
        // HW7 ready, HW8 running, HW8b paused, HW9 done, HW9b refused (the visual scenes key on it).
        row.dataset.state = !st ? 'ready' : st.running ? (paused ? 'paused' : 'running') : (st.refused.length ? 'refused' : 'done');
        const lead = doc.createElement('span');
        lead.className = 'wg-row__lead';
        const ico = doc.createElement('i');
        ico.className = 'wg-ico';
        ico.dataset.icon = 'history';
        lead.appendChild(ico);
        const body = doc.createElement('span');
        body.className = 'wg-setting__body';
        const title = doc.createElement('span');
        title.className = 'wg-setting__title';
        body.appendChild(title);
        row.append(lead, body);
        if (!st) {
            // HW7: title only, a tap opens the HW6 dialog with fresh counts.
            row.type = 'button';
            title.textContent = 'Copy past entries';
            const chev = doc.createElement('i');
            chev.className = 'wg-ico wg-row__chev';
            chev.dataset.icon = 'chev-r';
            row.appendChild(chev);
            row.addEventListener('click', () => openCopy(false));
        } else {
            const t = copyText(health, st, paused);
            title.textContent = t.title;
            const desc = doc.createElement('span');
            desc.className = 'wg-setting__desc';
            desc.textContent = t.desc;
            body.appendChild(desc);
            if (t.meter) {
                const meter = doc.createElement('progress');
                meter.className = 'wg-meter';
                meter.max = Math.max(1, st.total);
                meter.value = st.done;
                meter.setAttribute('aria-label', `${st.done} of ${st.total}`);
                body.appendChild(meter);
            }
        }
        if (globalThis.WGIcons && typeof globalThis.WGIcons.hydrate === 'function') globalThis.WGIcons.hydrate(row);
        writeRow.row.after(row);
        copyRow = row;
    };
    // A kind whose read was denied when the copy started: read it again; once
    // it reads, its not-held entries join the job.
    // Only the ids confirmed at Copy: a row synced in since is not part of it.
    // Runs after a pass read access, under the shell's current window: none
    // without readableFrom, and an id now older than it is dropped, not sent.
    const retryBlocked = async () => {
        const confirmed = readJob()?.blocked || {};
        const kinds = Object.keys(confirmed);
        if (!kinds.length || lastReadable === null) return;
        let plan;
        try {
            plan = await planCopy(health, records, kinds, { only: confirmed, storage, readableFrom: lastReadable });
        } catch {
            return; // store busy: next pass
        }
        const job = readJob();
        // A pending marking (its ledger write failed) is finished first: a new
        // admission would replace it (Argus 22238 #1).
        if (!job || job.marking) return 0;
        const rows = [];
        for (const k of kinds) {
            if (plan.blocked[k] !== undefined || !Array.isArray(job.blocked[k])) continue;
            const got = plan.rows[k] || [];
            rows.push(...got);
            job.ids[k] = got.map((r) => r.recordId);
            job.total = job.total - job.blocked[k].length + got.length;
            delete job.blocked[k];
        }
        // Not saved: the kinds stay blocked and are retried; no progress.
        return markWithJob(rows, job) ? rows.length : 0;
    };
    let copying = null;
    let copyTimer = null;
    // Passes in a row where every call failed, kept with the job so a relaunch
    // neither restarts the back-off nor the count to giving up.
    const fails = (job = readJob()) => (job && Number(job.fails)) || 0;
    const setFails = (n) => {
        const job = readJob();
        if (!job || fails(job) === n) return;
        job.fails = n;
        writeJSON(storage, JOB_KEY, job);
    };
    const later = (ms) => {
        clearTimeout(copyTimer);
        copyTimer = setTimeout(() => {
            copyTimer = null;
            if (doc.visibilityState !== 'hidden') drainWrites();
        }, ms);
    };
    // One write pass; with a copy open, the next starts copyGapMs after one
    // that delivered, or backs off 1→2→4… min (cap 15) after one where every
    // call failed (store busy): HW8b. A pass that hit the rate limit waits the
    // first step (1 min, HW8b) even when some calls got through. A foreground
    // return runs a pass at once.
    // A pass asked for while one runs (the copy just started) runs after it.
    let again = false;
    const copyPass = () => {
        if (copying) {
            again = true;
            return copying;
        }
        copying = (async () => {
            reconcileMarking();
            if (!readJob()) return writeBack.drain();
            const delivered = await writeBack.drain();
            // After the drain: its access read set lastReadable. Ids admitted
            // now go out on the next pass, after the short gap.
            const admitted = await retryBlocked();
            const st = copyState();
            if (st && st.pending && isHealthWriteEnabled(storage)) {
                if (writeBack.quotaHit()) {
                    // A call hit the rate limit: wait the first back-off step
                    // (HW8b) so the quota refills and live entries get through.
                    // Never a step toward stuck: the store will take it later.
                    paused = true;
                    if (delivered > 0) setFails(0);
                    later(copyBackoffMs);
                } else if (delivered > 0 || admitted > 0 || writeBack.dropped()) {
                    paused = false;
                    setFails(0);
                    later(copyGapMs);
                } else {
                    paused = true;
                    const n = fails() + 1;
                    setFails(n);
                    later(Math.min(copyBackoffMs * 2 ** (n - 1), copyBackoffMs * COPY_BACKOFF_CAP));
                }
            } else {
                paused = false;
            }
            renderCopy();
            return delivered;
        })().finally(() => {
            copying = null;
            if (again) {
                again = false;
                drainWrites();
            }
        });
        return copying;
    };
    const drainWrites = () => copyPass().catch((e) => console.error('[health] write pass failed', e));
    // The result stays until Settings is left (HW9), then the row is "Copy
    // past entries" again; a kind whose read is still denied does not keep the
    // job (its ids were never marked, so the next Copy recounts them), a copy
    // still going (pulses included) does unless it is stuck: failed
    // again at the cap (an entry the store never takes; across relaunches, as
    // the count is kept). Then the job goes, Copy is free again, and the
    // entries stay in the ledger.
    const settleCopy = () => {
        const st = copyState();
        if (!st) return;
        const stuck = fails(st.job) >= COPY_STUCK_FAILS;
        if (st.pending && !stuck) return;
        // Rows still only in job.marking are in no ledger: clearing the job
        // would lose them, so it stays until a pass marks them (Argus 22238 #2).
        if (Array.isArray(st.job.marking) && st.job.marking.length) return;
        writeJSON(storage, JOB_KEY, null);
        renderCopy();
    };
    // HW6 (offer: once per device, after a granting switch-on) and HW7 (the
    // Settings tap): count, ask, then mark and drain.
    const openCopy = async (offer) => {
        if (opening || readJob()) return;
        opening = true;
        try {
            let plan;
            let ok = false;
            // "Allow past data" asks once more and opens the dialog again with
            // fresh counts; still denied, it looks the same (Miles 16121).
            for (;;) {
                try {
                    if (!(await writeBack.readAccess())) throw new Error('write access unreadable');
                    if (lastReadable === null) return;
                    plan = await planCopy(health, records, ENTRY_KINDS.filter((k) => lastSupported.includes(k)), { storage, readableFrom: lastReadable });
                } catch (e) {
                    console.error('[health] copy count failed', e);
                    if (!offer) toast(`Couldn't reach ${label} — try again.`, 'error');
                    return;
                }
                if (!plan.total && !plan.cut) {
                    if (!offer) await tell(`Everything is already in ${label}.`, { title: 'Copy past entries' });
                    return;
                }
                if (offer) writeJSON(storage, OFFERED_KEY, true);
                let retry = false;
                const cut = plan.cut ? {
                    caution: cutText(plan.cut, lastReadable, label),
                    link: { label: 'Allow past data', below: true, onClick: () => { retry = true; } },
                } : {};
                if (plan.total) {
                    ok = await ask(`${plan.total} past ${plan.total === 1 ? 'entry' : 'entries'} from this app.`, {
                        title: 'Copy your past entries too?',
                        hint: `Readings that came from ${label} stay as they are, and nothing is copied twice.`,
                        confirmLabel: 'Copy',
                        cancelLabel: 'Not now',
                        ...cut,
                    });
                } else {
                    await tell('', { title: 'Copy past entries', ...cut });
                }
                if (!retry) break;
                try {
                    await health.requestAuthorization(HEALTH_KINDS);
                } catch (e) {
                    console.error('[health] past-data authorization failed', e);
                }
            }
            if (!ok || readJob() || !isHealthWriteEnabled(storage)) return;
            const ids = Object.fromEntries(Object.entries(plan.rows).map(([k, rs]) => [k, rs.map((r) => r.recordId)]));
            const job = { startedAt: Date.now(), total: plan.total, ids, blocked: plan.blocked };
            if (!markWithJob(Object.values(plan.rows).flat(), job)) {
                console.error('[health] copy could not be stored');
                toast("Couldn't start the copy — try again.", 'error');
                return;
            }
            paused = false;
            renderCopy();
            drainWrites();
        } finally {
            opening = false;
        }
    };
    reconcileMarking();
    settleCopy();
    const view = doc.getElementById('settings-view');
    const Observer = doc.defaultView && doc.defaultView.MutationObserver;
    if (view && Observer) {
        new Observer(() => { if (!view.classList.contains('active')) settleCopy(); })
            .observe(view, { attributes: true, attributeFilter: ['class'] });
    }
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

    const group = mountHealthRow(doc, storage, health, async (on) => {
        if (!on) {
            writeJSON(storage, ENABLED_KEY, false);
            writeJSON(storage, WRITE_KEY, false); // import off → write off
            writeEpoch++;
            writeHint = '';
            refresh();
            renderWrite();
            return true;
        }
        let available = false;
        let failed = false;
        try {
            available = await health.requestAuthorization(HEALTH_KINDS);
        } catch (e) {
            failed = true;
            console.error('[health] authorization failed', e);
        }
        if (!available) {
            const desc = doc.getElementById(ROW_ID)?.querySelector('.wg-setting__desc');
            if (desc) desc.textContent = failed
                ? `Couldn't reach ${healthLabel(health)}. Try again.`
                : `${healthLabel(health)} is not available on this device.`;
            return false;
        }
        writeJSON(storage, ENABLED_KEY, true);
        writeJSON(storage, ASKED_KEY, HEALTH_KINDS);
        // Switching on is also the manual rescan: start from the beginning
        // (known readings are skipped by id).
        writeJSON(storage, ANCHORS_KEY, {});
        refresh();
        renderWrite();
        importNow();
        return true;
    });

    if (group) writeRow = buildSettingRow(doc, {
        id: WRITE_ROW_ID, icon: 'upload', title: 'Also write my entries', toggleId: WRITE_TOGGLE_ID,
        aria: `Also write my entries to ${healthLabel(health)}`,
        onToggle: async (on) => {
            if (!on) {
                writeJSON(storage, WRITE_KEY, false);
                writeHint = '';
                renderWrite();
                return true;
            }
            const epoch = writeEpoch;
            // A failed call is not a refusal: toast it, stay off, no HW3 line.
            const failed = () => {
                writeJSON(storage, WRITE_KEY, false);
                writeHint = '';
                renderWrite();
                toast(`Couldn't reach ${healthLabel(health)} — try again.`, 'error');
                return false;
            };
            writeBack.markAsked(WRITE_KINDS);
            try {
                await health.requestAuthorization(HEALTH_KINDS, { write: WRITE_KINDS });
            } catch (e) {
                console.error('[health] write authorization failed', e);
                return epoch === writeEpoch ? failed() : false;
            }
            // Import switched off (and maybe on again) meanwhile: no late opt-in.
            if (epoch !== writeEpoch || !isHealthImportEnabled(storage)) return false;
            writeJSON(storage, WRITE_KEY, true);
            const granted = await writeBack.readAccess();
            if (epoch !== writeEpoch || !isHealthImportEnabled(storage)) return false;
            if (!granted) return failed();
            writeBack.markAsked();
            // Refused at turn-on (HW3): back off with where to allow it.
            if (!WRITE_KINDS.some((k) => granted.includes(k))) {
                writeJSON(storage, WRITE_KEY, false);
                writeHint = writeRefusedText(health);
                renderWrite();
            }
            if (!isHealthWriteEnabled(storage)) return false;
            drainWrites();
            // HW6: the one-time offer (not awaited: the switch settles now).
            if (readJSON(storage, OFFERED_KEY, false) !== true) openCopy(true);
            return true;
        },
    });
    writeBack.supported.then((ok) => { canWrite = ok; renderWrite(); });

    doc.addEventListener('visibilitychange', () => {
        if (doc.visibilityState === 'visible') {
            importNow();
            drainWrites();
        }
    });
    drainWrites();
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

// A kit toggle row: lead icon, title, optional desc, switch. onToggle(on)
// resolves false to flip the switch back.
function buildSettingRow(doc, { id, icon, title: titleText, desc: descText, toggleId, aria, checked = false, onToggle }) {
    const row = doc.createElement('div');
    row.id = id;
    row.className = 'wg-setting';

    const lead = doc.createElement('span');
    lead.className = 'wg-row__lead';
    const ico = doc.createElement('i');
    ico.className = 'wg-ico';
    ico.dataset.icon = icon;
    lead.appendChild(ico);

    const body = doc.createElement('span');
    body.className = 'wg-setting__body';
    const title = doc.createElement('span');
    title.className = 'wg-setting__title';
    title.textContent = titleText;
    const desc = doc.createElement('span');
    desc.className = 'wg-setting__desc';
    body.appendChild(title);
    if (descText !== undefined) {
        desc.textContent = descText;
        body.appendChild(desc);
    }

    const toggle = doc.createElement('label');
    toggle.className = 'wg-toggle';
    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.id = toggleId;
    input.className = 'wg-toggle__input';
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', aria);
    input.checked = checked;
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
    if (globalThis.WGIcons && typeof globalThis.WGIcons.hydrate === 'function') globalThis.WGIcons.hydrate(row);
    return { row, body, desc, input };
}

// The Settings home row: a kit toggle row in its own .wg-list group (the
// write row joins it). Returns the group; null when there is no Settings home
// or it is mounted already.
function mountHealthRow(doc, storage, health, onToggle) {
    const home = doc.querySelector('#settings-view .wg-settings-home');
    if (!home || doc.getElementById(ROW_ID)) return null;
    const group = doc.createElement('div');
    group.className = 'wg-list';
    group.appendChild(buildSettingRow(doc, {
        id: ROW_ID, icon: 'health', title: healthLabel(health), desc: healthStatusText(storage, health),
        toggleId: TOGGLE_ID, aria: `Import from ${healthLabel(health)}`,
        checked: isHealthImportEnabled(storage), onToggle,
    }).row);
    // Kit S6 slot ③ (bd med-ckm5.6).
    (home.querySelector('[data-settings-slot="health"]') || home).appendChild(group);
    return group;
}
