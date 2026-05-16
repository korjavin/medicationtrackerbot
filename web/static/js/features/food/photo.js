// ====================================
// FOOD PHOTO — capture, AI summary, undo
// ====================================
//
// Owns the "+ Photo" flow on the Food screen:
//   - hidden <input type=file> picker triggered from the day-nav toolbar
//   - EXIF + lastModified parsing to pick the right eaten_at timestamp
//   - POST /api/food/log/from-photo upload + cache invalidation
//   - the friendly summary card handoff (food-photo-summary.js owns the
//     UI; this file owns the network + cache-invalidation side)
//   - per-item undo (DELETE /api/food/log/:id) with partial-failure retry
//
// `triggerFoodPhotoPicker` is also surfaced on window.FoodActions so the
// Today shortcut tile can open the picker without first navigating to the
// Food section.

function triggerFoodPhotoPicker() {
    const input = document.getElementById('food-photo-input');
    if (!input) return;
    input.value = '';
    input.click();
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

async function resolveFoodPhotoEatenAt(file, now = new Date()) {
    const photoTime = (await readFoodPhotoExifDate(file))
        || readFoodPhotoLastModifiedDate(file);
    if (!photoTime) return now;
    const diffMs = Math.abs(photoTime.getTime() - now.getTime());
    if (diffMs <= 60 * 60 * 1000) return photoTime;
    const photoLabel = photoTime.toLocaleString();
    const usePhoto = await safeConfirm(
        `This photo was taken on ${photoLabel}. Use the photo's time? (Cancel = use now)`
    );
    return usePhoto ? photoTime : now;
}

async function uploadFoodPhoto(input) {
    const file = input && input.files && input.files[0];
    if (!file) return;

    if (!file.type || !file.type.startsWith('image/')) {
        safeAlert('Please choose an image file.');
        return;
    }

    const eatenAt = await resolveFoodPhotoEatenAt(file);

    const photoBtn = document.getElementById('add-food-photo-btn');
    const originalLabel = photoBtn ? photoBtn.querySelector('.wg-toolbar-btn__label') : null;
    const restoreLabel = originalLabel ? originalLabel.textContent : 'Photo';

    await withSubmit(photoBtn, async () => {
        if (originalLabel) originalLabel.textContent = 'Analyzing…';

        try {
            const form = new FormData();
            form.append('image', file, file.name || 'food.jpg');
            form.append('eaten_at', eatenAt.toISOString());

            const res = await fetch('/api/food/log/from-photo', {
                method: 'POST',
                headers: window.makeAuthHeaders(),
                body: form,
            });

            if (!res.ok) {
                const txt = await res.text();
                throw new Error(txt || `HTTP ${res.status}`);
            }

            const data = await res.json().catch(() => null);
            const items = (data && Array.isArray(data.items)) ? data.items : [];

            await window.DataStore.invalidateTags(['food']);
            if (typeof todayFoodKey === 'function' && window.DataStore.clearCached) {
                await window.DataStore.clearCached(todayFoodKey(new Date()));
            }
            if (window.DataStore?.advanceCursorSilently) {
                window.DataStore.advanceCursorSilently();
            }

            loadFoodLogs();
            if (typeof loadToday === 'function') loadToday();

            if (typeof showFoodPhotoSummary === 'function' && items.length) {
                let summaryHandle;
                summaryHandle = showFoodPhotoSummary({
                    items,
                    onUndo: () => undoFoodPhotoLog(items, summaryHandle),
                });
            } else {
                safeAlert(items.length
                    ? `Logged ${items.length} item${items.length === 1 ? '' : 's'}.`
                    : 'Photo logged.');
            }
        } catch (e) {
            console.error('Food photo upload failed:', e);
            safeAlert('Failed to log food from photo: ' + (e.message || e));
        } finally {
            if (originalLabel) originalLabel.textContent = restoreLabel;
            input.value = '';
        }
    });
}

// Undo handler for the friendly food-photo summary card. Issues a parallel
// DELETE for every just-logged item, refreshes the food list + Today, then
// transitions the card to a "Removed N items" success state. On partial
// failure the card flips to its retry-able error state, and Retry only
// re-attempts the items that haven't already been deleted — otherwise the
// store's "no rows" 500 for already-deleted ids would lock the user in
// permanent error after a single successful round.
async function undoFoodPhotoLog(items, summary, originalCount) {
    if (!Array.isArray(items) || items.length === 0) return;
    const total = (typeof originalCount === 'number') ? originalCount : items.length;

    const results = await Promise.all(items.map(async (it) => {
        if (!it || !it.id) return { item: it, ok: false };
        try {
            const res = await fetch(`/api/food/log/${it.id}`, {
                method: 'DELETE',
                headers: window.makeAuthHeaders(),
            });
            return { item: it, ok: !!(res && res.ok) };
        } catch (_) {
            return { item: it, ok: false };
        }
    }));

    const allOk = results.every(r => r.ok);
    const anyOk = results.some(r => r.ok);

    if (anyOk) {
        try {
            await window.DataStore.invalidateTags(['food']);
            if (typeof todayFoodKey === 'function' && window.DataStore.clearCached) {
                await window.DataStore.clearCached(todayFoodKey(new Date()));
            }
            if (window.DataStore?.advanceCursorSilently) {
                window.DataStore.advanceCursorSilently();
            }
        } catch (e) {
            console.error('Food photo undo cache invalidation failed:', e);
        }
        loadFoodLogs();
        if (typeof loadToday === 'function') loadToday();
    }

    if (!allOk) {
        const remaining = results.filter(r => !r.ok).map(r => r.item);
        if (summary && typeof summary.showError === 'function') {
            summary.showError(
                'Could not undo all items. Tap retry to try again.',
                () => undoFoodPhotoLog(remaining, summary, total),
            );
        }
        return;
    }

    if (summary && typeof summary.showRemoved === 'function') {
        summary.showRemoved(total);
    }
}

window.FoodPhoto = window.FoodPhoto || {};
window.FoodPhoto.triggerPicker = triggerFoodPhotoPicker;
window.FoodPhoto.upload = uploadFoodPhoto;
window.FoodPhoto.undo = undoFoodPhotoLog;
window.FoodPhoto.resolveEatenAt = resolveFoodPhotoEatenAt;
