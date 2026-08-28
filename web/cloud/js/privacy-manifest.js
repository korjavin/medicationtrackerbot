// THE PRIVACY / EGRESS MANIFEST — bd med-yor.4 (finding P1 in
// docs/2026-07-12-gpt-5.6-sol-cloud-privacy-audit.md).
//
// One structured list, one source of truth. Every place the product tells a
// user what happens to their data is derived from THIS file:
//
//   * docs/cloud-mode.md → "Privacy boundary" — the boundary table is
//     GENERATED from renderBoundaryTable() below (`pnpm privacy:docs` rewrites
//     the block between the GENERATED markers; the guard test fails if the
//     committed doc drifts from what the manifest renders).
//   * Settings → "What can the operator see?" — web/cloud/js/privacy.js derives
//     PRIVACY_ITEMS from every entry's `userCopy`.
//   * docs/cloud-mode.md → "Metadata leakage summary" — cross-checked 1:1
//     against every entry's `docSignal` by tests/privacy.drift.test.js.
//
// It replaces the old partial `docSignal` convention, whose hole was that
// `docSignal: null` entries escaped every machine check. Here there is no such
// hole: `userCopy` is mandatory (only entries explicitly covered by a sibling's
// copy may set it null, and the guard checks the sibling names them), and every
// entry renders into the generated doc table — a manifest row with no
// user-visible disclosure is structurally impossible.
//
// WHY THIS IS NOT MERELY A SECOND HAND-WRITTEN LIST:
// tests/architecture.privacy-claims.test.js derives the *set of things that
// must be disclosed* from the code itself — the outbound-HTTP / plaintext-
// handling files under internal/cloudserver/, and every literal third-party
// host in internal/cloudserver/*.go and web/cloud/js/**. Ship a new proxy, a
// new upstream host, or a new server-side plaintext path and the guard fails
// until an entry here claims it in `code`. Two hand-written lists compared to
// each other would catch nothing; this one is anchored to real call sites.
//
// ADDING AN ENTRY: fill in every field (the shape guard is strict), cite real
// `file:line` evidence (existence is checked), claim the code anchors in
// `code`, then run `pnpm privacy:docs` and commit the regenerated table.
//
// HONESTY CONSTRAINTS (inherited from med-yor.1 — do not "simplify" these away):
//   * The vault claim is TRUE and stays stated unconditionally.
//   * The carve-outs do NOT share one activation story. The operator-default
//     food DB and RxNav have no toggle, and RxNav has no BYO alternative at
//     all. Flattening them into "all opt-in" is a banned pattern in the guard.

// How much the OPERATOR (whoever runs this service) can see of an entry's data.
// Rendered into the "Who sees it" column.
export const OPERATOR_VISIBILITY = {
  none: 'nothing — never touches the operator',
  ciphertext: 'ciphertext only',
  metadata: 'metadata only',
  transient: 'plaintext, transiently in memory',
  plaintext: 'plaintext in transit',
  'at-rest': 'plaintext at rest (the operator holds the unwrapping key)',
};

// The activation class. Three egress classes, deliberately not collapsed:
// off-until-enabled, no-toggle-active-on-use, and always-on. `on-device` and
// `user-initiated` cover rows that are not ongoing egress at all.
export const ACTIVATION = {
  'opt-in-consent': 'Opt-in + explicit consent (revocable in Settings → Integrations)',
  'opt-in': 'Opt-in',
  'no-toggle': 'No toggle — active on use',
  'always-on': 'Always on',
  'user-initiated': 'Only on your action',
  'on-device': 'On-device, inherent to offline use',
};

// What kind of row this is: a real carve-out (plaintext or metadata leaves the
// vault), something that looks like one but is not, an on-device exposure that
// never leaves the device, or the vault promise itself.
export const BOUNDARY = {
  'carve-out': '',
  'not-a-carve-out': ' — *not a carve-out*',
  'on-device': ' — *stays on your device*',
  vault: ' — *the vault promise*',
};

