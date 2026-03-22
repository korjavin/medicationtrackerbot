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

function formatCacheAge(cachedAt) {
    if (!cachedAt) return 'Cached';
    const ageMs = Date.now() - new Date(cachedAt).getTime();
    const ageMin = Math.floor(ageMs / 60000);
    if (ageMin < 1) return 'Cached just now';
    if (ageMin < 60) return `Cached ${ageMin}m ago`;
    const ageHours = Math.floor(ageMin / 60);
    if (ageHours < 24) return `Cached ${ageHours}h ago`;
    const ageDays = Math.floor(ageHours / 24);
    return `Cached ${ageDays}d ago`;
}

function showStaleIndicator(containerEl, cachedAt) {
    if (!containerEl) return;
    let dot = containerEl.querySelector('.stale-dot');
    if (!dot) {
        dot = document.createElement('span');
        dot.className = 'stale-dot';
        containerEl.appendChild(dot);
    }
    dot.setAttribute('data-cache-age', formatCacheAge(cachedAt));
    dot.classList.add('visible');
}

function hideStaleIndicator(containerEl) {
    if (!containerEl) return;
    const dot = containerEl.querySelector('.stale-dot');
    if (dot) {
        dot.classList.remove('visible');
    }
}

window.showStaleIndicator = showStaleIndicator;
window.hideStaleIndicator = hideStaleIndicator;
