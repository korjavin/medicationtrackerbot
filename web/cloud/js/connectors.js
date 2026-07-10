// Connectors page (/connectors): the Claude/MCP connector picker, split out of
// the device-list screen (med-lyv). Devices and connectors answer different
// questions — "which passkeys can open this vault" vs "which AI client may
// read it" — and sharing one screen made the second look like a property of
// the first.
//
// Route note: the page is /connectors, not /mcp. The relay's capability
// endpoint already owns the "/mcp/<token>" prefix (router.go), and a shell
// page one slash away from it is a trap for both readers and path matching.
//
// Telegram is deliberately NOT mounted here. It is neither a device nor an
// MCP connector, and Settings → Integrations already mounts it.
import { getPairing, connectClaude, disconnectClaude } from './mcp-pairing.js';
import { getRemoteStatus, connectRemote, disconnectRemote } from './mcp-remote.js';

export function renderConnectors(app, ctx, onExit) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Connectors</h1>
      <p>Loading&hellip;</p>
    </section>`;
  loadConnectors(app, ctx, onExit).catch((err) => {
    renderConnectorsError(app, ctx, onExit, err.message || String(err));
  });
}

async function loadConnectors(app, ctx, onExit) {
  const pairing = await getPairing(ctx);
  const remoteEnabled = await getRemoteStatus();
  renderPicker(app, ctx, onExit, pairing, remoteEnabled);
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
  'Enable the remote connector?\n\n' +
  'The server will relay MCP traffic between claude.ai/ChatGPT and your unlocked browser tab. It can read the requests ' +
  'and the answers while relaying — nothing is stored. The connector key is kept on the server so the URL keeps ' +
  'working across restarts, until you Disconnect.';

function renderPicker(app, ctx, onExit, pairing, remoteEnabled) {
  const mode = claudeMode(pairing, remoteEnabled);
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Connectors</h1>
      <p id="claude-status"></p>
      <div class="claude-mode">
        <h3>Remote connector (claude.ai, ChatGPT) — primary</h3>
        <p>The server relays MCP traffic to your unlocked browser tab end-to-end encrypted via the relay. By enabling it
           you consent to the server seeing MCP requests and responses in transit — nothing is stored.</p>
        <button id="claude-remote-connect-button">Enable remote connector</button>
      </div>
      <div class="claude-mode">
        <h3>Local shim (Claude Code) — alternative</h3>
        <p>Fully end-to-end encrypted: runs a shim binary on your own machine, so the server never sees your data.</p>
        <button id="claude-local-connect-button">Connect Claude Code</button>
      </div>
      <p class="claude-mode-note">Only one connector can be active at a time — switching disconnects the other.</p>
      <button id="claude-disconnect-button">Disconnect</button>
      <button id="connectors-back">Back</button>
    </section>`;

  app.querySelector('#claude-status').textContent = CLAUDE_STATUS_TEXT[mode];
  app.querySelector('#claude-disconnect-button').hidden = mode === 'none';
  // Hide the connector that is already active — offering "Enable remote
  // connector" while remote is on is a no-op affordance. The *other* button
  // stays visible: it is the documented switch control (see the mode note
  // above, and the disconnect-then-connect logic below).
  app.querySelector('#claude-remote-connect-button').hidden = mode === 'remote';
  app.querySelector('#claude-local-connect-button').hidden = mode === 'local';

  app.querySelector('#claude-remote-connect-button').addEventListener('click', () => {
    if (!confirm(REMOTE_CONSENT_TEXT)) return;
    connectRemote(ctx)
      .then(({ token, url }) => renderRemoteURL(app, ctx, onExit, token, url))
      .catch((err) => renderConnectorsError(app, ctx, onExit, err.message || String(err)));
  });

  app.querySelector('#claude-local-connect-button').addEventListener('click', () => {
    // Switching from remote disconnects it first — the relay only tracks
    // one pairing per account, so the old one would otherwise be orphaned.
    (mode === 'remote' ? disconnectRemote(ctx) : Promise.resolve())
      .then(() => connectClaude(ctx))
      .then(({ code }) => renderClaudeCode(app, ctx, onExit, code))
      .catch((err) => renderConnectorsError(app, ctx, onExit, err.message || String(err)));
  });

  app.querySelector('#claude-disconnect-button').addEventListener('click', () => {
    (mode === 'remote' ? disconnectRemote(ctx) : disconnectClaude(ctx))
      .then(() => renderConnectors(app, ctx, onExit))
      .catch((err) => renderConnectorsError(app, ctx, onExit, err.message || String(err)));
  });

  app.querySelector('#connectors-back').addEventListener('click', onExit);
}

