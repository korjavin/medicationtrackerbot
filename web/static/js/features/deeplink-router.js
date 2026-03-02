// Deep-link and push-notification URL router.
// Handles path-based deep links (/bp_add, /weight_add),
// query-param deep links (?tab=…&action=add),
// push-action query params (?action=medication_confirm, etc.),
// and the Telegram start_param handshake.
//
// Loaded after app.js so all modal/tab helpers are available.
// handleDeepLinks is exposed on window for direct test invocation.

function handleDeepLinks() {
    // Path-based deep links: /bp_add, /weight_add
    const deepLinkRoutes = {
        '/bp_add': { tab: 'bp', open: showBPRecordModal },
        '/weight_add': { tab: 'weight', open: showWeightModal }
    };
    const currentPath = window.location.pathname;
    const deepLink = deepLinkRoutes[currentPath];
    if (deepLink) {
        if (deepLink.tab) {
            switchTab(deepLink.tab);
        }
        // Wait for data to load, then open modal
        setTimeout(() => {
            deepLink.open();
            // Clean up URL without reload
            window.history.replaceState({}, '', '/');
        }, 100);
        return;
    }

    // Query-param-based deep links and push actions
    const urlParams = new URLSearchParams(window.location.search);
    const action = urlParams.get('action');
    const tab = urlParams.get('tab');

    if (action === 'add') {
        // Handle ?tab=bp&action=add and ?tab=weight&action=add
        const tabAddModals = {
            'bp': showBPRecordModal,
            'weight': showWeightModal
        };
        const openFn = tab ? tabAddModals[tab] : null;
        if (tab) {
            switchTab(tab);
        }
        if (openFn) {
            setTimeout(() => {
                openFn();
                window.history.replaceState({}, '', '/');
            }, 100);
        } else {
            window.history.replaceState({}, '', '/');
        }
    } else if (action) {
        handlePushAction(action, urlParams);
        // Clean URL
        window.history.replaceState({}, '', '/');
    }
}
window.handleDeepLinks = handleDeepLinks;

// Check for Telegram start_param deep link (e.g. from bot button)
if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.start_param === 'bp_add') {
    // Wait for auth then open
    const checkInterval = setInterval(() => {
        if (typeof showBPRecordModal === 'function') {
            clearInterval(checkInterval);
            switchTab('bp');
            setTimeout(showBPRecordModal, 500);
        }
    }, 100);
}
