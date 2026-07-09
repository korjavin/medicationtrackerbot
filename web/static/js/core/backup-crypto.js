// core/backup-crypto.js
// Browser-side backup file format for the Settings → Import/Export vault:
// gzip, then optional passphrase encryption via the vendored `typage`
// (age-encryption) bundle. The output is a standard age-encryption.org/v1 file
// (scrypt recipient) wrapping a gzip member — `age -d file.json.gz.age |
// gunzip` anywhere. The server never sees the passphrase and never performs
// backup crypto (C2e locked decision 2).
//
// Order matters: compress BEFORE encrypting. age ciphertext is high-entropy and
// does not compress, so gzip-after-encrypt would save nothing. A real vault is
// ~330MB of JSON and ~20MB gzipped — and the import path caps the upload at
// 64MB, so this is what makes a large backup restorable at all.
//
// Both compressed and plain payloads import: the reader sniffs the gzip magic
// (0x1f 0x8b) on the decrypted bytes, so pre-compression `.json` / `.json.age`
// backups keep working.
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

    // gzip members begin with 0x1f 0x8b. Sniffed on the *decrypted* bytes, not on
    // the filename — users rename backups.
    function isGzipFile(bytes) {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        return u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b;
    }

    // A full vault is hundreds of MB of repetitive JSON and gzips ~15x. Compress
    // BEFORE encrypting: age ciphertext is incompressible, so the other order
    // saves nothing. Streams, so the whole thing is never held twice.
    // Response is the portable byte↔stream↔text adapter here: it takes a string
    // or a Uint8Array, exposes .body as a ReadableStream, and re-reads the piped
    // output as bytes or UTF-8 text. Blob.stream()/TextEncoder/TextDecoder are
    // all missing from the jsdom window this module registers into; Response is
    // not, and needs no polyfill.
    function piped(input, stream) {
        return new Response(new Response(input).body.pipeThrough(stream));
    }

    // gzipString(str) -> Uint8Array (a .gz member).
    async function gzipString(str) {
        const buf = await piped(str, new CompressionStream('gzip')).arrayBuffer();
        return new Uint8Array(buf);
    }

    // gunzipToString(bytes) -> string (the original text).
    function gunzipToString(bytes) {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        return piped(u8, new DecompressionStream('gzip')).text();
    }

    // bytesToString(bytes) -> string. Same portability reason as above; the
    // import path needs it for a plain (pre-compression) .json backup.
    function bytesToString(bytes) {
        return new Response(bytes).text();
    }

    // encryptBackup(data, passphrase) -> Uint8Array (binary .age file).
    // `data` is a string or the Uint8Array of an already-gzipped payload.
    async function encryptBackup(data, passphrase) {
        if (!passphrase) throw new Error('encryptBackup: passphrase required');
        const { Encrypter } = await age();
        const e = new Encrypter();
        e.setPassphrase(passphrase);
        return e.encrypt(data);
    }

    // decryptBackup(bytes, passphrase) -> Uint8Array (the plaintext payload,
    // which may itself be gzip — the caller sniffs with isGzipFile).
    async function decryptBackup(bytes, passphrase) {
        if (!passphrase) throw new Error('decryptBackup: passphrase required');
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const { Decrypter } = await age();
        const d = new Decrypter();
        d.addPassphrase(passphrase);
        return d.decrypt(u8);
    }

    const BackupCrypto = {
        isAgeFile, isGzipFile, gzipString, gunzipToString, bytesToString,
        encryptBackup, decryptBackup, setLoader,
    };

    if (typeof window !== 'undefined') {
        window.BackupCrypto = BackupCrypto;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = BackupCrypto;
    }
})();
