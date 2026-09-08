'use strict';

// ── State ─────────────────────────────────────────────────────
let courses           = [];
let filtered          = [];
let selected          = new Set();
let registeredCourses = [];
let tabId             = null;
let canConfirm        = false;
let mode              = '1'; // '1' = theo ngành, '2' = toàn trường

// Scheduler state
let scheduleTimer  = null;
let countdownTimer = null;
let isScheduling   = false;

// Filter state (Tab 1)
let filterDays    = new Set(); // empty = all days
let filterSession = 'all';    // 'all' | 'morning' | 'afternoon' | 'evening'
let filterAvail   = false;

// Active tab
let currentTab = 'register';

// ── Messaging ─────────────────────────────────────────────────
function send(msg) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, msg, res => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res ?? { ok: false, error: 'Không nhận được phản hồi' });
      }
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────
function parseSlots(raw) {
  if (!raw) return [];
  return raw.split('-').map(seg => {
    const p = seg.split(':');
    return p.length === 3 ? { day: p[0], s: +p[1], e: +p[2] } : null;
  }).filter(Boolean);
}

function overlaps(a, b) {
  for (const x of a)
    for (const y of b)
      if (x.day === y.day && x.s <= y.e && y.s <= x.e) return true;
  return false;
}

function conflictsWithSelected(course) {
  const own = parseSlots(course.slots);
  if (!own.length) return false;
  const others = courses
    .filter(c => selected.has(c.rowIndex) && c.rowIndex !== course.rowIndex)
    .flatMap(c => parseSlots(c.slots));
  return overlaps(own, others);
}

function formatSchedule(raw) {
  return raw.split(',').map(s => s.trim()).filter(Boolean).join('\n');
}

function firstTeacher(teachers) {
  return teachers.split(',')[0].trim();
}

function extractRooms(schedStr) {
  const rooms = [...new Set(parseScheduleFull(schedStr).map(s => s.room))];
  return rooms.join(', ') || '—';
}

function setBadge(text, type) {
  const el = document.getElementById('status-badge');
  el.textContent = text;
  el.className = `badge badge-${type}`;
}

function log(text, type = '') {
  const wrap = document.getElementById('log-wrap');
  const div  = document.getElementById('log');
  wrap.classList.remove('hidden');
  const el = document.createElement('div');
  el.className = `log-entry ${type ? 'log-' + type : ''}`;
  el.textContent = `[${new Date().toLocaleTimeString('vi-VN')}] ${text}`;
  div.appendChild(el);
  div.scrollTop = div.scrollHeight;
}

