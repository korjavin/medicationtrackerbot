// food.exif-eaten-at.test.js
//
// Verifies the EXIF DateTimeOriginal extraction for food-photo uploads and the
// "use photo time vs. now" decision in features/food.js#uploadFoodPhoto.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

// Build a minimal JPEG (SOI + APP1/EXIF + EOI) with the given EXIF strings.
// Layout uses little-endian TIFF; DateTime lives in IFD0, DateTimeOriginal +
// OffsetTimeOriginal in the Exif sub-IFD addressed by ExifIFDPointer (0x8769).
function buildJpegWithExif({
    dateTime = '2024:01:15 10:30:00',
    dateTimeOriginal = '2024:01:14 14:00:00',
    offsetTime = null,
} = {}) {
    const writeStr = (arr, at, s, len) => {
        for (let i = 0; i < Math.min(s.length, len - 1); i++) arr[at + i] = s.charCodeAt(i);
    };

    const dtLen = 20;
    const dtOrigLen = 20;
    const offLen = offsetTime ? 7 : 0;
    const exifEntries = offsetTime ? 2 : 1;
    const exifIfdSize = 2 + exifEntries * 12 + 4;

    const ifd0Start = 8;
    const ifd0Size = 2 + 2 * 12 + 4; // 30
    const dtDataAt = ifd0Start + ifd0Size;            // 38
    const exifIfdAt = dtDataAt + dtLen;               // 58
    const dtOrigAt = exifIfdAt + exifIfdSize;         // 88 or 76
    const offAt = dtOrigAt + dtOrigLen;
    const tiffSize = offsetTime ? offAt + offLen : dtOrigAt + dtOrigLen;

    const tiff = new Uint8Array(tiffSize);
    const dv = new DataView(tiff.buffer);

    // TIFF header: II 0x002A IFD0Offset=8 (all little-endian)
    tiff[0] = 0x49; tiff[1] = 0x49;
    dv.setUint16(2, 0x002A, true);
    dv.setUint32(4, ifd0Start, true);

    // IFD0: 2 entries [DateTime, ExifIFDPointer]
    dv.setUint16(ifd0Start, 2, true);
    // DateTime (0x0132), ASCII (2), count=20, valueOffset=dtDataAt
    dv.setUint16(ifd0Start + 2, 0x0132, true);
    dv.setUint16(ifd0Start + 4, 2, true);
    dv.setUint32(ifd0Start + 6, dtLen, true);
    dv.setUint32(ifd0Start + 10, dtDataAt, true);
    // ExifIFDPointer (0x8769), LONG (4), count=1, value=exifIfdAt
    dv.setUint16(ifd0Start + 14, 0x8769, true);
    dv.setUint16(ifd0Start + 16, 4, true);
    dv.setUint32(ifd0Start + 18, 1, true);
    dv.setUint32(ifd0Start + 22, exifIfdAt, true);
    dv.setUint32(ifd0Start + 26, 0, true); // next IFD = none
    writeStr(tiff, dtDataAt, dateTime, dtLen);

    // Exif sub-IFD
    dv.setUint16(exifIfdAt, exifEntries, true);
    // DateTimeOriginal (0x9003), ASCII (2), count=20, valueOffset=dtOrigAt
    dv.setUint16(exifIfdAt + 2, 0x9003, true);
    dv.setUint16(exifIfdAt + 4, 2, true);
    dv.setUint32(exifIfdAt + 6, dtOrigLen, true);
    dv.setUint32(exifIfdAt + 10, dtOrigAt, true);
    if (offsetTime) {
        // OffsetTimeOriginal (0x9011), ASCII (2), count=7, valueOffset=offAt
        dv.setUint16(exifIfdAt + 14, 0x9011, true);
        dv.setUint16(exifIfdAt + 16, 2, true);
        dv.setUint32(exifIfdAt + 18, offLen, true);
        dv.setUint32(exifIfdAt + 22, offAt, true);
        dv.setUint32(exifIfdAt + 26, 0, true);
    } else {
        dv.setUint32(exifIfdAt + 14, 0, true);
    }
    writeStr(tiff, dtOrigAt, dateTimeOriginal, dtOrigLen);
    if (offsetTime) writeStr(tiff, offAt, offsetTime, offLen);

    // Wrap in JPEG: SOI + APP1 + "Exif\0\0" + TIFF + EOI
    const exifHeaderLen = 6;
    const segLen = 2 + exifHeaderLen + tiffSize; // includes the 2-byte length field
    const out = new Uint8Array(2 + 2 + segLen + 2);
    out[0] = 0xFF; out[1] = 0xD8;     // SOI
    out[2] = 0xFF; out[3] = 0xE1;     // APP1 marker
    new DataView(out.buffer).setUint16(4, segLen, false); // length (BE)
    out[6] = 0x45; out[7] = 0x78; out[8] = 0x69; out[9] = 0x66; // "Exif"
    out[10] = 0x00; out[11] = 0x00;
    out.set(tiff, 12);
    out[out.length - 2] = 0xFF;
    out[out.length - 1] = 0xD9;       // EOI

    return out.buffer;
}

