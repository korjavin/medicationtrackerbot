(function () {
    const FEATURE_TOGGLE_IDS = {
        food: 'food-intake-toggle',
        bp: 'bp-feature-toggle',
        weight: 'weight-feature-toggle',
        health: 'health-feature-toggle',
        medication: 'medication-feature-toggle',
        workout: 'workout-feature-toggle'
    };

    window.applyFeatureSettings = function (settings) {
        if (!settings) return;
        window.featureSettings = { ...window.featureSettings, ...settings };
        window.featureSettingsLoaded = true;

        Object.entries(FEATURE_TOGGLE_IDS).forEach(([feature, id]) => {
            const input = document.getElementById(id);
            if (input) input.checked = !!window.featureSettings[feature];
        });
    };

    window.loadFeatureSettings = async function () {
        if (!window.DataStore) return;

        await window.DataStore.loadSWR({
            key: 'settings_features',
            tags: ['settings', 'feature_settings'],
            fetcher: async () => await window.apiCall('/api/settings/features', 'GET'),
            onCached: (cached) => window.applyFeatureSettings(cached),
            onFresh: (fresh) => window.applyFeatureSettings(fresh),
            onError: () => window.applyFeatureSettings({
                medication: true,
                workout: true,
                food: true,
                bp: true,
                weight: true,
                health: true
            })
        });
    };

    function applyFoodTargetsToInputs(targets) {
        const normalized = {
            calories: targets?.calories || 0,
            carbs: targets?.carbs || 0,
            protein: targets?.protein || 0,
            fat: targets?.fat || 0
        };
        window.foodTargets = normalized;

        const calories = document.getElementById('food-target-calories');
        const carbs = document.getElementById('food-target-carbs');
        const protein = document.getElementById('food-target-protein');
        const fat = document.getElementById('food-target-fat');

        if (calories) calories.value = normalized.calories || '';
        if (carbs) carbs.value = normalized.carbs || '';
        if (protein) protein.value = normalized.protein || '';
        if (fat) fat.value = normalized.fat || '';
    }

    window.loadFoodTargets = async function () {
        if (!window.DataStore) return;

        await window.DataStore.loadSWR({
            key: 'settings_food_targets',
            tags: ['settings', 'food_targets'],
            fetcher: async () => {
                let targets = await window.apiCall('/api/food/settings/targets', 'GET');
                if (!targets) {
                    // Compatibility fallback for older backend path.
                    targets = await window.apiCall('/api/settings/food/targets', 'GET');
                }
                return targets || { calories: 0, carbs: 0, protein: 0, fat: 0 };
            },
            onCached: (cached) => applyFoodTargetsToInputs(cached),
            onFresh: (fresh) => applyFoodTargetsToInputs(fresh),
            onError: () => applyFoodTargetsToInputs(window.foodTargets || {})
        });
    };

    window.saveFoodTargets = async function () {
        const payload = {
            calories: parseInt(document.getElementById('food-target-calories')?.value, 10) || 0,
            carbs: parseInt(document.getElementById('food-target-carbs')?.value, 10) || 0,
            protein: parseInt(document.getElementById('food-target-protein')?.value, 10) || 0,
            fat: parseInt(document.getElementById('food-target-fat')?.value, 10) || 0
        };

        let result = await window.apiCall('/api/food/settings/targets', 'POST', payload);
        if (!result) {
            // Compatibility fallback for older backend path.
            result = await window.apiCall('/api/settings/food/targets', 'POST', payload);
        }
        if (!result) return;

        applyFoodTargetsToInputs(payload);
        if (window.DataStore) await window.DataStore.invalidateTags(['settings', 'food_targets']);
        if (typeof window.safeAlert === 'function') window.safeAlert('Food targets saved');

        const currentTab = (window.AppStore && typeof window.AppStore.get === 'function' && window.AppStore.get('currentTab'))
            || document.querySelector('.view.active')?.id?.replace(/-view$/, '');
        if (currentTab === 'food' && typeof window.loadFoodLogs === 'function') {
            window.loadFoodLogs();
        }
    };

    window.saveTabOrder = async function (order) {
        if (!Array.isArray(order)) return;
        const res = await window.apiCall('/api/settings/tab-order', 'POST', { order });
        if (res) {
            if (typeof window.persistTabOrder === 'function') {
                window.persistTabOrder(order);
            }
            if (window.DataStore) {
                // Update local settings_bundle cache so it survives reload
                const cached = await window.DataStore.getCached('settings_bundle');
                if (cached) {
                    cached.tabOrder = order;
                    await window.DataStore.setCached('settings_bundle', cached);
                }
            }
        }
    };

    window.toggleFeatureSetting = async function (feature, enabled) {
        const result = await window.apiCall(`/api/settings/features/${feature}`, 'POST', { enabled });
        if (!result) return;

        const updated = { ...window.featureSettings, [feature]: enabled };
        window.applyFeatureSettings(updated);
        if (typeof window.rebuildCanonicalBottomNav === 'function') {
            window.rebuildCanonicalBottomNav();
        }
        if (window.DataStore) await window.DataStore.invalidateTags(['settings', 'feature_settings']);
    };

    async function loadReminderSettings() {
        const [bp, weight] = await Promise.all([
            window.apiCall('/api/bp/reminder/status', 'GET'),
            window.apiCall('/api/weight/reminder/status', 'GET')
        ]);

        const bpToggle = document.getElementById('bp-reminders-toggle');
        if (bpToggle) bpToggle.checked = !!bp?.enabled;

        const weightToggle = document.getElementById('weight-reminders-toggle');
        if (weightToggle) weightToggle.checked = !!weight?.enabled;
    }

    window.loadSettings = async function () {
        await Promise.allSettled([
            window.loadFeatureSettings(),
            window.loadFoodTargets(),
            loadReminderSettings()
        ]);
    };

    let settingsControlsBound = false;
    function bindSettingsControls() {
        if (settingsControlsBound) return;
        settingsControlsBound = true;

        const bindChange = (id, handler) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', handler);
        };
        const bindClick = (id, handler) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', handler);
        };

        bindChange('food-intake-toggle', async function () { await window.toggleFeatureSetting('food', this.checked); });
        bindChange('bp-feature-toggle', async function () { await window.toggleFeatureSetting('bp', this.checked); });
        bindChange('weight-feature-toggle', async function () { await window.toggleFeatureSetting('weight', this.checked); });
        bindChange('health-feature-toggle', async function () { await window.toggleFeatureSetting('health', this.checked); });
        bindChange('medication-feature-toggle', async function () { await window.toggleFeatureSetting('medication', this.checked); });
        bindChange('workout-feature-toggle', async function () { await window.toggleFeatureSetting('workout', this.checked); });

        bindChange('bp-reminders-toggle', async function () {
            const enabled = this.checked;
            const res = await window.apiCall('/api/bp/reminder/toggle', 'POST', { enabled });
            if (!res) this.checked = !enabled;
        });
        bindChange('weight-reminders-toggle', async function () {
            const enabled = this.checked;
            const res = await window.apiCall('/api/weight/reminder/toggle', 'POST', { enabled });
            if (!res) this.checked = !enabled;
        });

        bindClick('save-food-targets-btn', async () => { await window.saveFoodTargets(); });

        const WEBPUSH_VARIANTS = {
            success: ['status-success', 'wg-tag--mono--success'],
            error: ['status-error', 'wg-tag--mono--alert'],
            muted: ['status-muted', 'wg-tag--mono--muted'],
        };
        const WEBPUSH_VARIANT_CLASSES = [
            'status-success', 'status-error', 'status-muted',
            'wg-tag--mono--success', 'wg-tag--mono--alert', 'wg-tag--mono--muted',
        ];

        function applyStatus(status, text, variant) {
            status.textContent = text;
            status.classList.remove('wg-settings-hidden', ...WEBPUSH_VARIANT_CLASSES);
            const classes = WEBPUSH_VARIANTS[variant];
            if (classes) status.classList.add(...classes);
        }

        function hideStatus(status) {
            status.classList.add('wg-settings-hidden');
            status.classList.remove(...WEBPUSH_VARIANT_CLASSES);
        }

        bindChange('webpush-toggle', async function () {
            const status = document.getElementById('webpush-status');
            if (!status) return;

            if (!window.MedTrackerPush) {
                applyStatus(status, 'Push is unavailable', 'error');
                this.checked = false;
                return;
            }

            if (this.checked) {
                applyStatus(status, 'Requesting permission...', null);
                const success = await window.MedTrackerPush.subscribe();
                applyStatus(
                    status,
                    success ? 'Notifications enabled' : 'Failed to enable notifications',
                    success ? 'success' : 'error'
                );
                if (!success) this.checked = false;
            } else {
                const success = await window.MedTrackerPush.unsubscribe();
                applyStatus(
                    status,
                    success ? 'Notifications disabled' : 'Failed to disable notifications',
                    success ? 'muted' : 'error'
                );
                if (!success) this.checked = true;
            }

            setTimeout(() => hideStatus(status), 3000);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindSettingsControls, { once: true });
    }
    bindSettingsControls();
})();
