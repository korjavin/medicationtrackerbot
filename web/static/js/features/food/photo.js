// ====================================
// FOOD PHOTO — capture + photo time
// ====================================
//
// Owns the Photo entry (Add sheet tile, empty-day shortcut, Today tile):
//   - window.MediaCapture.pickPhoto() opens the device photo picker
//   - EXIF + lastModified parsing to pick the right eaten_at timestamp
//   - hands the file to the Add sheet's review (add-sheet.js), which parses,
//     shows the items, and logs them on the user's say-so
//
// Per-item undo (DELETE /api/food/log/:id) is shared with the food-description
// AI flow and lives in ai-undo.js (function `undoFoodAIItems`).
//
// `triggerFoodPhotoPicker` is also surfaced on window.FoodActions so the
// Today shortcut tile can open the picker without first navigating to the
// Food section.
//
// The static #food-photo-input element remains in the DOM as a fallback
// surface: its `change` handler is still wired by features/food/index.js so
// that any code path that programmatically dispatches a change event (e.g.
// older browser quirks, integration tests that simulate file selection) can
// still feed a file into uploadFoodPhoto without going through MediaCapture.

// Default opens the camera directly (capture on). { gallery: true } opens the
// photo picker instead (Android 14+ picker has no camera entry, hence two buttons).
async function triggerFoodPhotoPicker(opts) {
    const capture = window.MediaCapture;
    if (!capture || typeof capture.pickPhoto !== 'function') {
        return;
    }
    let file;
    try {
        file = await capture.pickPhoto(opts && opts.gallery ? { capture: false } : undefined);
    } catch (e) {
        console.error('Food photo picker failed:', e);
        return;
    }
    if (!file) return;
    await uploadFoodPhotoFile(file);
}

window.FoodActions = window.FoodActions || {};
window.FoodActions.triggerPhotoPicker = triggerFoodPhotoPicker;

// readFoodPhotoExifDateFromBuffer parses just enough JPEG/EXIF to extract the
// capture timestamp (DateTimeOriginal, tag 0x9003, with optional
// OffsetTimeOriginal tag 0x9011). Falls back to DateTime (0x0132) in IFD0
// when the Exif sub-IFD is missing. Returns a Date or null. Robust to
// non-JPEG inputs, missing EXIF, and malformed offsets.
function readFoodPhotoExifDateFromBuffer(buffer) {
    if (!buffer || buffer.byteLength < 4) return null;
    const view = new DataView(buffer);
    if (view.getUint16(0) !== 0xFFD8) return null;

    let offset = 2;
    const max = view.byteLength;
    while (offset + 4 <= max) {
        if (view.getUint8(offset) !== 0xFF) return null;
        const marker = view.getUint8(offset + 1);
        if (marker === 0xDA || marker === 0xD9) return null;
        const segLen = view.getUint16(offset + 2);
        if (segLen < 2) return null;
        if (marker === 0xE1 && offset + 4 + 6 <= max) {
            const sig = String.fromCharCode(
                view.getUint8(offset + 4),
                view.getUint8(offset + 5),
                view.getUint8(offset + 6),
                view.getUint8(offset + 7)
            );
            if (sig === 'Exif'
                && view.getUint8(offset + 8) === 0
                && view.getUint8(offset + 9) === 0) {
                return parseFoodPhotoExifTiff(view, offset + 10, segLen - 8);
            }
        }
        offset += 2 + segLen;
    }
    return null;
}

function parseFoodPhotoExifTiff(view, tiffStart, tiffLen) {
    const end = Math.min(tiffStart + tiffLen, view.byteLength);
    if (tiffStart + 8 > end) return null;

    const byteOrder = view.getUint16(tiffStart);
    let little;
    if (byteOrder === 0x4949) little = true;
    else if (byteOrder === 0x4D4D) little = false;
    else return null;

    if (view.getUint16(tiffStart + 2, little) !== 0x002A) return null;

    const ifd0Tags = readFoodPhotoExifIfd(view, tiffStart + view.getUint32(tiffStart + 4, little), end, little);
    if (!ifd0Tags) return null;

    let dateTimeFallback = null;
    if (ifd0Tags[0x0132]) {
        dateTimeFallback = readFoodPhotoExifAscii(view, tiffStart, end, ifd0Tags[0x0132], little);
    }

    let dateTimeOriginal = null;
    let offsetTimeOriginal = null;
    const exifPtr = ifd0Tags[0x8769];
    if (exifPtr) {
        const exifTags = readFoodPhotoExifIfd(view, tiffStart + exifPtr.valueOffset, end, little);
        if (exifTags) {
            if (exifTags[0x9003]) {
                dateTimeOriginal = readFoodPhotoExifAscii(view, tiffStart, end, exifTags[0x9003], little);
            }
            if (exifTags[0x9011]) {
                offsetTimeOriginal = readFoodPhotoExifAscii(view, tiffStart, end, exifTags[0x9011], little);
            }
        }
    }

    return parseFoodPhotoExifDateString(dateTimeOriginal || dateTimeFallback, offsetTimeOriginal);
}