// ── Tab 1: Danh sách môn đăng ký ─────────────────────────────
function renderTable() {
  const tbody = document.getElementById('tbody');
  tbody.innerHTML = '';

  filtered.forEach(course => {
    const isSelected = course.rowIndex !== null && selected.has(course.rowIndex);
    const isFull     = course.full || (course.capacity !== '' && Number(course.registered) >= Number(course.capacity));
    const isConflict = !isSelected && !isFull && conflictsWithSelected(course);

    const tr = document.createElement('tr');
    if (isSelected) tr.classList.add('row-selected');
    if (isConflict) tr.classList.add('row-conflict');
    if (isFull)     tr.classList.add('row-full');

    const dkCell  = isFull ? `<span class="badge-full">FULL</span>` : `${course.registered}/${course.capacity}`;
    const cbCell  = isFull || course.rowIndex === null
      ? ''
      : `<input type="checkbox" class="row-cb" data-idx="${course.rowIndex}"
           ${isSelected ? 'checked' : ''}
           ${isConflict ? 'disabled title="Trùng lịch với môn đã chọn"' : ''}>`;

    tr.innerHTML = `
      <td class="c">${cbCell}</td>
      <td>
        <div class="course-name">${course.name}${isConflict ? '<span class="conflict-icon" title="Trùng lịch">⚠</span>' : ''}</div>
        <div class="course-teach" title="${course.teachers}">${firstTeacher(course.teachers)}</div>
      </td>
      <td class="code-cell">${course.code}</td>
      <td class="c">${course.numCrd}</td>
      <td class="c">${dkCell}</td>
      <td class="sched-cell" style="white-space:pre-line">${formatSchedule(course.schedule)}</td>
      <td class="room-cell">${extractRooms(course.schedule)}</td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.row-cb').forEach(cb => {
    cb.addEventListener('change', e => toggleSelect(e.target.dataset.idx, e.target.checked));
  });

  updateSelectAll();
  updateActionBar();
  if (currentTab === 'timetable') renderTimetable();
}

function updateSelectAll() {
  const sa = document.getElementById('select-all');
  const selectable = filtered.filter(c => !conflictsWithSelected(c) || selected.has(c.rowIndex));
  const checkedCnt = selectable.filter(c => selected.has(c.rowIndex)).length;
  sa.indeterminate = checkedCnt > 0 && checkedCnt < selectable.length;
  sa.checked = selectable.length > 0 && checkedCnt === selectable.length;
}

function updateActionBar() {
  const count = selected.size;
  const totalTc = [...selected]
    .map(idx => courses.find(c => c.rowIndex === idx)?.numCrd ?? 0)
    .reduce((a, b) => a + b, 0);

  document.getElementById('sel-info').textContent =
    count === 0 ? 'Chưa chọn môn nào' : `Đã chọn ${count} môn · ${totalTc} tín chỉ`;

  document.getElementById('btn-add').disabled     = count === 0;
  document.getElementById('btn-confirm').disabled = !canConfirm;
}

function toggleSelect(idx, checked) {
  if (checked) selected.add(idx);
  else          selected.delete(idx);
  renderTable();
}

function applyFilter() {
  const q = document.getElementById('search-input').value.trim().toLowerCase();
  filtered = courses.filter(c => {
    if (q && !c.name.toLowerCase().includes(q) &&
             !c.code.toLowerCase().includes(q) &&
             !c.teachers.toLowerCase().includes(q)) return false;
    if (filterAvail && c.full) return false;
    if (filterDays.size > 0) {
      const slots = parseSlots(c.slots);
      if (!slots.some(s => filterDays.has(s.day))) return false;
    }
    if (filterSession !== 'all') {
      const ranges = { morning: [1, 6], afternoon: [7, 12], evening: [13, 99] };
      const [min, max] = ranges[filterSession];
      const slots = parseSlots(c.slots);
      if (!slots.some(s => s.s >= min && s.s <= max)) return false;
    }
    return true;
  });
  renderTable();
}

// ── Tab 2: Môn đã đăng ký ─────────────────────────────────────
function renderRegisteredTable() {
  const tbody = document.getElementById('reg-tbody');
  tbody.innerHTML = '';

  registeredCourses.forEach((c, i) => {
    const tr = document.createElement('tr');
    const typeClass    = c.type.includes('cải thiện') ? 'type-improve' : 'type-free';
    const statusBadge  = c.status === 'pending'
      ? '<span class="status-badge status-pending">Chờ XN</span>'
      : '<span class="status-badge status-registered">Đã ĐK</span>';

    if (c.status === 'pending') tr.classList.add('row-pending');

    tr.innerHTML = `
      <td class="c">${i + 1}</td>
      <td>
        <div class="course-name">${c.name} ${statusBadge}</div>
        <div class="course-teach" title="${c.teachers}">${firstTeacher(c.teachers)}</div>
      </td>
      <td class="code-cell">${c.code}</td>
      <td class="c">${c.credits}</td>
      <td class="sched-cell" style="white-space:pre-line">${formatSchedule(c.schedule)}</td>
      <td><span class="type-badge ${typeClass}">${c.type}</span></td>
      <td class="c">
        <button class="btn-cancel" data-idx="${c.rowIndex}" data-name="${c.name}">Hủy</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.btn-cancel').forEach(btn => {
    btn.addEventListener('click', handleCancel);
  });
}

// ── Timetable helpers ─────────────────────────────────────────
function parseScheduleFull(schedStr) {
  const result = [];
  schedStr.split(',').forEach(part => {
    const m = part.trim().match(/^(T\d+|CN)-\((\d+)-(\d+)\)-(.+)$/);
    if (m) result.push({ day: m[1], start: +m[2], end: +m[3], room: m[4] });
  });
  return result;
}

const TT_PALETTE = ['#3b82f6','#d97706','#7c3aed','#0891b2','#db2777','#ea580c','#0284c7','#65a30d'];

