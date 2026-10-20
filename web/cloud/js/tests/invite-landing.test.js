/**
 * @vitest-environment jsdom
 *
 * invite-landing.test.js (bd med-ta2n.10)
 *
 * The base-domain invite landing, https://<base>/i/<sub>#<token>: one
 * token-free GET /api/i/<sub>, then L1 (iPhone / Android), L2 (desktop QR),
 * L3 (iPhone after Get the app, sticky per tab) or L1 · expired. Contract:
 * med-ta2n.7 design field, sections 1 and 4.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASK_TEXT,
  COPY,
  L3_KEY_PREFIX,
  claimHref,
  mount,
  parseInviteLink,
  playHref,
} from '../invite-landing.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SUB = 'alice-7';
const TOKEN = '0123abcdef';
const LANDING = `https://med.example/i/${SUB}#${TOKEN}`;

function fakeLocation(over = {}) {
  return {
    pathname: `/i/${SUB}`,
    hash: `#${TOKEN}`,
    href: LANDING,
    host: 'med.example',
    protocol: 'https:',
    ...over,
  };
}

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

function okFetch(body) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
}

const PENDING = { state: 'pending', expires_at: '2026-11-03T10:00:00Z' };

function seed({ ios = '1234567890', pkg = 'ai.myhealthbot.app' } = {}) {
  document.head.innerHTML = '';
  if (ios) document.head.insertAdjacentHTML('beforeend', `<meta name="medtracker-ios-app-store-id" content="${ios}">`);
  if (pkg) document.head.insertAdjacentHTML('beforeend', `<meta name="medtracker-android-package" content="${pkg}">`);
  document.body.innerHTML = '<main class="wg-app invite-page" id="invite-app"></main>';
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const $ = (id) => document.getElementById(id);
const title = () => document.querySelector('h1').textContent;

async function setup({ platform = 'ios', body = PENDING, metas, location = fakeLocation(), storage = fakeStorage(), share, loadQr } = {}) {
  seed(metas);
  const fetchImpl = okFetch(body);
  const clipboard = { writeText: vi.fn(async () => {}) };
  const nav = { clipboard, ...(share ? { share } : {}) };
  await mount(document, { fetchImpl, location, storage, navigator: nav, platform, ...(loadQr ? { loadQr } : {}) });
  return { fetchImpl, clipboard, location, storage, nav };
}

describe('parseInviteLink', () => {
  it('reads sub from the path and the token from the fragment', () => {
    expect(parseInviteLink('/i/alice-7', '#0123abcdef')).toEqual({ sub: 'alice-7', token: '0123abcdef' });
  });

  it('rejects malformed parts instead of splicing them into URLs', () => {
    expect(parseInviteLink('/i/Alice', '#t')).toEqual({ sub: '', token: 't' });
    expect(parseInviteLink('/i/a/b', '#t').sub).toBe('');
    expect(parseInviteLink('/i/a', '#a"b').token).toBe('');
    expect(parseInviteLink('/i/a', '').token).toBe('');
  });
});

describe('URL builders (pinned contract)', () => {
  it('Play referrer = encodeURIComponent("invite=" + encodeURIComponent(landingUrl))', () => {
    const href = playHref('ai.myhealthbot.app', LANDING);
    const want = encodeURIComponent('invite=' + encodeURIComponent(LANDING));
    expect(href).toBe(`https://play.google.com/store/apps/details?id=ai.myhealthbot.app&referrer=${want}`);
    // What Play hands the app (decoded once): invite=<percent-encoded URL>.
    const referrer = new URL(href).searchParams.get('referrer');
    expect(referrer).toBe('invite=' + encodeURIComponent(LANDING));
    expect(new URLSearchParams(referrer).get('invite')).toBe(LANDING);
  });

  it('claim link is the old form on the account host; http only in dev', () => {
    expect(claimHref(fakeLocation(), SUB, TOKEN)).toBe(`https://${SUB}.med.example/#claim=${TOKEN}`);
    expect(claimHref(fakeLocation({ protocol: 'http:', host: 'localhost:8080' }), SUB, TOKEN))
      .toBe(`http://${SUB}.localhost:8080/#claim=${TOKEN}`);
  });
});

describe('invite landing page', () => {
  beforeEach(() => {
    delete globalThis.WGIcons;
  });

  it('makes exactly one request, to /api/i/<sub>, and never sends the token', async () => {
    for (const platform of ['ios', 'android', 'desktop']) {
      const { fetchImpl } = await setup({ platform, loadQr: async () => ({ qrcode: fakeQr().qrcode }) });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe(`/api/i/${SUB}`);
      expect(JSON.stringify([url, init])).not.toContain(TOKEN);
    }
  });

  it('incomplete link: no request at all', async () => {
    const { fetchImpl } = await setup({ location: fakeLocation({ hash: '' }) });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(COPY.incomplete);
  });

  describe('L1 · iPhone', () => {
    it('renders the frame copy with the expiry date from the status API', async () => {
      await setup();
      expect(title()).toBe(COPY.title);
      expect(document.body.textContent).toContain(COPY.lede);
      expect($('invite-get').textContent).toBe(COPY.getIOS);
      expect($('invite-browser').textContent).toBe(COPY.browser);
      expect($('invite-hint').textContent).toBe('This invite works once and expires on 3 Nov.');
    });

    it('Get the app copies the landing URL, opens the App Store and switches to L3', async () => {
      const { clipboard, location, storage } = await setup();
      $('invite-get').click();
      expect(clipboard.writeText).toHaveBeenCalledWith(LANDING);
      expect(title()).toBe(COPY.l3Title);
      await flush();
      expect(location.href).toBe('https://apps.apple.com/app/id1234567890');
      expect(storage.getItem(L3_KEY_PREFIX + SUB)).toBe('1');
    });

    it('opens the store even when the clipboard write is refused', async () => {
      seed();
      const location = fakeLocation();
      const clipboard = { writeText: vi.fn(async () => { throw new Error('denied'); }) };
      await mount(document, { fetchImpl: okFetch(PENDING), location, storage: fakeStorage(), navigator: { clipboard }, platform: 'ios' });
      $('invite-get').click();
      await flush();
      expect(location.href).toBe('https://apps.apple.com/app/id1234567890');
    });

    it('L3: Open in the app = medtracker://i/<sub>#<token>; store again repeats the store link', async () => {
      const { location, clipboard } = await setup();
      $('invite-get').click();
      await flush();
      expect([...document.querySelectorAll('.wg-olist li')].map((li) => li.textContent)).toEqual(COPY.l3Steps);
      $('invite-open').click();
      expect(location.href).toBe(`medtracker://i/${SUB}#${TOKEN}`);
      $('invite-store-again').click();
      await flush();
      expect(clipboard.writeText).toHaveBeenCalledTimes(2);
      expect(location.href).toBe('https://apps.apple.com/app/id1234567890');
    });

    it('L3 survives a tab return (sessionStorage flag)', async () => {
      const storage = fakeStorage();
      storage.setItem(L3_KEY_PREFIX + SUB, '1');
      await setup({ storage });
      expect(title()).toBe(COPY.l3Title);
      expect($('invite-open')).not.toBeNull();
    });

    it('Continue in the browser goes to the old claim URL with the same token', async () => {
      const { location } = await setup();
      $('invite-browser').click();
      expect(location.href).toBe(`https://${SUB}.med.example/#claim=${TOKEN}`);
    });

    it('no App Store id meta: no store button, browser path stays', async () => {
      await setup({ metas: { ios: '', pkg: 'ai.myhealthbot.app' } });
      expect($('invite-get')).toBeNull();
      expect($('invite-browser')).not.toBeNull();
    });
  });

  describe('L1 · Android', () => {
    it('Get the app copies the URL and opens Play with the invite as install referrer', async () => {
      const { clipboard, location } = await setup({ platform: 'android' });
      expect($('invite-get').textContent).toBe(COPY.getAndroid);
      $('invite-get').click();
      expect(clipboard.writeText).toHaveBeenCalledWith(LANDING);
      expect(title()).toBe(COPY.opening);
      await flush();
      expect(location.href).toBe(playHref('ai.myhealthbot.app', LANDING));
    });

    it('no package meta: no store button', async () => {
      await setup({ platform: 'android', metas: { ios: '1', pkg: '' } });
      expect($('invite-get')).toBeNull();
      expect($('invite-browser')).not.toBeNull();
    });
  });

  describe('L2 · desktop', () => {
    it('QR encodes this page\'s full URL (fragment included); no store buttons', async () => {
      const qr = fakeQr();
      const { location } = await setup({ platform: 'desktop', loadQr: async () => ({ qrcode: qr.qrcode }) });
      expect(qr.data).toEqual([LANDING]);
      expect($('invite-qr').querySelector('svg')).not.toBeNull();
      expect(document.body.textContent).toContain(COPY.scan);
      expect($('invite-get')).toBeNull();
      expect($('invite-browser').textContent).toBe(COPY.browserDesk);
      $('invite-browser').click();
      expect(location.href).toBe(`https://${SUB}.med.example/#claim=${TOKEN}`);
    });

    it('renders a real QR with the vendored generator', async () => {
      await setup({ platform: 'desktop' });
      expect($('invite-qr').querySelector('svg')).not.toBeNull();
    });
  });

  describe('L1 · expired', () => {
    for (const state of ['expired', 'claimed']) {
      it(`${state}: expired copy, ask is the sun, Get the app anyway has no invite`, async () => {
        const { location, clipboard } = await setup({ body: { state } });
        expect(title()).toBe(COPY.expiredTitle);
        expect(document.body.textContent).toContain(COPY.expiredLede);
        expect($('invite-ask').classList.contains('wg-btn--primary')).toBe(true);
        expect($('invite-browser')).toBeNull();
        $('invite-anyway').click();
        expect(location.href).toBe('https://apps.apple.com/app/id1234567890');
        expect(clipboard.writeText).not.toHaveBeenCalled();
      });
    }

    it('Android "anyway" is the Play link without a referrer', async () => {
      const { location } = await setup({ platform: 'android', body: { state: 'expired' } });
      $('invite-anyway').click();
      expect(location.href).toBe('https://play.google.com/store/apps/details?id=ai.myhealthbot.app');
    });

    it('Ask uses the share sheet when there is one', async () => {
      const share = vi.fn(async () => {});
      const { clipboard } = await setup({ body: { state: 'expired' }, share });
      $('invite-ask').click();
      await flush();
      expect(share).toHaveBeenCalledWith({ text: ASK_TEXT });
      expect(clipboard.writeText).not.toHaveBeenCalled();
    });

    it('Ask without a share sheet copies the message and says so', async () => {
      const { clipboard } = await setup({ body: { state: 'expired' } });
      $('invite-ask').click();
      await flush();
      expect(clipboard.writeText).toHaveBeenCalledWith(ASK_TEXT);
      expect($('invite-hint').textContent).toBe(COPY.askCopied);
    });
  });

  it('status API unreachable: falls back to L1 without an expiry hint', async () => {
    seed();
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); });
    await mount(document, { fetchImpl, location: fakeLocation(), storage: fakeStorage(), navigator: {}, platform: 'ios' });
    expect(title()).toBe(COPY.title);
    expect($('invite-hint').textContent).toBe('');
  });

  it('hydrates kit icons when the registry is loaded', async () => {
    const hydrate = vi.fn();
    globalThis.WGIcons = { hydrate };
    await setup();
    expect(hydrate).toHaveBeenCalled();
  });
});

describe('invite.html is CSP-clean', () => {
  const html = fs.readFileSync(path.join(REPO_ROOT, 'web/cloud/invite.html'), 'utf8');

  it('has no inline script, style or handler', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/\sstyle=/i);
  });

  it('keeps the <head> marker the server splices the store metas after', () => {
    expect(html).toContain('<head>');
    expect(html).toContain('data-page="invite-landing"');
  });
});

function fakeQr() {
  const data = [];
  return {
    data,
    qrcode: () => ({
      addData: (d) => data.push(d),
      make() {},
      createSvgTag: () => '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    }),
  };
}
