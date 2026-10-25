/**
 * architecture.sleep-readers.test.js (bd med-w6gx.31)
 *
 * A sleep day can hold both an Apple Health day and Mi Band sessions; both
 * rows are stored and the read shows one source (web/domain/healthsource.js
 * visibleSleep). A reader that lists sleep records directly skips that pick
 * and double-counts the night. So a direct sleep-record read
 * (records.list / listRaw / listRange / get on 'sleep' or SLEEP_RECORD_TYPE)
 * may only appear in the owners below, or in an allowlisted file that pipes
 * every such read through visibleSleep.
 *
 * Scans web/domain, web/static/js and web/cloud/js (tests/, vendor/ and
 * *.min.js excluded).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ROOTS = ['web/domain', 'web/static/js', 'web/cloud/js'];

const OWNERS = new Set([
    'web/domain/vitals.js', // readSleepLogs (through visibleSleep) + the .nxk writer's own merge read
    'web/domain/healthimport.js', // the Health importer's exists check over raw rows
]);
const ALLOWLIST = new Map([
    ['web/domain/gamification.js', 'both sleep reads are filtered through visibleSleep before scoring'],
]);

const SLEEP_READ_RE = /\.(?:list|listRaw|listRange|get|getRaw)\(\s*(?:['"`]sleep['"`]|SLEEP_RECORD_TYPE\b)/;

function collectJsFiles(dir, results = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!['tests', 'vendor', 'node_modules'].includes(entry.name)) collectJsFiles(full, results);
        } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.min.js')) {
            results.push(full);
        }
    }
    return results;
}

function codeOf(line) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return '';
    return line.replace(/(^|\s)\/\/.*$/, '');
}

const isSleepRead = (line) => SLEEP_READ_RE.test(codeOf(line));

describe('Architecture – sleep records are read through visibleSleep (med-w6gx.31)', () => {
    it('detector flags direct sleep reads and ignores other types and prose', () => {
        for (const line of [
            "    const all = await records.list('sleep');",
            '    return visibleSleep(await records.list(SLEEP_RECORD_TYPE));',
            "    const raw = await records.listRaw('sleep');",
            '      records.list(SLEEP_RECORD_TYPE), records.list(DAYSTATS_RECORD_TYPE),',
        ]) {
            expect(isSleepRead(line), line).toBe(true);
        }
        for (const line of [
            "    const all = await records.list('daystats');",
            '    // records.list(SLEEP_RECORD_TYPE) here would double-count',
            "    const s = await records.list('sleepiness');",
            '    const all = await records.list(SLEEP_RECORD_TYPE_V2);',
        ]) {
            expect(isSleepRead(line), line).toBe(false);
        }
    });

    it('only the owners and allowlisted files read sleep records directly', () => {
        const offenders = [];
        const seenAllowed = new Set();
        for (const root of ROOTS) {
            for (const file of collectJsFiles(path.join(REPO_ROOT, root))) {
                const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
                const lines = fs.readFileSync(file, 'utf8').split('\n');
                lines.forEach((line, i) => {
                    if (!isSleepRead(line)) return;
                    if (ALLOWLIST.has(rel)) seenAllowed.add(rel);
                    if (!OWNERS.has(rel) && !ALLOWLIST.has(rel)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
                });
            }
        }
        expect(offenders, 'read sleep through vitals.js (visibleSleep) instead').toEqual([]);
        // A stale allowlist entry hides nothing; drop it when the read moves.
        expect([...ALLOWLIST.keys()].filter((f) => !seenAllowed.has(f))).toEqual([]);
    });

    it('every allowlisted file uses visibleSleep', () => {
        for (const rel of ALLOWLIST.keys()) {
            expect(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'), rel).toMatch(/visibleSleep\(/);
        }
    });
});