function renderTimetable() {
  const DAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

  // Assign a stable color per course key
  const colorMap  = {};
  const infoMap   = {}; // key → {code, type, status}
  let ci = 0;

  const selCourses = courses.filter(c => selected.has(c.rowIndex));

  registeredCourses.forEach(c => {
    const key = c.crdId || c.code;
    if (!colorMap[key]) {
      colorMap[key] = TT_PALETTE[ci++ % TT_PALETTE.length];
      infoMap[key]  = { code: c.code, type: 'reg', status: c.status };
    }
  });
  selCourses.forEach(c => {
    const key = c.crdId || c.code;
    if (!colorMap[key]) {
      colorMap[key] = TT_PALETTE[ci++ % TT_PALETTE.length];
      infoMap[key]  = { code: c.code, type: 'sel' };
    }
  });

  // Build grid — track conflicts
  // grid[day][period] = { isStart, code, room, color, conflict }
  const grid = {};
  DAYS.forEach(d => { grid[d] = {}; });

  function fillGrid(c) {
    const key   = c.crdId || c.code;
    const color = colorMap[key];
    parseScheduleFull(c.schedule).forEach(({ day, start, end, room }) => {
      if (!grid[day]) return;
      for (let p = start; p <= end; p++) {
        if (grid[day][p]) {
          grid[day][p].conflict = true; // two courses share this slot
        } else {
          grid[day][p] = { isStart: p === start, code: c.code, name: c.name, room, color, conflict: false };
        }
      }
    });
  }

  registeredCourses.forEach(c => fillGrid(c));
  selCourses.forEach(c => fillGrid(c));

  // ── Dynamic legend ───────────────────────────────────────────
  const legend = document.getElementById('tt-legend');
  legend.innerHTML = '';
  const keys = Object.keys(infoMap);

  if (keys.length === 0) {
    const msg = document.createElement('span');
    msg.className   = 'tt-empty-msg';
    msg.textContent = 'Chọn môn hoặc tải môn đã đăng ký để xem thời khóa biểu.';
    legend.appendChild(msg);
  } else {
    keys.forEach(key => {
      const info  = infoMap[key];
      const color = colorMap[key];
      const badgeClass = info.type === 'sel' ? 'legend-badge legend-sel'
        : info.status === 'pending'           ? 'legend-badge legend-pending'
        :                                       'legend-badge legend-reg';
      const badgeText = info.type === 'sel' ? 'Chọn'
        : info.status === 'pending'          ? 'Chờ XN'
        :                                      'Đã ĐK';

      const item = document.createElement('span');
      item.className = 'legend-item';
      item.innerHTML =
        `<span class="legend-dot" style="background:${color}33;border:2px solid ${color}"></span>` +
        `<span class="legend-course-code">${info.code}</span>` +
        `<span class="${badgeClass}">${badgeText}</span>`;
      legend.appendChild(item);
    });
  }

  // ── Render grid ──────────────────────────────────────────────
  const tbody = document.getElementById('tt-tbody');
  tbody.innerHTML = '';

  for (let p = 1; p <= 13; p++) {
    const tr = document.createElement('tr');
    const pTd = document.createElement('td');
    pTd.className   = 'tt-period';
    pTd.textContent = p;
    tr.appendChild(pTd);

    DAYS.forEach(day => {
      const td   = document.createElement('td');
      const cell = grid[day][p];
      td.className = 'tt-cell';

      if (cell) {
        if (cell.conflict) {
          td.style.cssText = 'background:#fee2e2;border-left:3px solid #ef4444;';
          if (cell.isStart) {
            td.innerHTML = `<div class="tt-code" style="color:#dc2626">⚠ Trùng</div>`;
          }
          td.title = 'Hai môn cùng lúc — xem lại lịch';
        } else {
          td.style.cssText =
            `background:${cell.color}28;border-left:3px solid ${cell.color};` +
            (cell.isStart ? `border-top:2px solid ${cell.color}` : 'border-top:none');
          td.title = `${cell.name} · ${cell.room}`;
          if (cell.isStart) {
            td.innerHTML =
              `<div class="tt-code">${cell.code}</div>` +
              `<div class="tt-name">${cell.name}</div>` +
              `<div class="tt-room">${cell.room}</div>`;
          }
        }
      }
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  }
}

function updateRegSummary() {
  const totalTc = registeredCourses.reduce((sum, c) => sum + Number(c.credits), 0);
  document.getElementById('reg-summary').textContent =
    registeredCourses.length > 0 ? `${registeredCourses.length} môn · ${totalTc} tín chỉ` : '';
}

async function handleCancel(e) {
  const btn      = e.currentTarget;
  const rowIndex = btn.dataset.idx;
  const name     = btn.dataset.name;

  if (!confirm(`Bạn có chắc muốn hủy môn "${name}"?`)) return;

  btn.disabled    = true;
  btn.textContent = '…';

  const res = await send({ type: 'cancelCourse', rowIndex });
  if (res.ok) {
    log(`✓ Đã hủy: ${name}${res.message ? ' — ' + res.message : ''}`, 'ok');
    registeredCourses = registeredCourses.filter(c => c.rowIndex !== rowIndex);
    renderRegisteredTable();
    updateRegSummary();
    if (registeredCourses.length === 0) {
      document.getElementById('reg-table').classList.add('hidden');
      document.getElementById('reg-empty-state').textContent = 'Chưa đăng ký môn học nào.';
      document.getElementById('reg-empty-state').classList.remove('hidden');
    }
  } else {
    log(`✗ Lỗi hủy "${name}": ${res.error}`, 'err');
    btn.disabled    = false;
    btn.textContent = 'Hủy';
  }
}

// ── Mode toggle ───────────────────────────────────────────────
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.mode === mode) return;
    mode = btn.dataset.mode;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    // Reset danh sách khi đổi mode
    courses = []; filtered = []; selected = new Set(); canConfirm = false;
    document.getElementById('courses-table').classList.add('hidden');
    document.getElementById('empty-state').textContent = 'Nhấn "Tải danh sách môn" để bắt đầu.';
    document.getElementById('empty-state').classList.remove('hidden');
    updateActionBar();
  });
});

