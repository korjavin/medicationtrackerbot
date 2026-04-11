/**
 * architecture.sw-precache.test.js
 *
 * Validates that the Service Worker's STATIC_ASSETS array includes
 * every local script and stylesheet loaded by index.html.
 * Prevents offline breakage when new JS files are added but not precached.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const INDEX_PATH = path.join(REPO_ROOT, 'web/static/index.html');
const SW_PATH = path.join(REPO_ROOT, 'web/static/sw.js');

/**
 * Extract local asset paths from index.html <script src="..."> and
 * <link rel="stylesheet" href="..."> tags, stripping query strings.
 */
function extractIndexAssets(html) {
    const assets = new Set();

    // Match <script src="/static/..."> (skip external URLs like https://telegram.org/...)
    const scriptRe = /<script\s[^>]*src=["']([^"']+)["']/g;
    let m;
    while ((m = scriptRe.exec(html)) !== null) {
        const src = m[1].split('?')[0]; // strip ?v=TIMESTAMP
        if (src.startsWith('/static/')) {
            assets.add(src);
        }
    }

    // Match <link rel="stylesheet" href="/static/...">
    const linkRe = /<link\s[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/g;
    while ((m = linkRe.exec(html)) !== null) {
        const href = m[1].split('?')[0];
        if (href.startsWith('/static/')) {
            assets.add(href);
        }
    }
    // Also match href before rel
    const linkRe2 = /<link\s[^>]*href=["']([^"']+)["'][^>]*rel=["']stylesheet["']/g;
    while ((m = linkRe2.exec(html)) !== null) {
        const href = m[1].split('?')[0];
        if (href.startsWith('/static/')) {
            assets.add(href);
        }
    }

    return assets;
}

/**
 * Extract the STATIC_ASSETS array entries from sw.js source.
 */
function extractSwAssets(swSource) {
    const assets = new Set();
    // Match string literals inside the STATIC_ASSETS array
    const arrayMatch = swSource.match(/const STATIC_ASSETS\s*=\s*\[([\s\S]*?)\];/);
    if (!arrayMatch) return assets;

    const stringRe = /['"]([^'"]+)['"]/g;
    let m;
    while ((m = stringRe.exec(arrayMatch[1])) !== null) {
        assets.add(m[1]);
    }
    return assets;
}

describe('Service Worker precache coverage', () => {
    const html = fs.readFileSync(INDEX_PATH, 'utf-8');
    const swSource = fs.readFileSync(SW_PATH, 'utf-8');
    const indexAssets = extractIndexAssets(html);
    const swAssets = extractSwAssets(swSource);

    it('index.html should reference at least some local assets', () => {
        expect(indexAssets.size).toBeGreaterThan(0);
    });

    it('STATIC_ASSETS should include every local script and stylesheet from index.html', () => {
        const missing = [];
        for (const asset of indexAssets) {
            if (!swAssets.has(asset)) {
                missing.push(asset);
            }
        }
        expect(missing, `Missing from STATIC_ASSETS in sw.js:\n  ${missing.join('\n  ')}`).toEqual([]);
    });

    it('STATIC_ASSETS should include root document and manifest', () => {
        expect(swAssets.has('/')).toBe(true);
        expect(swAssets.has('/static/manifest.json')).toBe(true);
    });
});
