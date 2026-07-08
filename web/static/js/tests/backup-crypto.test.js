// backup-crypto.test.js
// Exercises core/backup-crypto.js against the real vendored typage bundle
// (web/static/vendor/age.min.js):
//   - round-trip encrypt → decrypt
//   - wrong-passphrase rejection
//   - isAgeFile header sniff
//   - decrypt of a known-answer .age file generated with the *reference* age
//     CLI (tests/fixtures/backup-kat.age) — proving cross-tool interop.
//
// The module lazily dynamic-imports '/static/vendor/age.min.js', an absolute
// URL that doesn't resolve under Node. We register the module in a jsdom window
// (so window.BackupCrypto exists) then inject a Node loader via setLoader() that
// imports the same bundle by file URL.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const VENDOR = path.join(REPO_ROOT, 'web/static/vendor/age.min.js');

// Known-answer file: `age -e -p` of the plaintext below with KAT_PASS.
const KAT_FILE = path.join(REPO_ROOT, 'tests/fixtures/backup-kat.age');
const KAT_PASS = 'medtracker-known-answer-passphrase';
const KAT_PLAIN = '{"format":"medtracker-vault","version":1,"note":"age CLI known-answer"}';

describe('BackupCrypto (core/backup-crypto.js over vendored typage)', () => {
    let dom;
    let BackupCrypto;

    beforeAll(() => {
        dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
            url: 'https://example.test/',
            runScripts: 'outside-only',
        });
        const src = fs.readFileSync(
            path.join(REPO_ROOT, 'web/static/js/core/backup-crypto.js'),
            'utf8'
        );
        dom.window.eval(`${src}\n//# sourceURL=file://backup-crypto.js`);
        BackupCrypto = dom.window.BackupCrypto;
        // Inject a Node-resolvable loader for the vendored ESM bundle.
        BackupCrypto.setLoader(() => import(pathToFileURL(VENDOR).href));
    });

    afterAll(() => { if (dom) dom.window.close(); });

    it('exposes the documented API surface', () => {
        expect(typeof BackupCrypto.encryptBackup).toBe('function');
        expect(typeof BackupCrypto.decryptBackup).toBe('function');
        expect(typeof BackupCrypto.isAgeFile).toBe('function');
    });

    it('round-trips encrypt → decrypt and emits a real age v1 file', async () => {
        const payload = JSON.stringify({ format: 'medtracker-vault', version: 1, data: { a: 1 } });
        const ct = await BackupCrypto.encryptBackup(payload, 's3cret pass');
        expect(ct).toBeInstanceOf(Uint8Array);
        expect(BackupCrypto.isAgeFile(ct)).toBe(true);
        const out = await BackupCrypto.decryptBackup(ct, 's3cret pass');
        expect(out).toBe(payload);
    });

    it('rejects a wrong passphrase', async () => {
        const ct = await BackupCrypto.encryptBackup('hello', 'right-pass');
        await expect(BackupCrypto.decryptBackup(ct, 'wrong-pass')).rejects.toThrow();
    });

    it('requires a passphrase for encrypt and decrypt', async () => {
        await expect(BackupCrypto.encryptBackup('x', '')).rejects.toThrow(/passphrase/);
        await expect(BackupCrypto.decryptBackup(new Uint8Array([1]), '')).rejects.toThrow(/passphrase/);
    });

    it('isAgeFile only matches the age v1 header', () => {
        expect(BackupCrypto.isAgeFile(new TextEncoder().encode('age-encryption.org/v1\n...'))).toBe(true);
        expect(BackupCrypto.isAgeFile(new TextEncoder().encode('{"format":"medtracker-vault"}'))).toBe(false);
        expect(BackupCrypto.isAgeFile(new Uint8Array([1, 2, 3]))).toBe(false);
    });

    it('decrypts a known-answer file produced by the reference `age` CLI', async () => {
        const bytes = new Uint8Array(fs.readFileSync(KAT_FILE));
        expect(BackupCrypto.isAgeFile(bytes)).toBe(true);
        const out = await BackupCrypto.decryptBackup(bytes, KAT_PASS);
        expect(out).toBe(KAT_PLAIN);
    });
});
