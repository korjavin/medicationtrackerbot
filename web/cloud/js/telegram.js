// Telegram onboarding module (C3a Task 5): consent screen + managed-bot
// deep-link flow + BYO fallback + test-notification button. Reused by the
// signup wizard (step 5) and — later — the settings screen; both mount the
// same renderer, which drives itself off GET /api/telegram/status.
//
// The wizard's derived-state rule (docs plan): render only when the server
// reports Telegram enabled AND state === 'none'. mountTelegram enforces that by
// calling opts.onDone() immediately when Telegram is disabled or already
// resolved (skipped) in the wizard context, so the wizard advances without a
// dead step.
//
// XSS note: this page holds the DEK (see signup.js). Server-supplied values
// (bot_username, deep_link) are written via textContent / .href, never
// interpolated into innerHTML.

const POLL_MS = 2500;

// BYO fallback shared by the consent and create-bot pages. Static string —
// no server-supplied values — so innerHTML interpolation is XSS-safe.
const BYO_DETAILS_HTML = `
        <details id="tg-advanced">
          <summary>Advanced: use your own bot token</summary>
          <p>Create a bot with <a href="https://t.me/BotFather" target="_blank"
             rel="noopener">@BotFather</a> and paste its token:</p>
          <input id="tg-byo-token" type="text" autocomplete="off"
                 placeholder="123456:ABC-DEF..." />
          <button id="tg-byo-submit">Link this bot</button>
        </details>`;

