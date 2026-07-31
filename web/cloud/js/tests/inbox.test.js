// bd med-76c.2 — client half of the sealed mailbox foundation: the inbox
// keypair lives in the vault (so every device can drain), only its public half
// reaches the server, and the mailbox transport opens what the Go server sealed.
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ackInboxEvent, drainInbox, ensureInboxKey, listInboxEvents, readInboxKey, startInboxPolling } from '../inbox.js';
import { inboxPublicFromPrivate, fromBase64, toBase64 } from '../crypto.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const VECTOR = JSON.parse(fs.readFileSync(
    path.resolve(REPO_ROOT, 'internal/cloudserver/testdata/inbox_sealed_vector.json'),
    'utf-8',
));

// Minimal records port: the vault surface inbox.js actually uses.
function fakeRecords(seed = {}, log = []) {
    const store = { ...seed };
    return {
        log,
        list: async (type) => (store[type] || []).slice(),
        put: async (type, record) => {
            log.push(`put:${type}`);
            store[type] = [record];
            return record;
        },
        del: async () => {},
    };
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

describe('inbox.js — key provisioning', () => {
    const ctx = { accountId: 'acct-1' };

    it('generates a keypair, stores the private half in the vault, publishes the public half', async () => {
        const records = fakeRecords();
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 204 }));

        const priv = await ensureInboxKey(ctx, { records, fetchImpl });
        expect(priv).toBeInstanceOf(Uint8Array);

        const [url, opts] = fetchImpl.mock.calls[0];
        expect(url).toBe('/api/inbox/key');
        expect(opts.method).toBe('PUT');

        // What we published must be the public half of what we stored.
        const published = fromBase64(JSON.parse(opts.body).public_key);
        expect(Array.from(published)).toEqual(Array.from(await inboxPublicFromPrivate(priv)));

        // And the private key is now readable from the vault.
        const fromVault = await readInboxKey(ctx, { records });
        expect(Array.from(fromVault)).toEqual(Array.from(priv));
    });

    it('writes the private key to the vault BEFORE publishing the public key', async () => {
        // Publishing first would let the server seal to a key a crash could stop
        // us from ever persisting, stranding those events permanently.
        const log = [];
        const records = fakeRecords({}, log);
        const fetchImpl = vi.fn(async () => { log.push('publish'); return { ok: true, status: 204 }; });

        await ensureInboxKey(ctx, { records, fetchImpl });

        expect(log).toEqual(['put:inboxkey', 'publish']);
    });

    it('reuses the vault key on later unlocks instead of rotating it', async () => {
        const records = fakeRecords();
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 204 }));

        const first = await ensureInboxKey(ctx, { records, fetchImpl });
        records.log.length = 0;
        const second = await ensureInboxKey(ctx, { records, fetchImpl });

        expect(Array.from(second)).toEqual(Array.from(first));
        expect(records.log).not.toContain('put:inboxkey'); // no rotation
        expect(fetchImpl).toHaveBeenCalledTimes(2); // republished, idempotently
    });

    it('surfaces a failed publish rather than pretending the mailbox works', async () => {
        const records = fakeRecords();
        const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }));
        await expect(ensureInboxKey(ctx, { records, fetchImpl })).rejects.toThrow(/could not publish/);
    });
});

