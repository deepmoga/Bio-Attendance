const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');

function loadLocalEnvironment(filename = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(filename)) return;
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadLocalEnvironment();

const { AttendanceDatabase } = require('./database');
const { parseAttendanceBody, deviceOptions } = require('./adms');
const { extractJson, localTimestamp, parseAnvizAttendance } = require('./anviz');

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createApp(options = {}) {
  const databasePath = options.databasePath || process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'attendance.db');
  const db = options.db || new AttendanceDatabase(databasePath);
  const app = express();
  const clients = new Set();
  const timeZone = options.timeZone || process.env.DEVICE_TIMEZONE || 'Asia/Kolkata';
  const scanDebounceMs = (Number(options.scanDebounceSeconds ?? process.env.DEVICE_SCAN_DEBOUNCE_SECONDS) || 5) * 1000;
  const broadcast = (message) => {
    const payload = JSON.stringify(message);
    for (const client of clients) client.write(`data: ${payload}\n\n`);
  };

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use((request, response, next) => {
    response.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    next();
  });

  const deviceText = express.text({ type: '*/*', limit: '2mb' });
  const deviceSerial = (request) => String(request.query.SN || request.query.sn || 'unknown').trim();
  const deviceIp = (request) => request.ip || request.socket.remoteAddress || '';

  app.get('/health', (_request, response) => {
    response.json({ ok: true, service: 'biometric-attendance' });
  });

  app.get('/iclock/cdata', (request, response) => {
    const serial = deviceSerial(request);
    db.touchDevice(serial, deviceIp(request));
    response.type('text/plain').send(deviceOptions(serial));
  });

  app.post('/iclock/cdata', deviceText, (request, response) => {
    const serial = deviceSerial(request);
    const table = String(request.query.table || '').toUpperCase();
    db.touchDevice(serial, deviceIp(request), request.body);

    if (table !== 'ATTLOG') {
      return response.type('text/plain').send('OK');
    }

    const events = parseAttendanceBody(request.body, serial);
    const results = events.map((event) => db.recordAttendance(event, serial));
    const freshResults = results.filter((result) => !result.duplicate);
    if (freshResults.length) {
      broadcast({ type: 'attendance', results: freshResults, dashboard: db.summary() });
    }
    const outcome = freshResults[0]?.action || (events.length ? 'duplicate' : 'ignored');
    if (outcome !== 'duplicate') {
      db.logDeviceRequest({
        serial, ipAddress: deviceIp(request), protocol: 'ADMS', requestCode: table || 'cdata',
        deviceUserId: events[0]?.deviceUserId || '', outcome,
        detail: events.length ? `${events.length} biometric scan(s)` : 'No valid attendance records found',
        rawPayload: request.body,
      });
    }
    return response.type('text/plain').send(`OK: ${events.length}`);
  });

  app.get('/iclock/getrequest', (request, response) => {
    const serial = deviceSerial(request);
    db.touchDevice(serial, deviceIp(request));
    response.type('text/plain').send('OK');
  });

  app.post('/iclock/devicecmd', deviceText, (request, response) => {
    const serial = deviceSerial(request);
    db.touchDevice(serial, deviceIp(request), request.body);
    response.type('text/plain').send('OK');
  });

  app.all(['/iclock/ping', '/iclock/registry'], deviceText, (request, response) => {
    db.touchDevice(deviceSerial(request), deviceIp(request), request.body);
    response.type('text/plain').send('OK');
  });

  app.post(['/fkwebserver/', '/fkwebserver'], express.raw({ type: '*/*', limit: '4mb' }), (request, response) => {
    const requestCode = String(request.headers.request_code || '').toLowerCase();
    const serial = String(request.headers.dev_id || 'unknown').trim();
    const parsed = extractJson(request.body);
    db.touchDevice(serial, deviceIp(request), parsed?.rawJson || '');

    let outcome = 'received';
    let detail = '';
    let deviceUserId = parsed?.data?.user_id ? String(parsed.data.user_id).trim() : '';

    if (requestCode === 'realtime_glog') {
      const event = parseAnvizAttendance(request.body, serial, timeZone);
      if (event) {
        const payloadFingerprint = crypto.createHash('sha256')
          .update(`glog|${serial}|${event.deviceUserId}|${parsed?.rawJson || ''}`)
          .digest('hex');
        const newDedupeKey = crypto.createHash('sha256')
          .update(`${payloadFingerprint}|${Date.now()}|${crypto.randomUUID()}`)
          .digest('hex');
        event.dedupeKey = db.resolveDevicePacketDedupeKey(
          payloadFingerprint,
          newDedupeKey,
          scanDebounceMs,
        );

        const result = db.recordAttendance(event, serial);
        outcome = result.duplicate ? 'duplicate' : result.action;
        detail = result.user?.name || `Unknown user ${event.deviceUserId}`;
        if (!result.duplicate) {
          console.log(`\x1b[32m[ATTENDANCE ${result.action.toUpperCase()}]\x1b[0m User: ${result.user?.name || result.deviceUserId} (ID: ${result.user?.deviceUserId || result.deviceUserId}) at ${result.eventTime}${result.durationMinutes ? ` | Duration: ${result.durationMinutes}m` : ''}`);
          broadcast({ type: 'attendance', results: [result], dashboard: db.summary() });
        } else {
          console.log(`\x1b[33m[DUPLICATE IGNORED]\x1b[0m User ID: ${event.deviceUserId}`);
        }
      } else {
        outcome = 'ignored';
        detail = 'Attendance payload could not be parsed';
      }
    } else if (requestCode === 'realtime_enroll_data' && parsed?.data?.user_id) {
      const enrollment = db.ensureEnrolledUser(
        deviceUserId,
        parsed.data.user_name,
      );
      if (enrollment.created) {
        outcome = 'registered';
        detail = `${enrollment.user.name} was added from device enrollment`;
        broadcast({ type: 'users_changed', dashboard: db.summary() });
      } else {
        // Some FKDATAHS101 terminals emit enrollment data, not realtime_glog,
        // when an enrolled finger is verified. Treat it as a scan only for an
        // existing user. Repeated identical uploads share one key until the
        // terminal has been quiet for the configured debounce period.
        const payloadFingerprint = crypto.createHash('sha256')
          .update(`${serial}|${deviceUserId}|${parsed.rawJson}`)
          .digest('hex');
        const newDedupeKey = crypto.createHash('sha256')
          .update(`${payloadFingerprint}|${Date.now()}|${crypto.randomUUID()}`)
          .digest('hex');
        const dedupeKey = db.resolveDevicePacketDedupeKey(
          payloadFingerprint,
          newDedupeKey,
          scanDebounceMs,
        );
        const result = db.recordAttendance({
          deviceUserId,
          eventTime: localTimestamp(timeZone),
          status: 'enrollment_fallback',
          verifyMode: 'enrollment_fallback',
          workCode: '',
          rawData: parsed.rawJson,
          dedupeKey,
        }, serial);
        outcome = result.duplicate ? 'duplicate' : result.action;
        detail = `${enrollment.user.name} · enrollment packet used as attendance`;
        if (!result.duplicate) {
          console.log(`\x1b[32m[ATTENDANCE ${result.action.toUpperCase()}]\x1b[0m User: ${enrollment.user.name} (ID: ${deviceUserId}) at ${result.eventTime}${result.durationMinutes ? ` | Duration: ${result.durationMinutes}m` : ''}`);
          broadcast({ type: 'attendance', results: [result], dashboard: db.summary() });
        } else {
          console.log(`\x1b[33m[DUPLICATE DEBOUNCED]\x1b[0m User: ${enrollment.user.name} (ID: ${deviceUserId})`);
        }
      }
    } else if (!parsed) {
      outcome = 'ignored';
      detail = 'No valid JSON object found in binary payload';
    }

    // The terminal can resend one accepted packet hundreds of times and also
    // polls receive_cmd while idle. Keep the user-facing log event-based: one
    // row for the accepted biometric action, registration, or malformed data.
    const isDevicePoll = requestCode === 'receive_cmd';
    if (!isDevicePoll && outcome !== 'duplicate') {
      db.logDeviceRequest({
        serial, ipAddress: deviceIp(request), protocol: 'FKWebServer', requestCode: requestCode || 'unknown',
        deviceUserId, outcome, detail, rawPayload: parsed?.rawJson || '',
      });
    }

    // The vendor FKWebServer sample acknowledges messages with an empty result.
    response.json({ result: '' });
  });

  const requireAuth = options.requireAuth !== undefined
    ? options.requireAuth
    : (options.adminPassword !== undefined
      ? Boolean(options.adminPassword)
      : (process.env.REQUIRE_AUTH !== undefined
        ? process.env.REQUIRE_AUTH === 'true'
        : Boolean(process.env.ADMIN_PASSWORD)));
  const adminUsername = options.adminUsername ?? process.env.ADMIN_USERNAME ?? 'admin';
  const adminPassword = options.adminPassword ?? process.env.ADMIN_PASSWORD ?? 'admin';

  if (requireAuth) {
    app.use((request, response, next) => {
      const authorization = request.headers.authorization || '';
      const encoded = authorization.startsWith('Basic ') ? authorization.slice(6) : '';
      let username = '';
      let password = '';
      try {
        [username, password] = Buffer.from(encoded, 'base64').toString('utf8').split(/:(.*)/s, 2);
      } catch {}

      if (safeEqual(username, adminUsername) && safeEqual(password, adminPassword)) return next();
      response.set('WWW-Authenticate', 'Basic realm="Attendance Dashboard", charset="UTF-8"');
      return response.status(401).send('Authentication required');
    });
  }

  app.use(express.json({ limit: '100kb' }));

  app.get('/api/dashboard', (_request, response) => response.json(db.summary()));
  app.get('/api/users', (_request, response) => response.json(db.listUsers()));
  app.post('/api/users', (request, response, next) => {
    try {
      const input = validateUser(request.body);
      const user = db.createUser(input);
      broadcast({ type: 'users_changed', dashboard: db.summary() });
      response.status(201).json(user);
    } catch (error) {
      next(error);
    }
  });
  app.put('/api/users/:id', (request, response, next) => {
    try {
      const input = validateUser(request.body, true);
      const user = db.updateUser(Number(request.params.id), input);
      if (!user) return response.status(404).json({ error: 'User not found' });
      broadcast({ type: 'users_changed', dashboard: db.summary() });
      return response.json(user);
    } catch (error) {
      return next(error);
    }
  });
  app.delete('/api/users/:id', (request, response) => {
    const success = db.deleteUser(Number(request.params.id));
    if (!success) return response.status(404).json({ error: 'User not found' });
    broadcast({ type: 'users_changed', dashboard: db.summary() });
    return response.json({ success: true });
  });

  app.post('/api/admin/clear-attendance', (request, response) => {
    const clearUsers = Boolean(request.body?.clearUsers);
    db.clearAttendance({ clearUsers });
    broadcast({ type: 'users_changed', dashboard: db.summary() });
    return response.json({ success: true, message: 'Attendance records cleared successfully' });
  });

  app.get('/api/attendance', (request, response) => {
    response.json(db.listAttendance({
      date: request.query.date,
      userId: request.query.userId,
      limit: request.query.limit,
    }));
  });
  app.get('/api/devices', (_request, response) => response.json(db.listDevices()));
  app.get('/api/device-logs', (request, response) => response.json(db.listDeviceRequests(request.query.limit)));
  app.get('/api/events', (request, response) => {
    response.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    response.flushHeaders();
    response.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    clients.add(response);
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 25000);
    request.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(response);
    });
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
  app.use((request, response) => {
    if (request.path.startsWith('/api/')) return response.status(404).json({ error: 'Not found' });
    return response.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.use((error, _request, response, _next) => {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return response.status(409).json({ error: 'That biometric user ID is already registered.' });
    }
    if (error.statusCode) return response.status(error.statusCode).json({ error: error.message });
    console.error(error);
    return response.status(500).json({ error: 'Unexpected server error' });
  });

  return { app, db };
}

function validateUser(body, allowActive = false) {
  const deviceUserId = String(body?.deviceUserId || '').trim();
  const name = String(body?.name || '').trim();
  const department = String(body?.department || '').trim();
  if (!deviceUserId || deviceUserId.length > 40 || !/^[\w.-]+$/.test(deviceUserId)) {
    throw Object.assign(new Error('Enter a valid biometric user ID (letters, numbers, dot, dash, or underscore).'), { statusCode: 400 });
  }
  if (!name || name.length > 100) {
    throw Object.assign(new Error('Name is required and must be 100 characters or fewer.'), { statusCode: 400 });
  }
  if (department.length > 100) {
    throw Object.assign(new Error('Department must be 100 characters or fewer.'), { statusCode: 400 });
  }
  return { deviceUserId, name, department, active: allowActive ? body.active !== false : true };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  const { app } = createApp();
  app.listen(port, '0.0.0.0', () => {
    console.log(`Biometric attendance listening on port ${port}`);
    if (!process.env.ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set; the development password is admin.');
  });
}

module.exports = { createApp, validateUser, loadLocalEnvironment };
