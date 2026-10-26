// Headless repro for med-ku8r: "Send photo" during a trial-agent voice call.
//
//   invite claim -> PRF passkey -> trial voice consent -> call (fake mic)
//   -> in_call -> test JPEG on the hidden photo input -> marker user_message
//   -> next relay turn to the trial vision model
//
// Stops once the photo send settles: reports any ElevenLabs /files request
// (there must be none), the SDK user_message frames, the vision turn's status,
// the call-bar status line, console warnings, and a screenshot. Logs go to
// stderr; stdout carries exactly one JSON line:
//   {files_requests, failed_requests, user_messages, vision_status, callbar, console, verdict, detail}
// verdict: PASS (no /files request, the marker was sent, no error on the call
// bar), REPRO (any of those failed), BLOCKED (never got as far as the send).
//
//   BASE_URL=https://acct.example.com CLAIM_TOKEN=abc… node trial-photo-call.mjs
//
// Same harness as vault-roundtrip.mjs: Chromium + CDP virtual authenticator
// with PRF, since auth is passkey-only.

import { chromium } from 'playwright';

const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const CLAIM_TOKEN = process.env.CLAIM_TOKEN || '';
const HEADLESS = process.env.HEADED !== '1';
const SCREENSHOT = process.env.SCREENSHOT || 'trial-photo.png';

const log = (msg) => console.error(msg);
const result = {
  files_requests: 0, failed_requests: {}, user_messages: [], vision_status: null, callbar: null, console: [], verdict: 'BLOCKED', detail: '',
};

class Blocked extends Error {}

async function main() {
  if (!BASE_URL || !CLAIM_TOKEN) throw new Blocked('BASE_URL and CLAIM_TOKEN are required');

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['microphone'] });
  // Record the SDK's user_message frames (the photo marker) as the page sends them.
  await context.addInitScript(() => {
    window.__e2eUserMessages = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const f = typeof data === 'string' ? JSON.parse(data) : null;
        if (f && f.type === 'user_message') window.__e2eUserMessages.push(f.text);
      } catch { /* not JSON */ }
      return send.call(this, data);
    };
  });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'warning' || m.type() === 'error') {
      result.console.push(`[${m.type()}] ${m.text()}`.slice(0, 500));
      log(`    [browser ${m.type()}] ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => result.console.push(`[pageerror] ${e.message}`.slice(0, 500)));
  // Which requests fail (e.g. ERR_INSUFFICIENT_RESOURCES = a request burst), counted per path.
  page.on('requestfailed', (r) => {
    const key = `${r.method()} ${new URL(r.url()).pathname} ${r.failure()?.errorText || ''}`;
    result.failed_requests[key] = (result.failed_requests[key] || 0) + 1;
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true, hasPrf: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    },
  });

  try {
    await claimInvite(page);
    await dismissFirstRun(page);
    await grantVoiceConsent(page);
    await startCall(page);
    await sendPhoto(page);
  } finally {
    try {
      result.callbar = result.callbar ?? await readCallbar(page);
      await page.screenshot({ path: SCREENSHOT, fullPage: true });
      log(`  screenshot: ${SCREENSHOT}`);
    } catch (e) {
      log(`  screenshot failed: ${e.message}`);
    }
    await browser.close();
  }
}

async function claimInvite(page) {
  log('→ claiming the invite with a PRF passkey');
  await page.goto(`${BASE_URL}/#claim=${CLAIM_TOKEN}`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/unlock/, { timeout: 30_000 });
  await page.locator('#create-passkey, #unlock-instead').first().waitFor({ timeout: 30_000 });
  if (await page.locator('#unlock-instead').count()) throw new Blocked('invite already claimed — mint a fresh one');
  await page.click('#create-passkey');

  // Signup tail: optional Telegram step, kit offer, mobile install nudge —
  // each skippable; the app is reached once the vault ctx exists.
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (await page.evaluate(() => Boolean(window.MedTrackerCloud?.ctx)).catch(() => false)) break;
    for (const sel of ['#tg-skip', '#kit-done', '#install-skip']) {
      const el = page.locator(sel);
      if (await el.isVisible().catch(() => false)) await el.click().catch(() => {});
    }
    const err = await page.locator('.wizard-error:visible').first().textContent().catch(() => null);
    if (err && err.trim()) throw new Blocked(`signup wizard error: ${err.trim()}`);
    if (Date.now() > deadline) throw new Blocked(`vault never opened after passkey creation (url ${page.url()})`);
    await page.waitForTimeout(1_000);
  }
  await page.waitForFunction(() => Boolean(window.MedTrackerCloudReady), null, { timeout: 60_000 });
  await page.evaluate(() => window.MedTrackerCloudReady);
  log('  ✓ vault open');
}

// W1/W2 first-run overlay: Skip the feature picker, "Not now" the AI trial.
async function dismissFirstRun(page) {
  const overlay = page.locator('#wg-firstrun-overlay');
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1_000);
    if (!(await overlay.isVisible().catch(() => false))) {
      if (i >= 3) break; // give the overlay a few seconds to mount at all
      continue;
    }
    const btn = overlay.getByRole('button', { name: /^(Skip|Not now)$/ }).first();
    if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
  }
  if (await overlay.isVisible().catch(() => false)) {
    await page.evaluate(() => window.WGFirstRun?.dismiss?.());
  }
  log('  ✓ first-run overlay cleared');
}

