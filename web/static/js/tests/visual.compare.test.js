// bd med-y5xx.4 — tests/visual/compare.mjs, the visual job's diff step. A pure
// node layer with no integration entry point (rule 8): two tiny PNGs in, a
// diff PNG and the summary out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import pngjs from 'pngjs';
import { compare } from '../../../../tests/visual/compare.mjs';

const { PNG } = pngjs;
let tmp;

function writePNG(file, w, h, paint) {
    const img = new PNG({ width: w, height: h });
    for (let i = 0; i < w * h; i++) img.data.set([20, 40, 30, 255], i * 4);
    if (paint) paint(img);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, PNG.sync.write(img));
}

const dot = (x, y) => (img) => img.data.set([255, 255, 255, 255], (y * img.width + x) * 4);

describe('visual compare (med-y5xx.4)', () => {
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

    it('diffs shared scenes, honours masks, reports new scenes and probe failures', async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-compare-'));
        const cur = path.join(tmp, 'cur');
        const ref = path.join(tmp, 'ref');
        const out = path.join(cur, 'compare'); // inside current, as in ios.yml: never diffed itself
        writePNG(path.join(ref, 'phone/today.png'), 10, 10);
        writePNG(path.join(cur, 'phone/today.png'), 10, 10, dot(1, 1)); // 1 of 100 pixels
        writePNG(path.join(ref, 'phone/masked.png'), 10, 10);
        writePNG(path.join(cur, 'phone/masked.png'), 10, 10, dot(9, 0)); // inside the mask
        writePNG(path.join(cur, 'phone/new-scene.png'), 10, 10);
        fs.writeFileSync(path.join(cur, 'phone/today.json'), JSON.stringify({ ok: false, failed: ['hOverflow'] }));
        const scenes = path.join(tmp, 'scenes.json');
        fs.writeFileSync(scenes, JSON.stringify({ scenes: [{ name: 'masked', mask: [{ x: 0.5, y: 0, w: 0.5, h: 0.2 }] }] }));

        const rows = await compare(cur, ref, out, scenes);
        const by = Object.fromEntries(rows.map((r) => [r.scene, r]));

        expect(rows.map((r) => r.scene)).toEqual(['today', 'masked', 'new-scene']);
        expect(by.today).toMatchObject({ device: 'phone', changedRatio: 0.01, probesOk: false, diff: path.join('diff', 'phone/today.png') });
        expect(fs.existsSync(path.join(out, 'diff/phone/today.png'))).toBe(true);
        expect(by.masked.changedRatio).toBe(0);
        expect(by['new-scene']).toMatchObject({ changedRatio: null, note: 'no reference' });
        const md = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
        expect(md).toContain('| phone | today | 1.00% | **failed** |');
        expect(md).toContain('no reference');
        expect(JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'))).toHaveLength(3);
    });
});
