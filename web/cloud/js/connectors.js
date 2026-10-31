// Claude/MCP connector page, split out of the device list (med-lyv). Devices and
// connectors answer different questions — "which passkeys can open this vault"
// vs "which AI client may read it" — and sharing one screen made the second
// look like a property of the first.
//
// Mounted by the app's Settings → Devices & connectors → Claude connector page
// (med-xso6.25, kit S5; features/settings.js openConnectorPage). It renders kit
// markup into the mount it is given and owns no page chrome. The old shell page
// /connectors now redirects there (web/cloud/js/app.js); the route is
// /connectors, not /mcp, because the relay's capability endpoint owns the
// "/mcp/<token>" prefix (router.go).
//
// med-73xx (kit screens-connect-ai.html CC1–CC4): one way in, "Connect an AI
// app", onto the Tier 2 remote connector. The connector URL is the same
// capability for every client; only the per-app instructions differ. The Tier 1
// local-shim offer is hidden until a packaged shim exists (med-ztzg); an
// account already paired that way keeps its status and Disconnect.
//
// Telegram is deliberately NOT mounted here. It is neither a device nor an
// MCP connector, and Settings → Integrations already mounts it.
import { getPairing, disconnectClaude } from './mcp-pairing.js';
import { getRemoteStatus, connectRemote, disconnectRemote } from './mcp-remote.js';

const renderBlocked = (mount, staging = false) => (!staging && !mount.isConnected) || !mount.ownerDocument?.documentElement
  || mount.ownerDocument.documentElement.hasAttribute('data-provider-reload-committed');

export function renderConnectors(mount, ctx) {
  // Settings stages this mount immediately before its synchronous WGPage push.
  if (renderBlocked(mount, true)) return;
  mount.innerHTML = '<p class="wg-hint">Loading&hellip;</p>';
  loadConnectors(mount, ctx).catch((err) => {
    renderConnectorsError(mount, ctx, err.message || String(err));
  });
}

// The mode for the Devices & connectors row summary. Throws like the page
// load does: a failed status read is not "not connected".
export async function claudeConnectorMode(ctx) {
  const pairing = await getPairing(ctx);
  const remote = await getRemoteStatus();
  return claudeMode(pairing, remote.enabled);
}

async function loadConnectors(mount, ctx) {
  const pairing = await getPairing(ctx);
  if (renderBlocked(mount)) return;
  const remote = await getRemoteStatus();
  if (renderBlocked(mount)) return;
  renderPicker(mount, ctx, pairing, remote);
}

// Mutually exclusive per Task 1's PoC ceiling (single relay pairing per
// account): 'remote' wins the vault's shared `mcppairing` record if the
// server also reports Tier 2 enabled, else 'local' if a pairing exists at
// all, else 'none'.
function claudeMode(pairing, remoteEnabled) {
  if (remoteEnabled) return 'remote';
  if (pairing) return 'local';
  return 'none';
}

const CLAUDE_STATUS_TEXT = {
  remote: 'Connected',
  local: 'Linked with the local shim',
  none: 'Not connected',
};

const CLAUDE_STATUS_META = {
  remote: 'Use your records in Claude Code, the Claude app or ChatGPT.',
  local: 'No longer offered. It keeps working until you disconnect.',
  none: 'Use your records in Claude Code, the Claude app or ChatGPT.',
};

const REMOTE_CONSENT_TEXT =
  'Our server will pass messages between your AI app and this app while it is open and unlocked. It can read them ' +
  'on the way and stores none of them. It keeps the connector key so the link keeps working until you Disconnect.';

// The local label in the user's Claude Code config — neutral, never the
// instance's product name (med-73xx). --scope user: available in every
// project, not just the folder Claude Code was started in.
function claudeCodeCommand(url) {
  return `claude mcp add --transport http --scope user health ${url}`;
}

// Claude Code cannot restart itself and picks a new server up on restart, so
// the prompt ends by asking it to say so.
function claudeCodePrompt(url) {
  return `Add my health records to Claude Code: run ${claudeCodeCommand(url)} then tell me to restart Claude Code.`;
}

const APPS = [
  ['code', 'Claude Code'],
  ['claude', 'Claude app'],
  ['chatgpt', 'ChatGPT'],
];

const APP_STEPS = {
  claude: [
    'Open Claude (claude.ai or the desktop app).',
    'Settings &rarr; Connectors &rarr; Add custom connector.',
    'Paste the URL, then ask &ldquo;show my blood pressure this week&rdquo;.',
  ],
  chatgpt: [
    'Open ChatGPT.',
    'Settings &rarr; Connectors &rarr; Add MCP.',
    'Paste the URL, then ask &ldquo;show my blood pressure this week&rdquo;.',
  ],
};

const KEEP_OPEN_HINT = '<p class="wg-hint">Keep this app open and unlocked on one device while Claude works.</p>';

