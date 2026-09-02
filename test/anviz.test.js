const test = require('node:test');
const assert = require('node:assert/strict');
const { extractJson, deviceTimestamp, parseAnvizAttendance } = require('../src/anviz');

test('extracts balanced JSON from an FK binary message', () => {
  const payload = Buffer.concat([
    Buffer.from([0x6b, 0, 0, 0]),
    Buffer.from('{"user_id":"18","meta":{"label":"brace } in text"},"io_time":"20260815120940"}'),
    Buffer.from([0, 0xff, 0x7d]),
  ]);
  const parsed = extractJson(payload);
  assert.equal(parsed.data.user_id, '18');
  assert.equal(parsed.data.meta.label, 'brace } in text');
});

test('uses server receipt time when the FK device clock has reset', () => {
  const timestamp = deviceTimestamp('20150101001029', 'Asia/Kolkata');
  assert.notEqual(timestamp.slice(0, 4), '2015');
  assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
});

test('parses and deduplicates FKDATAHS101 attendance payloads', () => {
  const payload = Buffer.from('k\0\0\0{"fk_bin_data_lib":"FKDATAHS101","user_id":"1","verify_mode":"1","io_mode":"0","io_time":"20150101001029"}\0');
  const event = parseAnvizAttendance(payload, '000000000000606', 'Asia/Kolkata');
  const retry = parseAnvizAttendance(payload, '000000000000606', 'Asia/Kolkata');
  assert.equal(event.deviceUserId, '1');
  assert.equal(event.verifyMode, '1');
  assert.equal(event.dedupeKey, retry.dedupeKey);
});
