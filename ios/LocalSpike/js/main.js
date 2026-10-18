// Local-mode GO/NO-GO diagnostic page (bd med-o7zq.1). Served by the iOS
// shell's WKURLSchemeHandler (ios/App/LocalSpike.swift) on a custom-scheme
// origin; not part of the web app. Checks are numbered as in the bead and in
// docs/ios.md. A result is PASS/FAIL only when this page can decide it; the
// owner decides MANUAL rows on the device, INFO rows feed those decisions.
import { nested } from './nested/a.js';

window.__wgMainRan = true;

const ITEMS = [
  ['1', 'Secure context + WebCrypto AES-GCM'],
  ['2', 'IndexedDB write/read; survives kill + update'],
  ['2k', 'Non-extractable AES key in IndexedDB survives'],
  ['3', 'ES modules: nested, root-relative, ../, dynamic, MIME'],
  ['4', 'Blob download → share sheet'],
  ['5', 'Camera getUserMedia + readable frame (barcode path)'],
  ['6', 'CSP from scheme-handler header enforced'],
  ['7', 'WebKit data location + file protection'],
  ['8', 'Native bridge on the custom origin'],
  ['9', 'BYOK fetch + CORS preflight from this origin'],
  ['10', 'Backup → restore keeps IndexedDB'],
  ['11', 'Eviction / persistent storage'],
  ['12', 'isExcludedFromBackup on WebKit data dir'],
];
const results = new Map(ITEMS.map(([id, name]) => [id, { name, status: 'pending', detail: '' }]));
let env = {};
let nativeText = '';

const $ = (id) => document.getElementById(id);
const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wgSpike;
const errText = (e) => (e && (e.name || e.message) ? `${e.name || 'Error'}: ${e.message || ''}` : String(e));

function set(id, status, detail) {
  results.set(id, { ...results.get(id), status, detail });
  render();
}

function reportText() {
  const head = `wg local-mode spike · build ${env.build || '?'} (${env.version || '?'}) · iOS ${env.ios || '?'} · ${env.model || '?'} · origin ${location.origin} · ${new Date().toISOString()}` +
    (env.error ? ` · /env.json FAILED (${env.error}): launch ids are per page load` : '');
  const rows = [...results].map(([id, r]) => `#${id} ${r.status} ${r.name} — ${r.detail}`);
  const viol = `CSP violations seen: ${(window.__wgViolations || []).join('; ') || 'none'}`;
  return [head, ...rows, viol, nativeText ? `\n— native (over the bridge) —\n${nativeText}` : ''].join('\n');
}

function render() {
  const body = $('results').tBodies[0];
  body.replaceChildren(...[...results].map(([id, r]) => {
    const tr = document.createElement('tr');
    const cells = [`#${id}`, r.status, `${r.name}${r.detail ? ' — ' + r.detail : ''}`];
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (i === 1) td.className = `st ${r.status}`;
      tr.append(td);
    });
    return tr;
  }));
  $('report').textContent = reportText();
}

async function sendReport() {
  if (!bridge) return;
  try { await bridge.postMessage({ op: 'report', text: reportText() }); } catch { /* #8 already says why */ }
}

// ---- 1 ----
async function checkCrypto() {
  const subtle = window.crypto && crypto.subtle;
  if (!window.isSecureContext || !subtle) {
    set('1', 'FAIL', `isSecureContext=${window.isSecureContext} crypto.subtle=${!!subtle}`);
    return;
  }
  const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('wg-local-spike'));
  const pt = new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
  const pbkdf2 = await subtle.importKey('raw', new TextEncoder().encode('pw'), 'PBKDF2', false, ['deriveKey']);
  await subtle.deriveKey({ name: 'PBKDF2', salt: iv, iterations: 1000, hash: 'SHA-256' }, pbkdf2,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  set('1', pt === 'wg-local-spike' ? 'PASS' : 'FAIL',
    `isSecureContext=true, AES-GCM round trip ${pt === 'wg-local-spike' ? 'ok' : 'MISMATCH'}, PBKDF2 deriveKey ok, randomUUID=${typeof crypto.randomUUID === 'function'}`);
}

