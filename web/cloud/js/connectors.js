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
// Remote remains the default (CC1–CC4). Private Claude Code setup (CC5–CC11)
// uses the published pinned helper; a stored pairing never proves attachment.
//
// Telegram is deliberately NOT mounted here. It is neither a device nor an
// MCP connector, and Settings → Integrations already mounts it.
import { getPairing, connectClaude, disconnectClaude, pairingNeedsReconnect } from './mcp-pairing.js';
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

async function loadConnectors(mount, ctx, showReconnect = true) {
  const pairing = await getPairing(ctx);
  if (renderBlocked(mount)) return;
  const remote = await getRemoteStatus();
  if (renderBlocked(mount)) return;
  renderPicker(mount, ctx, pairing, remote, showReconnect);
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
  local: 'Private pairing saved',
  none: 'Not connected',
};

const CLAUDE_STATUS_META = {
  remote: 'Use your records in Claude Code, the Claude app or ChatGPT.',
  local: 'The pairing code was shown once when you connected.',
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
    <button type="button" id="claude-private-button" class="wg-btn wg-btn--block">Private mode for Claude Code</button>
    <p class="wg-hint">End-to-end encrypted through our server. Needs a small helper on your computer.</p>
    <p class="wg-hint">One AI app per account. Connecting a new one replaces the old link.</p>`,
  // CC4 · Local shim: the switch, secondary (minting a pairing replaces the
  // account's old one server-side, mcp_relay.go).
  local: `
    <p class="wg-hint">Our server relays encrypted messages. Claude and its model provider can see the records you ask for.</p>
    ${KEEP_OPEN_HINT}
    <p class="wg-hint">The pairing code is shown once. To set up again or replace this connection, reconnect.</p>
    <button type="button" id="claude-private-button" class="wg-btn wg-btn--block">Reconnect</button>
    <button type="button" id="claude-remote-connect-button" class="wg-btn wg-btn--block">Use the standard connection instead</button>
    <p class="wg-hint">A pairing can expire or need reconnecting after the relay restarts. Reconnect creates a new code.</p>`,
  // Remote on: switching to Private is a confirmed replacement, not a no-op.
  remote: '<button type="button" id="claude-private-button" class="wg-btn wg-btn--block">Private mode for Claude Code</button>',
};

function renderPicker(mount, ctx, pairing, remote, showReconnect = true) {
  if (renderBlocked(mount)) return;
  const mode = claudeMode(pairing, remote.enabled);
  const needsReconnect = showReconnect && mode === 'none' && pairingNeedsReconnect(ctx);
  const showApps = mode === 'remote' && remote.url;
  mount.innerHTML = `
    <div class="wg-card wg-hstack">
      <span class="wg-row__lead${mode === 'remote' ? ' wg-row__lead--ok' : ''}"><i class="wg-ico" data-icon="plug"></i></span>
      <span class="wg-vstack wg-spacer">
        <span class="wg-row__title" id="claude-status"></span>
        <span class="wg-meta" id="claude-status-meta"></span>
      </span>
    </div>
    ${showApps ? '<div id="claude-apps" class="wg-vstack"></div>' : ''}
    ${CAPABILITIES}
    ${CONNECT_BLOCK[mode]}
    ${mode === 'none' ? '' : '<button type="button" id="claude-disconnect-button" class="wg-btn wg-btn--danger-ghost wg-btn--block">Disconnect</button>'}`;

  // Remote and Private share the pairing record, so a 4404 alone cannot say
  // which mode ended. Keep both choices and the remote default on this return
  // view; Private's OS/reconnect instructions follow only its explicit choice.
  mount.querySelector('#claude-status').textContent = needsReconnect ? 'Reconnect needed' : CLAUDE_STATUS_TEXT[mode];
  mount.querySelector('#claude-status-meta').textContent = needsReconnect ? 'The previous connection ended. Choose how to connect again.' : CLAUDE_STATUS_META[mode];

  // CC4: remote is on — show the per-app instructions again (the token lives
  // server-side, med-24d), with no primary: nothing is waiting.
  if (showApps) {
    const apps = mount.querySelector('#claude-apps');
    renderAppSwitch(apps, remote.url, false);
    apps.insertAdjacentHTML('beforeend', KEEP_OPEN_HINT);
  }

  mount.querySelector('#claude-private-button')?.addEventListener('click', () => renderPrivateChoice(mount, ctx, needsReconnect));
  let pending = false;
  let mutationStarted = false;
  mount.querySelector('#claude-remote-connect-button')?.addEventListener('click', async (event) => {
    if (pending || renderBlocked(mount)) return;
    pending = true;
    const button = event.currentTarget;
    mount.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      const currentPairing = await getPairing(ctx);
      if (renderBlocked(mount) || !button.isConnected) return;
      const currentRemote = await getRemoteStatus();
      if (renderBlocked(mount) || !button.isConnected) return;
      if ((currentPairing || currentRemote.enabled) && !(await confirmReplacement('remote', button))) return;
      if (!(await window.safeConfirm(REMOTE_CONSENT_TEXT, null, { title: 'Connect an AI app?', confirmLabel: 'Connect', icon: 'plug' }))) return;
      if (renderBlocked(mount) || !button.isConnected) return;
      mutationStarted = true;
      const { url } = await connectRemote(ctx);
      if (button.isConnected) renderConnected(mount, ctx, url);
    } catch {
      if (button.isConnected) renderMutationError(mount, ctx, mutationStarted);
    } finally {
      pending = false;
      if (button.isConnected) mount.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  });

  // Kit S5: outlined destructive → dialog → filled clay confirm.
  mount.querySelector('#claude-disconnect-button')?.addEventListener('click', async () => {
    const confirmed = await window.safeConfirm(
      'Claude loses access right away. Your data stays in the vault. You can reconnect later with a new ' +
        (mode === 'remote' ? 'URL.' : 'pairing code.') + ' Disconnect does not erase earlier records or transcripts, or uninstall the helper.',
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

// Published commands.json from mcpshim-v0.1.0, source
// 1a7c640616108cc79f1ce1b2b5e52cac56d7fc6c. Deliberately embedded: no mutable
// latest resolver or browser GitHub request. Only the base64url wire code may
// replace the single shell-quoted placeholder (contract: docs/mcpshim.md).
const PRIVATE_COMMANDS = {
  posix: "( set -eu; umask 077; d=$(mktemp -d); trap 'rm -rf \"$d\"' EXIT HUP INT TERM; curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 'https://github.com/korjavin/medicationtrackerbot/releases/download/mcpshim-v0.1.0/install.sh' -o \"$d/install.sh\"; if command -v sha256sum >/dev/null 2>&1; then h=$(sha256sum \"$d/install.sh\"); else h=$(shasum -a 256 \"$d/install.sh\"); fi; [ \"${h%% *}\" = '8be0fc4a40e7ce634567413a5f4dd34c62a81aac002c6fbfd1d18ef9b8065f8c' ]; sh \"$d/install.sh\" --version 0.1.0 --pairing-code '<PAIRING_CODE>' )",
  powershell: "& { $ErrorActionPreference='Stop'; $d=$null; try { $d=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N')); [IO.Directory]::CreateDirectory($d) | Out-Null; $a=Get-Acl -LiteralPath $d; $a.SetAccessRuleProtection($true,$false); $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User,'FullControl','ContainerInherit,ObjectInherit','None','Allow')); Set-Acl -LiteralPath $d -AclObject $a; $p=Join-Path $d 'install.ps1'; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/korjavin/medicationtrackerbot/releases/download/mcpshim-v0.1.0/install.ps1' -OutFile $p; if ((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'd380d9c008c0d396b959d93709a09225660e007f9e6b54074949cc8013f94d57') { throw 'Installer checksum mismatch' }; & $p -Version 0.1.0 -PairingCode '<PAIRING_CODE>'; if ($LASTEXITCODE -ne 0) { throw 'Installer failed' } } catch { [Console]::Error.WriteLine('Helper installation failed; check the pinned release and host policy.'); exit 1 } finally { if ($d -and (Test-Path -LiteralPath $d)) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue } } }",
};

const PRIVATE_PRIVACY = '<p class="wg-hint">Our server relays encrypted messages. Requested records reach Claude and its model provider outside the vault.</p>';
const PRIVATE_KEY_WARNING = '<div class="wg-note wg-note--warn"><i class="wg-ico" data-icon="key"></i><div class="wg-note__body">The prompt contains your pairing key. Claude, its transcript, shell history and local settings may keep it. Disconnect revokes access, but does not erase earlier data or transcripts or uninstall the helper.</div></div>';

function computerChoice() {
  return `<div class="wg-field"><span class="wg-label">Computer to set up</span>
    <div class="wg-seg" role="group" aria-label="Computer to set up">${[['macos', 'macOS'], ['linux', 'Linux'], ['windows', 'Windows']].map(([id, label]) =>
    `<button type="button" class="wg-seg__opt" data-computer="${id}" aria-pressed="false">${label}</button>`).join('')}</div>
    <p class="wg-hint">Choose your computer’s system, even if you are using this page on a phone.</p></div>`;
}

function bindComputerChoice(mount, show) {
  mount.querySelectorAll('[data-computer]').forEach((button) => button.addEventListener('click', () => {
    if (renderBlocked(mount) || button.disabled) return;
    mount.querySelectorAll('[data-computer]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
    show(button.dataset.computer);
  }));
}

async function confirmReplacement(destination, backgroundAction) {
  const wasPrimary = backgroundAction.classList.contains('wg-btn--primary');
  backgroundAction.classList.remove('wg-btn--primary');
  try {
    return await window.safeConfirm(
      'Creating a new connection disconnects your current AI app. ' + (destination === 'private'
        ? 'You will need to set up Claude Code with the new code.'
        : 'You will need to set up your AI app with the new link.'),
      null, { title: 'Replace this connection?', confirmLabel: 'Replace connection', icon: 'plug', focusCancel: true },
    );
  } finally {
    if (wasPrimary && backgroundAction.isConnected) backgroundAction.classList.add('wg-btn--primary');
  }
}

function renderPrivateChoice(mount, ctx, reconnect = false) {
  if (renderBlocked(mount)) return;
  mount.innerHTML = `${reconnect
    ? '<div class="wg-card"><span class="wg-row__title">Reconnect needed</span><p class="wg-meta">The previous connection ended.</p></div><div class="wg-note wg-note--warn"><i class="wg-ico" data-icon="plug"></i><div class="wg-note__body">Reconnect to create a new code and update Claude Code.</div></div>'
    : '<h2 class="wg-card__title">Private mode for Claude Code</h2>'}
    ${PRIVATE_PRIVACY}
    <p class="wg-hint">The setup command installs our helper on your computer and verifies its release checksum. Claude Code must already be installed.</p>
    ${computerChoice()}
    ${PRIVATE_KEY_WARNING}
    ${KEEP_OPEN_HINT}
    <button type="button" id="claude-private-create" class="wg-btn wg-btn--primary wg-btn--block" disabled>${reconnect ? 'Reconnect' : 'Create private connection'}</button>
    <button type="button" id="claude-private-back" class="wg-btn wg-btn--block">Back to connector</button>`;
  let computer;
  let pending = false;
  let mutationStarted = false;
  const create = mount.querySelector('#claude-private-create');
  bindComputerChoice(mount, (os) => { computer = os; create.disabled = false; });
  mount.querySelector('#claude-private-back').addEventListener('click', () => {
    loadConnectors(mount, ctx, false).catch(() => renderConnectorsError(mount, ctx, 'Could not load the connector status. Try again.'));
  });
  create.addEventListener('click', async () => {
    if (!computer || pending || renderBlocked(mount)) return;
    pending = true;
    mount.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    try {
      // Re-read at the action boundary: a render-time snapshot can be stale.
      const pairing = await getPairing(ctx);
      if (renderBlocked(mount) || !create.isConnected) return;
      const remote = await getRemoteStatus();
      if (renderBlocked(mount) || !create.isConnected) return;
      if ((pairing || remote.enabled || reconnect) && !(await confirmReplacement('private', create))) return;
      if (renderBlocked(mount) || !create.isConnected) return;
      // The existing session-authenticated legacy mint atomically tears down
      // hosted remote enablement (MCPRelayAPI.onLegacyPairingMutation). Never
      // POST the client-generated private key to /api/mcp/remote.
      mutationStarted = true;
      const { code } = await connectClaude(ctx);
      if (create.isConnected) renderPrivateSetup(mount, ctx, code, computer);
    } catch {
      if (create.isConnected) renderMutationError(mount, ctx, mutationStarted);
    } finally {
      pending = false;
      if (create.isConnected) mount.querySelectorAll('button').forEach((button) => { button.disabled = false; });
    }
  });
  hydrateIcons(mount);
}

function renderPrivateSetup(mount, ctx, code, computer) {
  if (renderBlocked(mount)) return;
  // connectClaude owns the wire format. Fail closed if a future caller returns
  // arbitrary text: the published templates quote only this restricted alphabet.
  if (typeof code !== 'string' || !/^mtmcp1\.[A-Za-z0-9_-]+$/.test(code)) {
    renderMutationError(mount, ctx, true);
    return;
  }
  mount.innerHTML = `
    <div class="wg-card wg-hstack"><span class="wg-row__lead"><i class="wg-ico" data-icon="plug"></i></span><span class="wg-vstack wg-spacer"><span class="wg-row__title">Private connection created</span><span class="wg-meta">Finish setup on your computer.</span></span><span class="wg-chip wg-chip--pending wg-chip--sm">Setup</span></div>
    ${computerChoice()}
    <div id="claude-private-instructions" class="wg-vstack"></div>
    ${KEEP_OPEN_HINT}
    <p class="wg-hint">This code is shown once. Copy it before leaving. To get a new code later, reconnect.</p>
    ${PRIVATE_PRIVACY}
    ${PRIVATE_KEY_WARNING}
    <p class="wg-hint">Pinned helper mcpshim-v0.1.0. You trust this app, its publisher and the downloaded helper. Checksums detect changed download bytes; they do not prove an honest publisher. Host security policy may block installation; the installer does not bypass it.</p>`;
  const instructions = mount.querySelector('#claude-private-instructions');
  const show = (os) => {
    const command = PRIVATE_COMMANDS[os === 'windows' ? 'powershell' : 'posix'].replace('<PAIRING_CODE>', code);
    const prompt = `Connect my health records in Private mode: run this ${os === 'windows' ? 'PowerShell' : 'POSIX shell'} command, then tell me to restart Claude Code. If health already exists, ask me before replacing only its user-scope entry by retrying the installer with ${os === 'windows' ? '-ReplaceUserHealth' : '--replace-user-health'}; leave local/project connections alone. Those scopes may shadow the user entry. Command: ${command}`;
    instructions.innerHTML = `
      <div class="wg-field"><span class="wg-label">Paste into Claude Code on that computer</span><div class="wg-code wg-code--wrap wg-private-code"><span id="claude-private-prompt" tabindex="0"></span></div></div>
      <button type="button" id="claude-private-copy-prompt" class="wg-btn wg-btn--primary wg-btn--block"><i class="wg-ico" data-icon="copy"></i>Copy prompt</button>
      <p id="claude-private-feedback" class="wg-hint wg-private-feedback" role="status" aria-live="polite"></p>
      <p class="wg-hint">Review the command before running it. Restart Claude Code, then ask “Show my blood pressure this week.” Installation and clipboard success do not establish a live connection.</p>
      <details class="wg-disc"><summary><span class="wg-setting__body"><span class="wg-setting__title">Or use a terminal</span><span class="wg-setting__desc">${os === 'windows' ? 'PowerShell' : 'Terminal'}</span></span><i class="wg-ico wg-disc__chev" data-icon="chev-d"></i></summary><div class="wg-disc__body">
        <div class="wg-code wg-code--wrap wg-private-code"><span id="claude-private-command" tabindex="0"></span></div>
        <button type="button" id="claude-private-copy-command" class="wg-btn wg-btn--block">Copy command</button>
        <p class="wg-hint">If health already exists, ask before retrying the installer with ${os === 'windows' ? '-ReplaceUserHealth' : '--replace-user-health'}. This replaces only the user-scope entry; local/project entries can still shadow it. After a failed replacement, retry setup; the old connection is not restored.</p>
      </div></details>`;
    instructions.querySelector('#claude-private-prompt').textContent = prompt;
    instructions.querySelector('#claude-private-command').textContent = command;
    const feedback = instructions.querySelector('#claude-private-feedback');
    const copy = (id, text, success) => instructions.querySelector(id).addEventListener('click', async () => {
      if (renderBlocked(mount)) return;
      try {
        await navigator.clipboard.writeText(text);
        if (feedback.isConnected) feedback.textContent = success;
      } catch {
        if (feedback.isConnected) feedback.textContent = 'Could not copy. Select and copy the text above, then retry.';
      }
    });
    copy('#claude-private-copy-prompt', prompt, 'Copied. Paste into Claude Code.');
    copy('#claude-private-copy-command', command, 'Copied. Paste into your terminal.');
    hydrateIcons(instructions);
  };
  bindComputerChoice(mount, show);
  mount.querySelector(`[data-computer="${computer}"]`).setAttribute('aria-pressed', 'true');
  show(computer);
  hydrateIcons(mount);
}

function renderMutationError(mount, ctx, mutationStarted) {
  // A replacement can fail after revoking the old link. Never promise rollback
  // or show Connected from the previous snapshot; re-read actual status first.
  renderConnectorsError(mount, ctx, mutationStarted
    ? 'Could not finish setup. Your previous connection may have been replaced. Check status, then retry setup if needed.'
    : 'Could not check the connection status. Nothing was changed. Try again.');
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
