// Parses the data-touching Telegram commands the cloud child bot accepts
// (bd med-eas.29.2). Runtime-agnostic and dependency-free, like every module
// in web/domain — no browser globals, no ports needed. Parsing happens HERE,
// on an unlocked client at drain time, and never on the relay: the relay reads
// only the leading token to tell /start and /help from what it seals, and is
// forbidden from inspecting arguments (docs/cloud-mode.md → "Inbound plaintext
// — what the relay may do").
//
// Reference command surface: internal/bot/commands.go commandSpecs. Only the
// commands whose write path already exists in web/domain are implemented; the
// rest resolve to `unsupported` so the bot can say so honestly rather than
// swallow the message.

// Commands the relay answers itself and which therefore never reach a mailbox.
const LOCAL_COMMANDS = new Set(['/start', '/help']);

// Snooze default mirrors web/domain/medintake.js's DEFAULT_SNOOZE_MINUTES.
// /food is natural-language logging: the relay still seals the raw text
// verbatim and the AI parse runs client-side at drain time (bd med-eas.29.4).
// /workout logs a completed ad-hoc workout for today through the shared workout
// domain — the "I did a workout" log, mirroring how /bp logs a reading. It does
// NOT reproduce bot mode's stateful button conversation (bd med-eas.29.5).
const KNOWN = new Set(['/bp', '/weight', '/note', '/intake', '/food', '/workout']);

// Commands that exist in bot mode but whose cloud write path is not built yet.
// Naming them explicitly gives the user "not yet" instead of "I don't
// understand", which is a materially different message when they are copying a
// command that demonstrably works in the other deployment.
const NOT_YET = new Set(['/activity', '/week', '/log', '/next', '/stock', '/bpstats', '/bpgoal', '/goal', '/tz']);

// commandToken returns the normalized leading command of a message ("/bp"), or
// "" when the text is not a command. Telegram appends "@botname" in groups.
// Mirrors botCommand() in internal/cloudserver/telegram.go — the two must agree
// on what counts as a command, since the relay decides what to seal and this
// decides what to do with it.
export function commandToken(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s.startsWith('/')) return '';
  let cmd = s.split(/\s+/)[0];
  const at = cmd.indexOf('@');
  if (at >= 0) cmd = cmd.slice(0, at);
  return cmd.toLowerCase();
}

function args(text) {
  return text.trim().split(/\s+/).slice(1);
}

// Accepts "120 80", "120/80", "120 80 65" (pulse). Telegram users type both
// separator styles and bot mode accepts both (internal/bot/bp.go).
function parseBP(text) {
  const raw = args(text).join(' ').replace(/\//g, ' ');
  const nums = raw.split(/\s+/).filter(Boolean).map(Number);
  if (nums.length < 2 || nums.some((n) => !Number.isFinite(n))) {
    return { kind: 'invalid', command: '/bp', hint: 'Usage: /bp 120 80 [pulse]' };
  }
  const [systolic, diastolic, pulse] = nums;
  // Reject transposed / impossible readings before they reach the vault. The
  // domain does not range-check, and a typo'd "/bp 12 80" is not recoverable
  // once it is a chart point.
  if (!inRange(systolic, 50, 300) || !inRange(diastolic, 30, 200) || diastolic >= systolic) {
    return { kind: 'invalid', command: '/bp', hint: 'That reading looks wrong — systolic must be the larger number. Usage: /bp 120 80' };
  }
  if (pulse !== undefined && !inRange(pulse, 20, 250)) {
    return { kind: 'invalid', command: '/bp', hint: 'Pulse looks wrong. Usage: /bp 120 80 65' };
  }
  return { kind: 'bp', systolic, diastolic, pulse: pulse ?? null };
}

function parseWeight(text) {
  const [first] = args(text);
  const weight = Number(String(first ?? '').replace(',', '.'));
  if (!Number.isFinite(weight) || !inRange(weight, 20, 400)) {
    return { kind: 'invalid', command: '/weight', hint: 'Usage: /weight 81.2' };
  }
  return { kind: 'weight', weight };
}

function parseNote(text) {
  const content = text.trim().slice(commandToken(text).length).trim();
  if (!content) return { kind: 'invalid', command: '/note', hint: 'Usage: /note felt dizzy after lunch' };
  return { kind: 'note', content };
}

// parseFood keeps the whole free-text remainder verbatim — the NL parse happens
// later, on an unlocked client, via the food-AI domain with the user's own key.
// Parsing here would need an AI call, which this pure module (and the relay) must
// never make.
function parseFood(text) {
  const description = text.trim().slice(commandToken(text).length).trim();
  if (!description) return { kind: 'invalid', command: '/food', hint: 'Usage: /food 200g chicken breast' };
  return { kind: 'food', command: '/food', text: description };
}

// parseWorkout logs a completed ad-hoc workout for today. The remainder is an
// optional free-text label ("legs"); a bare /workout is valid and means "I did
// a workout" with no name. The name is applied on an unlocked client, never on
// the relay — same seal-and-drain contract as every other command.
function parseWorkout(text) {
  const name = text.trim().slice(commandToken(text).length).trim();
  return { kind: 'workout', command: '/workout', name };
}

function inRange(n, lo, hi) {
  return Number.isFinite(n) && n >= lo && n <= hi;
}

// parseCommand maps raw message text to an intent the applier can execute.
// Never throws: an unparseable message becomes `invalid` (with a usage hint)
// and an unknown one becomes `unknown`, because the user is owed an answer
// either way — silently dropping their message is the bug this replaces.
export function parseCommand(text) {
  const command = commandToken(text);
  if (!command) return { kind: 'not_a_command' };
  if (LOCAL_COMMANDS.has(command)) return { kind: 'local', command };
  if (NOT_YET.has(command)) return { kind: 'unsupported', command };
  if (!KNOWN.has(command)) return { kind: 'unknown', command };

  switch (command) {
    case '/bp': return parseBP(text);
    case '/weight': return parseWeight(text);
    case '/note': return parseNote(text);
    case '/food': return parseFood(text);
    case '/workout': return parseWorkout(text);
    case '/intake': return { kind: 'intake' };
    default: return { kind: 'unknown', command };
  }
}
