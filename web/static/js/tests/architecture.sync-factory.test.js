/**
 * architecture.sync-factory.test.js
 *
 * Lint guard for the offline-write sync factory in `web/static/js/sync.js`.
 *
 * Every `await window.apiCallDirect(` call in sync.js must live inside one
 * of three allow-listed functions:
 *
 *   1. `defineOfflineEntity` — the factory itself; the BP/weight/intake
 *      pipelines all share its single network call site.
 *   2. `drainSwActionQueue` — drains the separate SW notification-action
 *      queue (`pending_sw_actions`). Per the sync-pipeline-factory plan
 *      Overview ("Out of scope"), this queue has a different shape
 *      (notification-action envelopes, not user-write payloads) and is
 *      intentionally kept out of the factory.
 *   3. `offlineAwareApiCall` — the top-level wrapper that dispatches
 *      online passthrough requests; the call here is the *online* path,
 *      not a syncer.
 *
 * Anything else means a new ad-hoc syncer was added without going through
 * the factory — exactly the regression this guard exists to catch. Add the
 * new pipeline via `defineOfflineEntity({...})` instead, and the call will
 * land inside the factory closure (allowed automatically).
 *
 * See docs/plans/2026-05-13-sync-pipeline-factory.md → Task 4.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SYNC_JS = path.join(REPO_ROOT, 'web/static/js/sync.js');

// Function declarations whose body bounds we care about. Each entry is
// matched by a regex anchored at the start of a line (any indentation).
// The matcher locates the line containing the opening `{`; brace-counting
// from there finds the matching close.
const ALLOWED_FUNCTIONS = [
    {
        name: 'defineOfflineEntity',
        // Top-level: `function defineOfflineEntity(config) {`
        startRe: /^function\s+defineOfflineEntity\s*\(/,
    },
    {
        name: 'drainSwActionQueue',
        // SyncManager method: `    async drainSwActionQueue() {`
        startRe: /^\s*async\s+drainSwActionQueue\s*\(/,
    },
    {
        name: 'offlineAwareApiCall',
        // Top-level: `async function offlineAwareApiCall(...) {`
        startRe: /^async\s+function\s+offlineAwareApiCall\s*\(/,
    },
];

// Locate `{ ... }` body bounds for a function whose declaration starts on
// `startLine` (1-based). Returns { startLine, endLine } where endLine is
// the line containing the matching close brace. Both inclusive.
//
// Walks the source character by character starting at startLine, tracking
// paren depth and string-literal state so that `{}` appearing in
// parameter defaults (e.g. `opts = {}`) does not get mis-read as the
// body's opening brace.
function findBodyBounds(lines, startLine) {
    let i = startLine - 1;
    let k = 0;
    let parenDepth = 0;
    let bodyOpenLine = -1;
    let bodyOpenCol = -1;
    // Phase 1: walk past the parameter list, then locate the body `{`.
    while (i < lines.length) {
        const line = lines[i];
        while (k < line.length) {
            const c = line[k];
            if (c === '"' || c === "'" || c === '`') {
                const end = skipStringLike(line, k, c);
                k = end + 1;
                continue;
            }
            if (c === '/' && line[k + 1] === '/') { k = line.length; break; }
            if (c === '(') parenDepth++;
            else if (c === ')') parenDepth--;
            else if (c === '{' && parenDepth === 0) {
                bodyOpenLine = i + 1;
                bodyOpenCol = k;
                break;
            }
            k++;
        }
        if (bodyOpenLine !== -1) break;
        i++;
        k = 0;
    }
    if (bodyOpenLine === -1) {
        throw new Error(`could not find body opening brace for function starting at line ${startLine}`);
    }

    // Phase 2: brace-count from the body `{` to its matching `}`.
    let depth = 0;
    let j = bodyOpenLine - 1;
    let col = bodyOpenCol;
    while (j < lines.length) {
        const line = lines[j];
        for (let m = (j === bodyOpenLine - 1 ? col : 0); m < line.length; m++) {
            const c = line[m];
            if (c === '"' || c === "'" || c === '`') {
                m = skipStringLike(line, m, c);
                continue;
            }
            if (c === '/' && line[m + 1] === '/') break;
            if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                if (depth === 0) return { startLine: bodyOpenLine, endLine: j + 1 };
            }
        }
        j++;
    }
    throw new Error(`unmatched body brace for function starting at line ${startLine}`);
}

// Returns the index of the closing quote (or end of line for unterminated
// strings — defensive only; sync.js does not have unterminated literals).
function skipStringLike(line, start, quote) {
    let i = start + 1;
    while (i < line.length && line[i] !== quote) {
        if (line[i] === '\\' && i + 1 < line.length) i += 2;
        else i++;
    }
    return i;
}

function locateAllowedRanges(source) {
    const lines = source.split('\n');
    const ranges = [];
    for (const fn of ALLOWED_FUNCTIONS) {
        let found = false;
        for (let i = 0; i < lines.length; i++) {
            if (fn.startRe.test(lines[i])) {
                const bounds = findBodyBounds(lines, i + 1);
                ranges.push({ name: fn.name, ...bounds });
                found = true;
                break;
            }
        }
        if (!found) {
            throw new Error(
                `architecture.sync-factory.test.js: expected to find function "${fn.name}" in sync.js — ` +
                `if it was renamed or removed, update ALLOWED_FUNCTIONS in this test.`
            );
        }
    }
    return ranges;
}

function findApiCallDirectLines(source) {
    const lines = source.split('\n');
    const hits = [];
    // Match `await window.apiCallDirect(` allowing flexible whitespace.
    // Excludes comment-only lines so the doc lines at the top of sync.js
    // (e.g. "// apiCallDirect attaches the HTTP status code as err.status.")
    // don't count as call sites.
    const re = /\bawait\s+window\.apiCallDirect\s*\(/;
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith('//')) continue;
        if (re.test(lines[i])) hits.push({ line: i + 1, text: lines[i] });
    }
    return hits;
}

describe('Architecture – sync-pipeline-factory single-call-site guard', () => {
    it('every `await window.apiCallDirect(` in sync.js lives in defineOfflineEntity / drainSwActionQueue / offlineAwareApiCall', () => {
        const source = fs.readFileSync(SYNC_JS, 'utf8');
        const ranges = locateAllowedRanges(source);
        const hits = findApiCallDirectLines(source);

        // Sanity: there must be at least one apiCallDirect inside the
        // factory and one inside offlineAwareApiCall, otherwise the guard
        // is silently meaningless.
        const inFactory = hits.filter((h) => isInRange(h.line, ranges, 'defineOfflineEntity'));
        const inWrapper = hits.filter((h) => isInRange(h.line, ranges, 'offlineAwareApiCall'));
        expect(
            inFactory.length,
            'expected at least one apiCallDirect inside defineOfflineEntity (the factory closure)'
        ).toBeGreaterThan(0);
        expect(
            inWrapper.length,
            'expected at least one apiCallDirect inside offlineAwareApiCall (the network-passthrough wrapper)'
        ).toBeGreaterThan(0);

        const offenders = [];
        for (const hit of hits) {
            if (!isInAnyAllowedRange(hit.line, ranges)) {
                offenders.push(`  sync.js:${hit.line}  ${hit.text.trim()}`);
            }
        }

        if (offenders.length > 0) {
            const allowedDesc = ranges
                .map((r) => `    - ${r.name} (lines ${r.startLine}-${r.endLine})`)
                .join('\n');
            throw new Error(
                'Found `await window.apiCallDirect(` calls in sync.js outside the allow-listed ' +
                'functions.\n' +
                'New offline-write pipelines must go through `defineOfflineEntity({...})` so the ' +
                'BP/weight/intake-style retry/permanent-error/toast logic is shared. Allowed ' +
                'enclosing functions:\n' +
                allowedDesc +
                '\n\nOffending call sites:\n' +
                offenders.join('\n')
            );
        }
    });

    it('the bounds-finder produces non-empty, non-overlapping ranges for every allow-listed function', () => {
        const source = fs.readFileSync(SYNC_JS, 'utf8');
        const ranges = locateAllowedRanges(source);
        expect(ranges.length).toBe(ALLOWED_FUNCTIONS.length);
        for (const r of ranges) {
            expect(r.endLine, `${r.name} bounds collapsed`).toBeGreaterThan(r.startLine);
        }
        // Detect overlaps — if the brace counter ever desyncs, this catches it.
        for (let i = 0; i < ranges.length; i++) {
            for (let j = i + 1; j < ranges.length; j++) {
                const a = ranges[i];
                const b = ranges[j];
                const overlap = !(a.endLine < b.startLine || b.endLine < a.startLine);
                // drainSwActionQueue lives inside the SyncManager object literal,
                // not inside another allow-listed function — so allow-listed
                // ranges must not nest into each other.
                expect(
                    overlap,
                    `${a.name} (${a.startLine}-${a.endLine}) overlaps with ${b.name} (${b.startLine}-${b.endLine})`
                ).toBe(false);
            }
        }
    });
});

function isInRange(line, ranges, name) {
    const r = ranges.find((x) => x.name === name);
    return !!r && line >= r.startLine && line <= r.endLine;
}

function isInAnyAllowedRange(line, ranges) {
    return ranges.some((r) => line >= r.startLine && line <= r.endLine);
}