function makeFakeFile(env, buffer, { type = 'image/jpeg', name = 'food.jpg' } = {}) {
    // FormData.append requires a real Blob; jsdom enforces this. Build a Blob
    // in the env's window so it's recognised by the env's FormData impl.
    const blob = new env.window.Blob([buffer], { type });
    blob.name = name;
    blob.arrayBuffer = async () => buffer;
    return blob;
}

describe('readFoodPhotoExifDateFromBuffer', () => {
    let env;
    beforeEach(() => { env = loadFrontendEnv(); });
    afterEach(() => { env.cleanup(); env = null; });

    it('returns null for too-small / non-JPEG input', () => {
        expect(env.window.readFoodPhotoExifDateFromBuffer(new ArrayBuffer(0))).toBeNull();
        const tiny = new Uint8Array([0x00, 0x00, 0x00, 0x00]).buffer;
        expect(env.window.readFoodPhotoExifDateFromBuffer(tiny)).toBeNull();
    });

    it('returns null for a JPEG without an APP1/EXIF segment', () => {
        const noExif = new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]).buffer;
        expect(env.window.readFoodPhotoExifDateFromBuffer(noExif)).toBeNull();
    });

    it('parses DateTimeOriginal with explicit OffsetTimeOriginal', () => {
        const buf = buildJpegWithExif({
            dateTimeOriginal: '2024:01:14 14:00:00',
            offsetTime: '+02:00',
        });
        const dt = env.window.readFoodPhotoExifDateFromBuffer(buf);
        expect(dt).not.toBeNull();
        // 14:00 +02:00 == 12:00 UTC
        expect(dt.toISOString()).toBe('2024-01-14T12:00:00.000Z');
    });

    it('parses DateTimeOriginal as local time when no offset is present', () => {
        const buf = buildJpegWithExif({
            dateTimeOriginal: '2024:01:14 14:00:00',
            offsetTime: null,
        });
        const dt = env.window.readFoodPhotoExifDateFromBuffer(buf);
        expect(dt).not.toBeNull();
        expect(dt.getFullYear()).toBe(2024);
        expect(dt.getMonth()).toBe(0);
        expect(dt.getDate()).toBe(14);
        expect(dt.getHours()).toBe(14);
        expect(dt.getMinutes()).toBe(0);
    });

    it('rejects clearly out-of-range dates', () => {
        const buf = buildJpegWithExif({ dateTimeOriginal: '1970:01:01 00:00:00' });
        expect(env.window.readFoodPhotoExifDateFromBuffer(buf)).toBeNull();
    });
});

