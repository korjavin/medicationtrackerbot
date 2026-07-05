// Browser implementation of the rxnorm port (C2b Task 6) — direct
// fetch()es from the browser to the public RxNav APIs, exact URLs and
// warning-string format from internal/rxnorm/client.go. Nothing is
// persisted beyond rxcui/normalized_name on the med record (Task 2); this
// module never proxies through the cloud server, so drug-name queries hit
// RxNav (NIH) directly from the client's own IP, not the operator's.
//
// CORS check (2026-07-05): rxnav.nlm.nih.gov's rxcui.json,
// approximateTerm.json and rxcui/{id}/properties.json all send
// `access-control-allow-origin: *` — fine from the browser. The
// interaction endpoint (lhncbc.nlm.nih.gov/RxNav/APIs/api/interaction/
// list.json) is NOT a CORS problem, it's gone: every request 403s with a
// static CloudFront/S3 error page, matching NLM's public interaction-API
// decommission. checkInteractions() below degrades to [] on any
// non-OK/non-JSON response, same as a network failure — the med save
// still succeeds, it just never surfaces an interaction warning.
const BASE_URL = 'https://rxnav.nlm.nih.gov';
const INTERACTION_URL = 'https://lhncbc.nlm.nih.gov/RxNav/APIs';

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function searchApproximate(term) {
  const url = `${BASE_URL}/REST/approximateTerm.json?term=${encodeURIComponent(term)}&maxEntries=1`;
  const data = await fetchJson(url);
  const candidates = data && data.approximateGroup && data.approximateGroup.candidate;
  return (candidates && candidates.length > 0 && candidates[0].rxcui) || '';
}

// searchRxNorm mirrors Client.SearchRxNorm: exact match, fall back to
// approximate match, then fetch the normalized name from properties.json.
export async function searchRxNorm(name) {
  let rxcui = '';
  try {
    const searchUrl = `${BASE_URL}/REST/rxcui.json?name=${encodeURIComponent(name)}`;
    const data = await fetchJson(searchUrl);
    const ids = data && data.idGroup && data.idGroup.rxnormId;
    rxcui = (ids && ids.length > 0 && ids[0]) || '';
    if (!rxcui) rxcui = await searchApproximate(name);
  } catch {
    return { rxcui: '', normalizedName: '' };
  }
  if (!rxcui) return { rxcui: '', normalizedName: '' };

  try {
    const propUrl = `${BASE_URL}/REST/rxcui/${rxcui}/properties.json`;
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
    const url = `${INTERACTION_URL}/api/interaction/list.json?rxcuis=${rxcuis.map(encodeURIComponent).join('+')}`;
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
