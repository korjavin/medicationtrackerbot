// Voice LLM relay — browser half (bd med-h849.2). The server half is
// internal/cloudserver/voice_llm_relay.go; its frame table is the contract:
//
//   server -> device  {"type":"hello","call":"<token>"}        first frame on attach
//   server -> device  {"id":n,"type":"request","body":{...}}   one completion request
//   server -> device  {"id":n,"type":"cancel"}                 ElevenLabs dropped turn n
//   device -> server  {"id":n,"type":"chunk","data":"<sse>"}   written verbatim
//   device -> server  {"id":n,"type":"end"}
//   device -> server  {"id":n,"type":"error","message":"..."}
//
// No crypto on this leg on purpose: ElevenLabs sends the turn to the server in
// plaintext anyway, and the leg is same-origin under the session cookie (like
// /api/mcp/relay/device). The browser's job is only to call the user's own AI
// (aiClient.chatStream — vault key or the trial proxy) and stream the answer
// back unparsed.

const RECONNECT_MIN_MS = 1000;
// The server keeps a detached call for 30 s (voiceCallGrace); 1+2+4+8+8+8 s of
// backoff spans it, and the first redial past it gets 4404 and stops.
const RECONNECT_MAX_MS = 8000;

// Mirror voiceStatusUnknownCall / voiceStatusReplaced in voice_llm_relay.go:
// the call is gone or another leg took it — redialing can never succeed.
export const STATUS_UNKNOWN_CALL = 4404;
export const STATUS_REPLACED = 4409;

// createVoiceLLMResponder → { start(): Promise<callToken>, stop() }.
// start() dials the device leg and resolves with the hello's call token (the
// value elevenlabs-call.js passes as customLlmExtraBody.call), then serves
// requests until stop(). A blip mid-call redials with ?call=<token> to reclaim.
export function createVoiceLLMResponder({ aiClient, url, now = () => Date.now() }) {
  let ws = null;
  let token = null;
  let stopped = true;
  let pendingStart = null;
  let reconnectTimer = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  const turns = new Map(); // request id -> AbortController

  function wsURL() {
    // `location` only when no url was injected (tests run without one).
    const base = url || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/voice-llm/device`;
    return token ? `${base}?call=${encodeURIComponent(token)}` : base;
  }

  // Frames go back on the socket the request arrived on: the server fails a
  // turn whose leg dropped, so its id means nothing on a newer leg.
  function send(sock, frame) {
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(frame));
  }

  function abortTurns() {
    for (const ctrl of turns.values()) ctrl.abort();
    turns.clear();
  }

  async function serve(sock, id, body) {
    const ctrl = new AbortController();
    turns.set(id, ctrl);
    const t0 = now();
    let ttfc = null;
    let outcome = 'ok';
    try {
      await aiClient.chatStream({
        body,
        signal: ctrl.signal,
        onChunk: (data) => {
          if (ttfc === null) ttfc = now() - t0;
          send(sock, { id, type: 'chunk', data });
        },
      });
      if (ctrl.signal.aborted) outcome = 'cancel';
      else send(sock, { id, type: 'end' });
    } catch (err) {
      if (ctrl.signal.aborted) {
        outcome = 'cancel';
      } else {
        outcome = 'error';
        // Logs only: the server speaks its own fixed sentence, never this.
        send(sock, { id, type: 'error', message: String((err && (err.code || err.message)) || 'error').slice(0, 200) });
      }
    } finally {
      if (turns.get(id) === ctrl) turns.delete(id);
      // Latency for the live-verification bead; sizes/timings only, no content.
      console.debug('[voice-llm] turn', { id, outcome, ttfc_ms: ttfc, total_ms: now() - t0 });
    }
  }

  function onMessage(sock, data) {
    let f;
    try { f = JSON.parse(data); } catch { return; }
    if (!f || typeof f !== 'object') return;
    // A re-attach may deliver a waiting turn's request BEFORE its hello, so
    // requests are served whatever the order.
    if (f.type === 'hello' && typeof f.call === 'string') {
      token = f.call;
      reconnectDelay = RECONNECT_MIN_MS;
      if (pendingStart) { pendingStart.resolve(token); pendingStart = null; }
    } else if (f.type === 'request' && f.id) {
      serve(sock, f.id, f.body);
    } else if (f.type === 'cancel' && f.id) {
      turns.get(f.id)?.abort();
    }
  }

  function fail(reason) {
    const p = pendingStart;
    pendingStart = null;
    stop();
    if (p) p.reject(new Error(reason));
    else console.warn('[voice-llm] relay leg lost:', reason);
  }

  function connect() {
    const sock = new WebSocket(wsURL());
    ws = sock;
    sock.onmessage = (ev) => { if (ws === sock) onMessage(sock, ev.data); };
    sock.onerror = () => {};
    sock.onclose = (ev) => {
      if (ws !== sock) return; // replaced or stopped — not ours to act on
      ws = null;
      abortTurns();
      if (stopped) return;
      const code = ev && ev.code;
      if (!token) { fail(`voice relay closed before hello (${code})`); return; }
      if (code === STATUS_UNKNOWN_CALL || code === STATUS_REPLACED) { fail(`voice relay call ended (${code})`); return; }
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    };
  }

  // start() always opens a fresh call: whatever leg a previous call left is
  // closed first, so one tab never holds two.
  function start() {
    stop();
    stopped = false;
    reconnectDelay = RECONNECT_MIN_MS;
    return new Promise((resolve, reject) => {
      pendingStart = { resolve, reject };
      connect();
    });
  }

  function stop() {
    stopped = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    token = null;
    const p = pendingStart;
    pendingStart = null;
    if (p) p.reject(new Error('voice relay stopped'));
    abortTurns();
    const sock = ws;
    ws = null;
    if (sock) sock.close();
  }

  return { start, stop };
}
