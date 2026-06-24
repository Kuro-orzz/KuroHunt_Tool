// content.js — chạy trong context của trang dangkyhoc.vnu.edu.vn
(function () {
  'use strict';

  const BASE = window.location.origin;

  function getToken() {
    const el = document.querySelector('input[name="__RequestVerificationToken"]');
    if (el) return el.value;
    const meta = document.querySelector('meta[name="__RequestVerificationToken"]');
    return meta ? meta.getAttribute('content') : '';
  }

  async function post(path) {
    const token = getToken();
    const body = token
      ? `__RequestVerificationToken=${encodeURIComponent(token)}`
      : '';
    const res = await fetch(BASE + path, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return res.text();
  }


  function parseCourses(html) {
    // Bọc trong <table> để DOMParser tạo đúng cấu trúc
    const doc = new DOMParser().parseFromString(
      `<table><tbody>${html}</tbody></table>`,
      'text/html'
    );
    const courses = [];

    doc.querySelectorAll('tr').forEach(row => {
      const td = row.querySelectorAll('td');
      if (td.length < 10) return;

      const cb     = row.querySelector('input[type="checkbox"][data-rowindex]');
      const isFull = !cb && td[6].classList.contains('over');

      // Bỏ qua các row không phải môn học (không có checkbox lẫn class "over")
      if (!cb && !isFull) return;

      const scheduleCell = td[9];
      courses.push({
        rowIndex:   cb?.getAttribute('data-rowindex') ?? null,
        crdId:      cb?.getAttribute('data-crdid') ?? '',
        numCrd:     Number(cb?.getAttribute('data-numcrd') ?? td[2].textContent.trim()) || 0,
        name:       td[1].textContent.trim(),
        credits:    td[2].textContent.trim(),
        code:       td[4].textContent.trim(),
        capacity:   td[5].textContent.trim(),
        registered: td[6].textContent.trim(),
        teachers:   td[7].textContent.trim(),
        fee:        td[8].querySelector('span')?.textContent.trim() ?? '',
        schedule:   scheduleCell.textContent.trim().replace(/\s+/g, ' '),
        slots:      scheduleCell.getAttribute('data-time-table-xxx') ?? '',
        full:       isFull,
      });
    });

    return courses;
  }

  function parseRegisteredCourses(html) {
    // Bọc trong <table> để <tr class="registered"> được parse đúng.
    // Các <input> không hợp lệ bên trong <tbody> sẽ được trình duyệt
    // tự động đẩy ra ngoài table nhưng vẫn nằm trong document.
    const doc = new DOMParser().parseFromString(
      `<table><tbody>${html}</tbody></table>`,
      'text/html'
    );

    const totalCourses = doc.querySelector('.total-credit')?.value ?? '?';
    const totalCredits = doc.querySelector('.total-crd')?.value ?? '?';

    const courses = [];
    doc.querySelectorAll('tr.registered, tr.pending').forEach(row => {
      const abort = row.querySelector('a.abort[data-rowindex]');
      if (!abort) return;

      const td = row.querySelectorAll('td');
      if (td.length < 10) return;

      courses.push({
        rowIndex: abort.getAttribute('data-rowindex'),
        crdId:    td[0].getAttribute('data-crdid-registered') ?? '',
        name:     td[1].textContent.trim(),
        credits:  td[2].textContent.trim(),
        code:     td[3].textContent.trim(),
        teachers: td[4].textContent.trim(),
        schedule: td[5].textContent.trim().replace(/\s+/g, ' '),
        slots:    td[5].getAttribute('data-time-table-2xxx') ?? '',
        type:     td[8].textContent.trim(),
        status:   row.classList.contains('pending') ? 'pending' : 'registered',
      });
    });

    return { courses, totalCourses, totalCredits };
  }

  // Phân tích kết quả trả về để phát hiện thông báo lỗi/thành công
  function parseResultMessage(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const alert = doc.querySelector('.alert, .message, .error, .success, [class*="notice"]');
    if (alert) return alert.textContent.trim();
    const body = doc.body?.textContent.trim();
    return body ? body.substring(0, 200) : '';
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    const done = r => { try { reply(r); } catch (_) {} };

    if (msg.type === 'ping') {
      done({ ok: true });
      return false;
    }

    if (msg.type === 'fetchCourses') {
      const m = msg.mode ?? '1';
      post(`/danh-sach-mon-hoc/1/${m}`)
        .then(html => done({ ok: true, courses: parseCourses(html) }))
        .catch(e  => done({ ok: false, error: e.message }));
      return true;
    }

    if (msg.type === 'addCourse') {
      const m = msg.mode ?? '1';
      post(`/chon-mon-hoc/${msg.rowIndex}/1/${m}`)
        .then(html => done({ ok: true, message: parseResultMessage(html) }))
        .catch(e  => done({ ok: false, error: e.message }));
      return true;
    }

    if (msg.type === 'confirmRegistration') {
      const m = msg.mode ?? '1';
      post(`/xac-nhan-dang-ky/${m}`)
        .then(html => done({ ok: true, message: parseResultMessage(html) }))
        .catch(e  => done({ ok: false, error: e.message }));
      return true;
    }

    if (msg.type === 'fetchRegisteredCourses') {
      post('/danh-sach-mon-hoc-da-dang-ky/1')
        .then(html => done({ ok: true, ...parseRegisteredCourses(html) }))
        .catch(e  => done({ ok: false, error: e.message }));
      return true;
    }

    if (msg.type === 'cancelCourse') {
      post(`/huy-mon-hoc/${msg.rowIndex}/1/1`)
        .then(html => done({ ok: true, message: parseResultMessage(html) }))
        .catch(e  => done({ ok: false, error: e.message }));
      return true;
    }
  });
})();
