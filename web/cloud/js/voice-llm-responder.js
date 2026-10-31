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
// The server keeps a detached call for up to 30 s (voiceCallGrace), capped by
// the authenticated call's absolute lifetime. Backoff spans that maximum;
// the first redial after the remaining window gets 4404 and stops.
const RECONNECT_MAX_MS = 8000;
// Bound on start(): the hello is the server's first frame, so a healthy leg
// answers in one round trip.
const START_TIMEOUT_MS = 5000;

// Mirror voiceStatusUnknownCall / voiceStatusReplaced in voice_llm_relay.go:
// the call is gone or another leg took it — redialing can never succeed.
export const STATUS_UNKNOWN_CALL = 4404;
export const STATUS_REPLACED = 4409;
// voiceStatusBudget: an anonymous trial call's grant ran out (bd med-o7zq.22).
// The server sends {"type":"budget_exhausted"} first, then closes with it.
export const STATUS_BUDGET = 4429;

// In-call photos (bd med-ku8r). ElevenLabs refuses file uploads for custom-LLM
// agents, so the call tab keeps the photo itself and tells the agent with this
// marker as a user message (elevenlabs-call.js sendUserMessage). The next turn
// gets the queued photos as image_url parts on its newest marker message, then
// the queue is cleared. Memory only, this tab only: never stored, never sent
// over the relay socket. aiclient.chatStream routes that turn to the vision
// credentials and strips images from later history.
export const PHOTO_MARKER = '[User sent a photo]';
const MAX_PENDING_IMAGES = 3;

// A message's text whether content is a string or OpenAI text parts.
function textOf(m) {
  if (typeof m.content === 'string') return m.content;
  if (!Array.isArray(m.content)) return '';
  return m.content.map((p) => (p && p.type === 'text' ? p.text : '')).join('');
}

// body with the images on its newest user message when that message is the
// marker, else null (the photos are then dropped, not deferred). Only the
// newest user message: aiclient.chatStream routes to vision by that one.
function withImages(body, images) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === 'user') { at = i; break; }
  }
  if (at < 0 || textOf(messages[at]).trim() !== PHOTO_MARKER) return null;
  const next = messages.slice();
  next[at] = {
    ...messages[at],
    content: [
      { type: 'text', text: PHOTO_MARKER },
      ...images.map((p) => ({ type: 'image_url', image_url: { url: p.url } })),
    ],
  };
  return { ...body, messages: next };
}

