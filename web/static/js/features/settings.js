(function () {
    window.loadFeatureSettings = async function () {
        if (!window.DataStore || window.featureSettingsLoaded) return;
        await window.DataStore.loadSWR({
            key: 'settings_features', tags: ['settings'],
            fetcher: async () => await window.apiCall('/api/settings/features', 'GET'),
            onCached: (cached) => window.applyFeatureSettings(cached),
            onFresh: (fresh) => { window.featureSettingsLoaded = true; window.applyFeatureSettings(fresh); },
            onError: () => window.applyFeatureSettings({ medication: true, workout: true }) // defaults
        });
    };

    window.applyFeatureSettings = function (settings) {
        if (!settings) return;
        window.featureSettings = settings;
        const tabs = {
            'tab-med-link': settings.medication,
            'tab-workout-link': settings.workout,
            'tab-food-link': settings.food,
            'tab-bp-link': settings.bp,
            'tab-weight-link': settings.weight,
            'tab-health-link': settings.health
        };
        Object.entries(tabs).forEach(([id, show]) => {
            const el = document.getElementById(id); if (el) el.style.display = show ? 'flex' : 'none';
        });
        const currentActive = document.querySelector('#tabs .tab.active');
        if (currentActive && currentActive.style.display === 'none') {
            const firstVisible = document.querySelector('#tabs .tab:not([style*="display: none"])');
            if (firstVisible) window.switchTab(firstVisible.dataset.tab);
        }
        window.renderTabSettings(settings);
    };

    window.renderTabSettings = function (settings) {
        const container = document.getElementById('settings-features-list');
        if (!container) return;
        container.replaceChildren();
        const card = document.createElement('mt-card'); card.innerHTML = '<h3 style="margin-top:0;">Enabled Features</h3><p style="color:var(--hint-color);font-size:0.9em;">Toggle whole tabs on or off.</p>';
        const list = document.createElement('div'); list.style.cssText = 'display:flex;flex-direction:column;gap:12px;margin-top:20px;';

        const toggles = [
            { key: 'medication', label: 'Medications', icon: '💊' },
            { key: 'workout', label: 'Workouts', icon: '💪' },
            { key: 'food', label: 'Food Logging', icon: '🍎' },
            { key: 'bp', label: 'Blood Pressure', icon: '💓' },
            { key: 'weight', label: 'Weight Tracking', icon: '⚖️' },
            { key: 'health', label: 'Health Vitals', icon: '🫀' }
        ];

        toggles.forEach(t => {
            const row = document.createElement('mt-setting-toggle');
            row.setAttribute('label', `${t.icon} ${t.label}`);
            if (settings[t.key]) row.setAttribute('checked', '');
            row.onchange = async () => {
                const updated = { ...window.featureSettings, [t.key]: row.checked };
                try {
                    await window.apiCall('/api/settings/features', 'POST', updated);
                    window.applyFeatureSettings(updated);
                    if (window.DataStore) await window.DataStore.invalidateTags(['settings']);
                } catch (e) { window.safeAlert('Failed to save settings'); row.checked = !row.checked; }
            };
            list.appendChild(row);
        });
        card.appendChild(list); container.appendChild(card);
    };

    window.loadFoodTargets = async function () {
        if (!window.DataStore) return;
        await window.DataStore.loadSWR({
            key: 'settings_food_targets', tags: ['settings'],
            fetcher: async () => await window.apiCall('/api/settings/food/targets', 'GET'),
            onCached: (cached) => { if (cached) window.foodTargets = cached; window.renderFoodTargetsSettings(cached); },
            onFresh: (fresh) => { if (fresh) window.foodTargets = fresh; window.renderFoodTargetsSettings(fresh); }
        });
    };

    window.renderFoodTargetsSettings = function (targets) {
        const container = document.getElementById('settings-food-targets-list');
        if (!container) return;
        container.replaceChildren();
        const card = document.createElement('mt-card'); card.innerHTML = '<h3 style="margin-top:0;">Food Targets</h3><p style="color:var(--hint-color);font-size:0.9em;">Daily goals for macros.</p>';
        const list = document.createElement('div'); list.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:15px;';

        const inputs = [
            { key: 'calories', label: 'Calories', unit: 'kcal' },
            { key: 'carbs', label: 'Carbs', unit: 'g' },
            { key: 'protein', label: 'Protein', unit: 'g' },
            { key: 'fat', label: 'Fat', unit: 'g' }
        ];

        inputs.forEach(i => {
            const div = document.createElement('div');
            div.innerHTML = `<label style="display:block;font-size:0.8em;color:var(--hint-color);">${i.label} (${i.unit})</label><input type="number" id="target-${i.key}" value="${targets?.[i.key] || 0}" style="width:100%;box-sizing:border-box;">`;
            list.appendChild(div);
        });

        const saveBtn = document.createElement('button'); saveBtn.className = 'primary'; saveBtn.style.marginTop = '15px'; saveBtn.textContent = 'Save Food Targets';
        saveBtn.onclick = async () => {
            const updated = {}; inputs.forEach(i => updated[i.key] = parseInt(document.getElementById(`target-${i.key}`).value) || 0);
            try {
                await window.apiCall('/api/settings/food/targets', 'POST', updated);
                window.foodTargets = updated;
                if (window.DataStore) await window.DataStore.invalidateTags(['settings']);
                window.safeAlert('Targets saved');
            } catch (e) { window.safeAlert('Failed to save targets'); }
        };
        card.appendChild(list); card.appendChild(saveBtn); container.appendChild(card);
    };
})();