describe('inbox.js — mailbox transport', () => {
    const ctx = { accountId: VECTOR.account_id };
    const privRaw = fromBase64(VECTOR.recipient_private_b64);

    // The vault stores PKCS#8; the Go vector carries a raw scalar.
    async function vaultPrivateKey() {
        const { rawX25519PrivateToPkcs8 } = await import('../crypto.js');
        return rawX25519PrivateToPkcs8(privRaw);
    }

    it('lists and opens the events the Go server sealed', async () => {
        const priv = await vaultPrivateKey();
        const fetchImpl = vi.fn(async () => okJson({
            events: [{ id: 7, created_at_unix: 1767225600, ct: VECTOR.sealed_b64 }],
        }));

        const events = await listInboxEvents(ctx, priv, { fetchImpl });

        expect(events).toHaveLength(1);
        expect(events[0].id).toBe(7);
        expect(events[0].event).toEqual(JSON.parse(VECTOR.plaintext));
    });

    // med-3q8.3: an un-openable seal is reported PER EVENT and never thrown out
    // of the page. It used to throw, which killed the whole drain before it
    // reached the events it could apply — every later Telegram command then sat
    // at "⏳ Queued" forever. It is still never silently dropped (the caller
    // leaves it queued, so a device holding the matching key can drain it).
    it('reports an event it cannot open without dropping it or aborting the page', async () => {
        const priv = await vaultPrivateKey();
        const tampered = fromBase64(VECTOR.sealed_b64);
        tampered[tampered.length - 1] ^= 0x01;
        const fetchImpl = vi.fn(async () => okJson({
            events: [
                { id: 1, created_at_unix: 1, ct: toBase64(tampered) },
                { id: 2, created_at_unix: 2, ct: VECTOR.sealed_b64 },
            ],
        }));

        const events = await listInboxEvents(ctx, priv, { fetchImpl });

        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({ id: 1 });
        expect(events[0].error).toBeInstanceOf(Error);
        expect(events[0].event).toBeUndefined();
        // The good event behind it still came back opened.
        expect(events[1].event).toEqual(JSON.parse(VECTOR.plaintext));
    });

    it('an empty mailbox is not an error', async () => {
        const priv = await vaultPrivateKey();
        const fetchImpl = vi.fn(async () => okJson({}));
        await expect(listInboxEvents(ctx, priv, { fetchImpl })).resolves.toEqual([]);
    });

    it('ack DELETEs the event by id and surfaces a failed ack', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 204 }));
        await ackInboxEvent(7, { fetchImpl });
        expect(fetchImpl).toHaveBeenCalledWith('/api/inbox/7', { method: 'DELETE' });

        const failing = vi.fn(async () => ({ ok: false, status: 500 }));
        await expect(ackInboxEvent(7, { fetchImpl: failing })).rejects.toThrow(/could not ack/);
    });
});