// ── Scheduler ─────────────────────────────────────────────────

// Race mode: thêm 1 môn với retry cho đến khi thành công hoặc hết stopAt
async function addCourseWithRetry(rowIndex, retryMs, stopAt) {
  const c = courses.find(x => x.rowIndex === rowIndex);
  let attempt = 0;
  while (Date.now() < stopAt) {
    attempt++;
    const res = await send({ type: 'addCourse', rowIndex, mode });
    if (res.ok) {
      log(`✓ (lần ${attempt}) ${c?.name}${res.message ? ' — ' + res.message : ''}`, 'ok');
      return true;
    }
    await new Promise(r => setTimeout(r, retryMs));
  }
  log(`✗ Hết thời gian retry: ${c?.name}`, 'err');
  return false;
}

// Race mode: thêm tất cả môn song song (Promise.all)
async function addCoursesRace(rowIndices, retryMs, retryWindowSec) {
  const stopAt = Date.now() + retryWindowSec * 1000;
  log(`Đang đăng ký ${rowIndices.length} môn song song…`);

  const results = await Promise.all(
    rowIndices.map(idx => addCourseWithRetry(idx, retryMs, stopAt))
  );
  const okCount = results.filter(Boolean).length;

  if (okCount > 0) {
    canConfirm = true;
    document.getElementById('btn-confirm').disabled = false;
    log(
      `Đã thêm ${okCount}/${rowIndices.length} môn. Nhấn "Xác nhận đăng ký" để hoàn tất.`,
      okCount === rowIndices.length ? 'ok' : 'warn'
    );
  }
}

function cancelSchedule() {
  clearTimeout(scheduleTimer);
  clearInterval(countdownTimer);
  scheduleTimer = countdownTimer = null;
  isScheduling = false;
  document.getElementById('btn-schedule').textContent = 'Đặt hẹn giờ';
  document.getElementById('btn-schedule').classList.remove('btn-danger');
  document.getElementById('btn-schedule').classList.add('btn-primary');
  document.getElementById('countdown').classList.add('hidden');
  document.getElementById('countdown').classList.remove('firing');
}

