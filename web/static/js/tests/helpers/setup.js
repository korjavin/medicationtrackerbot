/**
 * Global test setup — console noise guard.
 *
 * Installed via vitest.config.mjs `setupFiles`.
 *
 * Rules:
 *  - console.error, console.warn, and console.log calls in a test cause it
 *    to fail unless the test opts out by calling allowConsoleNoise().
 *  - Tests that *assert* on a console channel should keep their own
 *    vi.spyOn() setup; those calls are intercepted before the global spy
 *    and this guard never sees them.
 */
import { afterEach, beforeEach, vi } from 'vitest';

let _noiseAllowed = false;
let _errorSpy = null;
let _warnSpy = null;
let _logSpy = null;

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

beforeEach(() => {
  _noiseAllowed = false;
  _errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  _warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  _logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (_noiseAllowed || _errorSpy === null) return;

  const errorCalls = _errorSpy.mock.calls;
  const warnCalls = _warnSpy.mock.calls;
  const logCalls = _logSpy.mock.calls;

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
