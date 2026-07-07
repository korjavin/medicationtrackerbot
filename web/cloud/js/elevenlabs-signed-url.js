// Browser-direct ElevenLabs signed-URL client for cloud mode. Bot mode mints
// the WebSocket signed URL server-side (to hide the operator's key); cloud has
// no such route, so here the tab mints it directly against api.elevenlabs.io
// using the user's own key read from the vault — the BYO / C2c pattern. The
// key never crosses /api. Mirrors web/cloud/js/aiclient.js's settingsDomain
// credential seam. CORS on get_signed_url returns `allow-origin: *`, so the
// browser can call it directly with the xi-api-key header.
const SIGNED_URL_ENDPOINT = 'https://api.elevenlabs.io/v1/convai/conversation/get_signed_url';

export function createElevenLabsClient({ settingsDomain }) {
  // agentId is the app-provisioned agent (elevenlabs-agent.js provision());
  // fall back to a user-set vault agent_id for the pre-provisioning path.
  async function fetchSignedURL(agentId) {
    const { elevenlabs } = await settingsDomain.readIntegrationsUnmasked();
    if (!elevenlabs || !elevenlabs.api_key) {
      throw new Error('Set your ElevenLabs API key in Settings → Integrations');
    }
    const id = agentId || (elevenlabs && elevenlabs.agent_id);
    if (!id) {
      throw new Error('No ElevenLabs agent — provisioning failed');
    }
    const url = `${SIGNED_URL_ENDPOINT}?agent_id=${encodeURIComponent(id)}`;
    const resp = await fetch(url, { method: 'GET', headers: { 'xi-api-key': elevenlabs.api_key } });
    if (!resp.ok) {
      const err = new Error(`Failed to get signed URL (${resp.status})`);
      err.status = resp.status;
      throw err;
    }
    const data = await resp.json();
    if (!data || !data.signed_url) throw new Error('Response missing signed_url');
    return data.signed_url;
  }

  // hasKey lets the call controller decide vault-BYO vs trial-proxy before
  // provisioning (which needs the user's own key) without duplicating the
  // vault read there.
  async function hasKey() {
    const { elevenlabs } = await settingsDomain.readIntegrationsUnmasked();
    return Boolean(elevenlabs && elevenlabs.api_key);
  }

  return { fetchSignedURL, hasKey };
}
