// Doctor-visit brief (epic med-5k6t, bead med-5k6t.2) — the presentation half.
//
// A Today-screen shortcut opens #brief-modal (range picker + section
// checkboxes); Print and Download both build ONE standalone HTML string from
// GET /api/brief and hand it to web/cloud/js/print-doc.js. There is no PDF
// library and no server round-trip for rendering: a print stylesheet plus the
// browser's own print-to-PDF IS the feature, and the document never leaves the
// device (no privacy-manifest entry, by design).
//
// The document is deliberately a plain string rather than DOM: it has to
// survive being opened from the Downloads folder years later with no network
// and no stylesheet, exactly like the Emergency Kit in signup.js.

(function () {
    'use strict';

    const DEFAULT_DAYS = 90;

    // How much of a note the picker shows. Long enough to recognise the entry,
    // short enough that 50 of them (web/domain/brief.js NOTES_LIMIT) still
    // scan as a list.
    const NOTE_PREVIEW_CHARS = 90;

    // Mirrors web/domain/brief.js SECTION_ORDER / DEFAULT_SECTIONS. The
    // checkbox defaults live in index.html; this list only fixes doc order.
    const SECTION_ORDER = ['meds', 'bp', 'weight', 'vitals', 'notes', 'food', 'workouts'];

    const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

    // Local rather than window.escapeHtml: that one returns '' for any falsy
    // input, which would silently blank a 0 adherence or a 0 kcal average.
    function esc(v) {
        return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ESC[c]);
    }

    function preferredUnit() {
        return (typeof window !== 'undefined' && window.weightUnitPreference === 'lb') ? 'lb' : 'kg';
    }

    // core/utils.js owns the single KG_PER_LB in the app; the brief payload is
    // always kilograms (web/domain/brief.js weightSection), so every weight
    // number printed here goes through this. Getting it wrong hands a doctor a
    // figure 2.2x off.
    function weightDisplay(kg, unit) {
        const fmt = (typeof formatWeight === 'function')
            ? formatWeight
            : (v, u) => ({ value: Number(v), label: u });
        return fmt(kg, unit);
    }

    function fmtDate(iso) {
        const s = String(iso || '');
        return s.length >= 10 ? s.slice(0, 10) : s;
    }

    function fmtPct(v) {
        return (typeof v === 'number' && Number.isFinite(v)) ? `${v}%` : '—';
    }

    function fmtNum(v) {
        return (typeof v === 'number' && Number.isFinite(v)) ? String(v) : '—';
    }

    // Round the TOTAL before splitting: rounding the remainder alone renders
    // 119.6 as "1h 60m", because the hour was floored off the unrounded value.
    function fmtDuration(minutes) {
        if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return '—';
        const total = Math.round(minutes);
        const h = Math.floor(total / 60);
        return h > 0 ? `${h}h ${total % 60}m` : `${total}m`;
    }

    function block(title, body) {
        return `<section class="blk">\n<h2>${esc(title)}</h2>\n${body}\n</section>`;
    }

    function statRow(label, s, suffix) {
        if (!s) return '';
        const u = suffix ? ` ${esc(suffix)}` : '';
        return `<tr><th>${esc(label)}</th><td>${fmtNum(s.avg)}${u}</td>`
            + `<td>${fmtNum(s.min)}</td><td>${fmtNum(s.max)}</td></tr>`;
    }

    // ponytail: the literal colors below are intentional — this document
    // renders OUTSIDE the app, where --wg-* tokens do not exist, and it is
    // printed on white paper. Same precedent as buildKitDocument in
    // web/cloud/js/signup.js. The chart rules restate the .wg-bp-chart__* /
    // .wg-weight-chart__* / .wg-sleep-chart__* class contract from styles.css
    // with a fixed print palette, because the SVGs are serialized verbatim
    // from the live components and carry only those classes.
    const DOC_CSS = `
  * { box-sizing: border-box; }
  body { font: 13px/1.5 system-ui, -apple-system, sans-serif; color: #111; background: #fff;
         max-width: 48rem; margin: 1.5rem auto; padding: 0 1rem; }
  header { border-bottom: 2px solid #111; padding-bottom: 0.5rem; margin-bottom: 1.25rem; }
  h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
  h2 { font-size: 1rem; margin: 0 0 0.5rem; text-transform: uppercase; letter-spacing: 0.08em; }
  .meta { color: #444; font-size: 0.85rem; }
  .blk { margin-bottom: 1.5rem; break-inside: avoid; page-break-inside: avoid; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.3rem 0.4rem; border-bottom: 1px solid #ddd; vertical-align: top; }
  thead th { border-bottom: 1px solid #111; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  ul { margin: 0; padding-left: 1.1rem; }
  li { margin-bottom: 0.35rem; }
  .note-date { color: #555; font-variant-numeric: tabular-nums; }
  p.stat { margin: 0.4rem 0 0; }
  .chart { margin-top: 0.75rem; }
  svg { width: 100%; height: auto; max-width: 26rem; }
  footer { margin-top: 2rem; padding-top: 0.5rem; border-top: 1px solid #ddd;
           color: #555; font-size: 0.78rem; }
  .wg-bp-chart__guide, .wg-weight-chart__guide { stroke: #bbb; stroke-width: 1; stroke-dasharray: 3 3; fill: none; }
  .wg-bp-chart__band { fill: #cfe3dd; fill-opacity: 0.5; stroke: none; }
  .wg-bp-chart__sys, .wg-weight-chart__line { fill: none; stroke: #1f6f5c; stroke-width: 2;
                                              stroke-linecap: round; stroke-linejoin: round; }
  .wg-bp-chart__dia { fill: none; stroke: #7ba79b; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .wg-bp-chart__last, .wg-weight-chart__last { fill: #b8860b; stroke: #1f6f5c; stroke-width: 1.5; }
  .wg-weight-chart__goal { stroke: #b8860b; stroke-width: 1.5; stroke-dasharray: 4 3; fill: none; }
  .wg-weight-chart__plan, .wg-weight-chart__trend { stroke: #999; stroke-width: 1.5;
                                                    stroke-dasharray: 4 3; fill: none; }
  .wg-bp-chart__axis-tick, .wg-weight-chart__y-tick-label, .wg-weight-chart__x-tick-label,
  .wg-weight-chart__goal-label { fill: #444; font-family: inherit; font-size: 9px;
                                 font-variant-numeric: tabular-nums; }
  .wg-bp-chart__axis-tick[data-bp-axis="y"] { text-anchor: end; }
  .wg-bp-chart__axis-tick[data-bp-axis="x"] { text-anchor: middle; }
  .wg-sleep-chart__stage { stroke: none; }
  .wg-sleep-chart__stage--deep { fill: #4a2585; }
  .wg-sleep-chart__stage--light { fill: #2a6fb0; }
  .wg-sleep-chart__stage--rem { fill: #9a4fb0; }
  .wg-sleep-chart__stage--awake { fill: #c9971a; }
  .wg-sleep-chart__guide { stroke: #bbb; stroke-width: 1; stroke-dasharray: 3 3; fill: none; }
  .wg-sleep-chart__tick { stroke: #444; fill: none; }
  .wg-sleep-chart__hr-line { fill: none; stroke: #c0392b; stroke-width: 2;
                             stroke-linecap: round; stroke-linejoin: round; }
  .wg-sleep-chart__hr-dot-outer { fill: #fff; stroke: none; }
  .wg-sleep-chart__hr-dot { fill: #c0392b; stroke: none; }
  .wg-sleep-chart__hr-label { fill: #c0392b; font-weight: 700; stroke: none; }
  .wg-sleep-chart__axis-label, .wg-sleep-chart__day-label { fill: #444; }
  .wg-sleep-chart__bar-label { fill: #111; }
  .wg-sleep-chart__axis-label, .wg-sleep-chart__day-label,
  .wg-sleep-chart__bar-label, .wg-sleep-chart__hr-label {
    font-family: inherit; font-size: 9px; font-variant-numeric: tabular-nums; }
  @media print {
    body { margin: 0; max-width: none; font-size: 11px; }
    @page { size: A4; margin: 14mm; }
  }`;

    // An as-needed med has no schedule to be adherent to (web/domain/brief.js
    // sends as_needed + times_taken and adherence_pct null for it), so the
    // Adherence cell must never print a percentage for one — the count is the
    // honest number a doctor can read.
    function adherenceCell(m) {
        if (!m.as_needed) return fmtPct(m.adherence_pct);
        const n = Number(m.times_taken) || 0;
        return n === 1 ? 'taken 1 time' : `taken ${n} times`;
    }

    // What the percentage alone hides: missed doses vs merely-late ones (bd
    // med-29gh.2). The average clause only appears when something was actually
    // delayed — "average delay —" would say nothing.
    function adherenceDetailLine(detail) {
        if (!detail || typeof detail !== 'object') return '';
        const parts = [`missed ${fmtNum(detail.missed)}`, `delayed ${fmtNum(detail.delayed)}`];
        if (typeof detail.avg_delay_minutes === 'number' && Number.isFinite(detail.avg_delay_minutes)) {
            parts.push(`average delay ${fmtDuration(detail.avg_delay_minutes)}`);
        }
        return `<p class="stat">${esc(parts.join(', '))}</p>`;
    }

    function medsBlock(data) {
        const meds = Array.isArray(data.medications) ? data.medications : null;
        if (!meds || meds.length === 0) return '';
        const rows = meds.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.dosage)}</td>`
            + `<td>${esc(m.schedule_summary)}</td><td>${esc(fmtDate(m.started_at))}</td>`
            + `<td class="num">${esc(adherenceCell(m))}</td></tr>`).join('\n');
        const overall = (typeof data.overall_adherence_pct === 'number')
            ? `<p class="stat">Overall adherence: <strong>${esc(fmtPct(data.overall_adherence_pct))}</strong></p>`
            : '';
        return block('Medications', `<table>
