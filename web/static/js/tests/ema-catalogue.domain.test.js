import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createEMACatalogue } from '../../../domain/ema-catalogue.js';

const fixture = JSON.parse(readFileSync(new URL('../../../../internal/emacatalog/testdata/rows.json', import.meta.url)));
const source = JSON.parse(readFileSync(new URL('../../../../third_party/ema-article57/source.json', import.meta.url)));
const makeData = (rows = fixture.rows) => ({ schema_version: 1, source, columns: ['name', 'substances', 'route', 'jurisdiction'], source_rows: rows.length, rows });

describe('EMA standalone exact catalogue', () => {
    it('returns source candidates without changing original strings or inferring an identity', () => {
        const index = createEMACatalogue(makeData());
        const candecor = index.exact('  cAnDeCoR  ');
        expect(candecor.candidates.map(row => row.jurisdiction)).toEqual(['Germany', 'Slovenia']);
        expect(candecor.ambiguous).toBe(true);
        expect(index.exact('Candecor', { jurisdiction: 'Germany' }).candidates).toEqual([
            { name: 'Candecor', substances: 'Candesartan Cilexetil', route: 'Oral Use', jurisdiction: 'Germany' },
        ]);
        expect(index.exact('Smecta').candidates).toHaveLength(2);
        const multi = index.exact('Abirasolon-Mcrpc Kombipackung');
        expect(multi.candidates[0].substances).toBe('Abiraterone Acetate | Prednisolone');
        expect(Object.keys(multi.candidates[0]).sort()).toEqual(['jurisdiction', 'name', 'route', 'substances']);
        expect(multi.source).toEqual(source);
    });

    it('keeps cross-country conflicts, same-country conflicts, routes and case collisions', () => {
        const index = createEMACatalogue(makeData());
        expect(new Set(index.exact('Aacidexam').candidates.map(row => row.substances)).size).toBe(2);
        expect(index.exact('Aacidexam', { jurisdiction: 'Belgium' }).candidates).toHaveLength(2);
        const sameCountry = index.exact('Abnobaviscum Abietis', { jurisdiction: 'Germany' });
        expect(sameCountry.candidates).toHaveLength(2);
        expect(sameCountry.ambiguous).toBe(true);
        expect(new Set(index.exact('A 313').candidates.map(row => row.route))).toEqual(new Set(['Cutaneous Use', 'Oral Use']));
        expect(index.exact('ATORVASTATIN AUROBINDO', { jurisdiction: 'Cyprus' }).candidates.map(row => row.name)).toEqual(['atorvastatin Aurobindo', 'Atorvastatin Aurobindo']);
    });

    it('only deduplicates identical candidates and snapshots injected data', () => {
        const rows = fixture.rows.map(row => [...row]);
        const data = makeData([...rows, [...rows[0]]]);
        const index = createEMACatalogue(data);
        rows[0][0] = 'mutated';
        data.source = {};
        const result = index.exact('Candecor');
        expect(result.candidates).toHaveLength(2);
        expect(Object.isFrozen(result.candidates)).toBe(true);
        expect(Object.isFrozen(result.candidates[0])).toBe(true);
        expect(Object.isFrozen(result.source)).toBe(true);
    });

    it('uses explicit source jurisdiction and explicit EU-wide inclusion only', () => {
        const rows = [
            ['Example', 'A', 'Oral Use', 'European Union'],
            ['Example', 'B', 'Oral Use', 'Germany'],
            ['Example', 'C', 'Oral Use', 'France'],
        ]; // Synthetic policy fixture; no clinical meaning.
        const index = createEMACatalogue(makeData(rows));
        expect(index.exact('Example').candidates).toHaveLength(3);
        expect(index.exact('Example', { jurisdiction: 'Germany' }).candidates.map(row => row.substances)).toEqual(['B']);
        expect(index.exact('Example', { jurisdiction: 'Germany', includeEUWide: true }).candidates.map(row => row.substances)).toEqual(['A', 'B']);
        expect(index.exact('Example', { jurisdiction: 'European Union' }).candidates.map(row => row.substances)).toEqual(['A']);
        expect(index.exact('Example', { jurisdiction: 'germany' }).candidates).toEqual([]);
    });

    it('leaves unknown, malformed, misspelled and accent-different names unmatched', () => {
        const index = createEMACatalogue(makeData());
        for (const name of [null, undefined, {}, [], 42, '', '  ', '\0Candecor', 'Cándecor', 'Candecor comp', 'Caldecort', 'Umecta', 'Smect']) {
            expect(index.exact(name)).toMatchObject({ candidates: [], ambiguous: false });
        }
        for (const options of [null, [], 'Germany', { jurisdiction: '' }, { jurisdiction: 42 }, { includeEUWide: 'yes' }, { locale: 'de' }]) {
            expect(index.exact('Candecor', options).candidates).toEqual([]);
        }
    });

    it('fails clearly for unsupported schema, incomplete provenance or malformed rows', () => {
        for (const data of [null, {}, { ...makeData(), schema_version: 2 }, { ...makeData(), columns: ['name', 'substances'] },
            { ...makeData(), source: {} }, { ...makeData(), rows: [['Candecor']] }, { ...makeData(), rows: [['A', '', 'B', 'C']] }]) {
            expect(() => createEMACatalogue(data)).toThrow(TypeError);
        }
    });

    it('validates the complete shipped asset, release hash, allowlist and real examples offline', () => {
        const bytes = readFileSync(new URL('../../data/ema-article57-rev90-v1.json', import.meta.url));
        const release = JSON.parse(readFileSync(new URL('../../../../third_party/ema-article57/release.json', import.meta.url)));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(release.asset_sha256);
        expect(bytes.length).toBe(release.json_bytes);
        expect(bytes.length).toBeLessThanOrEqual(16 * 1024 * 1024);
        expect(gzipSync(bytes, { level: 9 }).length).toBe(release.gzip_level9_bytes);
        expect(release.gzip_level9_bytes).toBeLessThanOrEqual(3 * 1024 * 1024);
        const data = JSON.parse(bytes);
        expect(Object.keys(data).sort()).toEqual(['columns', 'rows', 'schema_version', 'source', 'source_rows']);
        expect(data.source).toEqual(source);
        expect(data.source_rows).toBe(release.source_rows);
        expect(data.rows.length).toBe(release.unique_rows);
        const index = createEMACatalogue(data); // Validates every row's four-column shape.
        for (const row of fixture.rows) {
            expect(index.exact(row[0], { jurisdiction: row[3] }).candidates).toContainEqual(Object.fromEntries(data.columns.map((field, i) => [field, row[i]])));
        }
        expect(index.exact('Abnobaviscum Abietis', { jurisdiction: 'Germany' }).ambiguous).toBe(true);
    });
});
