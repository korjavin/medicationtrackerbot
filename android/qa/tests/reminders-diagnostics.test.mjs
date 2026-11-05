import assert from 'node:assert/strict';
import test from 'node:test';
import { permissionDiagnosticLines } from '../scenarios/reminders-offline.mjs';

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
