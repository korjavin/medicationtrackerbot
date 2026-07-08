// core/backup-crypto.js
// Thin browser-side wrapper around the vendored `typage` (age-encryption)
// bundle: passphrase-based backup encryption for the Settings → Import/Export
// vault file. The output is a standard age-encryption.org/v1 file (scrypt
// recipient) — decryptable anywhere with `age -d`. The server never sees the
// passphrase and never performs backup crypto (C2e locked decision 2).
//
// The vendored ESM (`/static/vendor/age.min.js`) is loaded lazily via dynamic
// import() on first use, so it is not parsed/executed for users who never open
// the Import/Export screen and there is no new global <script> tag. (The SW
// still precaches the file so import/export works offline.)

(function () {
    // Overridable module loader so tests can inject the bundle by filesystem
    // path (dynamic import of an absolute `/static/...` URL doesn't resolve
    // under Node/Vitest). Production uses the default browser path.
    let _load = () => import('/static/vendor/age.min.js');
    let _cached = null;

    function setLoader(fn) {
        _load = fn;
        _cached = null;
    }

    async function age() {
        if (!_cached) _cached = await _load();
        return _cached;
    }

    // age v1 files begin with the ASCII line "age-encryption.org/v1\n".
    // Compared as raw bytes so this stays free of any platform text-decoder
    // global (works identically in the browser and headless test envs).
    const AGE_MAGIC = Array.from('age-encryption.org/v1', (c) => c.charCodeAt(0));

    // isAgeFile(bytes) — header sniff so the Import UI knows to prompt for a
    // passphrase (vs. parsing plaintext JSON). Accepts a Uint8Array/ArrayBuffer.
    function isAgeFile(bytes) {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (u8.length < AGE_MAGIC.length) return false;
        for (let i = 0; i < AGE_MAGIC.length; i++) {
            if (u8[i] !== AGE_MAGIC[i]) return false;
        }
        return true;
    }

    // encryptBackup(jsonString, passphrase) -> Uint8Array (binary .age file).
    async function encryptBackup(jsonString, passphrase) {
        if (!passphrase) throw new Error('encryptBackup: passphrase required');
        const { Encrypter } = await age();
        const e = new Encrypter();
        e.setPassphrase(passphrase);
        return e.encrypt(jsonString);
    }

    // decryptBackup(bytes, passphrase) -> string (the original JSON text).
    async function decryptBackup(bytes, passphrase) {
        if (!passphrase) throw new Error('decryptBackup: passphrase required');
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const { Decrypter } = await age();
        const d = new Decrypter();
        d.addPassphrase(passphrase);
        return d.decrypt(u8, 'text');
    }

    const BackupCrypto = { isAgeFile, encryptBackup, decryptBackup, setLoader };

    if (typeof window !== 'undefined') {
        window.BackupCrypto = BackupCrypto;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = BackupCrypto;
    }
})();
