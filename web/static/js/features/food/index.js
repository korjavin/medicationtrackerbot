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
//   - the collapsible library entry (toggleFoodLibraryView) that exposes
//     #food-meals-list (FoodMeals.load) and #fooddb-list (FoodDB.load)
//
// Module-level mutable state is allowed here for the orchestrator only:
// `foodControlsBound` is the once-flag for the bind IIFE, mirroring
// `workoutControlsBound` in the workout orchestrator. All other state has
// been pushed into the per-concern sub-files' IIFE closures (log.js,
// products.js, scanner.js, photo.js, meals.js, db.js).
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
}

function toggleFoodLibraryView() {
    const view = document.getElementById('food-library-view');
    const btn = document.getElementById('food-library-toggle-btn');
    if (!view || !btn) return;
    const nowVisible = view.classList.toggle('hidden') === false;
    btn.setAttribute('aria-expanded', nowVisible ? 'true' : 'false');
    btn.classList.toggle('wg-food-library-entry__btn--open', nowVisible);
    if (nowVisible) {
        if (typeof loadMyMeals === 'function') loadMyMeals();
        if (typeof loadFoodDB === 'function') loadFoodDB();
    }
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
        bindChange('food-photo-input', (e) => uploadFoodPhoto(e.target));
        bindClick('food-library-toggle-btn', () => toggleFoodLibraryView());

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

        bindClick('food-scanner-use-photo-btn', () => openPhotoPickerAndDecode());
        bindClick('food-scanner-close-btn', () => closeFoodScannerModal());
        bindClick('food-product-cancel-btn', () => closeFoodProductModal());
        bindClick('food-product-save-btn', () => saveFoodProduct());

        bindClick('food-save-meal-cancel-btn', () => closeFoodSaveMealModal());
        bindClick('food-save-meal-confirm-btn', () => confirmSaveMeal());

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
