/**
 * handoff-landing.test.js (bd med-r1j2.4)
 *
 * The base-domain add-device hand-off, https://<base>/d/<sub>#<slot>.<TK>
 * (screens-add-device.html AD8, AD8 · no code, AD8 · desktop): no request at
 * all; Open in the app / Get the app / Continue in this browser on a phone, the
 * typed "Code for a computer" without a fragment or on a computer, and the
 * Path 0 "Open my account" link through the real InviteSheet.parseAddress.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { COPY, mount, parseHandoffLink, fragFromCode } from '../handoff-landing.js';
import { encodeTransferCode, generateTransferKey, toBase64Url, transferSlotId } from '../crypto.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SUB = 'anna';

let dom;
let doc;
let tk;
let frag;

function fakeLocation(over = {}) {
  return {
    pathname: `/d/${SUB}`,
    hash: `#${frag}`,
    href: '',
    origin: 'https://med.example',
    host: 'med.example',
    protocol: 'https:',
    ...over,
  };
}

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><head></head><body><main id="handoff-app"></main></body></html>', {
    url: 'https://med.example/', runScripts: 'outside-only',
  });
  // The real classic script the page loads for Path 0.
  dom.window.eval(fs.readFileSync(path.join(REPO_ROOT, 'web/static/js/features/invite.js'), 'utf8'));
  doc = dom.window.document;
  doc.head.insertAdjacentHTML('beforeend', '<meta name="medtracker-ios-app-store-id" content="1234567890"><meta name="medtracker-android-package" content="ai.example.app">');
  tk = generateTransferKey();
  frag = `${await transferSlotId(tk)}.${toBase64Url(tk)}`;
});
afterEach(() => dom.window.close());

async function setup({ platform = 'ios', location = fakeLocation(), fetchImpl } = {}) {
  const clipboard = { writeText: vi.fn(async () => {}) };
  await mount(doc, { location, platform, navigator: { clipboard }, inviteSheet: dom.window.InviteSheet, ...(fetchImpl ? { fetchImpl } : {}) });
  return { location, clipboard };
}
const $ = (id) => doc.getElementById(id);
const flush = () => new Promise((r) => { setTimeout(r, 0); });

describe('parseHandoffLink', () => {
  it('takes a lowercase sub and a <slot>.<TK> fragment, raw', () => {
    expect(parseHandoffLink('/d/Anna', '#a_b-1.c_d-2')).toEqual({ sub: 'anna', frag: 'a_b-1.c_d-2' });
    expect(parseHandoffLink('/d/anna', '')).toEqual({ sub: 'anna', frag: '' });
    for (const [p, h] of [['/d/', '#a.b'], ['/d/a/b', '#a.b'], ['/d/a.b', '#a.b'], ['/i/anna', '#a.b']]) {
      expect(parseHandoffLink(p, h).sub).toBe('');
    }
    for (const h of ['#nodot', '#a.b.c', '#a+b.c', '#%61.b', '#a.']) expect(parseHandoffLink('/d/anna', h).frag).toBe('');
  });
});

describe('AD8 on a phone, with the code', () => {
  it('without the app-links meta (no shell takes /d/ yet): Continue in this browser is the sun, no Open in the app', async () => {
    const { location } = await setup();
    expect($('handoff-open')).toBeNull();
    const browser = $('handoff-browser');
    expect(browser.className).toContain('wg-btn--primary');
    expect(browser.parentElement.firstElementChild).toBe(browser);
    expect($('handoff-get')).not.toBeNull(); // the store button stays
    browser.click();
    expect(location.href).toBe(`https://${SUB}.med.example/claim#${frag}`);
  });

  it('iPhone with the app-links meta: Open in the app is the sun; Continue in this browser opens /claim on the account host', async () => {
    doc.head.insertAdjacentHTML('beforeend', '<meta name="medtracker-handoff-app" content="1">');
    const fetchImpl = vi.fn();
    const { location } = await setup({ fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled(); // the page asks nothing
    expect(doc.querySelector('h1').textContent).toBe('Add this iPhone to your account');
    expect(doc.body.textContent).toContain(COPY.lede);
    expect($('handoff-open').className).toContain('wg-btn--primary');
    $('handoff-open').click();
    expect(location.href).toBe(`medtracker://d/${SUB}#${frag}`);
    expect($('handoff-browser').className).toContain('wg-btn--ghost');
    $('handoff-browser').click();
    expect(location.href).toBe(`https://${SUB}.med.example/claim#${frag}`);
  });

  it('Get the app copies this link first, then opens the store (Android: no referrer)', async () => {
    const { location, clipboard } = await setup({ platform: 'android' });
    expect(doc.querySelector('h1').textContent).toBe('Add this phone to your account');
    $('handoff-get').click();
    await flush();
    expect(clipboard.writeText).toHaveBeenCalledWith(`https://med.example/d/${SUB}#${frag}`);
    expect(location.href).toBe('https://play.google.com/store/apps/details?id=ai.example.app');
  });

  it('Open my account (Path 0) goes to /unlock on the account host', async () => {
    const { location } = await setup();
    $('handoff-open-account').click();
    expect(location.href).toBe(`https://${SUB}.med.example/unlock`);
  });
});

describe('AD8 · no code and AD8 · desktop: the typed code', () => {
  it('a phone without a fragment says so; Continue waits for all 28 letters, any case, any spacing', async () => {
    const { location } = await setup({ platform: 'android', location: fakeLocation({ hash: '' }) });
    expect(doc.querySelector('h1').textContent).toBe(COPY.missingTitle);
    expect(doc.body.textContent).toContain('Scan the code again on your other device');
    const input = $('handoff-code');
    expect(input.className).toContain('wg-input--code');
    const cont = $('handoff-continue');
    expect(cont.disabled).toBe(true);
    const code = encodeTransferCode(tk);
    input.value = code.slice(0, 20);
    input.dispatchEvent(new dom.window.Event('input'));
    await vi.waitFor(() => expect(cont.disabled).toBe(true));
    input.value = code.replace(/ /g, '').toLowerCase();
    input.dispatchEvent(new dom.window.Event('input'));
    await vi.waitFor(() => expect(cont.disabled).toBe(false));
    cont.click();
    expect(location.href).toBe(`https://${SUB}.med.example/claim#${frag}`);
  });

  it('a computer with the link gets the code prefilled, Continue on, and the Open my account link', async () => {
    const { location } = await setup({ platform: 'desktop' });
    expect(doc.querySelector('h1').textContent).toBe(COPY.deskTitle);
    expect($('handoff-code').value).toBe(encodeTransferCode(tk));
    await vi.waitFor(() => expect($('handoff-continue').disabled).toBe(false));
    $('handoff-continue').click();
    expect(location.href).toBe(`https://${SUB}.med.example/claim#${frag}`);
    expect($('handoff-open-account').textContent).toBe(COPY.openAccount);
  });

  it('fragFromCode refuses anything but 28 valid letters', async () => {
    expect(await fragFromCode('')).toBe('');
    expect(await fragFromCode('ABC')).toBe('');
    expect(await fragFromCode(encodeTransferCode(tk))).toBe(frag);
  });
});

describe('handoff.html is CSP-clean', () => {
  const html = fs.readFileSync(path.join(REPO_ROOT, 'web/cloud/handoff.html'), 'utf8');

  it('has no inline script, style or handler, and keeps the <head> marker for the store metas', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).toContain('<head>');
    expect(html).toContain('data-page="handoff-landing"');
  });
});

it('a bad path renders the incomplete-link screen with no buttons', async () => {
  await setup({ location: fakeLocation({ pathname: '/d/' }) });
  expect(doc.body.textContent).toContain(COPY.incomplete);
  expect(doc.querySelector('button')).toBeNull();
});
