// bd med-yor.1 — the product may promise a zero-knowledge *vault*. It may not
// promise that the whole service is end-to-end encrypted, because several
// implemented opt-in integrations deliberately move plaintext past the operator
// (trial AI, trial voice, Telegram, hosted MCP tier 2, the operator-default
// food proxy, RxNav). Source finding: P0 in
// docs/2026-07-12-gpt-5.6-sol-cloud-privacy-audit.md.
//
// This guard is the reason the fix stays fixed. It is deliberately a
// content-shaped architecture test in the mould of
// web/static/js/tests/architecture.no-telegram-in-html.test.js: three rules,
// applied to an explicit list of copy surfaces.
//
//   1. BANNED — no surface may carry an unconditional whole-product claim.
//      Verbatim regressions of the phrasings the audit flagged fail here.
//   2. CO-OCCURRENCE — any surface that says "zero-knowledge" or "end-to-end
//      encrypted" must, in the same file, acknowledge the carve-outs. This is
//      what catches a *newly worded* absolute claim the ban list has never
//      seen.
//   3. PROMISE — the primary surfaces must carry the approved core wording,
//      both halves of it, so the vault claim is never quietly weakened either.
//
// Adding a copy surface? Add it to SURFACES. Adding a carve-out to the
// product? Add it to REQUIRED_CARVE_OUTS and to the cloud-mode.md table.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PRIVACY_MANIFEST,
  BOUNDARY,
  ACTIVATION,
  OPERATOR_VISIBILITY,
  renderBoundaryTable,
  GENERATED_BEGIN,
  GENERATED_END,
} from '../privacy-manifest.js';
import { PRIVACY_ITEMS, PRIVACY_CATEGORIES } from '../privacy.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

// Every surface a user or an evaluator reads a privacy claim from. `promise`
// marks the surfaces that must state the approved wording in full; the rest
// only have to avoid overclaiming and name the carve-outs when they invoke
// E2EE language at all.
const SURFACES = [
  { file: 'README.md', promise: true },
  { file: 'docs/cloud-mode.md', promise: true },
  { file: 'docs/index.html', promise: true },
  { file: 'web/cloud/index.html', promise: true },
  { file: 'web/static/index.html', promise: true },
  { file: 'docs/architecture.md', promise: false },
  { file: 'docs/cloud-operations-security.md', promise: false },
  { file: 'web/cloud/js/signup.js', promise: false },
  { file: 'web/cloud/js/privacy.js', promise: false },
  { file: 'web/cloud/js/connectors.js', promise: false },
  { file: 'web/static/pitch.html', promise: false },
];