export const PRIVACY_MANIFEST = [
  // ==========================================================================
  // The vault, and what the device itself holds.
  // ==========================================================================
  {
    id: 'vault',
    feature: 'The vault (all health records)',
    boundary: 'vault',
    data: 'Medications and doses, blood pressure, weight, food, workouts, sleep, vitals, diary notes',
    destination: 'The operator\'s sync API — as ciphertext only',
    operatorVisibility: 'ciphertext',
    retention: 'Stored until you delete the account; the operator holds no key to it, ever',
    activation: 'always-on',
    activationNote: 'the default and only storage path',
    byo: 'n/a — the DEK is generated in your browser and never leaves your devices',
    evidence: ['web/cloud/js/crypto.js:1', 'internal/cloudserver/sync.go:1'],
    code: { go: [], hosts: [] },
    docSignal: null,
    userCopy: {
      category: 'protected',
      title: 'Your health data',
      detail: 'Stored and synced only as ciphertext. The operator cannot read a single reading, dose, note, or value.',
    },
  },
  {
    // med-yor.4 gap 1: the record TYPE and record ID of every synced op are
    // wire fields the server stores unencrypted. A histogram of them plus
    // timing is a health-inference channel on its own, and the vitals record
    // ids embed the calendar day.
    id: 'record-type-tag',
    feature: 'Record types and record ids (sync tags)',
    boundary: 'carve-out',
    data: 'Which KIND of record each sync op is (`bp`, `medication`, `hrsample`, `diary`, …) and its record id — never its contents',
    destination: 'Stored beside the ciphertext in the operator\'s oplog',
    operatorVisibility: 'metadata',
    retention: 'For the life of the op or snapshot, same as the ciphertext it labels',
    activation: 'always-on',
    activationNote: 'the tag is what lets a reading device bind the AAD without a schema change',
    byo: 'n/a',
    evidence: ['web/cloud/js/sync.js:54', 'web/cloud/js/sync.js:59', 'web/cloud/js/sync.js:1193'],
    code: { go: [], hosts: [] },
    docSignal: 'Record types + record ids (sync tags)',
    userCopy: {
      category: 'visible',
      title: 'Which kinds of record you keep, and when',
      detail: 'Each synced item is labelled with its type and id in the clear — "a blood-pressure record", "a heart-rate day", "a diary note" — so your device can verify it on the way back. The contents stay sealed, but the labels are not nothing: a profile that is mostly blood-pressure records, arriving twice a day, suggests someone monitoring hypertension, and the vitals ids carry the calendar day. Treat the shape of your record types, and their timing, as something the operator can see.',
    },
  },
  {
    // med-yor.4 gap 3: decrypted records land in IndexedDB, and a cached LDK
    // reopens the vault with no passkey prompt and no auto-lock. Documented
    // for developers in docs/cloud-crypto.md; never said in the app until now.
    id: 'local-mirror',
    feature: 'Decrypted mirror on your device + warm unlock',
    boundary: 'on-device',
    data: 'Every record you have synced, decrypted, in this browser\'s IndexedDB — plus a cached device key that reopens the vault with no passkey prompt',
    destination: 'Nowhere. It never leaves the device',
    operatorVisibility: 'none',
    retention: 'Until you sign out, delete the account, or clear site data on that browser; there is no idle auto-lock',
    activation: 'on-device',
    activationNote: 'the app renders offline, which requires a local plaintext copy',
    byo: 'n/a',
    evidence: ['web/cloud/js/sync.js:211', 'web/cloud/js/unlock.js:19', 'web/cloud/js/unlock.js:38'],
    code: { go: [], hosts: [] },
    docSignal: null,
    userCopy: {
      category: 'device',
      title: 'A readable copy lives on this device',
      detail: 'So the app works offline, your records are decrypted and kept in this browser\'s storage, and once a device is unlocked it stays unlocked — reopening the app does not ask for your passkey again, and there is no idle auto-lock. That is convenient on your own phone and a real risk on a shared or borrowed computer: anyone who can open this browser profile can read everything. Sign out or delete the account to clear it, and think twice before unlocking on a machine you do not control.',
    },
  },

  // ==========================================================================
  // Operational metadata — always on, inherent to running the service.
  // ==========================================================================
  {
    id: 'push-relay',
    feature: 'Push reminder relay',
    boundary: 'not-a-carve-out',
    data: 'The time a reminder fires — plus, if you linked Telegram, the time a message you send the bot arrives, which fires a content-free wake — and an opaque blob; a reminder payload is app-layer encrypted under the push key on top of RFC 8291',
    destination: 'The operator\'s queue, then your browser vendor\'s push service (FCM / APNs / Mozilla)',
    operatorVisibility: 'ciphertext',
    retention: 'The queue entry is deleted once sent; the subscription endpoint persists until you disable push',
    activation: 'opt-in',
    activationNote: 'you grant notification permission',
    byo: 'n/a',
    evidence: ['internal/cloudserver/push.go:215', 'internal/cloudserver/relay.go:88', 'internal/cloudserver/relay.go:384'],
    code: { go: ['internal/cloudserver/relay.go', 'internal/cloudserver/push.go'], hosts: [] },
    docSignal: 'Reminder timing',
    userCopy: {
      category: 'visible',
      title: 'When your reminders fire',
      detail: 'A reminder is a blind alarm clock: the server knows a reminder is due at a time, but its content stays sealed. Your push subscription endpoint also tells the operator which browser vendor you use, and that vendor sees the ciphertext and its timing. Sending your bot a message also fires a wake push carrying no text at all, so an open tab records it immediately — that timing reaches your push vendor too.',
    },
  },
  {
    id: 'account-existence',
    feature: 'Account existence + subdomain',
    boundary: 'carve-out',
    data: 'That an account exists, its subdomain, and its creation date',
    destination: 'The operator; DNS/SNI observers on the network',
    operatorVisibility: 'metadata',
    retention: 'For the life of the account',
    activation: 'always-on',
    activationNote: 'a per-user origin is how the app is served',
    byo: 'n/a',
    evidence: ['internal/cloudserver/router.go:201'],
    code: { go: [], hosts: [] },
    docSignal: 'Subdomain (≈ account existence)',
    userCopy: {
      category: 'visible',
      title: 'That your account exists',
      detail: 'Your account lives at its own subdomain, so the operator (and, over the network, DNS observers) can tell an account exists. The wildcard certificate keeps the name out of public certificate logs.',
    },
  },
  {
    id: 'sync-metadata',
    feature: 'Sync cadence, blob sizes, IPs',
    boundary: 'carve-out',
    data: 'How often each device syncs, how big each encrypted blob is, and the IP it came from',
    destination: 'The operator',
    operatorVisibility: 'metadata',
    retention: 'Row timestamps persist with the oplog; request logs per the operator\'s retention policy',
    activation: 'always-on',
    activationNote: 'syncing is how your devices agree',
    byo: 'n/a',
    evidence: ['internal/cloudserver/sync.go:1'],
    code: { go: [], hosts: [] },
    docSignal: 'Sync cadence, blob sizes, IPs',
    userCopy: {
      category: 'visible',
      title: 'When and how much you sync',
      detail: 'How often your device syncs, the size of each encrypted blob, and your IP address — the same as any sync service sees. None of it is your health content, but it is not nothing either: sync bursts, reminder times and message arrivals sketch your daily routine, and blob sizes hint at how much you record. Treat it as metadata that can be inferred from, not as "no signal".',
    },
  },

  // ==========================================================================
  // Operator-trial provider keys — plaintext through the operator, by design.
  // ==========================================================================
  {
    id: 'trial-ai',
    feature: 'Trial AI (operator\'s OpenAI key)',
    boundary: 'carve-out',
    data: 'The meal or activity description you typed, and meal PHOTOS, in plaintext',
    destination: 'The operator\'s server, then the operator\'s OpenAI(-compatible) account',
    operatorVisibility: 'plaintext',
    retention: 'Not stored by the app; the provider\'s own retention applies (cloud-operations-security.md §5)',
    activation: 'opt-in-consent',
    activationNote: 'the `ai` consent scope; skipping key setup is not consent',
    byo: 'Add your own OpenAI key and the request goes browser-direct, never through the operator',
    evidence: [
      'internal/cloudserver/trial_proxy.go:99',
      'web/cloud/js/aiclient.js:320',
      'web/domain/settings.js:56',
    ],
    code: { go: ['internal/cloudserver/trial_proxy.go'], hosts: ['api.openai.com'] },
    docSignal: null,
    userCopy: {
      category: 'visible',
      title: 'Trial AI prompts, if you use the operator\'s key',
      detail: 'If you use the shared trial AI instead of your own key, your meal descriptions, workout descriptions and photos pass through the operator\'s OpenAI account to be parsed. This only happens with your explicit consent — you are asked on first use, and can revoke it any time in Settings → Integrations. Add your own key there to keep them off the operator entirely.',
    },
  },
  {
    // med-yor.4 gap 2: the free-text Telegram agent and the Journey narrator
    // share aiClient.chat, so on the trial key BOTH cross the operator —
    // including the vault data the agent's tools read back into the messages.
    id: 'trial-chat',
    feature: 'Trial AI assistant (Telegram free text + tool results)',
    boundary: 'carve-out',
    data: 'The Telegram message you sent, AND the vault data the assistant\'s tools read to answer it (BP history, notes, medications, …), carried back into the conversation as tool results',
    destination: 'The operator\'s server, then the operator\'s OpenAI(-compatible) account',
    operatorVisibility: 'plaintext',
    retention: 'Not stored by the app; provider retention applies',
    activation: 'opt-in-consent',
    activationNote: 'the `tg` consent scope, separate from meal parsing',
    byo: 'With your own OpenAI key the whole loop runs browser-direct',
    evidence: [
      'web/cloud/js/tg-agent.js:120',
      'web/cloud/js/tg-agent.js:137',
      'web/cloud/js/inbox-apply.js:778',
      'web/cloud/js/aiclient.js:434',
    ],
    code: { go: [], hosts: [] },
    docSignal: null,
    userCopy: {
      category: 'visible',
      title: 'Telegram assistant answers, if you use the trial key',
      detail: 'When the Telegram assistant answers you on the trial key, your message AND the health data it reads from your vault to answer — blood pressure history, notes, and the like — transit the operator\'s OpenAI account. This has its own consent, separate from meal parsing, asked on first use and revocable in Settings → Integrations.',
    },
  },
  {
    // Called out separately by the audit. The narrator's own header comment
    // says it goes browser-direct: it does not — it rides the same
    // aiClient.chat trial fallback, under the same `tg` consent scope.
    id: 'gamification-narration',
    feature: 'Journey narration summaries',
    boundary: 'carve-out',
    data: 'Already-computed gamification summaries — streaks, weekly counts, in-range percentages, chapter and experiment state. Never raw records',
    destination: 'Your own OpenAI(-compatible) endpoint, or — with no key of your own — the operator\'s server and the operator\'s OpenAI account',
    operatorVisibility: 'plaintext',
    retention: 'Not stored by the app; provider retention applies',
    activation: 'opt-in-consent',
    activationNote: 'shares the `tg` consent scope with the Telegram assistant; refusal degrades to the deterministic card',
    byo: 'With your own OpenAI key the summary goes browser-direct',
    evidence: [
      'web/cloud/js/gamification-narrator.js:141',
      'web/cloud/js/apishim.js:150',
      'web/cloud/js/aiclient.js:434',
    ],
    code: { go: [], hosts: [] },
    docSignal: null,
    userCopy: {
      category: 'visible',
      title: 'Journey narration, if you turn it on',
      detail: 'The Journey screen can turn its already-computed numbers — streaks, weekly counts, how often you were in range — into a few written sentences. Those summary numbers go to your own AI provider, or, with no key of your own, through the operator\'s trial account under the same consent as the Telegram assistant. Raw records are never sent, and declining just leaves the plain deterministic card in place.',
    },
  },
  {
    id: 'trial-voice',
    feature: 'Trial voice (operator\'s ElevenLabs key)',
    boundary: 'carve-out',
    data: 'Your voice audio, the transcript, and the agent conversation — including tool results read out of your vault',
    destination: 'The operator mints the signed URL, then the operator\'s ElevenLabs account',
    operatorVisibility: 'plaintext',
    retention: 'Not stored by the app; ElevenLabs retention applies',
    activation: 'opt-in-consent',
    activationNote: 'the `voice` consent scope, separate again',
    byo: 'With your own ElevenLabs key the operator is not involved',
    evidence: ['internal/cloudserver/trial_proxy.go:100', 'internal/cloudserver/trial_proxy.go:54'],
    code: { go: ['internal/cloudserver/trial_proxy.go'], hosts: ['api.elevenlabs.io'] },
    docSignal: null,
    userCopy: {
      category: 'visible',
      title: 'Trial voice calls, if you use the operator\'s key',
      detail: 'Trial voice calls run on the operator\'s ElevenLabs account, so your voice audio, its transcript and the agent conversation — including the blood pressure, weight and notes the agent reads back to you — pass through it. This requires your explicit consent: asked on first use, revocable in Settings → Integrations. With your own ElevenLabs key the operator is not involved.',
    },
  },

  // ==========================================================================
  // BYO-key paths — browser-direct, the operator is never in the path.
  // ==========================================================================
  {
    id: 'byo-openai',
    feature: 'AI with your own OpenAI(-compatible) key',
    boundary: 'not-a-carve-out',
    data: 'Meal and activity descriptions, meal photos, Telegram assistant messages and their tool results, Journey narration summaries, plus a health-data-free model-list request when you press "Load models" in Settings',
    destination: 'Your configured endpoint, browser-direct',
    operatorVisibility: 'none',
    retention: 'Whatever your provider does; the operator stores nothing',
    activation: 'no-toggle',
    activationNote: 'whenever you have a key set and use an AI feature, or press "Load models" in Settings',
    byo: 'This IS the BYO path',
    evidence: ['web/cloud/js/aiclient.js:17', 'web/cloud/js/aiclient.js:374', 'web/cloud/js/aiclient.js:139'],
    code: { go: [], hosts: ['api.openai.com'] },
    docSignal: 'Meal descriptions + photos (AI parsing)',
    userCopy: {
      category: 'leaves',
      title: 'AI meal parsing with your own key',
      detail: 'When you use your own OpenAI-compatible key, meal descriptions, photos, workout descriptions and assistant conversations go straight from your browser to that provider — never proxied through the operator. The "Load models" button in Settings uses the same direct connection, and sends no health data at all.',
    },
  },
  {
    // The audit lists ElevenLabs audio / transcripts / tool names / tool
    // RESULTS as an omission: the agent and its client tools are provisioned
    // browser-direct with your vault key, and the tools hand back real vault
    // data (BP, weight, notes) inside the conversation.
    id: 'byo-elevenlabs',
    feature: 'Voice with your own ElevenLabs key',
    boundary: 'not-a-carve-out',
    data: 'Voice audio, transcripts, the tool definitions this app provisions, and the tool RESULTS — the blood pressure, weight and diary notes the agent reads out of your vault',
    destination: 'api.elevenlabs.io, browser-direct',
    operatorVisibility: 'none',
    retention: 'ElevenLabs retains the conversation per your ElevenLabs account settings; the provisioned agent and tool definitions persist in that account until deleted',
    activation: 'no-toggle',
    activationNote: 'whenever you start a voice call with your own key set',
    byo: 'This IS the BYO path',
    evidence: [
      'web/cloud/js/elevenlabs-agent.js:12',
      'web/cloud/js/elevenlabs-agent.js:13',
      'web/cloud/js/elevenlabs-signed-url.js:8',
    ],
    code: { go: [], hosts: ['api.elevenlabs.io'] },
    docSignal: 'Voice audio, transcripts + tool results (ElevenLabs)',
    userCopy: {
      category: 'leaves',
      title: 'Voice calls with your own ElevenLabs key',
      detail: 'A voice call sends your audio to ElevenLabs and gets speech back, so ElevenLabs sees what you say and the transcript of it. It also sees the answers: when you ask about your numbers the app reads them out of your vault and hands them to the agent as tool results, so your blood pressure, weight and notes travel with the conversation. The app also creates an agent and its tools in your ElevenLabs account on first use. All of it goes browser-direct; the operator is not in the path.',
    },
  },
  {
    id: 'food-byo',
    feature: 'Food search with your own food-DB endpoint',
    boundary: 'not-a-carve-out',
    data: 'Search terms and scanned barcodes',
    destination: 'Your configured food-DB endpoint, browser-direct',
    operatorVisibility: 'none',
    retention: 'Whatever your endpoint does',
    activation: 'no-toggle',
    activationNote: 'whenever you search food with your own endpoint set',
    byo: 'This IS the BYO path — setting an endpoint is what removes the operator',
    evidence: ['web/cloud/js/fooddb.js:84', 'web/cloud/js/fooddb.js:88'],
    code: { go: [], hosts: [] },
    docSignal: null,
    // Deliberately no separate in-app item: the `food-operator` copy names both
    // the proxied and the browser-direct path in one place, which is how a user
    // actually needs to read it (which one am I on?).
    userCopy: null,
    userCopyCoveredBy: 'food-operator',
  },

  // ==========================================================================
  // Telegram.
  // ==========================================================================
  {
    id: 'telegram-relay',
    feature: 'Telegram relay',
    boundary: 'carve-out',
    data: 'Outbound reminder and confirmation text the client composes, forwarded verbatim; the opaque medication ids a dose reminder names, stored on its queued row; your chat id',
    destination: 'The operator\'s relay, then api.telegram.org',
    operatorVisibility: 'plaintext',
    retention: 'The queued entry is deleted after sending; Telegram keeps the chat',
    activation: 'opt-in',
    activationNote: 'requires you to link your own bot',
    byo: 'The bot is yours; a chat bot cannot be made end-to-end encrypted',
    evidence: [
      'internal/cloudserver/push.go:215',
      'internal/cloudserver/push.go:229',
      'internal/cloudserver/telegram.go:1',
      'internal/cloudserver/inbox.go:207',
    ],
    code: {
      go: [
        'internal/cloudserver/telegram.go',
        'internal/cloudserver/inbox.go',
        'internal/cloudserver/push.go',
      ],
      hosts: ['t.me'],
    },
    docSignal: 'TG bot token, chat id, TG message text (both directions) in transit',
    userCopy: {
      category: 'visible',
      title: 'Telegram chat + reminders, if you turn them on',
      detail: 'A chat bot cannot be end-to-end encrypted, so text crosses the relay in plain text both ways. Reminders it sends carry the detail you choose — "Medication time" with no names (generic), or the medication named (detailed) — in Settings → Notifications. Messages you send the bot also transit the relay in the clear; the server seals each on arrival, and the RELAY itself never parses it, never calls AI on it, and never logs it. What happens next is your own app\'s doing: an unlocked device opens the message and may hand it to an AI assistant — your own provider, or the operator\'s trial key with your consent (see "Telegram assistant answers" below). Photos are fetched through the server but never stored there. A dose reminder also carries the opaque id numbers of the medications it names, so tapping Confirm records exactly those doses — numbers only, never names, and at "detailed" the message text already spells the names out.',
    },
  },
  {
    id: 'telegram-inbound',
    feature: 'Inbound Telegram message, before sealing',
    boundary: 'carve-out',
    data: 'The text (or file reference) of a message you send the bot, in server memory for the instant it takes to seal it',
    destination: 'The operator\'s relay process',
    operatorVisibility: 'transient',
    retention: 'Never stored unsealed; the sealed copy sits in your inbox until an unlocked device drains it',
    activation: 'opt-in',
    activationNote: 'only if you linked Telegram',
    byo: 'n/a — Telegram delivers bot updates in the clear',
    evidence: ['internal/cloudserver/inbox.go:207'],
    code: { go: [], hosts: [] },
    docSignal: null,
    userCopy: {
      category: 'visible',
      title: 'A Telegram message, briefly, before it is sealed',
      detail: 'Telegram delivers your messages to the bot in the clear, so the relay unavoidably sees an inbound message in memory for the instant it takes to seal it to your account. It is never stored unsealed.',
    },
  },
  {
    id: 'telegram-bot-token',
    feature: 'Telegram bot token at rest',
    boundary: 'carve-out',
    data: 'Your bot token, sealed under a key DERIVED FROM `SESSION_SECRET` — a server holding that secret can recover it. This is not vault-grade',
    destination: 'The operator\'s database',
    operatorVisibility: 'at-rest',
    retention: 'Until you unlink the bot',
    activation: 'opt-in',
    activationNote: 'stored when you link Telegram',
    byo: 'n/a',
    evidence: ['internal/cloudserver/tg_token.go:22', 'internal/cloudserver/tg_token.go:55'],
    code: { go: ['internal/cloudserver/tg_token.go'], hosts: [] },
    docSignal: null,
    userCopy: {
      category: 'visible',
      title: 'Your Telegram bot token, while it is linked',
      detail: 'The token for the bot you created is kept on the server so reminders can be sent while your phone is asleep. Unlike your health data it is sealed with a key the server itself holds, so an operator with database and server access could recover it and post as your bot. Unlink Telegram to remove it.',
    },
  },

  // ==========================================================================
  // MCP (Claude connector).
  // ==========================================================================
  {
    id: 'mcp-hosted',
    feature: 'Hosted MCP (tier 2)',
    boundary: 'carve-out',
    data: 'Full MCP query AND response content, in plaintext in server memory — the operator runs the shim',
    destination: 'The operator, then the hosted AI client (claude.ai / ChatGPT)',
    operatorVisibility: 'plaintext',
    retention: 'Content not stored; the pairing key persists while remote mode is enabled',
    activation: 'opt-in',
    activationNote: 'explicit enable, deleted on Disconnect',
    byo: 'Tier 1 (local shim) gives the same capability over a blind relay',
    evidence: ['internal/cloudserver/mcp_remote.go:253', 'internal/cloudserver/mcp_endpoint.go:1'],
    code: { go: ['internal/cloudserver/mcp_remote.go', 'internal/cloudserver/mcp_endpoint.go'], hosts: [] },
    docSignal: 'MCP query content',
    userCopy: {
      category: 'visible',
      title: 'Claude connector queries (hosted mode only)',
      detail: 'With the local Claude connector, your queries stay sealed end-to-end. Only the opt-in hosted remote mode lets the server see query content in transit; it is off unless you enable it.',
    },
  },
  {
    id: 'mcp-local',
    feature: 'Local MCP (tier 1)',
    boundary: 'not-a-carve-out',
    data: 'Nothing. Frames are opaque; the relay sees sizes, timing and pairing ids only',
    destination: 'A blind WebSocket pipe to your own machine',
    operatorVisibility: 'metadata',
    retention: 'No content retained',
    activation: 'opt-in',
    activationNote: 'pairing with a local shim',
    byo: 'n/a',
    evidence: ['internal/cloudserver/mcp_relay.go:15'],
    code: { go: ['internal/cloudserver/mcp_relay.go'], hosts: [] },
    docSignal: 'MCP frame sizes + timing',
    userCopy: {
      category: 'visible',
      title: 'Claude connector traffic shape',
      detail: 'When the connector is active, the relay sees message sizes and timing and pairing ids — never the content, which stays sealed.',
    },
  },
  {
    id: 'mcp-pairing-key',
    feature: 'Hosted MCP pairing key at rest',
    boundary: 'carve-out',
    data: 'The pairing key, stored server-side while hosted mode is enabled',
    destination: 'The operator\'s database',
    operatorVisibility: 'at-rest',
    retention: 'Deleted on Disconnect; the token itself is never logged',
    activation: 'opt-in',
    activationNote: 'only with hosted mode',
    byo: 'n/a',
    evidence: ['internal/cloudserver/mcp_remote.go:34'],
    code: { go: [], hosts: [] },
    docSignal: 'MCP pairing key at rest (tier 2 only)',
    userCopy: {
      category: 'visible',
      title: 'Hosted connector key (hosted mode only)',
      detail: 'The hosted remote mode stores a pairing key on the server while it is enabled. It is deleted when you disconnect, and the pairing token itself is never logged.',
    },
  },

  // ==========================================================================
  // No-toggle lookups. These have NO enable step — do not describe them as
  // opt-in, and note that RxNav has no BYO alternative at all.
  // ==========================================================================
  {
    id: 'food-operator',
    feature: 'Operator-default food DB',
    boundary: 'carve-out',
    data: 'Food search terms and scanned barcodes, through a same-origin operator proxy — not browser-direct',
    destination: 'The operator, then the operator\'s food-DB instance',
    operatorVisibility: 'plaintext',
    retention: 'Not stored by the app; mind the operator\'s HTTP access logs — the term travels in the query string',
    activation: 'no-toggle',
    activationNote: 'whenever you search food without a food-DB endpoint of your own',
    byo: 'Set your own endpoint in Settings → Integrations and the operator leaves the path entirely',
    evidence: ['internal/cloudserver/food_proxy.go:48', 'internal/cloudserver/food_proxy.go:49'],
    code: { go: ['internal/cloudserver/food_proxy.go', 'internal/cloudserver/proxy_upstream.go'], hosts: [] },
    docSignal: 'Food/barcode search terms',
    userCopy: {
      category: 'visible',
      title: 'Food and barcode searches',
      detail: 'Unless you set your own food database in Settings → Integrations, searches and scanned barcodes go through the operator\'s server to the operator\'s food database — so the operator sees the search term in transit (the same exposure as searching a public food catalogue). There is no switch that turns this off; setting your own endpoint is what removes the operator, and then the query goes from your browser straight there instead.',
    },
  },
  {
    id: 'rxnav',
    feature: 'Drug lookups (RxNav)',
    boundary: 'carve-out',
    data: 'Drug-name and interaction queries, through a blind same-origin proxy',
    destination: 'The operator in transit, then RxNav (NIH)',
    operatorVisibility: 'plaintext',
    retention: 'Never logged or stored by the application; only the resolved rxcui lands on the medication record. Mind the reverse proxy\'s access logs — the name travels in the query string',
    activation: 'no-toggle',
    activationNote: 'whenever a medication lookup or interaction check runs',
    byo: 'None — there is no BYO alternative for drug lookups',
    evidence: ['internal/cloudserver/rxnav_proxy.go:56', 'internal/cloudserver/rxnav_proxy.go:59'],
    code: {
      // proxy_upstream.go is the shared blind forwarder both same-origin
      // proxies route through, so both entries claim it.
      go: ['internal/cloudserver/rxnav_proxy.go', 'internal/cloudserver/proxy_upstream.go'],
      hosts: ['rxnav.nlm.nih.gov', 'lhncbc.nlm.nih.gov'],
    },
    docSignal: 'Drug-name search + interaction queries',
    userCopy: {
      category: 'visible',
      title: 'Drug-name and interaction lookups',
      detail: 'Drug searches and interaction checks are relayed through the operator\'s server to RxNav (NIH) — the server can see the drug name in transit but is blind by design: the application never logs or stores the query. Only the resolved drug id is kept on the medication record. There is no toggle for this, and no way to point it at a service of your own.',
    },
  },

  // ==========================================================================
  // Server-side plaintext that is not egress at all.
  // ==========================================================================
  {
    // Found while sweeping for undisclosed paths (med-yor.4): a Mi Band .nxk
    // backup is parsed SERVER-SIDE — written to a temp file and read as
    // plaintext health data — before being sealed to the account inbox. Same
    // trust model as the Telegram inbound path, but it was disclosed nowhere.
    id: 'nxk-import',
    feature: 'Mi Band (.nxk) backup import',
    boundary: 'carve-out',
    data: 'The whole backup — heart rate, SpO2, stress, sleep, steps, workout history — written to a temporary file on the operator\'s disk and parsed in plaintext before it is sealed',
    destination: 'The operator\'s server process and its temp directory. Nothing is sent onward',
    operatorVisibility: 'transient',
    retention: 'The temp file is deleted when the request finishes; only sealed events are stored. Refused outright when no unlocked device has published an inbox key',
    activation: 'user-initiated',
    activationNote: 'when you upload a backup, in the app or to the Telegram bot',
    byo: 'n/a — the parser needs the raw file',
    evidence: [
      'internal/cloudserver/vitals_import_api.go:42',
      'internal/cloudserver/vitals_import_api.go:86',
      'internal/cloudserver/telegram.go:1137',
    ],
    code: {
      go: [
        'internal/cloudserver/vitals_import_api.go',
        'internal/cloudserver/vitals_import.go',
      ],
      hosts: [],
    },
    docSignal: 'Mi Band .nxk backup contents (transient, server-side)',
    userCopy: {
      category: 'visible',
      title: 'A Mi Band backup you upload, while it is being read',
      detail: 'Importing a Mi Band .nxk backup is the one place the server opens health data itself: the file is written to a temporary file, parsed, and the results sealed to your account for an unlocked device to pick up. For the length of that request the operator can see the whole backup — heart rate, sleep, steps, workouts. The temporary file is deleted when the request finishes, nothing is sent to a third party, and the upload is refused outright if no device of yours has published a key to seal to. It only ever happens when you upload a backup.',
    },
  },
  {
    id: 'feedback',
    feature: 'In-app feedback',
    boundary: 'not-a-carve-out',
    data: 'What you type, plus any screenshot or voice note you attach — age-encrypted in your browser to the developer\'s public key',
    destination: 'The operator stores the ciphertext blindly; the developer decrypts it offline',
    operatorVisibility: 'ciphertext',
    retention: 'Queued until the developer drains it; the app version and feedback kind travel as plaintext metadata',
    activation: 'user-initiated',
    activationNote: 'when you send feedback from inside the app',
    byo: 'n/a',
    evidence: ['web/cloud/js/feedback-submit.js:10', 'internal/cloudserver/feedback.go:39'],
    code: { go: ['internal/cloudserver/feedback.go'], hosts: [] },
    docSignal: null,
    userCopy: {
      // Deliberately 'visible', not 'leaves': the upload goes TO the operator
      // (blindly, as ciphertext) — it is not one of the browser-direct
      // third-party calls that section promises. Caught by codex review.
      category: 'visible',
      title: 'Feedback you send from inside the app',
      detail: 'Feedback sent from the app is encrypted in your browser to the developer\'s key before it is uploaded, so the operator stores it without being able to read it — but the developer can, including any screenshot or voice note you attach. It carries no account id. Only what you type and attach is sent; the app version and the kind of feedback travel unencrypted so the operator knows something arrived. Feedback sent to the Telegram bot instead is a different path — see below.',
    },
  },
  {
    // Caught by codex review on this bead: the Telegram feedback channel is NOT
    // the browser-encrypted path. The manager bot receives the message in the
    // clear, the SERVER builds the plaintext feedbackDoc and downloads the
    // attachment bytes, encrypts it server-side, and then copies the original
    // message into the developer's admin chat in full.
    id: 'feedback-telegram',
    feature: 'Feedback sent to the Telegram bot',
    boundary: 'carve-out',
    data: 'Your message text and any voice note or screenshot, in plaintext on the operator\'s server; the original message is then copied verbatim into the developer\'s Telegram admin chat',
    destination: 'The operator\'s server (plaintext), Telegram, and the developer\'s admin chat. The queued copy is encrypted server-side to the developer\'s key',
    operatorVisibility: 'plaintext',
    retention: 'The admin-chat copy stays in that Telegram chat; the queued ciphertext waits until the developer drains it',
    activation: 'user-initiated',
    activationNote: 'when you tap "Send feedback" in the manager bot and send the next message',
    byo: 'n/a — use the in-app feedback form for the browser-encrypted path',
    evidence: [
      'internal/cloudserver/feedback_telegram.go:168',
      'internal/cloudserver/feedback_telegram.go:185',
      'internal/cloudserver/feedback_telegram.go:280',
    ],
    code: { go: ['internal/cloudserver/feedback_telegram.go'], hosts: [] },
    docSignal: null,
    userCopy: {
      category: 'visible',
      title: 'Feedback you send to the Telegram bot',
      detail: 'Sending feedback through the bot is not the same as sending it from inside the app. Telegram delivers it in the clear, the server reads your text and downloads any voice note or screenshot to package it, and it then copies your original message straight into the developer\'s Telegram chat — so both the operator and the developer see the contents. Your name is not attached, but nothing about this path is encrypted before it reaches the server. Use the in-app feedback form if you would rather the operator could not read it.',
    },
  },
];

