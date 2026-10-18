// Browser implementation of the foodDb port consumed by createFoodDomain
// (C2c Task 5) — search()/barcode GETs go straight from this device to a
// FastFoodDB-shaped API, keyed from the vault's unmasked
// `integrations.food` record. Never routed through any /api shim surface.
// Mirrors internal/store/food/openfoodfacts_api.go's request/response
// shapes and barcode heuristic.
//
// Base URL resolution: the vault's `integrations.food.url` wins when set;
// otherwise falls back to the operator default injected by cmd/cloud into
// the served page as a <meta name="medtracker-food-db-url"> tag (a
// CSP-safe carrier — the origin's script-src 'self' blocks inline scripts;
// see internal/cloudserver/router.go's injectCloudBoot + CLOUD_FOOD_DB_URL
// in docs/environment.md) — or, in iOS local mode, the trial port below.
// Neither available = remote search disabled: search()
// returns [] rather than throwing, so a local-only lookup still succeeds,
// but remoteConfigured() reports false so callers can tell "no food DB" from
// "no matches" — a user who typed a query and got nothing deserves to know
// which it was (med-1j1).
//
// The operator's DB is reached through the operatorFoodDb port:
//   available()                 whether it can be asked at all
//   get(pathAndQuery, signal)   → Response of GET /api/food/<…> (or null)
//   hint()                      optional: why it is unavailable, as UI copy
// The cloud's (the default, SAME_ORIGIN_FOOD_DB) is the meta above plus
// same-origin /api/food/*. iOS local mode has no meta and no account:
// local-policy.js LOCAL_FOOD_DB sends the same paths to the base domain's
// attest-gated /api/attest/food/* routes while the free trial is on
// (bd med-o7zq.20).
const FETCH_TIMEOUT_MS = 10000;

function operatorFoodDbURL() {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="medtracker-food-db-url"]')?.content || '';
}

export const SAME_ORIGIN_FOOD_DB = {
  available: () => !!operatorFoodDbURL(),
  get: (pathAndQuery, signal) => fetch(pathAndQuery, { headers: {}, signal }),
};

function isBarcode(query) {
  return query.length >= 8 && /^[0-9]+$/.test(query);
}

// normalizeFoodProductName ports normalizeFoodProductName (openfoodfacts_api.go).
// Product names come from an untrusted food-DB response, so entity-decode via a
// <textarea> (RCDATA — character refs decode, tags stay inert text) rather than
// a <div>+innerHTML sink, which would parse `<img onerror=…>` into a live
// element and fire the handler even detached. Matches Go's html.UnescapeString.
function normalizeFoodProductName(name) {
  const el = document.createElement('textarea');
  el.innerHTML = name || '';
  let decoded = (el.value || '').trim();
  if (!decoded) return '';
  if (decoded.includes('%')) {
    try {
      decoded = decodeURIComponent(decoded).trim();
    } catch { /* leave as-is on malformed escape */ }
  }
  return decoded;
}

function mapFastFoodProduct(p) {
  return {
    name: normalizeFoodProductName(p.name),
    barcode: p.barcode || undefined,
    carbs_100g: p.carbs || 0,
    protein_100g: p.protein || 0,
    fat_100g: p.fat || 0,
    energy_kcal_100g: p.kcal100g || 0,
    usage_count: 0,
    is_meal: false,
  };
}

// doFetch(signal) → Response (or null).
async function fetchJson(doFetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(controller.signal);
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// createFoodDbClient builds the foodDb port — settingsDomain is a
// web/domain/settings.js instance whose readIntegrationsUnmasked() supplies
// the raw food.url/food.api_key (never exposed through any /api shim route).
export function createFoodDbClient({ settingsDomain, operatorFoodDb = SAME_ORIGIN_FOOD_DB }) {
  const remote = (url, apiKey) => fetchJson((signal) => fetch(url, { headers: apiKey ? { 'X-API-Key': apiKey } : {}, signal }));
  const operator = (pathAndQuery) => fetchJson((signal) => operatorFoodDb.get(pathAndQuery, signal));

  async function baseURL() {
    const { food } = await settingsDomain.readIntegrationsUnmasked();
    const configured = (food.url || '').trim();
    if (configured) return { url: configured.replace(/\/$/, ''), apiKey: food.api_key, isOperatorDefault: false };
    // Mirror Go SearchRemoteAPI: fall back to the bare `domain` field (bare host
    // → https://) before the operator default. Still the user's own DB, so the
    // vault-held key is forwarded here (unlike the operator fallback below).
    const domain = (food.domain || '').trim();
    if (domain) {
      const withScheme = /^https?:\/\//.test(domain) ? domain : `https://${domain}`;
      return { url: withScheme.replace(/\/$/, ''), apiKey: food.api_key, isOperatorDefault: false };
    }
    if (!(await operatorFoodDb.available())) return null;
    // Falling back to the operator's default DB: never forward the user's
    // vault-held food-DB key to the operator (zero-knowledge break) — that key
    // was meant for the user's own provider, not the operator's host.
    // isOperatorDefault routes it through the port (the operator's proxy).
    return { url: '', apiKey: '', isOperatorDefault: true };
  }

  async function search(query) {
    const cfg = await baseURL();
    if (!cfg) return [];

    let data;
    if (isBarcode(query)) {
      data = cfg.isOperatorDefault
        ? await operator(`/api/food/barcode/${encodeURIComponent(query)}`)
        : await remote(`${cfg.url}/api/v1/food/barcode/${encodeURIComponent(query)}`, cfg.apiKey);
      if (!data || !data.name) return [];
      return [mapFastFoodProduct(data)];
    }

    data = cfg.isOperatorDefault
      ? await operator(`/api/food/search?q=${encodeURIComponent(query)}&limit=20`)
      : await remote(`${cfg.url}/api/v1/food/search?q=${encodeURIComponent(query)}&limit=20`, cfg.apiKey);
    const results = (data && data.results) || [];
    return results.filter((p) => p.name).map(mapFastFoodProduct);
  }

  // Whether any remote food DB is reachable at all: a BYO url/domain in the
  // vault, or the operator's DB through the operatorFoodDb port (the cloud's
  // CLOUD_FOOD_DB_URL default; local mode's trial). False means search()
  // can only ever return local results, which the UI must say out loud.
  async function remoteConfigured() {
    return (await baseURL()) !== null;
  }

  // Why no remote food DB can be asked right now, as UI copy, or '' (one can,
  // or the port has nothing to say — the UI keeps its own default copy).
  async function remoteHint() {
    if (await baseURL()) return '';
    return (operatorFoodDb.hint && operatorFoodDb.hint()) || '';
  }

  return { search, remoteConfigured, remoteHint };
}