// createVoiceLLMResponder → { start(): Promise<callToken>, stop(), setPendingImage(), usesTrialAI() }.
// start() dials the device leg and resolves with the hello's call token (the
// value elevenlabs-call.js passes as customLlmExtraBody.call), then serves
// requests until stop(). A blip mid-call redials with ?call=<token> to reclaim.
//
// With `mint` (iOS local mode's anonymous trial, bd med-o7zq.23) the server
// mints the call instead of the first attach: start({ onExhausted }) awaits
// mint() → { call, signedUrl, ... }, dials url?call=<call>, and resolves with
// the mint's result. onExhausted runs once when the call's grant runs out
// (the budget_exhausted frame or close 4429). Without mint (cloud) start()
// is unchanged.
export function createVoiceLLMResponder({ aiClient, url, mint, now = () => Date.now() }) {
  let ws = null;
  let token = null;
  let epoch = 0; // bumped by every stop(): a mint that outlived one is dropped
  let onExhausted = null;
  let stopped = true;
  let pendingStart = null;
  let reconnectTimer = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  const turns = new Map(); // request id -> AbortController
  let pendingImages = []; // { url, resolve, reject }, the next turn's photos

  function settleImages(images, err) {
    for (const p of images) {
      if (err) p.reject(err);
      else p.resolve();
    }
  }

  // A cancelled turn is usually re-sent (ElevenLabs' cascade timeout, a leg
  // blip): its photos go back to the front for the re-sent turn, which drops
  // them if its newest user message is no longer the marker. After stop()
  // there is no next turn, so they fail.
  function requeue(images) {
    if (stopped) settleImages(images, new Error('the call ended'));
    else pendingImages = images.concat(pendingImages);
  }

  // Queues one photo (a data: URL) for the next turn and returns a promise
  // that resolves when that turn was answered, rejects when it failed or never
  // carried the photo. Throws at once (nothing queued) when there is no leg or
  // the queue is full, so the caller doesn't announce a photo that can't ride.
  function setPendingImage(url) {
    if (stopped) throw new Error('the AI relay is not connected');
    if (pendingImages.length >= MAX_PENDING_IMAGES) {
      throw new Error('too many photos waiting, let the agent answer first');
    }
    let entry;
    const answered = new Promise((resolve, reject) => { entry = { url, resolve, reject }; });
    pendingImages.push(entry);
    // cancel(err): take the photo back out of the queue (the caller could not
    // announce it) and reject with err; a no-op once a turn took it.
    answered.cancel = (err) => {
      const i = pendingImages.indexOf(entry);
      if (i < 0) return;
      pendingImages.splice(i, 1);
      entry.reject(err || new Error('photo cancelled'));
    };
    return answered;
  }

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

  async function serve(sock, id, frameBody) {
    const ctrl = new AbortController();
    turns.set(id, ctrl);
    // The queued photos ride this turn only, whatever its outcome.
    const images = pendingImages;
    pendingImages = [];
    let body = frameBody;
    if (images.length) {
      body = withImages(frameBody, images) || frameBody;
      if (body === frameBody) settleImages(images, new Error('the agent did not get the photo, send it again'));
    }
    const carried = body === frameBody ? [] : images;
    const t0 = now();
    let ttfc = null;
    let outcome = 'ok';
    const attempt = () => aiClient.chatStream({
      body,
      signal: ctrl.signal,
      onChunk: (data) => {
        if (ttfc === null) ttfc = now() - t0;
        send(sock, { id, type: 'chunk', data });
      },
    });
    try {
      try {
        await attempt();
      } catch (err) {
        // One retry for a transient failure (a 429/5xx from the provider or
        // trial proxy, or a network TypeError) while nothing has been sent —
        // ElevenLabs would otherwise speak the relay's fallback (bd med-h849.11).
        const status = err && err.status;
        const transient = err instanceof TypeError || status === 429 || status >= 500;
        if (!transient || ttfc !== null || ctrl.signal.aborted) throw err;
        await attempt();
      }
      if (ctrl.signal.aborted) {
        outcome = 'cancel';
        requeue(carried);
      } else {
        send(sock, { id, type: 'end' });
        settleImages(carried);
      }
    } catch (err) {
      if (ctrl.signal.aborted) {
        outcome = 'cancel';
        requeue(carried);
      } else {
        outcome = 'error';
        settleImages(carried, err);
        // Logs only: the server speaks its own fixed sentence, never this.
        send(sock, { id, type: 'error', message: String((err && (err.code || err.message)) || 'error').slice(0, 200) });
      }
    } finally {
      if (turns.get(id) === ctrl) turns.delete(id);
      // Latency for the live-verification bead; sizes/timings only, no content.
      console.debug('[voice-llm] turn', { id, outcome, ttfc_ms: ttfc, total_ms: now() - t0, photos: carried.length });
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
    } else if (f.type === 'budget_exhausted') {
      exhausted();
    }
  }

  function exhausted() {
    const cb = onExhausted;
    if (pendingStart) fail('voice trial budget exhausted');
    else stop(); // expected, not a lost leg: no warning
    if (cb) cb();
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
      if (code === STATUS_BUDGET) { exhausted(); return; }
      if (!token) { fail(`voice relay closed before hello (${code})`); return; }
      if (code === STATUS_UNKNOWN_CALL || code === STATUS_REPLACED) { fail(`voice relay call ended (${code})`); return; }
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    };
  }

  // start() always opens a fresh call: whatever leg a previous call left is
  // closed first, so one tab never holds two.
  function start(opts = {}) {
    if (!mint) return dial();
    stop();
    const e = epoch;
    return mint().then(async (minted) => {
      if (e !== epoch) throw new Error('voice relay stopped');
      await dial(minted.call);
      onExhausted = opts.onExhausted || null;
      return minted;
    });
  }

  function dial(minted) {
    stop();
    token = minted || null;
    stopped = false;
    reconnectDelay = RECONNECT_MIN_MS;
    return new Promise((resolve, reject) => {
      // A leg that opens but never says hello must not hold the call up.
      const timer = setTimeout(() => {
        if (pendingStart === entry) fail('voice relay sent no hello');
      }, START_TIMEOUT_MS);
      const entry = {
        resolve: (t) => { clearTimeout(timer); resolve(t); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      pendingStart = entry;
      connect();
    });
  }

  function stop() {
    epoch += 1;
    onExhausted = null;
    stopped = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    token = null;
    const p = pendingStart;
    pendingStart = null;
    if (p) p.reject(new Error('voice relay stopped'));
    const images = pendingImages;
    pendingImages = [];
    settleImages(images, new Error('the call ended'));
    abortTurns();
    const sock = ws;
    ws = null;
    if (sock) sock.close();
  }

  return { start, stop, setPendingImage, usesTrialAI: () => aiClient.usesTrial() };
}
