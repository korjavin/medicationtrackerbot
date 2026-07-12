// bd med-yor.14 — every literal external fetch host in the cloud client must
// be reachable under the app document's CSP or routed through a same-origin
// proxy. The DEK-bearing page's `connect-src` is 'self' + BYO-registered hosts
// + fixed api.elevenlabs.io only (internal/cloudserver/router.go
// buildConnectSrc); a hardcoded third-party URL that isn't on that list is
// structurally CSP-blocked and fails SILENTLY (fetchJson-style helpers
// swallow the error) — exactly the rxnav.nlm.nih.gov regression this guards
// against.
//
// CONTRACT: adding a new literal `https://<host>` fetch to any non-test
// web/cloud/js file fails this test until the host is either (a) proxied
// same-origin (relative /api/... path, like /api/rxnav/*), or (b) added to
// ALLOWED below with a justification for why the CSP already covers it (or
// why it is not a fetch at all).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const JS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// host → why a literal reference is acceptable.
const ALLOWED = {
  // Fixed entry in buildConnectSrc — always emitted in the app document's CSP.
  'api.elevenlabs.io': 'fixed connect-src entry (router.go buildConnectSrc)',
  // BYO-key default: reachable once the user registers their provider host.
  // The default-fallback registration gap is tracked in med-yor.4.
  'api.openai.com': 'BYO provider default; egress-host registration (med-yor.4)',
  // Anchor hrefs / navigation only — never a fetch, so connect-src is moot.
  't.me': 'navigation link to the Telegram bot, not a fetch',
};

function nonTestJsFiles(dir = JS_DIR) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'tests' ? [] : nonTestJsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Line comments: `//` not preceded by `:` (keeps https:// literals intact).
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function literalHosts(src) {
  const hosts = new Set();
  for (const m of stripComments(src).matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) {
    hosts.add(m[1]);
  }
  return hosts;
}

describe('cloud client egress consistency (med-yor.14)', () => {
  const files = nonTestJsFiles();
  const allHosts = new Set(
    files.flatMap((f) => [...literalHosts(fs.readFileSync(f, 'utf8'))]),
  );

  it('the scan actually reached the client sources (sanity)', () => {
    expect(files.map((f) => path.basename(f))).toContain('rxnorm.js');
    expect(allHosts.size).toBeGreaterThanOrEqual(1);
  });

  it('every literal external host is in the curated ALLOWED map', () => {
    const unexplained = [...allHosts].filter((h) => !(h in ALLOWED));
    expect(unexplained).toEqual([]);
  });

  it('no ALLOWED entry has gone stale (delete it when the last literal goes)', () => {
    const stale = Object.keys(ALLOWED).filter((h) => !allHosts.has(h));
    expect(stale).toEqual([]);
  });

  it('the RxNav hosts are gone — drug lookups are same-origin-proxied', () => {
    expect(allHosts.has('rxnav.nlm.nih.gov')).toBe(false);
    expect(allHosts.has('lhncbc.nlm.nih.gov')).toBe(false);
  });

  it('rxnorm.js actually routes through the proxy', () => {
    const src = fs.readFileSync(path.join(JS_DIR, 'rxnorm.js'), 'utf8');
    expect(stripComments(src)).toContain('/api/rxnav/');
  });
});
