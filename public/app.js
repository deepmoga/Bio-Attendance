const state = { users: [], activity: [], devices: [], deviceLogs: [], search: '' };
const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function initials(name) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function displayTime(value) {
  if (!value) return '—';
  const [date, time = ''] = value.replace(' ', 'T').split('T');
  const today = new Date().toISOString().slice(0, 10);
  return date === today ? time.slice(0, 5) : `${date} ${time.slice(0, 5)}`;
}

function renderDashboard(data) {
  state.users = data.users;
  elements.workingCount.textContent = data.counts.working;
  elements.checkedOutCount.textContent = data.counts.checkedOut;
  elements.registeredCount.textContent = data.counts.registered;
  elements.todayScansCount.textContent = data.counts.todayScans;
  renderUsers();
}

function renderUsers() {
  const query = state.search.toLowerCase();
  const users = state.users.filter((user) => user.active && `${user.name} ${user.department} ${user.deviceUserId}`.toLowerCase().includes(query));
  elements.userGrid.innerHTML = users.map((user) => `
    <article class="user-card">
      <span class="avatar">${escapeHtml(initials(user.name))}</span>
      <div><h3>${escapeHtml(user.name)}</h3><p>${escapeHtml(user.department || `Biometric ID ${user.deviceUserId}`)} · ${user.status === 'in' ? `Since ${displayTime(user.checkedInAt)}` : `Last ${displayTime(user.lastActivity)}`}</p></div>
      <div><span class="status ${user.status}">${user.status === 'in' ? 'Working' : 'Out'}</span><button class="card-action" data-edit-user="${user.id}" aria-label="Edit ${escapeHtml(user.name)}">···</button></div>
    </article>
  `).join('');
  elements.emptyUsers.hidden = state.users.length > 0 || Boolean(query);
  elements.userGrid.hidden = users.length === 0;
}

function renderActivity() {
  elements.activityRows.innerHTML = state.activity.map((event) => `
    <tr><td><strong>${escapeHtml(event.name || `Unknown ID ${event.deviceUserId}`)}</strong><small>${escapeHtml(event.department || `ID ${event.deviceUserId}`)}</small></td>
    <td><span class="action ${event.action}">${event.action === 'check_in' ? 'Checked in' : event.action === 'check_out' ? 'Checked out' : 'Unregistered'}</span></td>
    <td>${escapeHtml(displayTime(event.eventTime))}</td><td>${escapeHtml(event.deviceSerial)}</td></tr>
  `).join('');
  elements.emptyActivity.hidden = state.activity.length > 0;
}

function renderDevices() {
  elements.deviceList.innerHTML = state.devices.map((device) => `
    <article class="device"><div><strong>${escapeHtml(device.name || device.serial)}</strong><small>${escapeHtml(device.ipAddress || 'Address unavailable')} · seen ${escapeHtml(displayTime(device.lastSeenAt))}</small></div><span class="device-state" title="Device has contacted the server"></span></article>
  `).join('');
  elements.emptyDevices.hidden = state.devices.length > 0;
}

function renderDeviceLogs() {
  elements.deviceLogRows.innerHTML = state.deviceLogs.map((entry) => `
    <tr><td>${escapeHtml(displayTime(entry.receivedAt))}</td><td><strong>${escapeHtml(entry.deviceSerial)}</strong><small>${escapeHtml(entry.protocol)}</small></td>
    <td>${escapeHtml(entry.requestCode)}</td><td>${escapeHtml(entry.deviceUserId || '—')}</td>
    <td><span class="log-result ${escapeHtml(entry.outcome)}">${escapeHtml(entry.outcome.replace('_', ' '))}</span></td><td>${escapeHtml(entry.detail || '—')}</td></tr>
  `).join('');
  elements.emptyDeviceLogs.hidden = state.deviceLogs.length > 0;
}

