// architecture.cache-keys.test.js
//
// Lint guard for the centralized cache-key registry (core/cache-keys.js).
//
// Scans every JS source file outside the registry/infrastructure layer for
// literal string arguments to setCached / getCached / clearCached /
// setCachedWithTags. Each literal must correspond to a known entry in the
// registry — either a static-key name or a value matching a registered
// dynamic-family prefix.
//
// Why: the registry exists to catch typos and centralize cache-key policy.
// `getCached('medication')` (singular) silently returns null today; routed
// through this guard, it fails the build with a pointer at the registry.
// New cache keys must be added to web/static/js/core/cache-keys.js before
// the source can reference them.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const JS_ROOT = path.join(REPO_ROOT, 'web/static/js');
const CACHE_KEYS_JS = path.join(JS_ROOT, 'core/cache-keys.js');

// Files that own the cache layer itself or its low-level facade.
// They are allowed to reference literal cache-key strings directly.
const EXCLUDED_RELATIVE = new Set([
    'web/static/js/core/cache-keys.js',
    'web/static/js/core/api.js',
    'web/static/js/data-store.js',
    'web/static/js/cached-fetch.js',
    'web/static/js/db.js'
]);

const SCAN_PATTERNS = [
    /\bsetCached\(\s*(['"])(\w+)\1/g,
    /\bgetCached\(\s*(['"])(\w+)\1/g,
    /\bclearCached\(\s*(['"])(\w+)\1/g,
    /\bsetCachedWithTags\(\s*(['"])(\w+)\1/g,
    /\bcachedFetch\(\s*(['"])(\w+)\1/g
];

function collectJsFiles(dir, results = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'tests' && entry.name !== 'node_modules') {
                collectJsFiles(full, results);
            }
        } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.min.js')) {
            results.push(full);
        }
    }
    return results;
}

// Parse the registry source to discover known static-key names and dynamic
// family prefixes without needing to evaluate the module. Keeping the parse
// regex-based means the test can run in plain node without jsdom.
function loadRegistryKnownKeys() {
    const src = fs.readFileSync(CACHE_KEYS_JS, 'utf8');

    const staticBlock = src.match(/const STATIC_KEYS\s*=\s*\{([\s\S]*?)\n\s*\};/);
    if (!staticBlock) {
        throw new Error('architecture.cache-keys.test.js: could not locate STATIC_KEYS in core/cache-keys.js');
    }
    const staticKeys = new Set();
    const keyRe = /key:\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = keyRe.exec(staticBlock[1])) !== null) staticKeys.add(m[1]);

    const familyBlock = src.match(/const FAMILIES\s*=\s*\[([\s\S]*?)\n\s*\];/);
    if (!familyBlock) {
        throw new Error('architecture.cache-keys.test.js: could not locate FAMILIES in core/cache-keys.js');
    }
    const familyPrefixes = [];
    const prefixRe = /prefix:\s*['"]([^'"]+)['"]/g;
    while ((m = prefixRe.exec(familyBlock[1])) !== null) familyPrefixes.push(m[1]);

    return { staticKeys, familyPrefixes };
}

function isKnownLiteral(literal, registry) {
    if (registry.staticKeys.has(literal)) return true;
    for (const prefix of registry.familyPrefixes) {
        if (literal.startsWith(prefix)) return true;
    }
    return false;
}

describe('Architecture – cache-keys registry guard', () => {
    it('every literal cache-key passed to setCached/getCached/clearCached/setCachedWithTags is registered', () => {
        const registry = loadRegistryKnownKeys();
        expect(registry.staticKeys.size).toBeGreaterThan(0);
        expect(registry.familyPrefixes.length).toBeGreaterThan(0);

        const jsFiles = collectJsFiles(JS_ROOT);
        expect(jsFiles.length).toBeGreaterThan(0);

        const violations = [];

        for (const filePath of jsFiles) {
            const rel = path.relative(REPO_ROOT, filePath);
            if (EXCLUDED_RELATIVE.has(rel)) continue;

            const source = fs.readFileSync(filePath, 'utf8');
            const lines = source.split('\n');

            for (const pattern of SCAN_PATTERNS) {
                pattern.lastIndex = 0;
                let match;
                while ((match = pattern.exec(source)) !== null) {
                    const literal = match[2];
                    if (isKnownLiteral(literal, registry)) continue;

                    // Compute 1-based line number from char offset.
                    const upTo = source.slice(0, match.index);
                    const lineNo = upTo.split('\n').length;
                    const lineText = (lines[lineNo - 1] || '').trim();
                    violations.push(`${rel}:${lineNo}: unknown cache key "${literal}" — ${lineText}`);
                }
            }
        }

        if (violations.length > 0) {
            throw new Error(
                `Unregistered cache-key literal(s) found.\n` +
                `Every literal passed to setCached / getCached / clearCached / setCachedWithTags ` +
                `must be a known entry in web/static/js/core/cache-keys.js — either a static key ` +
                `name or matching a registered dynamic-family prefix. Add the missing entry there, ` +
                `or fix the typo:\n\n` +
                violations.map(v => `  • ${v}`).join('\n')
            );
        }
    });
});