document.getElementById('btn-schedule').addEventListener('click', async () => {
  if (isScheduling) {
    cancelSchedule();
    log('Đã hủy hẹn giờ.', 'warn');
    return;
  }

  const toAdd = [...selected].filter(idx => {
    const c = courses.find(x => x.rowIndex === idx);
    return c && !c.full;
  });
  if (!toAdd.length) {
    log('Chọn ít nhất 1 môn trước khi hẹn giờ!', 'warn');
    return;
  }

  const timeVal = document.getElementById('schedule-time').value;
  if (!timeVal) {
    log('Nhập giờ mở đăng ký!', 'warn');
    return;
  }

  const targetTime = new Date(timeVal).getTime();
  const delay = targetTime - Date.now();
  if (delay <= 0) {
    log('Giờ đặt hẹn đã qua! Vui lòng chọn lại.', 'warn');
    return;
  }

  const retryMs  = Math.max(50,  Number(document.getElementById('retry-ms').value)  || 300);
  const retrySec = Math.max(5,   Number(document.getElementById('retry-sec').value) || 60);

  // Snapshot danh sách môn tại thời điểm đặt hẹn
  const snapshot = [...toAdd];

  isScheduling = true;
  document.getElementById('btn-schedule').textContent = 'Hủy hẹn giờ';
  document.getElementById('btn-schedule').classList.remove('btn-primary');
  document.getElementById('btn-schedule').classList.add('btn-danger');

  const cd = document.getElementById('countdown');
  cd.classList.remove('hidden', 'firing');

  log(
    `Đã hẹn ${snapshot.length} môn lúc ${new Date(targetTime).toLocaleString('vi-VN')} · retry mỗi ${retryMs}ms trong ${retrySec}s`,
    'ok'
  );

  // Đếm ngược
  countdownTimer = setInterval(() => {
    const rem = targetTime - Date.now();
    if (rem <= 0) { cd.textContent = '00:00:00'; return; }
    const h = Math.floor(rem / 3600000);
    const m = Math.floor((rem % 3600000) / 60000);
    const s = Math.floor((rem % 60000) / 1000);
    cd.textContent =
      `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }, 250);

  // Kích hoạt đúng giờ
  scheduleTimer = setTimeout(async () => {
    clearInterval(countdownTimer);
    cd.textContent = 'FIRE!';
    cd.classList.add('firing');

    log('Đến giờ! Đang đăng ký…', 'ok');
    await addCoursesRace(snapshot, retryMs, retrySec);

    cancelSchedule();
    cd.classList.add('hidden');
  }, delay);
});

// ── Tab switching ─────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentTab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'));
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
    if (currentTab === 'timetable') renderTimetable();
  });
});

// ── Init ──────────────────────────────────────────────────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;

  if (!tabId) { setBadge('Lỗi', 'error'); return; }

  const pong = await send({ type: 'ping' });
  if (pong.ok) {
    setBadge('Đã kết nối', 'success');
  } else {
    setBadge('Mở trang VNU', 'error');
    document.getElementById('btn-fetch').disabled     = true;
    document.getElementById('btn-fetch-reg').disabled = true;
    document.getElementById('empty-state').textContent =
      'Vui lòng điều hướng tới dangkyhoc.vnu.edu.vn trước khi sử dụng.';
    document.getElementById('reg-empty-state').textContent =
      'Vui lòng điều hướng tới dangkyhoc.vnu.edu.vn trước khi sử dụng.';
  }
}

// ── Event listeners: Tab 1 ────────────────────────────────────
document.getElementById('btn-fetch').addEventListener('click', async () => {
  const btn = document.getElementById('btn-fetch');
  btn.disabled = true;
  btn.textContent = 'Đang tải…';
  document.getElementById('loading').classList.remove('hidden');
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('courses-table').classList.add('hidden');

  const res = await send({ type: 'fetchCourses', mode });

  btn.disabled = false;
  btn.textContent = 'Tải lại danh sách';
  document.getElementById('loading').classList.add('hidden');

  if (!res.ok) {
    log(`Lỗi tải danh sách: ${res.error}`, 'err');
    document.getElementById('empty-state').textContent = `Lỗi: ${res.error}`;
    document.getElementById('empty-state').classList.remove('hidden');
    return;
  }

  courses  = res.courses;
  filtered = [...courses];

  if (courses.length === 0) {
    document.getElementById('empty-state').textContent = 'Không tìm thấy môn học nào.';
    document.getElementById('empty-state').classList.remove('hidden');
    log('Không tìm thấy môn học trong phản hồi', 'warn');
    return;
  }

  document.getElementById('courses-table').classList.remove('hidden');
  renderTable();
  log(`Tải thành công ${courses.length} môn học`, 'ok');
});

document.getElementById('search-input').addEventListener('input', applyFilter);

// ── Filter bar ────────────────────────────────────────────────
document.querySelectorAll('.day-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const day = btn.dataset.day;
    if (filterDays.has(day)) { filterDays.delete(day); btn.classList.remove('active'); }
    else                      { filterDays.add(day);    btn.classList.add('active'); }
    applyFilter();
  });
});

document.querySelectorAll('.sess-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    filterSession = btn.dataset.sess;
    document.querySelectorAll('.sess-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    applyFilter();
  });
});

document.getElementById('filter-avail').addEventListener('change', e => {
  filterAvail = e.target.checked;
  applyFilter();
});

document.getElementById('select-all').addEventListener('change', e => {
  const selectable = filtered.filter(c => !conflictsWithSelected(c) || selected.has(c.rowIndex));
  if (e.target.checked) selectable.forEach(c => selected.add(c.rowIndex));
  else                   selectable.forEach(c => selected.delete(c.rowIndex));
  renderTable();
});

document.getElementById('btn-add').addEventListener('click', async () => {
  const toAdd = [...selected];
  if (!toAdd.length) return;

  const btn = document.getElementById('btn-add');
  btn.disabled = true;
  btn.textContent = 'Đang thêm…';

  let ok = 0;
  for (const rowIndex of toAdd) {
    const c = courses.find(x => x.rowIndex === rowIndex);
    log(`Đang thêm: ${c?.name} (${c?.code})…`);
    const res = await send({ type: 'addCourse', rowIndex, mode });
    if (res.ok) {
      log(`✓ Thêm thành công: ${c?.name}${res.message ? ' — ' + res.message : ''}`, 'ok');
      ok++;
    } else {
      log(`✗ Lỗi thêm "${c?.name}": ${res.error}`, 'err');
    }
  }

  btn.disabled = false;
  btn.textContent = 'Thêm môn đã chọn';

  if (ok > 0) {
    canConfirm = true;
    document.getElementById('btn-confirm').disabled = false;
    log(`Đã thêm ${ok}/${toAdd.length} môn. Nhấn "Xác nhận đăng ký" để hoàn tất.`,
        ok === toAdd.length ? 'ok' : 'warn');
  }
});

document.getElementById('btn-confirm').addEventListener('click', async () => {
  if (!confirm('Bạn có chắc muốn xác nhận đăng ký tất cả môn đã thêm?')) return;

  const btn = document.getElementById('btn-confirm');
  btn.disabled = true;
  btn.textContent = 'Đang xác nhận…';

  const res = await send({ type: 'confirmRegistration', mode });
  if (res.ok) {
    log(`✓ Đăng ký thành công!${res.message ? ' ' + res.message : ''}`, 'ok');
    canConfirm = false;
    setBadge('Đã đăng ký', 'success');
  } else {
    log(`✗ Lỗi xác nhận: ${res.error}`, 'err');
    btn.disabled = false;
    btn.textContent = 'Xác nhận đăng ký';
  }
});

// ── Event listeners: Tab 2 ────────────────────────────────────
document.getElementById('btn-fetch-reg').addEventListener('click', async () => {
  const btn = document.getElementById('btn-fetch-reg');
  btn.disabled = true;
  btn.textContent = 'Đang tải…';
  document.getElementById('reg-loading').classList.remove('hidden');
  document.getElementById('reg-empty-state').classList.add('hidden');
  document.getElementById('reg-table').classList.add('hidden');
  document.getElementById('reg-summary').textContent = '';

  const res = await send({ type: 'fetchRegisteredCourses' });

  btn.disabled = false;
  btn.textContent = 'Tải lại';
  document.getElementById('reg-loading').classList.add('hidden');

  if (!res.ok) {
    log(`Lỗi tải môn đã đăng ký: ${res.error}`, 'err');
    document.getElementById('reg-empty-state').textContent = `Lỗi: ${res.error}`;
    document.getElementById('reg-empty-state').classList.remove('hidden');
    return;
  }

  registeredCourses = res.courses;

  if (registeredCourses.length === 0) {
    document.getElementById('reg-empty-state').textContent = 'Chưa đăng ký môn học nào.';
    document.getElementById('reg-empty-state').classList.remove('hidden');
    log('Chưa có môn nào được đăng ký', 'warn');
    return;
  }

  document.getElementById('reg-table').classList.remove('hidden');
  renderRegisteredTable();
  updateRegSummary();
  if (currentTab === 'timetable') renderTimetable();
  log(`Tải thành công ${registeredCourses.length} môn đã đăng ký`, 'ok');
});

document.getElementById('btn-clear-log').addEventListener('click', () => {
  document.getElementById('log').innerHTML = '';
  document.getElementById('log-wrap').classList.add('hidden');
});

init();
