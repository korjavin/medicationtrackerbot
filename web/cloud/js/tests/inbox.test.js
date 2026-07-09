// bd med-76c.2 — client half of the sealed mailbox foundation: the inbox
// keypair lives in the vault (so every device can drain), only its public half
// reaches the server, and the mailbox transport opens what the Go server sealed.
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ackInboxEvent, drainInbox, ensureInboxKey, listInboxEvents, readInboxKey } from '../inbox.js';
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

    it('throws on an event it cannot open rather than silently dropping a real tap', async () => {
        const priv = await vaultPrivateKey();
        const tampered = fromBase64(VECTOR.sealed_b64);
        tampered[tampered.length - 1] ^= 0x01;
        const fetchImpl = vi.fn(async () => okJson({
            events: [{ id: 1, created_at_unix: 1, ct: toBase64(tampered) }],
        }));

        await expect(listInboxEvents(ctx, priv, { fetchImpl })).rejects.toThrow();
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
        expect(apply).toHaveBeenCalledWith(JSON.parse(VECTOR.plaintext));
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

        expect(res).toEqual({ applied: 0, failed: 1 });
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
