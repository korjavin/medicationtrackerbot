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

    const scene = new URLSearchParams(window.location.search).get('qa');
    const qa = { scene, done: null, probe };
    window.__wgQA = qa;
    if (!scene) return;
    // A load the shell made for a captured link (?invite=1, add-device-from-link)
    // keeps the real clock: the page judges the slot's receivedAt (shell time)
    // against Date.now(), and a join's 10 minutes would never hold at 23:00.
    if (!new URLSearchParams(window.location.search).has('invite')) pinClock();
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
    function pinClock() {
        const Real = window.Date;
        if (Real.wgQAPinned) return; // the jsdom suite re-evaluates the driver
        const d = new Real();
        const pin = new Real(d.getFullYear(), d.getMonth(), d.getDate(), 23, 0, 0).getTime();
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
        const vault = shiftDates(await getJSON('/qa/vault-v1.json'), new Date());
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
            await until(() => firstVisible(step.click), STEP_MS, `click ${step.click}`);
            firstVisible(step.click).click();
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
        } else if (step.inviteRequest) {
            // The W5 "Request an invite" sheet (bd med-ta2n.14). Its button
            // needs the shell's base.post op, which no QA pass has: open it
            // directly with a placeholder base and a stub POST, so nothing
            // leaves the page.
            // inviteRequest: "sent" fills an email and sends (stub 202).
            const ui = window.InviteSheet.request({
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
        const probes = {
            scale: vv ? vv.scale : 1,
            hOverflow: document.documentElement.scrollWidth - window.innerWidth,
            // Above the visible top: a panned visual viewport (keyboard) hides a
            // header whose layout top is still >= 0.
            clippedTop: shown('.wg-sheet__header, .wg-sheethead, .wg-appbar, .wg-pagebar')
                .filter((el) => onTop(el) && rect(el).top < top - 0.5).map(tag),
            // Charts are <svg>; icons (small svg) are skipped.
            canvasOverflow: shown('canvas, svg').filter((el) => {
                const w = rect(el).width;
                return w > 64 && el.parentElement && w > rect(el.parentElement).width + 0.5;
            }).map(tag),
            focusUnderKeyboard: !!(focused && vv && rect(focused).bottom > top + vv.height + 0.5),
            bottomNavCovered: !!(tabbar && rect(tabbar).bottom > window.innerHeight + 0.5),
            // Against the layout viewport: in WKWebView innerHeight shrinks
            // with the keyboard too (seen on the Simulator, bd med-y5xx.3).
            keyboardShown: !!(vv && vv.height < document.documentElement.clientHeight - 100),
        };
        const failed = [];
        if (probes.scale !== 1) failed.push('scale');
        if (probes.hOverflow > 0) failed.push('hOverflow');
        if (probes.clippedTop.length) failed.push('clippedTop');
        if (probes.canvasOverflow.length) failed.push('canvasOverflow');
        if (probes.focusUnderKeyboard) failed.push('focusUnderKeyboard');
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
        return { scene: def.name, ok: failed.length === 0, rev: rev++, loads, failed, probes, paint: paintRect(def) };
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
