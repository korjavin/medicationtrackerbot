// Visual compare step (bd med-y5xx.4, docs/design/ios-visual-testing.md piece 6).
//
//   node tests/visual/compare.mjs <current-dir> <reference-dir> <out-dir>
//
// Diffs every <device>/<scene>.png of the current run against the same file
// of the reference run (master's latest artifact) with pixelmatch, and writes
// out/diff/<device>/<scene>.png, out/summary.json and out/summary.md. Scenes
// may carry "mask" rectangles in tests/visual/scenes.json (fractions of the
// image: {x, y, w, h} in 0..1), blanked in both images before the diff.
// Evidence, never a gate: always exits 0.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pixelmatch from 'pixelmatch';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const SCENES = join(dirname(fileURLToPath(import.meta.url)), 'scenes.json');

async function pngs(dir, skip) {
    const out = [];
    const walk = async (d) => {
        let entries = [];
        try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = join(d, e.name);
            if (e.isDirectory()) { if (resolve(p) !== skip) await walk(p); } else if (e.name.endsWith('.png')) out.push(relative(dir, p));
        }
    };
    await walk(dir);
    return out.sort();
}

async function readPNG(path) {
    try { return PNG.sync.read(await readFile(path)); } catch { return null; }
}

function blank(img, masks) {
    for (const m of masks || []) {
        const x0 = Math.max(0, Math.round(m.x * img.width));
        const y0 = Math.max(0, Math.round(m.y * img.height));
        const x1 = Math.min(img.width, Math.round((m.x + m.w) * img.width));
        const y1 = Math.min(img.height, Math.round((m.y + m.h) * img.height));
        for (let y = y0; y < y1; y++) img.data.fill(0, (y * img.width + x0) * 4, (y * img.width + x1) * 4);
    }
}

async function probesOk(jsonPath) {
    try {
        const r = JSON.parse(await readFile(jsonPath, 'utf8'));
        return r.ok === true && !r.error;
    } catch { return null; }
}

export async function compare(current, reference, out, scenesPath = SCENES) {
    let masks = {};
    try {
        const list = JSON.parse(await readFile(scenesPath, 'utf8'));
        for (const s of list.scenes || list) if (s.mask) masks[s.name] = s.mask;
    } catch { masks = {}; }
    const rows = [];
    for (const rel of await pngs(current, resolve(out))) { // out may sit inside current (shots/compare)
        const device = dirname(rel);
        const scene = rel.slice(device.length + 1, -'.png'.length);
        const row = { scene, device, changedRatio: null, probesOk: await probesOk(join(current, device, `${scene}.json`)) };
        rows.push(row);
        const cur = await readPNG(join(current, rel));
        const ref = await readPNG(join(reference, rel));
        if (!cur) { row.note = 'unreadable'; continue; }
        if (!ref) { row.note = 'no reference'; continue; }
        if (cur.width !== ref.width || cur.height !== ref.height) {
            row.changedRatio = 1;
            row.note = `size ${ref.width}x${ref.height} -> ${cur.width}x${cur.height}`;
            continue;
        }
        blank(cur, masks[scene]);
        blank(ref, masks[scene]);
        const diff = new PNG({ width: cur.width, height: cur.height });
        const changed = pixelmatch(ref.data, cur.data, diff.data, cur.width, cur.height, { threshold: 0.1 });
        row.changedRatio = changed / (cur.width * cur.height);
        if (changed) {
            await mkdir(join(out, 'diff', device), { recursive: true });
            await writeFile(join(out, 'diff', rel), PNG.sync.write(diff));
            row.diff = join('diff', rel);
        }
    }
    // Probe failures first, then the biggest diffs, then the rows with no reference.
    const rank = (r) => (r.probesOk === false ? 0 : 1);
    rows.sort((a, b) => rank(a) - rank(b) || (b.changedRatio ?? -1) - (a.changedRatio ?? -1)
        || a.device.localeCompare(b.device) || a.scene.localeCompare(b.scene));
    const pct = (r) => (r.changedRatio == null ? '—' : `${(r.changedRatio * 100).toFixed(2)}%`);
    const md = [
        '### Visual diff against master', '',
        rows.some((r) => r.note !== 'no reference')
            ? 'Changed pixels per scene (pixelmatch, threshold 0.1) against the reference run. Evidence only.'
            : 'No reference screenshots (no master artifact yet): nothing to diff.', '',
        '| device | scene | changed | probes | note |', '|---|---|---|---|---|',
        ...rows.map((r) => `| ${r.device} | ${r.scene} | ${pct(r)} | ${r.probesOk == null ? '—' : r.probesOk ? 'ok' : '**failed**'} | ${r.note || (r.diff ? `\`${r.diff}\`` : '')} |`),
    ].join('\n');
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'summary.json'), JSON.stringify(rows, null, 2));
    await writeFile(join(out, 'summary.md'), md + '\n');
    return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [current, reference, out] = process.argv.slice(2);
    try {
        if (!current || !reference || !out) throw new Error('usage: compare.mjs <current-dir> <reference-dir> <out-dir>');
        const rows = await compare(current, reference, out);
        console.log(`compared ${rows.length} screenshot(s), summary in ${join(out, 'summary.md')}`);
    } catch (e) {
        console.log(`::warning title=visual compare::${e.message || e}`);
    }
}
