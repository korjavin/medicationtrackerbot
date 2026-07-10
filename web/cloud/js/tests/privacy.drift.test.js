// bd med-d5t.9 — the "What can the operator see?" Settings page must not drift
// from docs/cloud-mode.md's metadata leakage table. This is the guard the bead
// asks for: every Signal row in the doc has a matching privacy item, and every
// doc-tied privacy item names a real doc row. Add a leakage row to the doc and
// this fails until it is added to the page, and vice versa.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PRIVACY_ITEMS, PRIVACY_CATEGORIES, renderPrivacyInto } from '../privacy.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const CLOUD_MODE_DOC = path.join(REPO_ROOT, 'docs/cloud-mode.md');

// Pull the first column ("Signal") of every data row in the "## Metadata
// leakage summary" table.
function docSignalRows() {
  const md = fs.readFileSync(CLOUD_MODE_DOC, 'utf8');
  const start = md.indexOf('## Metadata leakage summary');
  if (start < 0) throw new Error('leakage table heading not found in docs/cloud-mode.md');
  // The table ends at the next blank-line-then-non-table content; scan until a
  // line that is not a table row.
  const lines = md.slice(start).split('\n');
  const signals = [];
  let inTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (inTable) break; // table finished
      continue;
    }
    inTable = true;
    const firstCell = trimmed.slice(1, trimmed.indexOf('|', 1)).trim();
    if (firstCell === 'Signal') continue;        // header
    if (/^-+$/.test(firstCell.replace(/\s/g, ''))) continue; // separator ---
    if (firstCell) signals.push(firstCell);
  }
  return signals;
}

describe('operator-visibility page ↔ leakage table (med-d5t.9)', () => {
  const docSignals = docSignalRows();
  const itemSignals = PRIVACY_ITEMS.map((i) => i.docSignal).filter(Boolean);

  it('the doc table actually parsed (sanity)', () => {
    expect(docSignals.length).toBeGreaterThanOrEqual(8);
  });

  it('every doc leakage row is represented on the page', () => {
    const missing = docSignals.filter((s) => !itemSignals.includes(s));
    expect(missing).toEqual([]);
  });

  it('every doc-tied page item names a real doc row (no stale entries)', () => {
    const stale = itemSignals.filter((s) => !docSignals.includes(s));
    expect(stale).toEqual([]);
  });

  it('doc-tied signals are one-to-one — no duplicate rows papering over a gap', () => {
    expect(new Set(itemSignals).size).toBe(itemSignals.length);
    expect(itemSignals.length).toBe(docSignals.length);
  });

  it('every item sits in a known category', () => {
    const keys = new Set(PRIVACY_CATEGORIES.map((c) => c.key));
    for (const item of PRIVACY_ITEMS) expect(keys.has(item.category)).toBe(true);
  });

  it('names the honest exposures the bead calls out, beyond the table rows', () => {
    const text = PRIVACY_ITEMS.map((i) => `${i.title} ${i.detail}`).join(' ').toLowerCase();
    // Trial-AI prompts go to the operator's OpenAI key.
    expect(text).toMatch(/trial ai/);
    expect(text).toMatch(/operator's openai/);
    // Inbound Telegram content is transiently visible before sealing.
    expect(text).toMatch(/telegram delivers your messages to the bot in the clear/);
  });
});

describe('renderPrivacyInto', () => {
  it('builds the three categories with items, using textContent (no injection surface)', () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<div id="m"></div>');
    const mount = dom.window.document.getElementById('m');

    renderPrivacyInto(mount, dom.window.document);

    const groups = mount.querySelectorAll('.wg-privacy-group');
    expect(groups.length).toBe(PRIVACY_CATEGORIES.length);
    expect(mount.querySelectorAll('.wg-privacy-item').length).toBe(PRIVACY_ITEMS.length);
    // No raw HTML tags leaked into the DOM as text.
    expect(mount.innerHTML).not.toContain('<script');
  });

  it('is idempotent — re-render replaces rather than appends', () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<div id="m"></div>');
    const mount = dom.window.document.getElementById('m');

    renderPrivacyInto(mount, dom.window.document);
    renderPrivacyInto(mount, dom.window.document);

    expect(mount.querySelectorAll('.wg-privacy-item').length).toBe(PRIVACY_ITEMS.length);
  });
});
