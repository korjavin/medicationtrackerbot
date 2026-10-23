// Egress-host registration (CSP allowlist). The account app document (`/`)
// serves a per-account `connect-src` scoped to exactly the provider hostnames
// this account uses browser-direct (see internal/cloudserver/router.go +
// docs/cloud-crypto.md). This module tells the server those hostnames after
// unlock and whenever a provider URL changes. It carries HOSTNAMES ONLY —
// never provider API keys, never health data.

// canAllowlist mirrors the server's validEgressHost (egress.go): a bare DNS
// hostname only. `new URL().hostname` can yield values the server rejects — an
// IPv6 literal (`[::1]`), an underscore host (`food_db.internal`), a
// trailing-dot FQDN — and the endpoint rejects the WHOLE batch on any invalid
// host, so a single such host would strand every provider's allowlist entry.
// Drop the unallowlistable one client-side instead; the good hosts still
// register (the dropped host simply can't be a clean `https://<host>` source).
// Must stay identical to DEFAULT_URL in aiclient.js — the host the AI client
// actually contacts when the user leaves the provider URL blank.
const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1';

function canAllowlist(host) {
  if (!host || host.length > 253) return false;
  if (host.startsWith('.') || host.startsWith('-')
    || host.endsWith('.') || host.endsWith('-') || host.includes('..')) return false;
  return /^[a-z0-9.-]+$/.test(host);
}

// hostsFromIntegrations extracts the unique lowercased hostnames the DEK page
// connects to browser-direct: the BYO AI provider (openai.url / vision_url)
// and the BYO food-DB (food.url, or the bare-host food.domain fallback that
// fooddb.js baseURL() uses when food.url is unset). api.elevenlabs.io is fixed
// and always allowed server-side, so it is intentionally NOT included here.
// Unparseable or empty URLs (e.g. an unset provider) and hosts the server
// would reject (see canAllowlist) are skipped.
export function hostsFromIntegrations(integrations) {
  const food = (integrations && integrations.food) || {};
  const foodURL = typeof food.url === 'string' ? food.url.trim() : '';
  // food.domain is only contacted when food.url is unset (fooddb.js baseURL()
  // precedence), so only register it then — keep connect-src minimal. It may be
  // a bare host with no scheme; fooddb.js prepends https:// before fetching, so
  // normalize the same way here or new URL() rejects it and it never registers.
  let foodDomain = '';
  if (!foodURL && typeof food.domain === 'string' && food.domain.trim()) {
    foodDomain = food.domain.trim();
    if (!/^https?:\/\//.test(foodDomain)) foodDomain = `https://${foodDomain}`;
  }
  // aiclient.js's credentials() resolves a blank openai.url to DEFAULT_URL, so
  // deriving from the raw stored string alone omitted api.openai.com for the
  // commonest setup of all — paste a key, leave the URL on its placeholder —
  // and CSP-blocked every browser-direct AI call for it. Mirror that fallback
  // here. Gated on a stored key because without one the AI calls go to the
  // same-origin trial proxy instead and connect-src stays minimal. (Found by
  // codex review on bd med-byom; it predates the model list, which only made
  // the breakage visible on a button.) A blank vision_url needs no entry: it
  // resolves to this same host.
  const openai = (integrations && integrations.openai) || {};
  const hasAIKey = !!((typeof openai.api_key === 'string' && openai.api_key.trim())
    || (typeof openai.vision_api_key === 'string' && openai.vision_api_key.trim()));
  const openaiURL = (typeof openai.url === 'string' && openai.url.trim())
    || (hasAIKey ? DEFAULT_OPENAI_URL : '');
  const urls = [
    openaiURL,
    openai.vision_url,
    foodURL,
    foodDomain,
  ];
  const hosts = [];
  for (const raw of urls) {
    if (!raw || typeof raw !== 'string') continue;
    let host;
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      continue; // not an absolute URL — nothing to allowlist
    }
    if (host && canAllowlist(host) && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

// registerEgressHosts reads the unmasked integrations from the vault, derives
// the provider hostnames, and PUTs them to /api/egress-hosts (session-gated).
// Best-effort: returns the registered hosts on success, or null on any failure
// (no fetch available, read error, network/HTTP error) — a failure just leaves
// the server's prior (or fixed-fallback) allowlist in place. Only hostnames
// leave the browser here; api_key fields never enter the request body.
export async function registerEgressHosts({ settings, fetchImpl }) {
  if (typeof fetchImpl !== 'function') return null;
  let hosts;
  try {
    hosts = hostsFromIntegrations(await settings.readIntegrationsUnmasked());
  } catch (e) {
    console.error('[cloud egress] read integrations failed', e);
    return null;
  }
  try {
    const res = await fetchImpl('/api/egress-hosts', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hosts }),
    });
    if (res && res.ok === false) {
      console.error('[cloud egress] register rejected', res.status);
      return null;
    }
  } catch (e) {
    console.error('[cloud egress] register failed', e);
    return null;
  }
  return hosts;
}