async function apiJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = new Error(`telegram api ${url}: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// getStatus returns the parsed status object, or { enabled: false } when the
// endpoint is absent (Telegram disabled → routes not registered → non-2xx).
export async function getStatus() {
  try {
    return await apiJSON('/api/telegram/status');
  } catch (e) {
    if (e.status && e.status !== 401) return { enabled: false, state: 'none' };
    throw e;
  }
}

// mountTelegram renders the Telegram setup UI into container, driven by the
// account's current status. opts.onDone (optional) is a "step complete"
// callback the wizard passes to advance past the step (used by Skip and the
// post-link Continue button); settings omits it and shows an idle done state.
export async function mountTelegram(container, opts = {}) {
  const onDone = opts.onDone;
  const inWizard = typeof onDone === 'function';
  let timer = null;

  const stopPolling = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  const poll = () => {
    stopPolling();
    timer = setInterval(async () => {
      // Self-terminate once the mount is torn down (settings Back / navigation
      // rewrites app.innerHTML, detaching container). Without this the interval
      // would fetch /api/telegram/status forever and accumulate a new timer on
      // every re-entry to the Devices screen.
      if (!container.isConnected) {
        stopPolling();
        return;
      }
      try {
        const s = await getStatus();
        render(s);
      } catch (e) {
        console.error('[telegram] status poll failed', e);
      }
    }, POLL_MS);
  };

  // Signature of what's currently painted. While polling, an unchanged
  // signature means "nothing to repaint" — critically, this stops the pending
  // poll from clobbering the create-bot page (with its deep-link button) every
  // 2.5s. We only repaint on a real state transition.
  let shown = null;

  function render(status) {
    if (!status.enabled) {
      stopPolling();
      if (inWizard) onDone();
      else container.replaceChildren();
      return;
    }
    const sig = `${status.state}:${status.bot_username || status.suggested_username || ''}`;
    if (sig === shown) return; // same state already on screen; keep polling
    shown = sig;
    switch (status.state) {
      case 'linked':
        renderLinked(status);
        break;
      case 'bot_created':
        renderOpenBot(status);
        break;
      case 'pending':
        renderCreateBot(status.deep_link, status.suggested_username);
        break;
      default: // 'none' | 'skipped'
        if (status.state === 'skipped' && inWizard) {
          stopPolling();
          onDone();
          return;
        }
        renderConsent();
    }
  }

  function showError(err) {
    const p = document.createElement('p');
    p.className = 'wizard-error';
    p.textContent = err.message || String(err);
    const section = container.querySelector('section');
    (section || container).appendChild(p);
  }

  // --- Consent + provisioning entry -------------------------------------

  function renderConsent() {
    stopPolling();
    container.innerHTML = `
      <section class="wizard-step">
        <h1>Get reminders on Telegram</h1>
        <p>Optional. You can link a personal Telegram bot so this server can
           ring your medication reminders in a chat.</p>
        <p><strong>What the server sees:</strong> to send messages, the server
           stores <em>one</em> credential — your bot's token — which it can read.
           With it, and only it, the server can send and receive messages as
           that bot. Your health data stays encrypted; this covers the message
           channel only.</p>
        <div class="wizard-actions">
          <button id="tg-accept">Set up my bot</button>
          <button id="tg-skip" class="secondary">Skip</button>
        </div>${BYO_DETAILS_HTML}
      </section>`;

    container.querySelector('#tg-accept').addEventListener('click', () => {
      provision().catch(showError);
    });
    if (inWizard) {
      container.querySelector('#tg-skip').addEventListener('click', () => {
        const btn = container.querySelector('#tg-skip');
        btn.disabled = true;
        fetch('/api/telegram/skip', { method: 'POST' })
          .then((res) => {
            if (!res.ok) throw new Error('Could not save your choice.');
            onDone();
          })
          .catch((err) => {
            btn.disabled = false;
            showError(err);
          });
      });
    } else {
      container.querySelector('#tg-skip').remove();
    }
    wireBYO();
  }

  function wireBYO() {
    container.querySelector('#tg-byo-submit').addEventListener('click', () => {
      submitBYO().catch(showError);
    });
  }

  async function provision() {
    const { deep_link, suggested_username } = await apiJSON('/api/telegram/provision', { method: 'POST' });
    // Route through render() (state 'pending') so the create-bot page is drawn
    // in exactly one place — the same page the poll keeps showing until the
    // child bot is created, so the deep-link button never disappears.
    render({ enabled: true, state: 'pending', deep_link, suggested_username });
  }

  // renderCreateBot draws the deep-link page for the whole 'pending' phase.
  // Shown both right after provision() and on any later status poll / reload
  // (status carries deep_link while pending), so the "Open Telegram" button
  // stays put until Telegram reports the bot created.
  function renderCreateBot(deepLink, suggested) {
    container.innerHTML = `
      <section class="wizard-step">
        <h1>Create your bot</h1>
        <p>Tap below to open Telegram. It pre-fills a new bot named
           <strong>Med Tracker</strong> — <em>keep the suggested bot username</em>
           (<code id="tg-suggested"></code>) so we can link it automatically.</p>
        <a id="tg-deep-link" class="button" target="_blank" rel="noopener">Open Telegram to create the bot</a>
        <p class="muted">Waiting for the bot to be created…</p>
        <p class="muted">Didn't finish linking automatically? Paste the bot's
           token below, or start over — no need to wait.</p>${BYO_DETAILS_HTML}
        <button id="tg-reset" class="secondary">Start over</button>
      </section>`;
    container.querySelector('#tg-suggested').textContent = suggested || '';
    if (deepLink) container.querySelector('#tg-deep-link').href = deepLink;
    wireBYO();
    container.querySelector('#tg-reset').addEventListener('click', () => {
      const btn = container.querySelector('#tg-reset');
      btn.disabled = true;
      resetPending().catch((err) => {
        btn.disabled = false;
        showError(err);
      });
    });
    poll();
  }

  // resetPending clears the stuck pending row server-side and returns the user
  // to the consent screen — the escape hatch when the managed_bot_created
  // webhook update was lost and the bind will never arrive. Polling is left
  // running until the POST succeeds so a failed reset keeps the page live;
  // renderConsent() stops it.
  async function resetPending() {
    await apiJSON('/api/telegram/reset', { method: 'POST' });
    // A later provision() re-enters 'pending' with the same sig as the page we
    // came from; null the dedupe so that render isn't swallowed.
    shown = null;
    renderConsent();
  }

  async function submitBYO() {
    const input = container.querySelector('#tg-byo-token');
    const token = (input.value || '').trim();
    if (!token) return;
    const btn = container.querySelector('#tg-byo-submit');
    btn.disabled = true;
    try {
      const { bot_username } = await apiJSON('/api/telegram/byo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      renderOpenBot({ enabled: true, state: 'bot_created', bot_username });
    } catch (e) {
      btn.disabled = false;
      throw e.status === 400 ? new Error('That bot token was rejected by Telegram.') : e;
    }
  }

  // --- Post-provision states --------------------------------------------

  function renderOpenBot(status) {
    container.innerHTML = `
      <section class="wizard-step">
        <h1>Open your bot</h1>
        <p>Your bot is ready. Open it and tap <strong>Start</strong> to connect
           it to your account.</p>
        <a id="tg-bot-link" class="button" target="_blank" rel="noopener"></a>
        <p class="muted">Waiting for you to tap Start…</p>
      </section>`;
    const link = container.querySelector('#tg-bot-link');
    link.textContent = `Open @${status.bot_username}`;
    link.href = `https://t.me/${encodeURIComponent(status.bot_username)}`;
    poll();
  }

  function renderLinked(status) {
    stopPolling();
    container.innerHTML = `
      <section class="wizard-step">
        <h1>Telegram connected</h1>
        <p>Your bot <code id="tg-bot-username"></code> is linked. Send yourself
           a test notification to confirm it works.</p>
        <div class="wizard-actions">
          <button id="tg-test">Send test notification</button>
          <button id="tg-unlink" class="secondary">Unlink</button>
        </div>
        <p id="tg-test-result" class="muted"></p>
        ${inWizard ? '<button id="tg-continue">Continue</button>' : ''}
      </section>`;
    container.querySelector('#tg-bot-username').textContent = `@${status.bot_username}`;

    container.querySelector('#tg-test').addEventListener('click', () => {
      const btn = container.querySelector('#tg-test');
      const result = container.querySelector('#tg-test-result');
      btn.disabled = true;
      result.textContent = 'Sending…';
      fetch('/api/telegram/test', { method: 'POST' })
        .then((res) => {
          btn.disabled = false;
          result.textContent = res.ok
            ? 'Sent — check your Telegram chat.'
            : 'Could not send. Open your bot and tap Start, then retry.';
        })
        .catch(() => {
          btn.disabled = false;
          result.textContent = 'Could not send. Try again.';
        });
    });

    container.querySelector('#tg-unlink').addEventListener('click', () => {
      if (!confirm('Unlink your Telegram bot? A managed bot stays yours — delete it in BotFather if you no longer want it.')) return;
      fetch('/api/telegram', { method: 'DELETE' })
        .then((res) => {
          if (!res.ok) throw new Error('Could not unlink.');
          renderConsent();
        })
        .catch(showError);
    });

    if (inWizard) {
      container.querySelector('#tg-continue').addEventListener('click', () => onDone());
    }
  }

  // Kick off from the current server state.
  try {
    render(await getStatus());
  } catch (e) {
    showError(e);
  }
}
