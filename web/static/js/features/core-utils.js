(function () {
    const tg = window.Telegram.WebApp;
    tg.ready();
    tg.expand();

    window.tg = tg;

    // Safe Alert Helper
    window.safeAlert = function (msg) {
        console.log("Alert:", msg);
        if (tg && tg.showAlert) {
            try {
                tg.showAlert(msg);
            } catch (e) {
                alert(msg);
            }
        } else {
            alert(msg);
        }
    };

    window.formatDateTimeLocalForInput = function (dateValue = new Date()) {
        const localDate = dateValue instanceof Date ? new Date(dateValue.getTime()) : new Date(dateValue);
        localDate.setMinutes(localDate.getMinutes() - localDate.getTimezoneOffset());
        return localDate.toISOString().slice(0, 16);
    };

    window.downloadBlobAsFile = function (blob, filename) {
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(link);
    };

    window.formatDate = function (dateStr) {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        return date.toLocaleString('de-DE', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    };

    window.formatDateOnly = function (dateStr) {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        return date.toLocaleDateString('de-DE', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });
    };

    window.formatTimeOnly = function (dateStr) {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        return date.toLocaleTimeString('de-DE', {
            hour: '2-digit',
            minute: '2-digit'
        });
    };
})();
