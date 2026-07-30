// "What can the operator see?" (bd med-d5t.9). docs/cloud-mode.md's metadata
// leakage table is honest and complete, and a non-technical friend will never
// read it. This is the same truth in plain language, in the app.
//
// DRIFT GUARD: every item whose `docSignal` is non-null must correspond exactly
// to a Signal row in that doc table, and vice versa — tests/privacy.drift check
// asserts the two sets are equal, so a leakage row added to the doc fails CI
// until it is added here (and the reverse). Items with `docSignal: null` are
// deliberate additions the table does not enumerate as their own row (trial-AI
// prompts, transient inbound-Telegram content) — honest exposures the bead asks
// us to name; they are not checked against the doc.
//
// Categories:
//   protected — encrypted on your device; the operator stores only ciphertext.
//   visible   — the operator (this server) can observe it. Metadata, never your
//               health content, except the clearly-marked flows that say so.
//   leaves    — goes from your browser DIRECT to a third party, never through
//               the operator. A different trust decision, made plain.

export const PRIVACY_CATEGORIES = [
  {
    key: 'protected',
    title: 'What is protected',
    intro: 'Everything you record — medications and doses, blood pressure, weight, food, workouts, sleep, diary notes — is encrypted on your device before it is ever sent. The operator stores only that ciphertext and holds no key to it. Losing your device and your Emergency Kit means even you cannot get back in; that is the cost of the operator never being able to read your vault. Optional features you switch on reach outside the vault — the two sections below name every one of them.',
  },
  {
    key: 'visible',
    title: 'What the operator can see',
    intro: 'The server needs some metadata to function. None of it is your health content, apart from the clearly-marked flows below where content passes through in transit.',
  },
  {
    key: 'leaves',
    title: 'What leaves your device to others',
    intro: 'A few features talk from your browser straight to a third party — never routed through the operator, because you supplied the key. You choose whether to use them.',
  },
];

