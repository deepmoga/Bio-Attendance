const crypto = require('node:crypto');

const ATTENDANCE_LINE = /^(\S+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s+([^\s]+))?(?:\s+([^\s]+))?(?:\s+([^\s]+))?/;

function parseAttendanceBody(body, serial = 'unknown') {
  return String(body || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(ATTENDANCE_LINE);
      if (!match) return null;

      const [, deviceUserId, date, time, status = '', verifyMode = '', workCode = ''] = match;
      const eventTime = `${date}T${time}`;
      const dedupeKey = crypto
        .createHash('sha256')
        .update(`${serial}|${deviceUserId}|${eventTime}|${line}`)
        .digest('hex');

      return {
        deviceUserId,
        eventTime,
        status,
        verifyMode,
        workCode,
        rawData: line,
        dedupeKey,
      };
    })
    .filter(Boolean);
}

function deviceOptions(serial) {
  const stamp = Math.floor(Date.now() / 1000);
  return [
    `GET OPTION FROM: ${serial}`,
    `Stamp=${stamp}`,
    `OpStamp=${stamp}`,
    'ErrorDelay=60',
    'Delay=5',
    'TransInterval=1',
    'TransFlag=1111000000',
    'Realtime=1',
    'Encrypt=0',
  ].join('\n');
}

module.exports = { parseAttendanceBody, deviceOptions };

