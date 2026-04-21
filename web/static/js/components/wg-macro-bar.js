// Wandergeek macro-bar — deterministic DOM renderer for the Food screen's
// four macro rows (Energy / Protein / Carbs / Fat). Ported from the
// handoff prototype (screens.jsx:MacroRow, lines 368-381) with these
// constraints:
//
//   • No inline style= attributes and no hardcoded colors. The fill
//     color comes from a `.wg-macro-bar__fill--<variant>` class and
//     styles.css maps each variant to the matching Food palette token.
//   • The only dynamic inline style is the fill width, applied via
//     style.setProperty on a neutral CSS custom property (`--fill-pct`)
//     that the CSS class reads with `width: var(--fill-pct, 0%)`.
//
// API:
//   WGMacroBar.render({ label, value, target, unit, variant }) → HTMLElement
//
//   label    — short row label (e.g. "Energy"). Falls back to empty string.
//   value    — numeric consumed-so-far value. Non-finite → 0.
//   target   — numeric daily target. Non-finite / <= 0 → fill clamps to 0%.
//   unit     — suffix rendered after the target ("kcal", "g", …). Optional.
//   variant  — 'energy' | 'protein' | 'carbs' | 'fat'. Unknown variants
//              omit the fill variant class (still renders, just no color).
//
// The rendered DOM:
//   <div class="wg-macro-bar">
//     <div class="wg-macro-bar__label">{label}</div>
//     <div class="wg-macro-bar__track wg-gloss--inset">
//       <div class="wg-macro-bar__fill wg-macro-bar__fill--<variant>"
//            style via setProperty('--fill-pct', '<pct>%')></div>
//     </div>
//     <div class="wg-macro-bar__value">
//       <span class="wg-macro-bar__value-current">{value}</span>
//       <span class="wg-macro-bar__value-target"> / {target} {unit}</span>
//     </div>
//   </div>

(function () {
    const VARIANTS = new Set(['energy', 'protein', 'carbs', 'fat']);

    function finiteOrZero(value) {
        return Number.isFinite(value) ? value : 0;
    }

    function computePercent(value, target) {
        const v = finiteOrZero(Number(value));
        const t = Number(target);
        if (!Number.isFinite(t) || t <= 0) return 0;
        const raw = (v / t) * 100;
        if (raw < 0) return 0;
        if (raw > 100) return 100;
        return raw;
    }

    function formatNumber(n) {
        if (!Number.isFinite(n)) return '0';
        // Drop decimals for whole numbers, keep at most one for fractional.
        if (Number.isInteger(n)) return String(n);
        return (Math.round(n * 10) / 10).toString();
    }

    function renderMacroBar(opts) {
        const options = opts || {};
        const label = typeof options.label === 'string' ? options.label : '';
        const value = finiteOrZero(Number(options.value));
        const target = Number(options.target);
        const unit = typeof options.unit === 'string' ? options.unit : '';
        const variant = typeof options.variant === 'string' ? options.variant : '';

        const row = document.createElement('div');
        row.classList.add('wg-macro-bar');

        const labelEl = document.createElement('div');
        labelEl.classList.add('wg-macro-bar__label');
        labelEl.textContent = label;
        row.appendChild(labelEl);

        const track = document.createElement('div');
        track.classList.add('wg-macro-bar__track', 'wg-gloss--inset');

        const fill = document.createElement('div');
        fill.classList.add('wg-macro-bar__fill');
        if (VARIANTS.has(variant)) {
            fill.classList.add(`wg-macro-bar__fill--${variant}`);
        }
        const pct = computePercent(value, target);
        fill.style.setProperty('--fill-pct', `${pct}%`);
        track.appendChild(fill);
        row.appendChild(track);

        const valueEl = document.createElement('div');
        valueEl.classList.add('wg-macro-bar__value');

        const current = document.createElement('span');
        current.classList.add('wg-macro-bar__value-current');
        current.textContent = formatNumber(value);
        valueEl.appendChild(current);

        const targetSpan = document.createElement('span');
        targetSpan.classList.add('wg-macro-bar__value-target');
        const targetLabel = Number.isFinite(target) && target > 0 ? formatNumber(target) : '—';
        const unitSuffix = unit ? ` ${unit}` : '';
        targetSpan.textContent = ` / ${targetLabel}${unitSuffix}`;
        valueEl.appendChild(targetSpan);

        row.appendChild(valueEl);

        return row;
    }

    window.WGMacroBar = {
        render: renderMacroBar,
        VARIANTS: Array.from(VARIANTS),
    };
})();
