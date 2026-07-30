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
