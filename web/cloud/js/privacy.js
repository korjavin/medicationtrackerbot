// "What can the operator see?" (bd med-d5t.9). docs/cloud-mode.md's metadata
// leakage table is honest and complete, and a non-technical friend will never
// read it. This is the same truth in plain language, in the app.
//
// SOURCE OF TRUTH (bd med-yor.4): the items below are DERIVED from
// ./privacy-manifest.js — this file only owns the section framing and the
// rendering. Do not add a hand-written item here; add a manifest entry with
// `userCopy` and it appears automatically. That is what closed the old hole
// where a `docSignal: null` item escaped every machine check: the manifest
// requires user-facing copy on every entry and is itself coverage-checked
// against the real egress call sites by
// tests/architecture.privacy-claims.test.js.
//
// DRIFT GUARD: every item whose `docSignal` is non-null must correspond exactly
// to a Signal row in the doc's metadata-leakage table, and vice versa —
// tests/privacy.drift.test.js asserts the two sets are equal.
//
// Categories:
//   protected — encrypted on your device; the operator stores only ciphertext.
//   visible   — the operator (this server) can observe it. Metadata, never your
//               health content, except the clearly-marked flows that say so.
//   device    — never leaves your device, but is readable by anyone who has it.
//   leaves    — goes from your browser DIRECT to a third party, never through
//               the operator. A different trust decision, made plain.
import { PRIVACY_MANIFEST } from './privacy-manifest.js';

export const PRIVACY_CATEGORIES = [
  {
    key: 'protected',
    title: 'What is protected',
    intro: 'Everything you record — medications and doses, blood pressure, weight, food, workouts, sleep, diary notes — is encrypted on your device before it is ever sent. The operator stores only that ciphertext and holds no key to it. Losing your device and your Emergency Kit means even you cannot get back in; that is the cost of the operator never being able to read your vault. Optional features you switch on reach outside the vault — the sections below name every one of them.',
  },
  {
    key: 'device',
    title: 'What stays on this device',
    intro: 'Encrypted in the cloud is not the same as locked on your phone. So the app works offline, this device keeps a readable copy and stays unlocked once you have unlocked it.',
  },
  {
    key: 'visible',
    title: 'What the operator can see',
    intro: 'The server needs some metadata to function. Apart from the clearly-marked flows below, none of it is your health content — but metadata is not nothing: when you sync, when reminders fire, when messages arrive, how big each blob is and which kinds of record you keep are enough to infer a routine and a rough idea of what you track. Read this list as "what could be inferred", not "harmless".',
  },
  {
    key: 'leaves',
    title: 'What leaves your device to others',
    intro: 'A few features talk from your browser straight to a third party — never routed through the operator, because you supplied the key. You choose whether to use them.',
  },
];

// PRIVACY_ITEMS is derived, not authored — every entry with `userCopy` in the
// manifest renders here, in manifest order. An egress path with no copy is
// impossible: the manifest guard requires `userCopy` on every entry (or an
// explicit `userCopyCoveredBy` pointing at the sibling row that names it).
export const PRIVACY_ITEMS = PRIVACY_MANIFEST
  .filter((entry) => entry.userCopy)
  .map((entry) => ({
    id: entry.id,
    category: entry.userCopy.category,
    docSignal: entry.docSignal || null,
    title: entry.userCopy.title,
    detail: entry.userCopy.detail,
  }));

// renderPrivacyInto builds the transparency view into `container`, one section
// per PRIVACY_CATEGORIES entry.
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

