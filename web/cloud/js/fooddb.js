// Browser implementation of the foodDb port consumed by createFoodDomain
// (C2c Task 5) — search()/barcode GETs go straight from this device to a
// FastFoodDB-shaped API, keyed from the vault's unmasked
// `integrations.food` record. Never routed through any /api shim surface.
// Mirrors internal/store/food/openfoodfacts_api.go's request/response
// shapes and barcode heuristic.
//
// Base URL resolution: the vault's `integrations.food.url` wins when set;
// otherwise falls back to the operator default injected by cmd/cloud into
// the served page as window.__MEDTRACKER_FOOD_DB_URL__ (see
// internal/cloudserver/router.go's injectCloudBoot + CLOUD_FOOD_DB_URL in
// docs/environment.md). Neither set = remote search silently disabled
// (search() below just returns []), never an error.
const FETCH_TIMEOUT_MS = 10000;

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

async function fetchJson(url, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers = apiKey ? { 'X-API-Key': apiKey } : {};
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
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
export function createFoodDbClient({ settingsDomain }) {
  async function baseURL() {
    const { food } = await settingsDomain.readIntegrationsUnmasked();
    const configured = (food.url || '').trim();
    if (configured) return { url: configured.replace(/\/$/, ''), apiKey: food.api_key };
    const operatorDefault = (typeof window !== 'undefined' && window.__MEDTRACKER_FOOD_DB_URL__) || '';
    if (!operatorDefault) return null;
    return { url: operatorDefault.replace(/\/$/, ''), apiKey: food.api_key };
  }

  async function search(query) {
    const cfg = await baseURL();
    if (!cfg) return [];

    if (isBarcode(query)) {
      const data = await fetchJson(`${cfg.url}/api/v1/food/barcode/${encodeURIComponent(query)}`, cfg.apiKey);
      if (!data || !data.name) return [];
      return [mapFastFoodProduct(data)];
    }

    const data = await fetchJson(`${cfg.url}/api/v1/food/search?q=${encodeURIComponent(query)}&limit=20`, cfg.apiKey);
    const results = (data && data.results) || [];
    return results.filter((p) => p.name).map(mapFastFoodProduct);
  }

  return { search };
}
