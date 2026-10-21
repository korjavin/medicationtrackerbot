// Settings → Import/Export section (C2e Task 6). Pin the contract:
//
//   - export reads the vault via window.CloudVault.exportAll and downloads
//     a Blob whose JSON parses to { format: "medtracker-vault" }
//   - import happy path dispatches the backup JSON to
//     window.CloudVault.importAll only after the destructive confirm
//     resolves true
//   - neither path touches /api export/import routes

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

    it('both pickers also accept application/octet-stream so iOS leaves .age/.nxk selectable', () => {
        // iOS maps accept to UTIs; .age/.nxk have none and grey out. octet-stream
        // maps to public.data (any file); wrong picks are rejected after reading.
        for (const id of ['importexport-import-file', 'importexport-nxk-file']) {
            expect(env.document.getElementById(id).getAttribute('accept')).toContain('application/octet-stream');
        }
    });

    it('a wrong file is rejected with a clear toast, nothing is replaced', async () => {
        const { window, document } = env;
        window.SyncManager = { showToast: vi.fn() };
        window.CloudVault = { exportAll: vi.fn(), hasUserContent: async () => false,
            importAll: vi.fn(async () => { throw new Error('Not a medtracker-vault v1 backup (got format "x", version 1)'); }) };
        setFile(window, document.getElementById('importexport-import-file'), 'photo.json', '{"format":"x","version":1}');
        await window.SettingsImportExport.import();
        expect(window.SyncManager.showToast).toHaveBeenCalledWith(expect.stringMatching(/Not a medtracker-vault/), 'error');
    });

    it('include-secrets checkbox is checked by default', () => {
        expect(env.document.getElementById('importexport-include-secrets').checked).toBe(true);
    });

    // med-c2b: the import passphrase is an answer to a question we can ask the
    // file itself. Kit S7 (bd med-ckm5.7): it is asked in a docked sheet over
    // the page (shot 09), and only for an age archive.
    describe('import passphrase sheet', () => {
        const sheet = () => env.document.getElementById('importexport-import-sheet');
        const open = () => !sheet().classList.contains('hidden');

        function pick(name, contents) {
            const input = env.document.getElementById('importexport-import-file');
            setFile(env.window, input, name, contents);
            input.dispatchEvent(new env.window.Event('change'));
        }

        it('no passphrase field lives on the page', () => {
            const pass = env.document.getElementById('importexport-import-passphrase');
            expect(pass.closest('.wg-settings-page')).toBeNull();
            expect(pass.closest('#importexport-import-sheet')).not.toBeNull();
        });

        it('a plaintext archive restores without asking', async () => {
            const { window } = env;
            window.CloudVault = { exportAll: vi.fn(), importAll: vi.fn(async () => {}), hasUserContent: async () => false };
            pick('vault.json', JSON.stringify(SAMPLE_VAULT));
            await window.SettingsImportExport.import();
            expect(open()).toBe(false);
            expect(window.CloudVault.importAll).toHaveBeenCalledTimes(1);
        });

        it('an age archive says encrypted on the picker', async () => {
            env.window.BackupCrypto.isAgeFile = vi.fn(() => true);
            pick('vault.json.gz.age', 'age-encryption.org/v1\n');
            const meta = env.document.querySelector('[data-file-input="importexport-import-file"] .wg-file__meta');
            await vi.waitFor(() => expect(meta.textContent).toMatch(/· encrypted$/));
        });

        it('an age archive asks in the sheet, decrypts with the typed passphrase, then clears it', async () => {
            const { window, document } = env;
            window.BackupCrypto.isAgeFile = vi.fn(() => true);
            window.BackupCrypto.decryptBackup = vi.fn(async () => new TextEncoder().encode(JSON.stringify(SAMPLE_VAULT)));
            window.CloudVault = { exportAll: vi.fn(), importAll: vi.fn(async () => {}), hasUserContent: async () => false };
            pick('vault.json.gz.age', 'age-encryption.org/v1\n');
            const done = window.SettingsImportExport.import();
            await vi.waitFor(() => expect(open()).toBe(true));
            expect(document.getElementById('importexport-sheet-backdrop').hidden).toBe(false);
            // An empty Decrypt keeps the sheet open.
            document.getElementById('importexport-import-decrypt').click();
            expect(open()).toBe(true);
            const pass = document.getElementById('importexport-import-passphrase');
            pass.value = 'pw';
            document.getElementById('importexport-import-decrypt').click();
            await done;
            expect(open()).toBe(false);
            expect(document.getElementById('importexport-sheet-backdrop').hidden).toBe(true);
            expect(window.BackupCrypto.decryptBackup).toHaveBeenCalledWith(expect.anything(), 'pw');
            expect(pass.value).toBe('');
            expect(window.CloudVault.importAll).toHaveBeenCalledTimes(1);
        });

        it('closing the sheet restores nothing and frees Restore', async () => {
            const { window, document } = env;
            window.BackupCrypto.isAgeFile = vi.fn(() => true);
            window.CloudVault = { exportAll: vi.fn(), importAll: vi.fn(async () => {}), hasUserContent: async () => false };
            pick('vault.json.gz.age', 'age-encryption.org/v1\n');
            const done = window.SettingsImportExport.import();
            await vi.waitFor(() => expect(open()).toBe(true));
            sheet().querySelector('[data-sheet-close]').click();
            await done;
            expect(window.BackupCrypto.decryptBackup).not.toHaveBeenCalled();
            expect(window.CloudVault.importAll).not.toHaveBeenCalled();
            // The re-entry guard is released: Restore asks again.
            const again = window.SettingsImportExport.import();
            await vi.waitFor(() => expect(open()).toBe(true));
            document.getElementById('importexport-sheet-backdrop').click();
            await again;
            expect(open()).toBe(false);
        });

        // The kit's display rules outrank the UA [hidden] rule; pin the guards
        // that keep [hidden] authoritative on the page and in the sheets.
        it('has CSS rules making [hidden] actually hide', async () => {
            const { readFile } = await import('node:fs/promises');
            const css = await readFile(
                new URL('../../css/styles.css', import.meta.url), 'utf8');
            expect(css).toMatch(/\.wg-settings-page \[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
            expect(css).toMatch(/\.wg-importexport-sheet \[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
            // Over the pushed page (--z-modal), on the backdrop's layer.
            expect(css).toMatch(/\.wg-importexport-sheet\s*\{[^}]*z-index:\s*var\(--z-confirm\)/);
            expect(css).toMatch(/\.wg-importexport-backdrop\s*\{[^}]*z-index:\s*var\(--z-confirm\)/);
            // Not the in-page dialog's class: its presence means a dialog is open.
            expect(env.document.querySelector('.mt-confirm-backdrop')).toBeNull();
        });
    });

    // Kit S7 (bd med-ckm5.7): Back up, Restore, Move, Danger in that order,
    // one sun on the page.
    it('lays the page out as Back up, Restore, Move, Danger', () => {
        const { document } = env;
        const heads = [...document.querySelectorAll('#settings-importexport > .wg-section > .wg-section__head .wg-eyebrow')]
            .map((e) => e.textContent);
        expect(heads.filter((h) => ['Back up', 'Restore', 'Move to a cloud account', 'Danger'].includes(h)))
            .toEqual(['Back up', 'Restore', 'Move to a cloud account', 'Danger']);
        expect(document.querySelectorAll('[data-settings-page="backup"] .wg-btn--primary')).toHaveLength(1);
        expect(document.getElementById('importexport-export-btn').textContent).toBe('Export backup');
        const erase = document.getElementById('importexport-local-erase-btn');
        expect(erase.classList.contains('wg-setting--boxed')).toBe(true);
        expect(erase.closest('section').querySelector('.wg-eyebrow--danger')).not.toBeNull();
    });

    // med-xso6.24 (kit S3): the native file input is hidden behind a kit
    // .wg-file picker whose Choose button opens it and whose row shows the file.
    describe('restore file picker', () => {
        function picker() {
            return env.document.querySelector('#settings-importexport .wg-file[data-file-input="importexport-import-file"]');
        }

        it('hides the native input and shows the empty picker', () => {
            const input = env.document.getElementById('importexport-import-file');
            expect(input.hidden).toBe(true);
            const p = picker();
            expect(p).not.toBeNull();
            expect(p.classList.contains('wg-file--filled')).toBe(false);
            expect(p.querySelector('[data-file-clear]').hidden).toBe(true);
            expect(p.querySelector('[data-file-choose]').hidden).toBe(false);
        });

        // med-5jsn: the name/meta spans must stack, or the meta runs inline
        // after the name and under the Choose button. jsdom has no layout,
        // so pin the kit rule itself.
        it('stacks the picker name above its meta line', async () => {
            const fs = await import('node:fs');
            const css = fs.readFileSync(new URL('../../css/components.css', import.meta.url), 'utf8');
            expect(css).toMatch(/\.wg-file__name,\.wg-file__meta\{display:block\}/);
        });

        // med-5jsn: opening the page by tap focuses Back without a ring;
        // a keyboard opener (focus-visible) keeps it.
        it('opens the page with Back focused but no ring after a tap', () => {
            const { window, document } = env;
            const focus = vi.spyOn(window.HTMLElement.prototype, 'focus');
            const page = window.SettingsView.openSettingsPage('backup');
            const back = page.el.querySelector('.wg-back');
            expect(focus.mock.contexts).toContain(back);
            const call = focus.mock.calls[focus.mock.contexts.indexOf(back)];
            expect(call[0]).toEqual({ focusVisible: false });
            expect(document.activeElement).toBe(back);
        });

        it('Choose opens the native input', () => {
            const input = env.document.getElementById('importexport-import-file');
            const click = vi.spyOn(input, 'click').mockImplementation(() => {});
            picker().querySelector('[data-file-choose]').click();
            expect(click).toHaveBeenCalledTimes(1);
        });

        it('fills with the file name on pick and clears back to empty', async () => {
            const input = env.document.getElementById('importexport-import-file');
            setFile(env.window, input, 'vault.json.gz', JSON.stringify(SAMPLE_VAULT));
            input.dispatchEvent(new env.window.Event('change'));
            const p = picker();
            await vi.waitFor(() => expect(p.classList.contains('wg-file--filled')).toBe(true));
            expect(p.textContent).toContain('vault.json.gz');
            expect(p.querySelector('[data-file-clear]').hidden).toBe(false);

            Object.defineProperty(input, 'files', { configurable: true, value: [] });
            p.querySelector('[data-file-clear]').click();
            await vi.waitFor(() => expect(p.classList.contains('wg-file--filled')).toBe(false));
            expect(p.textContent).toContain('Choose a backup file');
        });
    });

    // med-xso6.24: replacing the vault is the one irreversible action here —
    // it goes through the kit's typed-confirm dialog, destructive styling.
    it('import asks for a typed, destructive confirm', async () => {
        const { window, document } = env;
        window.CloudVault = { exportAll: vi.fn(), importAll: vi.fn(async () => {}) };
        setFile(window, document.getElementById('importexport-import-file'), 'backup.json', JSON.stringify(SAMPLE_VAULT));
        await window.SettingsImportExport.import();
        const opts = window.safeConfirm.mock.calls[0][2];
        expect(opts).toMatchObject({ destructive: true, typedConfirm: 'REPLACE', confirmLabel: 'Replace' });
        expect(opts.facts.map((f) => !!f.gone)).toEqual([true, false]);
    });

    // med-eyos: an empty target vault has nothing to lose, so no typed confirm;
    // anything but an explicit `false` from the probe keeps it (fail closed).
    describe('empty-vault restore skips the typed confirm', () => {
        async function run(probe) {
            const { window, document } = env;
            window.CloudVault = { exportAll: vi.fn(), importAll: vi.fn(async () => {}), ...(probe ? { hasUserContent: probe } : {}) };
            setFile(window, document.getElementById('importexport-import-file'), 'backup.json', JSON.stringify(SAMPLE_VAULT));
            await window.SettingsImportExport.import();
            return window;
        }
        it('probe false: imports with no dialog', async () => {
            const window = await run(vi.fn(async () => false));
            expect(window.safeConfirm).not.toHaveBeenCalled();
            expect(window.CloudVault.importAll).toHaveBeenCalledTimes(1);
        });
        it('probe true: typed confirm, cancel aborts', async () => {
            env.window.safeConfirm = vi.fn(async () => false);
            const window = await run(vi.fn(async () => true));
            expect(window.safeConfirm).toHaveBeenCalledTimes(1);
            expect(window.CloudVault.importAll).not.toHaveBeenCalled();
        });
        it('probe rejects: confirm still asked', async () => {
            const window = await run(vi.fn(async () => { throw new Error('boom'); }));
            expect(window.safeConfirm).toHaveBeenCalledTimes(1);
        });
        it('probe missing/undefined: confirm still asked', async () => {
            const window = await run(vi.fn(async () => undefined));
            expect(window.safeConfirm).toHaveBeenCalledTimes(1);
        });
    });

    // bd med-o7zq.38: a mode-switch pickup onto a side that already has
    // records offers Merge / Replace / Cancel (D1 med-ckm5.5: Merge
    // preselected, Continue); Replace asks the typed REPLACE confirm, like
    // the file Restore above.
    describe('move/leave pickup: Merge / Replace / Cancel', () => {
        const JSON_STR = JSON.stringify(SAMPLE_VAULT);
        async function pickup(source, choice, { content = true, confirm = true } = {}) {
            const { window } = env;
            window.safeChoose = vi.fn(async () => choice);
            window.safeConfirm = vi.fn(async () => confirm);
            window.safeAlert = vi.fn(async () => {});
            window.CloudVault = { exportAll: vi.fn(), importAll: vi.fn(async () => {}), hasUserContent: vi.fn(async () => content) };
            const beforeReload = vi.fn(async () => {});
            const result = await window.SettingsImportExport.restoreVault(JSON_STR, { source, beforeReload });
            return { window, result, beforeReload };
        }

        it('leave: asks the choice with the leave copy', async () => {
            const { window } = await pickup('leave', null);
            expect(window.safeChoose).toHaveBeenCalledTimes(1);
            const [msg, choices, opts] = window.safeChoose.mock.calls[0];
            expect(choices.map((c) => c.value)).toEqual(['merge', 'replace']);
            expect(msg).toMatch(/Your account is not changed/);
            expect(opts.title).toMatch(/^Records already on this /);
        });

        it('move: asks the choice with the move copy', async () => {
            const { window } = await pickup('move', null);
            const [msg, choices, opts] = window.safeChoose.mock.calls[0];
            expect(choices.map((c) => c.value)).toEqual(['merge', 'replace']);
            expect(msg).toMatch(/is not changed/);
            expect(opts.title).toBe('Records already in your account');
        });

        it.each(['move', 'leave'])('%s: merge imports with mode merge and no confirm', async (source) => {
            const { window, result } = await pickup(source, 'merge');
            expect(window.safeConfirm).not.toHaveBeenCalled();
            expect(window.CloudVault.importAll).toHaveBeenCalledWith(JSON_STR, { mode: 'merge' });
            expect(result).toEqual({ imported: true });
        });

        it.each(['move', 'leave'])('%s: replace confirms once, destructive, typed REPLACE, then imports with mode replace', async (source) => {
            const { window } = await pickup(source, 'replace');
            expect(window.safeConfirm).toHaveBeenCalledTimes(1);
            const opts = window.safeConfirm.mock.calls[0][2];
            expect(opts).toMatchObject({ destructive: true, confirmLabel: 'Replace', typedConfirm: 'REPLACE' });
            expect(window.CloudVault.importAll).toHaveBeenCalledWith(JSON_STR, { mode: 'replace' });
        });

        it.each(['move', 'leave'])('%s: replace declined imports nothing', async (source) => {
            const { window, result, beforeReload } = await pickup(source, 'replace', { confirm: false });
            expect(window.CloudVault.importAll).not.toHaveBeenCalled();
            expect(beforeReload).not.toHaveBeenCalled();
            expect(result).toEqual({ imported: false, cancelled: true });
        });

        // bd med-o7zq.42: Cancel = nothing happened, so no dialog follows it.
        it.each(['move', 'leave'])('%s: cancel imports nothing and shows nothing after it', async (source) => {
            const { window, result, beforeReload } = await pickup(source, null);
            expect(window.CloudVault.importAll).not.toHaveBeenCalled();
            expect(beforeReload).not.toHaveBeenCalled();
            expect(result).toEqual({ imported: false, cancelled: true });
            expect(window.safeAlert).not.toHaveBeenCalled();
        });

        it.each(['move', 'leave'])('%s: probe false imports with no dialog', async (source) => {
            const { window, result, beforeReload } = await pickup(source, 'merge', { content: false });
            expect(window.safeChoose).not.toHaveBeenCalled();
            expect(window.safeConfirm).not.toHaveBeenCalled();
            expect(window.CloudVault.importAll).toHaveBeenCalledTimes(1);
            expect(beforeReload).toHaveBeenCalledTimes(1);
            expect(result).toEqual({ imported: true });
        });
    });

    it('export passes includeSecrets:false through to CloudVault', async () => {
        const { window, document } = env;
        document.getElementById('importexport-include-secrets').checked = false;
        window.CloudVault = { exportAll: vi.fn(async () => JSON.stringify(SAMPLE_VAULT)), importAll: vi.fn() };
        window.downloadBlobAsFile = () => {};

        await window.SettingsImportExport.export();

        expect(window.CloudVault.exportAll).toHaveBeenCalledWith({ includeSecrets: false });
    });

    it('export downloads a gzipped medtracker-vault blob from CloudVault.exportAll', async () => {
        const { window, document } = env;
        window.CloudVault = { exportAll: vi.fn(async () => JSON.stringify(SAMPLE_VAULT)), importAll: vi.fn() };
        const downloads = [];
        window.downloadBlobAsFile = (blob, filename) => downloads.push({ blob, filename });

        await window.SettingsImportExport.export();
        // Nothing is written until Save to device on the Backup ready sheet.
        expect(downloads).toHaveLength(0);
        document.getElementById('importexport-ready-save').click();

        expect(window.CloudVault.exportAll).toHaveBeenCalledWith({ includeSecrets: true });
        expect(downloads).toHaveLength(1);
        expect(downloads[0].filename).toMatch(/^medtracker-vault-\d{4}-\d{2}-\d{2}\.json\.gz$/);
        // The blob is a real gzip member that gunzips back to the vault.
        const gz = new Uint8Array(await blobBytes(window, downloads[0].blob));
        expect(window.BackupCrypto.isGzipFile(gz)).toBe(true);
        const parsed = JSON.parse(await window.BackupCrypto.gunzipToString(gz));
        expect(parsed.format).toBe('medtracker-vault');
    });

    // bd med-nvd4: a slow export showed nothing and looked stuck. The status line
    // walks preparing → encrypting, hides for Backup ready, and says "Backup
    // exported" after Save; the button is busy meanwhile, and a failure stays
    // on screen as an error.
    it('encrypted export shows progress, then Backup ready, through the real button', async () => {
        const { window, document } = env;
        let release;
        window.CloudVault = {
            exportAll: vi.fn(() => new Promise((r) => { release = () => r(JSON.stringify(SAMPLE_VAULT)); })),
            importAll: vi.fn(),
        };
        window.BackupCrypto.encryptBackup = vi.fn(async () => new Uint8Array([1, 2, 3]));
        const downloads = [];
        window.downloadBlobAsFile = (blob, filename) => downloads.push(filename);
        const btn = document.getElementById('importexport-export-btn');
        const status = document.getElementById('importexport-export-status');
        const sheet = document.getElementById('importexport-export-sheet');
        const confirm = document.getElementById('importexport-export-confirm');
        expect(status.hidden).toBe(true);

        // Export backup opens the passphrase sheet (kit S7, shot 09); its foot
        // names what it will do.
        btn.click();
        expect(sheet.classList.contains('hidden')).toBe(false);
        expect(confirm.textContent).toBe('Export without encryption');
        const pass = document.getElementById('importexport-export-passphrase');
        pass.value = 'pw';
        pass.dispatchEvent(new window.Event('input'));
        expect(confirm.textContent).toBe('Encrypt and export');
        confirm.click();
        await vi.waitFor(() => expect(window.CloudVault.exportAll).toHaveBeenCalled());
        expect(sheet.classList.contains('hidden')).toBe(true);
        expect(pass.value).toBe('');
        expect(status.hidden).toBe(false);
        expect(status.textContent).toMatch(/Preparing your backup/);
        expect(btn.disabled).toBe(true);
        btn.click(); // re-entry ignored while busy
        release();

        const ready = document.getElementById('importexport-ready-sheet');
        await vi.waitFor(() => expect(ready.classList.contains('hidden')).toBe(false));
        expect(window.BackupCrypto.encryptBackup).toHaveBeenCalledTimes(1);
        expect(window.CloudVault.exportAll).toHaveBeenCalledTimes(1);
        expect(btn.disabled).toBe(false);
        // Nothing saved yet: the page claims no backup until Save or Share.
        expect(status.hidden).toBe(true);
        expect(document.getElementById('importexport-ready-meta').textContent).toBe('1 KB · encrypted with your passphrase');
        document.getElementById('importexport-ready-save').click();
        expect(downloads).toHaveLength(1);
        expect(ready.classList.contains('hidden')).toBe(true);
        expect(status.hidden).toBe(false);
        expect(status.classList.contains('wg-error')).toBe(false);
        expect(status.textContent).toMatch(/^Backup exported: medtracker-vault-.*\.json\.gz\.age/);
    });

    it('dismissing Backup ready saves nothing and says nothing was saved', async () => {
        const { window, document } = env;
        window.CloudVault = { exportAll: vi.fn(async () => JSON.stringify(SAMPLE_VAULT)), importAll: vi.fn(), markBackup: vi.fn() };
        window.downloadBlobAsFile = vi.fn();
        window.localStorage.removeItem('wg.backup.last');
        window.SettingsImportExport.load();
        document.getElementById('importexport-include-secrets').checked = false;

        await window.SettingsImportExport.export();

        const ready = document.getElementById('importexport-ready-sheet');
        expect(ready.classList.contains('hidden')).toBe(false);
        ready.querySelector('[data-sheet-close]').click();
        expect(ready.classList.contains('hidden')).toBe(true);
        expect(window.downloadBlobAsFile).not.toHaveBeenCalled();
        expect(document.getElementById('importexport-export-status').hidden).toBe(true);
        expect(document.getElementById('importexport-last-backup').hidden).toBe(true);
        // Nor does the Today W4 nudge retire (bd med-ta2n.4).
        expect(window.CloudVault.markBackup).not.toHaveBeenCalled();
    });

    // Shot 44: the ready filename wrapped mid-extension. .wg-fname splits it
    // so the stem truncates and ".json.gz.age" stays whole at 390px (jsdom has
    // no layout: pin the split and the kit rule).
    it('Backup ready keeps the extension whole and remembers the save', async () => {
        const { window, document } = env;
        window.CloudVault = { exportAll: vi.fn(async () => JSON.stringify(SAMPLE_VAULT)), importAll: vi.fn(), markBackup: vi.fn(async () => {}) };
        window.BackupCrypto.encryptBackup = vi.fn(async () => new Uint8Array([1, 2, 3]));
        window.downloadBlobAsFile = vi.fn();
        window.localStorage.removeItem('wg.backup.last');
        window.SettingsImportExport.load();
        const last = document.getElementById('importexport-last-backup');
        expect(last.hidden).toBe(true);
        document.getElementById('importexport-export-passphrase').value = 'pw';

        await window.SettingsImportExport.export();

        const stem = document.getElementById('importexport-ready-stem');
        const ext = document.getElementById('importexport-ready-ext');
        expect(stem.textContent).toMatch(/^medtracker-vault-\d{4}-\d{2}-\d{2}$/);
        expect(ext.textContent).toBe('.json.gz.age');
        expect(stem.parentElement.classList.contains('wg-fname')).toBe(true);
        const fs = await import('node:fs');
        const css = fs.readFileSync(new URL('../../css/components.css', import.meta.url), 'utf8');
        expect(css).toMatch(/\.wg-fname\{[^}]*white-space:nowrap/);
        expect(css).toMatch(/\.wg-fname__stem\{[^}]*text-overflow:ellipsis/);
        expect(css).toMatch(/\.wg-fname__ext\{flex-shrink:0\}/);
        // No Web Share with files here: Share stays hidden, Save is the sun.
        expect(document.getElementById('importexport-ready-share').hidden).toBe(true);
        document.getElementById('importexport-ready-save').click();
        expect(window.downloadBlobAsFile).toHaveBeenCalledWith(expect.anything(), `${stem.textContent}.json.gz.age`);
        expect(last.hidden).toBe(false);
        expect(last.textContent).toBe('last today');
        // Save hands the file to a download / native picker that never reports
        // a cancel: no confirmed backup, the W4 nudge only snoozes on
        // wg.backup.last (bd med-ta2n.4).
        await new Promise((r) => setTimeout(r, 0));
        expect(window.CloudVault.markBackup).not.toHaveBeenCalled();
    });

    it('a completed Share retires the W4 nudge; a cancelled Share does not', async () => {
        const { window, document } = env;
        window.CloudVault = { exportAll: vi.fn(async () => JSON.stringify(SAMPLE_VAULT)), importAll: vi.fn(), markBackup: vi.fn(async () => {}) };
        window.downloadBlobAsFile = vi.fn();
        window.localStorage.removeItem('wg.backup.last');
        let outcome = 'abort';
        const share = vi.fn(async () => {
            if (outcome === 'abort') { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; }
        });
        Object.defineProperty(window.navigator, 'share', { value: share, configurable: true });
        Object.defineProperty(window.navigator, 'canShare', { value: () => true, configurable: true });
        window.SettingsImportExport.load();
        document.getElementById('importexport-include-secrets').checked = false;

        await window.SettingsImportExport.export();
        const shareBtn = document.getElementById('importexport-ready-share');
        expect(shareBtn.hidden).toBe(false);
        shareBtn.click();
        await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(1));
        await new Promise((r) => setTimeout(r, 0));
        expect(window.CloudVault.markBackup).not.toHaveBeenCalled();
        expect(document.getElementById('importexport-last-backup').hidden).toBe(true);

        outcome = 'done';
        shareBtn.click();
        await vi.waitFor(() => expect(window.CloudVault.markBackup).toHaveBeenCalledTimes(1));
        expect(window.downloadBlobAsFile).not.toHaveBeenCalled();
    });

    it('export failure stays on screen as an error and frees the button', async () => {
        const { window, document } = env;
        window.CloudVault = { exportAll: vi.fn(async () => JSON.stringify(SAMPLE_VAULT)), importAll: vi.fn() };
        window.BackupCrypto.encryptBackup = vi.fn(async () => { throw new Error('out of memory'); });
        window.downloadBlobAsFile = vi.fn();
        document.getElementById('importexport-export-passphrase').value = 'pw';

        await window.SettingsImportExport.export();

        const status = document.getElementById('importexport-export-status');
        expect(status.hidden).toBe(false);
        expect(status.classList.contains('wg-error')).toBe(true);
        expect(status.textContent).toMatch(/^Export failed: out of memory\. Nothing was saved/);
        expect(window.downloadBlobAsFile).not.toHaveBeenCalled();
        expect(document.getElementById('importexport-export-btn').disabled).toBe(false);
    });

    it('import accepts a gzipped backup file', async () => {
        const { window, document } = env;
        window.CloudVault = { exportAll: vi.fn(), importAll: vi.fn(async () => {}) };

        const gz = await window.BackupCrypto.gzipString(JSON.stringify(SAMPLE_VAULT));
        const input = document.getElementById('importexport-import-file');
        const file = new window.File([gz], 'backup.json.gz', { type: 'application/gzip' });
        Object.defineProperty(input, 'files', { configurable: true, value: [file] });

        await window.SettingsImportExport.import();

        expect(window.CloudVault.importAll).toHaveBeenCalledTimes(1);
        const sent = JSON.parse(window.CloudVault.importAll.mock.calls[0][0]);
        expect(sent.format).toBe('medtracker-vault');
    });

    it('import does nothing when the confirm is declined', async () => {
        const { window, document } = env;
        window.safeConfirm = vi.fn(async () => false);
        window.CloudVault = { exportAll: vi.fn(), importAll: vi.fn(async () => {}) };

        setFile(window, document.getElementById('importexport-import-file'), 'backup.json', JSON.stringify(SAMPLE_VAULT));
        await window.SettingsImportExport.import();

        expect(window.CloudVault.importAll).not.toHaveBeenCalled();
    });

    it('export dispatches to CloudVault.exportAll and never touches apiCall', async () => {
        const { window } = env;
        window.apiCall = vi.fn();
        window.CloudVault = { exportAll: vi.fn(async () => JSON.stringify(SAMPLE_VAULT)), importAll: vi.fn() };
        const downloads = [];
        window.downloadBlobAsFile = (blob, filename) => downloads.push({ blob, filename });

        await window.SettingsImportExport.export();
        env.document.getElementById('importexport-ready-save').click();

        expect(window.CloudVault.exportAll).toHaveBeenCalled();
        expect(window.apiCall).not.toHaveBeenCalled();
        expect(downloads).toHaveLength(1);
    });

    // bd med-o7zq.6: a cloud import not yet on the server says why, and promises
    // a retry only where one happens (sync.js forceSnapshot outcomes).
    it('import says honestly why the backup is not in the account yet', async () => {
        const { window, document } = env;
        window.safeAlert = vi.fn(async () => {});
        const input = document.getElementById('importexport-import-file');
        const shown = {};
        for (const upload of ['synced', 'retrying', 'auth', 'rejected', undefined]) {
            window.safeAlert.mockClear();
            window.CloudVault = { exportAll: vi.fn(), importAll: vi.fn(async () => (upload ? { upload } : undefined)) };
            setFile(window, input, 'backup.json', JSON.stringify(SAMPLE_VAULT));
            await window.SettingsImportExport.import();
            shown[upload] = window.safeAlert.mock.calls.map((c) => c[0]);
        }
        expect(shown.synced).toEqual([]);
        expect(shown.undefined).toEqual([]); // local mode: nothing to upload
        expect(shown.retrying).toHaveLength(1);
        expect(shown.retrying[0]).toMatch(/retries by itself/);
        expect(shown.auth[0]).toMatch(/Sign in again with your passkey/);
        expect(shown.auth[0]).not.toMatch(/retries by itself/);
        expect(shown.rejected[0]).toMatch(/will not finish by itself/);
        expect(shown.rejected[0]).not.toMatch(/retries by itself/);
        for (const msg of [shown.retrying[0], shown.auth[0], shown.rejected[0]]) {
            expect(msg).toMatch(/Keep the backup file/);
        }
    });

    it('import dispatches to CloudVault.importAll and never touches apiCall', async () => {
        const { window, document } = env;
        window.apiCall = vi.fn();
        window.CloudVault = { exportAll: vi.fn(), importAll: vi.fn(async () => {}) };

        setFile(window, document.getElementById('importexport-import-file'), 'backup.json', JSON.stringify(SAMPLE_VAULT));
        await window.SettingsImportExport.import();

        expect(window.CloudVault.importAll).toHaveBeenCalledTimes(1);
        expect(window.CloudVault.importAll).toHaveBeenCalledWith(JSON.stringify(SAMPLE_VAULT));
        expect(window.apiCall).not.toHaveBeenCalled();
    });

    // Mi Band .nxk ingestion — POSTs raw multipart to the Go handler.
    describe('Mi Band .nxk import control', () => {
        it('the group is visible on load', () => {
            expect(env.document.getElementById('importexport-nxk-group').hidden).toBe(false);
        });

        it('POSTs the picked file as multipart to /api/vitals/import', async () => {
            const { window, document } = env;
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
            window.fetch = vi.fn();
            window.safeAlert = vi.fn();

            await window.SettingsImportExport.importNxk();

            expect(window.fetch).not.toHaveBeenCalled();
            expect(window.safeAlert).toHaveBeenCalled();
        });
    });

    // med-0ol.7 — the "Reset local sync" recovery affordance. It rebuilds
    // this device from the server when the sync engine wedges after a failed
    // import. Wired to window.CloudVault.resetLocalSync (dynamic-import
    // wrapper), never a /api route.
    describe('Reset local sync control', () => {
        it('the group is visible on load', () => {
            expect(env.document.getElementById('importexport-reset-sync-group').hidden).toBe(false);
        });

        it('calls CloudVault.resetLocalSync after the confirm, then reloads', async () => {
            const { window } = env;
            window.CloudVault = { resetLocalSync: vi.fn(async () => {}) };

            await window.SettingsImportExport.resetSync();

            expect(window.safeConfirm).toHaveBeenCalled();
            expect(window.CloudVault.resetLocalSync).toHaveBeenCalledTimes(1);
        });

        it('does nothing when the confirm is declined', async () => {
            const { window } = env;
            window.safeConfirm = vi.fn(async () => false);
            window.CloudVault = { resetLocalSync: vi.fn(async () => {}) };

            await window.SettingsImportExport.resetSync();

            expect(window.CloudVault.resetLocalSync).not.toHaveBeenCalled();
        });
    });

    // med-0tp — the un-openable inbox count. Seals for a device key this one
    // does not have stay QUEUED forever for another device; the count surfaces
    // inside the reset group so the escape hatch is reachable from it.
    describe('un-openable inbox note', () => {
        it('lives inside the reset-sync group, next to the escape hatch', () => {
            const note = env.document.getElementById('importexport-inbox-unopenable-note');
            expect(note).not.toBeNull();
            expect(note.closest('#importexport-reset-sync-group')).not.toBeNull();
        });

        it('stays hidden when the vault is not ready', () => {
            // The harness provides no CloudVault; bindControls ran at load.
            const note = env.document.getElementById('importexport-inbox-unopenable-note');
            expect(note.hidden).toBe(true);
            expect(note.textContent).toBe('');
        });

        it('shows the count when seals are stuck', async () => {
            const { window, document } = env;
            window.CloudVault = { getInboxUnopenableCount: vi.fn(async () => 2) };
            window.SettingsImportExport.load();
            const note = document.getElementById('importexport-inbox-unopenable-note');
            await vi.waitFor(() => expect(note.hidden).toBe(false));
            expect(note.textContent).toContain('2 messages could not be opened on this device');
            expect(note.textContent).toContain('sealed to a device key');
            expect(window.CloudVault.getInboxUnopenableCount).toHaveBeenCalled();
        });

        it('uses the singular for one stuck message', async () => {
            const { window, document } = env;
            window.CloudVault = { getInboxUnopenableCount: vi.fn(async () => 1) };
            window.SettingsImportExport.load();
            const note = document.getElementById('importexport-inbox-unopenable-note');
            await vi.waitFor(() => expect(note.hidden).toBe(false));
            expect(note.textContent).toContain('1 message could not be opened on this device');
            expect(note.textContent).toContain('sealed to a device key');
        });

        it('stays hidden when the count is 0', async () => {
            const { window, document } = env;
            window.CloudVault = { getInboxUnopenableCount: vi.fn(async () => 0) };
            await window.SettingsImportExport.refreshUnopenableNote();
            const note = document.getElementById('importexport-inbox-unopenable-note');
            expect(note.hidden).toBe(true);
        });

        it('stays hidden when the getter rejects', async () => {
            const { window, document } = env;
            window.CloudVault = { getInboxUnopenableCount: vi.fn(async () => { throw new Error('vault locked'); }) };
            await window.SettingsImportExport.refreshUnopenableNote();
            const note = document.getElementById('importexport-inbox-unopenable-note');
            expect(note.hidden).toBe(true);
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

        // bd med-nt9p.32.20: the guard stays held from the replace through
        // beforeReload to the reload, so a manual Restore can't start there.
        it('restoreVault holds the guard through beforeReload: a Restore click then is ignored', async () => {
            const { window, document } = env;
            const d = deferred();
            window.CloudVault = { exportAll: vi.fn(), importAll: vi.fn(async () => {}), hasUserContent: vi.fn(async () => false) };
            const entered = vi.fn();
            const restoring = window.SettingsImportExport.restoreVault(JSON.stringify(SAMPLE_VAULT), {
                source: 'leave',
                beforeReload: () => { entered(); return d.promise; },
            });
            await vi.waitFor(() => expect(entered).toHaveBeenCalled());

            setFile(window, document.getElementById('importexport-import-file'), 'backup.json', JSON.stringify(SAMPLE_VAULT));
            await window.SettingsImportExport.import();
            expect(window.CloudVault.importAll).toHaveBeenCalledTimes(1);

            d.resolve();
            expect(await restoring).toEqual({ imported: true });
        });
    });
});
