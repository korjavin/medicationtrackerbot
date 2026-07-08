// features/settings/importexport.js — Settings → Import/Export section (C2e
// Task 6). One shared screen serves both runtimes:
//
//   - Bot mode: export = GET /api/export, import = POST /api/import.
//   - Cloud mode (window.__MEDTRACKER_CLOUD__): fully client-side against the
//     unlocked vault via window.CloudVault.{exportAll,importAll} — zero-knowledge
//     forbids the plaintext ever reaching the server, so /api/export|/api/import
//     are NEVER fetched here.
//
// Optional passphrase encryption runs browser-side in BOTH modes via
// window.BackupCrypto (vendored age/typage). Empty passphrase is allowed but
// nudges the user because the backup carries their provider API keys.
//
// Import is replace-only and destructive: the user confirms, then the whole
// dataset is wiped and re-inserted. Cloud import forces one snapshot upload
// (inside CloudVault.importAll) and we reload so every section re-renders.
(function () {
    'use strict';

    function el(id) { return document.getElementById(id); }

    function isCloud() { return !!window.__MEDTRACKER_CLOUD__; }

    // Build the vault JSON string for the current mode. includeSecrets=false drops
    // settings.integrations + api_tokens (absent, not blank — the importer reads
    // absence as "leave the destination's secrets alone").
    async function readVaultJSON(includeSecrets) {
        if (isCloud()) {
            if (!window.CloudVault || typeof window.CloudVault.exportAll !== 'function') {
                throw new Error('Vault not ready — unlock first');
            }
            return await window.CloudVault.exportAll({ includeSecrets });
        }
        // A full vault is every domain over all history; the default 60s
        // apiCall timeout aborts long exports mid-download. Matches the
        // server's vaultIOTimeout.
        const vault = await apiCall(`/api/export?include_secrets=${includeSecrets ? '1' : '0'}`,
            'GET', null, { timeoutMs: 10 * 60_000 });
        if (!vault) throw new Error('Export failed');
        return JSON.stringify(vault, null, 2);
    }

    function todayStamp() {
        // YYYY-MM-DD in local time — matches the bot handler's filename shape.
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    async function doExport() {
        const passInput = el('importexport-export-passphrase');
        const passphrase = passInput ? passInput.value : '';
        const secretsBox = el('importexport-include-secrets');
        const includeSecrets = secretsBox ? secretsBox.checked : true;
        const nudge = el('importexport-passphrase-nudge');
        // Shown only when exporting secrets unencrypted.
        if (nudge) nudge.hidden = !!passphrase || !includeSecrets;
        // include_secrets defaults to on, so without this gate the user's first
        // sight of the nudge is *after* their provider API keys and live API
        // tokens have already landed in ~/Downloads in plain text.
        if (includeSecrets && !passphrase) {
            const ok = await safeConfirm(
                'This backup will contain your provider API keys and access tokens in plain text. Download anyway?'
            );
            if (!ok) return;
        }

        let json;
        try {
            json = await readVaultJSON(includeSecrets);
        } catch (e) {
            console.error('Export failed:', e);
            safeAlert(e.message || 'Export failed');
            return;
        }

        const base = `medtracker-vault-${todayStamp()}`;
        try {
            if (passphrase) {
                const bytes = await window.BackupCrypto.encryptBackup(json, passphrase);
                downloadBlobAsFile(new Blob([bytes], { type: 'application/octet-stream' }), `${base}.json.age`);
            } else {
                downloadBlobAsFile(new Blob([json], { type: 'application/json' }), `${base}.json`);
            }
        } catch (e) {
            console.error('Export encryption failed:', e);
            safeAlert(e.message || 'Export failed');
        }
    }

    function readFileBytes(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(new Uint8Array(reader.result));
            reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
            reader.readAsArrayBuffer(file);
        });
    }

    function readFileText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
            reader.readAsText(file);
        });
    }

    // Matches http.MaxBytesReader in internal/server/vault_import.go — reject
    // client-side rather than materializing the file only to get a 400.
    const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

    // Reveal the decrypt-passphrase field iff the picked file is an age file.
    // Only the 21-byte magic is read — the file itself can be hundreds of MB.
    async function onFileChange() {
        const field = el('importexport-import-passphrase-field');
        const file = el('importexport-import-file')?.files?.[0];
        if (!field) return;
        if (!file) { field.hidden = true; return; }
        try {
            const head = await readFileBytes(file.slice(0, 21));
            field.hidden = !window.BackupCrypto.isAgeFile(head);
        } catch (_) {
            field.hidden = true;
        }
    }

    async function doImport() {
        const file = el('importexport-import-file')?.files?.[0];
        if (!file) {
            safeAlert('Choose a backup file first');
            return;
        }
        if (file.size > MAX_BACKUP_BYTES) {
            safeAlert('Backup too large (max 64 MB)');
            return;
        }

        let bytes;
        try {
            bytes = await readFileBytes(file);
        } catch (e) {
            safeAlert(e.message || 'Failed to read file');
            return;
        }

        // Decrypt (age) or decode (plaintext) to the vault JSON string.
        let json;
        try {
            if (window.BackupCrypto.isAgeFile(bytes)) {
                const passphrase = el('importexport-import-passphrase')?.value || '';
                if (!passphrase) { safeAlert('This backup is encrypted — enter its passphrase'); return; }
                json = await window.BackupCrypto.decryptBackup(bytes, passphrase);
            } else {
                json = await readFileText(file);
            }
        } catch (e) {
            console.error('Import decrypt failed:', e);
            safeAlert('Could not read backup — wrong passphrase?');
            return;
        }

        const confirmed = await safeConfirm(
            'Import replaces ALL your current data with this backup. This cannot be undone. Continue?'
        );
        if (!confirmed) return;

        try {
            if (isCloud()) {
                await window.CloudVault.importAll(json);
                // Full refresh so every section re-renders from the restored vault
                // (simplest correct path — same as post-bootstrap reload).
                location.reload();
                return;
            }
            const vault = JSON.parse(json);
            const res = await apiCall('/api/import', 'POST', { ...vault, mode: 'replace' },
                { timeoutMs: 10 * 60_000 });
            if (!res) return; // apiCall already surfaced the error
            safeAlert('Import complete.');
            location.reload();
        } catch (e) {
            console.error('Import failed:', e);
            safeAlert(e.message || 'Import failed');
        }
    }

    function bindControls() {
        const exportBtn = el('importexport-export-btn');
        if (exportBtn && !exportBtn.dataset.bound) {
            exportBtn.dataset.bound = '1';
            exportBtn.addEventListener('click', () => { doExport(); });
        }
        const importBtn = el('importexport-import-btn');
        if (importBtn && !importBtn.dataset.bound) {
            importBtn.dataset.bound = '1';
            importBtn.addEventListener('click', () => { doImport(); });
        }
        const fileInput = el('importexport-import-file');
        if (fileInput && !fileInput.dataset.bound) {
            fileInput.dataset.bound = '1';
            fileInput.addEventListener('change', () => { onFileChange(); });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindControls);
    } else {
        bindControls();
    }

    // load() is a no-op hook mirroring SettingsIntegrations.load — the section is
    // static (no server prefill), so loadSettings() only needs to (re)bind.
    window.SettingsImportExport = {
        load: () => { bindControls(); },
        export: doExport,
        import: doImport
    };
})();
