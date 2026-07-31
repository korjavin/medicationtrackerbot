// features/firstrun/screens/done.js — Task 4 of the mobile Phase 2c
// plan. Final screen in the first-run overlay: a confirmation that
// setup is complete, plus a single "Open app" button. Pressing it
// calls POST /api/firstrun/complete (via helpers.complete()) and
// dismisses the overlay. The orchestrator's complete() flips the
// in-memory bootstrap flag to false so a re-mount on the same
// payload is a no-op; the next server-side bootstrap will see
// settings.first_run_complete = 1 and return needs_first_run: false
// for every subsequent launch.
//
// The screen also names the two capabilities nothing else in onboarding
// mentions — driving the app from an LLM over MCP, and talking to the voice
// agent (med-1mn). They are a mention on the last screen, not two more
// mandatory steps: the feature picker is deliberately lean ("otherwise it is
// too bloated on start for friends"). Both blurbs state their real limits
// rather than selling; see CAPABILITIES below.
(function () {
    'use strict';

    // Cloud-only. Bot mode reaches MCP through a separately deployed server
    // (docs/archive/mcp-deployment.md), not the in-app Connectors page, and never
    // injects the trial meta tags — so neither blurb has a destination there.
    function _cloud() {
        return !!window.__MEDTRACKER_CLOUD__;
    }

    // Same tag Settings → Integrations (applyTrialHints) and the wizard's
    // integrations screen read, so no two surfaces can disagree about whether
    // a capability exists on this deployment. Availability is advertised as a
    // boolean only — the key never reaches the client (docs/cloud-mode.md,
    // "Trial provider keys"). The wizard collects no ElevenLabs key of its
    // own, so at this point the operator's trial key is the only way voice can
    // work: no tag, no blurb.
    function _trial(name) {
        return document.querySelector('meta[name="' + name + '"]')?.content === '1';
    }

    // Accuracy over enthusiasm — onboarding copy that over-promises is what
    // med-eas.30 exists to prevent. Cloud MCP is a two-tool surface
    // (mcp_help + mcp_call); mcp_execute cannot exist there because
    // server-side scripting would break zero-knowledge. Every call is answered
    // by this browser tab, so it must be open and unlocked. Voice on the
    // operator's trial key is metered, and the conversation reaches the
    // provider under the operator's account.
    const CAPABILITIES = [
        {
            id: 'mcp',
            label: 'Connect Claude or ChatGPT',
            copy: 'Let an LLM read and update your data over MCP. It gets two tools — one to '
                + 'discover what it can do, one to do it. Answers come from this browser tab, so '
                + 'it has to be open and unlocked; nothing runs on the server.',
            linkText: 'Set it up in Connectors',
            href: '/connectors',
            available: _cloud,
        },
        {
            id: 'voice',
            label: 'Talk to a voice agent',
            copy: 'Have a spoken conversation with the app instead of typing. On the shared trial '
                + 'key it is rate-limited, and what you say reaches the voice provider under the '
                + 'operator’s account. Add your own key in Settings to keep it off theirs.',
            linkText: null,
            href: null,
            available: function () { return _cloud() && _trial('medtracker-trial-voice'); },
        },
    ];

    function renderCapability(cap) {
        const item = document.createElement('div');
        item.className = 'wg-firstrun-capability';
        item.setAttribute('data-firstrun-capability', cap.id);

        const label = document.createElement('div');
        label.className = 'wg-firstrun-capability__label';
        label.textContent = cap.label;
        item.appendChild(label);

        const copy = document.createElement('p');
        copy.className = 'wg-firstrun-capability__copy';
        copy.textContent = cap.copy;
        item.appendChild(copy);

        if (cap.href) {
            const link = document.createElement('a');
            link.className = 'wg-firstrun-capability__link';
            link.href = cap.href;
            link.textContent = cap.linkText;
            item.appendChild(link);
        }
        return item;
    }

    function renderCapabilities(body) {
        const available = CAPABILITIES.filter(function (cap) { return cap.available(); });
        if (!available.length) return;

        const intro = document.createElement('p');
        intro.className = 'wg-firstrun-screen__tagline';
        // Voice drops out on a deployment with no ElevenLabs key, so the
        // count is not a constant.
        intro.textContent = available.length > 1
            ? 'Two things worth knowing about:'
            : 'One thing worth knowing about:';
        body.appendChild(intro);

        const list = document.createElement('div');
        list.className = 'wg-firstrun-capabilities';
        available.forEach(function (cap) { list.appendChild(renderCapability(cap)); });
        body.appendChild(list);
    }

    function render(body, helpers) {
        const message = document.createElement('p');
        message.className = 'wg-firstrun-screen__tagline';
        message.textContent = 'You\'re all set. You can adjust permissions and integrations any time from Settings.';
        body.appendChild(message);

        renderCapabilities(body);

        const actions = document.createElement('div');
        actions.className = 'wg-firstrun-actions';

        const primary = document.createElement('button');
        primary.type = 'button';
        primary.className = 'wg-firstrun-btn wg-firstrun-btn--primary';
        primary.textContent = 'Open app';
        primary.setAttribute('data-firstrun-action', 'open-app');
        primary.addEventListener('click', function () {
            if (primary.disabled) return;
            primary.disabled = true;
            helpers.complete();
        });

        actions.appendChild(primary);
        body.appendChild(actions);
    }

    window.WGFirstRun = window.WGFirstRun || {};
    window.WGFirstRun.screens = window.WGFirstRun.screens || {};
    window.WGFirstRun.screens.done = {
        title: 'You\'re all set',
        render: render,
    };
})();
