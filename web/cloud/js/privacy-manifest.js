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
//     PRIVACY_ITEMS from every non-local entry's `userCopy`. Rows with
//     `mode: 'local'` (on-device mode in the iPhone and Android apps, no account) are not a cloud account's,
//     so they are disclosed in the generated doc table only.
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
    activationNote: 'the default and only storage path for a cloud account (on-device mode in the iPhone and Android apps keeps the records on the phone instead — see the local-mode rows)',
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
    destination: 'Nowhere through the app. In the iPhone app the phone\'s own device backup (iCloud or a computer) can include it, under Apple\'s security model',
    operatorVisibility: 'none',
    retention: 'Until you sign out, delete the account, or clear site data on that browser; there is no idle auto-lock',
    activation: 'on-device',
    activationNote: 'the app renders offline, which requires a local plaintext copy',
    byo: 'n/a',
    evidence: ['web/cloud/js/sync.js:211', 'web/cloud/js/unlock.js:343', 'web/cloud/js/unlock.js:450'],
    code: { go: [], hosts: [] },
    docSignal: null,
    userCopy: {
      category: 'device',
      title: 'A readable copy lives on this device',
      detail: 'So the app works offline, your records are decrypted and kept in this browser\'s storage, and once a device is unlocked it stays unlocked — reopening the app does not ask for your passkey again, and there is no idle auto-lock. That is convenient on your own phone and a real risk on a shared or borrowed computer: anyone who can open this browser profile can read everything. Sign out or delete the account to clear it, and think twice before unlocking on a machine you do not control. In the iPhone app the phone\'s own backup (iCloud or a computer) can include this copy, protected the way Apple protects that backup.',
    },
  },

  // ==========================================================================
  // Operational metadata — always on, inherent to running the service.
  // ==========================================================================
  {
    id: 'push-relay',
    feature: 'Push reminder relay',
    boundary: 'not-a-carve-out',
    data: 'The time a reminder fires — plus, if you linked Telegram, the time a message you send the bot arrives, and the time a new device claims your add-device code, each of which fires a content-free wake — and an opaque blob; a reminder payload is app-layer encrypted under the push key on top of RFC 8291',
    destination: 'The operator\'s queue, then your browser vendor\'s push service (FCM / APNs / Mozilla)',
    operatorVisibility: 'ciphertext',
    retention: 'The queue entry is deleted once sent; the subscription endpoint persists until you disable push',
    activation: 'opt-in',
    activationNote: 'you grant notification permission',
    byo: 'n/a',
    evidence: ['internal/cloudserver/push.go:215', 'internal/cloudserver/relay.go:88', 'internal/cloudserver/relay.go:384'],
    code: {
      go: ['internal/cloudserver/relay.go', 'internal/cloudserver/push.go'],
      hosts: [],
    },
    docSignal: 'Reminder timing',
    userCopy: {
      category: 'visible',
      title: 'When your reminders fire',
      detail: 'A reminder is a blind alarm clock: the server knows a reminder is due at a time, but its content stays sealed. Your push subscription endpoint also tells the operator which browser vendor you use, and that vendor sees the ciphertext and its timing. Sending your bot a message also fires a wake push carrying no text at all, so an open tab records it immediately — that timing reaches your push vendor too. A new device claiming your add-device code fires one more, asking you to come back and approve it.',
    },
  },
  {
    id: 'native-push',
    feature: 'Native app push wake',
    boundary: 'carve-out',
    data: 'A push token for this phone (a stable per-install identifier issued by Apple or Google), stored next to your account; the fact that the operator pushed a content-free wake to it at a given time',
    destination: 'The operator\'s relay, then Apple (APNs) or Google (FCM)',
    operatorVisibility: 'metadata',
    retention: 'Until you leave the account, switch account, or the platform reports the token dead',
    activation: 'opt-in',
    activationNote: 'when you allow notifications in the iPhone or Android app with an account; the iPhone app does not register yet',
    byo: 'n/a',
    evidence: ['internal/cloudserver/relay.go:461', 'internal/cloudserver/nativepush.go:45'],
    code: {
      go: ['internal/cloudserver/nativepush.go'],
      hosts: ['api.push.apple.com', 'api.sandbox.push.apple.com', 'fcm.googleapis.com', 'oauth2.googleapis.com'],
    },
    docSignal: 'Native push token',
    userCopy: {
      category: 'visible',
      title: 'Wake-ups for the phone app',
      detail: 'The phone app can be woken by a notification whose text is a fixed line ("Open the app to record what you sent" or "Open the app to keep reminders running"), never your data. The operator stores your phone\'s push token and knows when a wake was sent; Apple or Google see only that a notification went to your phone. Today only the Android app registers; the iPhone app does not yet.',
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
    // med-r1j2.1: the add-a-device hand-off (protocol v2) sends a coarse
    // platform label so the origin can say "<platform> wants to join"; it is
    // kept on the enrolled credential for the devices list. Enum only — no
    // device name, model or user agent.
    id: 'device-platform-label',
    feature: 'Device platform label',
    boundary: 'carve-out',
    data: 'Whether a device you added with a code is a web browser, an Android phone or an iPhone (`web` / `android` / `ios`) — never its name, model or browser',
    destination: 'The operator, stored with that device\'s passkey record',
    operatorVisibility: 'metadata',
    retention: 'Until you remove that device; the hand-off slot carrying it is deleted within ten minutes',
    activation: 'user-initiated',
    activationNote: 'only when you add a device with a code from another device',
    byo: 'n/a',
    evidence: ['internal/cloudserver/transfer.go:42', 'internal/cloudserver/device.go:47'],
    code: { go: [], hosts: [] },
    docSignal: 'Device platform label',
    userCopy: {
      category: 'visible',
      title: 'What kind of device you added',
      detail: 'When you add a device with a code, the operator records whether it is a web browser, an Android phone or an iPhone, so your devices list can tell them apart. Nothing more specific — no device name, model or browser version.',
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
  {
    // med-1yi5.3: the blind workout-share short link (plans; gyms since
    // med-8j5w.3 — same route, same construction). The ciphertext
    // crosses the operator (stored 30 days, served to whoever opens the
    // link) but the AES key rides only in the URL fragment, which no server
    // ever sees — so this is filed as not-a-carve-out with ciphertext
    // visibility, and the metadata the operator does learn (ciphertext size,
    // which account minted the link, which account/IP resolved it and when)
    // is the docSignal row in the cloud-mode.md leakage summary. The resolve
    // fetch omits credentials (the route is unauthenticated), but the request
    // Host still identifies the resolving account — that is disclosed, not
    // hidden.
    id: 'workout-share-link',
    feature: 'Workout plan and gym share links',
    boundary: 'not-a-carve-out',
    data: 'The encrypted workout plan or gym equipment list (ciphertext only — the key never leaves the link fragment)',
    destination: "The operator's share-link store, served back to anyone who opens the link",
    operatorVisibility: 'ciphertext',
    retention: '30 days, then deleted (also deleted with the account)',
    activation: 'user-initiated',
    activationNote: 'when you tap Share on a workout plan or a gym',
    byo: 'n/a',
    evidence: ['web/static/js/features/workout/share.js:257', 'internal/cloudserver/share.go:174'],
    code: { go: ['internal/cloudserver/share.go'], hosts: [] },
    docSignal: 'Share-link ciphertext size + minting account + resolver account/IP/time',
    userCopy: {
      category: 'visible',
      title: 'Workout plans and gyms you share by link',
      detail: 'When you share a workout plan or a gym by link, it is encrypted in your browser under a key that rides only in the link fragment; the operator stores the ciphertext for 30 days and can see that you created a share, never what is in it. Opening a link inside the app reaches the operator from your own account address, so the operator can also tell which account opened which share, and when.',
    },
  },
  {
    // med-ta2n.10 (owner accepted the carve-out, med-ta2n epic notes): the
    // invite landing's "Get the app for Android" opens Google Play with the
    // whole invite URL — claim token included — as the install referrer, so
    // the freshly installed app can sign in on first launch. The App Store
    // link carries no invite. Before the account exists, so no vault data.
    id: 'invite-play-referrer',
    feature: 'Invite link → "Get the app" on Android (Play install referrer)',
    boundary: 'carve-out',
    data: 'The invite link itself, including its one-time claim token (no health data — the account is still empty)',
    destination: 'Google Play, browser-direct, which hands it to the Med Tracker app on its first launch',
    operatorVisibility: 'none',
    retention: 'Per Google Play\'s own policy; the token stops working once the invite is claimed or expires (14 days by default, CLOUD_CLAIM_TTL)',
    activation: 'user-initiated',
    activationNote: 'only when you tap "Get the app for Android" on an invite page; iPhone and "Continue in the browser" send nothing to a store',
    byo: 'n/a — tap "Continue in the browser", or install the app first and paste the invite in it',
    evidence: ['web/cloud/js/invite-landing.js:93', 'web/cloud/js/invite-landing.js:83', 'web/cloud/js/invite-landing.js:189'],
    code: { go: [], hosts: ['play.google.com', 'apps.apple.com'] },
    docSignal: null,
    userCopy: {
      category: 'leaves',
      title: 'Invite links opened on Android',
      detail: 'When you open an invite on an Android phone and tap "Get the app for Android", the invite link — with its one-time sign-in token — goes to Google Play, so the app can pick up your invite the first time it opens. It carries no health data, and the token stops working once the invite is used or expires. "Continue in the browser" and the iPhone App Store link send nothing to a store.',
    },
  },

  // ==========================================================================
  // Operator-trial provider keys — plaintext through the operator, by design.
  // ==========================================================================
  {
    id: 'trial-ai',
    feature: 'Trial AI (operator\'s AI key)',
    boundary: 'carve-out',
    data: 'The meal or activity description you typed, meal PHOTOS, and exercise NAMES you ask it to tag by muscle group, in plaintext; an explicit trial Check key sends only a tiny health-data-free sample prompt',
    destination: 'The operator\'s server, then the operator\'s AI provider account (OpenAI or Anthropic, the operator\'s choice)',
    operatorVisibility: 'plaintext',
    retention: 'Not stored by the app; the provider\'s own retention applies (cloud-operations-security.md §5)',
    activation: 'opt-in-consent',
    activationNote: 'the `ai` consent scope; skipping key setup is not consent',
    byo: 'Add your own OpenAI key and the request goes browser-direct, never through the operator',
    evidence: [
      'internal/cloudserver/trial_proxy.go:104',
      'web/cloud/js/aiclient.js:321',
      'web/cloud/js/aiclient.js:550',
      'web/cloud/js/aiclient.js:612',
      'web/domain/settings.js:56',
    ],
    code: { go: ['internal/cloudserver/trial_proxy.go', 'internal/cloudserver/trial_anthropic.go'], hosts: ['api.openai.com', 'api.anthropic.com'] },
    docSignal: null,
    userCopy: {
      category: 'visible',
      title: 'Trial AI prompts, if you use the operator\'s key',
      detail: 'If you use the shared trial AI instead of your own key, your meal descriptions, workout descriptions, photos and the exercise names you ask it to tag by muscle group pass through the operator\'s AI provider account (OpenAI or Anthropic, the operator\'s choice) to be parsed. This only happens with your explicit consent — you are asked on first use, and can revoke it any time in Settings → Integrations. An explicit trial Check key sends only a tiny sample prompt, under the same consent and trial allowance. Add your own key there to keep health data off the operator entirely.',
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
    destination: 'The operator\'s server, then the operator\'s AI provider account (OpenAI or Anthropic, the operator\'s choice)',
    operatorVisibility: 'plaintext',
    retention: 'Not stored by the app; provider retention applies',
    activation: 'opt-in-consent',
    activationNote: 'the `tg` consent scope, separate from meal parsing',
    byo: 'With your own OpenAI key the whole loop runs browser-direct',
    evidence: [
      'web/cloud/js/tg-agent.js:120',
      'web/cloud/js/tg-agent.js:137',
      'web/cloud/js/inbox-apply.js:778',
      'web/cloud/js/aiclient.js:584',
    ],
    code: { go: [], hosts: [] },
    docSignal: null,
    userCopy: {
      category: 'visible',
      title: 'Telegram assistant answers, if you use the trial key',
      detail: 'When the Telegram assistant answers you on the trial key, your message AND the health data it reads from your vault to answer — blood pressure history, notes, and the like — transit the operator\'s AI provider account (OpenAI or Anthropic, the operator\'s choice). This has its own consent, separate from meal parsing, asked on first use and revocable in Settings → Integrations.',
    },
  },
  {
    // Called out separately by the audit. The narrator's own header comment
    // says it goes browser-direct: it does not — it rides the same
    // aiClient.chat trial fallback, under the same `tg` consent scope.
    id: 'gamification-narration',
    feature: 'Journey narration summaries',
    boundary: 'carve-out',
    data: 'Already-computed summaries — the weekly recap\'s weight-goal progress (goal direction, share of the way there, trend change and distance in kg, weigh-in days, milestones reached), workouts done vs scheduled, the week\'s BP mean vs target and days measured, and the chosen next-week intention; plus workout stats, chapter and experiment state, and revealed discoveries and experiment verdicts as their card text — which for the goal probes and goal-lever trials includes a weight-trend change in kg (per week, or per weigh-in step). Never raw records, dates or body weight',
    destination: 'Your own OpenAI(-compatible) endpoint, or — with no key of your own — the operator\'s server and the operator\'s AI provider account (OpenAI or Anthropic, the operator\'s choice)',
    operatorVisibility: 'plaintext',
    retention: 'Not stored by the app; provider retention applies',
    activation: 'opt-in-consent',
    activationNote: 'shares the `tg` consent scope with the Telegram assistant; refusal degrades to the deterministic card',
    byo: 'With your own OpenAI key the summary goes browser-direct',
    evidence: [
      'web/cloud/js/gamification-narrator.js:68',
      'web/cloud/js/gamification-narrator.js:177',
      'web/cloud/js/apishim.js:1264',
      'web/cloud/js/aiclient.js:584',
    ],
    code: { go: [], hosts: [] },
    docSignal: null,
    userCopy: {
      category: 'visible',
      title: 'Journey narration, if you turn it on',
      detail: 'The Journey screen can turn its already-computed numbers into a few written sentences — for the weekly recap, your weight-goal progress (how far along you are, the week\'s trend change and remaining distance in kg, weigh-in days, milestones), workouts done vs scheduled, your week\'s average blood pressure vs your target, and the intention you picked for next week; experiment suggestions also carry your revealed discoveries and trial results as written, which can include how your weight trend moved in kg per week. Those summary numbers go to your own AI provider, or, with no key of your own, through the operator\'s trial account under the same consent as the Telegram assistant. Raw records are never sent, and declining just leaves the plain deterministic card in place.',
    },
  },
  {
    id: 'trial-voice',
    feature: 'Trial voice (operator\'s ElevenLabs key)',
    boundary: 'carve-out',
    data: 'Your voice audio, the transcript, and the agent conversation — including tool results read out of your vault, which can be any part of your health record. The agent\'s answers are written by the operator\'s trial AI account (see the voice-llm-relay row), which receives the same conversation. A photo you send during the call does not go to ElevenLabs: your browser keeps it in memory for one turn and sends it with that turn to the AI that answers the call — with no AI key of your own, through the operator\'s trial AI proxy to the trial vision model',
    destination: 'The operator mints the signed URL, then the operator\'s ElevenLabs account; the answers come from the operator\'s trial AI account. Call photos: browser → the operator\'s trial AI proxy (in transit only, like trial text turns) → the trial vision model; never ElevenLabs, never the voice relay socket',
    operatorVisibility: 'plaintext',
    retention: 'Not stored by the app; ElevenLabs retention applies. A call photo lives only in the call tab\'s memory until the next turn is sent or the call ends; the trial proxy neither stores nor logs it',
    activation: 'opt-in-consent',
    activationNote: 'the `voice` consent scope, separate again',
    byo: 'With your own ElevenLabs key the operator does not mint the signed URL or see the audio; the answer relay still applies (voice-llm-relay). With your own AI key a call photo goes browser-direct to that provider (byo-openai)',
    evidence: [
      'internal/cloudserver/trial_proxy.go:167',
      'internal/cloudserver/trial_proxy.go:57',
      'web/static/js/features/elevenlabs-call.js:881',
      'web/cloud/js/voice-llm-responder.js:114',
      'web/cloud/js/voice-llm-responder.js:53',
    ],
    code: { go: ['internal/cloudserver/trial_proxy.go'], hosts: ['api.elevenlabs.io'] },
    docSignal: null,
    userCopy: {
      category: 'visible',
      title: 'Trial voice calls, if you use the operator\'s key',
      detail: 'Trial voice calls run on the operator\'s ElevenLabs account, so your voice audio, its transcript and the agent conversation pass through it, and the agent can reach your whole health record, so anything you ask it about (blood pressure, weight, workouts, medications, food, sleep, notes) is read out of your vault and travels with the conversation. The agent\'s answers are written by the operator\'s trial AI account (the same provider as the trial AI), which receives the whole conversation and those tool results, relayed through the operator\'s server. This requires your explicit consent: asked on first use, revocable in Settings → Integrations. With your own ElevenLabs key the signed URL and the ElevenLabs account are yours, but the answers still relay through the operator\'s server (see the voice-LLM relay). A photo you send during a call never goes to ElevenLabs: your browser holds it in memory and sends it with the next turn to the AI answering the call — your own provider if you set an AI key, otherwise through the operator\'s trial AI proxy, which sees it in transit and neither stores nor logs it.',
    },
  },

  {
    id: 'voice-llm-relay',
    feature: 'Voice agent\'s answers pass through the operator\'s server',
    boundary: 'carve-out',
    data: 'Each voice turn ElevenLabs sends to be answered: the transcript so far, the tool results the agent read from your vault (any part of your health record), and the agent\'s instructions. A photo you send during the call does not cross it: your browser adds it to the turn after the relay hands that turn over',
    destination: 'The operator\'s server in transit only, then your browser, then your own AI provider (BYO key) or the operator\'s trial AI account (no key)',
    operatorVisibility: 'plaintext',
    retention: 'Not stored and not logged beyond account, call fingerprint, byte counts, duration, time-to-first-chunk and outcome',
    activation: 'no-toggle',
    activationNote: 'whenever a voice call runs; trial users already consented via the `voice` scope, with your own AI key there is no extra prompt; with only an ElevenLabs key (no AI key) the call asks for the `voice` consent first, because the trial AI answers',
    byo: 'Your AI key never leaves your browser; the relay cannot be end-to-end encrypted because ElevenLabs is the sender and speaks plaintext',
    evidence: [
      'internal/cloudserver/voice_llm_relay.go:44',
      'internal/cloudserver/voice_llm_relay.go:153',
      'internal/cloudserver/voice_llm_relay.go:575',
      'web/cloud/js/voice-llm-responder.js:72',
    ],
    code: { go: ['internal/cloudserver/voice_llm_relay.go'], hosts: [] },
    docSignal: null,
    userCopy: {
      category: 'visible',
      title: 'Voice agent answers pass through the operator\'s server',
      detail: 'The voice agent\'s replies are written by an AI model, not by ElevenLabs. For every turn ElevenLabs sends the conversation so far, the tool results read from your vault and the agent\'s instructions to the operator\'s server, which passes them in transit to your unlocked browser; your browser calls your own AI provider (or, if you have no AI key of your own, the operator\'s trial AI account, which asks for your voice consent first) and streams the answer back. The operator\'s server can see that content while it passes through, because ElevenLabs sends it in plaintext and it cannot be end-to-end encrypted; it is never stored, and logs keep only sizes and timings. A photo you send during the call never crosses this relay: your browser adds it to the turn itself. Your own AI key never leaves your browser.',
    },
  },

  // ==========================================================================
  // BYO-key paths — browser-direct, the operator is never in the path.
  // ==========================================================================
  {
    id: 'byo-openai',
    feature: 'AI with your own OpenAI(-compatible) key',
    boundary: 'not-a-carve-out',
    data: 'Meal and activity descriptions, meal photos, photos you send during a voice call, exercise names you ask it to tag by muscle group, Telegram assistant messages and their tool results, Journey narration summaries, plus health-data-free model-list and tiny Check key requests in Settings',
    destination: 'Your configured endpoint, browser-direct',
    operatorVisibility: 'none',
    retention: 'Whatever your provider does; the operator stores nothing',
    activation: 'no-toggle',
    activationNote: 'whenever you have a key set and use an AI feature, press "Load models", or explicitly press "Check key" with a permitted draft/saved provider key in Settings',
    byo: 'This IS the BYO path',
    evidence: ['web/cloud/js/aiclient.js:18', 'web/cloud/js/aiclient.js:612', 'web/cloud/js/aiclient.js:738', 'web/cloud/js/aiclient.js:764'],
    code: { go: [], hosts: ['api.openai.com'] },
    docSignal: 'Meal descriptions + photos (AI parsing)',
    userCopy: {
      category: 'leaves',
      title: 'AI meal parsing with your own key',
      detail: 'When you use your own OpenAI-compatible key, meal descriptions, photos (including photos you send during a voice call), workout descriptions, exercise names you ask it to tag and assistant conversations go straight from your browser to that provider — never proxied through the operator. Model Choose and Check key in Settings use the same direct connection without health data. Check key makes one tiny completion request with the selected draft or saved key, saves no settings, and may incur a small provider charge.',
    },
  },
  {
    // The audit lists ElevenLabs audio / transcripts / tool names / tool
    // RESULTS as an omission: the agent and its client tools are provisioned
    // browser-direct with your vault key, and the tools hand back real vault
    // data inside the conversation — and since med-eas.82 the agent's tool set
    // reaches the whole operation catalog, not a fixed handful of domains.
    id: 'byo-elevenlabs',
    feature: 'Voice with your own ElevenLabs key',
    boundary: 'not-a-carve-out',
    data: 'Voice audio, transcripts, the tool definitions this app provisions, and the tool RESULTS — the agent can call any operation in the app catalog, so any part of your health record it is asked about (blood pressure, weight, workouts, medications, food, sleep, diary notes) is read out of your vault into the conversation',
    destination: 'api.elevenlabs.io, browser-direct; the agent\'s answers are relayed through the operator\'s server (see the voice-llm-relay row): the operator sees those turns in transit, but never the audio',
    operatorVisibility: 'plaintext',
    retention: 'ElevenLabs retains the conversation per your ElevenLabs account settings; the provisioned agent and tool definitions persist in that account until deleted',
    activation: 'no-toggle',
    activationNote: 'whenever you start a voice call with your own key set',
    byo: 'This IS the BYO path for audio and tools; the LLM leg relays through the operator\'s server in transit (voice-llm-relay)',
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
      detail: 'A voice call sends your audio to ElevenLabs and gets speech back, so ElevenLabs sees what you say and the transcript of it. It also sees the answers: when you ask about your numbers the app reads them out of your vault and hands them to the agent as tool results. The agent can reach the full set of operations this app exposes, so whichever part of your health record you ask about — blood pressure, weight, workouts, medications, food, sleep, diary notes — travels with the conversation. The app also creates an agent and its tools in your ElevenLabs account on first use. Audio, transcripts and tool calls go browser-direct. The agent\'s answers are the exception: ElevenLabs sends each turn (the transcript so far, tool results and the agent\'s instructions) to the operator\'s server, which passes it in transit to your browser; your browser asks your own AI provider (or, with no AI key set, the operator\'s trial AI account, after asking for your voice consent) and streams the reply back. The operator\'s server does not store or log that content, and your AI key never leaves your browser.',
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
    retention: 'Reminder text is erased from the queued entry when it is sent; the medication ids and dose-slot key stay on the sent row for 48 hours so a later Confirm tap still resolves, then are erased; Telegram keeps the chat',
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
      'internal/cloudserver/telegram.go:1147',
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
  {
    // bd med-ta2n.14: "Request an invite" — the in-app email form (on-device
    // mode's Settings → Sync & backup) and the manager bot's "yes" both file a
    // request the admin approves in Telegram; an approved email request is
    // mailed the claim link through the operator's SMTP relay.
    id: 'invite-request',
    feature: 'Invite requests (email form or the Telegram bot)',
    boundary: 'carve-out',
    data: 'Your email address and optional note (email form), or your Telegram chat and user id (bot); the admin\'s ping shows the address and note, or your Telegram name, @username and id. On approval, the invite email — the claim link — goes to that address. Your IP address is used in memory only to limit how often requests are sent, and is not stored',
    destination: 'The operator\'s server (plaintext), the admin\'s Telegram chat, and — for an approved email request — the operator\'s SMTP relay and your mail provider',
    operatorVisibility: 'plaintext',
    retention: 'The request row (address and note or Telegram ids, decision) is deleted 90 days after it was made; the admin-chat ping stays in that Telegram chat; the sent email is kept per the SMTP relay\'s and your mail provider\'s own policy',
    activation: 'user-initiated',
    activationNote: 'only when you send the form or answer "yes" to the bot, and only if the operator has turned requests on',
    byo: 'n/a — or skip it: an invite link someone sends you needs no request',
    evidence: [
      'internal/cloudserver/invite_request.go:97',
      'internal/cloudserver/invite_request.go:216',
      'internal/cloudserver/invite_request.go:362',
      'internal/cloudserver/mailer.go:79',
    ],
    code: { go: ['internal/cloudserver/invite_request.go', 'internal/cloudserver/mailer.go'], hosts: [] },
    docSignal: null,
    userCopy: {
      category: 'visible',
      title: 'An invite request, if you send one',
      detail: 'Asking for an invite — from the app\'s "Request an invite" form or by answering "yes" to the Telegram bot — sends the operator your email address and note (or your Telegram name, @username and id) in the clear, and the admin sees them in Telegram to approve or decline. If an emailed request is approved, the invite link is sent to that address through the operator\'s mail relay, so the relay and your mail provider see the email. Nothing from your records is sent. The request is deleted after 90 days. Your IP address is used only in memory, to limit how often requests can be sent, and is never stored.',
    },
  },

  // ==========================================================================
  // On-device mode (bd med-o7zq.3; Android bd med-nt9p.32): the "Only on this
  // device" app on iPhone and Android — no account, no server. The free trial
  // rows use App Attest on iPhone and Play Integrity on Android. `mode: 'local'` keeps these rows out of the cloud
  // app's "What can the operator see?" page (privacy.js); the generated doc
  // table carries them.
  // ==========================================================================
  {
    id: 'local-records',
    mode: 'local',
    feature: 'On-device mode (iPhone and Android apps) — your records on the phone',
    boundary: 'on-device',
    data: 'Every record you keep, plus your provider keys and settings (BYOK AI, food database), readable in the app\'s on-device storage',
    destination: 'Nowhere through the app. The phone\'s own backup can include it — iCloud or a computer on iPhone, under Apple\'s security model; on Android, Google\'s backup (only when the phone encrypts it, e.g. with the screen lock) and device-to-device transfer, under Google\'s security model. Google\'s cloud backup skips any app over 25 MB, so export a backup file to keep a copy. Only the on-device records are in the Android backup — never a cloud account\'s data',
    operatorVisibility: 'none',
    retention: 'Until you delete the app or its data; a device backup keeps its copy per Apple\'s or Google\'s backup retention',
    activation: 'on-device',
    activationNote: 'you chose "Only on this device"; there is no account and no sync',
    byo: 'n/a',
    evidence: ['web/cloud/js/local-boot.js:1', 'web/cloud/js/sync.js:1524', 'ios/App/LocalOrigin.swift:125', 'android/app/src/main/AndroidManifest.xml:35', 'android/app/src/main/res/xml/data_extraction_rules.xml:10'],
    code: { go: [], hosts: [] },
    docSignal: null,
    userCopy: {
      category: 'device',
      title: 'On-device mode: your records live on this phone',
      detail: 'In on-device mode there is no account and nothing is synced: your records, provider keys and settings are stored readable in the app on this phone, protected by the phone\'s lock. The phone\'s own backup can include them — iCloud or a computer on iPhone, Google\'s backup or a transfer to a new phone on Android — protected the way Apple or Google protects that backup. Do not count on it: Google\'s backup skips apps over 25 MB, and deleting the app without a backup deletes them, so export a backup file regularly.',
    },
  },
  {
    id: 'local-egress',
    mode: 'local',
    feature: 'On-device mode (iPhone and Android apps) — network',
    boundary: 'not-a-carve-out',
    data: 'Nothing, except the requests to the AI provider and food database you added with your own key (the same calls as the BYO rows above) and, only if you turn on the free trial, the anonymous trial AI, the operator\'s food-database lookups and trial voice calls (the local-trial, local-food and local-voice rows below); and, through the app shell rather than the page, an invite request or feedback you send (the invite-request and local-feedback rows)',
    destination: 'Only those providers, plus our server (and, for trial voice calls, the operator\'s ElevenLabs account) while the free trial is on, and our server for an invite request or feedback you send, which the app shell posts (never the page). The app\'s CSP admits no other host, and every other server feature (sync, push relay, Telegram, MCP, voice with your own ElevenLabs key, sharing, RxNav drug lookups, Mi Band import) is off; with the trial off, so are the operator\'s food database and voice calls. Telegram is a sync feature; local mode offers it and routes to Turn on sync',
    operatorVisibility: 'none',
    retention: 'Per each provider\'s own policy',
    activation: 'opt-in',
    activationNote: 'you add a provider key in Settings → AI & integrations; its host name is handed to the app shell for the CSP, never to a server',
    byo: 'The only kind there is in this mode',
    evidence: ['web/cloud/js/local-policy.js:287', 'web/cloud/js/local-policy.js:295', 'web/cloud/js/local-policy.js:247', 'ios/App/LocalOrigin.swift:41', 'android/app/src/main/java/com/example/medtracker/MainActivity.kt:382'],
    code: { go: [], hosts: [] },
    docSignal: null,
    userCopy: {
      category: 'leaves',
      title: 'On-device mode: only the providers you add',
      detail: 'In on-device mode the app talks to no server of ours unless you turn on the free trial (AI, food database and voice calls) or send an invite request or feedback (the app itself sends them, not the page). Otherwise the only requests that leave the phone go to the AI provider or food database you added with your own key, and the app blocks every other host. Medication names are not checked against RxNav, and voice with your own ElevenLabs key and sharing need a cloud account. Telegram needs sync: the app offers it and routes to Turn on sync.',
    },
  },
  {
    // bd med-o7zq.15 (server half; the client bead med-o7zq.16 points the
    // evidence at the real client lines). DeviceCheck egress lives in
    // internal/appattest, which the Go host scan does not cover — attest.go
    // names the host so this anchor is checked. bd med-nt9p.32.8.3: the
    // Android twin — Play Integrity egress lives in internal/playintegrity;
    // attest.go names both Google hosts for the same reason.
    id: 'local-trial',
    mode: 'local',
    feature: 'On-device mode (iPhone and Android apps) — anonymous trial AI (operator\'s AI key, no account)',
    boundary: 'carve-out',
    data: 'The meal or activity description you typed, meal and workout-sheet PHOTOS (with the plan\'s exercise names) and exercise names to tag, or a tiny health-data-free sample prompt for an explicit trial Check key, in plaintext; plus a proof that identifies the app install, not you: on iPhone an App Attest proof and a DeviceCheck token, on Android a Google Play Integrity token',
    destination: 'The operator\'s server, then the operator\'s AI provider account (the same as the account trial AI); at enrollment the operator\'s server asks Apple DeviceCheck whether this iPhone already had a trial, or, on Android, Google Play Integrity to confirm the app install — one opaque token per enrollment goes to Google, no health data, no account',
    operatorVisibility: 'transient',
    retention: 'Prompts and photos are not stored (memory only, in transit). Stored per device trial bucket: each install\'s attested key id and public key (App Attest on iPhone, an Android Keystore key on Android), the request counters, and a SHA-256 hash of the bucket\'s trial pass (on iPhone the pass itself stays in the keychain, this device only, never iCloud-synced; on Android in the app\'s own storage, which the phone\'s Google backup includes); Apple keeps the device\'s two DeviceCheck bits; on Android, when the operator turns on device recall, Google Play keeps the device\'s recall bits (a mark that this phone had its trial). No device token or Play Integrity token or verdict is stored, except the accepted app-verdict label on the install row. Settings → Backup & import → Erase data on this device first asks the server to delete the trial bucket of this install\'s current key (every install row in it, the counters and the pass hash; bd med-egb3) — if that fails you are told and can cancel — and only after the server confirms drops the phone\'s attest key; the trial pass stays in the phone\'s secure storage (a pass for an older bucket the delete did not reach keeps that bucket\'s trial; a pass for the deleted bucket is refused). Only unlinkable day counts under the deleted random bucket id remain until swept. Apple\'s DeviceCheck flags, and Google\'s device recall if the operator switches it on, are kept by Apple or Google and the operator can\'t clear them. They limit how many free trials one phone can get after erasing. Anonymous feedback already queued stays on the server until the operator collects it',
    activation: 'opt-in-consent',
    activationNote: 'you turn on the trial in Settings → AI & integrations and accept the trial consent; off by default, and off means no request to our server at all',
    byo: 'Add your own AI key and requests go phone-direct to your provider, never through the operator',
    evidence: ['web/cloud/js/local-policy.js:295', 'web/cloud/js/local-trial.js:99', 'web/cloud/js/local-trial.js:115', 'ios/App/Attest.swift:90', 'ios/App/Attest.swift:75', 'android/app/src/main/java/com/example/medtracker/Attest.kt:158', 'internal/cloudserver/attest.go:773', 'internal/cloudserver/attest.go:598', 'internal/appattest/devicecheck.go:65', 'internal/cloudserver/attest.go:646', 'internal/cloudserver/attest.go:950', 'internal/playintegrity/playintegrity.go:308', 'internal/cloudserver/attest.go:393', 'web/cloud/js/local-policy.js:841', 'web/cloud/js/local-trial.js:217'],
    code: { go: ['internal/cloudserver/attest.go'], hosts: ['api.devicecheck.apple.com', 'playintegrity.googleapis.com', 'oauth2.googleapis.com'] },
    docSignal: null,
    userCopy: {
      category: 'visible',
      title: 'On-device mode: the free trial AI, if you turn it on',
      detail: 'If you turn on the free trial AI in on-device mode, your meal and activity descriptions, meal and workout-sheet photos and exercise names go through our server to the operator\'s AI provider account to be parsed. Our server keeps no prompts or photos — only an anonymous install id and how many trial requests this phone\'s trial has used. On iPhone, Apple is asked whether this phone already had a trial, and a trial pass kept in the phone\'s keychain lets a reinstall of the app continue the same allowance instead of starting a new one. On Android, Google Play Integrity confirms the app install; one opaque token per enrollment goes to Google — no health data, no account. Erase data on this device also asks our server to delete this phone\'s trial record and its remaining allowance (if the server cannot be reached you are told and can cancel). Apple\'s DeviceCheck flags, and Google\'s device recall if the operator switches it on, are kept by Apple or Google and the operator can\'t clear them. They limit how many free trials one phone can get after erasing. Anonymous feedback you already sent stays on the server until the operator collects it. Add your own key to keep everything off our server.',
    },
  },
  {
    // bd med-o7zq.19 (server half) + med-o7zq.20 (client: fooddb.js's
    // operator port → local-policy.js LOCAL_FOOD_DB → local-trial.js foodGet).
    // Same App Attest enrollment as local-trial; GET /api/attest/food/* on the
    // base domain.
    id: 'local-food',
    mode: 'local',
    feature: 'On-device mode (iPhone and Android apps) — anonymous trial food database (operator\'s food DB, no account)',
    boundary: 'carve-out',
    data: 'Food search terms and scanned barcodes',
    destination: 'The operator, then the operator\'s food-DB instance',
    operatorVisibility: 'transient',
    retention: 'Search terms and barcodes are not stored or logged by the app (memory only, in transit); mind the operator\'s HTTP access logs — the term travels in the query string. Stored per device trial bucket: a daily lookup count next to the local-trial record',
    activation: 'opt-in-consent',
    activationNote: 'the same free-trial switch and consent as the trial AI (one enrollment per install; a reinstall rejoins the device\'s trial with its pass: the keychain on iPhone, the phone\'s Google backup on Android); off means no request to our server at all',
    byo: 'Set your own food-DB endpoint in Settings → AI & integrations and lookups go phone-direct to it, never through the operator',
    evidence: ['web/cloud/js/fooddb.js:96', 'web/cloud/js/local-policy.js:259', 'web/cloud/js/local-trial.js:257', 'internal/cloudserver/attest.go:929', 'internal/cloudserver/food_proxy.go:93'],
    code: { go: ['internal/cloudserver/attest.go', 'internal/cloudserver/food_proxy.go'], hosts: [] },
    docSignal: null,
    userCopy: {
      category: 'visible',
      title: 'On-device mode: the free trial food database, if you turn it on',
      detail: 'If you turn on the free trial in on-device mode, food searches and scanned barcodes go through our server to the operator\'s food database. Our server keeps no search terms or barcodes — only how many lookups this phone\'s anonymous trial made today, up to a daily limit. With the trial off, nothing is looked up and the app says so. Add your own food database to keep lookups off our server.',
    },
  },
  {
    // bd med-o7zq.22 (server half) + med-o7zq.23 (client: local-policy.js
    // swaps window.CloudVoiceLLM for a minting responder and adds the hosts,
    // local-trial.js voiceStart signs the start, elevenlabs-call.js takes the
    // signed URL from it). Same App Attest enrollment and the same trial
    // switch as local-trial; POST /api/attest/voice/start mints the
    // operator's ElevenLabs signed URL, the relay answers the turns itself.
    id: 'local-voice',
    mode: 'local',
    feature: 'On-device mode (iPhone and Android apps) — anonymous trial voice calls (operator\'s ElevenLabs and AI keys, no account)',
    boundary: 'carve-out',
    data: 'Your voice audio, the transcript and the agent conversation — including tool results the agent reads from the records on this phone (blood pressure, weight, workouts, medications, food, sleep, notes) — and the agent\'s answers; plus the proof that identifies the app install (App Attest on iPhone, a Keystore key on Android)',
    destination: 'Audio and transcript: the operator\'s ElevenLabs account, phone-direct after our server mints the call. The agent\'s answers: ElevenLabs sends each turn to the operator\'s server, which has the operator\'s trial AI account write the answer',
    operatorVisibility: 'transient',
    retention: 'Not stored by the app (turns transit memory only and are never logged); ElevenLabs retention applies to the audio and transcript. Stored per device trial bucket: voice call seconds (lifetime and per day) next to the local-trial record',
    activation: 'opt-in-consent',
    activationNote: 'the same single free-trial switch and consent as the trial AI and food database; off means no request to our server or to ElevenLabs at all',
    byo: 'None in this mode: voice with your own ElevenLabs key needs a cloud account',
    evidence: ['web/cloud/js/local-trial.js:267', 'web/cloud/js/local-policy.js:295', 'web/cloud/js/local-policy.js:230', 'web/cloud/js/voice-llm-responder.js:265', 'web/static/js/features/elevenlabs-call.js:982', 'internal/cloudserver/attest.go:312', 'internal/cloudserver/voice_llm_relay.go:803', 'internal/cloudserver/trial_proxy.go:167'],
    code: { go: ['internal/cloudserver/attest.go', 'internal/cloudserver/voice_llm_relay.go', 'internal/cloudserver/trial_proxy.go'], hosts: ['api.elevenlabs.io'] },
    docSignal: null,
    userCopy: {
      category: 'visible',
      title: 'On-device mode: free trial voice calls, if you turn them on',
      detail: 'If you turn on the free trial in on-device mode, voice calls run on the operator\'s ElevenLabs account: your voice audio and its transcript go to it, and the agent\'s answers are written by the operator\'s AI provider account through our server, which receives each turn and the health data the agent reads from this phone to answer you. You get a limited number of free minutes of calls on this phone, with a daily limit (the operator sets both); each call uses its full length limit when it starts. Our server keeps no call content — only how many seconds of calls this phone\'s anonymous trial has used. With the trial off, the app calls neither our server nor ElevenLabs.',
    },
  },
  {
    // bd med-ta2n.19 (server: POST /api/attest/feedback) + med-ta2n.20 (client:
    // local-policy.js swaps feedback-submit.js's transport for the attest
    // client). Same age recipient and feedback_queue as the cloud 'feedback'
    // row; the row's account_id is 'attest:' + the bucket id. The shell
    // POSTs it (bridge op base.post, med-ta2n.24); the CSP is unchanged and
    // the local-egress row names this send.
    id: 'local-feedback',
    mode: 'local',
    feature: 'On-device mode (iPhone and Android apps) — feedback you send',
    boundary: 'carve-out',
    data: 'What you type plus any screenshot or voice note, age-encrypted on the phone to the developer\'s key; the app version; your install\'s attestation key id',
    destination: 'The operator\'s server (stores the ciphertext blindly), then the developer offline',
    operatorVisibility: 'ciphertext',
    retention: 'Until the developer drains the queue',
    activation: 'user-initiated',
    activationNote: 'when you tap Send in Settings → Send feedback; the first send on an install without a key enrolls one — the app check only; it does not use or spend the free trial',
    byo: 'n/a',
    evidence: ['web/cloud/js/feedback-submit.js:195', 'web/cloud/js/local-policy.js:486', 'web/cloud/js/local-policy.js:516', 'web/cloud/js/local-boot.js:85', 'internal/cloudserver/attest.go:331'],
    code: { go: ['internal/cloudserver/attest.go'], hosts: [] },
    docSignal: null,
    userCopy: {
      category: 'visible',
      title: 'On-device mode: feedback you send',
      detail: 'Feedback you send from the on-device app is encrypted on this phone to the developer\'s key and goes through our server, which stores it without being able to read it; the developer can, including any screenshot or voice note you attach. It carries no account, but it is signed with this app install\'s anonymous key (the same app check as the free trial), so the operator can tell two messages came from the same install. The app version travels unencrypted. Nothing else from your log leaves the phone.',
    },
  },
  {
    id: 'local-notifications',
    feature: 'Reminder text on the lock screen (on-device mode and accounts)',
    boundary: 'on-device',
    data: 'The text of each reminder: generic ("Medication time") or, with Detailed, the full text — medication and tracker names, workout plans, your weight and goal, the weekly summary. Generic is the default on the device and for new accounts; accounts that already had reminders keep Detailed, the text they always showed. In an account a Web Push reminder carries the same text sealed under the push key (see the push relay row) until this device decrypts it',
    destination: 'The phone\'s notification scheduler (iPhone and Android apps) or the browser\'s notifications (Web Push), then the lock screen and Notification Center, readable by anyone holding the device. On Android the pending schedule (the same text, plus the medication ids a dose reminder opens) is kept in the app\'s device-protected storage, so reminders still fire after a reboot before the first unlock; that storage is readable before the unlock only below the OS (root, forensic tools)',
    operatorVisibility: 'none',
    retention: 'Until the reminder fires or is replaced by the next schedule',
    activation: 'opt-in',
    activationNote: 'you allow notifications; Settings → Reminders & notifications picks Generic or Detailed (Lock-screen text on the device, Reminder text in an account), as does the ask sheet',
    byo: 'n/a',
    evidence: ['web/cloud/js/reminders.js:201', 'web/cloud/js/reminders.js:267', 'web/cloud/js/push.js:403', 'android/app/src/main/java/com/example/medtracker/Notifications.kt:30'],
    code: { go: [], hosts: [] },
    docSignal: null,
    userCopy: {
      category: 'device',
      title: 'Reminders on the lock screen',
      detail: 'Reminders show on the lock screen and in notifications, where anyone holding the device can read them even while it is locked. In the iPhone and Android apps they are scheduled on the phone itself; on the web they arrive as a sealed push this device opens. Generic text only says a reminder is due; Detailed shows the full text — medication and tracker names, workout plans, your weight and goal, and the weekly summary. Pick either in Settings → Reminders & notifications. Accounts that had reminders before this choice existed start on Detailed, as they always were.',
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
