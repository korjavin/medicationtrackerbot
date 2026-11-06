// iOS visual QA driver (bd med-y5xx.1, docs/design/ios-visual-testing.md).
//
// Bundled ONLY by `QA=1 ios/bundle-web.sh` (served at /qa/driver.js on
// wgapp://local, loaded right after the local entry, before the app scripts); the TestFlight archive and the
// cloud never carry it (the web tier's cloud pass injects it with Playwright's
// addInitScript, setting __wgQACloud and __wgQAFiles). A classic script: on `?qa=<scene>` it seeds the golden
// vault into the empty local store, navigates to the scene with the app's own
// entry points, waits for the scene's ready selectors, and publishes
//   <div role="status" id="wg-qa-ready" aria-label="<json report>">
// which XCUITest (and the Playwright tier) wait for and read. The report is
// re-published (rev + 1) on every viewport / focus change, so a native step
// that brings up the keyboard can read the probes again.
//
// Scenes live in /qa/scenes.json (tests/visual/scenes.json), the one list both
// runners read.
(function () {
    const BOOT_MS = 20000;
    const STEP_MS = 10000;
    const QUIET_MS = 400;
    const SETTLE_CAP_MS = 5000;
    // Capture the unoccluded viewport before app scripts can focus a field.
    // WKWebView may shrink both layout and visual heights for its keyboard.
    // The cloud runner injects at document start, before the root exists.
    const viewportBaseline = { width: window.innerWidth, height: Math.max(window.innerHeight, document.documentElement?.clientHeight || 0) };

    const scene = new URLSearchParams(window.location.search).get('qa');
    const qa = { scene, done: null, probe, memo: {} };
    window.__wgQA = qa;
    if (!scene) return;
    // &clock=real (the iOS shell's -wgQACapture, add-device-from-link) keeps the
    // real clock: the page judges the slot's receivedAt (shell time) against
    // Date.now(), and a join's 10 minutes would never hold at 23:00.
    // &clock=HH:MM (a scene's "clock", run.mjs) pins that time instead of 23:00.
    const clock = new URLSearchParams(window.location.search).get('clock');
    if (clock !== 'real') pinClock(/^\d\d:\d\d$/.test(clock || '') ? clock.split(':').map(Number) : [23, 0]);
    // Document loads in this launch (the seed import reloads once): a scene
    // whose page reloads mid-scene shows loads > 1 (or > 2 right after seeding).
    let loads = 1;
    try {
        loads = Number(window.sessionStorage.getItem('wg-qa-loads') || 0) + 1;
        window.sessionStorage.setItem('wg-qa-loads', String(loads));
    } catch (_) { /* no storage: stays 1 */ }
    qa.done = run(scene).catch((e) => publish({ scene, ok: false, error: String((e && e.message) || e) }));

    // Time-dependent text ("Now 05:28", "in 3h 25m", past/future readings)
    // must not depend on when the job runs: every Date the page makes reads
    // today at 23:00 local, after all of the fixture's (shifted) entries, and
    // ticks from there so timeouts and debounces keep working. Installed at
    // document start (QA=1 loads this script right after the local entry; the
    // cloud pass injects it with addInitScript), before any app script.
    // ponytail: ticks from the pin, so a scene that lives > 60 s shows 23:01;
    // freeze outright (Playwright clock.setFixedTime style) if that shows up.
    function pinClock([hour, minute]) {
        const Real = window.Date;
        // The jsdom suite re-evaluates the driver: keep its clock, drop a clockAdvance.
        if (Real.wgQAPinned) { Real.wgQAShift = 0; return; }
        const d = new Real();
        const pin = new Real(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0).getTime();
        const t0 = window.performance.now();
        const now = () => pin + QADate.wgQAShift + Math.floor(window.performance.now() - t0);
        function QADate(...args) {
            if (!new.target) return new Real(now()).toString();
            return Reflect.construct(Real, args.length ? args : [now()], new.target);
        }
        QADate.prototype = Real.prototype;
        QADate.now = now;
        QADate.parse = Real.parse;
        QADate.UTC = Real.UTC;
        QADate.wgQAPinned = true;
        QADate.wgQAShift = 0; // a scene's clockAdvance step, this load only
        window.Date = QADate;
    }

    async function run(name) {
        const list = await getJSON('/qa/scenes.json');
        const def = (Array.isArray(list) ? list : list.scenes || []).find((s) => s.name === name);
        const nativeOnly = def && (def.nativeOnly !== undefined ? def.nativeOnly : def.name.startsWith('native-'));
        if (!def || nativeOnly) throw new Error(`no in-page scene "${name}"`);
        // checkAuth (bootstrap.js) awaits the local boot, then the first
        // switchTab sets currentTab and the same sync callback runs the deep
        // links: once currentTab is set and a task has passed, the app owns no
        // pending navigation that could override ours.
        await until(() => window.AppStore && window.AppStore.get('currentTab'), BOOT_MS, 'app boot');
        await sleep(0);
        // Never import over a real vault: the QA bundle is local mode only; the
        // cloud pass opts in for its fresh test account.
        if (!document.documentElement.classList.contains('wg-local-vault') && !window.__wgQACloud) throw new Error('not local mode');
        if (!(await window.CloudVault.hasUserContent())) {
            await seed();
            return; // the import reloads the page; the next load runs the scene
        }
        // A view's own load can still undo a step after the ready check passed
        // (run 39214150540: workouts-stats shot Plans with ok:true), so check
        // again once the store is quiet and redo the steps once.
        for (let attempt = 0; ; attempt++) {
            for (const step of def.steps || []) await runStep(step);
            for (const sel of def.ready || []) await until(() => firstVisible(sel), STEP_MS, `ready ${sel}`);
            await settle();
            if (!lostReady(def).length || attempt >= 1) break;
        }
        // A sheet's enter animation (opacity 0 → 1) still running when the
        // runner shoots leaves only the dim (PL6 on Android, bd med-jqrf.5).
        if (typeof document.getAnimations === 'function') {
            await Promise.race([Promise.all(document.getAnimations()
                .filter((a) => !(a.effect && a.effect.getTiming().iterations === Infinity)).map((a) => a.finished.catch(() => {}))), sleep(3000)]);
        }
        publish(report(def));
        watch(def);
    }

    // Seeds once, through Settings → Backup & import's own path. The store is
    // empty here, so the import's replace confirm never shows (importexport.js
    // skips it when hasUserContent() === false).
    async function seed() {
        const vault = seedVault(await getJSON('/qa/vault-v1.json'));
        // The fixture is Europe/Berlin; a different device zone would raise the
        // timezone confirm over every screenshot (bootstrap.js maybeUpdateTimezone).
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz && vault.data && vault.data.settings) vault.data.settings.timezone = tz;
        // The first-run overlay record is not vault-managed, so it survives the import.
        await window.apiCall('/api/firstrun/complete', 'POST');
        const input = document.getElementById('importexport-import-file');
        const file = new window.File([JSON.stringify(vault)], 'qa-vault-v1.json', { type: 'application/json' });
        setFiles(input, file);
        input.dispatchEvent(new window.Event('change'));
        await window.SettingsImportExport.import();
        if (!(await window.CloudVault.hasUserContent())) throw new Error('seed import failed');
    }

    function seedVault(fixture) {
        return withTimelineNow(shiftDates(withPausedPlan(withTimeline(withHealthSources(withPileUp(withTwoDoseDay(withEuMatch(fixture)))))), new Date()));
    }

    // Saved EU register match (bd med-3u28.10, kit ER11–ER13): Lisinopril
    // carries the Rev.90 reference to one of its two register cards, so the
    // Meds list shows "Rx lisinopril · EU Lisinopril Dihydrate" (ER13), the
    // editor paints the saved chip from the record, and with EU picked the
    // chip names it and the sheet says Picked (meds-editor-eu-* scenes).
    // Visual seed only; tests/fixtures/vault-v1.json stays the vault-format pin.
    function withEuMatch(vault) {
        const med = vault && vault.data && vault.data.medications && (vault.data.medications.items || [])[0];
        if (med) {
            med.ema = {
                for_name: med.name, substances: 'Lisinopril Dihydrate', revision: 'EMA/518502/2018, Rev.90',
                data_date: '09/10/2026', sha256: 'e4f0c27b05b1d893e055038fff70886a5aadc9434c54fd5a0a93ae98cfe4ad92',
            };
        }
        return vault;
    }

    // Meds timeline day order (bd med-5y49): the golden fixture's one 09:00
    // dose a day can't show "later on top" inside a day. A second daily slot
    // at 21:00 (the fixture already holds an undone 21:00 row) gives every
    // day two doses: meds-timeline-next-early (06:00) shows "Later today"
    // folded above the card, Next today 09:00 above Pending; an unfolded
    // future day 21:00 above 09:00. The fixture's dose taken today at 15:32
    // moves to yesterday, so no clock shows a dose taken later than now.
    // Visual seed only; tests/fixtures/vault-v1.json stays the vault-format pin.
    function withTwoDoseDay(vault) {
        const meds = vault && vault.data && vault.data.medications;
        const med = meds && (meds.items || [])[0];
        if (med) med.schedule = '{"type":"daily","times":["09:00","21:00"]}';
        const back = (iso) => (iso ? new Date(Date.parse(iso) - 86400000).toISOString().replace('.000Z', 'Z') : iso);
        ((meds && meds.intakes) || []).filter((i) => i.scheduled_at === '2026-07-08T15:32:00Z').forEach((i) => {
            i.scheduled_at = back(i.scheduled_at);
            i.taken_at = back(i.taken_at);
            i.acted_at = back(i.acted_at);
        });
        return vault;
    }

    // Plans tab PL1 (bd med-jqrf.2): a paused plan, so workouts-plans shows the
    // Paused list under the current plan. Paused plans have no next slot and
    // no reminders, and its days carry no exercises or sessions, so no other
    // screen shows it. Visual seed only.
    function withPausedPlan(vault) {
        const w = vault && vault.data && vault.data.workouts;
        if (!w || !Array.isArray(w.groups) || !Array.isArray(w.variants)) return vault;
        w.groups.push({ ...w.groups[0], id: 11, name: 'Summer cut', description: '', is_rotating: true, active: false });
        ['Upper', 'Lower', 'Conditioning'].forEach((name, i) => w.variants.push({
            id: 23 + i, group_id: 11, name, rotation_order: i, description: '', created_at: '2026-06-01T08:00:00Z',
        }));
        return vault;
    }

    // Plans tab PL4 (bd med-jqrf.2): a second active plan that doesn't rotate
    // (every day at 07:30, three exercises), and the seeded plan grown to
    // seven days so its card folds after four with "All 7 days".
    function withTwoPlans(vault) {
        const w = vault.data.workouts;
        const base = w.groups.find((g) => g.id === 10);
        w.groups.push({ ...base, id: 12, name: 'Morning mobility', description: '', is_rotating: false, active: true,
            days_of_week: '[0,1,2,3,4,5,6]', scheduled_time: '07:30' });
        w.variants.push({ id: 30, group_id: 12, name: 'Morning mobility', rotation_order: 0, description: '', created_at: '2026-06-01T08:00:00Z' });
        ['Upper Mix', 'Bench Technique & Shoulders', 'Upper Back & Grip', 'Quads & Calves'].forEach((name, i) => w.variants.push({
            id: 26 + i, group_id: 10, name, rotation_order: 3 + i, description: '', created_at: '2026-06-01T08:00:00Z',
        }));
        [['Hip flexor stretch', 2, 30], ['Cat–cow', 2, 10], ['Dead hang', 3, 30]].forEach(([name, sets, reps], i) => w.exercises.push({
            id: 60 + i, variant_id: 30, exercise_name: name, target_sets: sets, target_reps_min: reps,
            target_reps_max: null, target_weight_kg: null, order_index: i, exercise_library_id: null, equipment_id: null,
        }));
        // PL2 (bd med-jqrf.3): "Quads & Calves" (id 29, day 7, never next) as on
        // the kit page: a description, three exercises, done six days ago in
        // 47 min with per-set logs, so its day page shows every target and
        // "last". Stamped from the (pinned) clock: the fixture is already shifted.
        // The sun hides while a session runs: finish WN6's unfinished one here.
        w.sessions.filter((s) => s.status === 'in_progress').forEach((s) => {
            s.status = 'completed';
            s.completed_at = new Date(Date.parse(s.started_at) + 30 * 60000).toISOString();
        });
        const quads = w.variants.find((v) => v.id === 29);
        quads.description = 'Quad-focused leg day with strength emphasis, plus calves.';
        const lifts = [['Back squat', 4, 5, 100, 97.5], ['Leg press', 3, 10, 160, 150], ['Standing calf raise', 4, 12, 60, 60]];
        lifts.forEach(([name, sets, reps, kg], i) => w.exercises.push({
            id: 63 + i, variant_id: 29, exercise_name: name, target_sets: sets, target_reps_min: reps,
            target_reps_max: null, target_weight_kg: kg, order_index: i, exercise_library_id: null, equipment_id: null,
        }));
        const at = new Date();
        at.setDate(at.getDate() - 6);
        at.setHours(18, 4, 0, 0);
        w.sessions.push({
            id: 70, user_id: 1, group_id: 10, variant_id: 29,
            scheduled_date: new Date(at.getFullYear(), at.getMonth(), at.getDate()).toISOString(), scheduled_time: '18:00',
            status: 'completed', started_at: at.toISOString(), completed_at: new Date(at.getTime() + 47 * 60000).toISOString(),
            snoozed_until: null, snooze_count: 0, notification_message_id: null, notes: '',
        });
        lifts.forEach(([name, sets, reps, , last], i) => w.exercise_logs.push({
            session_id: 70, exercise_id: 63 + i, exercise_name: name, sets_completed: sets, reps_completed: reps,
            weight_kg: last, status: 'completed', notes: '', logged_at: new Date(at.getTime() + (10 + i * 12) * 60000).toISOString(),
            source: 'schedule', sets: Array.from({ length: sets }, () => ({ weight_kg: last, reps })),
        }));
        return vault;
    }

    // MT4 · pile-up (bd med-ry7b.4): the golden fixture has one dose a day,
    // so no History day ever lists 2+ pending doses and the bulk pair never
    // shows. Add a pending 09:00 to the day of the fixture's undone 19:00
    // (two days back once shifted): that day lists 2 pending under
    // "Mark all taken / Skip all" (meds-timeline-bulk-undo). Visual seed only;
    // tests/fixtures/vault-v1.json stays the vault-format pin.
    function withPileUp(vault) {
        const meds = vault && vault.data && vault.data.medications;
        if (meds && Array.isArray(meds.intakes)) {
            meds.intakes.push({
                medication_id: 1, scheduled_at: '2026-07-06T07:00:00Z', taken_at: null,
                status: 'PENDING', snoozed_until: null, source: 'schedule', tz: 'Europe/Berlin',
            });
        }
        return vault;
    }

    // HS1–HS4 source labels (bd med-w6gx.32): mark one BP reading and one
    // weight log as Health imports and the one sleep night as Mi Band, so
    // health-bp / weight / health-vitals show the labels. Only `source` is
    // added (no source_id), so ids, values, dates and trends stay as they were.
    // Visual seed only; tests/fixtures/vault-v1.json stays the vault-format pin.
    function withHealthSources(vault) {
        const d = (vault && vault.data) || {};
        const mark = (list, i, source) => { if (Array.isArray(list) && list[i]) list[i].source = source; };
        mark(d.bp && d.bp.readings, 1, 'apple_health');
        mark(d.weight && d.weight.logs, 1, 'apple_health');
        mark(d.vitals && d.vitals.sleep, 0, 'miband');
        return vault;
    }

    // Train → Timeline (bd med-soo0.4, kit WN2): the golden fixture has one
    // session, so the Timeline would show a single week. Add an off-plan
    // Telegram-style "Morning run", a skipped plan day and six older weekly
    // sessions, all older than the fixture's session 50 (the row the
    // workout-session-* scenes open first), so the shots carry several
    // weeks, an Off plan row, a dashed dot and "Show 4 earlier weeks".
    // Visual seed only; tests/fixtures/vault-v1.json stays the vault-format pin.
    function withTimeline(vault) {
        const w = vault && vault.data && vault.data.workouts;
        if (!w || !Array.isArray(w.sessions)) return vault;
        const session = (id, day, extra) => ({
            id, user_id: 1, group_id: 10, variant_id: 20, scheduled_date: `${day}T00:00:00+02:00`,
            scheduled_time: '18:00', status: 'completed', started_at: `${day}T16:04:00Z`,
            completed_at: `${day}T16:56:00Z`, snoozed_until: null, snooze_count: 0,
            notification_message_id: null, notes: '', ...extra,
        });
        w.sessions.push(
            session(51, '2026-07-05', { group_id: -1, variant_id: -1, started_at: '2026-07-05T06:10:00Z',
                completed_at: '2026-07-05T06:44:00Z', notes: 'Morning run', scheduled_time: '08:10' }),
            // A Finish that never landed: Unfinished chip + Finish (WN6).
            session(59, '2026-07-04', { group_id: -1, variant_id: -1, status: 'in_progress', started_at: '2026-07-04T08:15:00Z',
                completed_at: null, scheduled_time: '10:15' }),
            session(52, '2026-07-03', { variant_id: 21, status: 'skipped', started_at: null, completed_at: null }),
            session(53, '2026-06-30', { variant_id: 21 }),
            session(54, '2026-06-24'),
            session(55, '2026-06-17', { variant_id: 21 }),
            session(56, '2026-06-10'),
            session(57, '2026-06-03', { variant_id: 21 }),
            session(58, '2026-05-27'),
        );
        // The WN7 "Other plan day" sheet (med-soo0.3): a third, never-done
        // day with a long name, so the shot shows a wrapped row and "never".
        // Pull (the day the card opens on, WN1) gets real exercises, so the
        // card reads "3 exercises · Pull-up, …", not "0 exercises".
        if (Array.isArray(w.variants) && Array.isArray(w.exercises)) {
            w.variants.push({ id: 22, group_id: 10, name: 'Glutes, Hamstrings & Core Stability with Single-Leg Balance Work and a Loaded Carry Finisher', rotation_order: 2,
                description: '', created_at: '2026-06-01T08:00:00Z' });
            const exercise = (id, variant_id, exercise_name, order_index) => ({
                id, variant_id, exercise_name, target_sets: 3, target_reps_min: 8,
                target_reps_max: 12, target_weight_kg: null, order_index, exercise_library_id: null, equipment_id: null,
            });
            ['Hip thrust', 'Romanian deadlift'].forEach((name, i) => w.exercises.push(exercise(31 + i, 22, name, i)));
            ['Pull-up', 'Lat pulldown', 'Face pull'].forEach((name, i) => w.exercises.push(exercise(33 + i, 21, name, i)));
        }
        if (Array.isArray(w.exercise_logs)) {
            [53, 54].forEach((id, i) => w.exercise_logs.push({
                session_id: id, exercise_id: 30, exercise_name: 'Bench Press', sets_completed: 3,
                reps_completed: 10, weight_kg: 55 + i * 2.5, status: 'completed', notes: '',
                logged_at: `${id === 53 ? '2026-06-30' : '2026-06-24'}T16:50:00Z`, source: 'schedule',
            }));
            ['Goblet squat', 'Plank'].forEach((name, i) => w.exercise_logs.push({
                session_id: 59, exercise_id: 0, exercise_name: name, sets_completed: 3,
                reps_completed: i ? 1 : 10, weight_kg: i ? 0 : 16, status: 'completed', notes: '',
                logged_at: `2026-07-04T08:${30 + i * 10}:00Z`, source: 'schedule',
            }));
        }
        return vault;
    }

    // Stamped from the (pinned) clock after the shift. The plan trains today,
    // in two days and in four (the fixture's Mon/Wed/Fri only holds on those
    // days), so the Up next card opens on "Today" (WN1) whatever day the run
    // is. A band walk four days back: band rows key on epoch ms, which
    // shiftDates leaves alone (the fixture's own run is a year old, past
    // listMiBand's 90 days).
    function withTimelineNow(vault) {
        const w = vault && vault.data && vault.data.workouts;
        const day = new Date().getDay();
        if (w && Array.isArray(w.groups)) {
            w.groups.forEach((g) => { g.days_of_week = JSON.stringify([day, (day + 2) % 7, (day + 4) % 7].sort()); });
        }
        if (!w || !Array.isArray(w.miband)) return vault;
        const start = Math.floor((Date.now() - 4 * 86400000) / 60000) * 60000;
        w.miband.push({
            activity_type: 6, activity_name: 'walking', source_start_ms: start, source_end_ms: start + 3900000,
            tz_offset: -new Date().getTimezoneOffset() * 60, duration_sec: 3900, distance_m: 5400, steps: 7100,
            calories: 260, heart_rate_avg: 104, spo2_avg: 97, pause_ms: 0, source: 'device', gps: [],
        });
        return vault;
    }

    function setFiles(input, file) {
        try {
            const dt = new window.DataTransfer();
            dt.items.add(file);
            input.files = dt.files;
        } catch (_) { /* no DataTransfer (jsdom): fall through */ }
        if (!input.files || input.files.length !== 1) {
            Object.defineProperty(input, 'files', { configurable: true, value: [file] });
        }
    }

    // Moves every ISO date (a whole string: "YYYY-MM-DD" or "YYYY-MM-DDT…") by
    // whole days so exported_at lands on today: Today / Food / charts show the
    // fixture's data, and times of day and zone suffixes stay as written.
    function shiftDates(vault, now) {
        const ISO = /^(\d{4})-(\d{2})-(\d{2})(?=$|T)/;
        const m = ISO.exec(vault.exported_at || '');
        if (!m) return vault;
        const day = (y, mo, d) => Date.UTC(y, mo, d) / 86400000;
        const days = day(now.getFullYear(), now.getMonth(), now.getDate()) - day(+m[1], m[2] - 1, +m[3]);
        const shift = (s) => {
            const x = ISO.exec(s);
            if (!x) return s;
            return new Date(Date.UTC(+x[1], x[2] - 1, +x[3] + days)).toISOString().slice(0, 10) + s.slice(10);
        };
        const walk = (v) => {
            if (typeof v === 'string') return shift(v);
            if (Array.isArray(v)) return v.map(walk);
            if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
            return v;
        };
        return walk(vault);
    }

    async function runStep(step) {
        if (step.tab) {
            window.switchTab(step.tab);
            // The view's own load restores its last sub-tab; a click before it
            // lands is undone (workouts-stats shot showed Plans).
            await settle();
        } else if (step.click) {
            // optional: tap it if it shows within 3 s (a sheet only some
            // devices open, e.g. the notification ask after a dose write).
            try {
                await until(() => firstVisible(step.click), step.optional ? 3000 : STEP_MS, `click ${step.click}`);
            } catch (e) {
                if (step.optional) return;
                throw e;
            }
            firstVisible(step.click).click();
        } else if (step.api) {
            // Writes through the app's own API, e.g. PATCH /api/settings/body.
            // The write stays in the store for later scenes.
            await window.apiCall(step.api.path, step.api.method || 'GET', step.api.body);
        } else if (step.pausePlans) {
            // PL5 paused (bd med-jqrf.5): Active off on every plan, through the
            // editor's own update. The write stays; twoPlans replaces the store after.
            for (const g of await window.apiCall('/api/workout/groups', 'GET')) {
                if (g.active) await window.apiCall(`/api/workout/groups/update?id=${g.id}`, 'PUT', { ...g, active: false });
            }
        } else if (step.emptyWorkout) {
            // Ad hoc resumes today's running session, which earlier scenes
            // may have populated. Finish those fixtures through the real API
            // before History's Ad hoc action opens a new, empty session.
            const finished = new Set();
            for (;;) {
                const next = await window.apiCall('/api/workout/sessions/next');
                const session = next && next.session;
                if (!session || session.status !== 'in_progress') break;
                if (finished.has(session.id)) throw new Error('emptyWorkout: running session did not finish');
                await window.apiCall(`/api/workout/sessions/status?id=${session.id}`, 'PUT', { status: 'completed' });
                finished.add(session.id);
            }
        } else if (step.dropScratchWorkouts) {
            // The weightCheck / exerciseIdentity scenes log ~60 ad-hoc
            // sessions today; the Timeline's week head then read "63
            // workouts". Delete today's finished off-plan sessions, so the
            // Up next shots (WN1…) show the seeded weeks. The fixture has
            // none today, so a rerun deletes nothing.
            const today = new Date();
            const ymd = [today.getFullYear(), today.getMonth() + 1, today.getDate()].map((n) => String(n).padStart(2, '0')).join('-');
            const rows = await window.apiCall('/api/workout/sessions?limit=500') || [];
            for (const { session: s } of rows) {
                if (s && s.group_id === -1 && s.status === 'completed' && String(s.scheduled_date).slice(0, 10) === ymd) {
                    await window.apiCall(`/api/workout/sessions/delete?id=${s.id}`, 'DELETE');
                }
            }
        } else if (step.clockAdvance) {
            // Moves this load's pinned clock on by that many minutes: every
            // load reads 23:00, so a session started in an earlier scene would
            // read "In progress · 0 min" (WN5).
            if (window.Date.wgQAPinned) window.Date.wgQAShift = step.clockAdvance * 60000;
        } else if (step.weightCheck) {
            // Kit WS1–WS3 (bd med-l5yr.5): completed sessions of one exercise
            // at the `earlier` weights (three sets each), then one holding
            // `sets`, opened the way a History row opens it. The writes stay.
            const wc = step.weightCheck;
            const logSession = async (kgs) => {
                const s = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
                await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
                    session_id: s.id, exercise_id: 999, exercise_name: wc.name, source: 'library', status: 'completed',
                    sets: kgs.map((weight_kg) => ({ weight_kg, reps: 8 })),
                });
                await window.apiCall(`/api/workout/sessions/status?id=${s.id}`, 'PUT', { status: 'completed' });
                return s.id;
            };
            for (const kg of wc.earlier || []) await logSession([kg, kg, kg]);
            await window.showWorkoutSessionModal(await logSession(wc.sets));
        } else if (step.exerciseIdentity) {
            // Kit EI1–EI6 (bd med-l5yr.4): library rows with other names and
            // history-only names, then the Edit sheet on `edit`. Seeded once
            // per store (the first EI scene); later scenes reuse it.
            const has = async () => (await window.apiCall('/api/workout/exercise-library') || [])
                .some((r) => r.name === 'Kettlebell Swings');
            if (!(await has())) {
                const logAs = async (name) => {
                    const s = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
                    await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
                        session_id: s.id, exercise_id: 999, exercise_name: name, source: 'library', status: 'completed',
                        sets: [{ weight_kg: 16, reps: 10 }],
                    });
                    await window.apiCall(`/api/workout/sessions/status?id=${s.id}`, 'PUT', { status: 'completed' });
                };
                // Logged before the rows exist, so each stays under its own spelling.
                const logs = { 'Kettlebell Swings': 3, Swings: 9, 'KB Swings': 4, 'Kettlebell Rows': 5, 'cable pulldown': 7,
                    'Horizontal Row': 4, 'Hammer Curls': 6, 'Lateral Raises': 11, 'Dumbbell Lateral Raise': 8 };
                for (const [name, n] of Object.entries(logs)) for (let i = 0; i < n; i++) await logAs(name);
                const create = (name, body_part) => window.apiCall('/api/workout/exercise-library/create', 'POST', { name, body_part });
                const ks = await create('Kettlebell Swings', 'upper legs');
                await window.apiCall(`/api/workout/exercise-library/update?id=${ks.id}`, 'PUT',
                    { name: 'Kettlebell Swings', body_part: 'upper legs', aliases: ['Swings', 'KB Swings'] });
                await create('Hammer Curls', 'upper arms');
                await create('Lateral Raises', 'shoulders');
                await create('Dumbbell Lateral Raise', 'shoulders');
            }
            const rows = await window.apiCall('/api/workout/exercise-library') || [];
            const row = rows.find((r) => r.name === step.exerciseIdentity.edit);
            if (!row) throw new Error(`exerciseIdentity: no library row ${step.exerciseIdentity.edit}`);
            await window.WorkoutLibrary.openEdit(row.id);
        } else if (step.takePending) {
            // Takes every pending dose (the timeline focus card's own read, bd
            // med-ry7b) so the card shows TL3 · all done. The write stays.
            const rows = await window.apiCall(`/api/doses?status=due,snoozed&to=${new Date().toISOString()}`);
            const occIds = (Array.isArray(rows) ? rows : []).map((r) => r.occId);
            if (occIds.length) await window.apiCall('/api/doses/act', 'POST', { action: 'take', occ_ids: occIds });
        } else if (step.snoozePending) {
            // Snoozes the newest pending dose for that many minutes, so Today's
            // Next up shows it "Snoozed until HH:MM" (bd med-ry7b.7). The write
            // stays until a later takePending.
            const rows = await window.apiCall(`/api/doses?status=due&to=${new Date().toISOString()}`);
            const last = (Array.isArray(rows) ? rows : []).slice(-1)[0];
            if (!last) throw new Error('snoozePending: no pending dose');
            await window.apiCall('/api/doses/act', 'POST', { action: 'snooze', occ_ids: [last.occId], minutes: step.snoozePending });
        } else if (step.fill) {
            // Types into an input the way a user does (fires `input`).
            await until(() => firstVisible(step.fill), STEP_MS, `fill ${step.fill}`);
            const el = firstVisible(step.fill);
            el.value = step.value;
            el.dispatchEvent(new window.Event('input', { bubbles: true }));
            // `change: true` also leaves the field (the blur-time checks).
            if (step.change) el.dispatchEvent(new window.Event('change', { bubbles: true }));
        } else if (step.aiReview) {
            // The AI review (kit FC2, med-5jq.9) without a provider on CI:
            // answer the dry-run parse with step.aiReview's items and Estimate.
            const items = step.aiReview;
            window.CloudFoodAI = Object.assign({}, window.CloudFoodAI, {
                parseMealFromDescription: async () => ({ status: 'parsed', items: items.map((it) => ({ ...it })) }),
            });
            window.showAddFoodModal({ view: 'describe' });
            document.getElementById('food-add-describe-text').value = 'breakfast';
            document.getElementById('food-add-primary-btn').click();
        } else if (step.scanStaple) {
            // FC1 (med-5jq.7) without a food DB on CI: the scanned barcode's
            // remote row and the matching food of the user's are step.scanStaple's.
            const { scanned, mine } = step.scanStaple;
            window.CloudFoodSearch = Object.assign({}, window.CloudFoodSearch, {
                remoteConfigured: async () => true,
                search: async (q, o) => (o && o.remote ? [{ ...scanned }] : []),
                stapleOffer: async () => ({ ...mine }),
            });
            window.showAddFoodModal();
            await window.FoodLog.addSheet.onScan(scanned.barcode, scanned.barcode);
        } else if (step.tag) {
            // A DOM id for a native `tap` (XCUITest finds web elements by id)
            // on an element the app renders without one.
            await until(() => firstVisible(step.tag), STEP_MS, `tag ${step.tag}`);
            // WKWebView does not expose DOM ids to XCUITest, so the id is the
            // accessible name too (the tap step matches either).
            // An element that already has an id keeps it (app code reads it).
            const el = firstVisible(step.tag);
            if (!el.id) el.id = step.id;
            el.setAttribute('aria-label', step.id);
        } else if (step.consent) {
            // The trial consent sheet has no tap path on CI (no App Attest on
            // the Simulator, no trial keys in the cloud tier): open it directly.
            // The promise stays pending; the shot is taken with the sheet up.
            window.TrialConsent.request(step.consent);
        } else if (step.firstrun) {
            // The W1 picker over the seeded vault (bd med-ta2n.1): the seed
            // completed first run, so open the overlay the way Settings →
            // "Re-run onboarding" does. Nothing is written until a tap.
            // firstrun: "trial" opens W2 (bd med-ta2n.2) the way a resumed
            // session does, skipping W1's gate.
            window.WGFirstRun.state.clear();
            if (step.firstrun === 'trial') window.WGFirstRun.state.setStep('trial');
            // firstrun: "invite" answers a placeholder shell base first, so the
            // W1 footnote's "Want it on every device? Get an invite" (IM1,
            // med-er5x) shows in local mode; the link is never followed.
            if (step.firstrun === 'invite') {
                window.Attest = {
                    isSupported: () => true,
                    status: async () => ({ supported: false, base: 'app.example.com', attested: false }),
                };
            }
            window.WGFirstRun.mount({ needs_first_run: true });
        } else if (step.invite) {
            // The F1 "Have an invite?" sheet (bd med-ta2n.6). Its W1 footer
            // button shows only in a v3 shell's local mode, which the cloud and
            // Playwright passes are not: open it the way that button does.
            document.dispatchEvent(new CustomEvent('wg:invite-open'));
        } else if (step.offer) {
            // The P3 route for a claim URL (bd med-ta2n.7): local mode with the
            // seeded records → "Turn on sync?"; account mode → "Switch account?".
            // Nothing leaves until a tap.
            window.InviteSheet.offer(step.offer);
        } else if (step.reminderHint) {
            // Kit RD3 (bd med-mt0l): the take sheet as a reminder tap opens it
            // (the deeplink's ids + slot), with the one-time lock-screen hint
            // re-armed for this QA device and its fixture preference Generic.
            try { window.localStorage.removeItem('wg.reminderDetailHint.shown'); } catch (_) { /* hint just won't show */ }
            const pref = await window.apiCall('/api/settings/reminder-delivery');
            if ((pref?.lockscreen || pref?.verbosity) !== 'generic') {
                // A UI write can offer notification permission. Keep an
                // already-Generic fixture untouched; otherwise finish that
                // real setup prompt before opening the reminder's take sheet.
                await window.apiCall('/api/settings/reminder-delivery', 'PUT', { verbosity: 'generic' });
                await runStep({ click: '[data-notify-choice="not-now"]', optional: true });
            }
            const rows = await window.apiCall(`/api/doses?status=due,snoozed&to=${new Date().toISOString()}`);
            const row = (Array.isArray(rows) ? rows : []).sort((a, b) => Date.parse(b.plannedAt) - Date.parse(a.plannedAt))[0];
            if (!row) throw new Error('reminderHint: no projected due dose in the seed');
            qa.reminderSlot = { occId: row.occId, medId: row.medId, plannedAt: row.plannedAt };
            window.handlePushAction('medication_confirm', new URLSearchParams({ ids: String(row.medId), scheduled: row.plannedAt }));
        } else if (step.staleReminder) {
            // A dose reminder gone stale before its tap (bd med-wi09.6): "taken"
            // takes the dose in-app first; "moved" points the reminder a minute
            // off the dose, as a schedule edit leaves it. The url is the app's
            // own (reminderDeeplink), which the shell keeps unchanged
            // (ios/App/ReminderPath.swift). Its toasts stay up for the shot.
            const rows = await window.apiCall(`/api/doses?status=due,snoozed&to=${new Date().toISOString()}`);
            // The latest one: the timeline's focus card, so the shot shows it.
            const row = (Array.isArray(rows) ? rows : []).sort((a, b) => Date.parse(b.plannedAt) - Date.parse(a.plannedAt))[0];
            if (!row) throw new Error('staleReminder: no due dose in the seed');
            if (step.staleReminder === 'taken') {
                // The take's own reschedule (2 s debounce) replaces every pending
                // notification: let it land before ours (local-policy.js fires
                // this after every device schedule attempt).
                const rescheduled = new Promise((ok) => document.addEventListener('wg:local-reminders-scheduled', ok, { once: true }));
                await window.apiCall('/api/doses/act', 'POST', { action: 'take', occ_ids: [row.occId] });
                await Promise.race([rescheduled, sleep(STEP_MS)]);
            }
            const slotUnix = Date.parse(row.plannedAt) / 1000 + (step.staleReminder === 'moved' ? 60 : 0);
            const { reminderDeeplink } = await import('/js/reminder-deeplink.js');
            const url = reminderDeeplink({ kind: 'medication', medicationIds: [row.medId], fireAtUnix: slotUnix, slotUnix });
            const sm = window.SyncManager;
            const show = sm.showToast.bind(sm);
            sm.showToast = (m, t, o) => show(m, t, { ...o, duration: 0 });
            // A real notification for the native `notification` step to tap,
            // on the real clock (the page's is pinned), 15 s out: past the
            // ready wait and the permission alert. Resolves how many the shell
            // scheduled (Playwright's stub bridge: 0).
            const ln = window.LocalNotifications;
            const realNow = () => Math.floor((window.performance.timeOrigin + window.performance.now()) / 1000);
            let fireAtUnix = 0;
            const schedule = () => {
                if (!fireAtUnix) fireAtUnix = realNow() + 15;
                if (realNow() >= fireAtUnix) return Promise.resolve(0);
                return ln.schedule([{ fireAtUnix, title: 'Med Tracker', body: 'QA stale reminder', url }]);
            };
            // Every app schedule is replace-all (e.g. its re-run once the
            // permission is granted, reminders.js askPermissionIfNeeded): add
            // ours back after each one until it fires.
            document.addEventListener('wg:local-reminders-scheduled', () => { if (fireAtUnix) schedule(); });
            let scheduled = 0;
            if (ln && ln.isSupported()) {
                // Not granted yet: iOS shows its alert (the native
                // allowNotifications step answers it), so this is not awaited.
                if (await ln.permission() !== 'granted') {
                    ln.requestPermission().then(schedule);
                    scheduled = 1;
                } else {
                    scheduled = await schedule();
                }
            }
            if (!scheduled) {
                // No shell that delivers (Playwright): what Shell.openReminder runs on a tap.
                window.history.replaceState({}, '', url);
                window.handleDeepLinks();
                await until(() => firstVisible('.wg-toast, .wg-timeline__stale, #med-confirm-modal'), STEP_MS, 'reminder landing');
            }
        } else if (step.inviteRequest) {
            // The W5 "Request an invite" sheet (bd med-ta2n.14). Its button
            // needs the shell's base.post op, which no QA pass has: open it
            // directly with a placeholder base and a stub POST, so nothing
            // leaves the page.
            // inviteRequest: "sent" fills an email and sends (stub 202); "w4"
            // opens it the way the W4 protect sheet does (IM2 · W4, med-er5x).
            const w4 = step.inviteRequest === 'w4' ? { lead: 'copy', eyebrow: '43 records on this phone' } : {};
            const ui = window.InviteSheet.request({
                ...w4,
                base: 'app.example.com',
                post: async () => new Response('{"status":"sent"}', { status: 202 }),
            });
            if (ui && step.inviteRequest === 'sent') {
                ui.email.value = 'name@example.com';
                ui.send.click();
            }
        } else if (step.openAccount) {
            // Path 0 "Open my account" (bd med-r1j2.5, AD10). Its W5 entry shows
            // only where the shell reports its base, which no QA pass does:
            // answer a placeholder base and open the page the way the entry
            // does. Nothing leaves until "Unlock with passkey", never tapped.
            // openAccount: "invalid" types a partial address and commits it.
            window.Attest = {
                isSupported: () => true,
                status: async () => ({ supported: false, base: 'app.example.com', attested: false }),
            };
            window.InviteSheet.openAccount();
            const input = document.getElementById('open-account-input');
            const go = document.querySelector('.wg-pagefoot [data-invite-action="open-account"]');
            const type = (v, commit) => {
                input.value = v;
                input.dispatchEvent(new Event('input'));
                if (commit) input.dispatchEvent(new Event('change'));
            };
            // The base arrives async: a full address enables the sun once it has.
            await until(() => { type('anna.app.example.com'); return !go.disabled; }, STEP_MS, 'open account base');
            if (step.openAccount === 'invalid') type('anna.app', true);
        } else if (step.shellSignedIn) {
            // The iOS app signed into an account (bd med-y7b4.2), in the cloud
            // pass: give LocalNotifications its own copy of the bridge with the
            // shell's platform, which is what settings.js nativeLeaveAccount
            // reads (CloudVault.leaveAccount is cloud-boot's own). The slot-②
            // row then shows on the next Settings open; no scene taps it.
            const ln = window.LocalNotifications;
            if (!ln) throw new Error('shellSignedIn: no LocalNotifications');
            ln.__native = Object.assign(Object.create(ln.__native || {}), { platform: 'ios' });
        } else if (step.localFeedback) {
            // Settings → Send feedback in local mode (bd med-ta2n.20) mounts
            // only where the shell has App Attest and base.post, which no QA
            // pass has: answer both for this document and run the app's own
            // mount. Nothing leaves the page until a Send, which no scene taps.
            const native = window.LocalNotifications && window.LocalNotifications.__native;
            if (!native) throw new Error('localFeedback: no shell bridge');
            const has = native.has;
            native.has = (op) => (op === 'base.post' ? Promise.resolve(true) : has(op));
            window.Attest = {
                isSupported: () => true,
                status: async () => ({ supported: true, base: 'app.example.com', attested: false }),
            };
            const policy = await import('/js/local-policy.js');
            if (!(await policy.mountLocalFeedback({ win: window }))) throw new Error('localFeedback: not mounted');
            // The row sits in the last Settings slot: bring it on screen.
            const row = document.getElementById('feedback-launcher');
            if (row) row.scrollIntoView({ block: 'center' });
        } else if (step.trial) {
            // The AI-trial card (kit A1) has no natural state on CI either (no
            // App Attest, and the seed vault has its own OpenAI key): stub what
            // the card reads with step.trial as the trial status. Scenes using
            // it run last, since the stub stays for the rest of the run.
            const status = step.trial;
            if (window.CloudVault && window.CloudVault.trial) {
                window.CloudVault.trial.status = async () => status;
            } else if (!document.querySelector('meta[name="medtracker-trial-ai"]')) {
                // Account mode (the cloud pass): the server advertises the
                // operator trial with this flag only when it has a trial key,
                // and the visual cloud server has none.
                const meta = document.createElement('meta');
                meta.name = 'medtracker-trial-ai';
                meta.content = '1';
                document.head.appendChild(meta);
            }
            window.SettingsIntegrations.trialOffer = async () => status.on !== true;
        } else if (step.noAIKey) {
            // The seed vault has its own OpenAI key, which hides the Settings
            // trial offer: answer the integrations read with that key blank.
            // The vault itself keeps the key.
            const call = window.apiCall;
            window.apiCall = (endpoint, method, ...rest) => (endpoint === '/api/settings/integrations' && (!method || method === 'GET')
                ? call(endpoint, method, ...rest).then((p) => (p && p.openai ? { ...p, openai: { ...p.openai, api_key: '' } } : p))
                : call(endpoint, method, ...rest));
        } else if (step.emptyOverview) {
            // Vitals with no data (bd med-0xad.5): answer the overview read with
            // an empty object, so every tile shows a dash and every card its
            // empty state. The vault keeps its rows; the stub lasts this load.
            const call = window.apiCall;
            window.apiCall = (endpoint, method, ...rest) => (String(endpoint).startsWith('/api/health/overview') && (!method || method === 'GET')
                ? Promise.resolve({})
                : call(endpoint, method, ...rest));
        } else if (step.kitNudge) {
            // The Emergency Kit nudge (bd med-ta2n.15) waits 2 days after
            // sign-in, and the cloud pass signs in fresh: answer the card's
            // status read with step.kitNudge. The stub stays for the run.
            const status = step.kitNudge;
            const call = window.apiCall;
            window.apiCall = (endpoint, method, ...rest) => (endpoint === '/api/protection/kit-nudge' && !method
                ? Promise.resolve(status)
                : call(endpoint, method, ...rest));
        } else if (step.tzPlan) {
            // A pending timezone plan (bd med-26gl: its card sits at the top of
            // Today): the seed has none, so answer the plan read with step.tzPlan
            // and refresh the banner, which reloads Today. The stub stays for the run.
            const result = step.tzPlan;
            const call = window.apiCall;
            window.apiCall = (endpoint, method, ...rest) => (endpoint === '/api/tz-plan/current' && method === 'GET'
                ? Promise.resolve(result)
                : call(endpoint, method, ...rest));
            // refresh() reloads the current tab on a change; the scene's next
            // tab step loads Today anyway, so skip that dangling reload.
            const reload = window.reloadCurrentTab;
            window.reloadCurrentTab = () => {};
            try { await window.TZPlanBanner.refresh(); } finally { window.reloadCurrentTab = reload; }
        } else if (step.healthCopy) {
            // Copy past entries (bd med-8f4s.11, kit HW6-HW9b) shows only on a
            // phone shell that writes to Health, which no QA pass has: mount the
            // app's own Health card over a stub store where other apps hold
            // nothing, writing on, in page-only storage, and reach the state
            // step.healthCopy names: "row" HW7, "offer" HW6 (the dialog the row
            // opens), "running" HW8 (a few calls land, then the store
            // stops answering), "paused" HW8b (every call fails), "done" HW9,
            // "refused" HW9b (weight not allowed), "cut" HW6 with the past-data
            // line (Miles 16121). The vault is only read.
            const mode = step.healthCopy;
            const kinds = ['bp', 'weight', 'hr', 'workout'];
            const mem = new Map([
                ['wg.health.enabled', 'true'], ['wg.health.write', 'true'], ['wg.health.backfillOffered', 'true'],
                ['wg.health.asked', JSON.stringify(['bp', 'weight', 'sleep', 'workout', 'steps', 'hr', 'spo2'])],
                ['wg.health.writeAsked', JSON.stringify(kinds)],
            ]);
            const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
            // running: the first pass lands 4 calls and fails the rest, so it
            // ends with progress (the row renders per pass); every later call
            // never answers, which holds HW8 "N of M" with the meter.
            let calls = 0;
            let hold = false;
            const answer = () => {
                if (mode === 'paused') return Promise.reject(new Error('busy'));
                if (mode !== 'running') return Promise.resolve(true);
                if (hold) return new Promise(() => {});
                if (++calls === 5) setTimeout(() => { hold = true; }, 0);
                return calls <= 4 ? Promise.resolve(true) : Promise.reject(new Error('busy'));
            };
            // The batched form, write({ entries }) (web/static/js/native/health.js
            // batch contract, "write({ entries: [body, ...] })"; consumed by
            // health-import.js writeEntries): one result per entry in request
            // order, true | "<that entry's error>"; a store failure rejects the
            // whole call. A scalar reply would read as zero results.
            const write = (args) => {
                if (!args || !Array.isArray(args.entries)) return answer();
                if (mode === 'paused') return Promise.reject(new Error('busy'));
                if (mode === 'running') {
                    // The first batch lands 4 entries and leaves the rest's
                    // results missing (a shorter array: kept, still queued, so
                    // the job stays mid-copy; an error string would end it);
                    // every later call never answers.
                    if (hold) return new Promise(() => {});
                    setTimeout(() => { hold = true; }, 0);
                    return Promise.resolve(args.entries.slice(0, 4).map(() => true));
                }
                return Promise.resolve(args.entries.map((e) => (mode === 'refused' && e.type === 'weight' ? 'denied' : true)));
            };
            const health = {
                label: 'Health Connect', accessHint: 'Health Connect → App permissions',
                isSupported: () => true, canWrite: async () => true, requestAuthorization: async () => true,
                // readableFrom: a shell without it offers no Copy; "cut" reads
                // the last 30 days only (Android without the history permission).
                writeAccess: async () => ({
                    granted: mode === 'refused' ? kinds.filter((k) => k !== 'weight') : kinds, supported: kinds,
                    readableFrom: mode === 'cut' ? Date.now() - 30 * 86400e3 : 0,
                }),
                query: async () => ({ samples: [], anchor: 'qa', returned: 0, more: false }),
                write, remove: answer,
            };
            const { startHealthImport } = await import('/js/health-import.js');
            const { localRecordsPort } = await import('/js/sync.js');
            // A shell with Health already mounted the real card: this one replaces it.
            const mounted = document.getElementById('health-import-row');
            if (mounted) mounted.parentNode.remove();
            await startHealthImport({ accountId: 'local' }, {
                health, storage, doc: document, records: localRecordsPort(), run: async () => null,
                afterImport: async () => {}, appRefresh: { setImport: () => {} },
                ask: mode === 'offer' || mode === 'cut' ? undefined : async () => true, // offer/cut: the app's own dialog
            });
            await until(() => document.querySelector('#health-copy-row[data-state="ready"]'), STEP_MS, 'health copy row');
            const row = document.getElementById('health-copy-row');
            row.scrollIntoView({ block: 'center' });
            if (mode !== 'row') row.click();
            // HW8 with a moved meter: past the first pass, not "0 of N".
            if (mode === 'running') {
                await until(() => /^[1-9]\d* of /.test(document.querySelector('#health-copy-row .wg-setting__desc')?.textContent || ''), STEP_MS, 'health copy progress');
            }
        } else if (step.healthNative) {
            // iOS Simulator scene: only the native seed writes Health samples.
            // Remove fixture vitals, then run the real native importer and assert its values.
            if (!document.documentElement.classList.contains('wg-local-vault') || !window.Health?.isSupported()) {
                throw new Error('native Health scene requires the iOS local shell');
            }
            const key = 'wg-qa-native-health-cleared';
            if (!sessionStorage.getItem(key)) {
                const vault = shiftDates(await getJSON('/qa/vault-v1.json'), new Date());
                vault.data.vitals = { day_stats: [], heart: [], sleep: [], spo2: [] };
                const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                if (tz) vault.data.settings.timezone = tz;
                await window.CloudVault.importAll(vault);
                sessionStorage.setItem(key, '1');
                window.location.reload();
                await new Promise(() => {});
            }
            const { runHealthImport, resetHealthAnchors } = await import('/js/health-import.js');
            const { localRecordsPort } = await import('/js/sync.js');
            resetHealthAnchors();
            localStorage.setItem('wg.health.enabled', 'true');
            await runHealthImport({ accountId: 'local' }, { records: localRecordsPort(), flush: async () => {} });
            const data = await window.apiCall('/api/health/overview', 'GET');
            if (data.average_heart_rate_7d !== 65 || data.average_spo2_7d !== 98 || data.average_sleep_hours_7d !== 7 ||
                !data.step_stats_7d.some((d) => d.steps === 4000)) throw new Error('native Health seed values missing from imported overview');
        } else if (step.startHere) {
            // W3 "Start here" (bd med-ta2n.3): the seed has a record in every
            // module, so replace it once with the fixture minus step.startHere.drop
            // (vault data sections) and store step.startHere.picked as the W1
            // picks, then reload. Destructive for the store: the scene runs last.
            // ponytail: once per tab session (sessionStorage); a runner that
            // reused the tab for another partial scene would need a key per scene.
            const KEY = 'wg-qa-start-here';
            let done = false;
            try { done = window.sessionStorage.getItem(KEY) === '1'; } catch (_) { /* no storage */ }
            if (!done) {
                const vault = shiftDates(await getJSON('/qa/vault-v1.json'), new Date());
                const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                if (tz && vault.data && vault.data.settings) vault.data.settings.timezone = tz;
                for (const k of step.startHere.drop || []) delete vault.data[k];
                await window.CloudVault.importAll(vault);
                await window.apiCall('/api/firstrun/complete', 'POST', { picked: step.startHere.picked });
                try { window.sessionStorage.setItem(KEY, '1'); } catch (_) { /* no storage */ }
                window.location.reload();
                await new Promise(() => {}); // the next load runs the scene
            }
        } else if (step.twoPlans) {
            // PL4: replace the store once with the seeded vault plus a second
            // active plan (withTwoPlans), then reload. Destructive like noPlan:
            // the scene runs after every scene that reads the seeded plan.
            const KEY = 'wg-qa-two-plans';
            let done = false;
            try { done = window.sessionStorage.getItem(KEY) === '1'; } catch (_) { /* no storage */ }
            if (!done) {
                const vault = withTwoPlans(seedVault(await getJSON('/qa/vault-v1.json')));
                const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                if (tz && vault.data && vault.data.settings) vault.data.settings.timezone = tz;
                await window.CloudVault.importAll(vault);
                try { window.sessionStorage.setItem(KEY, '1'); } catch (_) { /* no storage */ }
                window.location.reload();
                await new Promise(() => {}); // the next load runs the scene
            }
        } else if (step.noPlan) {
            // WN6 (bd med-soo0.6): someone with no plan who logs workouts.
            // Replace the store once with the seeded vault minus every plan
            // (groups, days, their sessions), keeping the off-plan sessions
            // and the band walk, then reload. Destructive: runs last, like startHere.
            const KEY = 'wg-qa-no-plan';
            let done = false;
            try { done = window.sessionStorage.getItem(KEY) === '1'; } catch (_) { /* no storage */ }
            if (!done) {
                const vault = seedVault(await getJSON('/qa/vault-v1.json'));
                const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                if (tz && vault.data && vault.data.settings) vault.data.settings.timezone = tz;
                const w = vault.data.workouts;
                Object.assign(w, { groups: [], variants: [], exercises: [], rotations: [] });
                w.sessions = w.sessions.filter((x) => x.group_id === -1);
                const kept = new Set(w.sessions.map((x) => x.id));
                w.exercise_logs = w.exercise_logs.filter((l) => kept.has(l.session_id));
                await window.CloudVault.importAll(vault);
                try { window.sessionStorage.setItem(KEY, '1'); } catch (_) { /* no storage */ }
                window.location.reload();
                await new Promise(() => {}); // the next load runs the scene
            }
        } else if (step.pull) {
            // Pull to refresh (bd med-y7b4.6, kit PR2 / PR3). No QA pass has the
            // Health import, and a real pull would sync: "busy" pulls over a
            // stub import that never ends, so the pill stays in its busy state;
            // "done" shows the ok toast a pull with new readings ends on, kept up;
            // "stub" only registers that stub, for a real finger drag after
            // (the iOS native pullDown step, bd med-y7b4.7).
            if (step.pull === 'stub') {
                window.AppRefresh.setImport(() => new Promise(() => {}), 'Apple Health', () => true);
                window.scrollTo(0, 0);
            } else if (step.pull === 'busy') {
                window.AppRefresh.setImport(() => new Promise(() => {}), 'Apple Health', () => true);
                const fire = (type, y) => {
                    const e = new Event(type, { bubbles: true });
                    Object.defineProperty(e, 'touches', { value: y === undefined ? [] : [{ clientY: y }] });
                    document.dispatchEvent(e);
                };
                window.scrollTo(0, 0);
                fire('touchstart', 10);
                fire('touchmove', 110);
                fire('touchend');
            } else {
                window.safeToast('12 new readings from Apple Health', 'success', { duration: 0 });
            }
        } else if (step.euRegister) {
            // The EU register flow (bd med-3u28.4, FlowQAEURegisterTests): once
            // per load (a redone scene keeps the first numbers).
            if (!qa.euRegister) qa.euRegister = await euRegister(step.euRegister);
        } else if (step.settingsPage) {
            await until(() => window.SettingsView.openSettingsPage(step.settingsPage), STEP_MS, `settings page ${step.settingsPage}`);
        } else if (step.file) {
            // A picked file for a (hidden) <input type="file">: the OS picker
            // can't be driven. step.text is its content (default "{}").
            const input = document.querySelector(step.file);
            if (!input) throw new Error(`file ${step.file}: no such input`);
            const dt = new DataTransfer();
            dt.items.add(new File([step.text || '{}'], step.name || 'backup.json', { type: 'application/json' }));
            input.files = dt.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (step.scroll) {
            // Bring a below-the-fold element into view (the W1 footnote, bd
            // med-ta2n.28, sits under the sticky foot).
            // scrollIntoView moved the page under the fixed overlay on WebKit
            // 390 (the 16e shot showed Today): scroll the element's own
            // scroller to its end and wait until it holds still with the
            // element inside the viewport and the scroller's box, 1px slack
            // (the Android WebView misses an exact bottom, bd med-3vc6).
            await until(() => firstVisible(step.scroll), STEP_MS, `scroll ${step.scroll}`);
            const target = firstVisible(step.scroll);
            let box = target.parentElement;
            while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
            box = box || document.scrollingElement;
            let last = -1, seen = '';
            try {
                await until(() => {
                    box.scrollTop = box.scrollHeight;
                    const bottom = target.getBoundingClientRect().bottom;
                    const boxBottom = box === document.scrollingElement ? window.innerHeight : box.getBoundingClientRect().bottom;
                    const settled = box.scrollTop === last && bottom <= Math.min(window.innerHeight, boxBottom) + 1;
                    last = box.scrollTop;
                    seen = `bottom=${bottom} innerHeight=${window.innerHeight} boxBottom=${boxBottom} scrollTop=${box.scrollTop}/${box.scrollHeight}/${box.clientHeight}`;
                    return settled;
                }, STEP_MS, `scroll ${step.scroll} into view`);
            } catch (e) {
                throw new Error(`${e.message} (${seen})`);
            }
        } else if (step.call) {
            // An app entry point by its global name (showAddModal,
            // showAddFoodModal…): the editor a native step then types into.
            if (typeof window[step.call] !== 'function') throw new Error(`call ${step.call}: no such function`);
            await window[step.call](...(step.args || []));
            await settle();
        } else if (step.fillAll) {
            // fill for every visible match in order (a schedule's time rows).
            await until(() => document.querySelectorAll(step.fillAll).length && firstVisible(step.fillAll), STEP_MS, `fillAll ${step.fillAll}`);
            const els = Array.from(document.querySelectorAll(step.fillAll)).filter(visible);
            if (els.length !== step.values.length) throw new Error(`fillAll ${step.fillAll}: ${els.length} fields for ${step.values.length} values`);
            els.forEach((el, i) => {
                el.value = step.values[i];
                el.dispatchEvent(new window.Event('input', { bubbles: true }));
                el.dispatchEvent(new window.Event('change', { bubbles: true }));
            });
        } else if (step.remember) {
            // A value the flow test compares against later (the kcal total
            // before a meal): the report's flow.memo[as].
            await until(() => firstVisible(step.remember), STEP_MS, `remember ${step.remember}`);
            if (!(step.as in qa.memo)) qa.memo[step.as] = firstVisible(step.remember).textContent.replace(/\s+/g, ' ').trim();
        } else if (step.waitText) {
            // Until that element shows that text (a list's data has loaded).
            await until(() => { const el = firstVisible(step.waitText); return el && el.textContent.includes(step.text); }, STEP_MS, `waitText ${step.waitText} ${step.text}`);
        } else if (step.coreLocal) {
            await coreLocalSetup(step.coreLocal);
        } else if (step.openMed) {
            // The editor of the medication with that name, from Meds → Schedule.
            const med = ((await window.apiCall('/api/medications')) || []).find((m) => m.name === step.openMed);
            if (!med) throw new Error(`openMed: no medication ${step.openMed}`);
            window.switchTab('meds');
            await settle();
            await until(() => firstVisible('.med-tab[data-tab="schedule"]'), STEP_MS, 'Meds Schedule tab');
            firstVisible('.med-tab[data-tab="schedule"]').click();
            await until(() => firstVisible(`[data-med-id="${med.id}"]`), STEP_MS, `schedule row ${med.id}`);
            firstVisible(`[data-med-id="${med.id}"]`).click();
            await until(() => firstVisible('#med-modal #med-name'), STEP_MS, 'medication editor');
        } else if (step.takeDose) {
            // Precondition writes (a dose already taken): today's due dose of
            // that medication at that local time, through the app's own API.
            // A redone scene finds it taken and does nothing.
            const { med: name, at } = step.takeDose;
            const med = ((await window.apiCall('/api/medications')) || []).find((m) => m.name === name);
            if (!med) throw new Error(`takeDose: no medication ${name}`);
            const rows = await window.apiCall(`/api/doses?status=due,snoozed&to=${new Date().toISOString()}`) || [];
            const row = rows.find((r) => String(r.medId) === String(med.id) && r.localTime === at && r.localDate === localDate(new Date()));
            if (row) await window.apiCall('/api/doses/act', 'POST', { action: 'take', occ_ids: [row.occId] });
            await window.DataStore.invalidateTags(['medications', 'history']);
            await settle();
        } else {
            throw new Error(`unknown step ${JSON.stringify(step)}`);
        }
        await sleep(50);
    }

    function localDate(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // FlowQACoreLocalTests' fixture (bd med-sz4k.6.1, twin of android/qa
    // core-local.mjs's setup), idempotent across the flow's launches: the
    // golden vault's timezone history and intake zones become the device's
    // (a Berlin history moves today's slots; one reload after the import),
    // its own medications are archived so no other dose competes, and
    // `meds` (name → daily times) exist as the YAML's precondition says.
    async function coreLocalSetup({ meds = {} } = {}) {
        // The notification ask after a med write is not this flow's subject
        // (Android pre-grants the permission): this device counts as asked.
        window.localStorage.setItem('wg.notifyPermission.asked', '1');
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const vault = JSON.parse(await window.CloudVault.exportAll({ includeSecrets: false }));
        const d = vault.data;
        const foreign = (d.tz && ((d.tz.history || []).length || (d.tz.transitions || []).length || (d.tz.transition_plans || []).length || (d.tz.current && d.tz.current !== tz)))
            || (d.medications.intakes || []).some((i) => i.tz && i.tz !== tz);
        if (foreign) {
            d.tz = { current: tz, history: [], transition_plans: [], transitions: [] };
            d.settings.timezone = tz;
            for (const intake of d.medications.intakes || []) if (intake.tz) intake.tz = tz;
            await window.CloudVault.importAll(JSON.stringify(vault));
            window.location.reload();
            await new Promise(() => {}); // the next load runs the scene again
        }
        const all = (await window.apiCall('/api/medications?archived=true')) || [];
        for (const m of all) {
            if (!m.archived && !(m.name in meds) && !m.name.startsWith('QA B1')) {
                await window.apiCall(`/api/medications/${m.id}`, 'POST', { ...m, archived: true });
            }
        }
        for (const [name, times] of Object.entries(meds)) {
            if (all.some((m) => m.name === name)) continue;
            await window.apiCall('/api/medications', 'POST', {
                name, dosage: '5mg', schedule: JSON.stringify({ type: 'daily', times }), archived: false, supplement: false,
            });
        }
        await window.DataStore.invalidateTags(['medications', 'history']);
        await settle();
    }

    // jsdom has no layout (every rect is empty), so there "visible" falls back
    // to "not inside [hidden] / .hidden".
    function visible(el) {
        if (!el || !el.isConnected || el.closest('[hidden], .hidden')) return false;
        return el.getClientRects().length > 0 || document.documentElement.getClientRects().length === 0;
    }

    // Selectors like .wg-pagebar also match markup in inactive views.
    function firstVisible(sel) {
        return Array.from(document.querySelectorAll(sel)).find(visible) || null;
    }

    // Ready once no store change has landed for QUIET_MS (capped).
    function settle() {
        return new Promise((resolve) => {
            let timer;
            const done = () => { window.removeEventListener('datastore:changed', bump); clearTimeout(cap); resolve(); };
            const bump = () => { clearTimeout(timer); timer = setTimeout(done, QUIET_MS); };
            const cap = setTimeout(done, SETTLE_CAP_MS);
            window.addEventListener('datastore:changed', bump);
            bump();
        });
    }

    // Pure DOM arithmetic. A failing probe sets ok=false; keyboardShown is
    // reported, never failed on: the runner knows which scenes expect it.
    // The visible top in client coordinates. Chromium measures client rects
    // from the layout viewport (visible top = vv.offsetTop); iOS WKWebView
    // measures them from the visual viewport (visible top = 0), which made the
    // old `top < vv.offsetTop` flag an on-screen sheet header (med-m1x5). A
    // marker fixed at the layout top reads the layout top in whichever space
    // the engine uses; the visual viewport sits offsetTop below it. The marker
    // is QA tooling, never app markup; the cloud pass has no driver.css and its
    // CSP (style-src 'self') blocks a style attribute, but not CSSOM.
    function visibleTop(vv) {
        if (!vv) return 0;
        const marker = document.createElement('div');
        marker.setAttribute('data-wg-qa', '');
        marker.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden';
        document.body.appendChild(marker);
        const layoutTop = marker.getBoundingClientRect().top;
        marker.remove();
        return layoutTop + vv.offsetTop;
    }

    function probe() {
        const vv = window.visualViewport;
        const shown = (sel) => Array.from(document.querySelectorAll(sel)).filter(visible);
        const rect = (el) => el.getBoundingClientRect();
        const tag = (el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (el.classList[0] ? `.${el.classList[0]}` : '');
        const focused = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
        const tabbar = shown('.wg-tabbar')[0];
        const top = visibleTop(vv);
        // An open sheet or page covers the screen behind it with its scrim: a
        // header back there panned off by the iOS keyboard is not clipped UI.
        const layers = shown('mt-modal');
        const onTop = (el) => !layers.length || layers.some((m) => m.contains(el));
        const stacked = (window.ModalManager?._stack || []).map((id) => document.getElementById(id)).filter((el) => layers.includes(el));
        const activeModal = layers.filter((el) => el.classList.contains('mt-confirm-modal')).at(-1) || stacked.at(-1) || layers.at(-1);
        const focusOnTop = !activeModal || !!(focused && activeModal.contains(focused));
        const editable = !!(focused && !focused.disabled && !focused.readOnly && (focused.isContentEditable
            || focused.tagName === 'TEXTAREA'
            || (focused.tagName === 'INPUT' && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(focused.type))));
        const focusRect = focused && rect(focused);
        const layoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
        const width = (vv && vv.width) || window.innerWidth;
        if (Math.abs(width - viewportBaseline.width) > 1) viewportBaseline.height = layoutHeight;
        viewportBaseline.width = width;
        viewportBaseline.height = Math.max(viewportBaseline.height, layoutHeight);
        const keyboardShown = !!(vv && vv.scale === 1 && vv.height < viewportBaseline.height - 100);
        const viewportBottom = top + (vv ? vv.height : window.innerHeight);
        const checkFocus = !!(focused && editable && focusOnTop && visible(focused));
        const focusOutsideViewport = !!(checkFocus && (focusRect.bottom > viewportBottom + 0.5 || focusRect.top < top - 0.5));
        // An in-flow header above the top of a scrolled document was scrolled
        // past, not clipped (med-y5xx.15: the meds timeline scrolls to today,
        // a scene step scrolls a row into view). A fixed/sticky one still counts.
        const layoutTop = top - (vv ? vv.offsetTop : 0);
        const pinned = (el) => {
            for (let n = el; n && n !== document.body; n = n.parentElement) {
                if (/fixed|sticky/.test(getComputedStyle(n).position)) return true;
            }
            return false;
        };
        // It must also sit above the layout top: a header still inside the layout
        // viewport but hidden by a keyboard pan on a scrolled page is clipped.
        const scrolledPast = (el) => window.scrollY > 0 && !pinned(el) && rect(el).top < layoutTop
            && rect(el).top - layoutTop + window.scrollY >= -0.5;
        const probes = {
            scale: vv ? vv.scale : 1,
            hOverflow: document.documentElement.scrollWidth - window.innerWidth,
            // Above the visible top: a panned visual viewport (keyboard) hides a
            // header whose layout top is still >= 0.
            clippedTop: shown('.wg-sheet__header, .wg-sheethead, .wg-appbar, .wg-pagebar')
                .filter((el) => onTop(el) && rect(el).top < top - 0.5 && !scrolledPast(el)).map(tag),
            // Charts are <svg>; icons (small svg) are skipped.
            canvasOverflow: shown('canvas, svg').filter((el) => {
                const w = rect(el).width;
                return w > 64 && el.parentElement && w > rect(el.parentElement).width + 0.5;
            }).map(tag),
            focusUnderKeyboard: !!(checkFocus && keyboardShown && focusRect.bottom > viewportBottom + 0.5),
            focusOutsideViewport,
            // Enough geometry to distinguish a background/button focus from
            // a genuinely obscured editable field in the actual screenshot.
            focusContext: {
                target: focused ? tag(focused) : null, editable, onTop: focusOnTop,
                activeModal: activeModal ? tag(activeModal) : null,
                rect: focusRect ? { top: focusRect.top, bottom: focusRect.bottom } : null,
                viewportTop: top, viewportBottom, layoutHeight, baselineHeight: viewportBaseline.height,
                visualViewport: vv ? { height: vv.height, width: vv.width, offsetTop: vv.offsetTop, scale: vv.scale } : null,
            },
            bottomNavCovered: !!(tabbar && rect(tabbar).bottom > window.innerHeight + 0.5),
            keyboardShown,
        };
        const failed = [];
        if (probes.scale !== 1) failed.push('scale');
        if (probes.hOverflow > 0) failed.push('hOverflow');
        if (probes.clippedTop.length) failed.push('clippedTop');
        if (probes.canvasOverflow.length) failed.push('canvasOverflow');
        if (probes.focusUnderKeyboard) failed.push('focusUnderKeyboard');
        else if (probes.focusOutsideViewport) failed.push('focusOutsideViewport');
        if (probes.bottomNavCovered) failed.push('bottomNavCovered');
        return { probes, failed };
    }

    let rev = 0;
    function report(def) {
        const { probes, failed } = probe();
        // Every report re-checks the scene: a shot whose ready content is gone
        // (the app switched away) is a failed scene, not a passing one.
        probes.readyLost = lostReady(def);
        if (probes.readyLost.length) failed.push('ready');
        if (def.rendered && def.rendered.length) {
            probes.renderedValues = def.rendered.map(({ selector, text }) => {
                const el = firstVisible(selector);
                const actual = el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
                return { selector, expected: text, actual };
            });
            if (probes.renderedValues.some(({ expected, actual }) => expected !== actual)) failed.push('rendered');
        }
        // inView: each selector's first visible match sits wholly between the
        // visible top and the viewport bottom, or the top of a bottom tab bar
        // (a desktop side rail is not a floor): reachable without scrolling.
        if (def.inView && def.inView.length) {
            const { viewportTop, viewportBottom } = probes.focusContext;
            const bar = firstVisible('.wg-tabbar');
            const barTop = bar ? bar.getBoundingClientRect().top : Infinity;
            const floor = barTop > (viewportTop + viewportBottom) / 2 ? Math.min(viewportBottom, barTop) : viewportBottom;
            probes.inView = def.inView.map((selector) => {
                const el = firstVisible(selector);
                const r = el && el.getBoundingClientRect();
                return { selector, top: r ? r.top : null, bottom: r ? r.bottom : null, floor,
                    ok: !!r && r.top >= viewportTop - 0.5 && r.bottom <= floor + 0.5 };
            });
            if (probes.inView.some((v) => !v.ok)) failed.push('inView');
        }
        return { scene: def.name, ok: failed.length === 0, rev: rev++, loads, failed, probes, paint: paintRect(def), reminderSlot: qa.reminderSlot, euRegister: qa.euRegister,
            flow: def.flow ? flowState(def) : undefined };
    }

    // The EU register check on this shell (bd med-3u28.4, twin of Android's
    // eu-register.mjs): `want` is the choice Settings must have stored (a
    // relaunch keeps it). "us": local mode has no RxNav, so after the editor's
    // name commit (the scene's steps before) nothing checks and nothing loads.
    // "eu": opens the editor and commits the name itself, timing the real
    // first load to the chip with a 50 ms timer probe (its worst lateness is
    // the freeze proxy; WebKit has no longtask entries and no heap API, so
    // memory is the runner's WebContent RSS log, matched by the epoch ms
    // here), counts the loader's asset fetches, checks the cache entry, then
    // measures the phases apart.
    async function euRegister(want) {
        const ASSET = '/static/data/ema-article57-rev90-v1.json';
        // The settings record's med_register (bd med-3u28.6), as the Settings row reads it.
        const settings = await window.apiCall('/api/settings');
        const register = settings && settings.med_register === 'eu' ? 'eu' : 'us';
        if (register !== want) throw new Error(`euRegister: the stored choice is ${register}, want ${want}`);
        const epoch = () => Math.round(window.performance.timeOrigin + window.performance.now()); // the page clock is pinned
        const emaCaches = async () => {
            try { return (await window.caches.keys()).filter((n) => n.startsWith('medtracker-ema-')); } catch (e) { return String((e && e.message) || e); }
        };
        const r = { register, secure: window.isSecureContext, cacheApi: typeof window.caches !== 'undefined', cachesBefore: await emaCaches() };
        if (want === 'us') {
            await sleep(3000); // a check would have painted by now
            r.check = await window.apiCall(`/api/medications/ema-check?name=Candecor`);
            r.euSlot = visible(document.getElementById('med-eu-slot'));
            r.rxChip = visible(document.getElementById('med-rx-display'));
            r.cachesAfter = await emaCaches();
            return r;
        }
        let maxLag = 0, stop = false;
        const probe = () => {
            const t = window.performance.now();
            setTimeout(() => { maxLag = Math.max(maxLag, window.performance.now() - t - 50); if (!stop) probe(); }, 50);
        };
        // Counts the loader's asset requests (it calls globalThis.fetch per
        // request): 1 = read from the bundle, 0 = served by its cache.
        const realFetch = window.fetch;
        let assetFetches = 0;
        window.fetch = function (input, ...rest) {
            if (String((input && input.url) || input).includes('/static/data/ema-')) assetFetches++;
            return realFetch.call(this, input, ...rest);
        };
        r.storedBefore = await cacheHit(ASSET);
        // The editor's own path: open it, commit the name, wait for the chip.
        probe();
        r.firstAt = epoch();
        const t0 = window.performance.now();
        window.switchTab('meds');
        window.showAddModal();
        await until(() => document.getElementById('med-name'), STEP_MS, 'editor');
        const input = document.getElementById('med-name');
        input.value = 'Candecor';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        input.dispatchEvent(new window.Event('change', { bubbles: true }));
        let progress = false;
        const end = Date.now() + 60000;
        while (!visible(document.getElementById('med-eu-chip'))) {
            if (document.querySelector('#med-eu-slot .wg-meter')) progress = true;
            if (document.getElementById('med-eu-retry')) throw new Error('euRegister: the editor shows "Couldn\'t load"');
            if (Date.now() > end) throw new Error('euRegister: no EU chip in 60 s');
            await sleep(20);
        }
        r.first = { ms: Math.round(window.performance.now() - t0), progress, chip: document.getElementById('med-eu-chip').textContent.trim() };
        await sleep(200);
        stop = true;
        window.fetch = realFetch;
        r.first.maxTimerLagMs = Math.round(maxLag);
        r.firstEnd = epoch();
        r.assetFetches = assetFetches;
        r.cachesAfter = await emaCaches();
        // The loader answers before its cache write lands: give it 5 s.
        r.stored = false;
        for (let i = 0; i < 50 && !r.stored; i++) {
            r.stored = await cacheHit(ASSET);
            if (!r.stored) await sleep(100);
        }
        if (!/Candesartan/.test(r.first.chip)) throw new Error(`euRegister: chip ${r.first.chip}`);
        // Phases on their own copy, after the app's check (Android measures them first, on a page it then reloads).
        r.phasesAt = epoch();
        const p0 = window.performance.now();
        const text = await (await window.fetch(ASSET, { cache: 'no-store' })).text();
        const p1 = window.performance.now();
        const data = JSON.parse(text);
        const p2 = window.performance.now();
        const { createEMACatalogue } = await import('/domain/ema-catalogue.js');
        const p3 = window.performance.now();
        const candecor = createEMACatalogue(data).exact('Candecor').candidates.length;
        const p4 = window.performance.now();
        r.phases = { fetchDecodeMs: Math.round(p1 - p0), parseMs: Math.round(p2 - p1), indexMs: Math.round(p4 - p3), chars: text.length, rows: data.rows.length, candecor };
        // Not stored: why? The loader swallows its put error, so repeat its
        // put (same key, same body) and a tiny one, and report each outcome.
        if (!r.stored) {
            const put = async (key, body) => {
                try {
                    const cache = await window.caches.open('medtracker-ema-rev90-v1');
                    await cache.put(key, new window.Response(body, { headers: { 'Content-Type': 'application/json' } }));
                    return (await cache.match(key)) ? 'ok' : 'no entry after put';
                } catch (e) { return `${(e && e.name) || 'Error'}: ${(e && e.message) || e}`; }
            };
            r.putProbe = { small: await put('/qa/ema-put-probe', '{}'), asset: await put(ASSET, text) };
            try { await (await window.caches.open('medtracker-ema-rev90-v1')).delete('/qa/ema-put-probe'); } catch (_) { /* probe only */ }
            try { r.storageEstimate = await window.navigator.storage.estimate(); } catch (_) { /* no estimate */ }
        }
        r.phasesEnd = epoch();
        return r;
    }

    // An entry for the asset in the loader's cache (not just its name: the
    // loader opens the cache before the write).
    async function cacheHit(url) {
        try {
            const cache = await window.caches.open('medtracker-ema-rev90-v1');
            return !!(await cache.match(url));
        } catch (_) { return false; }
    }

    // Where the scene's last ready element shows, in points of the web view
    // (visual viewport): XCUITest shoots only once that region of the screen
    // holds painted content, not the blank boot frame (bd med-y5xx.11).
    function paintRect(def) {
        const sel = (def.ready || [])[(def.ready || []).length - 1];
        const el = sel && firstVisible(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const vv = window.visualViewport;
        const top = visibleTop(vv); // client rect space differs per engine (med-m1x5)
        const width = vv ? vv.width : window.innerWidth;
        const height = vv ? vv.height : window.innerHeight;
        const x0 = Math.max(r.left, 0);
        let y0 = Math.max(r.top, top);
        const x1 = Math.min(r.right, width);
        let y1 = Math.min(r.bottom, top + height);
        // Fixed/sticky bars (tab bar, app bar, subnav, banners) paint over the
        // element; sample only what they leave uncovered (bd med-2sh9).
        for (const bar of document.querySelectorAll('.wg-tabbar, .wg-appbar, .wg-subnav, .wg-banners')) {
            if (!/fixed|sticky/.test(getComputedStyle(bar).position)) continue;
            const b = bar.getBoundingClientRect();
            if (b.right <= x0 || b.left >= x1 || b.bottom <= y0 || b.top >= y1) continue;
            // Only a bar that actually paints on top there: a sheet above the
            // tab bar leaves its content visible.
            const hit = document.elementFromPoint((Math.max(x0, b.left) + Math.min(x1, b.right)) / 2, (Math.max(y0, b.top) + Math.min(y1, b.bottom)) / 2);
            if (!hit || !bar.contains(hit)) continue;
            if (b.top + b.bottom < y0 + y1) y0 = Math.max(y0, b.bottom);
            else y1 = Math.min(y1, b.top);
        }
        if (x1 - x0 < 4 || y1 - y0 < 4) return null;
        const s = (vv && vv.scale) || 1;
        const round = (n) => Math.round(n * s);
        return { x: round(x0), y: round(y0 - top), w: round(x1 - x0), h: round(y1 - y0) };
    }

    // A flow scene's page state (bd med-sz4k.6.1, `flow` in scenes.json): what
    // FlowQA asserts on, read from the DOM the user sees, plus `targets`: the
    // on-screen rect (web view points, as paintRect) of each named element,
    // for a native tap. A target is a selector, or {sel, text, inner}: the
    // first visible `sel` whose text contains `text`, then its `inner` match.
    function flowState(def) {
        const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
        const all = (sel) => Array.from(document.querySelectorAll(sel)).filter(visible);
        const find = (t) => {
            if (typeof t === 'string') return firstVisible(t);
            const host = all(t.sel).find((el) => !t.text || text(el).includes(t.text));
            return host && t.inner ? Array.from(host.querySelectorAll(t.inner)).find(visible) || null : host || null;
        };
        const targets = {};
        for (const [name, t] of Object.entries(def.targets || {})) {
            const el = find(t);
            // A field's value too: what native typing put there.
            if (el) targets[name] = { ...screenRect(el), value: /^(INPUT|TEXTAREA)$/.test(el.tagName) ? el.value : undefined };
        }
        const kcal = firstVisible('#food-macros-card-kcal');
        return {
            tab: window.AppStore && window.AppStore.get('currentTab'),
            today: localDate(new Date()),
            clock: new Date().toTimeString().slice(0, 5),
            modals: all('mt-modal').map((m) => m.id),
            nextUp: all('[data-section="next-up"] .wg-row').map(text),
            focus: all('#med-timeline-list .wg-tl-focus .wg-timeline__row').map((r) => ({ occIds: r.dataset.occIds, medIds: r.dataset.medIds, state: r.dataset.state, text: text(r) })),
            timeline: all('#med-timeline-list .wg-timeline__row').map((r) => ({ medIds: r.dataset.medIds, state: r.dataset.state, date: r.dataset.localDate, text: text(r) })),
            foodKcal: kcal ? text(kcal) : null,
            food: all('#food-list .wg-food-item-row .wg-row__title').map(text),
            fuel: all('#today-content [data-section="fuel"] .wg-stat__value').map(text),
            bp: all('#bp-list .wg-bp-reading-row').map((r) => ({ id: r.dataset.readingId, text: text(r) })),
            weight: all('#weight-list .wg-weight-history-row').map((r) => ({ id: r.dataset.weightId, text: text(r) })),
            memo: qa.memo,
            targets,
        };
    }

    // An element's rect in points of the web view's visible area (as paintRect).
    function screenRect(el) {
        const r = el.getBoundingClientRect();
        const vv = window.visualViewport;
        const top = visibleTop(vv);
        const s = (vv && vv.scale) || 1;
        return { x: Math.round(r.left * s), y: Math.round((r.top - top) * s), w: Math.round(r.width * s), h: Math.round(r.height * s) };
    }

    function lostReady(def) {
        return (def.ready || []).filter((sel) => !firstVisible(sel));
    }

    function publish(r) {
        let node = document.getElementById('wg-qa-ready');
        if (!node) {
            node = document.createElement('div');
            node.id = 'wg-qa-ready';
            node.setAttribute('role', 'status');
            node.className = 'wg-qa-hidden';
        }
        // WebKit drops everything outside an aria-modal that holds focus
        // (mt-modal pages, sheets) from the accessibility tree, so XCUITest
        // would lose the node: keep it inside that modal.
        const focused = document.activeElement;
        const host = (focused && focused.closest && focused.closest('[aria-modal="true"]')) || document.body;
        if (node.parentNode !== host) host.appendChild(node);
        node.setAttribute('aria-label', JSON.stringify(r));
        qa.report = r;
    }

    function watch(def) {
        let timer;
        const again = () => {
            if (window.__wgQA !== qa) return; // a later run (tests re-eval the driver) owns the node
            clearTimeout(timer);
            timer = setTimeout(() => publish(report(def)), 150);
        };
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', again);
            window.visualViewport.addEventListener('scroll', again);
        }
        ['focusin', 'focusout', 'input'].forEach((t) => document.addEventListener(t, again, true));
        // A flow scene's state is DOM text: re-read it on any change (bd med-sz4k.6.1).
        // Not the driver's own nodes (probe's marker, the report node): those would loop.
        if (def.flow && window.MutationObserver) {
            const own = (n) => n.nodeType === 1 && (n.id === 'wg-qa-ready' || n.hasAttribute('data-wg-qa'));
            new window.MutationObserver((records) => {
                if (records.some((r) => ![...r.addedNodes, ...r.removedNodes].every(own) || (r.type === 'characterData' && !own(r.target.parentNode || r.target))))
                    again();
            }).observe(document.body, { subtree: true, childList: true, characterData: true });
        }
        // Tab / sub-tab switches flip classes and [hidden]: re-check readiness.
        if (window.MutationObserver) {
            new window.MutationObserver(again).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
            // Re-check asserted values when a view re-renders after the initial report.
            // Observe its content container, not body: probe() adds a temporary body marker.
            const anchor = def.rendered && firstVisible((def.ready || []).at(-1));
            if (anchor && anchor.parentElement) {
                new window.MutationObserver(again).observe(anchor.parentElement, { subtree: true, childList: true, characterData: true });
            }
        }
    }

    async function getJSON(url) {
        // A copy every time: the seeds push into the fixture, and the injected
        // files (and the jsdom suite's parsed fixture) outlive one seed.
        const files = window.__wgQAFiles; // injected (cloud pass): the cloud serves no /qa/*
        if (files && files[url]) return JSON.parse(JSON.stringify(files[url]));
        const res = await window.fetch(url);
        if (!res.ok) throw new Error(`${url}: ${res.status}`);
        return JSON.parse(JSON.stringify(await res.json()));
    }

    function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

    async function until(fn, ms, what) {
        const end = Date.now() + ms;
        for (;;) {
            if (fn()) return;
            if (Date.now() > end) throw new Error(`timeout: ${what}`);
            await sleep(50);
        }
    }
}());
