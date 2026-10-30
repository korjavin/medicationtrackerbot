// Validate every generated row and report local parse/index costs. --record
// explicitly updates stable release measurements after source/reuse review.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { createEMACatalogue } from '../web/domain/ema-catalogue.js';

const assetURL = new URL('../web/static/data/ema-article57-rev90-v1.json', import.meta.url);
const releaseURL = new URL('../third_party/ema-article57/release.json', import.meta.url);
const source = JSON.parse(readFileSync(new URL('../third_party/ema-article57/source.json', import.meta.url)));
const beforeLoad = performance.now();
const bytes = readFileSync(assetURL);
const loaded = performance.now();
assert(bytes.length <= 16 * 1024 * 1024, 'EMA JSON exceeds reviewed 16 MiB budget');
const compressed = gzipSync(bytes, { level: 9 });
assert(compressed.length <= 3 * 1024 * 1024, 'EMA gzip exceeds reviewed 3 MiB budget');
const started = performance.now();
const data = JSON.parse(bytes.toString('utf8'));
const parsed = performance.now();
assert.deepEqual(Object.keys(data).sort(), ['columns', 'rows', 'schema_version', 'source', 'source_rows']);
assert.deepEqual(data.source, source);
const lookup = createEMACatalogue(data);
const indexed = performance.now();
const countries = new Set();
const names = new Map();
let previous;
let multiProductRows = 0;
for (const row of data.rows) {
    assert(row.every(value => !/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(value)), 'email-shaped text in A-D');
    // Strict lexicographic tuple order, using UTF-8 bytes like the Go generator.
    if (previous) {
        let order = 0;
        for (let i = 0; i < 4 && order === 0; i++) order = Buffer.compare(Buffer.from(previous[i]), Buffer.from(row[i]));
        assert(order < 0, 'unsorted or duplicate row');
    }
    previous = row;
    countries.add(row[3]);
    const key = row[0].trim().toLowerCase();
    if (!names.has(key)) names.set(key, new Set());
    names.get(key).add(row[1]);
    if (row[1].includes('|')) multiProductRows++;
}
const fixture = JSON.parse(readFileSync(new URL('../internal/emacatalog/testdata/rows.json', import.meta.url)));
for (const row of fixture.rows) {
    const result = lookup.exact(row[0], { jurisdiction: row[3] });
    assert(result.candidates.some(candidate => data.columns.every((field, i) => candidate[field] === row[i])), 'real fixture candidate missing');
}
const release = {
    asset_sha256: createHash('sha256').update(bytes).digest('hex'),
    json_bytes: bytes.length,
    gzip_level9_bytes: compressed.length,
    source_rows: data.source_rows,
    unique_rows: data.rows.length,
    jurisdictions: countries.size,
    lowercase_trimmed_names_with_distinct_raw_substances: [...names.values()].filter(values => values.size > 1).length,
    multi_product_rows: multiProductRows,
};
if (process.argv.includes('--record')) writeFileSync(releaseURL, JSON.stringify(release, null, 2) + '\n');
else {
    // Compression output can vary with the runtime's zlib version. Pin the
    // original JSON bytes/counts; enforce the gzip budget on this runtime.
    const expected = JSON.parse(readFileSync(releaseURL));
    const stable = ({ gzip_level9_bytes, ...rest }) => rest;
    assert.deepEqual(stable(release), stable(expected), 'release drifted; review the update before --record');
}
console.log(JSON.stringify({ ...release, read_ms: +(loaded - beforeLoad).toFixed(2), parse_ms: +(parsed - started).toFixed(2), index_ms: +(indexed - parsed).toFixed(2) }, null, 2));
