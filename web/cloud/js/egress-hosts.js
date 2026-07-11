// Egress-host registration (CSP allowlist). The account app document (`/`)
// serves a per-account `connect-src` scoped to exactly the provider hostnames
// this account uses browser-direct (see internal/cloudserver/router.go +
// docs/cloud-crypto.md). This module tells the server those hostnames after
// unlock and whenever a provider URL changes. It carries HOSTNAMES ONLY —
// never provider API keys, never health data.

// hostsFromIntegrations extracts the unique lowercased hostnames the DEK page
// connects to browser-direct: the BYO AI provider (openai.url / vision_url)
// and the BYO food-DB (food.url). api.elevenlabs.io is fixed and always
// allowed server-side, so it is intentionally NOT included here. Unparseable
// or empty URLs (e.g. an unset provider, or a bare host with no scheme) are
// skipped rather than registered.
export function hostsFromIntegrations(integrations) {
  const urls = [
    integrations && integrations.openai && integrations.openai.url,
    integrations && integrations.openai && integrations.openai.vision_url,
    integrations && integrations.food && integrations.food.url,
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
    if (host && !hosts.includes(host)) hosts.push(host);
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
