const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAttendanceBody, deviceOptions } = require('../src/adms');

test('parses tab-separated ADMS attendance records', () => {
  const events = parseAttendanceBody(
    '12\t2026-08-15 09:10:11\t0\t1\t0\n13\t2026-08-15 09:11:12\t1\t15\t2',
    'DEVICE-1',
  );

  assert.equal(events.length, 2);
  assert.deepEqual(
    {
      deviceUserId: events[0].deviceUserId,
      eventTime: events[0].eventTime,
      status: events[0].status,
      verifyMode: events[0].verifyMode,
      workCode: events[0].workCode,
    },
    { deviceUserId: '12', eventTime: '2026-08-15T09:10:11', status: '0', verifyMode: '1', workCode: '0' },
  );
  assert.equal(events[0].dedupeKey, parseAttendanceBody('12\t2026-08-15 09:10:11\t0\t1\t0', 'DEVICE-1')[0].dedupeKey);
});

test('ignores malformed device lines and emits valid ADMS options', () => {
  assert.deepEqual(parseAttendanceBody('not an attendance record', 'D1'), []);
  const options = deviceOptions('D1');
  assert.match(options, /^GET OPTION FROM: D1/m);
  assert.match(options, /^Realtime=1$/m);
});