// Unconditional claims that are false for the implemented product. Each entry
// is a phrasing that shipped (or that a well-meaning edit reaches for next).
const BANNED = [
  [/we hold none of your data/i, 'the operator holds plaintext for opt-in integrations'],
  [/(can'?t|cannot|never)\s+read\s+any\s+of\s+(it|your data)/i, 'true of the vault only — say "the vault"'],
  [/everything\s+is\s+end-to-end\s+encrypted/i, 'opt-in integrations are not'],
  [/all\s+(of\s+)?your\s+data\s+is\s+end-to-end\s+encrypted/i, 'opt-in integrations are not'],
  [/never\s+see\s+any\s+of\s+your\s+data/i, 'trial AI / Telegram / hosted MCP see plaintext'],
  [/no\s*-?\s*one\s+(can|could)\s+(ever\s+)?(see|read)\s+your\s+data/i, 'scope the claim to the vault'],
  [/operator\s+(running\s+this\s+service\s+)?cannot\s+read\s+your\s+data/i, 'scope the claim to the vault'],
  [/ciphertext\s+and\s+timing\s+metadata,\s*nothing\s+else/i, 'Telegram/trial/MCP plaintext also exists'],
  [/(provides|does)\s+exactly\s+three\s+things/i, 'the operator also runs plaintext proxies and relays'],
  [/zero[\s-]?knowledge\s+(health\s+)?(platform|service|product|app|company)/i,
    'the vault is zero-knowledge; the service is not — say "zero-knowledge vault"'],
  // Caught by codex review on this bead: it is tempting to summarize the
  // carve-outs as uniformly opt-in, but the operator-default food proxy and the
  // RxNav proxy have no toggle at all — they carry a query whenever the feature
  // is used. Split the list by activation instead of flattening it.
  [/(every ?one|each ?one|all of them|they all|they|each|none)\s+(is|are|stays?|stay)\s+off\s+until/i,
    'food + RxNav lookups have no enable step — separate "off until you turn it on" from "active on use"'],
];

// Any of these counts as acknowledging that something sits outside the vault.
const CARVE_OUT_MARKER = /carve[\s-]?out|opt-in|opt in|optional integration|optional extra|outside (that|the) vault|separately disclosed|not end-to-end encrypted/i;

// The two halves of the approved core wording. Kept as separate assertions so a
// diff that guts the vault claim fails just as loudly as one that drops the
// carve-outs — the bead forbids "fixing" this by hedging the vault away.
const PROMISE_VAULT = /your vault[^.]{0,120}is end-to-end encrypted/i;
const PROMISE_CARVE_OUTS = /optional integrations?[^.]{0,200}(outside (that|the) vault|not end-to-end encrypted)/i;

// Every carve-out the code actually implements. cloud-mode.md's carve-out
// section is the canonical enumeration; dropping one from it fails here.
const REQUIRED_CARVE_OUTS = [
  ['trial AI', /trial ai/i],
  ['trial voice', /trial voice/i],
  ['Telegram relay', /telegram/i],
  ['Telegram bot token at rest', /bot token/i],
  ['hosted MCP (tier 2)', /hosted mcp/i],
  ['operator-default food DB', /food[\s-]?db|food database/i],
  ['RxNav drug lookups', /rxnav/i],
  ['operational metadata', /operational metadata/i],
];

const CARVE_OUT_HEADING = '## Privacy boundary — the vault promise and its carve-outs';

function read(file) {
  return fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

// Copy wraps across lines in HTML, markdown blockquotes, and template
// literals, and is peppered with <strong>/** emphasis. Strip the packaging so a
// phrase split by a newline or interrupted by a tag still matches — otherwise
// the guard is trivially defeated by reflowing a paragraph.
function normalize(text) {
  return text
    .replace(/^\s*>\s?/gm, '')   // markdown blockquote markers
    .replace(/<[^>]+>/g, ' ')    // html tags
    .replace(/\*+/g, '')         // markdown emphasis
    .replace(/\s+/g, ' ');
}

describe('privacy claims must match the implemented boundary (med-yor.1)', () => {
  for (const { file } of SURFACES) {
    describe(file, () => {
      const text = normalize(read(file));

      for (const [pattern, why] of BANNED) {
        it(`makes no unconditional claim: ${pattern}`, () => {
          const hit = text.match(pattern);
          expect(hit, `banned phrasing "${hit?.[0]}" in ${file} — ${why}`).toBeNull();
        });
      }

      it('acknowledges the carve-outs wherever it invokes E2EE language', () => {
        if (!/zero[\s-]?knowledge|end-to-end encrypted/i.test(text)) return; // no claim, nothing to qualify
        expect(
          CARVE_OUT_MARKER.test(text),
          `${file} claims zero-knowledge / end-to-end encryption but never mentions the opt-in integrations that leave the vault`,
        ).toBe(true);
      });
    });
  }

  for (const { file, promise } of SURFACES.filter((s) => s.promise)) {
    describe(`${file} (primary surface)`, () => {
      const text = normalize(read(file));

      it('states the vault half of the promise (must not be hedged away)', () => {
        expect(PROMISE_VAULT.test(text), `${file} is missing the vault claim — it is true and users need it`).toBe(promise);
      });

      it('states the carve-out half of the promise', () => {
        expect(PROMISE_CARVE_OUTS.test(text), `${file} is missing the "optional integrations reach outside the vault" clause`).toBe(true);
      });
    });
  }
});

describe('cloud-mode.md is the canonical carve-out enumeration (med-yor.1)', () => {
  const doc = read('docs/cloud-mode.md');
  const start = doc.indexOf(CARVE_OUT_HEADING);

  it('the carve-out section exists', () => {
    expect(start, `"${CARVE_OUT_HEADING}" not found in docs/cloud-mode.md`).toBeGreaterThan(-1);
  });

  // The section runs to the next H2. Scoping to it means a carve-out named
  // only in some unrelated paragraph elsewhere in the doc does not satisfy the
  // guard.
  const rest = doc.slice(start + CARVE_OUT_HEADING.length);
  const end = rest.indexOf('\n## ');
  const section = normalize(end < 0 ? rest : rest.slice(0, end));

  for (const [name, pattern] of REQUIRED_CARVE_OUTS) {
    it(`enumerates: ${name}`, () => {
      expect(pattern.test(section), `carve-out "${name}" dropped from the cloud-mode.md table`).toBe(true);
    });
  }

  it('grounds each carve-out in code rather than asserting it', () => {
    // Every row cites a real file; a table of prose with no evidence column is
    // how this drifts back into marketing.
    const cited = section.match(/internal\/cloudserver\/[a-z_]+\.go/g) || [];
    expect(new Set(cited).size).toBeGreaterThanOrEqual(5);
    for (const f of new Set(cited)) {
      expect(fs.existsSync(path.join(REPO_ROOT, f)), `cloud-mode.md cites ${f}, which does not exist`).toBe(true);
    }
  });
});

// ===========================================================================
// bd med-yor.4 — the manifest is the single source of truth, and the set of
// things it MUST cover is derived from the code, not from a sibling list.
//
// The failure this catches: someone ships a new proxy, a new upstream host, or
// a new server-side plaintext path and nobody updates the disclosure. A guard
// that compared two hand-written lists to each other would pass happily. These
// scan the real call sites instead.
// ===========================================================================

// Markers that mean "this file moves user data past the app's own boundary":
// it makes an outbound HTTP call, forwards to an upstream, sends a push, talks
// to Telegram, or handles user PLAINTEXT server-side before sealing it.
// Comments are stripped before matching, so a mention in prose does not count.
const GO_EGRESS_MARKERS = [
  ['outbound HTTP', /http\.NewRequest(WithContext)?\(/],
  ['upstream proxy', /proxyUpstream\(/],
  ['web push send', /webpush\.Send/],
  ['telegram client', /tgclient\./],
  ['server-side plaintext seal', /SealAndQueue\(/],
  ['server-side health-file parse', /\bnxk\./],
];

// Third-party hosts a literal reference to is NOT a disclosure obligation.
// Deliberately empty: this is the one place a path could escape the manifest,
// so an entry here needs a written reason and a reviewer who agrees with it.
const HOST_EXEMPT = {};

function stripGoComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function goSourceFiles() {
  const dir = path.join(REPO_ROOT, 'internal/cloudserver');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'))
    .map((f) => `internal/cloudserver/${f}`);
}

function jsSourceFiles(dir = path.join(REPO_ROOT, 'web/cloud/js')) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'tests' ? [] : jsSourceFiles(full);
    return entry.name.endsWith('.js') ? [path.relative(REPO_ROOT, full)] : [];
  });
}

function literalHostsIn(src) {
  return new Set([...src.matchAll(/https?:\/\/([a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,})/g)].map((m) => m[1]));
}

describe('privacy manifest is well-formed (med-yor.4)', () => {
  const ids = PRIVACY_MANIFEST.map((e) => e.id);

  it('has unique ids and is non-trivial', () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(15);
  });

  for (const entry of PRIVACY_MANIFEST) {
    describe(entry.id, () => {
      it('declares every required field', () => {
        for (const field of ['feature', 'data', 'destination', 'retention', 'byo']) {
          expect(typeof entry[field], `${entry.id}.${field} must be a non-empty string`).toBe('string');
          expect(entry[field].length, `${entry.id}.${field} must be a non-empty string`).toBeGreaterThan(0);
        }
        expect(Object.keys(BOUNDARY), `${entry.id}.boundary`).toContain(entry.boundary);
        expect(Object.keys(ACTIVATION), `${entry.id}.activation`).toContain(entry.activation);
        expect(Object.keys(OPERATOR_VISIBILITY), `${entry.id}.operatorVisibility`).toContain(entry.operatorVisibility);
        expect(Array.isArray(entry.code?.go) && Array.isArray(entry.code?.hosts), `${entry.id}.code must be {go:[], hosts:[]}`).toBe(true);
      });

      // THE hole the old convention had: an entry with no machine-checkable
      // user-facing signal. Copy is mandatory; the only escape is an explicit
      // pointer at the sibling row whose copy covers it, and that sibling must
      // exist and carry copy of its own.
      it('carries user-facing copy (or names the sibling that covers it)', () => {
        if (entry.userCopy) {
          expect(typeof entry.userCopy.title).toBe('string');
          expect(entry.userCopy.detail.length).toBeGreaterThan(40);
          expect(PRIVACY_CATEGORIES.map((c) => c.key)).toContain(entry.userCopy.category);
          return;
        }
        const covering = PRIVACY_MANIFEST.find((e) => e.id === entry.userCopyCoveredBy);
        expect(covering, `${entry.id} has no userCopy and no valid userCopyCoveredBy`).toBeTruthy();
        expect(covering.userCopy, `${entry.id}.userCopyCoveredBy points at ${entry.userCopyCoveredBy}, which has no copy either`).toBeTruthy();
      });

      it('cites evidence that actually exists at that line', () => {
        expect(entry.evidence.length, `${entry.id} cites no evidence`).toBeGreaterThan(0);
        for (const ref of entry.evidence) {
          const [file, line] = ref.split(':');
          const full = path.join(REPO_ROOT, file);
          expect(fs.existsSync(full), `${entry.id} cites ${file}, which does not exist`).toBe(true);
          const lines = fs.readFileSync(full, 'utf8').split('\n').length;
          expect(Number(line), `${entry.id} cites ${ref}, but ${file} has only ${lines} lines`).toBeLessThanOrEqual(lines);
        }
      });

      it('claims code anchors that still exist', () => {
        for (const f of entry.code.go) {
          expect(fs.existsSync(path.join(REPO_ROOT, f)), `${entry.id} claims ${f}, which does not exist — drop the stale anchor`).toBe(true);
        }
      });
    });
  }
});

describe('every egress / plaintext path in the code is disclosed (med-yor.4)', () => {
  const claimedGo = new Set(PRIVACY_MANIFEST.flatMap((e) => e.code.go));
  const claimedHosts = new Set(PRIVACY_MANIFEST.flatMap((e) => e.code.hosts));

  const goHits = new Map(); // file -> [marker names]
  for (const file of goSourceFiles()) {
    const src = stripGoComments(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    const hits = GO_EGRESS_MARKERS.filter(([, re]) => re.test(src)).map(([name]) => name);
    if (hits.length) goHits.set(file, hits);
  }

  it('the scan actually found the known proxies (sanity — a broken scan must fail loudly)', () => {
    expect([...goHits.keys()]).toEqual(
      expect.arrayContaining([
        'internal/cloudserver/trial_proxy.go',
        'internal/cloudserver/food_proxy.go',
        'internal/cloudserver/rxnav_proxy.go',
        'internal/cloudserver/telegram.go',
      ]),
    );
  });

  it('every cloudserver file that talks outward or handles plaintext is claimed by a manifest entry', () => {
    const unclaimed = [...goHits.entries()]
      .filter(([file]) => !claimedGo.has(file))
      .map(([file, hits]) => `${file} (${hits.join(', ')})`);
    expect(
      unclaimed,
      'these files move user data past the app boundary but no privacy-manifest entry claims them — '
        + 'add an entry to web/cloud/js/privacy-manifest.js with user-facing copy, then run `pnpm privacy:docs`',
    ).toEqual([]);
  });

  // No reverse "every claimed file must still match a marker" check: entries
  // legitimately anchor files that are privacy-relevant without doing outbound
  // HTTP (tg_token.go seals a credential at rest, mcp_relay.go pipes opaque
  // frames, feedback.go stores blind ciphertext). Dangling paths are caught by
  // the per-entry "claims code anchors that still exist" assertion above; the
  // direction that matters — code the manifest does not cover — is below.

  it('every literal third-party host in the Go sources is claimed or exempt', () => {
    const found = new Map();
    for (const file of goSourceFiles()) {
      const src = stripGoComments(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
      for (const host of literalHostsIn(src)) if (!found.has(host)) found.set(host, file);
    }
    const unexplained = [...found].filter(([h]) => !claimedHosts.has(h) && !(h in HOST_EXEMPT));
    expect(
      unexplained.map(([h, f]) => `${h} (${f})`),
      'a third-party host reachable from the server, with no manifest entry naming it',
    ).toEqual([]);
  });

  it('every literal third-party host in the cloud client is claimed or exempt', () => {
    const found = new Map();
    for (const file of jsSourceFiles()) {
      const src = stripGoComments(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
      for (const host of literalHostsIn(src)) if (!found.has(host)) found.set(host, file);
    }
    const unexplained = [...found].filter(([h]) => !claimedHosts.has(h) && !(h in HOST_EXEMPT));
    expect(
      unexplained.map(([h, f]) => `${h} (${f})`),
      'the browser can reach this host but no manifest entry discloses it',
    ).toEqual([]);
  });

  it('no manifest host-anchor has gone stale', () => {
    const all = new Set();
    for (const file of [...goSourceFiles(), ...jsSourceFiles()]) {
      for (const host of literalHostsIn(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'))) all.add(host);
    }
    const stale = [...claimedHosts].filter((h) => !all.has(h));
    expect(stale, 'these manifest hosts appear nowhere in the sources — drop them').toEqual([]);
  });
});

describe('docs and in-app copy are generated from the manifest (med-yor.4)', () => {
  const doc = read('docs/cloud-mode.md');

  it('the generated boundary table matches the manifest exactly', () => {
    const start = doc.indexOf(GENERATED_BEGIN);
    const end = doc.indexOf(GENERATED_END);
    expect(start, 'docs/cloud-mode.md lost the generated-table BEGIN marker').toBeGreaterThan(-1);
    expect(end, 'docs/cloud-mode.md lost the generated-table END marker').toBeGreaterThan(start);
    const inDoc = doc.slice(start + GENERATED_BEGIN.length, end).trim();
    expect(inDoc, 'docs/cloud-mode.md drifted from the manifest — run `pnpm privacy:docs`').toBe(renderBoundaryTable());
  });

  it('the in-app privacy page is derived, not hand-written', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'web/cloud/js/privacy.js'), 'utf8');
    expect(src, 'privacy.js must derive PRIVACY_ITEMS from the manifest').toContain('PRIVACY_MANIFEST');
    const withCopy = PRIVACY_MANIFEST.filter((e) => e.userCopy);
    expect(PRIVACY_ITEMS.length).toBe(withCopy.length);
    expect(PRIVACY_ITEMS.map((i) => i.id)).toEqual(withCopy.map((e) => e.id));
  });

  it('names every disclosure gap the audit found (med-yor.4 acceptance list)', () => {
    const copy = PRIVACY_ITEMS.map((i) => `${i.title} ${i.detail}`).join(' ').toLowerCase();
    const required = [
      ['plaintext record-type channel', /labelled with its type and id in the clear/],
      ['record-type inference risk', /monitoring hypertension/],
      ['local plaintext mirror + warm unlock', /stays unlocked|no idle auto-lock/],
      ['ElevenLabs audio + transcripts + tool results', /elevenlabs[\s\S]*transcript/],
      ['trial voice', /trial voice/],
      ['gamification narration', /journey screen can turn/],
      ['Telegram agent AI egress', /telegram assistant/],
      ['non-food OpenAI uses', /workout descriptions/],
      ['operator-proxied food lookup', /operator's server to the operator's food database/],
      ['RxNav has no BYO alternative', /no way to point it at a service of your own/],
      ['server-side .nxk parse', /mi band backup/],
      ['metadata inference risk', /sketch your daily routine/],
    ];
    for (const [name, pattern] of required) {
      expect(pattern.test(copy), `the in-app privacy page no longer names: ${name}`).toBe(true);
    }
  });

  it('does not undo med-yor.1 — the relay claim stays scoped to the relay', () => {
    // privacy.js used to say inbound Telegram gets "no parsing, no AI, no logs"
    // full stop, which the trial tg-agent contradicts. The claim is true OF THE
    // RELAY and must stay attributed to it, with the AI hop named.
    const tg = PRIVACY_ITEMS.find((i) => i.id === 'telegram-relay');
    expect(tg, 'the telegram-relay disclosure disappeared').toBeTruthy();
    expect(/relay itself never parses it/i.test(tg.detail)).toBe(true);
    expect(/ai assistant/i.test(tg.detail)).toBe(true);
  });
});
