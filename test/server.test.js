const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');

async function withServer(run) {
  const { app, db } = createApp({ databasePath: ':memory:', adminUsername: 'tester', adminPassword: 'secret' });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
}

const authorization = `Basic ${Buffer.from('tester:secret').toString('base64')}`;

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: authorization, 'Content-Type': 'application/json', ...options.headers },
  });
  return { response, body: await response.json() };
}

test('registers multiple users and toggles scans from in to out', async () => {
  await withServer(async (baseUrl) => {
    for (const user of [
      { deviceUserId: '12', name: 'Aman Singh', department: 'Operations' },
      { deviceUserId: '13', name: 'Meera Kaur', department: 'Accounts' },
    ]) {
      const { response } = await requestJson(`${baseUrl}/api/users`, { method: 'POST', body: JSON.stringify(user) });
      assert.equal(response.status, 201);
    }

    let response = await fetch(`${baseUrl}/iclock/cdata?SN=TEST-1&table=ATTLOG`, {
      method: 'POST', body: '12\t2026-08-15 09:10:11\t0\t1\t0', headers: { 'Content-Type': 'text/plain' },
    });
    assert.equal(await response.text(), 'OK: 1');

    let dashboard = (await requestJson(`${baseUrl}/api/dashboard`)).body;
    assert.equal(dashboard.counts.registered, 2);
    assert.equal(dashboard.counts.working, 1);
    assert.equal(dashboard.users.find((user) => user.deviceUserId === '12').status, 'in');

    // A device retry of the identical record must not flip the user back out.
    await fetch(`${baseUrl}/iclock/cdata?SN=TEST-1&table=ATTLOG`, {
      method: 'POST', body: '12\t2026-08-15 09:10:11\t0\t1\t0', headers: { 'Content-Type': 'text/plain' },
    });
    dashboard = (await requestJson(`${baseUrl}/api/dashboard`)).body;
    assert.equal(dashboard.counts.working, 1);

    await fetch(`${baseUrl}/iclock/cdata?SN=TEST-1&table=ATTLOG`, {
      method: 'POST', body: '12\t2026-08-15 17:30:00\t0\t1\t0', headers: { 'Content-Type': 'text/plain' },
    });
    dashboard = (await requestJson(`${baseUrl}/api/dashboard`)).body;
    assert.equal(dashboard.counts.working, 0);
    assert.equal(dashboard.users.find((user) => user.deviceUserId === '12').status, 'out');

    const activity = (await requestJson(`${baseUrl}/api/attendance`)).body;
    assert.deepEqual(activity.map((event) => event.action), ['check_out', 'check_in']);
  });
});

test('stores unknown IDs without changing registered attendance', async () => {
  await withServer(async (baseUrl) => {
    await fetch(`${baseUrl}/iclock/cdata?SN=TEST-2&table=ATTLOG`, {
      method: 'POST', body: '999\t2026-08-15 10:00:00\t0\t1\t0', headers: { 'Content-Type': 'text/plain' },
    });
    const activity = (await requestJson(`${baseUrl}/api/attendance`)).body;
    assert.equal(activity[0].action, 'unknown');
    assert.equal(activity[0].deviceUserId, '999');
  });
});

test('protects dashboard APIs while leaving the device endpoint accessible', async () => {
  await withServer(async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/dashboard`)).status, 401);
    const response = await fetch(`${baseUrl}/iclock/cdata?SN=TEST-3`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /GET OPTION FROM: TEST-3/);
  });
});

test('supports the connected FKWebServer terminal protocol', async () => {
  await withServer(async (baseUrl) => {
    const enrollment = Buffer.from('v\0\0\0{"user_id":"7","user_name":"Device User","user_privilege":"USER","enroll_data_array":[]}\0');
    let response = await fetch(`${baseUrl}/fkwebserver/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', request_code: 'realtime_enroll_data', dev_id: 'FK-606' },
      body: enrollment,
    });
    assert.deepEqual(await response.json(), { result: '' });

    const users = (await requestJson(`${baseUrl}/api/users`)).body;
    assert.equal(users[0].deviceUserId, '7');
    assert.equal(users[0].name, 'Device User');

    const scan = Buffer.from('k\0\0\0{"fk_bin_data_lib":"FKDATAHS101","user_id":"7","verify_mode":"1","io_mode":"0","io_time":"20150101001029"}\0');
    response = await fetch(`${baseUrl}/fkwebserver/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', request_code: 'realtime_glog', dev_id: 'FK-606' },
      body: scan,
    });
    assert.deepEqual(await response.json(), { result: '' });

    // A retry of the same binary packet remains a single check-in.
    await fetch(`${baseUrl}/fkwebserver/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', request_code: 'realtime_glog', dev_id: 'FK-606' },
      body: scan,
    });
    const dashboard = (await requestJson(`${baseUrl}/api/dashboard`)).body;
    assert.equal(dashboard.counts.working, 1);
    assert.equal(dashboard.counts.todayScans, 1);
    assert.equal(dashboard.users[0].status, 'in');
  });
});