<thead><tr><th>Medication</th><th>Dose</th><th>Schedule</th><th>Since</th><th class="num">Adherence</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>${overall}${adherenceDetailLine(data.adherence_detail)}`);
    }

    function bpBlock(data, charts) {
        const bp = data.bp;
        if (!bp || !bp.count) return '';
        const goal = bp.goal || {};
        const goalLine = (goal.target_systolic || goal.target_diastolic)
            ? `<p class="stat">Goal: ${esc(fmtNum(goal.target_systolic))}/${esc(fmtNum(goal.target_diastolic))} mmHg</p>`
            : '';
        const chart = charts.bp ? `<div class="chart">${charts.bp}</div>` : '';
        return block('Blood pressure', `<table>
<thead><tr><th></th><th>Avg</th><th>Min</th><th>Max</th></tr></thead>
<tbody>
${statRow('Systolic', bp.systolic, 'mmHg')}
${statRow('Diastolic', bp.diastolic, 'mmHg')}
${statRow('Pulse', bp.pulse, 'bpm')}
</tbody>
</table>
<p class="stat">${esc(String(bp.count))} reading${bp.count === 1 ? '' : 's'} in range.</p>${goalLine}${chart}`);
    }

    function weightBlock(data, unit, charts) {
        const w = data.weight;
        if (!w || !Array.isArray(w.points) || w.points.length === 0) return '';
        const start = weightDisplay(w.start, unit);
        const end = weightDisplay(w.end, unit);
        const delta = weightDisplay(w.delta, unit);
        const sign = delta.value > 0 ? '+' : '';
        const chart = charts.weight ? `<div class="chart">${charts.weight}</div>` : '';
        return block('Weight', `<p class="stat">Start <strong>${esc(String(start.value))} ${esc(start.label)}</strong>`
            + ` → end <strong>${esc(String(end.value))} ${esc(end.label)}</strong>`
            + ` (${esc(sign + String(delta.value))} ${esc(delta.label)} over ${esc(String(w.points.length))} entries).</p>${chart}`);
    }

    function has(v) {
        return v !== null && v !== undefined;
    }

    function vitalsBlock(data, charts) {
        const v = data.vitals;
        if (!v) return '';
        const parts = [];
        if (has(v.avg_sleep_minutes)) parts.push(`average sleep ${esc(fmtDuration(v.avg_sleep_minutes))}`);
        if (has(v.resting_hr)) parts.push(`resting heart rate ${esc(fmtNum(v.resting_hr))} bpm`);
        if (parts.length === 0) return '';
        // The caption is not decoration: renderCharts draws only the last 30
        // days (90 or 180 daily bars in a 358-unit coord space are unreadable),
        // while the sentence above averages the FULL range. Without it a doctor
        // reads the bars as spanning the range in the header.
        const chart = charts.sleep
            ? `<div class="chart">${charts.sleep}</div>`
                + '<p class="stat">Sleep chart: last 30 days shown.</p>'
            : '';
        return block('Vitals', `<p class="stat">${parts.join(', ')}.</p>${chart}`);
    }

    function notesBlock(data) {
        const notes = Array.isArray(data.notes) ? data.notes : null;
        if (!notes || notes.length === 0) return '';
        const items = notes.map((n) => `<li><span class="note-date">${esc(n.date)}</span> — ${esc(n.text)}</li>`).join('\n');
        return block('Notes', `<ul>\n${items}\n</ul>`);
    }

    function foodBlock(data) {
        const f = data.food;
        if (!f || !f.days_logged) return '';
        const t = f.targets || {};
        const target = (key) => ((typeof t[key] === 'number') ? ` (target ${esc(fmtNum(t[key]))})` : '');
        return block('Nutrition', `<table>
