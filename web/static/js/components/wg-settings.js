// Wandergeek Settings-screen render helpers.
//
// Three deterministic DOM factories used by the Settings reskin (Phase 9):
//
//   WGSettings.section({ eyebrow, title, description, children }) -> HTMLElement
//       Renders a `.wg-card` with an optional uppercase `.wg-section-label`
//       eyebrow, a mono JetBrains-Mono section title, an optional muted
//       description, and a `.wg-settings-row-list` child container that
//       receives either a single child node or an array of child nodes.
//
//   WGSettings.row({ title, description, control }) -> HTMLElement
//       Renders a `.wg-settings-row` with a left column (mono title + muted
//       description) and a right column containing the caller-provided
//       control node (usually a <mt-setting-toggle>, a `.wg-gloss` button,
//       or a `.wg-gloss--inset` input wrap).
//
//   WGSettings.infoRow({ label, value }) -> HTMLElement
//       Renders a read-only label/value row. Used by the Timezone card for
//       rows like "Saved Timezone" / "Browser Local Time". Label is an
//       uppercase mono eyebrow; value is a mono display string. Both sides
//       are rendered as plain text (no HTML injection).
//
// The helpers are DOM factories, not templating strings — callers assemble
// the screen by appending the returned elements. No inline styles, no
// hardcoded colors: every visual value lives in styles.css under the
// Wandergeek Settings token group.

(function () {
    function appendChildren(container, children) {
        if (children == null) return;
        if (Array.isArray(children)) {
            for (const child of children) {
                if (child instanceof Node) {
                    container.appendChild(child);
                }
            }
            return;
        }
        if (children instanceof Node) {
            container.appendChild(children);
        }
    }

    function renderSection({ eyebrow, title, description, children } = {}) {
        const card = document.createElement('section');
        card.className = 'wg-card wg-settings-section';

        if (typeof eyebrow === 'string' && eyebrow.length > 0) {
            const eyebrowEl = document.createElement('div');
            eyebrowEl.className = 'wg-section-label wg-settings-section__eyebrow';
            const span = document.createElement('span');
            span.textContent = eyebrow;
            eyebrowEl.appendChild(span);
            card.appendChild(eyebrowEl);
        }

        if (typeof title === 'string' && title.length > 0) {
            const titleEl = document.createElement('h3');
            titleEl.className = 'wg-settings-section__title';
            titleEl.textContent = title;
            card.appendChild(titleEl);
        }

        if (typeof description === 'string' && description.length > 0) {
            const descEl = document.createElement('p');
            descEl.className = 'wg-settings-section__desc';
            descEl.textContent = description;
            card.appendChild(descEl);
        }

        const list = document.createElement('div');
        list.className = 'wg-settings-row-list';
        appendChildren(list, children);
        card.appendChild(list);

        return card;
    }

    function renderRow({ title, description, control } = {}) {
        const row = document.createElement('div');
        row.className = 'wg-settings-row';

        const content = document.createElement('div');
        content.className = 'wg-settings-row__content';

        if (typeof title === 'string' && title.length > 0) {
            const titleEl = document.createElement('div');
            titleEl.className = 'wg-settings-row__title';
            titleEl.textContent = title;
            content.appendChild(titleEl);
        }

        if (typeof description === 'string' && description.length > 0) {
            const descEl = document.createElement('div');
            descEl.className = 'wg-settings-row__desc';
            descEl.textContent = description;
            content.appendChild(descEl);
        }

        row.appendChild(content);

        const controlSlot = document.createElement('div');
        controlSlot.className = 'wg-settings-row__control';
        if (control instanceof Node) {
            controlSlot.appendChild(control);
        }
        row.appendChild(controlSlot);

        return row;
    }

    function renderInfoRow({ label, value } = {}) {
        const row = document.createElement('div');
        row.className = 'wg-settings-info-row';

        const labelEl = document.createElement('span');
        labelEl.className = 'wg-settings-info-row__label';
        labelEl.textContent = typeof label === 'string' ? label : '';
        row.appendChild(labelEl);

        const valueEl = document.createElement('span');
        valueEl.className = 'wg-settings-info-row__value wg-mono-display';
        valueEl.textContent = typeof value === 'string' ? value : (value == null ? '' : String(value));
        row.appendChild(valueEl);

        return row;
    }

    window.WGSettings = {
        section: renderSection,
        row: renderRow,
        infoRow: renderInfoRow,
    };
})();