// The connector URL carries the human token in the clear (it's a capability
// URL, that's the point) and is shown exactly once, right after minting —
// same "shown once" rule as the local shim's pairing code.
function renderRemoteURL(app, ctx, onExit, token, url) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Remote connector enabled</h1>
      <p>Copy this URL now — it will not be shown again (the connector itself keeps working; to see it again, Disconnect
         and re-enable, which mints a new one).</p>
      <dl>
        <dt>Connector URL</dt><dd class="claude-remote-url" id="claude-remote-url"></dd>
      </dl>
      <button id="claude-remote-copy">Copy URL</button>
      <ol>
        <li>claude.ai: Settings &rarr; Connectors &rarr; Add custom connector &rarr; paste the URL.</li>
        <li>ChatGPT: Settings &rarr; Connectors &rarr; Add MCP &rarr; paste the URL.</li>
      </ol>
      <p class="claude-mode-note">Keep an unlocked tab open. The URL stays valid until you Disconnect — it survives
         server updates.</p>
      <button id="claude-remote-done">Done</button>
    </section>`;

  // Server-generated capability URL — textContent only, never innerHTML.
  app.querySelector('#claude-remote-url').textContent = url;
  app.querySelector('#claude-remote-copy').addEventListener('click', () => navigator.clipboard.writeText(url));
  app.querySelector('#claude-remote-done').addEventListener('click', () => renderConnectors(app, ctx, onExit));
}

// The pairing code carries the E2E key in the clear (that's the point — the
// server never sees it) and is shown exactly once, right after minting.
function renderClaudeCode(app, ctx, onExit, code) {
  const snippet = JSON.stringify(
    { mcpServers: { medtracker: { command: '<path>/mcpshim', env: { MEDTRACKER_MCP_CODE: code } } } },
    null,
    2
  );
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Connect Claude</h1>
      <p>Save this pairing code now — it will not be shown again. Build the
         shim (<code>go build ./cmd/mcpshim</code>) and paste this config
         into Claude Code / Desktop's MCP settings.</p>
      <dl>
        <dt>Pairing code</dt><dd class="claude-code" id="claude-code"></dd>
      </dl>
      <button id="claude-copy-code">Copy code</button>
      <pre id="claude-config-snippet"></pre>
      <button id="claude-copy-snippet">Copy config</button>
      <button id="claude-done">Done</button>
    </section>`;

  // Server/client-generated secrets — textContent only, never innerHTML.
  app.querySelector('#claude-code').textContent = code;
  app.querySelector('#claude-config-snippet').textContent = snippet;
  app.querySelector('#claude-copy-code').addEventListener('click', () => navigator.clipboard.writeText(code));
  app.querySelector('#claude-copy-snippet').addEventListener('click', () => navigator.clipboard.writeText(snippet));
  app.querySelector('#claude-done').addEventListener('click', () => renderConnectors(app, ctx, onExit));
}

function renderConnectorsError(app, ctx, onExit, errorText) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Connectors</h1>
      <p class="wizard-error"></p>
      <button id="connectors-retry">Try again</button>
      <button id="connectors-back">Back</button>
    </section>`;
  app.querySelector('.wizard-error').textContent = errorText;
  app.querySelector('#connectors-retry').addEventListener('click', () => renderConnectors(app, ctx, onExit));
  app.querySelector('#connectors-back').addEventListener('click', onExit);
}
