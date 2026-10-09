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
// Telegram is deliberately NOT mounted here. It is neither a device nor an
// MCP connector, and Settings → Integrations already mounts it.
import { getPairing, connectClaude, disconnectClaude } from './mcp-pairing.js';
import { getRemoteStatus, connectRemote, disconnectRemote } from './mcp-remote.js';

export function renderConnectors(mount, ctx) {
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
  const remote = await getRemoteStatus();
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
  remote: 'Claude connector: remote (claude.ai / ChatGPT) linked',
  local: 'Claude connector: local shim (Claude Code) linked',
  none: 'Claude connector: not connected',
};

const REMOTE_CONSENT_TEXT =
  'The server will relay MCP traffic between claude.ai/ChatGPT and your unlocked browser tab. It can read the requests ' +
  'and the answers while relaying — nothing is stored. The connector key is kept on the server so the URL keeps ' +
  'working across restarts, until you Disconnect.';

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

function renderPicker(mount, ctx, pairing, remote) {
  const mode = claudeMode(pairing, remote.enabled);
  mount.innerHTML = `
    <div class="wg-card wg-hstack">
      <span class="wg-row__lead${mode === 'none' ? '' : ' wg-row__lead--ok'}"><i class="wg-ico" data-icon="plug"></i></span>
      <span class="wg-vstack wg-spacer">
        <span class="wg-row__title" id="claude-status"></span>
        <span class="wg-meta">Only one connector can be active at a time — switching disconnects the other.</span>
      </span>
    </div>
    <div id="claude-remote-url-block" hidden>${codeField('Connector URL', 'claude-remote-url-current', 'claude-remote-copy-current', 'Copy URL')}</div>
    <section class="wg-section">
      <div class="wg-section__head"><span class="wg-eyebrow">A connected client can</span></div>
      <div class="wg-list">
        <div class="wg-row wg-row--pad"><span class="wg-row__body"><span class="wg-row__title">Read</span><span class="wg-row__meta">meds, BP, weight, vitals, food, workouts, journey</span></span></div>
        <div class="wg-row wg-row--pad"><span class="wg-row__body"><span class="wg-row__title">Write</span><span class="wg-row__meta">add, edit and delete those entries</span></span></div>
      </div>
    </section>
    <section class="wg-section">
      <div class="wg-section__head"><span class="wg-eyebrow">Remote connector (claude.ai, ChatGPT)</span></div>
      <p class="wg-hint">The server relays MCP traffic to your unlocked browser tab. This mode is <strong>not</strong> end-to-end
         encrypted: by enabling it you consent to the server seeing MCP requests and responses in transit — nothing
         is stored, and it never gains access to your vault. Prefer the local shim below if you want the traffic
         sealed from the operator too.</p>
      <button type="button" id="claude-remote-connect-button" class="wg-btn wg-btn--primary wg-btn--block">Enable remote connector</button>
    </section>
    <section class="wg-section">
      <div class="wg-section__head"><span class="wg-eyebrow">Local shim (Claude Code)</span></div>
      <p class="wg-hint">Fully end-to-end encrypted: runs a shim binary on your own machine, so the server never sees your data.</p>
      <button type="button" id="claude-local-connect-button" class="wg-btn wg-btn--block">Connect Claude Code</button>
    </section>
    <button type="button" id="claude-disconnect-button" class="wg-btn wg-btn--danger-ghost wg-btn--block">Disconnect</button>`;

  mount.querySelector('#claude-status').textContent = CLAUDE_STATUS_TEXT[mode];
  mount.querySelector('#claude-disconnect-button').hidden = mode === 'none';
  // Hide the connector that is already active — offering "Enable remote
  // connector" while remote is on is a no-op affordance. The *other* button
  // stays visible: it is the documented switch control (see the mode note
  // above, and the disconnect-then-connect logic below).
  mount.querySelector('#claude-remote-connect-button').hidden = mode === 'remote';
  mount.querySelector('#claude-local-connect-button').hidden = mode === 'local';

  // Capability URL — textContent only, never innerHTML.
  if (mode === 'remote' && remote.url) {
    mount.querySelector('#claude-remote-url-block').hidden = false;
    mount.querySelector('#claude-remote-url-current').textContent = remote.url;
    bindCopy(mount.querySelector('#claude-remote-copy-current'), remote.url);
  }

  mount.querySelector('#claude-remote-connect-button').addEventListener('click', async () => {
    if (!(await window.safeConfirm(REMOTE_CONSENT_TEXT, null, { title: 'Enable the remote connector?', confirmLabel: 'Enable', icon: 'plug' }))) return;
    connectRemote(ctx)
      .then(({ token, url }) => renderRemoteURL(mount, ctx, token, url))
      .catch((err) => renderConnectorsError(mount, ctx, err.message || String(err)));
  });

  mount.querySelector('#claude-local-connect-button').addEventListener('click', () => {
    // Switching from remote disconnects it first — the relay only tracks
    // one pairing per account, so the old one would otherwise be orphaned.
    (mode === 'remote' ? disconnectRemote(ctx) : Promise.resolve())
      .then(() => connectClaude(ctx))
      .then(({ code }) => renderClaudeCode(mount, ctx, code))
      .catch((err) => renderConnectorsError(mount, ctx, err.message || String(err)));
  });

  // Kit S5: outlined destructive → dialog → filled clay confirm.
  mount.querySelector('#claude-disconnect-button').addEventListener('click', async () => {
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

// The connector URL carries the human token in the clear (it's a capability
// URL, that's the point). Unlike the local shim's pairing code — whose E2E key
// the server never sees and so cannot re-show — the token lives server-side, so
// the connector page can render it again (med-24d).
function renderRemoteURL(mount, ctx, token, url) {
  mount.innerHTML = `
    <section class="wg-section">
      <p class="wg-row__title">Remote connector enabled</p>
      <p>Paste this URL into claude.ai or ChatGPT. You can look it up again on this page.</p>
      ${codeField('Connector URL', 'claude-remote-url', 'claude-remote-copy', 'Copy URL')}
      <ol class="wg-hint">
        <li>claude.ai: Settings &rarr; Connectors &rarr; Add custom connector &rarr; paste the URL.</li>
        <li>ChatGPT: Settings &rarr; Connectors &rarr; Add MCP &rarr; paste the URL.</li>
      </ol>
      <p class="wg-hint">Keep an unlocked tab open. The URL stays valid until you Disconnect — it survives
         server updates.</p>
      <button type="button" id="claude-remote-done" class="wg-btn wg-btn--primary wg-btn--block">Done</button>
    </section>`;

  // Server-generated capability URL — textContent only, never innerHTML.
  mount.querySelector('#claude-remote-url').textContent = url;
  bindCopy(mount.querySelector('#claude-remote-copy'), url);
  mount.querySelector('#claude-remote-done').addEventListener('click', () => renderConnectors(mount, ctx));
  hydrateIcons(mount);
}

// The pairing code carries the E2E key in the clear (that's the point — the
// server never sees it) and is shown exactly once, right after minting.
function renderClaudeCode(mount, ctx, code) {
  const snippet = JSON.stringify(
    { mcpServers: { medtracker: { command: '<path>/mcpshim', env: { MEDTRACKER_MCP_CODE: code } } } },
    null,
    2
  );
  mount.innerHTML = `
    <section class="wg-section">
      <p class="wg-row__title">Connect Claude Code</p>
      <p>Save this pairing code now — it will not be shown again. Build the
         shim (<code>go build ./cmd/mcpshim</code>) and paste this config
         into Claude Code / Desktop's MCP settings.</p>
      ${codeField('Pairing code', 'claude-code', 'claude-copy-code', 'Copy code')}
      <pre id="claude-config-snippet" class="wg-card wg-code-block"></pre>
      <button type="button" id="claude-copy-snippet" class="wg-btn wg-btn--block">Copy config</button>
      <button type="button" id="claude-done" class="wg-btn wg-btn--primary wg-btn--block">Done</button>
    </section>`;

  // Server/client-generated secrets — textContent only, never innerHTML.
  mount.querySelector('#claude-code').textContent = code;
  mount.querySelector('#claude-config-snippet').textContent = snippet;
  bindCopy(mount.querySelector('#claude-copy-code'), code);
  bindCopy(mount.querySelector('#claude-copy-snippet'), snippet);
  mount.querySelector('#claude-done').addEventListener('click', () => renderConnectors(mount, ctx));
  hydrateIcons(mount);
}

function renderConnectorsError(mount, ctx, errorText) {
  mount.innerHTML = `
    <section class="wg-section">
      <p class="wg-error"></p>
      <button type="button" id="connectors-retry" class="wg-btn wg-btn--block">Try again</button>
    </section>`;
  mount.querySelector('.wg-error').textContent = errorText;
  mount.querySelector('#connectors-retry').addEventListener('click', () => renderConnectors(mount, ctx));
}
