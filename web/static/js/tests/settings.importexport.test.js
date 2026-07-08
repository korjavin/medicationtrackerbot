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
        // isAgeFile(false) by default — tests drive plaintext .json files.
        env.window.BackupCrypto = {
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

    it('include-secrets checkbox is checked by default', () => {
        expect(env.document.getElementById('importexport-include-secrets').checked).toBe(true);
    });

    it('bot export drops secrets when the checkbox is unchecked', async () => {
        const { window, document } = env;
        document.getElementById('importexport-include-secrets').checked = false;
        window.apiCall = vi.fn(async () => SAMPLE_VAULT);
        window.downloadBlobAsFile = () => {};

        await window.SettingsImportExport.export();

        expect(window.apiCall).toHaveBeenCalledWith('/api/export?include_secrets=0', 'GET');
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

    it('bot export downloads a medtracker-vault JSON blob from GET /api/export', async () => {
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
        expect(downloads[0].filename).toMatch(/^medtracker-vault-\d{4}-\d{2}-\d{2}\.json$/);
        const parsed = JSON.parse(await blobText(window, downloads[0].blob));
        expect(parsed.format).toBe('medtracker-vault');
    });

    it('bot import POSTs vault + mode:replace to /api/import after confirm', async () => {
        const { window, document } = env;
        const posts = [];
        window.apiCall = vi.fn(async (url, method, body) => {
            if (url === '/api/import') { posts.push({ method, body }); return { ok: true }; }
            return null;
        });

        setFile(window, document.getElementById('importexport-import-file'), 'backup.json', JSON.stringify(SAMPLE_VAULT));
        await window.SettingsImportExport.import();

        expect(window.safeConfirm).toHaveBeenCalled();
        expect(posts).toHaveLength(1);
        expect(posts[0].method).toBe('POST');
        expect(posts[0].body.mode).toBe('replace');
        expect(posts[0].body.format).toBe('medtracker-vault');
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
});
