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
    const qa = { scene, done: null, probe };
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
        if (Real.wgQAPinned) return; // the jsdom suite re-evaluates the driver
        const d = new Real();
        const pin = new Real(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0).getTime();
        const t0 = window.performance.now();
        const now = () => pin + Math.floor(window.performance.now() - t0);
        function QADate(...args) {
            if (!new.target) return new Real(now()).toString();
            return Reflect.construct(Real, args.length ? args : [now()], new.target);
        }
        QADate.prototype = Real.prototype;
        QADate.now = now;
        QADate.parse = Real.parse;
        QADate.UTC = Real.UTC;
        QADate.wgQAPinned = true;
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
        publish(report(def));
        watch(def);
    }

    // Seeds once, through Settings → Backup & import's own path. The store is
    // empty here, so the import's replace confirm never shows (importexport.js
    // skips it when hasUserContent() === false).
    async function seed() {
        const vault = shiftDates(withPileUp(await getJSON('/qa/vault-v1.json')), new Date());
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
        } else {
            throw new Error(`unknown step ${JSON.stringify(step)}`);
        }
        await sleep(50);
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
        return { scene: def.name, ok: failed.length === 0, rev: rev++, loads, failed, probes, paint: paintRect(def), reminderSlot: qa.reminderSlot };
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
        const y0 = Math.max(r.top, top);
        const x1 = Math.min(r.right, width);
        const y1 = Math.min(r.bottom, top + height);
        if (x1 - x0 < 4 || y1 - y0 < 4) return null;
        const s = (vv && vv.scale) || 1;
        const round = (n) => Math.round(n * s);
        return { x: round(x0), y: round(y0 - top), w: round(x1 - x0), h: round(y1 - y0) };
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
        const files = window.__wgQAFiles; // injected (cloud pass): the cloud serves no /qa/*
        if (files && files[url]) return files[url];
        const res = await window.fetch(url);
        if (!res.ok) throw new Error(`${url}: ${res.status}`);
        return res.json();
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