async function api(url, options) {
  const cleanUrl = new URL(url, window.location.href);
  cleanUrl.username = '';
  cleanUrl.password = '';
  const response = await fetch(cleanUrl, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function refresh() {
  const [dashboard, activity, devices, deviceLogs] = await Promise.all([
    api('/api/dashboard'), api('/api/attendance?limit=30'), api('/api/devices'), api('/api/device-logs?limit=100'),
  ]);
  renderDashboard(dashboard);
  state.activity = activity;
  state.devices = devices;
  state.deviceLogs = deviceLogs;
  renderActivity();
  renderDevices();
  renderDeviceLogs();
}

let soundEnabled = localStorage.getItem('bio_sound_enabled') !== 'false';
function updateSoundUI() {
  if (elements.soundStatus) elements.soundStatus.textContent = soundEnabled ? 'On' : 'Off';
  if (elements.soundToggle) elements.soundToggle.style.opacity = soundEnabled ? '1' : '0.7';
}
updateSoundUI();

function playChime(action) {
  if (!soundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    if (action === 'check_in') {
      // Ascending pleasant chord for check-in
      osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
      osc.frequency.exponentialRampToValueAtTime(659.25, ctx.currentTime + 0.15); // E5
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    } else {
      // Descending gentle chord for check-out
      osc.frequency.setValueAtTime(659.25, ctx.currentTime); // E5
      osc.frequency.exponentialRampToValueAtTime(440.00, ctx.currentTime + 0.2); // A4
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
      osc.start();
      osc.stop(ctx.currentTime + 0.5);
    }
  } catch {}
}

function openUserDialog(user = null) {
  elements.userForm.reset();
  elements.userId.value = user?.id || '';
  elements.userName.value = user?.name || '';
  elements.deviceUserId.value = user?.deviceUserId || '';
  elements.department.value = user?.department || '';
  elements.userActive.checked = user?.active !== false;
  elements.activeLabel.hidden = !user;
  elements.deleteUserButton.hidden = !user;
  elements.dialogTitle.textContent = user ? 'Edit user' : 'Register user';
  elements.formError.hidden = true;
  elements.userDialog.showModal();
  elements.userName.focus();
}

function formatDuration(minutes) {
  if (!minutes || minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function showToast(result) {
  const first = result.results?.find((item) => !item.duplicate);
  if (!first) return;
  
  const isCheckIn = first.action === 'check_in';
  const isCheckOut = first.action === 'check_out';
  
  playChime(first.action);
  
  elements.scanToast.className = `toast ${first.action}`;
  elements.toastIcon.textContent = isCheckIn ? '✓' : isCheckOut ? '⇥' : '?';
  elements.toastTitle.textContent = first.user?.name || `Unknown biometric ID (${first.deviceUserId || ''})`;
  
  if (isCheckIn) {
    elements.toastDetail.innerHTML = `<span class="badge badge-in">CHECKED IN</span> at ${displayTime(first.eventTime || new Date().toISOString())}`;
  } else if (isCheckOut) {
    const dur = first.durationMinutes ? ` · Worked: <strong>${formatDuration(first.durationMinutes)}</strong>` : '';
    elements.toastDetail.innerHTML = `<span class="badge badge-out">CHECKED OUT</span> at ${displayTime(first.eventTime || new Date().toISOString())}${dur}`;
  } else {
    elements.toastDetail.textContent = 'Scan received, but this ID is not registered';
  }
  
  elements.scanToast.hidden = false;
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => { elements.scanToast.hidden = true; }, 6000);
}

if (elements.soundToggle) {
  elements.soundToggle.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    localStorage.setItem('bio_sound_enabled', String(soundEnabled));
    updateSoundUI();
    if (soundEnabled) playChime('check_in');
  });
}

elements.addUserButton.addEventListener('click', () => openUserDialog());
elements.emptyAddButton.addEventListener('click', () => openUserDialog());
elements.closeDialog.addEventListener('click', () => elements.userDialog.close());
elements.cancelDialog.addEventListener('click', () => elements.userDialog.close());

if (elements.clearDataButton) {
  elements.clearDataButton.addEventListener('click', () => {
    elements.clearError.hidden = true;
    elements.wipeUsersCheckbox.checked = false;
    elements.clearDialog.showModal();
  });
}

if (elements.closeClearDialog) elements.closeClearDialog.addEventListener('click', () => elements.clearDialog.close());
if (elements.cancelClearDialog) elements.cancelClearDialog.addEventListener('click', () => elements.clearDialog.close());

if (elements.confirmClearButton) {
  elements.confirmClearButton.addEventListener('click', async () => {
    elements.confirmClearButton.disabled = true;
    try {
      await api('/api/admin/clear-attendance', {
        method: 'POST',
        body: JSON.stringify({ clearUsers: elements.wipeUsersCheckbox.checked }),
      });
      elements.clearDialog.close();
      await refresh();
    } catch (err) {
      elements.clearError.textContent = err.message || 'Failed to clear records';
      elements.clearError.hidden = false;
    } finally {
      elements.confirmClearButton.disabled = false;
    }
  });
}

if (elements.deleteUserButton) {
  elements.deleteUserButton.addEventListener('click', async () => {
    const id = elements.userId.value;
    if (!id || !confirm('Are you sure you want to delete this user? All their attendance records will be removed.')) return;
    elements.deleteUserButton.disabled = true;
    try {
      await api(`/api/users/${id}`, { method: 'DELETE' });
      elements.userDialog.close();
      await refresh();
    } catch (err) {
      elements.formError.textContent = err.message;
      elements.formError.hidden = false;
    } finally {
      elements.deleteUserButton.disabled = false;
    }
  });
}

elements.userSearch.addEventListener('input', (event) => { state.search = event.target.value; renderUsers(); });
elements.refreshButton.addEventListener('click', () => refresh().catch(console.error));
elements.refreshLogsButton.addEventListener('click', () => refresh().catch(console.error));
elements.userGrid.addEventListener('click', (event) => {
  const button = event.target.closest('[data-edit-user]');
  if (button) openUserDialog(state.users.find((user) => user.id === Number(button.dataset.editUser)));
});
elements.userForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.saveUser.disabled = true;
  elements.formError.hidden = true;
  const id = elements.userId.value;
  const body = {
    name: elements.userName.value,
    deviceUserId: elements.deviceUserId.value,
    department: elements.department.value,
    active: elements.userActive.checked,
  };
  try {
    await api(id ? `/api/users/${id}` : '/api/users', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    elements.userDialog.close();
    await refresh();
  } catch (error) {
    elements.formError.textContent = error.message;
    elements.formError.hidden = false;
  } finally {
    elements.saveUser.disabled = false;
  }
});

