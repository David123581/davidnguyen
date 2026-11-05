'use strict';

(() => {
  const root = document.getElementById('app');
  const pad = (n) => String(n).padStart(3, '0');

  // ---------- tiện ích ----------
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled') e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }

  let toastTimer;
  function toast(msg, isErr) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = h('div', { class: 'toast' + (isErr ? ' err' : ''), role: 'status' }, msg);
    document.body.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), isErr ? 5000 : 2500);
  }

  async function api(method, path, body) {
    const r = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Cần đăng nhập'); }
    if (!r.ok) throw new Error(data.error || 'Có lỗi xảy ra');
    return data;
  }
  const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

  const ls = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* bỏ qua */ } },
  };

  const ymd = (d) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
  const todayStr = () => ymd(new Date());
  const monthNow = () => todayStr().slice(0, 7);
  const monthLabel = (m) => `${m.slice(5)}/${m.slice(0, 4)}`;

  // ---------- đăng nhập & khung ----------
  function showLogin() {
    stopLive();
    const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'current-password', placeholder: 'Mã PIN', 'aria-label': 'Mã PIN' });
    const err = h('div', { style: 'color:var(--red);margin-top:8px', role: 'alert' });
    const submit = async () => {
      try { await api('POST', '/api/login', { pin: pin.value }); boot(); } catch (e) { err.textContent = e.message; pin.select(); }
    };
    pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    root.replaceChildren(h('div', { class: 'login' },
      h('div', { class: 'card' },
        h('h1', null, 'Tổ trưởng bảo vệ'),
        h('p', { class: 'muted' }, 'Nhập mã PIN để quản lý.'),
        pin,
        h('button', { class: 'primary', style: 'width:100%;margin-top:12px', onclick: submit }, 'Đăng nhập'),
        err)));
    pin.focus();
  }

  const TABS = [
    ['goi-so', 'Gọi số', viewQueue],
    ['kiem-tra', 'Kiểm tra', viewChecklist],
    ['lich-truc', 'Lịch trực', viewRoster],
    ['danh-gia', 'Đánh giá tháng', viewEvals],
    ['danh-ba', 'Danh bạ', viewContacts],
    ['cai-dat', 'Cài đặt', viewSettings],
  ];

  let live = null; // {es, timer}
  function stopLive() {
    if (live) { live.es && live.es.close(); clearInterval(live.timer); live = null; }
  }

  async function boot() {
    try { await api('GET', '/api/me'); } catch { return; }
    render();
  }

  function render() {
    stopLive();
    const id = (location.hash || '#goi-so').slice(1);
    const tab = TABS.find((t) => t[0] === id) || TABS[0];
    const main = h('main', { class: 'wrap' });
    root.replaceChildren(
      h('nav', { class: 'tabs', 'aria-label': 'Chức năng' }, TABS.map((t) => h('a', { href: `#${t[0]}`, class: t[0] === tab[0] ? 'on' : '' }, t[1]))),
      main);
    Promise.resolve(tab[2](main)).catch((e) => main.replaceChildren(h('div', { class: 'card' }, `Lỗi: ${e.message}`)));
  }
  window.addEventListener('hashchange', render);

  // ---------- 1. Gọi số ----------
  async function viewQueue(main) {
    let counter = Number(ls.get('counter', '1')) || 1;
    let data = await api('GET', '/api/queue');
    let key = (await api('GET', '/api/ticket-key')).key;
    const box = h('div');
    main.append(box);
    const qrPrint = h('div', { id: 'qrprint' });
    main.append(qrPrint);

    const act = (path, extra) => guard(async () => {
      const r = await api('POST', path, { counter, ...extra });
      if (path.endsWith('/call') && !r.ticket) toast('Không còn khách đang chờ');
      else if (r.ticket) toast(`Đã gọi số ${pad(r.ticket.number)} - quầy ${counter}`);
      await refresh();
    });

    async function refresh() { data = await api('GET', '/api/queue'); draw(); }

    function qrUrl() { return `${location.origin}/lay-so?k=${key}`; }
    function qrImg() {
      const q = qrcode(0, 'M');
      q.addData(qrUrl());
      q.make();
      return h('img', { src: q.createDataURL(8, 2), alt: 'Mã QR lấy số' });
    }

    function draw() {
      if (counter > data.counters) counter = 1;
      const serving = new Map(data.tickets.filter((t) => t.status === 'serving').map((t) => [t.counter, t]));
      const mine = serving.get(counter);
      const waiting = data.tickets.filter((t) => t.status === 'waiting');
      const skipped = data.tickets.filter((t) => t.status === 'skipped');
      const manual = h('input', { type: 'number', min: '1', placeholder: 'Số cần gọi', style: 'min-width:110px;flex:1', 'aria-label': 'Gọi số cụ thể' });

      box.replaceChildren(
        h('div', { class: 'card' },
          h('h2', null, 'Bạn đang điều khiển quầy nào?'),
          h('div', { class: 'counters' }, Array.from({ length: data.counters }, (_, i) => i + 1).map((c) =>
            h('button', { class: c === counter ? 'on' : '', onclick: () => { counter = c; ls.set('counter', String(c)); draw(); } }, `Quầy ${c}`))),
          h('div', { class: 'actions' },
            h('button', { class: 'primary callnext', onclick: act('/api/queue/call') }, `GỌI SỐ TIẾP → QUẦY ${counter}`),
            h('button', { onclick: act('/api/queue/recall'), disabled: !mine }, 'Gọi lại'),
            h('button', { onclick: act('/api/queue/skip'), disabled: !mine }, 'Khách vắng (bỏ qua)'),
            h('button', { onclick: act('/api/queue/done'), disabled: !mine }, 'Hoàn tất'),
            h('div', { class: 'row', style: 'flex-wrap:nowrap' }, manual,
              h('button', { onclick: guard(async () => { if (!manual.value) return; await act('/api/queue/call-number', { number: Number(manual.value) })(); }) }, 'Gọi')))),

        h('div', { class: 'card' },
          h('div', { class: 'now' }, Array.from({ length: data.counters }, (_, i) => i + 1).map((c) => {
            const t = serving.get(c);
            return h('div', { class: 'c' + (c === counter ? ' me' : '') }, h('div', { class: 'muted' }, `Quầy ${c}`), h('div', { class: 'n' + (t ? '' : ' idle') }, t ? pad(t.number) : '---'));
          })),
          h('p', { class: 'stats muted' },
            h('span', null, `Đã cấp: ${data.stats.issued}`), h('span', null, `Đang chờ: ${data.stats.waiting}`),
            h('span', null, `Hoàn tất: ${data.stats.done}`), h('span', null, `Bỏ qua: ${data.stats.skipped}`))),

        h('div', { class: 'card' },
          h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'margin:0' }, `Đang chờ (${waiting.length})`),
            h('button', {
              onclick: guard(async () => {
                const name = prompt('Tên khách (có thể để trống):') ?? null;
                if (name === null) return;
                const r = await api('POST', '/api/queue/issue', { name });
                toast(`Đã cấp số ${pad(r.number)} cho khách`);
                await refresh();
              }),
            }, '+ Cấp số cho khách không có điện thoại')),
          waiting.length ? h('div', { class: 'tickets', style: 'margin-top:10px' }, waiting.map((t) => h('div', { class: 'tk' }, h('b', null, pad(t.number)), t.name && h('span', { class: 'muted' }, t.name),
            h('button', { onclick: act('/api/queue/call-number', { number: t.number }) }, 'Gọi'))))
            : h('p', { class: 'muted' }, 'Chưa có khách chờ.'),
          skipped.length ? h('div', null, h('h3', { style: 'margin-top:14px' }, 'Đã bỏ qua (gọi lại nếu khách quay lại)'),
            h('div', { class: 'tickets' }, skipped.map((t) => h('div', { class: 'tk skipped' }, h('b', null, pad(t.number)), h('button', { onclick: act('/api/queue/call-number', { number: t.number }) }, 'Gọi lại'))))) : null),

        h('div', { class: 'card qrbox no-print' },
          h('h2', null, 'Mã QR cho khách lấy số'),
          qrImg(),
          h('p', { class: 'muted', style: 'word-break:break-all' }, qrUrl()),
          h('div', { class: 'row', style: 'justify-content:center' },
            h('button', { onclick: () => { qrPrint.replaceChildren(h('h1', null, 'Quét mã QR để lấy số thứ tự'), qrImg()); document.body.classList.add('print-qr'); window.print(); document.body.classList.remove('print-qr'); } }, 'In mã QR'),
            h('button', { onclick: () => window.open('/tv', '_blank') }, 'Mở màn hình tivi'),
            h('button', {
              class: 'danger',
              onclick: guard(async () => {
                if (!confirm('Tạo mã QR mới? Mã QR đang dán sẽ hết hiệu lực và phải in/dán lại.')) return;
                key = (await api('POST', '/api/ticket-key/rotate')).key; draw(); toast('Đã tạo mã QR mới');
              }),
            }, 'Đổi mã QR'))));
    }
    draw();

    live = { es: new EventSource('/api/stream'), timer: setInterval(() => refresh().catch(() => {}), 10000) };
    live.es.addEventListener('state', () => refresh().catch(() => {}));
  }

  // ---------- 2. Kiểm tra an ninh & giao việc ----------
  async function viewChecklist(main) {
    let day = todayStr();
    let d;
    const box = h('div');
    main.append(box);

    async function load() { d = await api('GET', `/api/checklist?day=${day}`); draw(); }
    const save = guard(async (item, patch) => { await api('PUT', '/api/checklist', { day, item_id: item, ...patch }); await load(); });

    function draw() {
      const nm = new Map(d.staff.map((s) => [s.id, s.name]));
      const done = d.items.filter((i) => d.logs[i.id] && d.logs[i.id].done).length;
      const selected = new Set(d.on_duty.length ? d.on_duty : d.staff.map((s) => s.id));
      const checks = d.staff.map((s) => h('label', { style: 'display:inline-flex;gap:6px;align-items:center;margin:0 12px 0 0;color:var(--text)' },
        h('input', { type: 'checkbox', value: s.id, checked: selected.has(s.id), style: 'width:20px;min-height:0;height:20px' }), s.name));

      box.replaceChildren(
        h('div', { class: 'card' },
          h('div', { class: 'row' },
            h('h2', { class: 'grow', style: 'margin:0' }, `Kiểm tra an ninh: ${done}/${d.items.length} hoàn tất`),
            h('input', { type: 'date', value: day, style: 'max-width:180px', 'aria-label': 'Ngày', onchange: (e) => { if (e.target.value) { day = e.target.value; load().catch((er) => toast(er.message, true)); } } })),
          h('div', { style: 'margin-top:10px' }, h('span', { class: 'muted' }, 'Giao việc cho: '), checks,
            h('button', {
              style: 'margin-top:8px',
              onclick: guard(async () => {
                const ids = checks.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => Number(i.value));
                await api('POST', '/api/checklist/assign', { day, staff_ids: ids });
                await load(); toast('Đã chia đều các hạng mục chưa giao');
              }),
            }, 'Chia đều việc chưa giao'))),
        h('div', { class: 'card' },
          d.items.map((it) => {
            const log = d.logs[it.id] || {};
            return h('div', { class: 'check' + (log.done ? ' done' : '') },
              h('input', { type: 'checkbox', checked: Boolean(log.done), 'aria-label': `Hoàn thành: ${it.text}`, onchange: (e) => save(it.id, { done: e.target.checked }) }),
              h('div', null,
                h('div', { class: 'tx' }, it.text),
                h('div', { class: 'sub' },
                  h('select', { 'aria-label': 'Người phụ trách', onchange: (e) => save(it.id, { staff_id: e.target.value || null }) },
                    h('option', { value: '' }, '— Chưa giao —'),
                    d.staff.map((s) => h('option', { value: s.id, selected: s.id === log.staff_id }, s.name))),
                  h('input', { placeholder: 'Ghi chú', value: log.note || '', maxlength: '200', 'aria-label': 'Ghi chú', onchange: (e) => save(it.id, { note: e.target.value }) }),
                  log.done && log.done_at ? h('span', { class: 'muted' }, `${new Date(log.done_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' })}${log.staff_id ? ' - ' + nm.get(log.staff_id) : ''}`) : null,
                  h('button', {
                    class: 'ghost no-print',
                    onclick: guard(async () => { const t = prompt('Sửa nội dung hạng mục:', it.text); if (t) { await api('PUT', `/api/check-items/${it.id}`, { text: t }); await load(); } }),
                  }, 'Sửa'),
                  h('button', {
                    class: 'ghost danger no-print',
                    onclick: guard(async () => { if (confirm(`Xoá hạng mục "${it.text}"?`)) { await api('DELETE', `/api/check-items/${it.id}`); await load(); } }),
                  }, 'Xoá'))));
          }),
          h('button', {
            style: 'margin-top:12px',
            onclick: guard(async () => { const t = prompt('Nội dung hạng mục mới:'); if (t) { await api('POST', '/api/check-items', { text: t }); await load(); } }),
          }, '+ Thêm hạng mục kiểm tra')));
    }
    await load();
  }

  // ---------- 3. Lịch trực ----------
  async function viewRoster(main) {
    let month = ls.get('roster-month', monthNow());
    const CODES = ['', 'HC', '24', 'N', 'D', 'P'];
    const LABEL = { HC: 'Hành chính', 24: 'Trực 24h', N: 'Ca ngày 12h', D: 'Ca đêm 12h', P: 'Nghỉ phép' };
    const box = h('div');
    main.append(box);
    let d;

    async function load() { d = await api('GET', `/api/shifts?month=${month}`); draw(); }
    const setCell = guard(async (staffId, day, code) => {
      await api('PUT', '/api/shifts', { day, staff_id: staffId, code });
      (d.shifts[staffId] ||= {});
      if (code) d.shifts[staffId][day] = code; else delete d.shifts[staffId][day];
      draw();
    });

    function draw() {
      const [y, m] = month.split('-').map(Number);
      const days = new Date(y, m, 0).getDate();
      const dayList = Array.from({ length: days }, (_, i) => i + 1);
      const dow = (n) => new Date(y, m - 1, n).getDay();
      const dn = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
      const ds = (n) => `${month}-${String(n).padStart(2, '0')}`;

      box.replaceChildren(
        h('div', { class: 'card' },
          h('div', { class: 'row no-print' },
            h('h2', { class: 'grow', style: 'margin:0' }, `Lịch trực tháng ${monthLabel(month)}`),
            h('input', { type: 'month', value: month, style: 'max-width:180px', 'aria-label': 'Tháng', onchange: (e) => { if (e.target.value) { month = e.target.value; ls.set('roster-month', month); load().catch((er) => toast(er.message, true)); } } }),
            h('button', { onclick: () => window.print() }, 'In lịch trực')),
          h('h2', { class: 'hide-print-only', style: 'text-align:center' }, `LỊCH TRỰC BẢO VỆ - THÁNG ${monthLabel(month)}`),
          h('p', { class: 'muted no-print' }, 'Bấm vào ô để đổi ca. ', Object.entries(LABEL).map(([k, v]) => `${k} = ${v}`).join(' · ')),
          h('div', { class: 'rosterwrap' },
            h('table', { class: 't roster' },
              h('thead', null,
                h('tr', null, h('th', { class: 'nm' }, 'Họ tên'), dayList.map((n) => h('th', { class: [0, 6].includes(dow(n)) ? 'we' : '' }, String(n), h('br'), dn[dow(n)]))),
              ),
              h('tbody', null, d.staff.map((s) => h('tr', null,
                h('td', { class: 'nm' }, s.name,
                  h('div', { class: 'no-print' },
                    h('select', {
                      style: 'min-height:32px;padding:2px;margin-top:4px',
                      'aria-label': `Điền nhanh cho ${s.name}`,
                      onchange: guard(async (e) => {
                        const v = e.target.value;
                        if (!v) return;
                        e.target.value = '';
                        const code = v === '-' ? '' : v;
                        if (!confirm(code ? `Điền ca "${LABEL[code]}" cho cả tháng của ${s.name}?` : `Xoá toàn bộ ca tháng này của ${s.name}?`)) return;
                        await api('PUT', '/api/shifts/bulk', { month, staff_id: s.id, code });
                        await load();
                      }),
                    }, h('option', { value: '' }, 'Điền nhanh…'), Object.keys(LABEL).map((k) => h('option', { value: k }, `Cả tháng: ${k}`)), h('option', { value: '-' }, 'Xoá cả tháng')))),
                dayList.map((n) => {
                  const code = (d.shifts[s.id] || {})[ds(n)] || '';
                  return h('td', { class: [0, 6].includes(dow(n)) ? 'we' : '' },
                    h('button', { class: code ? `s-${code}` : '', 'aria-label': `${s.name} ngày ${n}: ${code || 'trống'}`, onclick: () => setCell(s.id, ds(n), CODES[(CODES.indexOf(code) + 1) % CODES.length]) }, code));
                })))))),
          h('div', { class: 'hide-print-only', style: 'margin-top:30px;display:flex;justify-content:space-around' },
            h('div', { style: 'text-align:center' }, h('b', null, 'Tổ trưởng'), h('div', { style: 'height:70px' })),
            h('div', { style: 'text-align:center' }, h('b', null, 'Xác nhận của Ngân hàng'), h('div', { style: 'height:70px' })))));
    }
    await load();
  }

  // ---------- 4. Phiếu đánh giá tháng ----------
  async function viewEvals(main) {
    let month = ls.get('eval-month', monthNow());
    const box = h('div');
    main.append(box);
    let d;
    let editing = null;

    async function load() { d = await api('GET', `/api/evaluations?month=${month}`); draw(); }

    function printLink(prefill, staffId) {
      const q = new URLSearchParams({ month, prefill: prefill ? '1' : '0' });
      if (staffId) q.set('staff', staffId);
      window.open(`/in-danh-gia?${q}`, '_blank');
    }

    function drawEditor(s) {
      const ev = d.evals[s.id] || { ratings: {}, notes: {}, uu_diem: '', khuyet_diem: '', danh_gia_chung: 'Tốt', kien_nghi: '' };
      const rating = {};
      for (const c of d.criteria) if (!c.is_group) rating[c.code] = ev.ratings[c.code] || 'tot';
      const notes = { ...ev.notes };
      const R = [['tot', 'Tốt'], ['kha', 'Khá'], ['tb', 'TB'], ['yeu', 'Yếu']];
      const f = {
        uu_diem: h('input', { value: ev.uu_diem, maxlength: '300' }),
        khuyet_diem: h('input', { value: ev.khuyet_diem, maxlength: '300' }),
        danh_gia_chung: h('input', { value: ev.danh_gia_chung, maxlength: '300' }),
        kien_nghi: h('input', { value: ev.kien_nghi, maxlength: '300' }),
      };
      return h('div', { class: 'card' },
        h('h2', null, `Chấm điểm: ${s.name} - tháng ${monthLabel(month)}`),
        h('div', { class: 'row no-print' },
          h('button', { onclick: (e) => { for (const k of Object.keys(rating)) rating[k] = 'tot'; e.target.closest('.card').querySelectorAll('input[type=radio][value=tot]').forEach((r) => { r.checked = true; }); } }, 'Tất cả = Tốt')),
        h('div', { style: 'overflow-x:auto' },
          h('table', { class: 't evtable' },
            h('thead', null, h('tr', null, h('th', null, 'STT'), h('th', null, 'Nội dung'), R.map((r) => h('th', null, r[1])), h('th', null, 'Ghi chú'))),
            h('tbody', null, d.criteria.map((c) => c.is_group
              ? h('tr', null, h('td', { class: 'g' }, c.code), h('td', { class: 'g', colspan: '6' }, c.text))
              : h('tr', null, h('td', null, c.code), h('td', null, c.text),
                R.map(([v, lab]) => h('td', { class: 'r' }, h('input', { type: 'radio', value: v, name: `r-${c.code}`, 'aria-label': `${c.code} ${lab}`, checked: rating[c.code] === v, onchange: () => { rating[c.code] = v; } }))),
                h('td', null, h('input', { class: 'note', value: notes[c.code] || '', maxlength: '200', 'aria-label': `Ghi chú ${c.code}`, onchange: (e) => { notes[c.code] = e.target.value; } })))))),
        ),
        h('div', { class: 'form-grid' },
          h('div', null, h('label', null, 'Ưu điểm của bảo vệ'), f.uu_diem),
          h('div', null, h('label', null, 'Khuyết điểm của bảo vệ'), f.khuyet_diem),
          h('div', null, h('label', null, 'Đánh giá chung'), f.danh_gia_chung),
          h('div', null, h('label', null, 'Kiến nghị'), f.kien_nghi)),
        h('div', { class: 'row', style: 'margin-top:14px' },
          h('button', {
            class: 'primary',
            onclick: guard(async () => {
              await api('PUT', `/api/evaluations/${month}/${s.id}`, { ratings: rating, notes, uu_diem: f.uu_diem.value, khuyet_diem: f.khuyet_diem.value, danh_gia_chung: f.danh_gia_chung.value, kien_nghi: f.kien_nghi.value });
              editing = null; await load(); toast('Đã lưu phiếu đánh giá');
            }),
          }, 'Lưu phiếu'),
          h('button', { onclick: () => { editing = null; draw(); } }, 'Đóng')));
    }

    function draw() {
      const target = d.staff.find((s) => s.id === editing);
      box.replaceChildren(
        h('div', { class: 'card' },
          h('div', { class: 'row' },
            h('h2', { class: 'grow', style: 'margin:0' }, `Phiếu đánh giá tháng ${monthLabel(month)}`),
            h('input', { type: 'month', value: month, style: 'max-width:180px', 'aria-label': 'Tháng', onchange: (e) => { if (e.target.value) { month = e.target.value; ls.set('eval-month', month); editing = null; load().catch((er) => toast(er.message, true)); } } })),
          h('p', { class: 'muted' }, 'Mỗi nhân viên một phiếu. Chưa chấm thì phiếu mặc định mức "Tốt" cho mọi tiêu chí. Mục tiêu và tên công ty chỉnh trong Cài đặt.'),
          h('table', { class: 't' },
            h('thead', null, h('tr', null, h('th', null, 'Nhân viên'), h('th', null, 'Hình thức'), h('th', null, 'Trạng thái'), h('th', null, ''))),
            h('tbody', null, d.staff.map((s) => h('tr', null,
              h('td', null, s.name), h('td', null, { hc: 'Hành chính', 12: '12/24h', 24: '24/24h' }[s.shift_type]),
              h('td', null, d.evals[s.id] ? '✓ Đã lưu' : 'Mặc định (Tốt)'),
              h('td', null, h('div', { class: 'row' }, h('button', { onclick: () => { editing = s.id; draw(); } }, 'Chấm điểm'), h('button', { onclick: () => printLink(true, s.id) }, 'In phiếu')))))
            )),
          h('div', { class: 'row', style: 'margin-top:12px' },
            h('button', { class: 'primary', onclick: () => printLink(true) }, 'In tất cả phiếu (đã tích sẵn)'),
            h('button', { onclick: () => printLink(false) }, 'In phiếu trống (lãnh đạo tự tích)'))),
        target ? drawEditor(target) : null);
      if (target) box.lastChild.scrollIntoView({ block: 'start' });
    }
    await load();
  }

  // ---------- 5. Danh bạ ----------
  async function viewContacts(main) {
    let list = await api('GET', '/api/contacts');
    let q = '';
    let cat = '';
    const box = h('div');
    main.append(box);

    const reload = async () => { list = await api('GET', '/api/contacts'); draw(); };

    function form(c) {
      const f = {};
      const field = (k, label, ph) => h('div', null, h('label', null, label), (f[k] = h('input', { value: c[k] || '', placeholder: ph || '', maxlength: '200' })));
      const wrap = h('div', { class: 'card' },
        h('h3', null, c.id ? 'Sửa liên hệ' : 'Thêm liên hệ'),
        h('div', { class: 'form-grid' }, field('name', 'Tên cơ quan / đơn vị *'), field('category', 'Nhóm', 'Công an, UBND, Y tế…'), field('phone', 'Số điện thoại *'), field('phone2', 'Số phụ'), field('address', 'Địa chỉ'), field('note', 'Ghi chú')),
        h('div', { class: 'row', style: 'margin-top:12px' },
          h('button', {
            class: 'primary',
            onclick: guard(async () => {
              const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
              if (c.id) await api('PUT', `/api/contacts/${c.id}`, body); else await api('POST', '/api/contacts', body);
              await reload(); toast('Đã lưu');
            }),
          }, 'Lưu'),
          h('button', { onclick: () => draw() }, 'Huỷ')));
      return wrap;
    }

    function csvCell(v) { return `"${String(v ?? '').replace(/"/g, '""')}"`; }

    function draw(editor) {
      const cats = [...new Set(list.map((c) => c.category).filter(Boolean))].sort();
      const s = q.trim().toLowerCase();
      const shown = list.filter((c) => (!cat || c.category === cat) && (!s || [c.name, c.phone, c.phone2, c.address, c.note, c.category].join(' ').toLowerCase().includes(s)));
      const search = h('input', { type: 'search', placeholder: 'Tìm theo tên, số điện thoại…', value: q, 'aria-label': 'Tìm kiếm', oninput: (e) => { q = e.target.value; const pos = e.target.selectionStart; draw(); const n = box.querySelector('input[type=search]'); n.focus(); n.setSelectionRange(pos, pos); } });
      box.replaceChildren(
        h('div', { class: 'card' },
          h('div', { class: 'row' }, h('div', { class: 'grow' }, search),
            h('button', { class: 'primary', onclick: () => draw({}) }, '+ Thêm'),
            h('button', {
              onclick: () => {
                const rows = [['Tên', 'Nhóm', 'SĐT', 'SĐT phụ', 'Địa chỉ', 'Ghi chú'], ...list.map((c) => [c.name, c.category, c.phone, c.phone2, c.address, c.note])];
                const blob = new Blob(['﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
                const a = h('a', { href: URL.createObjectURL(blob), download: 'danh-ba.csv' });
                document.body.append(a); a.click(); a.remove();
              },
            }, 'Xuất Excel/CSV'),
            h('button', { onclick: () => draw({ importing: true }) }, 'Nhập hàng loạt')),
          h('div', { class: 'chips', style: 'margin-top:10px' },
            h('button', { class: 'chip' + (cat === '' ? ' on' : ''), onclick: () => { cat = ''; draw(); } }, 'Tất cả'),
            cats.map((c) => h('button', { class: 'chip' + (cat === c ? ' on' : ''), onclick: () => { cat = c; draw(); } }, c)))),
        editor && editor.importing ? importer() : null,
        editor && !editor.importing ? form(editor) : null,
        h('div', { class: 'card' }, shown.length ? shown.map((c) => h('div', { class: 'contact' },
          h('div', null, h('b', null, c.name), ' ', c.category && h('span', { class: 'pill' }, c.category),
            c.address && h('div', { class: 'muted' }, c.address), c.note && h('div', { class: 'muted' }, c.note)),
          h('div', { class: 'ph' },
            h('div', null, h('a', { href: `tel:${c.phone.replace(/[^\d+]/g, '')}` }, c.phone)),
            c.phone2 && h('div', null, h('a', { href: `tel:${c.phone2.replace(/[^\d+]/g, '')}` }, c.phone2)),
            h('div', { class: 'row', style: 'margin-top:4px' },
              h('button', { class: 'ghost', onclick: () => draw(c) }, 'Sửa'),
              h('button', { class: 'ghost danger', onclick: guard(async () => { if (confirm(`Xoá "${c.name}"?`)) { await api('DELETE', `/api/contacts/${c.id}`); await reload(); } }) }, 'Xoá'))))) : h('p', { class: 'muted' }, 'Không có liên hệ nào.')));
    }

    function importer() {
      const ta = h('textarea', { rows: '6', placeholder: 'Dán từ Excel, mỗi dòng một liên hệ, các cột cách nhau bằng Tab hoặc dấu ;\nTên cơ quan ; Nhóm ; SĐT ; SĐT phụ ; Địa chỉ ; Ghi chú' });
      return h('div', { class: 'card' }, h('h3', null, 'Nhập hàng loạt'), ta,
        h('div', { class: 'row', style: 'margin-top:10px' },
          h('button', {
            class: 'primary',
            onclick: guard(async () => {
              const rows = ta.value.split(/\r?\n/).map((l) => l.split(/\t|;/).map((x) => x.trim())).filter((r) => r[0] && r[2]);
              if (!rows.length) { toast('Không có dòng hợp lệ (cần ít nhất Tên và SĐT)', true); return; }
              for (const r of rows) await api('POST', '/api/contacts', { name: r[0], category: r[1], phone: r[2], phone2: r[3], address: r[4], note: r[5] });
              await reload(); toast(`Đã nhập ${rows.length} liên hệ`);
            }),
          }, 'Nhập'), h('button', { onclick: () => draw() }, 'Huỷ')));
    }
    draw();
  }

  // ---------- 6. Cài đặt ----------
  async function viewSettings(main) {
    const s = await api('GET', '/api/settings');
    let staff = await api('GET', '/api/staff');
    const box = h('div');
    main.append(box);

    function draw() {
      const f = {};
      const field = (k, label, extra) => h('div', null, h('label', null, label), (f[k] = h('input', { value: s[k] || '', ...extra })));
      const old = h('input', { type: 'password', autocomplete: 'current-password' });
      const nu = h('input', { type: 'password', autocomplete: 'new-password' });
      box.replaceChildren(
        h('div', { class: 'card' },
          h('h2', null, 'Thông tin chung'),
          h('div', { class: 'form-grid' },
            field('company', 'Tên công ty bảo vệ (in trên phiếu)'), field('target', 'Mục tiêu bảo vệ'), field('place', 'Địa danh (dòng ngày tháng)'),
            field('branch_title', 'Tên hiển thị trên tivi / trang lấy số'), field('counters', 'Số quầy giao dịch (1-10)', { type: 'number', min: '1', max: '10' }), field('tv_note', 'Dòng chữ chạy trên tivi')),
          h('button', {
            class: 'primary', style: 'margin-top:12px',
            onclick: guard(async () => { await api('PUT', '/api/settings', Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]))); toast('Đã lưu cài đặt'); }),
          }, 'Lưu')),

        h('div', { class: 'card' },
          h('h2', null, 'Nhân viên bảo vệ'),
          h('table', { class: 't' },
            h('thead', null, h('tr', null, h('th', null, 'Họ tên'), h('th', null, 'Mã đánh giá'), h('th', null, 'Hình thức'), h('th', null, ''))),
            h('tbody', null, staff.map((m) => {
              const n = h('input', { value: m.name, maxlength: '60', 'aria-label': 'Họ tên' });
              const c = h('input', { value: m.code, maxlength: '20', 'aria-label': 'Mã đánh giá' });
              const t = h('select', { 'aria-label': 'Hình thức' }, [['hc', 'Hành chính'], ['12', '12/24h'], ['24', '24/24h']].map(([v, l]) => h('option', { value: v, selected: m.shift_type === v }, l)));
              return h('tr', null, h('td', null, n), h('td', null, c), h('td', null, t),
                h('td', null, h('div', { class: 'row' },
                  h('button', { onclick: guard(async () => { await api('PUT', `/api/staff/${m.id}`, { name: n.value, code: c.value, shift_type: t.value }); toast('Đã lưu'); }) }, 'Lưu'),
                  h('button', { class: 'danger', onclick: guard(async () => { if (confirm(`Xoá ${m.name} khỏi danh sách?`)) { await api('DELETE', `/api/staff/${m.id}`); staff = await api('GET', '/api/staff'); draw(); } }) }, 'Xoá'))));
            }))),
          h('button', {
            style: 'margin-top:10px',
            onclick: guard(async () => { const name = prompt('Họ tên nhân viên mới:'); if (name) { await api('POST', '/api/staff', { name, shift_type: '24' }); staff = await api('GET', '/api/staff'); draw(); } }),
          }, '+ Thêm nhân viên')),

        h('div', { class: 'card' },
          h('h2', null, 'Đổi mã PIN'),
          h('div', { class: 'form-grid' }, h('div', null, h('label', null, 'PIN hiện tại'), old), h('div', null, h('label', null, 'PIN mới (tối thiểu 4 ký tự)'), nu)),
          h('button', {
            style: 'margin-top:12px',
            onclick: guard(async () => { await api('POST', '/api/pin', { old: old.value, new: nu.value }); toast('Đã đổi PIN, vui lòng đăng nhập lại'); showLogin(); }),
          }, 'Đổi PIN'),
          h('hr', { style: 'margin:18px 0;border:0;border-top:1px solid var(--line)' }),
          h('button', { onclick: guard(async () => { await api('POST', '/api/logout', {}); showLogin(); }) }, 'Đăng xuất')));
    }
    draw();
  }

  boot();
  // Nếu chưa đăng nhập, boot() đã hiện màn hình đăng nhập qua api() → showLogin().
})();