test('uses repeated enrollment packets as debounced scans for an existing user', async () => {
  await withServer(async (baseUrl) => {
    await requestJson(`${baseUrl}/api/users`, {
      method: 'POST',
      body: JSON.stringify({ deviceUserId: '8', name: 'Existing User', department: '' }),
    });
    const enrollment = Buffer.from('v\0\0\0{"user_id":"8","user_name":"","user_privilege":"USER","enroll_data_array":[{"backup_number":0,"enroll_data":"BIN_1"}]}\0');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await fetch(`${baseUrl}/fkwebserver/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', request_code: 'realtime_enroll_data', dev_id: 'FK-606' },
        body: enrollment,
      });
    }

    const dashboard = (await requestJson(`${baseUrl}/api/dashboard`)).body;
    assert.equal(dashboard.counts.working, 1);
    assert.equal(dashboard.counts.todayScans, 1);
    const logs = (await requestJson(`${baseUrl}/api/device-logs`)).body;
    assert.equal(logs.length, 1);
    assert.deepEqual(logs.map((entry) => entry.outcome), ['check_in']);
  });
});

test('does not expose idle polls or device retries as biometric scan logs', async () => {
  await withServer(async (baseUrl) => {
    await requestJson(`${baseUrl}/api/users`, {
      method: 'POST',
      body: JSON.stringify({ deviceUserId: '9', name: 'Quiet Logs', department: '' }),
    });
    const enrollment = Buffer.from('v\0\0\0{"user_id":"9","user_name":"","user_privilege":"USER","enroll_data_array":[{"backup_number":0,"enroll_data":"BIN_2"}]}\0');
    const headers = { 'Content-Type': 'application/octet-stream', dev_id: 'FK-606' };

    await fetch(`${baseUrl}/fkwebserver/`, {
      method: 'POST', headers: { ...headers, request_code: 'receive_cmd' }, body: Buffer.from('{}'),
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await fetch(`${baseUrl}/fkwebserver/`, {
        method: 'POST', headers: { ...headers, request_code: 'realtime_enroll_data' }, body: enrollment,
      });
    }

    const logs = (await requestJson(`${baseUrl}/api/device-logs`)).body;
    assert.equal(logs.length, 1);
    assert.equal(logs[0].outcome, 'check_in');
  });
});

test('remembers enrollment retry streams across server restarts', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-retry-'));
  const databasePath = path.join(directory, 'attendance.db');
  const enrollment = Buffer.from('v\0\0\0{"user_id":"10","user_name":"","user_privilege":"USER","enroll_data_array":[{"backup_number":0,"enroll_data":"BIN_3"}]}\0');

  try {
    for (let restart = 0; restart < 2; restart += 1) {
      const { app, db } = createApp({ databasePath, adminUsername: 'tester', adminPassword: 'secret' });
      const server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      try {
        if (restart === 0) {
          await requestJson(`${baseUrl}/api/users`, {
            method: 'POST',
            body: JSON.stringify({ deviceUserId: '10', name: 'Restart Safe', department: '' }),
          });
        }
        await fetch(`${baseUrl}/fkwebserver/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', request_code: 'realtime_enroll_data', dev_id: 'FK-606' },
          body: enrollment,
        });
      } finally {
        await new Promise((resolve) => server.close(resolve));
        db.close();
      }
    }

    const { app, db } = createApp({ databasePath, adminUsername: 'tester', adminPassword: 'secret' });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      const dashboard = (await requestJson(`${baseUrl}/api/dashboard`)).body;
      assert.equal(dashboard.counts.todayScans, 1);
      assert.equal(dashboard.counts.working, 1);
      const logs = (await requestJson(`${baseUrl}/api/device-logs`)).body;
      assert.equal(logs.length, 1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
