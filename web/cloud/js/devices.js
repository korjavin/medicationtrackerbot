// Device-list + revocation screen: docs/cloud-crypto.md "Removing a device /
// revocation" and the envelope-audit MAC ("Malicious operator adds their own
// credential"). An unlocked device already holds the DEK, so it re-derives
// K_mac and checks every envelope's mac before rendering a verified /
// unverified badge — a forged envelope (no DEK access) fails the audit.
import { auditEnvelope, fromBase64, fromBase64Url } from './crypto.js';
import { getPairing, connectClaude, disconnectClaude } from './mcp-pairing.js';
import { getRemoteStatus, connectRemote, disconnectRemote } from './mcp-remote.js';

export function renderDeviceList(app, ctx, onExit) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Devices</h1>
      <p>Loading your devices&hellip;</p>
    </section>`;
  loadDevices(app, ctx, onExit).catch((err) => {
    renderDeviceListError(app, ctx, onExit, err.message || String(err));
  });
}

async function loadDevices(app, ctx, onExit) {
  const res = await fetch('/api/devices');
  if (!res.ok) throw new Error('Could not load your devices.');
  const devices = await res.json();

  const audited = await Promise.all(
    (devices || []).map(async (d) => {
      const credentialId = fromBase64Url(d.credential_id);
      let verified = false;
      if (d.envelope) {
        verified = await auditEnvelope({
          dek: ctx.dek,
          envelope: {
            nonce: fromBase64(d.envelope.nonce),
            ct: fromBase64(d.envelope.ct),
            mac: fromBase64(d.envelope.mac),
          },
          credentialId,
        });
      }
      return { ...d, verified };
    })
  );

  const pairing = await getPairing(ctx);
  const remoteEnabled = await getRemoteStatus();
  renderDevices(app, ctx, onExit, audited, pairing, remoteEnabled);
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

function renderDevices(app, ctx, onExit, devices, pairing, remoteEnabled) {
  const mode = claudeMode(pairing, remoteEnabled);
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Devices</h1>
      <ul class="device-list" id="device-list"></ul>
      <button id="add-device-button">Add a device</button>
      <h2>Claude connector</h2>
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
      <button id="devices-back">Back</button>
    </section>`;

  const list = app.querySelector('#device-list');
  for (const d of devices) {
    list.appendChild(renderDeviceRow(app, ctx, onExit, d));
  }

  app.querySelector('#add-device-button').addEventListener('click', () => {
    import('./transfer.js')
      .then(({ renderAddDevice }) => renderAddDevice(app, ctx, () => renderDeviceList(app, ctx, onExit)))
      .catch(() => renderDeviceListError(app, ctx, onExit, 'Could not open the add-device flow. Try again.'));
  });

  app.querySelector('#claude-status').textContent = CLAUDE_STATUS_TEXT[mode];
  app.querySelector('#claude-disconnect-button').hidden = mode === 'none';

  app.querySelector('#claude-remote-connect-button').addEventListener('click', () => {
    if (!confirm(REMOTE_CONSENT_TEXT)) return;
    connectRemote(ctx)
      .then(({ token, url }) => renderRemoteURL(app, ctx, onExit, token, url))
      .catch((err) => renderDeviceListError(app, ctx, onExit, err.message || String(err)));
  });

  app.querySelector('#claude-local-connect-button').addEventListener('click', () => {
    // Switching from remote disconnects it first — the relay only tracks
    // one pairing per account, so the old one would otherwise be orphaned.
    (mode === 'remote' ? disconnectRemote(ctx) : Promise.resolve())
      .then(() => connectClaude(ctx))
      .then(({ code }) => renderClaudeCode(app, ctx, onExit, code))
      .catch((err) => renderDeviceListError(app, ctx, onExit, err.message || String(err)));
  });

  app.querySelector('#claude-disconnect-button').addEventListener('click', () => {
    (mode === 'remote' ? disconnectRemote(ctx) : disconnectClaude(ctx))
      .then(() => renderDeviceList(app, ctx, onExit))
      .catch((err) => renderDeviceListError(app, ctx, onExit, err.message || String(err)));
  });

  app.querySelector('#devices-back').addEventListener('click', onExit);
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
  app.querySelector('#claude-remote-done').addEventListener('click', () => renderDeviceList(app, ctx, onExit));
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
  app.querySelector('#claude-done').addEventListener('click', () => renderDeviceList(app, ctx, onExit));
}

function renderDeviceRow(app, ctx, onExit, d) {
  const li = document.createElement('li');
  li.className = 'device-row';

  // Server-controlled fields (credential id, timestamps) — textContent only,
  // never innerHTML (this page holds the DEK; XSS here reads it).
  const label = document.createElement('span');
  label.textContent = `Passkey ${d.credential_id.slice(0, 8)}… — added ${new Date(d.created_at).toLocaleDateString()}`;
  li.appendChild(label);

  const badge = document.createElement('span');
  badge.className = d.verified ? 'device-verified' : 'device-unverified';
  badge.textContent = d.verified ? 'verified' : 'unverified — remove?';
  li.appendChild(badge);

  const revokeButton = document.createElement('button');
  revokeButton.textContent = 'Revoke';
  revokeButton.addEventListener('click', () => {
    // Retiring a device you still control vs. a stolen one need different
    // responses: revocation alone only removes access going forward. A
    // stolen unlocked device already saw the DEK, so recovering from that
    // needs key rotation — out of scope here (docs/cloud-crypto.md "Removing
    // a device / revocation" status note) — hence the copy pointing there.
    const confirmed = confirm(
      'Revoke this device?\n\nUse this to retire a device you still control. If it was lost or ' +
        'stolen, revoking here does not protect your data on its own — see the recovery guide ' +
        'about rotating your keys.'
    );
    if (!confirmed) return;
    revokeDevice(app, ctx, onExit, d.credential_id);
  });
  li.appendChild(revokeButton);

  return li;
}

async function revokeDevice(app, ctx, onExit, credentialId) {
  try {
    const res = await fetch(`/api/devices/${credentialId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Could not revoke that device. Try again.');
    renderDeviceList(app, ctx, onExit);
  } catch (err) {
    renderDeviceListError(app, ctx, onExit, err.message || String(err));
  }
}

function renderDeviceListError(app, ctx, onExit, errorText) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Devices</h1>
      <p class="wizard-error"></p>
      <button id="devices-retry">Try again</button>
      <button id="devices-back">Back</button>
    </section>`;
  app.querySelector('.wizard-error').textContent = errorText;
  app.querySelector('#devices-retry').addEventListener('click', () => renderDeviceList(app, ctx, onExit));
  app.querySelector('#devices-back').addEventListener('click', onExit);
}