describe('resolveFoodPhotoEatenAt', () => {
    let env;
    beforeEach(() => { env = loadFrontendEnv(); });
    afterEach(() => { env.cleanup(); env = null; });

    it('falls back to "now" when no EXIF date and no lastModified are present', async () => {
        env.window.readFoodPhotoExifDate = async () => null;
        let confirmCalls = 0;
        env.window.safeConfirm = async () => { confirmCalls++; return true; };

        const now = new Date('2024-06-01T12:00:00Z');
        const got = await env.window.resolveFoodPhotoEatenAt({}, now);
        expect(got.getTime()).toBe(now.getTime());
        expect(confirmCalls).toBe(0);
    });

    it('falls back to file.lastModified when EXIF is missing (HEIC / stripped metadata)', async () => {
        env.window.readFoodPhotoExifDate = async () => null;
        const lastModified = new Date('2024-05-30T18:00:00Z').getTime();
        let confirmMsg = null;
        env.window.safeConfirm = async (msg) => { confirmMsg = msg; return true; };

        const now = new Date('2024-06-01T12:00:00Z');
        const got = await env.window.resolveFoodPhotoEatenAt({ lastModified }, now);
        expect(got.getTime()).toBe(lastModified);
        expect(confirmMsg).toMatch(/photo/i);
    });

    it('uses file.lastModified silently when within 1h of now', async () => {
        env.window.readFoodPhotoExifDate = async () => null;
        const now = new Date('2024-06-01T12:00:00Z');
        const lastModified = now.getTime() - 30 * 60 * 1000;
        let confirmCalls = 0;
        env.window.safeConfirm = async () => { confirmCalls++; return true; };

        const got = await env.window.resolveFoodPhotoEatenAt({ lastModified }, now);
        expect(got.getTime()).toBe(lastModified);
        expect(confirmCalls).toBe(0);
    });

    it('ignores zero / nonsensical lastModified values', async () => {
        env.window.readFoodPhotoExifDate = async () => null;
        env.window.safeConfirm = async () => true;

        const now = new Date('2024-06-01T12:00:00Z');
        const got = await env.window.resolveFoodPhotoEatenAt({ lastModified: 0 }, now);
        expect(got.getTime()).toBe(now.getTime());
    });

    it('uses the photo time silently when within 1 hour of now', async () => {
        const photoTime = new Date('2024-06-01T11:30:00Z');
        const now = new Date('2024-06-01T12:00:00Z');
        env.window.readFoodPhotoExifDate = async () => photoTime;
        let confirmCalls = 0;
        env.window.safeConfirm = async () => { confirmCalls++; return true; };

        const got = await env.window.resolveFoodPhotoEatenAt({}, now);
        expect(got.getTime()).toBe(photoTime.getTime());
        expect(confirmCalls).toBe(0);
    });

    it('asks the user when photo time differs by more than 1 hour, returns photo time on yes', async () => {
        const photoTime = new Date('2024-05-30T18:00:00Z');
        const now = new Date('2024-06-01T12:00:00Z');
        env.window.readFoodPhotoExifDate = async () => photoTime;
        let confirmMsg = null;
        env.window.safeConfirm = async (msg) => { confirmMsg = msg; return true; };

        const got = await env.window.resolveFoodPhotoEatenAt({}, now);
        expect(confirmMsg).toMatch(/photo/i);
        expect(got.getTime()).toBe(photoTime.getTime());
    });

    it('returns now when the user declines the photo time prompt', async () => {
        const photoTime = new Date('2024-05-30T18:00:00Z');
        const now = new Date('2024-06-01T12:00:00Z');
        env.window.readFoodPhotoExifDate = async () => photoTime;
        env.window.safeConfirm = async () => false;

        const got = await env.window.resolveFoodPhotoEatenAt({}, now);
        expect(got.getTime()).toBe(now.getTime());
    });
});

describe('uploadFoodPhoto sends the resolved eaten_at to the server', () => {
    let env;
    beforeEach(() => { env = loadFrontendEnv(); });
    afterEach(() => { env.cleanup(); env = null; });

    async function captureUpload({ photoTime, confirmAnswer = true } = {}) {
        env.window.readFoodPhotoExifDate = async () => photoTime;
        env.window.safeConfirm = async () => confirmAnswer;
        env.window.safeAlert = () => {};
        env.window.loadFoodLogs = () => {};
        env.window.loadToday = () => {};
        if (env.window.DataStore) {
            env.window.DataStore.invalidateTags = async () => {};
            env.window.DataStore.clearCached = async () => {};
            env.window.DataStore.advanceCursorSilently = () => {};
        }

        let captured = null;
        env.window.fetch = async (url, opts) => {
            if (typeof url === 'string' && url.includes('/food/log/from-photo')) {
                captured = opts && opts.body;
            }
            return {
                ok: true,
                status: 200,
                async json() { return { items: [] }; },
                async text() { return ''; },
            };
        };

        const buffer = buildJpegWithExif();
        const file = makeFakeFile(env, buffer);
        await env.window.uploadFoodPhoto({ files: [file], value: '' });
        return captured;
    }

    it('sends EXIF photo time when within 1h of now (no prompt)', async () => {
        const now = Date.now();
        const photoTime = new Date(now - 30 * 60 * 1000); // 30 min before now
        const form = await captureUpload({ photoTime });
        expect(form).not.toBeNull();
        expect(typeof form.get).toBe('function');
        expect(form.get('eaten_at')).toBe(photoTime.toISOString());
    });

    it('sends photo time when user accepts the prompt for an old photo', async () => {
        const photoTime = new Date('2024-01-01T08:00:00Z');
        const form = await captureUpload({ photoTime, confirmAnswer: true });
        expect(form.get('eaten_at')).toBe(photoTime.toISOString());
    });

    it('sends "now" when user declines the prompt for an old photo', async () => {
        const photoTime = new Date('2024-01-01T08:00:00Z');
        const before = Date.now();
        const form = await captureUpload({ photoTime, confirmAnswer: false });
        const after = Date.now();
        const sent = new Date(form.get('eaten_at')).getTime();
        expect(sent).toBeGreaterThanOrEqual(before);
        expect(sent).toBeLessThanOrEqual(after);
    });

    it('falls back to "now" when no EXIF data is available', async () => {
        const before = Date.now();
        const form = await captureUpload({ photoTime: null });
        const after = Date.now();
        const sent = new Date(form.get('eaten_at')).getTime();
        expect(sent).toBeGreaterThanOrEqual(before);
        expect(sent).toBeLessThanOrEqual(after);
    });
});