// ---- 2 / 2k / 10 ----
const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const done = (t) => new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = t.onabort = () => reject(t.error); });

async function checkIndexedDB() {
  const open = indexedDB.open('wg-local-spike', 1);
  open.onupgradeneeded = () => {
    open.result.createObjectStore('launches', { autoIncrement: true });
    open.result.createObjectStore('kv');
  };
  const db = await req(open);
  const before = await req(db.transaction('launches').objectStore('launches').getAll());
  let sealed = await req(db.transaction('kv').objectStore('kv').get('sealed'));

  const me = { launch: env.launch, build: env.build, vendor: env.vendor, at: new Date().toISOString() };
  let fresh = false;
  let keyError = null;
  if (!sealed) {
    // Before the write transaction: awaiting WebCrypto inside it would let it
    // auto-commit. A crypto failure is 2k's, never 2's.
    try {
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('sealed'));
      sealed = { key, iv, ct, ...me };
      fresh = true;
    } catch (e) {
      keyError = e;
    }
  }
  // 'strict': complete fires only once the write is flushed to disk. Only
  // then say "persisted" — owner step 2a kills the app right after seeing it.
  const t = db.transaction(['launches', 'kv'], 'readwrite', { durability: 'strict' });
  t.objectStore('launches').add(me);
  if (fresh) t.objectStore('kv').put(sealed, 'sealed');
  await done(t);
  $('persist').textContent = `Launch ${me.launch} persisted (IndexedDB transaction complete, ${new Date().toISOString()}).`;
  const after = await req(db.transaction('launches').objectStore('launches').getAll());
  const wrote = after.some((r) => r.launch === me.launch);
  const prior = before.filter((r) => r.launch !== me.launch);
  const builds = [...new Set(prior.map((r) => r.build))];
  const vendors = [...new Set(after.map((r) => r.vendor))];
  const first = prior[0];
  set('2', wrote ? (prior.length ? 'PASS' : 'MANUAL') : 'FAIL',
    `${wrote ? 'write+read ok' : 'write NOT read back'}; ${prior.length} earlier launch(es)` +
    (first ? `, first ${first.at} on build ${first.build}; builds seen ${builds.join(',')}` : ' — kill + relaunch, then update the build, and reopen') +
    `; this launch ${me.launch} build ${me.build}`);

  try {
    if (keyError) throw keyError;
    const pt = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, sealed.key, sealed.ct));
    const same = sealed.launch === me.launch;
    const from = same ? 'created this launch — kill + relaunch to test' : `from launch ${sealed.launch} build ${sealed.build} (${sealed.at})`;
    set('2k', pt === 'sealed' ? (same ? 'MANUAL' : 'PASS') : 'FAIL',
      `key extractable=${sealed.key.extractable}, decrypt ${pt === 'sealed' ? 'ok' : 'MISMATCH'}, ${from}`);
  } catch (e) {
    set('2k', 'FAIL', `stored key unusable: ${errText(e)}`);
  }

  set('10', 'MANUAL', `vendor ids in history: ${vendors.join(', ')} (this install ${env.vendor}). After restore onto another device, the history above must still list the old launches.`);
}

async function checkStorage() {
  const s = navigator.storage;
  if (!s) { set('11', 'INFO', 'navigator.storage missing'); return; }
  const was = s.persisted ? await s.persisted() : 'n/a';
  const granted = s.persist ? await s.persist() : 'n/a';
  const now = s.persisted ? await s.persisted() : 'n/a';
  const est = s.estimate ? await s.estimate() : {};
  const mb = (n) => (typeof n === 'number' ? `${(n / 1048576).toFixed(1)} MB` : '?');
  set('11', 'MANUAL', `persisted before=${was}, persist()=${granted}, after=${now}; usage ${mb(est.usage)} of quota ${mb(est.quota)}. Eviction itself is a manual run (docs/ios.md).`);
}