// What Settings → Integrations' consent toggle does (PATCH the vault record).
// The in-call consent sheet is still clicked below if it shows anyway.
async function grantVoiceConsent(page) {
  log('→ granting trial voice consent');
  const consent = await page.evaluate(async () => {
    const cur = await window.apiCall('/api/settings/trial-consent', 'GET').catch(() => null);
    if (cur && cur.voice === true) return cur;
    await window.apiCall('/api/settings/trial-consent', 'PATCH', { voice: true });
    return window.apiCall('/api/settings/trial-consent', 'GET');
  });
  if (!consent || consent.voice !== true) throw new Blocked(`voice consent did not stick: ${JSON.stringify(consent)}`);
  log('  ✓ voice consent on');
}

async function readCallbar(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('.wg-callbar__call')?.closest('.wg-callbar, [data-state]');
    if (!bar) return null;
    const text = (sel) => bar.querySelector(sel)?.textContent?.trim() || '';
    return {
      state: bar.dataset.state || '',
      label: text('.wg-callbar__label'),
      status: text('.wg-callbar__status'),
      error: text('.wg-callbar__error'),
    };
  }).catch(() => null);
}

async function startCall(page) {
  log('→ starting the call');
  await page.evaluate(() => window.switchTab?.('today'));
  await page.locator('.wg-callbar__call').first().waitFor({ state: 'attached', timeout: 30_000 })
    .catch(() => { throw new Blocked('no call bar on Today'); });

  const trial = await page.evaluate(() => document.querySelector('meta[name="medtracker-trial-voice"]')?.content === '1');
  if (!trial) throw new Blocked('trial voice is not configured on this server (no medtracker-trial-voice meta)');

  // DOM click: immune to anything docked over the bar.
  await page.evaluate(() => document.querySelector('.wg-callbar__call').click());

  const deadline = Date.now() + 45_000;
  for (;;) {
    const allow = page.locator('[data-trial-consent-choice="allow"]');
    if (await allow.isVisible().catch(() => false)) await allow.click().catch(() => {});
    const bar = await readCallbar(page);
    if (bar?.state === 'in_call') {
      log(`  ✓ in_call (${bar.status})`);
      return;
    }
    if (bar?.state === 'error') {
      result.callbar = bar;
      throw new Blocked(`call failed before in_call: ${bar.error || bar.status}`);
    }
    if (Date.now() > deadline) {
      result.callbar = bar;
      throw new Blocked(`call never reached in_call (state ${bar?.state})`);
    }
    await page.waitForTimeout(500);
  }
}

// "BP 120/80" in big black text on white, encoded by the browser itself.
async function testJpeg(page) {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1200; c.height = 800;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#000'; g.font = 'bold 200px sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('BP 120/80', c.width / 2, c.height / 2);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  });
  return Buffer.from(b64, 'base64');
}

// Since the med-ku8r re-shape the photo never goes to ElevenLabs: the page
// queues it, sends the marker as an SDK user_message, and the next relay turn
// carries it to the trial vision model (POST /api/trial/openai/…?vision=1).
async function sendPhoto(page) {
  log('→ sending the test photo');
  const jpeg = await testJpeg(page);
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/conversations\/[^/]+\/files$/.test(new URL(r.url()).pathname)) result.files_requests += 1;
  });
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.pathname === '/api/trial/openai/chat/completions' && u.searchParams.get('vision') === '1') {
      result.vision_status = r.status();
      log(`  vision turn → ${r.status()}`);
    }
  });
  await page.locator('.wg-callbar__photo-input').first()
    .setInputFiles({ name: 'bp.jpg', mimeType: 'image/jpeg', buffer: jpeg });

  // sendPhoto settles once the vision turn was answered (or failed).
  const deadline = Date.now() + 60_000;
  let st = null;
  for (;;) {
    await page.waitForTimeout(1_000);
    st = await page.evaluate(() => window.WGCallAgent?.getState?.()).catch(() => null);
    if (!st || !st.uploading || Date.now() > deadline) break;
  }
  result.user_messages = await page.evaluate(() => window.__e2eUserMessages || []).catch(() => []);
  result.callbar = await readCallbar(page);
  const bar = result.callbar || {};
  const photoError = (st && st.photoError) || '';
  const barText = `${bar.status || ''} ${bar.error || ''}`;
  const barError = bar.state !== 'in_call' || Boolean(photoError) || /couldn't send|rejected|failed|error/i.test(barText);
  const marked = result.user_messages.includes('[User sent a photo]');

  if (!result.files_requests && !barError && marked) {
    result.verdict = 'PASS';
    result.detail = `marker sent, vision turn ${result.vision_status ?? 'not seen'}, call bar: ${barText.trim() || bar.state}`;
  } else {
    result.verdict = 'REPRO';
    result.detail = `files requests ${result.files_requests}; marker ${marked ? 'sent' : 'NOT sent'}; `
      + `vision turn ${result.vision_status ?? 'not seen'}; call bar [${bar.state}] ${photoError || barText.trim()}`;
  }
}

main()
  .catch((err) => {
    result.verdict = err instanceof Blocked ? 'BLOCKED' : 'REPRO';
    result.detail = err.message;
  })
  .finally(() => {
    result.console = result.console.slice(-15);
    console.log(JSON.stringify(result));
  });
