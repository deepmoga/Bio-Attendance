const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

class AttendanceDatabase {
  constructor(filename, options = {}) {
    const directory = path.dirname(filename);
    if (filename !== ':memory:') fs.mkdirSync(directory, { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.timeZone = options.timeZone || process.env.DEVICE_TIMEZONE || 'Asia/Kolkata';
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_user_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        department TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS devices (
        serial TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        ip_address TEXT NOT NULL DEFAULT '',
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_payload TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS attendance_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id),
        device_user_id TEXT NOT NULL,
        device_serial TEXT NOT NULL,
        event_time TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('check_in', 'check_out', 'unknown')),
        device_status TEXT NOT NULL DEFAULT '',
        verify_mode TEXT NOT NULL DEFAULT '',
        work_code TEXT NOT NULL DEFAULT '',
        raw_data TEXT NOT NULL DEFAULT '',
        dedupe_key TEXT NOT NULL UNIQUE,
        received_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS attendance_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        check_in_event_id INTEGER NOT NULL REFERENCES attendance_events(id),
        check_in_at TEXT NOT NULL,
        check_out_event_id INTEGER REFERENCES attendance_events(id),
        check_out_at TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed'))
      );

      CREATE TABLE IF NOT EXISTS device_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_serial TEXT NOT NULL,
        ip_address TEXT NOT NULL DEFAULT '',
        protocol TEXT NOT NULL,
        request_code TEXT NOT NULL,
        device_user_id TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        raw_payload TEXT NOT NULL DEFAULT '',
        received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS device_packet_state (
        packet_fingerprint TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL,
        last_seen_at_ms INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS one_open_session_per_user
        ON attendance_sessions(user_id) WHERE status = 'open';
      CREATE INDEX IF NOT EXISTS events_by_time ON attendance_events(event_time DESC);
      CREATE INDEX IF NOT EXISTS sessions_by_user ON attendance_sessions(user_id, check_in_at DESC);
      CREATE INDEX IF NOT EXISTS device_requests_by_time ON device_requests(received_at DESC);
    `);

    this.recordTransaction = this.db.transaction((event, serial) => {
      const user = this.db
        .prepare('SELECT * FROM users WHERE device_user_id = ? AND active = 1')
        .get(event.deviceUserId);

      const existing = this.db
        .prepare('SELECT id, action FROM attendance_events WHERE dedupe_key = ?')
        .get(event.dedupeKey);
      if (existing) return { duplicate: true, eventId: existing.id, action: existing.action };

      let action = 'unknown';
      let openSession = null;
      let durationMinutes = null;

      if (user) {
        openSession = this.db
          .prepare("SELECT * FROM attendance_sessions WHERE user_id = ? AND status = 'open'")
          .get(user.id);

        // If an open session is from a previous day or older than 18 hours, auto-close it
        if (openSession) {
          const todayDate = String(event.eventTime || '').slice(0, 10);
          const sessionDate = String(openSession.check_in_at || '').slice(0, 10);
          if (todayDate && sessionDate && sessionDate !== todayDate) {
            this.db.prepare(`
              UPDATE attendance_sessions
              SET status = 'closed', check_out_at = datetime(check_in_at, '+8 hours')
              WHERE id = ?
            `).run(openSession.id);
            openSession = null;
          }
        }

        action = openSession ? 'check_out' : 'check_in';
      }

      const result = this.db.prepare(`
        INSERT INTO attendance_events
          (user_id, device_user_id, device_serial, event_time, action, device_status,
           verify_mode, work_code, raw_data, dedupe_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        user?.id || null,
        event.deviceUserId,
        serial,
        event.eventTime,
        action,
        event.status,
        event.verifyMode,
        event.workCode,
        event.rawData,
        event.dedupeKey,
      );

      const eventId = Number(result.lastInsertRowid);
      if (action === 'check_in') {
        this.db.prepare(`
          INSERT INTO attendance_sessions (user_id, check_in_event_id, check_in_at)
          VALUES (?, ?, ?)
        `).run(user.id, eventId, event.eventTime);
      } else if (action === 'check_out') {
        this.db.prepare(`
          UPDATE attendance_sessions
          SET check_out_event_id = ?, check_out_at = ?, status = 'closed'
          WHERE id = ?
        `).run(eventId, event.eventTime, openSession.id);

        try {
          const inTime = new Date(openSession.check_in_at).getTime();
          const outTime = new Date(event.eventTime).getTime();
          if (!isNaN(inTime) && !isNaN(outTime) && outTime >= inTime) {
            durationMinutes = Math.round((outTime - inTime) / 60000);
          }
        } catch {}
      }

      return {
        duplicate: false,
        eventId,
        action,
        durationMinutes,
        eventTime: event.eventTime,
        user: user ? { id: user.id, name: user.name, deviceUserId: user.device_user_id } : null,
      };
    });
  }

  touchDevice(serial, ipAddress, payload = '') {
    this.db.prepare(`
      INSERT INTO devices (serial, ip_address, last_seen_at, last_payload)
      VALUES (?, ?, datetime('now'), ?)
      ON CONFLICT(serial) DO UPDATE SET
        ip_address = excluded.ip_address,
        last_seen_at = datetime('now'),
        last_payload = excluded.last_payload
    `).run(serial || 'unknown', ipAddress || '', String(payload).slice(0, 500));
  }

  logDeviceRequest({ serial, ipAddress = '', protocol, requestCode, deviceUserId = '', outcome, detail = '', rawPayload = '' }) {
    const result = this.db.prepare(`
      INSERT INTO device_requests
        (device_serial, ip_address, protocol, request_code, device_user_id, outcome, detail, raw_payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      serial || 'unknown', ipAddress, protocol, requestCode, deviceUserId,
      outcome, String(detail).slice(0, 300), String(rawPayload).slice(0, 2000),
    );
    this.db.prepare(`
      DELETE FROM device_requests WHERE id NOT IN (
        SELECT id FROM device_requests ORDER BY id DESC LIMIT 5000
      )
    `).run();
    return Number(result.lastInsertRowid);
  }

  listDeviceRequests(limit = 100) {
    return this.db.prepare(`
      SELECT id, device_serial AS deviceSerial, ip_address AS ipAddress,
             protocol, request_code AS requestCode, device_user_id AS deviceUserId,
             outcome, detail, raw_payload AS rawPayload, received_at AS receivedAt
      FROM device_requests ORDER BY id DESC LIMIT ?
    `).all(Math.min(Math.max(Number(limit) || 100, 1), 500));
  }

  recordAttendance(event, serial) {
    return this.recordTransaction(event, serial);
  }

  resolveDevicePacketDedupeKey(packetFingerprint, newDedupeKey, quietPeriodMs) {
    const now = Date.now();
    const recent = this.db.prepare(`
      SELECT dedupe_key AS dedupeKey, last_seen_at_ms AS lastSeenAtMs
      FROM device_packet_state WHERE packet_fingerprint = ?
    `).get(packetFingerprint);

    if (recent && now - recent.lastSeenAtMs < quietPeriodMs) {
      this.db.prepare(`
        UPDATE device_packet_state SET last_seen_at_ms = ? WHERE packet_fingerprint = ?
      `).run(now, packetFingerprint);
      return recent.dedupeKey;
    }

    this.db.prepare(`
      INSERT INTO device_packet_state (packet_fingerprint, dedupe_key, last_seen_at_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(packet_fingerprint) DO UPDATE SET
        dedupe_key = excluded.dedupe_key,
        last_seen_at_ms = excluded.last_seen_at_ms
    `).run(packetFingerprint, newDedupeKey, now);
    this.db.prepare('DELETE FROM device_packet_state WHERE last_seen_at_ms < ?')
      .run(now - (7 * 24 * 60 * 60 * 1000));
    return newDedupeKey;
  }

  listUsers() {
    return this.db.prepare(`
      SELECT u.id, u.device_user_id AS deviceUserId, u.name, u.department,
             u.active, u.created_at AS createdAt,
             CASE WHEN s.id IS NULL THEN 'out' ELSE 'in' END AS status,
             s.check_in_at AS checkedInAt,
             (SELECT e.event_time FROM attendance_events e WHERE e.user_id = u.id
              ORDER BY e.event_time DESC, e.id DESC LIMIT 1) AS lastActivity
      FROM users u
      LEFT JOIN attendance_sessions s ON s.user_id = u.id AND s.status = 'open'
      ORDER BY u.active DESC, u.name COLLATE NOCASE
    `).all().map((user) => ({ ...user, active: Boolean(user.active) }));
  }

  createUser({ deviceUserId, name, department = '' }) {
    const result = this.db.prepare(`
      INSERT INTO users (device_user_id, name, department) VALUES (?, ?, ?)
    `).run(deviceUserId, name, department);
    return this.getUser(Number(result.lastInsertRowid));
  }

  ensureEnrolledUser(deviceUserId, suggestedName = '') {
    const existing = this.db
      .prepare('SELECT id FROM users WHERE device_user_id = ?')
      .get(deviceUserId);
    if (existing) return { created: false, user: this.getUser(existing.id) };
    const name = String(suggestedName || '').trim() || `User ${deviceUserId}`;
    return { created: true, user: this.createUser({ deviceUserId, name, department: '' }) };
  }

  updateUser(id, { deviceUserId, name, department = '', active = true }) {
    const result = this.db.prepare(`
      UPDATE users SET device_user_id = ?, name = ?, department = ?, active = ?,
                       updated_at = datetime('now')
      WHERE id = ?
    `).run(deviceUserId, name, department, active ? 1 : 0, id);
    return result.changes ? this.getUser(id) : null;
  }

  getUser(id) {
    const user = this.db.prepare(`
      SELECT id, device_user_id AS deviceUserId, name, department, active,
             created_at AS createdAt, updated_at AS updatedAt
      FROM users WHERE id = ?
    `).get(id);
    return user ? { ...user, active: Boolean(user.active) } : null;
  }

  deleteUser(id) {
    this.db.prepare('DELETE FROM attendance_sessions WHERE user_id = ?').run(id);
    this.db.prepare('DELETE FROM attendance_events WHERE user_id = ?').run(id);
    const result = this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return result.changes > 0;
  }

  clearAttendance({ clearUsers = false } = {}) {
    this.db.prepare('DELETE FROM attendance_sessions').run();
    this.db.prepare('DELETE FROM attendance_events').run();
    this.db.prepare('DELETE FROM device_requests').run();
    this.db.prepare('DELETE FROM device_packet_state').run();
    if (clearUsers) {
      this.db.prepare('DELETE FROM users').run();
    }
    return { success: true };
  }


  listAttendance({ date, userId, limit = 200 } = {}) {
    const conditions = [];
    const params = [];
    if (date) {
      conditions.push('substr(e.event_time, 1, 10) = ?');
      params.push(date);
    }
    if (userId) {
      conditions.push('e.user_id = ?');
      params.push(userId);
    }
    params.push(Math.min(Math.max(Number(limit) || 200, 1), 1000));
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    return this.db.prepare(`
      SELECT e.id, e.device_user_id AS deviceUserId, e.device_serial AS deviceSerial,
             e.event_time AS eventTime, e.action, e.verify_mode AS verifyMode,
             e.received_at AS receivedAt, u.name, u.department
      FROM attendance_events e
      LEFT JOIN users u ON u.id = e.user_id
      ${where}
      ORDER BY e.event_time DESC, e.id DESC
      LIMIT ?
    `).all(...params);
  }

  listDevices() {
    return this.db.prepare(`
      SELECT serial, name, ip_address AS ipAddress, last_seen_at AS lastSeenAt
      FROM devices ORDER BY last_seen_at DESC
    `).all();
  }

  summary() {
    const users = this.listUsers();
    const activeUsers = users.filter((user) => user.active);
    const todayParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const part = (type) => todayParts.find((item) => item.type === type).value;
    const today = `${part('year')}-${part('month')}-${part('day')}`;
    const todayScans = this.db.prepare(
      'SELECT COUNT(*) AS count FROM attendance_events WHERE substr(event_time, 1, 10) = ?',
    ).get(today).count;
    return {
      users,
      counts: {
        registered: activeUsers.length,
        working: activeUsers.filter((user) => user.status === 'in').length,
        checkedOut: activeUsers.filter((user) => user.status === 'out').length,
        todayScans,
      },
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = { AttendanceDatabase };
