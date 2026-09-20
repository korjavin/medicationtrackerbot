/**
 * @vitest-environment jsdom
 *
 * share-landing.test.js (bd med-1yi5.2)
 *
 * The base-domain landing page for the blind workout-share short link:
 * /s/<id>#<K> expands back into a read-only plan preview plus the
 * Add-to-my-Med-Tracker handoff and the copy-plan-code fallback. The page
 * makes exactly one request (GET /api/s/<id>); K, the token and the plan
 * never leave it.
 *
 * The epic's golden vector plaintext carries a gzip blob whose CRC does not
 * verify (and JSON that is not a plan export), so the golden packed blob is
 * asserted as decrypt-to-exact-plaintext in crypto.test.js, while this suite
 * builds its own real p1 token (gzip + base64url, like share.js
 * encodeShareToken) for every end-to-end case.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { fromBase64, gzip, toBase64, toBase64Url, utf8 } from '../crypto.js';
import {
  MSG,
  decodeSharedPlan,
  mount,
  parseShareLink,
  renderPreview,
} from '../share-landing.js';

// A small but realistic export payload (the shape share.js hands to
// encodeShareToken: { v:1, plan:{ name, days:[{ name?, exercises:[{name}] }] } }).
const PLAN = {
  v: 1,
  plan: {
    name: 'Leg Day',
    days: [
      { name: 'Monday', exercises: [{ name: 'Squat' }, { name: 'Lunge' }] },
      { name: 'Friday', exercises: [{ name: 'Deadlift' }] },
    ],
  },
};

async function makeToken(payload) {
  return 'p1.' + toBase64Url(await gzip(utf8(JSON.stringify(payload))));
}

// Independent encrypt path (raw WebCrypto, mirroring the wire contract: fresh
// 16-byte K, 12-byte nonce, AAD utf8('mt/v1/share'), nonce ‖ ct packing, std
// base64 on the wire). The module under test only ever decrypts.
async function encryptShare(keyBytes, token, nonce = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])) {
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: utf8('mt/v1/share') },
    key,
    utf8(token)
  );
  const packed = new Uint8Array(nonce.length + ct.byteLength);
  packed.set(nonce, 0);
  packed.set(new Uint8Array(ct), nonce.length);
  return toBase64(packed);
}

async function freshLink(id = 'Ab3kZ9xQ2m') {
  const keyBytes = crypto.getRandomValues(new Uint8Array(16));
  const token = await makeToken(PLAN);
  return { id, keyBytes, keyFrag: toBase64Url(keyBytes), token, ct: await encryptShare(keyBytes, token) };
}

// The page's real markup, from the epic-fixed share.html skeleton.
function seedPage() {
  document.body.innerHTML = `
    <main class="wizard-step" id="share-app">
      <h1 id="share-title">Shared workout plan</h1>
      <p id="share-status" class="muted">Loading…</p>
      <div id="share-preview" hidden></div>
      <div id="share-actions" hidden>
        <label for="share-home">Your Med Tracker address</label>
        <div class="note-form"><input id="share-home" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="your-name"><span id="share-home-suffix"></span></div>
        <button id="share-add" type="button">Add to my Med Tracker</button>
        <button id="share-copy" type="button">Copy plan code</button>
        <p class="muted"><a id="share-get" href="/">Don't have Med Tracker yet?</a></p>
      </div>
    </main>`;
}

function memStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    _data: data,
  };
}

function stubLocation({ pathname = '/s/Ab3kZ9xQ2m', hash = '', host = 'tracker.test', protocol = 'https:' } = {}) {
  return { pathname, hash, host, protocol, href: `https://${host}${pathname}${hash}` };
}

function q(sel) { return document.querySelector(sel); }
function click(el) { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }
async function flush(times = 5) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  seedPage();
  // crypto.js gzip/gunzip streams through Blob; jsdom's Blob has no .stream(),
  // so swap in Node's for these tests (same seam the node-env suites get).
  vi.stubGlobal('Blob', NodeBlob);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('parseShareLink', () => {
  it('reads the id from the path and the 16-byte key from the fragment', () => {
    const { id, key } = parseShareLink('/s/Ab3kZ9xQ2m', '#ABEiM0RVZneImaq7zN3u_w');
    expect(id).toBe('Ab3kZ9xQ2m');
    expect(Array.from(key)).toEqual([0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255]);
  });

  it('returns a null key for a missing, garbage, or short fragment', () => {
    expect(parseShareLink('/s/Ab3kZ9xQ2m', '').key).toBeNull();
    expect(parseShareLink('/s/Ab3kZ9xQ2m', '#').key).toBeNull();
    expect(parseShareLink('/s/Ab3kZ9xQ2m', '#!!!not-base64!!!').key).toBeNull();
    expect(parseShareLink('/s/Ab3kZ9xQ2m', '#' + toBase64Url(new Uint8Array(15).fill(7))).key).toBeNull();
  });
});

describe('golden E2E shape (self-built token; golden blob asserted in crypto.test.js)', () => {
  it('decrypts, clears the status, and previews the decoded plan', async () => {
    const link = await freshLink();
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ ct: link.ct }) };
    });
    const location = stubLocation({ hash: '#' + link.keyFrag });

    await mount(document, { fetchImpl, location, storage: memStorage(), clipboard: null });

    expect(q('#share-status').textContent).toBe('');
    const preview = q('#share-preview');
    expect(preview.hidden).toBe(false);
    expect(preview.textContent).toContain('Leg Day');
    expect(preview.textContent).toContain('2 days · 3 exercises');
    expect(preview.textContent).toContain('Monday');
    expect(preview.textContent).toContain('Squat');
    expect(preview.textContent).toContain('Deadlift');
    expect(q('#share-actions').hidden).toBe(false);
    expect(q('#share-home-suffix').textContent).toBe('.tracker.test');

    // Only one fetch, to /api/s/<id>, bypassing the HTTP cache.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/s/Ab3kZ9xQ2m');
    expect(calls[0].init).toMatchObject({ cache: 'no-store' });
  });
});

describe('failure states', () => {
  it('missing hash → incomplete message, fetch NOT called', async () => {
    const fetchImpl = vi.fn();
    await mount(document, {
      fetchImpl,
      location: stubLocation({ hash: '' }),
      storage: memStorage(),
      clipboard: null,
    });
    expect(q('#share-status').textContent).toBe(MSG.incomplete);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(q('#share-preview').hidden).toBe(true);
  });

  it('404 → expired message', async () => {
    const link = await freshLink();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    await mount(document, {
      fetchImpl,
      location: stubLocation({ hash: '#' + link.keyFrag }),
      storage: memStorage(),
      clipboard: null,
    });
    expect(q('#share-status').textContent).toBe(MSG.expired);
    expect(q('#share-preview').hidden).toBe(true);
  });

  it('429 → retry message', async () => {
    const link = await freshLink();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    await mount(document, {
      fetchImpl,
      location: stubLocation({ hash: '#' + link.keyFrag }),
      storage: memStorage(),
      clipboard: null,
    });
    expect(q('#share-status').textContent).toBe(MSG.loadFailed);
  });

  it('wrong K → generic error, no preview', async () => {
    const link = await freshLink();
    const wrongFrag = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ct: link.ct }) }));
    await mount(document, {
      fetchImpl,
      location: stubLocation({ hash: '#' + wrongFrag }),
      storage: memStorage(),
      clipboard: null,
    });
    expect(q('#share-status').textContent).toBe(MSG.notPlan);
    expect(q('#share-preview').hidden).toBe(true);
    expect(q('#share-preview').textContent).toBe('');
    expect(q('#share-actions').hidden).toBe(true);
  });

  it('valid decrypt of a non-plan payload → generic error', async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(16));
    const ct = await encryptShare(keyBytes, await makeToken({ v: 1, plan: { name: 'x' } }));
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ct }) }));
    await mount(document, {
      fetchImpl,
      location: stubLocation({ hash: '#' + toBase64Url(keyBytes) }),
      storage: memStorage(),
      clipboard: null,
    });
    expect(q('#share-status').textContent).toBe(MSG.notPlan);
  });
});

describe('Add to my Med Tracker', () => {
  async function readyPage({ storage = memStorage(), protocol = 'https:' } = {}) {
    const link = await freshLink();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ct: link.ct }) }));
    const location = stubLocation({ hash: '#' + link.keyFrag, protocol });
    await mount(document, { fetchImpl, location, storage, clipboard: null });
    return { link, location, storage };
  }

  it('invalid subdomain → inline error, no navigation', async () => {
    const { location } = await readyPage();
    const before = location.href;
    q('#share-home').value = 'Bad Name!';
    click(q('#share-add'));
    expect(q('#share-error').textContent).toBe(MSG.badHome);
    expect(location.href).toBe(before);
  });

  it('empty input → inline error, no navigation', async () => {
    const { location } = await readyPage();
    const before = location.href;
    q('#share-home').value = '   ';
    click(q('#share-add'));
    expect(q('#share-error').textContent).toBe(MSG.badHome);
    expect(location.href).toBe(before);
  });

  it('valid subdomain → storage written and deeplink href assigned', async () => {
    const { link, location, storage } = await readyPage();
    q('#share-home').value = '  My-Home1 ';
    click(q('#share-add'));
    expect(storage._data['mt-share-home']).toBe('my-home1');
    expect(location.href).toBe(`https://my-home1.tracker.test/#share-plan=${link.token}`);
    expect(q('#share-error').textContent).toBe('');
  });

  it('http landing page → http handoff (dev)', async () => {
    const { link, location } = await readyPage({ protocol: 'http:' });
    q('#share-home').value = 'devhome';
    click(q('#share-add'));
    expect(location.href).toBe(`http://devhome.tracker.test/#share-plan=${link.token}`);
  });

  it('prefills the address from storage on the next mount', async () => {
    const storage = memStorage({ 'mt-share-home': 'revisit' });
    await readyPage({ storage });
    expect(q('#share-home').value).toBe('revisit');
  });
});

describe('Copy plan code', () => {
  async function readyPage(clipboard) {
    const link = await freshLink();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ct: link.ct }) }));
    const location = stubLocation({ hash: '#' + link.keyFrag });
    await mount(document, { fetchImpl, location, storage: memStorage(), clipboard });
    return link;
  }

  it('clipboard receives exactly the bare token', async () => {
    const written = [];
    const link = await readyPage({ writeText: async (t) => { written.push(t); } });
    click(q('#share-copy'));
    await flush();
    expect(written).toEqual([link.token]);
    expect(q('#share-copy').textContent).toBe(MSG.copied);
  });

  it('no clipboard API → readonly textarea with the token', async () => {
    const link = await readyPage(null);
    click(q('#share-copy'));
    await flush();
    const area = q('#share-token-fallback');
    expect(area).not.toBeNull();
    expect(area.value).toBe(link.token);
    expect(area.readOnly).toBe(true);
  });
});

describe('preview hygiene', () => {
  it('renders hostile plan text as text, never as markup', () => {
    const evil = {
      v: 1,
      plan: {
        name: '<img src=x onerror=alert(1)>',
        days: [{ name: '<b>day</b>', exercises: [{ name: '<script>alert(2)</script>' }] }],
      },
    };
    renderPreview(q('#share-preview'), evil);
    expect(q('#share-preview').querySelector('img')).toBeNull();
    expect(q('#share-preview').querySelector('script')).toBeNull();
    expect(q('#share-preview').textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('falls back for missing names without throwing', () => {
    renderPreview(q('#share-preview'), { v: 1, plan: { days: [{ exercises: [{}] }, {}] } });
    expect(q('#share-preview').textContent).toContain('Shared workout plan');
    expect(q('#share-preview').textContent).toContain('Day 1');
    expect(q('#share-preview').textContent).toContain('Exercise');
  });
});

describe('decodeSharedPlan guards', () => {
  it('rejects an oversize packed blob without decrypting', async () => {
    const key = crypto.getRandomValues(new Uint8Array(16));
    await expect(decodeSharedPlan(new Uint8Array(16385), key)).rejects.toThrow();
    await expect(decodeSharedPlan(new Uint8Array(0), key)).rejects.toThrow();
  });

  it('rejects a payload whose JSON is not a v1 plan export', async () => {
    const key = crypto.getRandomValues(new Uint8Array(16));
    const ct = await encryptShare(key, await makeToken({ v: 2, plan: { name: 'x', days: [] } }));
    await expect(decodeSharedPlan(fromBase64(ct), key)).rejects.toThrow();
  });
});
