// Shared utility functions.
// Loaded early (before app.js) — no dependencies on other app files.

function safeAlert(msg) {
    const tg = window.Telegram && window.Telegram.WebApp;
    if (tg && tg.showAlert) {
        try {
            tg.showAlert(msg);
        } catch (e) {
            alert(msg);
        }
    } else {
        alert(msg);
    }
}

function safeConfirm(msg, callback) {
    const tg = window.Telegram && window.Telegram.WebApp;
    const hasTelegramContext = !!(tg && (window.userInitData || tg.initData));
    const invokeCallback = (ok) => {
        if (typeof callback !== 'function') return ok;
        return callback(ok);
    };

    return new Promise((resolve, reject) => {
        const handleResult = (ok) => {
            Promise.resolve(invokeCallback(ok)).then(resolve).catch(reject);
        };

        if (hasTelegramContext && tg.showConfirm) {
            try {
                tg.showConfirm(msg, handleResult);
            } catch (e) {
                handleResult(confirm(msg));
            }
            return;
        }

        handleResult(confirm(msg));
    });
}

function formatDateTimeLocalForInput(dateValue = new Date()) {
    const localDate = dateValue instanceof Date ? new Date(dateValue.getTime()) : new Date(dateValue);
    localDate.setMinutes(localDate.getMinutes() - localDate.getTimezoneOffset());
    return localDate.toISOString().slice(0, 16);
}

function downloadBlobAsFile(blob, filename) {
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(link);
}