const CAPABILITIES = `
    <section class="wg-section">
      <div class="wg-section__head"><span class="wg-eyebrow">A connected app can</span></div>
      <div class="wg-list">
        <div class="wg-row wg-row--pad"><span class="wg-row__body"><span class="wg-row__title">Read</span><span class="wg-row__meta">meds, BP, weight, vitals, food, workouts, journey</span></span></div>
        <div class="wg-row wg-row--pad"><span class="wg-row__body"><span class="wg-row__title">Write</span><span class="wg-row__meta">add, edit and delete those entries</span></span></div>
      </div>
    </section>`;

// A secret in the kit code field (S5): one line, ellipsized, with a Copy icon
// button. Values go in via textContent by the caller — never innerHTML.
function codeField(label, valueId, copyId, copyLabel) {
  return `
    <div class="wg-field">
      <span class="wg-label">${label}</span>
      <div class="wg-code"><span id="${valueId}"></span><button type="button" id="${copyId}" class="wg-btn wg-btn--ghost wg-btn--icon wg-btn--sm" aria-label="${copyLabel}"><i class="wg-ico" data-icon="copy"></i></button></div>
    </div>`;
}

function bindCopy(button, text) {
  button.addEventListener('click', () => {
    navigator.clipboard.writeText(text)
      .then(() => window.safeToast && window.safeToast('Copied', 'success'))
      .catch(() => window.safeToast && window.safeToast('Could not copy — select the text instead.', 'error'));
  });
}

function hydrateIcons(root) {
  if (window.WGIcons && typeof window.WGIcons.hydrate === 'function') window.WGIcons.hydrate(root);
}

// The per-app instructions for one connector URL (CC3/CC4): a plain segment
// (a view switch, not a mode), opening on Claude Code; the choice isn't
// remembered. `primary` makes Copy prompt the view's one primary — on CC3,
// right after connecting; CC4 (coming back later) has none.
function renderAppSwitch(root, url, primary) {
  root.innerHTML = `
    <div class="wg-seg" role="group" aria-label="AI app">${APPS.map(([id, label]) =>
      `<button type="button" class="wg-seg__opt" data-app="${id}" aria-pressed="false">${label}</button>`).join('')}</div>
    <div id="claude-app-panel" class="wg-vstack"></div>`;
  const panel = root.querySelector('#claude-app-panel');
  const show = (app) => {
    root.querySelectorAll('.wg-seg__opt').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.app === app)));
    renderAppPanel(panel, url, app, primary);
  };
  root.querySelectorAll('.wg-seg__opt').forEach((b) => b.addEventListener('click', () => show(b.dataset.app)));
  show('code');
}

function renderAppPanel(panel, url, app, primary) {
  if (app === 'code') {
    const prompt = claudeCodePrompt(url);
    const command = claudeCodeCommand(url);
    panel.innerHTML = `
      <div class="wg-field">
        <span class="wg-label">Paste this into Claude Code</span>
        <div class="wg-code wg-code--wrap"><span id="claude-code-prompt"></span></div>
      </div>
      <button type="button" id="claude-code-copy-prompt" class="wg-btn${primary ? ' wg-btn--primary' : ''} wg-btn--block"><i class="wg-ico" data-icon="copy"></i>Copy prompt</button>
      <p class="wg-hint">Claude Code asks once before it runs the command. Restart it, then ask &ldquo;show my blood pressure this week&rdquo;.</p>
      ${codeField('Or run this in a terminal', 'claude-code-command', 'claude-code-copy-command', 'Copy command')}`;
    // Built from the server-generated capability URL — textContent only.
    panel.querySelector('#claude-code-prompt').textContent = prompt;
    panel.querySelector('#claude-code-command').textContent = command;
    bindCopy(panel.querySelector('#claude-code-copy-prompt'), prompt);
    bindCopy(panel.querySelector('#claude-code-copy-command'), command);
  } else {
    panel.innerHTML = `
      ${codeField('Connector URL', 'claude-remote-url', 'claude-remote-copy', 'Copy URL')}
      <ol class="wg-hint">${APP_STEPS[app].map((s) => `<li>${s}</li>`).join('')}</ol>`;
    panel.querySelector('#claude-remote-url').textContent = url;
    bindCopy(panel.querySelector('#claude-remote-copy'), url);
  }
  hydrateIcons(panel);
}

// Per-mode controls are left out of the markup, never `hidden`: kit
// .wg-btn / .wg-vstack set display and would override the [hidden] UA rule in
// the body-level page this mounts into.
const CONNECT_BLOCK = {
  // CC1: the connector is the one primary.
  none: `
    <p class="wg-hint">Your AI app reaches this app through our server. The server sees the requests and answers on the way and stores none of them.</p>
    <button type="button" id="claude-remote-connect-button" class="wg-btn wg-btn--primary wg-btn--block">Connect an AI app</button>
    <p class="wg-hint">One AI app per account. Connecting a new one replaces the old link.</p>`,
  // CC4 · Local shim: the switch, secondary (minting a pairing replaces the
  // account's old one server-side, mcp_relay.go).
  local: `
    <button type="button" id="claude-remote-connect-button" class="wg-btn wg-btn--block">Connect an AI app instead</button>
    <p class="wg-hint">This disconnects the local shim first.</p>`,
  // Remote on: no offer — it would be a no-op affordance.
  remote: '',
};