export const PRIVACY_ITEMS = [
  // --- protected (framing; not doc-table rows) --------------------------------
  {
    category: 'protected',
    docSignal: null,
    title: 'Your health data',
    detail: 'Stored and synced only as ciphertext. The operator cannot read a single reading, dose, note, or value.',
  },

  // --- visible to the operator (metadata) -------------------------------------
  {
    category: 'visible',
    docSignal: 'Reminder timing',
    title: 'When your reminders fire',
    detail: 'A reminder is a blind alarm clock: the server knows a reminder is due at a time, but its content stays sealed.',
  },
  {
    category: 'visible',
    docSignal: 'Subdomain (≈ account existence)',
    title: 'That your account exists',
    detail: 'Your account lives at its own subdomain, so the operator (and, over the network, DNS observers) can tell an account exists. The wildcard certificate keeps the name out of public certificate logs.',
  },
  {
    category: 'visible',
    docSignal: 'Sync cadence, blob sizes, IPs',
    title: 'When and how much you sync',
    detail: 'How often your device syncs, the size of each encrypted blob, and your IP address — the same as any sync service sees. No content.',
  },
  {
    category: 'visible',
    docSignal: 'TG bot token, chat id, TG message text (both directions) in transit',
    title: 'Telegram chat + reminders, if you turn them on',
    detail: 'A chat bot cannot be end-to-end encrypted, so text crosses the relay in plain text both ways. Reminders it sends carry the detail you choose — "Medication time" with no names (generic), or the medication named (detailed) — in Settings → Notifications. Messages you send the bot also transit the relay in the clear, but the server seals each on arrival and never reads it: no parsing, no AI, no logs. Only your unlocked app opens and acts on them. Photos are fetched through the server but never stored there.',
  },
  {
    category: 'visible',
    docSignal: 'MCP query content',
    title: 'Claude connector queries (hosted mode only)',
    detail: 'With the local Claude connector, your queries stay sealed end-to-end. Only the opt-in hosted remote mode lets the server see query content in transit; it is off unless you enable it.',
  },
  {
    category: 'visible',
    docSignal: 'MCP frame sizes + timing',
    title: 'Claude connector traffic shape',
    detail: 'When the connector is active, the relay sees message sizes and timing and pairing ids — never the content, which stays sealed.',
  },
  {
    category: 'visible',
    docSignal: 'MCP pairing key at rest (tier 2 only)',
    title: 'Hosted connector key (hosted mode only)',
    detail: 'The hosted remote mode stores a pairing key on the server while it is enabled. It is deleted when you disconnect, and the pairing token itself is never logged.',
  },
  {
    category: 'visible',
    docSignal: null,
    title: 'Trial AI prompts, if you use the operator\'s key',
    detail: 'If you use the shared trial AI instead of your own key, your meal descriptions and photos pass through the operator\'s OpenAI account to be parsed. This only happens with your explicit consent — you are asked on first use, and can revoke it any time in Settings → Integrations. Add your own key there to keep them off the operator entirely.',
  },
  {
    category: 'visible',
    docSignal: null,
    title: 'Telegram assistant answers, if you use the trial key',
    detail: 'When the Telegram assistant answers you on the trial key, your message AND the health data it reads from your vault to answer — blood pressure history, notes, and the like — transit the operator\'s OpenAI account. This has its own consent, separate from meal parsing, asked on first use and revocable in Settings → Integrations.',
  },
  {
    category: 'visible',
    docSignal: null,
    title: 'Trial voice calls, if you use the operator\'s key',
    detail: 'Trial voice calls run on the operator\'s ElevenLabs account, so your voice audio and the agent conversation pass through it. This requires your explicit consent — asked on first use, revocable in Settings → Integrations. With your own ElevenLabs key the operator is not involved.',
  },
  {
    category: 'visible',
    docSignal: 'Drug-name search + interaction queries',
    title: 'Drug-name and interaction lookups',
    detail: 'Drug searches and interaction checks are relayed through the operator\'s server to RxNav (NIH) — the server can see the drug name in transit but is blind by design: the application never logs or stores the query. Only the resolved drug id is kept on the medication record.',
  },
  {
    category: 'visible',
    docSignal: null,
    title: 'A Telegram message, briefly, before it is sealed',
    detail: 'Telegram delivers your messages to the bot in the clear, so the relay unavoidably sees an inbound message in memory for the instant it takes to seal it to your account. It is never stored unsealed.',
  },

  {
    // Deliberately in `visible`, not `leaves`: without a food-DB key of your
    // own, fooddb.js routes the query through the operator's same-origin
    // /api/food/* proxy (internal/cloudserver/food_proxy.go), so the operator
    // does see the search term. Only the BYO path is browser-direct.
    category: 'visible',
    docSignal: 'Food/barcode search terms',
    title: 'Food and barcode searches',
    detail: 'Unless you set your own food database in Settings → Integrations, searches and scanned barcodes go through the operator\'s server to the operator\'s food database — so the operator sees the search term in transit (the same exposure as searching a public food catalogue). Set your own endpoint and the query goes from your browser straight there instead, never through the operator.',
  },

  // --- leaves your device to third parties ------------------------------------
  {
    category: 'leaves',
    docSignal: 'Meal descriptions + photos (AI parsing)',
    title: 'AI meal parsing with your own key',
    detail: 'When you use your own OpenAI-compatible key, meal descriptions and photos go straight from your browser to that provider — never proxied through the operator.',
  },
];

// renderPrivacyInto builds the three-section transparency view into `container`.
// Everything here is authored constants (no user or server data), but it is
// still built with textContent + createElement rather than innerHTML — this
// ships on the DEK-bearing page, and "static today" is how an injection lands
// tomorrow.
export function renderPrivacyInto(container, doc = (typeof document !== 'undefined' ? document : null)) {
  if (!container || !doc) return;
  container.replaceChildren();
  for (const cat of PRIVACY_CATEGORIES) {
    const section = doc.createElement('div');
    section.className = 'wg-privacy-group';
    section.dataset.category = cat.key;

    const h = doc.createElement('h4');
    h.className = 'wg-privacy-group__title wg-mono-display';
    h.textContent = cat.title;
    section.appendChild(h);

    if (cat.intro) {
      const p = doc.createElement('p');
      p.className = 'wg-privacy-group__intro';
      p.textContent = cat.intro;
      section.appendChild(p);
    }

    const items = PRIVACY_ITEMS.filter((it) => it.category === cat.key);
    if (items.length) {
      const list = doc.createElement('ul');
      list.className = 'wg-privacy-list';
      for (const it of items) {
        const li = doc.createElement('li');
        li.className = 'wg-privacy-item';
        const t = doc.createElement('div');
        t.className = 'wg-privacy-item__title';
        t.textContent = it.title;
        const d = doc.createElement('div');
        d.className = 'wg-privacy-item__detail';
        d.textContent = it.detail;
        li.append(t, d);
        list.appendChild(li);
      }
      section.appendChild(list);
    }
    container.appendChild(section);
  }
}
