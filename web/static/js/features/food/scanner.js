// ====================================
// FOOD SCANNER — barcode/QR camera modal
// ====================================
//
// Owns the #food-scanner-modal flow:
//   - live MediaDevices camera stream via getUserMedia (web-side; the modal
//     owns the camera UI on the browser PWA)
//   - per-frame decode via window.Barcode.scan({ source: video }) (the native
//     abstraction installed by web/static/js/native/index.js — Phase 2b Task 7)
//   - "Use Photo" fallback path that opens window.MediaCapture.pickPhoto() to
//     pick a still image, then decodes it via window.Barcode.scan({ source })
//
// Cross-file coupling: a decoded barcode is written into #food-barcode and
// onFoodBarcodeChange (products.js) is invoked; a decoded QR text falls back
// to #food-name. The scanner closes itself once a value is consumed.

(function () {
    let foodScannerStream = null;
    let foodScannerRunning = false;
    let foodScanLoopTimer = null;

    window.FoodScanner = window.FoodScanner || {};
    window.FoodScanner._getStream = () => foodScannerStream;
    window.FoodScanner._setStream = (v) => { foodScannerStream = v; };
    window.FoodScanner._isRunning = () => foodScannerRunning;
    window.FoodScanner._setRunning = (v) => { foodScannerRunning = !!v; };
    window.FoodScanner._getLoopTimer = () => foodScanLoopTimer;
    window.FoodScanner._setLoopTimer = (v) => { foodScanLoopTimer = v; };
})();

const FOOD_SCAN_THROTTLE_MS = 200;
const FOOD_NUMERIC_BARCODE_MIN_LEN = 8;
const FOOD_BARCODE_FORMATS = [
    'qr_code',
    'ean_13',
    'ean_8',
    'upc_a',
    'upc_e',
    'code_128',
    'code_39',
    'itf'
];

function setFoodScannerStatus(message) {
    const status = document.getElementById('food-scanner-status');
    if (status) status.innerText = message;
}

function sanitizeScannedValue(rawValue) {
    if (!rawValue) return { text: '', numeric: '' };
    const text = String(rawValue).replace(/​/g, '').trim();
    const digitsOnly = text.replace(/\D/g, '');
    const numeric = digitsOnly.length >= FOOD_NUMERIC_BARCODE_MIN_LEN ? digitsOnly : '';
    return { text, numeric };
}

function handleDecodedValue(rawValue) {
    const { text, numeric } = sanitizeScannedValue(rawValue);
    if (!text) return false;

    if (numeric) {
        const barcodeInput = document.getElementById('food-barcode');
        barcodeInput.value = numeric;
        onFoodBarcodeChange();
    } else {
        const nameInput = document.getElementById('food-name');
        nameInput.value = text;
        safeAlert('Scanned QR text was added to Food Name.');
    }
    closeFoodScannerModal();
    return true;
}

async function scanFrameLoop() {
    if (!window.FoodScanner._isRunning()) return;

    const video = document.getElementById('food-scanner-video');
    if (!video || !window.Barcode || video.readyState < 2) {
        window.FoodScanner._setLoopTimer(setTimeout(scanFrameLoop, FOOD_SCAN_THROTTLE_MS));
        return;
    }

    try {
        const result = await window.Barcode.scan({ source: video, formats: FOOD_BARCODE_FORMATS });
        // Re-check after await: stopFoodScanner() may have run while the
        // decode was in flight (modal closed, pagehide, beforeunload). Without
        // this guard a late-resolving decode would still write to #food-barcode
        // / trigger onFoodBarcodeChange against a UI the user already dismissed.
        if (!window.FoodScanner._isRunning()) return;
        if (result && result.rawValue && handleDecodedValue(result.rawValue)) return;
    } catch (e) {
        console.error('Food scanner frame decode failed:', e);
    }

    if (!window.FoodScanner._isRunning()) return;
    window.FoodScanner._setLoopTimer(setTimeout(scanFrameLoop, FOOD_SCAN_THROTTLE_MS));
}

function isNativeShell() {
    try {
        var cap = window.Capacitor;
        return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
    } catch (_) { return false; }
}

