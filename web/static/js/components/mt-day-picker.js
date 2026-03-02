class MTDayPicker extends HTMLElement {
    connectedCallback() {
        if (this.dataset.initialized === 'true') return;
        this.dataset.initialized = 'true';

        this.classList.add('days-select');

        const days = [
            { id: 1, label: 'Mon' },
            { id: 2, label: 'Tue' },
            { id: 3, label: 'Wed' },
            { id: 4, label: 'Thu' },
            { id: 5, label: 'Fri' },
            { id: 6, label: 'Sat' },
            { id: 0, label: 'Sun' }
        ];

        days.forEach(day => {
            const span = document.createElement('span');
            span.dataset.day = day.id;
            span.textContent = day.label;
            this.appendChild(span);
        });

        this.addEventListener('click', (e) => {
            if (e.target.tagName === 'SPAN' && e.target.dataset.day !== undefined) {
                e.target.classList.toggle('selected');
                this.dispatchEvent(new CustomEvent('change', { detail: { value: this.value } }));
            }
        });
    }

    get value() {
        return Array.from(this.querySelectorAll('span.selected'))
            .map(s => parseInt(s.dataset.day, 10));
    }

    set value(daysArray) {
        if (!Array.isArray(daysArray)) daysArray = [];
        this.querySelectorAll('span').forEach(s => {
            if (daysArray.includes(parseInt(s.dataset.day, 10))) {
                s.classList.add('selected');
            } else {
                s.classList.remove('selected');
            }
        });
    }
}
window.MTDayPicker = MTDayPicker;