function renderPicker(mount, ctx, pairing, remote) {
  if (renderBlocked(mount)) return;
  const mode = claudeMode(pairing, remote.enabled);
  const showApps = mode === 'remote' && remote.url;
  mount.innerHTML = `
    <div class="wg-card wg-hstack">
      <span class="wg-row__lead${mode === 'none' ? '' : ' wg-row__lead--ok'}"><i class="wg-ico" data-icon="plug"></i></span>
      <span class="wg-vstack wg-spacer">
        <span class="wg-row__title" id="claude-status"></span>
        <span class="wg-meta" id="claude-status-meta"></span>
      </span>
    </div>
    ${showApps ? '<div id="claude-apps" class="wg-vstack"></div>' : ''}
    ${CAPABILITIES}
    ${CONNECT_BLOCK[mode]}
    ${mode === 'none' ? '' : '<button type="button" id="claude-disconnect-button" class="wg-btn wg-btn--danger-ghost wg-btn--block">Disconnect</button>'}`;

  mount.querySelector('#claude-status').textContent = CLAUDE_STATUS_TEXT[mode];
  mount.querySelector('#claude-status-meta').textContent = CLAUDE_STATUS_META[mode];

  // CC4: remote is on — show the per-app instructions again (the token lives
  // server-side, med-24d), with no primary: nothing is waiting.
  if (showApps) {
    const apps = mount.querySelector('#claude-apps');
    renderAppSwitch(apps, remote.url, false);
    apps.insertAdjacentHTML('beforeend', KEEP_OPEN_HINT);
  }

  mount.querySelector('#claude-remote-connect-button')?.addEventListener('click', async () => {
    if (!(await window.safeConfirm(REMOTE_CONSENT_TEXT, null, { title: 'Connect an AI app?', confirmLabel: 'Connect', icon: 'plug' }))) return;
    connectRemote(ctx)
      .then(({ url }) => renderConnected(mount, ctx, url))
      .catch((err) => renderConnectorsError(mount, ctx, err.message || String(err)));
  });

  // Kit S5: outlined destructive → dialog → filled clay confirm.
  mount.querySelector('#claude-disconnect-button')?.addEventListener('click', async () => {
    const confirmed = await window.safeConfirm(
      'Claude loses access right away. Your data stays in the vault. You can reconnect later with a new ' +
        (mode === 'remote' ? 'URL.' : 'pairing code.'),
      null,
      { title: 'Disconnect Claude?', confirmLabel: 'Disconnect', destructive: true, icon: 'plug' },
    );
    if (!confirmed) return;
    (mode === 'remote' ? disconnectRemote(ctx) : disconnectClaude(ctx))
      .then(() => renderConnectors(mount, ctx))
      .catch((err) => renderConnectorsError(mount, ctx, err.message || String(err)));
  });
  hydrateIcons(mount);
}

// CC3, right after connecting. The connector URL carries the human token in
// the clear (it's a capability URL, that's the point), so the screen says the
// link is a key. Copy prompt is the one primary; Done is secondary.
function renderConnected(mount, ctx, url) {
  if (renderBlocked(mount)) return;
  mount.innerHTML = `
    <div class="wg-note wg-note--ok"><i class="wg-ico" data-icon="check"></i><div class="wg-note__body">Connector on. Pick the app you use.</div></div>
    <div id="claude-apps" class="wg-vstack"></div>
    <div class="wg-note wg-note--warn"><i class="wg-ico" data-icon="key"></i><div class="wg-note__body" id="claude-key-warning">This link opens your records to whoever has it, while your app is open and unlocked. Disconnect turns it off.</div></div>
    ${KEEP_OPEN_HINT}
    <button type="button" id="claude-remote-done" class="wg-btn wg-btn--block">Done</button>`;

  renderAppSwitch(mount.querySelector('#claude-apps'), url, true);
  mount.querySelector('#claude-remote-done').addEventListener('click', () => renderConnectors(mount, ctx));
  hydrateIcons(mount);
}

function renderConnectorsError(mount, ctx, errorText) {
  if (renderBlocked(mount)) return;
  mount.innerHTML = `
    <section class="wg-section">
      <p class="wg-error"></p>
      <button type="button" id="connectors-retry" class="wg-btn wg-btn--block">Try again</button>
    </section>`;
  mount.querySelector('.wg-error').textContent = errorText;
  mount.querySelector('#connectors-retry').addEventListener('click', () => renderConnectors(mount, ctx));
}
