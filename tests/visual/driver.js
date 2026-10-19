// iOS visual QA driver (bd med-y5xx.1, docs/design/ios-visual-testing.md).
//
// Bundled ONLY by `QA=1 ios/bundle-web.sh` (served at /qa/driver.js on
// wgapp://local, loaded after every app script); the TestFlight archive and the
// cloud never carry it. A classic script: on `?qa=<scene>` it seeds the golden
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
    qa.done = run(scene).catch((e) => publish({ scene, ok: false, error: String((e && e.message) || e) }));

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
        // Never import over a real vault: the QA bundle is local mode only.
        if (!document.documentElement.classList.contains('wg-local-vault')) throw new Error('not local mode');
        if (!(await window.CloudVault.hasUserContent())) {
            await seed();
            return; // the import reloads the page; the next load runs the scene
        }
        for (const step of def.steps || []) await runStep(step);
        for (const sel of def.ready || []) await until(() => firstVisible(sel), STEP_MS, `ready ${sel}`);
        await settle();
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
        } else if (step.click) {
            await until(() => firstVisible(step.click), STEP_MS, `click ${step.click}`);
            firstVisible(step.click).click();
        } else if (step.tag) {
            // A DOM id for a native `tap` (XCUITest finds web elements by id)
            // on an element the app renders without one.
            await until(() => firstVisible(step.tag), STEP_MS, `tag ${step.tag}`);
            firstVisible(step.tag).id = step.id;
        } else if (step.settingsPage) {
            await until(() => window.SettingsView.openSettingsPage(step.settingsPage), STEP_MS, `settings page ${step.settingsPage}`);
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
    function probe() {
        const vv = window.visualViewport;
        const shown = (sel) => Array.from(document.querySelectorAll(sel)).filter(visible);
        const rect = (el) => el.getBoundingClientRect();
        const tag = (el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (el.classList[0] ? `.${el.classList[0]}` : '');
        const focused = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
        const tabbar = shown('.wg-tabbar')[0];
        const probes = {
            scale: vv ? vv.scale : 1,
            hOverflow: document.documentElement.scrollWidth - window.innerWidth,
            // Above the visible top: a panned visual viewport (keyboard) hides a
            // header whose layout top is still >= 0.
            clippedTop: shown('.wg-sheet__header, .wg-sheethead, .wg-appbar, .wg-pagebar')
                .filter((el) => rect(el).top < (vv ? vv.offsetTop : 0) - 0.5).map(tag),
            // Charts are <svg>; icons (small svg) are skipped.
            canvasOverflow: shown('canvas, svg').filter((el) => {
                const w = rect(el).width;
                return w > 64 && el.parentElement && w > rect(el.parentElement).width + 0.5;
            }).map(tag),
            focusUnderKeyboard: !!(focused && vv && rect(focused).bottom > vv.height + vv.offsetTop + 0.5),
            bottomNavCovered: !!(tabbar && rect(tabbar).bottom > window.innerHeight + 0.5),
            keyboardShown: !!(vv && vv.height < window.innerHeight - 100),
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
        return { scene: def.name, ok: failed.length === 0, rev: rev++, failed, probes };
    }

    function publish(r) {
        let node = document.getElementById('wg-qa-ready');
        if (!node) {
            node = document.createElement('div');
            node.id = 'wg-qa-ready';
            node.setAttribute('role', 'status');
            node.className = 'wg-qa-hidden';
            document.body.appendChild(node);
        }
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
    }

    async function getJSON(url) {
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