// --- doc generation --------------------------------------------------------

const HEADER = [
  'Boundary',
  'What leaves the vault',
  'Who sees it',
  'Retention',
  'How it is turned on',
  'If you bring your own key',
  'Evidence',
];

function activationCell(entry) {
  const base = `**${ACTIVATION[entry.activation]}**`;
  return entry.activationNote ? `${base} — ${entry.activationNote}` : base;
}

function seenCell(entry) {
  return `${entry.destination}. Operator sees: ${OPERATOR_VISIBILITY[entry.operatorVisibility]}`;
}

function evidenceCell(entry) {
  return entry.evidence.map((e) => `\`${e}\``).join(', ');
}

// renderBoundaryTable emits the markdown block that lives between the GENERATED
// markers in docs/cloud-mode.md. scripts/gen-privacy-docs.mjs writes it;
// architecture.privacy-claims.test.js asserts the committed doc still matches.
export function renderBoundaryTable() {
  const rows = PRIVACY_MANIFEST.map((e) => [
    `**${e.feature}**${BOUNDARY[e.boundary]}`,
    e.data,
    seenCell(e),
    e.retention,
    activationCell(e),
    e.byo,
    evidenceCell(e),
  ]);
  return [
    `| ${HEADER.join(' | ')} |`,
    `|${HEADER.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

export const GENERATED_BEGIN = '<!-- BEGIN GENERATED privacy-boundary-table — source: web/cloud/js/privacy-manifest.js, regenerate: pnpm privacy:docs -->';
export const GENERATED_END = '<!-- END GENERATED privacy-boundary-table -->';