// bd med-76c.2 part 2 — the drain. These pin the four binding rules from
// docs/cloud-mode.md → "Drain protocol"; each one is a correctness rule whose
// violation loses or duplicates something the user actually tapped.
describe('inbox.js — drainInbox', () => {
    const ctx = { accountId: VECTOR.account_id };

    // The vault holds the private key; the mailbox returns Go-sealed bytes.
    async function seededRecords() {
        const { rawX25519PrivateToPkcs8 } = await import('../crypto.js');
        const priv = await rawX25519PrivateToPkcs8(fromBase64(VECTOR.recipient_private_b64));
        return fakeRecords({ inboxkey: [{ recordId: 'inboxkey', deleted: false, privateKey: toBase64(priv) }] });
    }

    // events: [{id, ct}] → a fetch stub serving GET /api/inbox then DELETEs.
    function mailbox(events) {
        const deleted = [];
        const fetchImpl = vi.fn(async (url, opts) => {
            if (opts && opts.method === 'DELETE') {
                deleted.push(Number(url.split('/').pop()));
                return { ok: true, status: 204 };
            }
            return okJson({ events });
        });
        return { fetchImpl, deleted };
    }

    it('applies an event, then acks it only after the flush barrier confirms', async () => {
        const records = await seededRecords();
        const { fetchImpl, deleted } = mailbox([{ id: 7, created_at_unix: 1, ct: VECTOR.sealed_b64 }]);
        const order = [];
        const apply = vi.fn(async () => { order.push('apply'); });
        const flush = vi.fn(async () => { order.push('flush'); return true; });

        const res = await drainInbox(ctx, { apply, records, fetchImpl, flush });

        expect(res).toEqual({ applied: 1, failed: 0 });
        // The mailbox event id rides along so appliers can derive a deterministic
        // record id from it (drain rule 2).
        expect(apply).toHaveBeenCalledWith(JSON.parse(VECTOR.plaintext), 7);
        expect(deleted).toEqual([7]);
        // Rule 1: apply → flush → ack. Never ack ahead of the barrier.
        expect(order).toEqual(['apply', 'flush']);
    });

    // Rule 1, the failure that this whole design exists to prevent: an event
    // marked processed whose write never reached the vault.
    it('does NOT ack when the flush is unconfirmed', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const records = await seededRecords();
        const { fetchImpl, deleted } = mailbox([{ id: 7, created_at_unix: 1, ct: VECTOR.sealed_b64 }]);

        const res = await drainInbox(ctx, {
            apply: vi.fn(async () => {}), records, fetchImpl, flush: async () => false,
        });

        // A leading flush-false aborts the drain and flags stalled (med-eas.51).
        expect(res).toEqual({ applied: 0, failed: 1, stalled: true });
        expect(deleted).toEqual([]); // still queued for the next drain
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('does NOT ack when apply throws, and keeps draining the other events', async () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const records = await seededRecords();
        const { fetchImpl, deleted } = mailbox([
            { id: 7, created_at_unix: 1, ct: VECTOR.sealed_b64 },
            { id: 8, created_at_unix: 1, ct: VECTOR.sealed_b64 },
        ]);
        const apply = vi.fn()
            .mockImplementationOnce(async () => { throw new Error('vault write failed'); })
            .mockImplementationOnce(async () => {});

        const res = await drainInbox(ctx, { apply, records, fetchImpl, flush: async () => true });

        expect(res).toEqual({ applied: 1, failed: 1 });
        expect(deleted).toEqual([8]); // 7 stays queued; one bad event strands nothing else
        expect(err).toHaveBeenCalled();
        err.mockRestore();
    });

    // Rule 4: apply in SERVER-timestamp order, not mailbox arrival order. Event
    // id 1 arrives first but was tapped LATER, so it must be applied second —
    // otherwise a Snooze tapped at 09:00 would overwrite a Confirm tapped 09:10.
    it('applies events in sealed server-timestamp order, not arrival order', async () => {
        const records = await seededRecords();
        const later = JSON.parse(VECTOR.plaintext);
        const earlier = JSON.parse(VECTOR.plaintext_earlier);
        expect(earlier.at_unix).toBeLessThan(later.at_unix);

        const { fetchImpl, deleted } = mailbox([
            { id: 1, created_at_unix: 1, ct: VECTOR.sealed_b64 },          // later tap, arrived first
            { id: 2, created_at_unix: 2, ct: VECTOR.sealed_earlier_b64 },  // earlier tap, arrived second
        ]);
        const seen = [];
        const res = await drainInbox(ctx, {
            apply: async (e) => { seen.push(e.at_unix); }, records, fetchImpl, flush: async () => true,
        });

        expect(res).toEqual({ applied: 2, failed: 0 });
        expect(seen).toEqual([earlier.at_unix, later.at_unix]);
        expect(deleted).toEqual([2, 1]);
    });

    // med-eas.51: when sync is wedged flushConfirmed can never resolve true, so
    // no event could ever ack. The drain must NOT even fetch — re-pulling a
    // ~160MB backlog every poll is the self-DoS this guard stops.
    it('pauses with ZERO GET /api/inbox fetches when sync is wedged', async () => {
        const records = await seededRecords();
        const { fetchImpl } = mailbox([{ id: 7, created_at_unix: 1, ct: VECTOR.sealed_b64 }]);
        const apply = vi.fn();

        const res = await drainInbox(ctx, { apply, records, fetchImpl, flush: async () => true, wedged: async () => true });

        expect(res).toEqual({ applied: 0, failed: 0, wedged: true });
        expect(apply).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled(); // not even the GET
    });

    // med-eas.51: a LEADING flush-false means sync can't confirm anything —
    // abort the whole drain instead of apply+failing every remaining event.
    it('aborts after the first flush-false, applying only the first event and acking none', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const records = await seededRecords();
        const { fetchImpl, deleted } = mailbox([
            { id: 7, created_at_unix: 1, ct: VECTOR.sealed_b64 },
            { id: 8, created_at_unix: 2, ct: VECTOR.sealed_b64 },
        ]);
        const apply = vi.fn(async () => {});

        const res = await drainInbox(ctx, { apply, records, fetchImpl, flush: async () => false });

        expect(res).toEqual({ applied: 0, failed: 1, stalled: true });
        expect(apply).toHaveBeenCalledTimes(1); // event 8 never applied — we bailed
        expect(deleted).toEqual([]); // nothing acked
        warn.mockRestore();
    });

    // med-3q8.3, the reported bug: one permanently un-openable seal (e.g. sealed
    // to an inbox public key a concurrent device's LWW PUT superseded) used to
    // throw out of listInboxEvents and abort the whole drain, so every Telegram
    // command queued behind it stayed "⏳ Queued" while the app was open.
    it('skips an un-openable event and still applies + acks the ones behind it', async () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const records = await seededRecords();
        const tampered = fromBase64(VECTOR.sealed_b64);
        tampered[tampered.length - 1] ^= 0x01;
        const { fetchImpl, deleted } = mailbox([
            { id: 7, created_at_unix: 1, ct: toBase64(tampered) },
            { id: 8, created_at_unix: 2, ct: VECTOR.sealed_b64 },
        ]);
        const apply = vi.fn(async () => {});

        const res = await drainInbox(ctx, { apply, records, fetchImpl, flush: async () => true });

        expect(res).toEqual({ applied: 1, failed: 1, unopenable: 1 });
        expect(apply).toHaveBeenCalledTimes(1);
        expect(deleted).toEqual([8]); // the good one acked, the poison one kept queued
        err.mockRestore();
    });

    it('is a no-op when this account has no inbox key yet', async () => {
        const records = fakeRecords();
        const fetchImpl = vi.fn();
        const res = await drainInbox(ctx, { apply: vi.fn(), records, fetchImpl, flush: async () => true });
        expect(res).toEqual({ applied: 0, failed: 0 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    // Rule 3 is handled server-side (delete is idempotent), but a second drain
    // inside ONE tab is pure waste and races its own ack.
    it('refuses to run two drains concurrently for the same account', async () => {
        const records = await seededRecords();
        const { fetchImpl } = mailbox([{ id: 7, created_at_unix: 1, ct: VECTOR.sealed_b64 }]);
        let release;
        let started;
        const applyStarted = new Promise((r) => { started = r; });
        const apply = vi.fn(() => new Promise((r) => { release = r; started(); }));

        const first = drainInbox(ctx, { apply, records, fetchImpl, flush: async () => true });
        await applyStarted; // the first drain now holds the lock

        const second = await drainInbox(ctx, { apply, records, fetchImpl, flush: async () => true });
        expect(second.skipped).toBe(true);

        release();
        await first;
        expect(apply).toHaveBeenCalledTimes(1);
    });
});

// bd med-eas.29.2 — nothing else in cloud mode polls (no SSE, no change stream),
// so without this a command texted to the bot sits unapplied until the next full
// page load, and its "⏳ Queued" reply never becomes "✅ Recorded".
describe('startInboxPolling', () => {
    const ctx = { accountId: VECTOR.account_id };

    async function pollRecords() {
        const { rawX25519PrivateToPkcs8 } = await import('../crypto.js');
        const priv = await rawX25519PrivateToPkcs8(fromBase64(VECTOR.recipient_private_b64));
        return fakeRecords({ inboxkey: [{ recordId: 'inboxkey', deleted: false, privateKey: toBase64(priv) }] });
    }

    function emptyMailbox() {
        return vi.fn(async () => okJson({ events: [] }));
    }

    function fakeDoc(state = 'visible') {
        const listeners = {};
        return {
            visibilityState: state,
            addEventListener: (ev, fn) => { listeners[ev] = fn; },
            removeEventListener: (ev) => { delete listeners[ev]; },
            fire: (ev) => listeners[ev] && listeners[ev](),
        };
    }

    // med-eas.51: a poison event that never applies (apply/decode keeps failing)
    // is no-progress too — the poller must back off, not re-fetch it every tick.
    // Inject a deterministic fake drain: the real drainInbox opens the event with
    // WebCrypto, whose async races the fake timers — that slop leaks the drain's
    // expected error log into the next test and skews the drain count. The fake
    // isolates exactly the poller's backoff gate (the med-eas.51 code under test).
    it('backs off when every drain fails to apply, not just on flush-false', async () => {
        vi.useFakeTimers();
        const doc = fakeDoc('visible');
        const drain = vi.fn(async () => ({ applied: 0, failed: 1 })); // every drain fails to apply

        const stop = startInboxPolling(ctx, { apply: () => {}, intervalMs: 1000, doc, drain });

        await vi.advanceTimersByTimeAsync(6000);
        // Without backoff this would drain on all 6 ticks; the gate throttles it.
        expect(drain.mock.calls.length).toBeGreaterThan(0);
        expect(drain.mock.calls.length).toBeLessThan(6);

        stop();
        vi.useRealTimers();
    });

    // med-3q8.3 — the reported bug, at the poller. A permanently un-openable
    // seal parked in the mailbox is no-progress, but it is NOT the bricked
    // mailbox med-eas.51 throttles: it is skipped client-side after a fetch the
    // byte cap already bounds. Throttling on it pinned the poll at ~60s, so a
    // command texted with the app open sat at "⏳ Queued" for a minute.
    it('keeps full cadence when the only failures are seals it can never open', async () => {
        vi.useFakeTimers();
        const doc = fakeDoc('visible');
        let report = { applied: 0, failed: 1, unopenable: 1 };
        const drain = vi.fn(async () => report);
        const onApplied = vi.fn();

        const stop = startInboxPolling(ctx, { apply: () => {}, intervalMs: 1000, doc, drain, onApplied });

        await vi.advanceTimersByTimeAsync(4000);
        expect(drain.mock.calls.length).toBe(4); // every tick drained — nothing skipped
        expect(onApplied).not.toHaveBeenCalled();

        // The user texts the bot: the very next tick applies it, so the "Queued"
        // placeholder becomes the real answer within one interval.
        report = { applied: 1, failed: 1, unopenable: 1 };
        await vi.advanceTimersByTimeAsync(1100);
        expect(onApplied).toHaveBeenCalledTimes(1);

        stop();
        vi.useRealTimers();
    });

    it('drains on an interval while the tab is visible', async () => {
        vi.useFakeTimers();
        const fetchImpl = emptyMailbox();
        const doc = fakeDoc('visible');
        const stop = startInboxPolling(ctx, {
            apply: vi.fn(), intervalMs: 1000, doc, fetchImpl, records: await pollRecords(),
        });

        await vi.advanceTimersByTimeAsync(3100);
        expect(fetchImpl).toHaveBeenCalled();
        stop();

        const calls = fetchImpl.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5000);
        expect(fetchImpl.mock.calls.length).toBe(calls); // stop() really stops
        vi.useRealTimers();
    });

    // med-d15 — the hidden tab IS the case that matters: while the user types in
    // Telegram, this tab is backgrounded by definition. Skipping the timer there
    // made the mailbox silent for exactly that window, so the ✅ only ever landed
    // the moment they switched back. Browsers already clamp background timers to
    // ~1/min, so the cost is one empty GET per minute, not one per interval.
    it('polls a hidden tab — the user is in Telegram exactly while this tab is hidden', async () => {
        vi.useFakeTimers();
        const fetchImpl = emptyMailbox();
        const doc = fakeDoc('hidden');
        const stop = startInboxPolling(ctx, {
            apply: vi.fn(), intervalMs: 1000, doc, fetchImpl, records: await pollRecords(),
        });

        await vi.advanceTimersByTimeAsync(3100);
        expect(fetchImpl).toHaveBeenCalled(); // scheduled ticks drain while hidden

        // ...and coming back still drains immediately, without waiting out the
        // rest of the interval.
        const whileHidden = fetchImpl.mock.calls.length;
        doc.visibilityState = 'visible';
        doc.fire('visibilitychange');
        await vi.advanceTimersByTimeAsync(200);
        expect(fetchImpl.mock.calls.length).toBeGreaterThan(whileHidden);
        stop();
        vi.useRealTimers();
    });

    // med-eas.51: a wedged/stalled account must stop hammering GET /api/inbox
    // every interval, but resume the normal cadence the moment it recovers.
    // Fake drain (see the poison-backoff test above): stalls while flushOk is
    // false, makes progress once it flips. Real drainInbox's WebCrypto open would
    // race the fake timers and skew the drain count under parallel-suite load.
    it('backs off after consecutive stalls and resumes the normal cadence on progress', async () => {
        vi.useFakeTimers();
        const doc = fakeDoc('visible');
        let flushOk = false;
        const drain = vi.fn(async () => (flushOk
            ? { applied: 1, failed: 0 }
            : { applied: 0, failed: 1, stalled: true }));
        const drains = () => drain.mock.calls.length;

        const stop = startInboxPolling(ctx, { apply: () => {}, intervalMs: 1000, doc, drain });

        // Sustained stall: 6 ticks fire but the backoff gate throttles the actual
        // drains, so we drain far fewer times than we tick.
        await vi.advanceTimersByTimeAsync(6000);
        const throttled = drains();
        expect(throttled).toBeGreaterThan(0);
        expect(throttled).toBeLessThan(6);

        // Recovery: a drain now makes progress, which resets the backoff.
        flushOk = true;
        await vi.advanceTimersByTimeAsync(6000);
        const afterRecovery = drains();
        expect(afterRecovery).toBeGreaterThan(throttled); // recovery drains ran

        await vi.advanceTimersByTimeAsync(3000);
        // Full cadence restored: with the backoff reset, ~1 drain per tick.
        expect(drains()).toBeGreaterThanOrEqual(afterRecovery + 2);

        stop();
        vi.useRealTimers();
    });
});
