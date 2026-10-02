// med-8tur.6 — the goal-aware weigh-in body ("⚖️ Weigh in — trend 82.4 kg, 4.4
// to go") rides ONLY the Web Push ciphertext (sealed under the NK). Telegram's
// tg_text reaches the relay in plaintext, so it keeps the goal-free text at
// every verbosity: numeric goal data must not newly leave the vault via the relay.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Identity "encryption" so the test can read the sealed payload back.
vi.mock('../crypto.js', () => ({
    encryptPushPayload: vi.fn(async (_nk, plaintext) => plaintext),
    toBase64: vi.fn((bytes) => new TextDecoder().decode(bytes)),
}));
vi.mock('../sync.js', () => ({
    getOrCreateNK: vi.fn(async () => 'nk'),
    hasRichNotifications: vi.fn(),
    disableRichNotifications: vi.fn(),
}));
vi.mock('../localdb.js', () => ({ openDb: vi.fn() }));

import { pushSchedule } from '../push.js';

const GOAL = '\u{2696}\u{FE0F} Weigh in — trend 82.4 kg, 4.4 to go';
const reminder = {
    fireAtUnix: 1767258000, kind: 'weight', callback: 'wt:1767258000',
    text: '\u{2696}\u{FE0F} **Time to weigh in**', genericText: '\u{2696}\u{FE0F} Time for a scheduled measurement',
    pushText: GOAL,
};

describe('pushSchedule — goal-aware weigh-in text is Web-Push-only', () => {
    let sent;
    beforeEach(() => {
        sent = null;
        globalThis.fetch = vi.fn(async (_url, init) => { sent = JSON.parse(init.body).entries; return { ok: true }; });
    });
    afterEach(() => { delete globalThis.fetch; });

    for (const verbosity of ['detailed', 'generic']) {
        it(`delivery both, ${verbosity}: ct body carries the goal, tg_text does not`, async () => {
            await pushSchedule({ accountId: `a-${verbosity}` }, [reminder], { delivery: 'both', verbosity });
            const [entry] = sent;
            expect(JSON.parse(entry.ct)).toMatchObject({ body: GOAL, kind: 'weight' });
            expect(entry.tg_text).toBe(verbosity === 'generic' ? reminder.genericText : reminder.text);
            expect(entry.tg_text).not.toMatch(/82\.4|to go/);
        });
    }

    it('an entry without pushText keeps its text as the web push body', async () => {
        const plain = { ...reminder, pushText: undefined };
        await pushSchedule({ accountId: 'a-plain' }, [plain], { delivery: 'webpush' });
        expect(JSON.parse(sent[0].ct).body).toBe(plain.text);
        expect(sent[0].tg_text).toBeUndefined();
    });
});
