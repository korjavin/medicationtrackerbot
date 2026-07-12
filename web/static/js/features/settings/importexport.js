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

    // Import lifecycle state (med-0ol.1/.4). A .nxk / full-vault import runs for a
    // while; without feedback the user assumes it failed and clicks again (double
    // submit), and closing the tab mid-upload leaves a partial import. One flag
    // guards re-entry, drives a busy label + spinner, and arms a beforeunload
    // prompt for the duration — cleared the moment the import finishes or errors
    // so no navigation nag lingers.
    let importInFlight = false;

    function beforeUnloadGuard(e) {
        // Native "Leave site?" confirmation — both forms are needed across browsers.
        e.preventDefault();
        e.returnValue = '';
        return '';
    }

    // Toggle the import busy state: disable the button, show/clear the inline
    // progress note, and arm/disarm the unload guard. Class + textContent + hidden
    // only — no inline styles or colors (design-token guards).
    function setImportBusy(on, message) {
        importInFlight = on;
        // Both import buttons: a busy .nxk import must also block the vault
        // import (and vice versa) — they share the destination vault.
        for (const id of ['importexport-import-btn', 'importexport-nxk-btn']) {
            const btn = el(id);
            if (btn) btn.disabled = on;
        }
        const note = el('importexport-import-progress');
        if (note) {
            note.hidden = !on;
            if (on) note.textContent = message || 'Importing… keep this page open until it finishes.';
        }
        if (on) {
            window.addEventListener('beforeunload', beforeUnloadGuard);
        } else {
            window.removeEventListener('beforeunload', beforeUnloadGuard);
        }
    }

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
        // ponytail: no indent — the file is gzipped anyway, and a real vault is
        // hundreds of MB, so pretty-printing only doubles the string we hold in
        // memory. `gunzip -c … | jq` is the human-readable path.
        return JSON.stringify(vault);
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
            // gzip first: age ciphertext doesn't compress, and the plain file is
            // hundreds of MB. See core/backup-crypto.js.
            const gz = await window.BackupCrypto.gzipString(json);
            if (passphrase) {
                const bytes = await window.BackupCrypto.encryptBackup(gz, passphrase);
                downloadBlobAsFile(new Blob([bytes], { type: 'application/octet-stream' }), `${base}.json.gz.age`);
            } else {
                downloadBlobAsFile(new Blob([gz], { type: 'application/gzip' }), `${base}.json.gz`);
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

    // Matches http.MaxBytesReader in internal/server/vault_import.go — reject
    // client-side rather than materializing the file only to get a 400. The
    // upload is gzipped, so 64MB here is ~1GB of vault JSON. Only a pre-
    // compression plain .json backup is measured uncompressed.
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
        // Ignore a second click while an import is already running (med-0ol.1).
        if (importInFlight) return;
        const file = el('importexport-import-file')?.files?.[0];
        if (!file) {
            safeAlert('Choose a backup file first');
            return;
        }
        if (file.size > MAX_BACKUP_BYTES) {
            safeAlert('Backup too large (max 64 MB)');
            return;
        }

        // Claim the shared re-entry guard BEFORE the first await. Reading +
        // decrypting a 64 MB file and awaiting the confirm dialog are slow async
        // steps; without claiming here a reset / .nxk / second-import click during
        // that window would pass its own `importInFlight` check and interleave
        // against the same vault. Release on every early-return below; the
        // confirmed path hands off to setImportBusy(true) which keeps it set.
        importInFlight = true;

        let bytes;
        try {
            bytes = await readFileBytes(file);
        } catch (e) {
            importInFlight = false;
            safeAlert(e.message || 'Failed to read file');
            return;
        }

        // Unwrap to the vault JSON string. Four shapes, sniffed by magic bytes so
        // a renamed file still works: .json, .json.gz, .json.age, .json.gz.age
        // (the two non-gz forms are pre-compression backups).
        let json;
        try {
            if (window.BackupCrypto.isAgeFile(bytes)) {
                const passphrase = el('importexport-import-passphrase')?.value || '';
                if (!passphrase) { importInFlight = false; safeAlert('This backup is encrypted — enter its passphrase'); return; }
                bytes = await window.BackupCrypto.decryptBackup(bytes, passphrase);
            }
            json = window.BackupCrypto.isGzipFile(bytes)
                ? await window.BackupCrypto.gunzipToString(bytes)
                : await window.BackupCrypto.bytesToString(bytes);
        } catch (e) {
            importInFlight = false;
            console.error('Import decrypt failed:', e);
            safeAlert('Could not read backup — wrong passphrase?');
            return;
        }

        const confirmed = await safeConfirm(
            'Import replaces ALL your current data with this backup. This cannot be undone. Continue?'
        );
        if (!confirmed) { importInFlight = false; return; }

        setImportBusy(true);
        try {
            if (isCloud()) {
                await window.CloudVault.importAll(json);
                // Clear busy BEFORE reload — otherwise beforeUnloadGuard would
                // prompt on our own intended navigation.
                setImportBusy(false);
                // Full refresh so every section re-renders from the restored vault
                // (simplest correct path — same as post-bootstrap reload).
                location.reload();
                return;
            }
            const vault = JSON.parse(json);
            // gzip the upload: a full vault's JSON exceeds the 64MB body cap
            // (http.MaxBytesReader), so an uncompressed POST can't restore a real
            // backup at all. The handler gunzips on Content-Encoding.
            const body = await window.BackupCrypto.gzipString(
                JSON.stringify({ ...vault, mode: 'replace' }));
            const res = await apiCall('/api/import', 'POST', body,
                { timeoutMs: 10 * 60_000, headers: { 'Content-Encoding': 'gzip' } });
            if (!res) { setImportBusy(false); return; } // apiCall already surfaced the error
            setImportBusy(false);
            safeAlert('Import complete.');
            location.reload();
        } catch (e) {
            console.error('Import failed:', e);
            setImportBusy(false);
            safeAlert(e.message || 'Import failed');
        }
    }

    function toast(message, type) {
        if (window.SyncManager && typeof window.SyncManager.showToast === 'function') {
            window.SyncManager.showToast(message, type || 'info');
        } else {
            safeAlert(message);
        }
    }

    // Mi Band .nxk ingestion (cloud only). Unlike the vault import/export above,
    // this POSTs the raw backup straight to the Go handler, which parses it
    // server-side and seals the vitals to the account inbox — the browser can't
    // parse SQLite. Same-origin fetch carries the session cookie.
    async function doNxkImport() {
        // Ignore a second click while an import is already uploading (med-0ol.1).
        if (importInFlight) return;
        const file = el('importexport-nxk-file')?.files?.[0];
        if (!file) { safeAlert('Choose a .nxk backup first'); return; }
        // Busy state + unload guard for the upload leg (med-0ol.1/.4); the
        // server-side parse + inbox drain finish in the background afterward.
        setImportBusy(true, 'Uploading Mi Band backup… keep this page open.');
        try {
            const form = new FormData();
            form.append('file', file, file.name);
            const res = await fetch('/api/vitals/import', { method: 'POST', body: form });
            if (res.status === 412) {
                toast('Publish an inbox key first (unlock this device), then retry.', 'error');
                return;
            }
            if (!res.ok) {
                toast('Import failed — is this a Mi Band .nxk backup?', 'error');
                return;
            }
            const body = await res.json().catch(() => ({}));
            const n = body && typeof body.queued === 'number' ? body.queued : 0;
            toast(`Mi Band data queued (${n}) — it will appear in Vitals shortly.`, 'success');
        } catch (e) {
            console.error('NXK import failed:', e);
            toast('Import failed — check your connection and try again.', 'error');
        } finally {
            setImportBusy(false);
        }
    }

    // Reset local sync (cloud only, med-0ol.7). Escape hatch when the sync engine
    // wedges (repeated permanent write errors after a failed import): clears the
    // local IDB mirror + pending + sync meta and re-bootstraps this device from
    // the server's compacted snapshot. Shares the import re-entry guard so it can't
    // collide with an in-flight import (both mutate the same vault).
    async function doResetSync() {
        if (importInFlight) return;
        // Claim the shared re-entry guard BEFORE the confirm await, mirroring
        // doImport: safeConfirm is async (and non-blocking on the messenger-native
        // path), so without claiming here an import click during the confirm window
        // would pass its own importInFlight check and interleave against the same
        // vault. Release on the not-confirmed path; the confirmed path hands off to
        // setImportBusy(true) which keeps it set.
        importInFlight = true;
        const confirmed = await safeConfirm(
            'Reset local sync rebuilds this device from the server and discards any unsynced local changes. Continue?'
        );
        if (!confirmed) { importInFlight = false; return; }
        setImportBusy(true, 'Resetting local sync… keep this page open until it finishes.');
        try {
            await window.CloudVault.resetLocalSync();
            // Clear busy BEFORE reload so beforeUnloadGuard doesn't prompt on our
            // own intended navigation.
            setImportBusy(false);
            location.reload();
        } catch (e) {
            console.error('Reset local sync failed:', e);
            setImportBusy(false);
            safeAlert(e.message || 'Reset failed');
        }
    }

    function bindControls() {
        // The .nxk endpoint only exists on cmd/cloud; reveal the control there.
        const nxkGroup = el('importexport-nxk-group');
        if (nxkGroup) nxkGroup.hidden = !isCloud();
        const nxkBtn = el('importexport-nxk-btn');
        if (nxkBtn && !nxkBtn.dataset.bound) {
            nxkBtn.dataset.bound = '1';
            nxkBtn.addEventListener('click', () => { doNxkImport(); });
        }

        // Reset local sync — cloud only (rebuilds the device from the server).
        const resetGroup = el('importexport-reset-sync-group');
        if (resetGroup) resetGroup.hidden = !isCloud();
        const resetBtn = el('importexport-reset-sync-btn');
        if (resetBtn && !resetBtn.dataset.bound) {
            resetBtn.dataset.bound = '1';
            resetBtn.addEventListener('click', () => { doResetSync(); });
        }

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
        import: doImport,
        importNxk: doNxkImport,
        resetSync: doResetSync
    };
})();
