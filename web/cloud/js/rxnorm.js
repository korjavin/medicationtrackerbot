// Browser implementation of the rxnorm port (C2b Task 6) — routes through
// the operator's blind same-origin RxNav proxy (`/api/rxnav/*`,
// internal/cloudserver/rxnav_proxy.go), not browser-direct: the DEK-bearing
// app document's `connect-src` is 'self' + BYO hosts only, so direct fetches
// to rxnav.nlm.nih.gov / lhncbc.nlm.nih.gov are structurally CSP-blocked.
// Tradeoff: the operator sees the drug-name query in transit, but the proxy
// is blind by the fixed-string log invariant (never logs name/rxcui/body),
// and nothing is persisted beyond rxcui/normalized_name on the med record.
// Warning-string format still mirrors internal/rxnorm/client.go.
//
// NLM decommissioned the public interaction-list endpoint (403s); the proxy
// forwards anyway and checkInteractions() degrades to [] on any non-OK/
// non-JSON response, same as a network failure — the med save still
// succeeds, it just never surfaces an interaction warning.

// 10s cap mirrors internal/rxnorm/client.go's http.Client{Timeout: 10s}. A
// bare fetch() has no timeout, so a half-open stall (captive portal, degraded
// network) would hang the awaited searchRxNorm inside a med create/update and
// the write would never persist. On abort/error the caller degrades to empty.
const FETCH_TIMEOUT_MS = 10000;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function searchApproximate(term) {
  const url = `/api/rxnav/approximate?term=${encodeURIComponent(term)}`;
  const data = await fetchJson(url);
  const candidates = data && data.approximateGroup && data.approximateGroup.candidate;
  return (candidates && candidates.length > 0 && candidates[0].rxcui) || '';
}

// searchRxNorm mirrors Client.SearchRxNorm: exact match, fall back to
// approximate match, then fetch the normalized name from properties.json.
export async function searchRxNorm(name) {
  let rxcui = '';
  try {
    const searchUrl = `/api/rxnav/rxcui?name=${encodeURIComponent(name)}`;
    const data = await fetchJson(searchUrl);
    const ids = data && data.idGroup && data.idGroup.rxnormId;
    rxcui = (ids && ids.length > 0 && ids[0]) || '';
    if (!rxcui) rxcui = await searchApproximate(name);
  } catch {
    return { rxcui: '', normalizedName: '' };
  }
  if (!rxcui) return { rxcui: '', normalizedName: '' };

  try {
    const propUrl = `/api/rxnav/properties?rxcui=${encodeURIComponent(rxcui)}`;
    const data = await fetchJson(propUrl);
    const normalizedName = (data && data.properties && data.properties.name) || '';
    return { rxcui, normalizedName };
  } catch {
    return { rxcui, normalizedName: '' };
  }
}

// checkInteractions mirrors Client.CheckInteractions: warning strings
// "Interaction between A and B: <desc>", de-duplicated by unordered pair.
export async function checkInteractions(rxcuis) {
  if (!rxcuis || rxcuis.length < 2) return [];
  try {
    const url = `/api/rxnav/interactions?rxcuis=${encodeURIComponent(rxcuis.join(','))}`;
    const data = await fetchJson(url);
    const groups = (data && data.fullInteractionTypeGroup) || [];
    const warnings = [];
    const seen = new Set();
    for (const group of groups) {
      for (const fit of group.fullInteractionType || []) {
        for (const pair of fit.interactionPair || []) {
          const concepts = pair.interactionConcept || [];
          if (concepts.length < 2) continue;
          const m1 = concepts[0].minConceptItem && concepts[0].minConceptItem.name;
          const m2 = concepts[1].minConceptItem && concepts[1].minConceptItem.name;
          const key = `${m1}-${m2}`;
          if (seen.has(key)) continue;
          seen.add(key);
          warnings.push(`Interaction between ${m1} and ${m2}: ${pair.description}`);
        }
      }
    }
    return warnings;
  } catch {
    return [];
  }
}

export function createRxnormPort() {
  return { searchRxNorm, checkInteractions };
}
