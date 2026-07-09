// bd med-76c.2 — client half of the sealed mailbox foundation: the inbox
// keypair lives in the vault (so every device can drain), only its public half
// reaches the server, and the mailbox transport opens what the Go server sealed.
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ackInboxEvent, ensureInboxKey, listInboxEvents, readInboxKey } from '../inbox.js';
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