// On the Capacitor shell the Barcode abstraction's capacitor impl drives the
// full-screen MLKit scanner UI itself — no in-app modal, no live video frame
// loop. Route straight through window.Barcode.scan() and hand the decoded
// value to the existing handleDecodedValue() path so the food modal stays
// closed and the barcode lands in #food-barcode the same way it would have
// from the web flow.
//
// Always close the in-app food-scanner modal on completion: ModalManager
// opened it as part of the standard open() flow, but the MLKit overlay owns
// the actual scanner UI on Capacitor. Leaving the empty in-app modal visible
// on cancel/error strands the user staring at an empty surface they can't
// dismiss visually. handleDecodedValue() also closes the modal on success,
// but calling closeFoodScannerModal() unconditionally here covers all three
// exit paths (cancel/null, error, success).
async function scanWithNativeBarcode() {
    try {
        const result = await window.Barcode.scan({ formats: FOOD_BARCODE_FORMATS });
        const decoded = result && result.rawValue ? result.rawValue : '';
        if (decoded) {
            handleDecodedValue(decoded);
        }
    } catch (e) {
        console.error('Native barcode scan failed:', e);
        safeAlert('Barcode scanning failed: ' + (e && e.message ? e.message : 'unknown error'));
    } finally {
        try { closeFoodScannerModal(); } catch (_) { /* ignore */ }
    }
}

async function startFoodScanner() {
    if (isNativeShell() && window.Barcode && typeof window.Barcode.scan === 'function') {
        await scanWithNativeBarcode();
        return;
    }

    const modal = document.getElementById('food-scanner-modal');
    if (!modal) return;

    if (!window.isSecureContext) {
        setFoodScannerStatus('Camera requires HTTPS (or localhost). Use "Use Photo" or manual entry.');
        return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setFoodScannerStatus('Camera is unavailable. Use "Use Photo" or manual entry.');
        return;
    }

    if (!window.BarcodeDetector) {
        setFoodScannerStatus('Live scan is unavailable on this browser. Use "Use Photo".');
        return;
    }

    const video = document.getElementById('food-scanner-video');
    try {
        setFoodScannerStatus('Requesting camera access...');
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: { ideal: 'environment' } }
        });
        window.FoodScanner._setStream(stream);
        video.srcObject = stream;
        await video.play();
        setFoodScannerStatus('Point camera at barcode or QR.');
        window.FoodScanner._setRunning(true);
        scanFrameLoop();
    } catch (e) {
        console.error('Failed to start food scanner:', e);
        setFoodScannerStatus('Camera access denied or unavailable. Use "Use Photo".');
    }
}

function stopFoodScanner() {
    window.FoodScanner._setRunning(false);

    const t = window.FoodScanner._getLoopTimer();
    if (t) {
        clearTimeout(t);
        window.FoodScanner._setLoopTimer(null);
    }

    const video = document.getElementById('food-scanner-video');
    if (video) {
        video.pause();
        video.srcObject = null;
    }

    const stream = window.FoodScanner._getStream();
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        window.FoodScanner._setStream(null);
    }
}

window.addEventListener('pagehide', stopFoodScanner);
window.addEventListener('beforeunload', stopFoodScanner);

function openFoodScannerModal() {
    window.ModalManager.foodScanner.open();
}

function closeFoodScannerModal() {
    window.ModalManager.foodScanner.close();
}

async function openPhotoPickerAndDecode() {
    let file = null;
    try {
        // capture: false so the web impl does not force the rear camera —
        // users picking a photo of a barcode often have the image already in
        // the gallery (matches the legacy <input type=file accept=image/*>
        // behavior which had no capture attribute).
        file = await window.MediaCapture.pickPhoto({ capture: false });
    } catch (e) {
        console.error('Failed to open photo picker:', e);
        setFoodScannerStatus('Failed to open photo picker. Try again or use manual entry.');
        return;
    }
    if (!file) return;

    setFoodScannerStatus('Decoding image...');
    try {
        const result = await window.Barcode.scan({ source: file, formats: FOOD_BARCODE_FORMATS });
        const decoded = result && result.rawValue ? result.rawValue : '';

        if (!decoded || !handleDecodedValue(decoded)) {
            setFoodScannerStatus('No barcode/QR found in photo. Try another image.');
            safeAlert('No barcode or QR code found in the selected photo.');
        }
    } catch (e) {
        console.error('Failed to decode from photo:', e);
        setFoodScannerStatus('Failed to decode image. Try another photo or manual entry.');
        safeAlert('Could not decode barcode/QR from image.');
    }
}
