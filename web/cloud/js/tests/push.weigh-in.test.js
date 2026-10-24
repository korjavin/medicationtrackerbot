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
        it(`delivery both, ${verbosity}: tg_text never carries the goal; the ct body follows the lock-screen pref`, async () => {
            await pushSchedule({ accountId: `a-${verbosity}` }, [reminder], { delivery: 'both', verbosity });
            const [entry] = sent;
            // med-5vy0: Generic hides the goal from the lock screen too.
            expect(JSON.parse(entry.ct)).toMatchObject({ body: verbosity === 'generic' ? reminder.genericText : GOAL, kind: 'weight' });
            expect(entry.tg_text).toBe(verbosity === 'generic' ? reminder.genericText : reminder.text);
            expect(entry.tg_text).not.toMatch(/82\.4|to go/);
        });
    }

    // med-5vy0: account web push honours the lock-screen pref. Same keys, only
    // the body text changes, so an older SW reads it as before.
    it('a dose: generic seals "Medication time", detailed seals the names; keys unchanged', async () => {
        const dose = { fireAtUnix: 1767258000, kind: 'medication', text: 'Time to take: Aspirin', genericText: '\u{1F48A} Medication time', callback: 's:1767258000', medicationIds: [2] };
        await pushSchedule({ accountId: 'a-dose-g' }, [dose], { delivery: 'webpush', verbosity: 'generic' });
        const generic = JSON.parse(sent[0].ct);
        expect(Object.keys(generic).sort()).toEqual(['body', 'kind', 'title', 'url']);
        expect(generic.body).toBe('\u{1F48A} Medication time');
        expect(JSON.stringify(generic)).not.toContain('Aspirin');
        await pushSchedule({ accountId: 'a-dose-d' }, [dose], { delivery: 'webpush', verbosity: 'detailed' });
        expect(JSON.parse(sent[0].ct)).toMatchObject({ body: 'Time to take: Aspirin', kind: 'medication', title: 'Med Tracker' });
    });

    it('an entry without pushText keeps its text as the web push body', async () => {
        const plain = { ...reminder, pushText: undefined };
        await pushSchedule({ accountId: 'a-plain' }, [plain], { delivery: 'webpush' });
        expect(JSON.parse(sent[0].ct).body).toBe(plain.text);
        expect(sent[0].tg_text).toBeUndefined();
    });
});

// bd med-9d1a — the tap target rides the same NK ciphertext, never the wire in
// clear: a dose opens its take sheet, anything else its section.
describe('pushSchedule — the reminder deeplink is sealed in the ciphertext', () => {
    let sent;
    beforeEach(() => {
        sent = null;
        globalThis.fetch = vi.fn(async (_url, init) => { sent = JSON.parse(init.body).entries; return { ok: true }; });
    });
    afterEach(() => { delete globalThis.fetch; });

    it('a medication slot seals ids + slot time, no names; other kinds seal their section', async () => {
        const dose = { fireAtUnix: 1767258000, kind: 'medication', text: 'Time to take: A, B', callback: 's:1767258000', medicationIds: [2, 9] };
        const workout = { fireAtUnix: 1767258000, kind: 'workout', text: 'Lift' };
        const tracker = { fireAtUnix: 1767258000, kind: 'tracker', text: 'Log' };
        await pushSchedule({ accountId: 'a-url' }, [dose, reminder, workout, tracker], { delivery: 'both' });

        const urls = sent.map((e) => JSON.parse(e.ct).url);
        const q = new URL(urls[0], 'https://x.test').searchParams;
        expect(urls[0].startsWith('/?')).toBe(true);
        expect([...q.keys()].sort()).toEqual(['action', 'ids', 'scheduled']);
        expect(q.get('action')).toBe('medication_confirm');
        expect(q.get('ids')).toBe('2,9');
        expect(q.get('scheduled')).toBe(new Date(1767258000 * 1000).toISOString());
        expect(urls.slice(1)).toEqual(['/?tab=weight', '/?tab=workouts', '/?tab=today']);
        // Never in clear on the wire.
        for (const e of sent) expect(JSON.stringify({ ...e, ct: undefined })).not.toMatch(/medication_confirm|tab=/);
    });
});