const streamUrl = new URL('/api/events', window.location.href);
streamUrl.username = '';
streamUrl.password = '';
const stream = new EventSource(streamUrl);
stream.onopen = () => { elements.liveDot.classList.add('live'); elements.liveText.textContent = 'Live updates connected'; };
stream.onerror = () => { elements.liveDot.classList.remove('live'); elements.liveText.textContent = 'Reconnecting…'; };
stream.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.type === 'attendance') {
    renderDashboard(message.dashboard);
    showToast(message);
    Promise.all([api('/api/attendance?limit=30'), api('/api/devices'), api('/api/device-logs?limit=100')]).then(([activity, devices, deviceLogs]) => {
      state.activity = activity; state.devices = devices; state.deviceLogs = deviceLogs; renderActivity(); renderDevices(); renderDeviceLogs();
    });
  } else if (message.type === 'users_changed') {
    renderDashboard(message.dashboard);
    Promise.all([api('/api/attendance?limit=30'), api('/api/devices'), api('/api/device-logs?limit=100')]).then(([activity, devices, deviceLogs]) => {
      state.activity = activity; state.devices = devices; state.deviceLogs = deviceLogs; renderActivity(); renderDevices(); renderDeviceLogs();
    });
  }
};

refresh().catch((error) => {
  elements.liveText.textContent = 'Unable to load dashboard';
  console.error(error);
});
