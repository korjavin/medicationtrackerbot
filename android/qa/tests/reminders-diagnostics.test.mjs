import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import remindersOffline, { permissionDiagnosticLines } from '../scenarios/reminders-offline.mjs';

test('captured SharedPreferences diagnostics preserve separate permission exits and retry offsets', () => {
  // Structure captured from android-qa 42014079048, with only permission-state diagnostics retained.
  const before = '<map><string name="log">2026-11-05T10:56:49Z shell notifications step stage=1 granted=false enabled=false canScheduleExactAlarms=false result=runtime-prompt';
  const after = before + '&#10;2026-11-05T10:56:53Z shell notifications step stage=2 granted=true enabled=true canScheduleExactAlarms=false result=exact-alarm-settings' +
    '&#10;2026-11-05T10:56:59Z shell notifications step stage=2 granted=true enabled=true canScheduleExactAlarms=true result=granted</string></map>';
  const lines = permissionDiagnosticLines(after);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((line) => line.split('result=')[1]), ['runtime-prompt', 'exact-alarm-settings', 'granted']);
  assert.equal(lines.slice(permissionDiagnosticLines(before).length).length, 2);
  assert.deepEqual(permissionDiagnosticLines('<map/>'), []);
});

test('two failures before normal permission collection each retain their own native exits', async () => {
  const exits = [];
  const ctx = {
    pkg: 'com.example.medtracker', results: {},
    shell: async () => '', sleep: async () => {},
    async step(name) {
      if (name === 'open the account') return { on() {} };
      // grantBoth can fail after its native step but before the inner collection finally.
      ctx.results.reminders.permissionDiagnosticsBefore = exits.length - 1;
      throw new Error('no runtime prompt or app notification settings');
    },
  };
  const adb = mock.method(childProcess, 'execFile', (file, args, _options, reply) => {
    assert.equal(file, 'adb');
    const xml = `<map><string name="log">${exits.map((line) => `2026-11-05T10:56:59Z ${line}`).join('&#10;')}</string></map>`;
    reply(null, args.includes('cat') ? xml : '');
    return {};
  });
  syncBuiltinESMExports();
  try {
    for (const result of ['runtime-prompt', 'app-settings']) {
      const line = `shell notifications step stage=1 granted=false enabled=false canScheduleExactAlarms=false result=${result}`;
      exits.push(line);
      await assert.rejects(remindersOffline(ctx), /no runtime prompt or app notification settings/);
      assert.deepEqual(ctx.results.reminders.permissionDiagnostics, [line]);
    }
    assert.equal(ctx.results.reminders.attempts, 2);
  } finally {
    adb.mock.restore();
    syncBuiltinESMExports();
  }
});
