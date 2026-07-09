// bd med-76c.2 — the mt/v1/inbox sealed box crosses a language boundary: Go
// seals (internal/cloudserver/sealedbox.go), the browser opens. A format drift
// on either side silently strands every inbound Telegram event, so both suites
// decrypt one committed vector. If this fails, so does the Go test that pins it.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    generateInboxKeypair,
    inboxCryptoSupported,
    inboxPublicFromPrivate,
    openInboxEvent,
    rawX25519PrivateToPkcs8,
    fromBase64,
} from '../crypto.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const VECTOR = JSON.parse(fs.readFileSync(
    path.resolve(REPO_ROOT, 'internal/cloudserver/testdata/inbox_sealed_vector.json'),
    'utf-8',
));

const dec = (b) => new TextDecoder().decode(b);

describe('crypto.js — mt/v1/inbox sealed box', () => {
    it('this runtime supports WebCrypto X25519', async () => {
        expect(await inboxCryptoSupported()).toBe(true);
    });

    it('opens the sealed payload the Go server produced', async () => {
        const priv = rawX25519PrivateToPkcs8(fromBase64(VECTOR.recipient_private_b64));
        const opened = await openInboxEvent(priv, VECTOR.account_id, fromBase64(VECTOR.sealed_b64));
        expect(dec(opened)).toBe(VECTOR.plaintext);
    });

    it('derives the same public key Go recorded for that private key', async () => {
        const priv = rawX25519PrivateToPkcs8(fromBase64(VECTOR.recipient_private_b64));
        const pub = await inboxPublicFromPrivate(priv);
        expect(Array.from(pub)).toEqual(Array.from(fromBase64(VECTOR.recipient_public_b64)));
    });

    it('refuses a payload sealed for a different account (AAD binding)', async () => {
        const priv = rawX25519PrivateToPkcs8(fromBase64(VECTOR.recipient_private_b64));
        await expect(openInboxEvent(priv, 'someone-else', fromBase64(VECTOR.sealed_b64))).rejects.toThrow();
    });

    it('refuses a tampered payload', async () => {
        const priv = rawX25519PrivateToPkcs8(fromBase64(VECTOR.recipient_private_b64));
        const sealed = fromBase64(VECTOR.sealed_b64);
        sealed[sealed.length - 1] ^= 0x01;
        await expect(openInboxEvent(priv, VECTOR.account_id, sealed)).rejects.toThrow();
    });

    it('refuses a payload sealed to somebody else’s key', async () => {
        const { privateKey } = await generateInboxKeypair();
        await expect(openInboxEvent(privateKey, VECTOR.account_id, fromBase64(VECTOR.sealed_b64))).rejects.toThrow();
    });

    it('rejects a truncated payload before touching WebCrypto', async () => {
        const priv = rawX25519PrivateToPkcs8(fromBase64(VECTOR.recipient_private_b64));
        await expect(openInboxEvent(priv, VECTOR.account_id, new Uint8Array(43))).rejects.toThrow(/too short/);
    });

    it('generateInboxKeypair yields a 32-byte public key that matches its private half', async () => {
        const { publicKey, privateKey } = await generateInboxKeypair();
        expect(publicKey.length).toBe(32);
        expect(Array.from(await inboxPublicFromPrivate(privateKey))).toEqual(Array.from(publicKey));
    });
});
