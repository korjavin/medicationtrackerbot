import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Exercise the checked-in Actions expression, rather than a separate policy copy.
const workflow = readFileSync(new URL('../../../../.github/workflows/ios.yml', import.meta.url), 'utf8');
const build = workflow.split('\n  build:\n')[1];
const condition = build.match(/^    if: (.+)$/m)[1];
const selectsBuild = new Function('github', 'inputs', `return (${condition});`);

describe('iOS distribution dispatch safety', () => {
    it.each(['push', 'pull_request', 'workflow_dispatch'])('preserves the ordinary %s build with default inputs', (eventName) => {
        expect(selectsBuild({ event_name: eventName, event: {} }, {})).toBe(true);
    });

    it('excludes a label-only event', () => {
        expect(selectsBuild({ event_name: 'pull_request', event: { action: 'labeled' } }, {})).toBe(false);
    });

    // All 63 non-default combinations, including unpaired modifiers, are QA intent.
    it.each(Array.from({ length: 64 }, (_, mask) => [mask]))('dispatch mask %i cannot turn Simulator intent into a release', (mask) => {
        const inputs = {
            visual: Boolean(mask & 1), qa: Boolean(mask & 2), health_diagnostic: Boolean(mask & 4),
            health_sign: Boolean(mask & 8), visual_scenes: mask & 16 ? 'health-kit-import' : '', qa_parts: mask & 32 ? 'core' : '',
        };
        expect(selectsBuild({ event_name: 'workflow_dispatch', event: {} }, inputs)).toBe(mask === 0);
    });
});

describe('iOS flow-QA parts (bd med-5yr8)', () => {
    // A misspelt class in QA_PARTS would make its -only-testing select nothing.
    it('names only XCTest classes that exist in ios/UITests', () => {
        const parts = JSON.parse(workflow.match(/\n  QA_PARTS: >-\n((?:    .+\n)+)/)[1].replace(/\s+/g, ' '));
        const dir = new URL('../../../../ios/UITests/', import.meta.url);
        const declared = readdirSync(dir).filter((f) => f.endsWith('.swift'))
            .flatMap((f) => [...readFileSync(new URL(f, dir), 'utf8').matchAll(/class (\w+): XCTestCase/g)].map((m) => m[1]));
        const listed = Object.values(parts).flat();
        expect(Object.keys(parts)).not.toContain('rest');
        expect(listed.length).toBeGreaterThan(0);
        expect(listed.filter((c) => !declared.includes(c))).toEqual([]);
        expect(new Set(listed).size).toBe(listed.length);
    });
});
