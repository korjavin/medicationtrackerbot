// architecture.native-bridge-parity.test.js
//
// The iOS and Android shells answer the same bridge ops (docs/mobile-parity.md).
// Diffs the op lists in ios/App/LocalOrigin.swift (localOps/accountOps/sharedOps)
// and android/.../LocalOrigin.kt (LOCAL_OPS/ACCOUNT_OPS/SHARED_OPS). An op on one
// platform only must be listed in PLATFORM_ONLY with a reason.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const IOS = path.join(ROOT, 'ios/App/LocalOrigin.swift');
const ANDROID_DIR = path.join(ROOT, 'android/app/src/main/java');
const ANDROID = path.join(ANDROID_DIR, fs.readdirSync(ANDROID_DIR, { recursive: true }).find((f) => path.basename(f) === 'LocalOrigin.kt'));

const PLATFORM_ONLY = {
    chrome: 'Android system bars',
    'back.state': 'twin pending med-y7b4.4/.5: the second of the two PRs removes this entry',
    'clipboard.read': 'Android: WebView has no clipboard-read permission UI; iOS and the web read navigator.clipboard from the tap',
};

// { op: group } from `<name> = [ ... ]` (Swift) or `<name> = setOf( ... )` (Kotlin).
function ops(file, names, open, close) {
    const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const out = {};
    for (const [group, name] of Object.entries(names)) {
        const m = src.match(new RegExp(`\\b${name}\\s*=\\s*${open}([\\s\\S]*?)${close}`));
        for (const [, op] of (m ? m[1] : '').matchAll(/"([^"]+)"/g)) out[op] = group;
    }
    return out;
}

const ios = ops(IOS, { local: 'localOps', account: 'accountOps', shared: 'sharedOps' }, '\\[', '\\]');
const android = ops(ANDROID, { local: 'LOCAL_OPS', account: 'ACCOUNT_OPS', shared: 'SHARED_OPS' }, 'setOf\\(', '\\)');

describe('native bridge op parity', () => {
    it('extracts every op group from both shells', () => {
        for (const found of [ios, android]) {
            expect(new Set(Object.values(found))).toEqual(new Set(['local', 'account', 'shared']));
        }
    });

    it('both shells answer the same ops in the same mode, or the op is in PLATFORM_ONLY', () => {
        const diff = [];
        for (const op of new Set([...Object.keys(ios), ...Object.keys(android)])) {
            if (ios[op] === android[op] || op in PLATFORM_ONLY) continue;
            diff.push(`${op}: ios=${ios[op] || 'missing'} android=${android[op] || 'missing'}`);
        }
        expect(diff).toEqual([]);
    });

    it('PLATFORM_ONLY has no stale entries', () => {
        expect(Object.keys(PLATFORM_ONLY).filter((op) => !!ios[op] === !!android[op])).toEqual([]);
    });

    // base.post's path allowlist (contract med-ta2n.24 A2/A7): one list in each shell and the page.
    it('base.post paths are identical in both shells and the page', () => {
        const paths = (file, re) => {
            const m = fs.readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '').match(re);
            return m ? [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]).sort() : [];
        };
        const iosPaths = paths(IOS, /\bbasePostPaths\b[^=]*=\s*\[([\s\S]*?)\]/);
        expect(iosPaths).toEqual(['/api/attest/challenge', '/api/attest/enroll', '/api/attest/feedback', '/api/invite-requests']);
        expect(paths(ANDROID, /\bBASE_POST_PATHS\s*=\s*setOf\(([\s\S]*?)\)/)).toEqual(iosPaths);
        expect(paths(path.join(ROOT, 'web/cloud/js/local-policy.js'), /\bBASE_POST_PATHS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]/)).toEqual(iosPaths);
    });
});
