// features/trial-consent.js — consent disclosure dialog + retry seam
// (bd med-yor.2, Task 4). Pins the contract:
//
//   - request(scope) renders a modal whose disclosure names the data
//     categories per scope, the operator's provider account, and the
//     add-your-own-key alternative (Settings → Integrations)
//   - Allow PATCHes { [scope]: true } to /api/settings/trial-consent and
//     resolves true; Not now PATCHes { [scope]: false } and resolves false
//   - dismissal (backdrop / Escape) resolves false WITHOUT persisting a
//     choice — no decision is not a refusal on record
//   - Allow resolves false when the PATCH fails — an unpersisted grant
//     would just bounce off the vault-read gate again
//   - retryAfterConsent(fn) reruns fn once after an allowed dialog for the
//     gate's trial_consent_required error and rethrows on refusal; any
//     other error passes through with no dialog

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function consentError(scope) {
    const err = new Error('trial consent required');
    err.code = 'trial_consent_required';
    err.scope = scope;
    return err;
}

describe('features/trial-consent.js — disclosure dialog + retry seam', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
        env.window.apiCall = vi.fn(async (url, method, body) => {
            if (url === '/api/settings/trial-consent' && method === 'PATCH') {
                return { ai: null, voice: null, tg: null, updated_at: 1, ...body };
            }
            return null;
        });
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    function modal() {
        return env.document.querySelector('.wg-trial-consent-modal');
    }

    it('ai dialog names meal descriptions + photos, the operator’s OpenAI account, and the BYO alternative', () => {
        env.window.TrialConsent.request('ai');
        const el = modal();
        expect(el).not.toBeNull();
        expect(el.getAttribute('data-trial-consent-scope')).toBe('ai');
        const text = el.textContent;
        expect(text).toMatch(/meal descriptions/i);
        expect(text).toMatch(/photos/i);
        expect(text).toMatch(/operator[’']s OpenAI account/i);
        expect(text).toMatch(/Settings → Integrations/);
        expect(text).toMatch(/your own key/i);
        el.querySelector('[data-trial-consent-choice="deny"]').click();
    });

    it('tg dialog names Telegram messages AND the vault health data the assistant reads', () => {
        env.window.TrialConsent.request('tg');
        const text = modal().textContent;
        expect(text).toMatch(/Telegram messages/i);
        expect(text).toMatch(/blood pressure history/i);
        expect(text).toMatch(/vault/i);
        expect(text).toMatch(/operator[’']s OpenAI account/i);
        // The gamification narrator rides this scope (plan ➕ note) — the
        // disclosure must say so.
        expect(text).toMatch(/narrator/i);
        modal().querySelector('[data-trial-consent-choice="deny"]').click();
    });

    it('voice dialog names voice audio + transcripts and the operator’s ElevenLabs agent', () => {
        env.window.TrialConsent.request('voice');
        const text = modal().textContent;
        expect(text).toMatch(/voice audio/i);
        expect(text).toMatch(/transcripts/i);
        expect(text).toMatch(/operator[’']s ElevenLabs/i);
        modal().querySelector('[data-trial-consent-choice="deny"]').click();
    });

    it('Allow PATCHes { scope: true } and resolves true; the modal unmounts', async () => {
        const p = env.window.TrialConsent.request('ai');
        modal().querySelector('[data-trial-consent-choice="allow"]').click();
        await expect(p).resolves.toBe(true);
        expect(env.window.apiCall).toHaveBeenCalledWith('/api/settings/trial-consent', 'PATCH', { ai: true });
        expect(modal()).toBeNull();
    });

    it('Not now PATCHes { scope: false } and resolves false', async () => {
        const p = env.window.TrialConsent.request('voice');
        modal().querySelector('[data-trial-consent-choice="deny"]').click();
        await expect(p).resolves.toBe(false);
        expect(env.window.apiCall).toHaveBeenCalledWith('/api/settings/trial-consent', 'PATCH', { voice: false });
    });

    it('backdrop dismissal resolves false and persists nothing', async () => {
        const p = env.window.TrialConsent.request('ai');
        env.document.querySelector('.mt-confirm-backdrop').click();
        await expect(p).resolves.toBe(false);
        expect(env.window.apiCall).not.toHaveBeenCalled();
        expect(modal()).toBeNull();
    });

    it('Escape dismissal resolves false and persists nothing', async () => {
        const p = env.window.TrialConsent.request('tg');
        env.document.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape' }));
        await expect(p).resolves.toBe(false);
        expect(env.window.apiCall).not.toHaveBeenCalled();
    });

    it('Allow resolves false when the PATCH fails (grant not persisted → gate would still refuse)', async () => {
        env.window.apiCall = vi.fn(async () => null);
        const p = env.window.TrialConsent.request('ai');
        modal().querySelector('[data-trial-consent-choice="allow"]').click();
        await expect(p).resolves.toBe(false);
    });

    it('unknown scope resolves false without mounting a dialog', async () => {
        await expect(env.window.TrialConsent.request('everything')).resolves.toBe(false);
        expect(modal()).toBeNull();
    });

    it('retryAfterConsent reruns fn once after Allow and returns its result', async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(consentError('ai'))
            .mockResolvedValueOnce({ items: [1] });
        const p = env.window.TrialConsent.retryAfterConsent(fn);
        await flushPromises();
        modal().querySelector('[data-trial-consent-choice="allow"]').click();
        await expect(p).resolves.toEqual({ items: [1] });
        expect(fn).toHaveBeenCalledTimes(2);
        expect(env.window.apiCall).toHaveBeenCalledWith('/api/settings/trial-consent', 'PATCH', { ai: true });
    });

    it('retryAfterConsent rethrows the gate error on refusal and does NOT rerun fn', async () => {
        const err = consentError('ai');
        const fn = vi.fn().mockRejectedValue(err);
        const p = env.window.TrialConsent.retryAfterConsent(fn);
        p.catch(() => { /* asserted below; pre-attach so no unhandled rejection */ });
        await flushPromises();
        modal().querySelector('[data-trial-consent-choice="deny"]').click();
        await expect(p).rejects.toBe(err);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(env.window.apiCall).toHaveBeenCalledWith('/api/settings/trial-consent', 'PATCH', { ai: false });
    });

    it('retryAfterConsent passes non-consent errors through without a dialog', async () => {
        const boom = new Error('network down');
        const fn = vi.fn().mockRejectedValue(boom);
        await expect(env.window.TrialConsent.retryAfterConsent(fn)).rejects.toBe(boom);
        expect(modal()).toBeNull();
        expect(env.window.apiCall).not.toHaveBeenCalled();
    });

    it('concurrent requests for the same scope share one dialog', async () => {
        const p1 = env.window.TrialConsent.request('ai');
        const p2 = env.window.TrialConsent.request('ai');
        expect(env.document.querySelectorAll('.wg-trial-consent-modal').length).toBe(1);
        modal().querySelector('[data-trial-consent-choice="allow"]').click();
        await expect(p1).resolves.toBe(true);
        await expect(p2).resolves.toBe(true);
        expect(env.window.apiCall).toHaveBeenCalledTimes(1);
    });
});