// ---- 3 ----
async function checkModules() {
  const staticOk = nested.a === 'a' && nested.b === 'b' && nested.c === 'c';
  const { dyn } = await import('/js/dyn.js');
  const res = await fetch('/js/dyn.js');
  const mime = res.headers.get('content-type') || '';
  const ok = staticOk && dyn === 'dyn' && /javascript/.test(mime);
  set('3', ok ? 'PASS' : 'FAIL',
    `static nested ${staticOk ? 'ok' : 'FAILED'} (/static/b.js, ../../domain/c.js), dynamic import ${dyn === 'dyn' ? 'ok' : 'FAILED'}, MIME "${mime}", import.meta.url ${nested.url}`);
}

// ---- 6 ----
async function checkCSP() {
  const inlineBlocked = !window.__wgInlineRan;
  let evalBlocked = false;
  try { (0, eval)('1'); } catch { evalBlocked = true; }
  let connectBlocked = false;
  try { await fetch('https://example.com/', { mode: 'no-cors' }); } catch { connectBlocked = true; }
  // The violation event can arrive a tick after the rejection.
  await new Promise((r) => setTimeout(r, 300));
  const viol = window.__wgViolations || [];
  const sawConnect = viol.some((v) => v.startsWith('connect-src'));
  const ok = inlineBlocked && evalBlocked && connectBlocked && sawConnect;
  set('6', ok ? 'PASS' : 'FAIL',
    `inline script blocked=${inlineBlocked}, eval blocked=${evalBlocked}, fetch to a host outside connect-src blocked=${connectBlocked} (violation event=${sawConnect})`);
}

// ---- 8 (+ native rows 7, 12) ----
async function checkBridge() {
  if (!bridge) {
    set('8', 'FAIL', 'no wgSpike message handler on this origin (app-bound restriction?) — use the native Report button for 7/12');
    set('7', 'INFO', 'see the native Report button');
    set('12', 'INFO', 'see the native Report button');
    return;
  }
  try {
    const o = await bridge.postMessage({ op: 'origin' });
    const ok = o && o.protocol === env.scheme && o.host === 'local' && o.mainFrame === true;
    set('8', ok ? 'PASS' : 'FAIL', `reply received; native saw securityOrigin protocol="${o.protocol}" host="${o.host}" port=${o.port} mainFrame=${o.mainFrame}`);
  } catch (e) {
    set('8', 'FAIL', `postMessage rejected: ${errText(e)}`);
    return;
  }
  try {
    nativeText = await bridge.postMessage({ op: 'native' });
    const has = (needle) => nativeText.includes(needle);
    set('7', 'INFO', !has('our origin dir: not found') ?'origin dir found — see native section below' : 'origin dir NOT found — see native section below');
    // Native clears the flag WebKit sets on a new origin dir (bd med-o7zq.11).
    // PASS only when nothing in the chain is excluded now and no clear
    // failed: check 10 is invalid otherwise. Owner just sends the report.
    const now = (nativeText.split('\n').find((l) => l.startsWith('#12 now: ')) || '').slice(9);
    const clean = now.includes('origin excluded=false') && !now.includes('excluded=true')
      && !now.includes('unreadable') && !has('cleared FAILED');
    set('12', clean ? 'PASS' : 'FAIL',
      `${clean ? 'origin dir and parents in the backup now' : 'origin dir (or a parent) still excluded from backup, or a clear failed'}`
      + `${has('found=true cleared ok') ? '; WebKit had excluded it, cleared on a launch (history below)' : ''}; see native section below`);
  } catch (e) {
    set('7', 'INFO', `native report unavailable: ${errText(e)}`);
  }
}

// ---- 9 ----
async function probe(url, headers) {
  try {
    const r = await fetch(url, { headers, referrerPolicy: 'no-referrer' });
    return { ok: true, text: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, text: `rejected (${errText(e)})` };
  }
}

