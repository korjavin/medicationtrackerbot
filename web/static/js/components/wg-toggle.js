// Wandergeek toggle primitive.
//
// Renders the kit .wg-toggle pill (css/components.css) driven by a hidden
// <input type="checkbox"> so the existing change-event + id-based wiring in
// app.js (the document.getElementById('<feature>-feature-toggle')
// .addEventListener block near loadSettings()) keeps binding without
// modification. The label itself is the pill and its ::after the knob; both
// paint from the checkbox's :checked state.
//
// API:
//   WGToggle.render({ id, checked, disabled, ariaLabel, onToggle }) -> HTMLElement
//
// The returned element is a <label class="wg-toggle"> containing a hidden
// `<input type="checkbox" id="...">`. The hidden input
// is the source of truth for state — callers can still do
// `document.getElementById(id).checked` and listen for `change`.

(function () {
    function renderToggle({ id, checked, disabled, ariaLabel, onToggle } = {}) {
        const label = document.createElement('label');
        label.className = 'wg-toggle';
        if (disabled) {
            label.classList.add('wg-toggle--disabled');
        }

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'wg-toggle__input';
        if (id) input.id = id;
        if (checked) input.checked = true;
        if (disabled) input.disabled = true;
        if (ariaLabel) input.setAttribute('aria-label', ariaLabel);

        if (typeof onToggle === 'function') {
            input.addEventListener('change', (e) => {
                onToggle(e.target.checked, e);
            });
        }

        label.appendChild(input);
        return label;
    }

    window.WGToggle = { render: renderToggle };
})();
