// Medication scheduling utilities extracted from app.js
// (Plan 2026-05-13, Task 5).
//
// Four pure helpers that parse `medication.schedule` JSON and derive
// human-readable text + the next scheduled occurrence. Pulled out of
// app.js so feature consumers (features/meds.js, features/today.js) can
// reach them by name without going through the app.js god-file.
//
// Public surface:
//   - MedicationUtils.parseMedicationSchedule(rawSchedule)
//   - MedicationUtils.getNextScheduledDate(schedule, now?)
//   - MedicationUtils.getMedicationScheduleText(med, schedule)
//   - MedicationUtils.getLastTakenTimeMs(medication)
//
// Backwards-compat: the four functions remain available as bare
// window.parseMedicationSchedule / window.getNextScheduledDate /
// window.getMedicationScheduleText / window.getLastTakenTimeMs so the
// existing feature consumers and tests that look them up by name (e.g.
// app.js:1141-1142, features/meds.js:251/299/312/345) keep working.

window.MedicationUtils = (function () {
    function parseMedicationSchedule(rawSchedule) {
        try {
            return JSON.parse(rawSchedule);
        } catch (e) {
            return null;
        }
    }

    function getNextScheduledDate(schedule, now = new Date()) {
        if (!schedule) return null;

        const parseCandidate = (baseDate, timeStr) => {
            const [h, min] = String(timeStr).split(':').map(Number);
            if (Number.isNaN(h) || Number.isNaN(min)) return null;
            const candidate = new Date(baseDate);
            candidate.setHours(h, min, 0, 0);
            return candidate;
        };

        if (schedule.type === 'daily' && Array.isArray(schedule.times)) {
            const candidates = schedule.times
                .map((timeStr) => {
                    const candidate = parseCandidate(now, timeStr);
                    if (!candidate) return null;
                    if (candidate <= now) {
                        candidate.setDate(candidate.getDate() + 1);
                    }
                    return candidate;
                })
                .filter(Boolean);
            return candidates.sort((a, b) => a - b)[0] || null;
        }

        if (schedule.type === 'weekly' && Array.isArray(schedule.days) && Array.isArray(schedule.times)) {
            const candidates = [];
            for (let i = 0; i < 8; i++) {
                const dayBase = new Date(now);
                dayBase.setDate(now.getDate() + i);
                if (!schedule.days.includes(dayBase.getDay())) continue;

                schedule.times.forEach((timeStr) => {
                    const candidate = parseCandidate(dayBase, timeStr);
                    if (candidate && candidate > now) {
                        candidates.push(candidate);
                    }
                });
            }
            return candidates.sort((a, b) => a - b)[0] || null;
        }

        return null;
    }

    function getMedicationScheduleText(med, schedule) {
        if (!schedule) {
            return window.escapeHtml(med.schedule);
        }

        if (schedule.type === 'daily') {
            const times = Array.isArray(schedule.times) ? schedule.times : [];
            return `Daily: ${times.join(', ')}`;
        }

        if (schedule.type === 'weekly') {
            const daysMap = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
            const days = Array.isArray(schedule.days) ? schedule.days : [];
            const times = Array.isArray(schedule.times) ? schedule.times : [];
            const dayNames = days.map((day) => daysMap[day]);
            return `Weekly (${dayNames.join(', ')}): ${times.join(', ')}`;
        }

        return 'As Needed';
    }

    function getLastTakenTimeMs(medication) {
        return medication.last_taken_at ? new Date(medication.last_taken_at).getTime() : 0;
    }

    return {
        parseMedicationSchedule,
        getNextScheduledDate,
        getMedicationScheduleText,
        getLastTakenTimeMs,
    };
})();

// Backwards-compat shims — preserve the bare global names that existed
// when these helpers lived in app.js, so callers that look them up via
// `window.parseMedicationSchedule` (today.js fallback path, app.js's own
// _todayRender helper-hand-off at line 1141-1142) and bare-identifier
// lookups in features/meds.js continue to resolve.
window.parseMedicationSchedule = window.MedicationUtils.parseMedicationSchedule;
window.getNextScheduledDate = window.MedicationUtils.getNextScheduledDate;
window.getMedicationScheduleText = window.MedicationUtils.getMedicationScheduleText;
window.getLastTakenTimeMs = window.MedicationUtils.getLastTakenTimeMs;
