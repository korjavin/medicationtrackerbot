import { readFileSync } from 'node:fs';
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

    // All 31 non-default combinations, including unpaired modifiers, are QA intent.
    it.each(Array.from({ length: 32 }, (_, mask) => [mask]))('dispatch mask %i cannot turn Simulator intent into a release', (mask) => {
        const inputs = {
            visual: Boolean(mask & 1), qa: Boolean(mask & 2), health_diagnostic: Boolean(mask & 4),
            health_sign: Boolean(mask & 8), visual_scenes: mask & 16 ? 'health-kit-import' : '',
        };
        expect(selectsBuild({ event_name: 'workflow_dispatch', event: {} }, inputs)).toBe(mask === 0);
    });
});
