/**
 * Global test setup — console noise guard.
 *
 * Installed via vitest.config.mjs `setupFiles`.
 *
 * Rules:
 *  - console.error, console.warn, and console.log calls in a test cause it
 *    to fail unless the test opts out by calling allowConsoleNoise().
 *  - Tests that *assert* on a console channel keep their own vi.spyOn()
 *    setup; the guard notices the takeover and skips that channel for the
 *    test. Output on a taken-over channel is expected-by-construction —
 *    the test silences the channel and usually asserts on it.
 *
 * Vitest 4 changed nested spying: vi.spyOn() on an already-mocked method
 * returns the SAME mock instance instead of installing a shadowing spy
 * (vitest 3 behavior). A test's vi.spyOn(console, 'error') therefore no
 * longer hides calls from this guard — so the guard intercepts vi.spyOn()
 * calls on the console object (see _trackingSpyOn) and records which
 * channels the current test took over. Channels the test never spied are
 * still enforced exactly as before.
 */
import { afterEach, beforeEach, vi } from 'vitest';
import { VirtualConsole } from 'jsdom';

// jsdom "Not implemented" stub errors (window.print/focus from the print
// iframe's load handler in web/cloud/js/print-doc.js, and the like) are
// environment trivia, not product signal. Under vitest 3 they never reached
// the test console; under vitest 4 the default VirtualConsole forwards them
// to console.error, tripping this guard. Omit them harness-wide. In-page
// console.* calls are unaffected — jsdom only ever forwards jsdomError to a
// bare console object (see VirtualConsole.sendTo) — and no test passes an
// explicit virtualConsole, so forcing the default here conflicts with
// nothing.
const _sendTo = VirtualConsole.prototype.sendTo;
VirtualConsole.prototype.sendTo = function sendTo(anyConsole, options) {
  return _sendTo.call(this, anyConsole, { ...options, omitJSDOMErrors: true });
};

let _noiseAllowed = false;
let _errorSpy = null;
let _warnSpy = null;
let _logSpy = null;
// Console channels ('error', 'warn', 'log') the current test spied itself
// via vi.spyOn(console, ...). Reset in the guard's beforeEach — which runs
// before any test-file hook — so entries always belong to the current test,
// regardless of when spies are restored.
let _testOwned = new Set();

/**
 * Mark the current test as intentionally producing console output.
 * Call inside the test body or in a beforeEach.
 */
export function allowConsoleNoise() {
  _noiseAllowed = true;
}

/**
 * Return the active global spies for the current test.
 * Use when a test needs to assert on console output that it also
 * opts into via allowConsoleNoise().
 */
export function getGlobalSpies() {
  return { errorSpy: _errorSpy, warnSpy: _warnSpy, logSpy: _logSpy };
}

// Installed once, at setup evaluation. The guard's own spies (beforeEach
// below) are created through _rawSpyOn so installing them never marks a
// test takeover.
const _rawSpyOn = vi.spyOn.bind(vi);
function _trackingSpyOn(obj, method, ...rest) {
  if (obj === console && (method === 'error' || method === 'warn' || method === 'log')) {
    _testOwned.add(method);
  }
  return _rawSpyOn(obj, method, ...rest);
}
vi.spyOn = _trackingSpyOn;
if (vi.spyOn !== _trackingSpyOn) {
  throw new Error('console guard: vi.spyOn interception failed to install');
}

beforeEach(() => {
  _testOwned = new Set();
  _noiseAllowed = false;
  _errorSpy = _rawSpyOn(console, 'error').mockImplementation(() => {});
  _warnSpy = _rawSpyOn(console, 'warn').mockImplementation(() => {});
  _logSpy = _rawSpyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (_noiseAllowed || _errorSpy === null) return;

  // Channels the test spied itself are the test's to assert on — the
  // guard only enforces the channels the test never touched.
  const errorCalls = _testOwned.has('error') ? [] : _errorSpy.mock.calls;
  const warnCalls = _testOwned.has('warn') ? [] : _warnSpy.mock.calls;
  const logCalls = _testOwned.has('log') ? [] : _logSpy.mock.calls;

  if (errorCalls.length === 0 && warnCalls.length === 0 && logCalls.length === 0) return;

  const lines = [
    ...errorCalls.map((a) => `  console.error(${a.map((x) => String(x)).join(', ')})`),
    ...warnCalls.map((a) => `  console.warn(${a.map((x) => String(x)).join(', ')})`),
    ...logCalls.map((a) => `  console.log(${a.map((x) => String(x)).join(', ')})`),
  ];
  throw new Error(
    `Unexpected console output in test:\n${lines.join('\n')}\n\n` +
    `Call allowConsoleNoise() (from 'tests/helpers/setup.js') to opt out.`
  );
});