function readFoodPhotoExifIfd(view, ifdOffset, end, little) {
    if (ifdOffset + 2 > end) return null;
    const count = view.getUint16(ifdOffset, little);
    if (ifdOffset + 2 + count * 12 > end) return null;
    const tags = {};
    for (let i = 0; i < count; i++) {
        const e = ifdOffset + 2 + i * 12;
        const tag = view.getUint16(e, little);
        const type = view.getUint16(e + 2, little);
        const cnt = view.getUint32(e + 4, little);
        tags[tag] = {
            type,
            count: cnt,
            valueOffset: view.getUint32(e + 8, little),
            valueFieldAt: e + 8,
        };
    }
    return tags;
}

function readFoodPhotoExifAscii(view, tiffStart, end, entry, little) {
    if (entry.type !== 2 || entry.count === 0) return null;
    const length = entry.count;
    const strStart = length <= 4 ? entry.valueFieldAt : tiffStart + entry.valueOffset;
    if (strStart + length > view.byteLength) return null;
    let s = '';
    for (let i = 0; i < length; i++) {
        const b = view.getUint8(strStart + i);
        if (b === 0) break;
        s += String.fromCharCode(b);
    }
    return s;
}

function parseFoodPhotoExifDateString(s, offsetStr) {
    if (!s) return null;
    const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
    if (!m) return null;
    const [, y, mo, d, h, mi, se] = m;
    let dt;
    if (offsetStr && /^[+-]\d{2}:\d{2}$/.test(offsetStr)) {
        dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${offsetStr}`);
    } else {
        dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se));
    }
    if (Number.isNaN(dt.getTime())) return null;
    const yr = dt.getFullYear();
    if (yr < 1995 || yr > new Date().getFullYear() + 1) return null;
    return dt;
}

async function readFoodPhotoExifDate(file) {
    if (!file || typeof file.arrayBuffer !== 'function') return null;
    try {
        return readFoodPhotoExifDateFromBuffer(await file.arrayBuffer());
    } catch (e) {
        return null;
    }
}

function readFoodPhotoLastModifiedDate(file) {
    if (!file || typeof file.lastModified !== 'number' || !file.lastModified) return null;
    const dt = new Date(file.lastModified);
    if (Number.isNaN(dt.getTime())) return null;
    const yr = dt.getFullYear();
    if (yr < 1995 || yr > new Date().getFullYear() + 1) return null;
    return dt;
}

// The photo's own time (EXIF, else lastModified) when it has one; the Add
// sheet's time chip shows it and the user can change it before logging.
async function resolveFoodPhotoEatenAt(file, now = new Date()) {
    return (await readFoodPhotoExifDate(file))
        || readFoodPhotoLastModifiedDate(file)
        || now;
}

async function uploadFoodPhoto(input) {
    const file = input && input.files && input.files[0];
    if (!file) return;
    try {
        await uploadFoodPhotoFile(file);
    } finally {
        if (input) input.value = '';
    }
}

async function uploadFoodPhotoFile(file) {
    if (!file) return;

    if (!file.type || !file.type.startsWith('image/')) {
        safeAlert('Please choose an image file.');
        return;
    }

    const eatenAt = await resolveFoodPhotoEatenAt(file);
    // Never logs directly: the Add sheet parses (dry run) and shows the items
    // for review; its Log commits them (kit F6).
    await window.FoodLog.addSheet.startPhotoReview(file, eatenAt);
}

window.FoodPhoto = window.FoodPhoto || {};
window.FoodPhoto.triggerPicker = triggerFoodPhotoPicker;
window.FoodPhoto.upload = uploadFoodPhoto;
// Re-export the shared AI-undo helper under its legacy name so existing
// callers and tests that look up `window.FoodPhoto.undo` keep working.
window.FoodPhoto.undo = undoFoodAIItems;
window.FoodPhoto.resolveEatenAt = resolveFoodPhotoEatenAt;
