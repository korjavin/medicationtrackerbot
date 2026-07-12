// Settings → Import/Export section (C2e Task 6). Pin the contract:
//
//   - export (bot) reads GET /api/export and downloads a Blob whose JSON
//     parses to { format: "medtracker-vault" }
//   - import (bot) happy path POSTs the vault + mode:"replace" to /api/import
//     only after the destructive confirm resolves true
//   - cloud branch dispatches to a stubbed window.CloudVault instead of the
//     /api routes

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

// A minimal well-formed vault the export endpoint / CloudVault returns.
const SAMPLE_VAULT = {
    format: 'medtracker-vault',
    version: 1,
    exported_at: '2026-07-08T00:00:00Z',
    data: { diary: { notes: [] } }
};

// jsdom's Blob has no .text(); read it back through the env's FileReader
// (FileReader is a window global, not a Node one). location.reload is a
// jsdom navigation no-op, so the import success path needs no stubbing.
function blobBytes(window, blob) {
    return new Promise((resolve, reject) => {
        const r = new window.FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsArrayBuffer(blob);
    });
}

function blobText(window, blob) {
    return new Promise((resolve, reject) => {
        const r = new window.FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsText(blob);
    });
}

function setFile(window, input, name, jsonString) {
    // Use the env's File so the module's jsdom FileReader can read it back.
    const file = new window.File([jsonString], name, { type: 'application/json' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
}

describe('Settings → Import/Export section', () => {
    let env;

    beforeEach(() => {
        // The import success path calls location.reload(), which jsdom logs as a
        // "Not implemented: navigation" console.error — expected, not a failure.
        allowConsoleNoise();
        env = loadFrontendEnv();
        // Keep the real gzip/decode helpers (the export and import paths run
        // through them); stub only the age crypto. isAgeFile(false) by default —
        // tests drive plaintext .json files.
        env.window.BackupCrypto = {
            ...env.window.BackupCrypto,
            isAgeFile: vi.fn(() => false),
            encryptBackup: vi.fn(),
            decryptBackup: vi.fn()
        };
        env.window.safeConfirm = vi.fn(async () => true);
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('renders the section and exposes SettingsImportExport', () => {
        const { window, document } = env;
        expect(document.getElementById('settings-importexport')).not.toBeNull();
        expect(document.getElementById('importexport-export-btn')).not.toBeNull();
        expect(document.getElementById('importexport-import-file')).not.toBeNull();
        expect(typeof window.SettingsImportExport.export).toBe('function');
        expect(typeof window.SettingsImportExport.import).toBe('function');
    });

    it('the file picker accepts every shape export writes', () => {
        // Regression: accept=".json,.age" made the picker refuse the .json.gz
        // that an unencrypted export produces — the backup was unimportable.
        const accept = env.document.getElementById('importexport-import-file').getAttribute('accept');
        for (const ext of ['.gz', '.age', '.json']) expect(accept).toContain(ext);
    });

    it('include-secrets checkbox is checked by default', () => {
        expect(env.document.getElementById('importexport-include-secrets').checked).toBe(true);
    });

    // med-c2b: the import passphrase box is an answer to a question we can ask
    // the file itself. It ships `hidden` and appears only for an age archive.
    describe('import passphrase field', () => {
        function pick(name, contents) {
            const input = env.document.getElementById('importexport-import-file');
            setFile(env.window, input, name, contents);
            input.dispatchEvent(new env.window.Event('change'));
            return env.document.getElementById('importexport-import-passphrase-field');
        }

        it('stays hidden for a plaintext archive', async () => {
            env.window.BackupCrypto.isAgeFile = vi.fn(() => false);
            const field = pick('vault.json', JSON.stringify(SAMPLE_VAULT));
            await vi.waitFor(() => expect(env.window.BackupCrypto.isAgeFile).toHaveBeenCalled());
            expect(field.hidden).toBe(true);
        });

        it('is revealed for an age-encrypted archive', async () => {
            env.window.BackupCrypto.isAgeFile = vi.fn(() => true);
            const field = pick('vault.json.gz.age', 'age-encryption.org/v1\n');
            await vi.waitFor(() => expect(field.hidden).toBe(false));
        });

        it('is hidden again after switching back to a plaintext archive', async () => {
            env.window.BackupCrypto.isAgeFile = vi.fn(() => true);
            const field = pick('vault.json.gz.age', 'age-encryption.org/v1\n');
            await vi.waitFor(() => expect(field.hidden).toBe(false));

            env.window.BackupCrypto.isAgeFile = vi.fn(() => false);
            pick('vault.json', JSON.stringify(SAMPLE_VAULT));
            await vi.waitFor(() => expect(field.hidden).toBe(true));
        });

        // The `hidden` attribute above is only a UA `display:none`. The field's
        // own class sets `display:flex`, which outranks it — so the JS hid the
        // field and the CSS showed it anyway. Pin the guard rule.
        it('has a CSS rule making [hidden] actually hide it', async () => {
            const { readFile } = await import('node:fs/promises');
            const css = await readFile(
                new URL('../../css/styles.css', import.meta.url), 'utf8');
            expect(css).toMatch(/\.wg-settings-integrations__field\[hidden\]\s*\{[^}]*display:\s*none/);
        });
    });

    it('bot export drops secrets when the checkbox is unchecked', async () => {
        const { window, document } = env;
        document.getElementById('importexport-include-secrets').checked = false;
        window.apiCall = vi.fn(async () => SAMPLE_VAULT);
        window.downloadBlobAsFile = () => {};

        await window.SettingsImportExport.export();

        expect(window.apiCall).toHaveBeenCalledWith('/api/export?include_secrets=0', 'GET', null,
            expect.objectContaining({ timeoutMs: 600000 }));
    });

    it('cloud export passes includeSecrets:false through to CloudVault', async () => {
        const { window, document } = env;
        window.__MEDTRACKER_CLOUD__ = true;
        document.getElementById('importexport-include-secrets').checked = false;
        window.CloudVault = { exportAll: vi.fn(async () => JSON.stringify(SAMPLE_VAULT)), importAll: vi.fn() };
        window.downloadBlobAsFile = () => {};

        await window.SettingsImportExport.export();

        expect(window.CloudVault.exportAll).toHaveBeenCalledWith({ includeSecrets: false });
    });

    it('bot export downloads a gzipped medtracker-vault blob from GET /api/export', async () => {
        const { window } = env;
        window.apiCall = vi.fn(async (url, method) => {
            expect(url).toBe('/api/export?include_secrets=1');
            expect(method).toBe('GET');
            return SAMPLE_VAULT;
        });
        const downloads = [];
        window.downloadBlobAsFile = (blob, filename) => downloads.push({ blob, filename });

        await window.SettingsImportExport.export();

        expect(downloads).toHaveLength(1);
        expect(downloads[0].filename).toMatch(/^medtracker-vault-\d{4}-\d{2}-\d{2}\.json\.gz$/);
        // The blob is a real gzip member that gunzips back to the vault.
        const gz = new Uint8Array(await blobBytes(window, downloads[0].blob));
        expect(window.BackupCrypto.isGzipFile(gz)).toBe(true);
        const parsed = JSON.parse(await window.BackupCrypto.gunzipToString(gz));
        expect(parsed.format).toBe('medtracker-vault');
    });

    it('bot import POSTs a gzipped vault + mode:replace to /api/import after confirm', async () => {
        const { window, document } = env;
        const posts = [];
        window.apiCall = vi.fn(async (url, method, body, opts) => {
            if (url === '/api/import') { posts.push({ method, body, opts }); return { ok: true }; }
            return null;
        });

        setFile(window, document.getElementById('importexport-import-file'), 'backup.json', JSON.stringify(SAMPLE_VAULT));
        await window.SettingsImportExport.import();

        expect(window.safeConfirm).toHaveBeenCalled();
        expect(posts).toHaveLength(1);
        expect(posts[0].method).toBe('POST');
        // Body is gzip bytes, not an object: the plaintext exceeds the 64MB cap.
        expect(posts[0].opts.headers).toEqual({ 'Content-Encoding': 'gzip' });
        expect(window.BackupCrypto.isGzipFile(posts[0].body)).toBe(true);
        const sent = JSON.parse(await window.BackupCrypto.gunzipToString(posts[0].body));
        expect(sent.mode).toBe('replace');
        expect(sent.format).toBe('medtracker-vault');
    });

    it('bot import accepts a gzipped backup file', async () => {
        const { window, document } = env;
        const posts = [];
        window.apiCall = vi.fn(async (url, method, body) => {
            if (url === '/api/import') { posts.push(body); return { ok: true }; }
            return null;
        });

        const gz = await window.BackupCrypto.gzipString(JSON.stringify(SAMPLE_VAULT));
        const input = document.getElementById('importexport-import-file');
        const file = new window.File([gz], 'backup.json.gz', { type: 'application/gzip' });
        Object.defineProperty(input, 'files', { configurable: true, value: [file] });

        await window.SettingsImportExport.import();

        expect(posts).toHaveLength(1);
        const sent = JSON.parse(await window.BackupCrypto.gunzipToString(posts[0]));
        expect(sent.format).toBe('medtracker-vault');
    });

    it('bot import does nothing when the confirm is declined', async () => {
        const { window, document } = env;
        window.safeConfirm = vi.fn(async () => false);
        window.apiCall = vi.fn(async () => ({ ok: true }));

        setFile(window, document.getElementById('importexport-import-file'), 'backup.json', JSON.stringify(SAMPLE_VAULT));
        await window.SettingsImportExport.import();

        expect(window.apiCall).not.toHaveBeenCalled();
    });

    it('cloud export dispatches to CloudVault.exportAll, never /api/export', async () => {
        const { window } = env;
        window.__MEDTRACKER_CLOUD__ = true;
        window.apiCall = vi.fn();
        window.CloudVault = { exportAll: vi.fn(async () => JSON.stringify(SAMPLE_VAULT)), importAll: vi.fn() };
        const downloads = [];
        window.downloadBlobAsFile = (blob, filename) => downloads.push({ blob, filename });

        await window.SettingsImportExport.export();

        expect(window.CloudVault.exportAll).toHaveBeenCalled();
        expect(window.apiCall).not.toHaveBeenCalled();
        expect(downloads).toHaveLength(1);
    });

    it('cloud import dispatches to CloudVault.importAll, never /api/import', async () => {
        const { window, document } = env;
        window.__MEDTRACKER_CLOUD__ = true;
        window.apiCall = vi.fn();
        window.CloudVault = { exportAll: vi.fn(), importAll: vi.fn(async () => {}) };

        setFile(window, document.getElementById('importexport-import-file'), 'backup.json', JSON.stringify(SAMPLE_VAULT));
        await window.SettingsImportExport.import();

        expect(window.CloudVault.importAll).toHaveBeenCalledTimes(1);
        expect(window.apiCall).not.toHaveBeenCalled();
    });

    // Mi Band .nxk ingestion — cloud only, POSTs raw multipart to the Go handler.
    describe('Mi Band .nxk import control', () => {
        function goCloud() {
            env.window.__MEDTRACKER_CLOUD__ = true;
            env.window.SettingsImportExport.load(); // re-bind so the group is revealed
        }

        it('the group is hidden outside cloud mode', () => {
            expect(env.document.getElementById('importexport-nxk-group').hidden).toBe(true);
        });

        it('reveals the group in cloud mode', () => {
            goCloud();
            expect(env.document.getElementById('importexport-nxk-group').hidden).toBe(false);
        });

        it('POSTs the picked file as multipart to /api/vitals/import', async () => {
            const { window, document } = env;
            goCloud();
            const calls = [];
            window.fetch = vi.fn(async (url, opts) => {
                calls.push({ url, opts });
                return { ok: true, status: 200, json: async () => ({ queued: 7 }) };
            });
            window.SyncManager = { showToast: vi.fn() };

            const input = document.getElementById('importexport-nxk-file');
            const file = new window.File([new Uint8Array([1, 2, 3])], 'backup.nxk');
            Object.defineProperty(input, 'files', { configurable: true, value: [file] });

            await window.SettingsImportExport.importNxk();

            expect(calls).toHaveLength(1);
            expect(calls[0].url).toBe('/api/vitals/import');
            expect(calls[0].opts.method).toBe('POST');
            expect(calls[0].opts.body).toBeInstanceOf(window.FormData);
            expect(window.SyncManager.showToast).toHaveBeenCalledWith(
                expect.stringContaining('7'), 'success');
        });

        it('surfaces the no-inbox-key 412 as an error toast', async () => {
            const { window, document } = env;
            goCloud();
            window.fetch = vi.fn(async () => ({ ok: false, status: 412, json: async () => ({}) }));
            window.SyncManager = { showToast: vi.fn() };

            const input = document.getElementById('importexport-nxk-file');
            const file = new window.File([new Uint8Array([1])], 'backup.nxk');
            Object.defineProperty(input, 'files', { configurable: true, value: [file] });

            await window.SettingsImportExport.importNxk();

            expect(window.SyncManager.showToast).toHaveBeenCalledWith(
                expect.stringContaining('inbox key'), 'error');
        });

        it('does nothing when no file is picked', async () => {
            const { window } = env;
            goCloud();
            window.fetch = vi.fn();
            window.safeAlert = vi.fn();

            await window.SettingsImportExport.importNxk();

            expect(window.fetch).not.toHaveBeenCalled();
            expect(window.safeAlert).toHaveBeenCalled();
        });
    });

    // med-0ol.1/.4 — a big import runs for a while; without feedback the user
    // clicks again (double submit), and closing the tab mid-upload corrupts it.
    describe('import busy state + navigation guard', () => {
        function deferred() {
            let resolve;
            const promise = new Promise((r) => { resolve = r; });
            return { promise, resolve };
        }

        it('disables the button, shows progress, and ignores a second click mid-import (vault)', async () => {
            const { window, document } = env;
            window.__MEDTRACKER_CLOUD__ = true;
            const d = deferred();
            window.CloudVault = { exportAll: vi.fn(), importAll: vi.fn(() => d.promise) };
            setFile(window, document.getElementById('importexport-import-file'), 'backup.json', JSON.stringify(SAMPLE_VAULT));

            const first = window.SettingsImportExport.import();
            // Busy state arms after the awaited file-read + destructive confirm.
            await vi.waitFor(() => expect(document.getElementById('importexport-import-btn').disabled).toBe(true));
            const note = document.getElementById('importexport-import-progress');
            expect(note.hidden).toBe(false);
            expect(note.textContent.length).toBeGreaterThan(0);

            // A second click while the first import is in flight is a no-op.
            await window.SettingsImportExport.import();
            expect(window.CloudVault.importAll).toHaveBeenCalledTimes(1);

            d.resolve();
            await first;
            // Cleared on completion (before the reload).
            expect(document.getElementById('importexport-import-btn').disabled).toBe(false);
            expect(note.hidden).toBe(true);
        });

        it('arms a beforeunload guard while importing and removes it on completion', async () => {
            const { window, document } = env;
            window.__MEDTRACKER_CLOUD__ = true;
            const added = [];
            const removed = [];
            const realAdd = window.addEventListener.bind(window);
            const realRemove = window.removeEventListener.bind(window);
            vi.spyOn(window, 'addEventListener').mockImplementation((type, fn, opts) => {
                if (type === 'beforeunload') added.push(fn);
                return realAdd(type, fn, opts);
            });
            vi.spyOn(window, 'removeEventListener').mockImplementation((type, fn, opts) => {
                if (type === 'beforeunload') removed.push(fn);
                return realRemove(type, fn, opts);
            });
            const d = deferred();
            window.CloudVault = { exportAll: vi.fn(), importAll: vi.fn(() => d.promise) };
            setFile(window, document.getElementById('importexport-import-file'), 'backup.json', JSON.stringify(SAMPLE_VAULT));

            const first = window.SettingsImportExport.import();
            await vi.waitFor(() => expect(added.length).toBe(1));
            // The handler actually blocks the unload (native "Leave site?" prompt).
            const evt = { preventDefault: vi.fn(), returnValue: null };
            added[0](evt);
            expect(evt.preventDefault).toHaveBeenCalled();

            d.resolve();
            await first;
            expect(removed).toContain(added[0]); // no lingering navigation nag
        });

        it('the .nxk upload disables both import buttons and is not double-triggered', async () => {
            const { window, document } = env;
            window.__MEDTRACKER_CLOUD__ = true;
            window.SettingsImportExport.load(); // reveal the nxk group
            window.SyncManager = { showToast: vi.fn() };
            const d = deferred();
            window.fetch = vi.fn(() => d.promise.then(() => ({ ok: true, status: 200, json: async () => ({ queued: 3 }) })));
            const input = document.getElementById('importexport-nxk-file');
            const file = new window.File([new Uint8Array([1, 2, 3])], 'backup.nxk');
            Object.defineProperty(input, 'files', { configurable: true, value: [file] });

            const p = window.SettingsImportExport.importNxk();
            // doNxkImport has no awaits before the busy state, so it arms synchronously.
            expect(document.getElementById('importexport-nxk-btn').disabled).toBe(true);
            expect(document.getElementById('importexport-import-btn').disabled).toBe(true);

            await window.SettingsImportExport.importNxk(); // second click ignored
            expect(window.fetch).toHaveBeenCalledTimes(1);

            d.resolve();
            await p;
            expect(document.getElementById('importexport-nxk-btn').disabled).toBe(false);
        });
    });
});
