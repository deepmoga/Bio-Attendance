const crypto = require('node:crypto');

function extractJson(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        const rawJson = text.slice(start, index + 1);
        try {
          return { data: JSON.parse(rawJson), rawJson };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function localTimestamp(timeZone = 'Asia/Kolkata', date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
}

function deviceTimestamp(value, timeZone) {
  const match = String(value || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return localTimestamp(timeZone);
  const [, year, month, day, hour, minute, second] = match;
  const currentYear = Number(localTimestamp(timeZone).slice(0, 4));
  // Some FK devices lose their clock and revert to 2015. Use receipt time in that case.
  if (Math.abs(Number(year) - currentYear) > 1) return localTimestamp(timeZone);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

function parseAnvizAttendance(buffer, serial, timeZone) {
  const parsed = extractJson(buffer);
  if (!parsed || !parsed.data.user_id) return null;
  const data = parsed.data;
  const deviceUserId = String(data.user_id).trim();
  const dedupeKey = crypto
    .createHash('sha256')
    .update(`fkweb|${serial}|${deviceUserId}|${data.io_time || ''}|${parsed.rawJson}`)
    .digest('hex');
  return {
    deviceUserId,
    eventTime: deviceTimestamp(data.io_time, timeZone),
    status: String(data.io_mode || ''),
    verifyMode: String(data.verify_mode || ''),
    workCode: '',
    rawData: parsed.rawJson,
    dedupeKey,
  };
}

module.exports = { extractJson, localTimestamp, deviceTimestamp, parseAnvizAttendance };
