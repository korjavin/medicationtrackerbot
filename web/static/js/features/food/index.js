// ====================================
// FOOD — Orchestrator
// ====================================
//
// Thin orchestrator for the Food section. Owns:
//   - top-level controls binding (#bindFoodControls — date-nav buttons,
//     toolbar +Add buttons, macros toggle, modal Cancel/Save, scanner +
//     product modal buttons, FoodDB search/sort/pagination, food-modal
//     inputs)
//   - icon hydration for the day-nav / modal / inline-add buttons
//   - the Daily / Weekly macros toggle (setFoodMacrosRange)
//   - the Log / Food DB sub-tab strip (switchFoodTab)
//
// Module-level mutable state is allowed here for the orchestrator only:
// `foodControlsBound` is the once-flag for the bind IIFE, mirroring
// `workoutControlsBound` in the workout orchestrator. All other state has
// been pushed into the per-concern sub-files' IIFE closures (log.js,
// products.js, scanner.js, photo.js, db.js).
//
// Load order: this file MUST be loaded last in the food sub-tree because
// `bindFoodControls` references handlers declared in the other files.

function renderFoodDayNavIcons() {
    const prev = document.getElementById('food-date-prev-btn');
    const next = document.getElementById('food-date-next-btn');
    if (!window.WGIcons || typeof window.WGIcons.iconSvg !== 'function') return;
    if (prev && !prev.querySelector('svg')) {
        prev.replaceChildren(window.WGIcons.iconSvg('chevronLeft'));
    }
    if (next && !next.querySelector('svg')) {
        next.replaceChildren(window.WGIcons.iconSvg('chevronRight'));
    }
}

function renderFoodModalIcons() {
    if (!window.WGIcons || typeof window.WGIcons.iconSvg !== 'function') return;
    const scanBtn = document.getElementById('food-scan-btn');
    if (scanBtn && !scanBtn.querySelector('svg')) {
        const icon = window.WGIcons.iconSvg('barcode', { size: 14 });
        scanBtn.insertBefore(icon, scanBtn.firstChild);
    }
}

function renderFoodInlineAddIcon() {
    if (!window.WGIcons || typeof window.WGIcons.iconSvg !== 'function') return;
    const btn = document.getElementById('add-food-inline-btn');
    if (btn && !btn.querySelector('svg')) {
        btn.insertBefore(window.WGIcons.iconSvg('plus', { size: 14 }), btn.firstChild);
    }
    const photoBtn = document.getElementById('add-food-photo-btn');
    if (photoBtn && !photoBtn.querySelector('svg')) {
        photoBtn.insertBefore(window.WGIcons.iconSvg('camera', { size: 14 }), photoBtn.firstChild);
    }
    const scanBtn = document.getElementById('scan-food-inline-btn');
    if (scanBtn && !scanBtn.querySelector('svg')) {
        scanBtn.insertBefore(window.WGIcons.iconSvg('barcode', { size: 14 }), scanBtn.firstChild);
    }
}

