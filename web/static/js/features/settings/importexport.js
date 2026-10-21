// features/settings/importexport.js — Settings → Import/Export section (C2e
// Task 6). Fully client-side against the unlocked vault via
// window.CloudVault.{exportAll,importAll} — zero-knowledge forbids the
// plaintext ever reaching the server, so no /api export/import route is
// ever fetched here.
//
// Optional passphrase encryption runs browser-side via window.BackupCrypto
// (vendored age/typage). Empty passphrase is allowed but nudges the user
// because the backup carries their provider API keys.
//
// Import is replace-only and destructive: the user confirms, then the whole
// dataset is wiped and re-inserted. Cloud import forces one snapshot upload
// (inside CloudVault.importAll) and we reload so every section re-renders.
(function () {
    'use strict';

    function el(id) { return document.getElementById(id); }

    // Import lifecycle state (med-0ol.1/.4). A .nxk / full-vault import runs for a
    // while; without feedback the user assumes it failed and clicks again (double
    // submit), and closing the tab mid-upload leaves a partial import. One flag
    // guards re-entry, drives a busy label + spinner, and arms a beforeunload
    // prompt for the duration — cleared the moment the import finishes or errors
    // so no navigation nag lingers.
    let importInFlight = false;

    // The word the typed confirm asks for before a replace-import (D1).
    const REPLACE_PHRASE = 'REPLACE';

    // Why a cloud import is not on the server yet (CloudVault.importAll's
    // `upload`, sync.js forceSnapshot). 'synced' and the local vault (no
    // upload) say nothing.
    const NOT_UPLOADED = {
        retrying: 'The upload retries by itself the next time you open the app while online.',
        auth: 'Your sign-in has expired, so the upload is paused. Sign in again with your passkey and it resumes.',
        rejected: 'The server refused it: the backup is too large for your account or the account is over its storage limit. It will not finish by itself. Free up space or ask the operator, then restore the file again.',
    };

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
        if (!window.CloudVault || typeof window.CloudVault.exportAll !== 'function') {
            throw new Error('Vault not ready — unlock first');
        }
        return await window.CloudVault.exportAll({ includeSecrets });
    }

    function todayStamp() {
        // YYYY-MM-DD in local time — matches the bot handler's filename shape.
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    // Export progress (bd med-nvd4). A big vault takes a while to read, gzip and
    // (with a passphrase) run age's scrypt — on a phone that is many seconds
    // with nothing on screen, so the export looked stuck. One status line says
    // which phase is running, or the error. It hides when Backup ready opens and
    // says "Backup exported" only after Save or Share. Class + textContent +
    // hidden only (design-token guards).
    let exportInFlight = false;

    function setExportStatus(text, isError) {
        const note = el('importexport-export-status');
        if (!note) return;
        note.hidden = false;
        note.textContent = text;
        note.className = isError ? 'wg-error' : 'wg-hint';
    }

    // Let the status line paint before a step that holds the main thread
    // (JSON.stringify of the whole vault, age's synchronous scrypt).
    function yieldToPaint() {
        return new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Kit sheets over the Backup page (S7, bd med-ckm5.7): the passphrase is
    // typed in a sheet docked on the keyboard, never in a field on the page,
    // so iOS has no page to pan and Settings home can't show behind it (shot
    // 09). One sheet at a time. openSheet(id) resolves what closeSheet(value)
    // passes; the X, the backdrop, Back and Esc resolve null.
    let closeSheet = null;

    function openSheet(id) {
        if (closeSheet) closeSheet(null);
        const backdrop = el('importexport-sheet-backdrop');
        return new Promise((resolve) => {
            closeSheet = (value) => {
                closeSheet = null;
                window.ModalManager.register(id, null);
                window.ModalManager.close(id);
                if (backdrop) backdrop.hidden = true;
                resolve(value);
            };
            if (backdrop) backdrop.hidden = false;
            window.ModalManager.register(id, () => { if (closeSheet) closeSheet(null); });
            window.ModalManager.open(id, { overlay: false });
        });
    }

    // Export backup → the passphrase sheet. Its foot names what happens: an
    // empty passphrase writes an unencrypted file (doExport's confirm still
    // guards API keys in clear).
    async function openExportSheet() {
        if (exportInFlight) return;
        const pass = el('importexport-export-passphrase');
        paintExportConfirm();
        const go = openSheet('importexport-export-sheet');
        try { pass?.focus(); } catch (_) { /* ignore */ }
        if (await go) await doExport();
        else if (pass) pass.value = ''; // closed: nothing typed lingers
    }

    // Live as the user types: the foot label, and the nudge only when API keys
    // would go out unencrypted.
    function paintExportConfirm() {
        const btn = el('importexport-export-confirm');
        const pass = el('importexport-export-passphrase');
        const secrets = el('importexport-include-secrets');
        const nudge = el('importexport-passphrase-nudge');
        const has = !!(pass && pass.value);
        if (btn) btn.textContent = has ? 'Encrypt and export' : 'Export without encryption';
        if (nudge) nudge.hidden = has || !(secrets && secrets.checked);
    }

    // "last N days ago" in the Back up head: when a backup last left this
    // device through Save or Share. Per-device browser storage, no record
    // content; missing or blocked storage just hides the line.
    const LAST_BACKUP_KEY = 'wg.backup.last';

    function paintLastBackup() {
        const meta = el('importexport-last-backup');
        if (!meta) return;
        let at = 0;
        try { at = Number(window.localStorage.getItem(LAST_BACKUP_KEY)) || 0; } catch (_) { /* hidden */ }
        meta.hidden = !at;
        if (!at) return;
        const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86400000);
        meta.textContent = days <= 0 ? 'last today' : days === 1 ? 'last yesterday' : `last ${days} days ago`;
    }

    // The file left the device (Save or Share): only now is there a backup.
    // Local mode also retires the Today W4 nudge here (CloudVault.markBackup,
    // bd med-ta2n.4); the cloud vault has none.
    function stampLastBackup(name) {
        try { window.localStorage.setItem(LAST_BACKUP_KEY, String(Date.now())); } catch (_) { /* not remembered */ }
        if (window.CloudVault && typeof window.CloudVault.markBackup === 'function') {
            Promise.resolve().then(() => window.CloudVault.markBackup()).catch((e) => console.warn('[backup] could not record the backup', e));
        }
        paintLastBackup();
        setExportStatus(`Backup exported: ${name}. Keep it somewhere safe.`);
    }

    // The ready file: name split into stem + extension (.wg-fname) so a narrow
    // screen truncates the stem and ".json.gz.age" never breaks (shot 44).
    let readyFile = null;

    function splitFileName(name) {
        const i = name.indexOf('.json');
        return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
    }

    function canShareFile(file) {
        try {
            return typeof navigator.share === 'function' && typeof navigator.canShare === 'function'
                && navigator.canShare({ files: [file] });
        } catch (_) { return false; }
    }

    // Backup ready (kit S7): Save to device (sun) is the existing download path
    // (the native shells hand it to their Save / Share flow); Share is the Web
    // Share sheet, shown only where it can take a file.
    function showReady(blob, name, encrypted) {
        readyFile = { blob, name };
        const [stem, ext] = splitFileName(name);
        el('importexport-ready-stem').textContent = stem;
        el('importexport-ready-ext').textContent = ext;
        el('importexport-ready-meta').textContent = `${formatFileSize(blob.size)} · ${encrypted ? 'encrypted with your passphrase' : 'not encrypted'}`;
        let file = null;
        try { file = new File([blob], name, { type: blob.type }); } catch (_) { /* no File: no Share */ }
        el('importexport-ready-share').hidden = !(file && canShareFile(file));
        readyFile.file = file;
        const ready = readyFile;
        // The blob can be hundreds of MB: let it go with the sheet.
        openSheet('importexport-ready-sheet').then(() => { if (readyFile === ready) readyFile = null; });
    }

    function saveReady() {
        if (!readyFile) return;
        downloadBlobAsFile(readyFile.blob, readyFile.name);
        stampLastBackup(readyFile.name);
        if (closeSheet) closeSheet(true);
    }

    async function shareReady() {
        if (!readyFile || !readyFile.file) return;
        try {
            await navigator.share({ files: [readyFile.file], title: readyFile.name });
            stampLastBackup(readyFile.name);
            if (closeSheet) closeSheet(true);
        } catch (e) {
            // Dismissing the OS sheet is not an error.
            if (e && e.name === 'AbortError') return;
            safeToast("Couldn't share the file. Save it to the device instead.", 'error');
        }
    }

    async function doExport() {
        if (exportInFlight) return;
        const passInput = el('importexport-export-passphrase');
        const passphrase = passInput ? passInput.value : '';
        // Never kept on the page once read.
        if (passInput) passInput.value = '';
        const secretsBox = el('importexport-include-secrets');
        const includeSecrets = secretsBox ? secretsBox.checked : true;
        // include_secrets defaults to on, so without this gate the user's first
        // sight of the nudge is *after* their provider API keys and live API
        // tokens have already landed in ~/Downloads in plain text.
        if (includeSecrets && !passphrase) {
            const ok = await safeConfirm(
                'This backup will contain your provider API keys and access tokens in plain text. Export anyway?'
            );
            if (!ok) return;
        }

        exportInFlight = true;
        const btn = el('importexport-export-btn');
        if (btn) btn.disabled = true;
        const name = `medtracker-vault-${todayStamp()}.json.gz${passphrase ? '.age' : ''}`;
        try {
            setExportStatus('Preparing your backup… reading your data.');
            await yieldToPaint();
            const json = await readVaultJSON(includeSecrets);
            setExportStatus('Preparing your backup… compressing.');
            await yieldToPaint();
            // gzip first: age ciphertext doesn't compress, and the plain file is
            // hundreds of MB. See core/backup-crypto.js.
            const gz = await window.BackupCrypto.gzipString(json);
            let blob;
            if (passphrase) {
                setExportStatus('Encrypting your backup… this can take a minute on a phone.');
                await yieldToPaint();
                const bytes = await window.BackupCrypto.encryptBackup(gz, passphrase);
                blob = new Blob([bytes], { type: 'application/octet-stream' });
            } else {
                blob = new Blob([gz], { type: 'application/gzip' });
            }
            // Nothing is saved until Save or Share on Backup ready.
            const note = el('importexport-export-status');
            if (note) note.hidden = true;
            showReady(blob, name, !!passphrase);
        } catch (e) {
            console.error('Export failed:', e);
            setExportStatus(`Export failed: ${(e && e.message) || 'unknown error'}. Nothing was saved — try again.`, true);
        } finally {
            exportInFlight = false;
            if (btn) btn.disabled = false;
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

    // Say "encrypted" on the picker iff the picked file is an age file (Restore
    // then asks its passphrase in a sheet). Only the 21-byte magic is read —
    // the file itself can be hundreds of MB.
    async function onFileChange() {
        const file = el('importexport-import-file')?.files?.[0];
        if (!file) return;
        // Resolve before the await: the view may be torn down by the time it lands.
        const meta = document.querySelector('[data-file-input="importexport-import-file"] .wg-file__meta');
        let age = false;
        try { age = window.BackupCrypto.isAgeFile(await readFileBytes(file.slice(0, 21))); } catch (_) { /* not age */ }
        if (meta && age) meta.textContent = `${formatFileSize(file.size)} · encrypted`;
    }

    // The import passphrase sheet: resolves the typed passphrase, or null when
    // it is closed. An empty Decrypt keeps it open.
    async function askImportPassphrase() {
        const pass = el('importexport-import-passphrase');
        if (pass) pass.value = '';
        const go = openSheet('importexport-import-sheet');
        try { pass?.focus(); } catch (_) { /* ignore */ }
        const ok = await go;
        const value = ok && pass ? pass.value : '';
        if (pass) pass.value = '';
        return value || null;
    }

    function submitImportPassphrase() {
        if (el('importexport-import-passphrase')?.value && closeSheet) closeSheet(true);
    }

    function formatFileSize(bytes) {
        if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    }

    // .wg-file picker (kit S3) over a hidden <input type="file">: Choose opens
    // the OS picker, the filled state shows name + size, × clears the pick.
    // The input stays the source of truth — import reads input.files.
    function paintFilePicker(picker, input) {
        const file = input.files && input.files[0];
        picker.classList.toggle('wg-file--filled', !!file);
        picker.querySelector('.wg-file__name').textContent = file ? file.name : picker.dataset.emptyName;
        picker.querySelector('.wg-file__meta').textContent = file ? formatFileSize(file.size) : picker.dataset.emptyMeta;
        picker.querySelector('[data-file-choose]').hidden = !!file;
        picker.querySelector('[data-file-clear]').hidden = !file;
    }

    function bindFilePicker(picker) {
        const input = el(picker.dataset.fileInput);
        if (!input || picker.dataset.bound) return;
        picker.dataset.bound = '1';
        picker.querySelector('[data-file-choose]').addEventListener('click', () => input.click());
        picker.querySelector('[data-file-clear]').addEventListener('click', () => {
            input.value = '';
            input.dispatchEvent(new Event('change'));
        });
        // Paint first so onFileChange's "encrypted" meta lands on top of it.
        input.addEventListener('change', () => paintFilePicker(picker, input));
    }

    async function doImport() {
        // Ignore a second click while an import is already running (med-0ol.1).
        if (importInFlight) return;
        const file = el('importexport-import-file')?.files?.[0];
        if (!file) {
            safeToast('Choose a backup file first', 'info');
            return;
        }
        if (file.size > MAX_BACKUP_BYTES) {
            safeToast('Backup too large (max 64 MB)', 'info');
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
            safeToast(e.message || 'Failed to read file', 'error');
            return;
        }

        // Unwrap to the vault JSON string. Four shapes, sniffed by magic bytes so
        // a renamed file still works: .json, .json.gz, .json.age, .json.gz.age
        // (the two non-gz forms are pre-compression backups).
        let json;
        try {
            if (window.BackupCrypto.isAgeFile(bytes)) {
                const passphrase = await askImportPassphrase();
                if (!passphrase) { importInFlight = false; return; }
                bytes = await window.BackupCrypto.decryptBackup(bytes, passphrase);
            }
            json = window.BackupCrypto.isGzipFile(bytes)
                ? await window.BackupCrypto.gunzipToString(bytes)
                : await window.BackupCrypto.bytesToString(bytes);
        } catch (e) {
            importInFlight = false;
            console.error('Import decrypt failed:', e);
            safeToast('Could not read backup — wrong passphrase?', 'error');
            return;
        }

        await runRestore(json);
    }

    // The one restore pipeline (bd med-nt9p.32.18): the Restore button above
    // and the local → cloud move pickup (web/cloud/js/cloud-boot.js) both call
    // it, and the account → local move may too.
    //
    //   restoreVault(json, { source = 'file', beforeReload } = {})
    //     → Promise<{ imported: boolean }>   (cancel and failure resolve, not reject)
    //
    // `json` is the vault v1 JSON string. `source` picks the copy: 'move'
    // (the shell's move stash) and 'leave' (local-policy.js pickupLeaveStash,
    // the account → local stash) have their own; anything else ('file', the
    // Restore button) gets the backup-file copy. Unless the receiving side is
    // provably empty, a file asks the typed replace confirm and a move/leave
    // asks Merge / Replace / Cancel; then CloudVault.importAll(json, { mode }), says when it is not uploaded yet, then awaits
    // `beforeReload` (optional async hook; a throw is logged and the reload
    // still happens, the import already did) and reloads the page.
    // { imported: true } = replaced and reloading. { imported: false,
    // cancelled: true } = the user cancelled: nothing shown after, nothing
    // replaced. { imported: false } = the import failed (already told the
    // user) or another import / reset already runs (importInFlight; nothing
    // shown). Neither replaced anything or called beforeReload.
    function restoreVault(json, opts) {
        if (importInFlight) return Promise.resolve({ imported: false });
        return runRestore(json, opts);
    }

    // restoreVault's body; doImport enters here already holding importInFlight.
    async function runRestore(json, { source = 'file', beforeReload } = {}) {
        const move = source === 'move';
        const leave = source === 'leave';
        const device = window.LocalNotifications?.copy?.device || 'iPhone';
        importInFlight = true;
        // Typed confirm (kit S3): the confirm button stays disabled until the
        // phrase matches, so a stray tap can't wipe the vault.
        // Nothing to replace (probe says exactly `false`) → no confirm. Any other
        // outcome (true, missing probe, throw) keeps the confirm: fail closed.
        let empty = false;
        try { empty = (await window.CloudVault.hasUserContent?.()) === false; } catch { /* fail closed */ }
        const local = document.documentElement.classList.contains('wg-local-vault');
        // Mode-switch pickups (bd med-o7zq.38) with records on the receiving
        // side: Merge / Replace / Cancel. Replace and a file Restore both ask
        // the typed REPLACE confirm.
        let mode;
        let confirmed = empty;
        // D1 (med-ckm5.5): Merge is preselected and Continue commits it;
        // Replace goes on to a typed REPLACE confirm.
        if (!empty && (move || leave)) {
            mode = await safeChoose(
                leave
                    ? `This ${device} already has records from using it without an account. Your account is not changed either way.`
                    : `Your account already has records. The copy on this ${device} is not changed either way.`,
                [
                    { value: 'merge', label: 'Merge', sub: 'Keep both. Records kept on both sides may appear twice.' },
                    { value: 'replace', label: 'Replace', sub: leave ? `Erase the records on this ${device} first` : "Erase the account's records on every device first" },
                ],
                {
                    title: leave ? `Records already on this ${device}` : 'Records already in your account',
                    icon: 'archive', tone: 'info', confirmLabel: 'Continue', selected: 'merge',
                }
            );
            confirmed = mode === 'merge' || (mode === 'replace' && await safeConfirm(
                '',
                null,
                {
                    title: leave ? `Replace the records on this ${device}?` : 'Replace the records in your account?',
                    icon: 'swap', destructive: true, confirmLabel: 'Replace', typedConfirm: REPLACE_PHRASE,
                    facts: leave
                        ? [{ text: `The records on this ${device} now`, gone: true }, { text: "Your account's records take their place" }]
                        : [{ text: "The account's records, on every device", gone: true }, { text: `The records from this ${device} take their place` }],
                }
            ));
        } else if (!empty) {
            confirmed = await safeConfirm(
                '',
                null,
                {
                    title: 'Replace all your data?', icon: 'swap', destructive: true, confirmLabel: 'Replace', typedConfirm: REPLACE_PHRASE,
                    facts: [
                        { text: local ? `Everything stored on this ${device} now` : 'Everything stored now, on every device', gone: true },
                        { text: 'The records in this backup take its place' },
                    ],
                }
            );
        }
        if (!confirmed) {
            importInFlight = false;
            // Cancel = nothing happened (bd med-o7zq.42): no dialog after it.
            // A move keeps its stash (asks again next open); a leave goes back.
            return { imported: false, cancelled: true };
        }

        setImportBusy(true);
        try {
            const result = mode
                ? await window.CloudVault.importAll(json, { mode })
                : await window.CloudVault.importAll(json);
            // Clear busy BEFORE reload — otherwise beforeUnloadGuard would
            // prompt on our own intended navigation.
            setImportBusy(false);
            // But keep the re-entry guard until the reload (bd med-nt9p.32.20):
            // an import started during the alert or beforeReload below would
            // be reloaded out from under the user.
            importInFlight = true;
            // Cloud: applied here, but not on the server yet. Say why and what
            // happens next, so a user moving from another device keeps that
            // copy and the file for now (bd med-o7zq.6).
            const why = result && NOT_UPLOADED[result.upload];
            if (why) {
                await safeAlert(
                    move
                        ? `Your records are in this account on this ${device}, but not uploaded yet. ${why} They also stay on this ${device} without an account until you erase them there.`
                        : `Your backup is restored on this device, but it is not in your account yet. ${why} Keep the backup file, and any other copy of your records, until your account shows them on another device.`,
                    { title: 'Not uploaded yet' }
                );
            }
        } catch (e) {
            console.error('Import failed:', e);
            setImportBusy(false);
            if (move) {
                await safeAlert(
                    `${e.message || 'Import failed'} Your records stay on this ${device}, and the app tries again the next time you open it.`,
                    { title: 'Records not moved yet' }
                );
            } else {
                safeToast(e.message || 'Import failed', 'error');
            }
            return { imported: false };
        }
        if (beforeReload) {
            try { await beforeReload(); } catch (e) { console.error('restoreVault: beforeReload failed', e); }
        }
        // Full refresh so every section re-renders from the restored vault
        // (simplest correct path — same as post-bootstrap reload).
        location.reload();
        // ponytail: released once the reload is asked for, so a reload that
        // never happens (a cancelled leave prompt) can't wedge Restore; the old
        // page's last moments before the reload commits stay unguarded.
        importInFlight = false;
        return { imported: true };
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
        if (!file) { safeToast('Choose a .nxk backup first', 'info'); return; }
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
            'This device is rebuilt from the server.',
            null,
            {
                title: 'Reset local sync?', icon: 'refresh', confirmLabel: 'Reset', destructive: true,
                facts: [
                    { text: 'Changes on this device not synced yet', gone: true },
                    { text: 'Everything already on the server' },
                ],
            }
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
            safeToast(e.message || 'Reset failed', 'error');
        }
    }

    // Un-openable inbox seals (med-0tp). A drain that meets a seal for a device
    // key this one does not have leaves it QUEUED forever for another device —
    // the command sits at "Queued" with nothing in the UI saying why. Surface
    // the last drain's count here, directly above the reset escape hatch that
    // discards the backlog. Runs on every Settings open (load → bindControls);
    // hidden when the count is 0 or the vault is not ready. Never throws.
    async function refreshUnopenableNote() {
        const note = el('importexport-inbox-unopenable-note');
        if (!note) return;
        let count = 0;
        try {
            if (window.CloudVault && typeof window.CloudVault.getInboxUnopenableCount === 'function') {
                count = await window.CloudVault.getInboxUnopenableCount();
            }
        } catch (_) { count = 0; }
        if (typeof count !== 'number' || count <= 0) {
            note.hidden = true;
            note.textContent = '';
            return;
        }
        // Hedged on purpose (codex review): a corrupt seal or invalid-JSON
        // payload counts as un-openable too, and no other device can drain
        // those — but the superseded device key is the known mechanism, and the
        // reset advice below holds either way.
        note.textContent = count === 1
            ? '1 message could not be opened on this device — it may have been sealed to a device key this one does not have. It stays queued for your other devices. Reset local sync (below) discards it along with any unsynced local changes.'
            : `${count} messages could not be opened on this device — they may have been sealed to a device key this one does not have. They stay queued for your other devices. Reset local sync (below) discards them along with any unsynced local changes.`;
        note.hidden = false;
    }

    // The sheets' own controls; bound once, with the Export button.
    function bindSheets() {
        const on = (id, type, fn) => el(id)?.addEventListener(type, fn);
        const dismiss = () => { if (closeSheet) closeSheet(null); };
        el('importexport-sheet-backdrop')?.addEventListener('click', dismiss);
        document.querySelectorAll('.wg-importexport-sheet [data-sheet-close]').forEach((b) => b.addEventListener('click', dismiss));
        on('importexport-export-passphrase', 'input', paintExportConfirm);
        on('importexport-include-secrets', 'change', paintExportConfirm);
        on('importexport-export-confirm', 'click', () => { if (closeSheet) closeSheet(true); });
        on('importexport-export-passphrase', 'keydown', (e) => { if (e.key === 'Enter' && closeSheet) closeSheet(true); });
        on('importexport-ready-save', 'click', saveReady);
        on('importexport-ready-share', 'click', () => { shareReady(); });
        on('importexport-import-decrypt', 'click', submitImportPassphrase);
        on('importexport-import-passphrase', 'keydown', (e) => { if (e.key === 'Enter') submitImportPassphrase(); });
    }

    function bindControls() {
        document.querySelectorAll('#settings-importexport [data-file-input]').forEach(bindFilePicker);

        const nxkBtn = el('importexport-nxk-btn');
        if (nxkBtn && !nxkBtn.dataset.bound) {
            nxkBtn.dataset.bound = '1';
            nxkBtn.addEventListener('click', () => { doNxkImport(); });
        }

        refreshUnopenableNote();
        const resetBtn = el('importexport-reset-sync-btn');
        if (resetBtn && !resetBtn.dataset.bound) {
            resetBtn.dataset.bound = '1';
            resetBtn.addEventListener('click', () => { doResetSync(); });
        }

        const exportBtn = el('importexport-export-btn');
        if (exportBtn && !exportBtn.dataset.bound) {
            exportBtn.dataset.bound = '1';
            exportBtn.addEventListener('click', () => { openExportSheet(); });
            bindSheets();
        }
        paintLastBackup();
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
        // The passphrase sheet the Export backup button opens (the W4 sheet's
        // "Save backup", bd med-ta2n.4).
        openExport: openExportSheet,
        import: doImport,
        restoreVault,
        importNxk: doNxkImport,
        resetSync: doResetSync,
        refreshUnopenableNote
    };
})();
