const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { AttendanceDatabase } = require('../src/database');

const legacyPath = path.resolve(process.argv[2] || './database.db');
const destinationPath = path.resolve(process.argv[3] || './data/attendance.db');
const legacy = new Database(legacyPath, { readonly: true });
const destination = new AttendanceDatabase(destinationPath);

const tables = legacy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
if (!tables.includes('users')) throw new Error('Legacy users table was not found.');

const users = legacy.prepare('SELECT id, name, fingerprint_id FROM users ORDER BY id').all();
for (const user of users) {
  try {
    destination.createUser({
      deviceUserId: String(user.fingerprint_id),
      name: user.name || `User ${user.fingerprint_id}`,
      department: '',
    });
  } catch (error) {
    if (error.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
  }
}

let importedEvents = 0;
if (tables.includes('attendance')) {
  const attendance = legacy.prepare(`
    SELECT a.id, a.timestamp, a.status, u.fingerprint_id
    FROM attendance a JOIN users u ON u.id = a.user_id
    ORDER BY a.timestamp, a.id
  `).all();
  for (const row of attendance) {
    const eventTime = String(row.timestamp).replace(' ', 'T');
    const dedupeKey = crypto.createHash('sha256').update(`legacy|${row.id}|${row.fingerprint_id}|${eventTime}`).digest('hex');
    const result = destination.recordAttendance({
      deviceUserId: String(row.fingerprint_id),
      eventTime,
      status: row.status || '',
      verifyMode: '', workCode: '', rawData: `Legacy attendance ${row.id}`, dedupeKey,
    }, 'legacy-import');
    if (!result.duplicate) importedEvents += 1;
  }
}

legacy.close();
destination.close();
console.log(`Imported ${users.length} users and ${importedEvents} attendance events.`);