<thead><tr><th>Daily average</th><th class="num">Value</th></tr></thead>
<tbody>
<tr><th>Calories</th><td class="num">${esc(fmtNum(f.avg_kcal))} kcal${target('calories')}</td></tr>
<tr><th>Protein</th><td class="num">${esc(fmtNum(f.avg_protein))} g${target('protein')}</td></tr>
<tr><th>Carbs</th><td class="num">${esc(fmtNum(f.avg_carbs))} g${target('carbs')}</td></tr>
<tr><th>Fat</th><td class="num">${esc(fmtNum(f.avg_fat))} g${target('fat')}</td></tr>
</tbody>
</table>
<p class="stat">Averaged over ${esc(String(f.days_logged))} logged day${f.days_logged === 1 ? '' : 's'}.</p>`);
    }

    function workoutsBlock(data) {
        const w = data.workouts;
        if (!w || !w.session_count) return '';
        return block('Workouts', `<p class="stat">${esc(String(w.session_count))} completed session`
            + `${w.session_count === 1 ? '' : 's'}, ${esc(fmtNum(w.per_week))} per week.</p>`);
    }

    const BLOCK_BUILDERS = {
        meds: (data) => medsBlock(data),
        bp: (data, unit, charts) => bpBlock(data, charts),
        weight: (data, unit, charts) => weightBlock(data, unit, charts),
        vitals: (data, unit, charts) => vitalsBlock(data, charts),
        notes: (data) => notesBlock(data),
        food: (data) => foodBlock(data),
        workouts: (data) => workoutsBlock(data),
    };

    // buildBriefDocument(data, { unit, charts }) → a standalone HTML string.
    // `charts` carries pre-serialized SVG markup so this stays a pure
    // string function (the SVG rendering needs a live DOM; the doc does not).
    // A section absent from `data` never appears; a section present but empty
    // is omitted too — an empty table tells a doctor nothing.
    function buildBriefDocument(data, opts) {
        const o = opts || {};
        const unit = o.unit === 'lb' ? 'lb' : 'kg';
        const charts = o.charts || {};
        const range = (data && data.range) || {};
        const blocks = SECTION_ORDER
            .map((key) => BLOCK_BUILDERS[key](data || {}, unit, charts))
            .filter(Boolean);
        const body = blocks.length > 0
            ? blocks.join('\n')
            : '<section class="blk"><p class="stat">Nothing recorded in this range.</p></section>';
        return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Med Tracker — Doctor brief ${esc(fmtDate(range.from))} to ${esc(fmtDate(range.to))}</title>
<style>${DOC_CSS}
</style>
</head>
<body>
<header>
<h1>Doctor brief</h1>
<p class="meta">${esc(fmtDate(range.from))} — ${esc(fmtDate(range.to))}`
            + ` (last ${esc(fmtNum(range.days))} days) · generated ${esc(fmtDate(range.generated_at))}</p>
</header>
${body}
<footer>Generated locally by Med Tracker — this data never left the device.</footer>
</body>
</html>`;
    }

    // ponytail: no memoization — import() already caches by specifier. The
    // indirection is the test seam (see settings.js loadPrivacyModule).
    function loadPrintDoc() { return import('/js/print-doc.js'); }

    function serializeSvg(el) {
        // WGWeightChart and WGSleepChart return a <div> empty-state card (not
        // an <svg>) when they have nothing to draw; WGBpChart returns null.
        // Either way: no chart.
        if (!el || String(el.tagName || '').toLowerCase() !== 'svg') return '';
        try {
            return new XMLSerializer().serializeToString(el);
        } catch (e) {
            return '';
        }
    }

    function renderCharts(data, unit) {
        const out = {};
        try {
            const bp = data.bp;
            if (bp && Array.isArray(bp.readings) && bp.readings.length > 0 && window.WGBpChart) {
                out.bp = serializeSvg(window.WGBpChart.render({ readings: bp.readings, goal: bp.goal }));
            }
            const w = data.weight;
            if (w && Array.isArray(w.points) && w.points.length > 0 && window.WGWeightChart) {
                out.weight = serializeSvg(window.WGWeightChart.render({
                    logs: w.points, unit, range: 'all',
                }));
            }
            const v = data.vitals;
            if (v && Array.isArray(v.sleep_daily) && v.sleep_daily.length > 0 && window.WGSleepChart) {
                // '30d' is the component's own calendar-day filter — a brief
                // over 90 or 180 days still prints a readable ~30 bars, and
                // vitalsBlock captions that narrower window. If every logged
                // day falls outside it the component returns its empty-state
                // <div> instead of an <svg>, and serializeSvg drops it.
                out.sleep = serializeSvg(window.WGSleepChart.render({
                    stats: v.sleep_daily, range: '30d',
                }));
            }
        } catch (e) {
            // A chart that fails to draw must not cost the doctor the numbers.
            console.error('[brief] chart render failed', e);
        }
        return out;
    }

    async function fetchBrief(days, sections) {
        const qs = `days=${encodeURIComponent(days)}&sections=${encodeURIComponent(sections.join(','))}`;
        const data = await window.apiCall(`/api/brief?${qs}`);
        if (!data || !data.range) throw new Error('brief unavailable');
        return data;
    }

    function renderDoc(data) {
        const unit = preferredUnit();
        return buildBriefDocument(data, { unit, charts: renderCharts(data, unit) });
    }

    async function generate(days, sections) {
        return renderDoc(await fetchBrief(days, sections));
    }

    // The brief that is waiting on the note picker. Held here rather than
    // refetched on confirm: the preview the user ticks and the document that
    // gets built MUST be the same read, or a note written between the two
    // clicks prints without ever having been offered (bd med-29gh.5).
    let _briefPendingNotes = null;

    function noteBoxes(doc) {
        return Array.from(doc.querySelectorAll('#brief-notes-list input[type="checkbox"]'));
    }

    function truncateNote(text) {
        const s = String(text || '').replace(/\s+/g, ' ').trim();
        return s.length > NOTE_PREVIEW_CHARS ? `${s.slice(0, NOTE_PREVIEW_CHARS)}…` : s;
    }

    // Rebuilds the list, carrying over the ticks of any note the user has
    // already seen — pressing Back, changing the range and coming here again
    // must not silently re-include a note that was deliberately dropped.
    // Notes never shown before default to CHECKED: the step is the privacy
    // affordance, and defaulting to none would hand a hurried user an empty
    // Notes section instead of the one the app has always printed.
    function showNotesStep(doc, notes) {
        const list = doc.getElementById('brief-notes-list');
        const step = doc.getElementById('brief-notes-step');
        const options = doc.getElementById('brief-options');
        if (!list || !step || !options) return false;

        const previous = new Map(noteBoxes(doc).map((b) => [b.dataset.noteId, b.checked]));
        list.textContent = '';
        notes.forEach((n) => {
            const id = String(n.id);
            const label = doc.createElement('label');
            label.className = 'wg-brief-modal__note';
            const box = doc.createElement('input');
            box.type = 'checkbox';
            box.dataset.noteId = id;
            box.checked = previous.has(id) ? previous.get(id) : true;
            const date = doc.createElement('span');
            date.className = 'wg-brief-modal__note-date';
            date.textContent = n.date;
            const text = doc.createElement('span');
            text.className = 'wg-brief-modal__note-text';
            text.textContent = truncateNote(n.text);
            label.appendChild(box);
            label.appendChild(date);
            label.appendChild(text);
            list.appendChild(label);
        });
        syncAllToggle(doc);
        options.classList.add('hidden');
        step.classList.remove('hidden');
        const back = doc.getElementById('brief-back-btn');
        if (back) back.classList.remove('hidden');
        return true;
    }

    function hideNotesStep(doc) {
        _briefPendingNotes = null;
        const step = doc.getElementById('brief-notes-step');
        const options = doc.getElementById('brief-options');
        const back = doc.getElementById('brief-back-btn');
        if (step) step.classList.add('hidden');
        if (options) options.classList.remove('hidden');
        if (back) back.classList.add('hidden');
    }

    function syncAllToggle(doc) {
        const all = doc.getElementById('brief-notes-all');
        if (!all) return;
        const boxes = noteBoxes(doc);
        all.checked = boxes.length > 0 && boxes.every((b) => b.checked);
    }

    // Filters IN PLACE, on the payload the user just previewed. Everything is
    // local, so this is presentation-only — nothing was ever hidden from a
    // server, and health.brief keeps handing agents the full set.
    function applyNoteSelection(doc, data) {
        const keep = new Set(noteBoxes(doc).filter((b) => b.checked).map((b) => b.dataset.noteId));
        data.notes = (Array.isArray(data.notes) ? data.notes : []).filter((n) => keep.has(String(n.id)));
    }

    function readOptions(doc) {
        const active = doc.querySelector('#brief-range [aria-pressed="true"]');
        const days = active ? Number(active.dataset.days) || DEFAULT_DAYS : DEFAULT_DAYS;
        const sections = Array.from(doc.querySelectorAll('#brief-sections input[type="checkbox"]'))
            .filter((b) => b.checked)
            .map((b) => b.dataset.section);
        return { days, sections };
    }

    function setStatus(doc, text) {
        const el = doc.getElementById('brief-status');
        if (el) el.textContent = text;
    }

    async function output(doc, mode, html) {
        const mod = await window.DoctorBrief.loadPrintDoc();
        if (mode === 'download') {
            const name = `med-tracker-doctor-brief-${fmtDate(new Date().toISOString())}.html`;
            if (mod.downloadDoc(doc, html, name)) {
                setStatus(doc, 'Downloaded.');
                return;
            }
            // In-app browsers refuse Blob downloads — print is the fallback
            // that still gets the paper into the appointment.
            mod.printDoc(doc, html, 'wg-brief-print-frame', DOC_CSS);
            setStatus(doc, 'Download blocked — opened the print dialog instead.');
            return;
        }
        mod.printDoc(doc, html, 'wg-brief-print-frame', DOC_CSS);
        setStatus(doc, 'Print dialog opened.');
    }

    // `mode` is 'print' or 'download'. An empty selection never reaches the
    // API: GET /api/brief treats an empty `sections` as "the default set"
    // (web/domain/brief.js normalizeSections), so sending it would silently
    // print sections the user just unticked.
    //
    // Two-pass when the Notes section is on and the range actually holds
    // notes: the first press fetches and shows the per-note picker, the second
    // prints the notes still ticked. No notes (or Notes unticked) is the
    // one-pass flow this has always had.
    async function run(doc, mode) {
        const opts = _briefPendingNotes ? null : readOptions(doc);
        if (opts && opts.sections.length === 0) {
            setStatus(doc, 'Pick at least one section.');
            return;
        }
        setStatus(doc, 'Building brief…');
        try {
            let data = _briefPendingNotes;
            if (data) {
                applyNoteSelection(doc, data);
            } else {
                data = await fetchBrief(opts.days, opts.sections);
                if (opts.sections.indexOf('notes') !== -1
                    && Array.isArray(data.notes) && data.notes.length > 0
                    && showNotesStep(doc, data.notes)) {
                    _briefPendingNotes = data;
                    setStatus(doc, 'Pick the notes to include, then Print or Download.');
                    return;
                }
            }
            await output(doc, mode, renderDoc(data));
            hideNotesStep(doc);
        } catch (e) {
            console.error('[brief] generate failed', e);
            hideNotesStep(doc);
            setStatus(doc, 'Could not build the brief. Try again when you are back online.');
        }
    }

    function selectRange(group, btn) {
        Array.from(group.querySelectorAll('[data-days]')).forEach((b) => {
            const on = b === btn;
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
            b.classList.toggle('wg-settings-segmented__btn--active', on);
            b.classList.toggle('wg-gloss--sun', on);
        });
    }

    function open() {
        const doc = document;
        hideNotesStep(doc);
        // Ticks survive Back within a session (showNotesStep carries them), but
        // not a reopen: every visit starts from the shipped all-checked default
        // rather than silently withholding a note excluded weeks ago. Also
        // keeps stale note text out of the DOM between sessions.
        const list = doc.getElementById('brief-notes-list');
        if (list) list.textContent = '';
        setStatus(doc, 'Everything is generated on this device.');
        if (window.ModalManager && typeof window.ModalManager.open === 'function') {
            window.ModalManager.open('brief-modal');
        }
    }

    function close() {
        hideNotesStep(document);
        if (window.ModalManager && typeof window.ModalManager.close === 'function') {
            window.ModalManager.close('brief-modal');
        }
    }

    function bind() {
        const doc = document;
        const modal = doc.getElementById('brief-modal');
        if (!modal || modal.dataset.briefBound === 'true') return;
        modal.dataset.briefBound = 'true';

        const group = doc.getElementById('brief-range');
        if (group) {
            group.addEventListener('click', (e) => {
                const btn = e.target && e.target.closest ? e.target.closest('[data-days]') : null;
                if (btn) selectRange(group, btn);
            });
        }
        const cancel = doc.getElementById('brief-cancel-btn');
        if (cancel) cancel.addEventListener('click', close);
        // Back drops the held brief on purpose: the user may now pick a
        // different range, and reusing the old payload would print a window
        // they did not ask for. showNotesStep carries the ticks forward.
        const back = doc.getElementById('brief-back-btn');
        if (back) {
            back.addEventListener('click', () => {
                hideNotesStep(doc);
                setStatus(doc, 'Everything is generated on this device.');
            });
        }
        const notesAll = doc.getElementById('brief-notes-all');
        if (notesAll) {
            notesAll.addEventListener('change', () => {
                noteBoxes(doc).forEach((b) => { b.checked = notesAll.checked; });
            });
        }
        const notesList = doc.getElementById('brief-notes-list');
        if (notesList) notesList.addEventListener('change', () => syncAllToggle(doc));
        const download = doc.getElementById('brief-download-btn');
        if (download) {
            download.addEventListener('click', () => {
                if (typeof withSubmit === 'function') withSubmit(download, () => run(doc, 'download'));
                else run(doc, 'download');
            });
        }
        const print = doc.getElementById('brief-print-btn');
        if (print) {
            print.addEventListener('click', () => {
                if (typeof withSubmit === 'function') withSubmit(print, () => run(doc, 'print'));
                else run(doc, 'print');
            });
        }
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', bind);
        } else {
            bind();
        }
    }

    window.DoctorBrief = {
        open,
        close,
        bind,
        generate,
        buildBriefDocument,
        loadPrintDoc,
    };
})();
