// ====================================
// FOOD SCANNER — barcode/QR camera modal
// ====================================
//
// Owns the #food-scanner-modal flow:
//   - live MediaDevices camera stream via getUserMedia
//   - per-frame BarcodeDetector polling loop (throttled)
//   - "Use Photo" fallback path that decodes a still image via the native
//     BarcodeDetector first, then ZXing as a graceful fallback
//
// Cross-file coupling: a decoded barcode is written into #food-barcode and
// onFoodBarcodeChange (products.js) is invoked; a decoded QR text falls back
// to #food-name. The scanner closes itself once a value is consumed.

(function () {
    let foodScannerStream = null;
    let foodScannerRunning = false;
    let foodScanLoopTimer = null;
    let foodBarcodeDetector = null;

    window.FoodScanner = window.FoodScanner || {};
    window.FoodScanner._getStream = () => foodScannerStream;
    window.FoodScanner._setStream = (v) => { foodScannerStream = v; };
    window.FoodScanner._isRunning = () => foodScannerRunning;
    window.FoodScanner._setRunning = (v) => { foodScannerRunning = !!v; };
    window.FoodScanner._getLoopTimer = () => foodScanLoopTimer;
    window.FoodScanner._setLoopTimer = (v) => { foodScanLoopTimer = v; };
    window.FoodScanner._getDetector = () => foodBarcodeDetector;
    window.FoodScanner._setDetector = (v) => { foodBarcodeDetector = v; };
})();

const FOOD_SCAN_THROTTLE_MS = 200;
const FOOD_NUMERIC_BARCODE_MIN_LEN = 8;

function setFoodScannerStatus(message) {
    const status = document.getElementById('food-scanner-status');
    if (status) status.innerText = message;
}

function createFoodBarcodeDetector() {
    if (!window.BarcodeDetector) return null;
    const existing = window.FoodScanner._getDetector();
    if (existing) return existing;

    const formats = [
        'qr_code',
        'ean_13',
        'ean_8',
        'upc_a',
        'upc_e',
        'code_128',
        'code_39',
        'itf'
    ];
    let detector;
    try {
        detector = new BarcodeDetector({ formats });
    } catch (e) {
        console.error('Failed to create BarcodeDetector with formats, retrying default:', e);
        detector = new BarcodeDetector();
    }
    window.FoodScanner._setDetector(detector);
    return detector;
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
    const detector = createFoodBarcodeDetector();
    if (!video || !detector || video.readyState < 2) {
        window.FoodScanner._setLoopTimer(setTimeout(scanFrameLoop, FOOD_SCAN_THROTTLE_MS));
        return;
    }

    try {
        const results = await detector.detect(video);
        if (results && results.length > 0) {
            const first = results.find(r => r && r.rawValue) || results[0];
            if (first && handleDecodedValue(first.rawValue)) return;
        }
    } catch (e) {
        console.error('Food scanner frame decode failed:', e);
    }

    window.FoodScanner._setLoopTimer(setTimeout(scanFrameLoop, FOOD_SCAN_THROTTLE_MS));
}

async function startFoodScanner() {
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

function decodeBarcodeFromImageFallback(image) {
    return new Promise((resolve, reject) => {
        const ZXingGlobal = window.ZXing;
        if (!ZXingGlobal || !ZXingGlobal.BrowserMultiFormatReader) {
            reject(new Error('Fallback decoder is not available.'));
            return;
        }

        const reader = new ZXingGlobal.BrowserMultiFormatReader();
        reader.decodeFromImageElement(image)
            .then(result => {
                reader.reset();
                resolve(result && result.text ? result.text : '');
            })
            .catch(err => {
                reader.reset();
                reject(err);
            });
    });
}

async function decodeFromImageWithDetector(image) {
    const detector = createFoodBarcodeDetector();
    if (!detector) return '';

    const results = await detector.detect(image);
    if (!results || results.length === 0) return '';
    const first = results.find(r => r && r.rawValue) || results[0];
    return first && first.rawValue ? first.rawValue : '';
}

async function openPhotoPickerAndDecode() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';

    input.onchange = async (event) => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;

        setFoodScannerStatus('Decoding image...');
        try {
            const imageURL = URL.createObjectURL(file);
            const image = new Image();
            image.src = imageURL;
            await image.decode();

            let decoded = '';
            try {
                decoded = await decodeFromImageWithDetector(image);
            } catch (e) {
                console.log('Native image decode failed, using fallback:', e);
            }

            if (!decoded) {
                decoded = await decodeBarcodeFromImageFallback(image);
            }

            URL.revokeObjectURL(imageURL);

            if (!decoded || !handleDecodedValue(decoded)) {
                setFoodScannerStatus('No barcode/QR found in photo. Try another image.');
                safeAlert('No barcode or QR code found in the selected photo.');
            }
        } catch (e) {
            console.error('Failed to decode from photo:', e);
            setFoodScannerStatus('Failed to decode image. Try another photo or manual entry.');
            safeAlert('Could not decode barcode/QR from image.');
        }
    };

    input.click();
}