// Food sub-tab strip (med-ejq.3). Same shape as switchMedTab /
// switchWorkoutTab: TabController owns the pane + `.active` toggling, and a
// sibling sync paints the gloss pills, mirroring syncMedsSubTabActiveClass.
function syncFoodSubTabActiveClass(activeTab) {
    const container = document.querySelector('.wg-food-subtabs');
    if (!container) return;
    container.querySelectorAll('.food-tab').forEach((btn) => {
        const isActive = btn.dataset.tab === activeTab;
        btn.classList.toggle('wg-gloss--sun', isActive);
        btn.classList.toggle('wg-food-subtabs__btn--active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

function switchFoodTab(tab) {
    const activated = window.TabController.activateTabGroup(tab, {
        buttonSelector: '.food-tab',
        contentSelector: '.food-tab-content',
        contentIdFromTab: (name) => `food-${name}-tab`
    });
    if (!activated) return;

    syncFoodSubTabActiveClass(tab);
    if (tab === 'fooddb' && typeof loadFoodDB === 'function') loadFoodDB();
}

(function () {
    let foodControlsBound = false;

    function bindFoodControls() {
        if (foodControlsBound) return;
        foodControlsBound = true;

        const bindClick = (id, handler) => {
            const element = document.getElementById(id);
            if (element) element.addEventListener('click', handler);
        };
        const bindChange = (id, handler) => {
            const element = document.getElementById(id);
            if (element) element.addEventListener('change', handler);
        };
        const bindInput = (id, handler) => {
            const element = document.getElementById(id);
            if (element) element.addEventListener('input', handler);
        };
        const bindFocus = (id, handler) => {
            const element = document.getElementById(id);
            if (element) element.addEventListener('focus', handler);
        };

        let foodDBSearchTimeout;
        bindInput('fooddb-search', (e) => {
            clearTimeout(foodDBSearchTimeout);
            foodDBSearchTimeout = setTimeout(() => {
                window.FoodDB.query = e.target.value.trim();
                window.FoodDB.page = 0;
                loadFoodDB();
            }, 300);
        });

        const sortBtns = document.querySelectorAll('.fooddb-sort-btn');
        sortBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const target = e.currentTarget;
                sortBtns.forEach(b => {
                    b.classList.remove('active');
                    b.classList.remove('wg-gloss--sun');
                    b.setAttribute('aria-pressed', 'false');
                });
                target.classList.add('active');
                target.classList.add('wg-gloss--sun');
                target.setAttribute('aria-pressed', 'true');
                window.FoodDB.sort = target.dataset.sort;
                window.FoodDB.page = 0;
                loadFoodDB();
            });
        });

        bindClick('fooddb-prev-btn', () => {
            if (window.FoodDB.page > 0) {
                window.FoodDB.page = window.FoodDB.page - 1;
                loadFoodDB();
            }
        });

        bindClick('fooddb-next-btn', () => {
            const limit = 20;
            if ((window.FoodDB.page + 1) * limit < window.FoodDB.total) {
                window.FoodDB.page = window.FoodDB.page + 1;
                loadFoodDB();
            }
        });

        bindClick('add-food-inline-btn', () => showAddFoodModal());
        bindClick('add-food-photo-btn', () => triggerFoodPhotoPicker());
        bindClick('scan-food-inline-btn', () => {
            if (typeof showAddFoodModal === 'function') {
                showAddFoodModal();
            }
            if (typeof openFoodScannerModal === 'function') {
                openFoodScannerModal();
            }
        });
        bindChange('food-photo-input', (e) => uploadFoodPhoto(e.target));

        window.TabController.bindTabGroup({
            container: document.querySelector('.food-tabs'),
            buttonSelector: '.food-tab',
            onTabSelect: switchFoodTab
        });

        const macrosToggle = document.getElementById('food-macros-toggle');
        if (macrosToggle) {
            macrosToggle.querySelectorAll('.wg-food-macros-card__toggle-btn').forEach((btn) => {
                btn.addEventListener('click', () => setFoodMacrosRange(btn.dataset.range));
            });
        }

        bindClick('food-date-prev-btn', () => shiftFoodDate(-1));
        bindClick('food-date-next-btn', () => shiftFoodDate(1));
        bindClick('food-date-label', () => {
            const dateFilter = document.getElementById('food-date-filter');
            if (dateFilter) {
                if (typeof dateFilter.showPicker === 'function') {
                    dateFilter.showPicker();
                } else {
                    dateFilter.focus();
                    dateFilter.click();
                }
            }
        });
        bindChange('food-date-filter', () => loadFoodLogs());

        bindClick('food-modal-cancel-btn', () => closeFoodModal());
        bindClick('food-modal-save-btn', () => saveFoodLog());
        bindInput('food-weight', () => calculateFoodCalories());
        bindInput('food-barcode', () => onFoodBarcodeChange());
        bindClick('food-scan-btn', () => openFoodScannerModal());
        bindInput('food-name', () => onFoodNameChange());
        bindFocus('food-name', () => onFoodNameFocus());
        bindInput('food-carbs', () => calculateFoodCalories());
        bindInput('food-protein', () => calculateFoodCalories());
        bindInput('food-fat', () => calculateFoodCalories());
        bindChange('food-per-100g', () => onFoodPer100gChange());
        bindFocus('food-calories', () => onFoodCaloriesFocus());

        if (typeof bindFoodParseAIToggle === 'function') {
            bindFoodParseAIToggle();
        }

        bindClick('food-scanner-use-photo-btn', () => openPhotoPickerAndDecode());
        bindClick('food-scanner-close-btn', () => closeFoodScannerModal());
        bindClick('food-product-cancel-btn', () => closeFoodProductModal());
        bindClick('food-product-save-btn', () => saveFoodProduct());

        renderFoodDayNavIcons();
        renderFoodModalIcons();
        renderFoodInlineAddIcon();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindFoodControls, { once: true });
    } else {
        bindFoodControls();
    }
})();