async function checkBYOK() {
  // A dummy key: a resolved fetch (401) proves the preflight and CORS passed;
  // a rejection is a CORS (or CSP/network) refusal. Same request shape as
  // web/cloud/js/aiclient.js fetchModelIds.
  const dummy = 'sk-wg-spike-invalid';
  const openai = await probe('https://api.openai.com/v1/models', { Authorization: `Bearer ${dummy}` });
  const anthropicApp = await probe('https://api.anthropic.com/v1/models', { Authorization: `Bearer ${dummy}` });
  const anthropicNative = await probe('https://api.anthropic.com/v1/models', {
    'x-api-key': dummy, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true',
  });
  const prev = results.get('9').detail.split(' | own key: ')[1];
  set('9', openai.ok && (anthropicApp.ok || anthropicNative.ok) ? 'PASS' : 'FAIL',
    `dummy key — OpenAI ${openai.text}; Anthropic (Bearer, as aiclient.js) ${anthropicApp.text}; Anthropic (x-api-key + direct-browser header) ${anthropicNative.text}` +
    (prev ? ` | own key: ${prev}` : ' | own key: not tried (optional, form above)'));
}

async function ownKey() {
  const [url, kind] = $('provider').value.split('|');
  const key = $('key').value.trim();
  if (!key) return;
  const headers = kind === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
    : { Authorization: `Bearer ${key}` };
  const r = await probe(url, headers);
  $('key').value = '';
  const base = results.get('9').detail.split(' | own key: ')[0];
  const success = r.text === 'HTTP 200';
  set('9', success ? 'PASS' : results.get('9').status, `${base} | own key: ${kind} GET /v1/models ${r.text}${success ? ' (successful request)' : ''}`);
  sendReport();
}

// ---- 5 ----
async function camera() {
  set('5', 'pending', 'asking for the camera…');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = $('video');
    video.srcObject = stream;
    await video.play();
    for (let i = 0; i < 50 && !video.videoWidth; i++) await new Promise((r) => setTimeout(r, 100));
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);
    const px = ctx.getImageData(0, 0, Math.min(64, canvas.width), Math.min(64, canvas.height)).data;
    let sum = 0;
    for (const v of px) sum += v;
    const tracks = stream.getVideoTracks().length;
    set('5', tracks > 0 && canvas.width > 0 ? 'PASS' : 'FAIL',
      `videoTracks=${tracks}, frame ${canvas.width}x${canvas.height} readable (pixel sum ${sum}), BarcodeDetector=${'BarcodeDetector' in window}`);
  } catch (e) {
    set('5', 'FAIL', `${errText(e)}; mediaDevices=${!!navigator.mediaDevices}`);
  } finally {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  }
  sendReport();
}

// ---- 4 ----
function share() {
  const blob = new Blob([reportText() + '\n'], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'wg-local-spike-report.txt';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  set('4', 'MANUAL', 'download started — PASS only if the share sheet opened with wg-local-spike-report.txt');
}

async function copy() {
  try {
    await navigator.clipboard.writeText(reportText());
    $('status').textContent = 'Report copied.';
  } catch (e) {
    $('status').textContent = `Copy failed: ${errText(e)} — use Share or the native Report button.`;
  }
}

async function run(id, fn) {
  try { await fn(); } catch (e) { set(id, 'FAIL', errText(e)); }
}

async function main() {
  $('share').addEventListener('click', share);
  $('copy').addEventListener('click', copy);
  $('camera').addEventListener('click', camera);
  $('keytest').addEventListener('click', ownKey);
  set('4', 'MANUAL', 'tap "Share report"');
  set('5', 'MANUAL', 'tap "Test camera"');
  render();
  try { env = await (await fetch('/env.json')).json(); } catch (e) { env = { error: errText(e) }; }
  if (!env.launch) {
    // Without the native per-process id every page load counts as a launch:
    // say so in the report rather than record unidentified launches.
    env.launch = `page-${Math.random().toString(36).slice(2, 8)}`;
    $('status').textContent = `/env.json failed (${env.error || 'no launch id'}): relaunch results in #2 are per page load, not per process.`;
  }
  await run('1', checkCrypto);
  await run('3', checkModules);
  await run('6', checkCSP);
  await run('2', checkIndexedDB);
  await run('11', checkStorage);
  await run('9', checkBYOK);
  await run('8', checkBridge); // last: the native scan then sees this launch's IndexedDB writes
  $('status').textContent = 'Automatic checks done. Run the manual ones, then Share or Copy the report.';
  sendReport();
}

main();
