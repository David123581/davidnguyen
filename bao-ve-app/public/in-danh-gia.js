'use strict';

(async () => {
  const q = new URLSearchParams(location.search);
  const month = q.get('month') || '';
  const prefill = q.get('prefill') === '1';
  const only = q.get('staff');
  const sheets = document.getElementById('sheets');

  function h(tag, cls, ...kids) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const k of kids.flat()) if (k !== null && k !== undefined) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  }

  document.getElementById('print').addEventListener('click', () => window.print());

  const r = await fetch(`/api/evaluations?month=${encodeURIComponent(month)}`);
  if (r.status === 401) { location.href = '/bao-ve'; return; }
  const d = await r.json();
  if (!r.ok) { sheets.textContent = d.error || 'Lỗi'; return; }

  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const mm = String(m).padStart(2, '0');
  const RATING = ['tot', 'kha', 'tb', 'yeu'];
  const staff = d.staff.filter((s) => !only || String(s.id) === only);
  document.getElementById('info').textContent = `${staff.length} phiếu · tháng ${mm}/${y} · ${prefill ? 'đã tích sẵn' : 'để trống cho lãnh đạo tích'}`;

  const mark = (on) => h('td', 'm', on ? '✓' : '');

  staff.forEach((s, idx) => {
    const ev = d.evals[s.id] || { ratings: {}, notes: {}, uu_diem: '', khuyet_diem: '', danh_gia_chung: 'Tốt', kien_nghi: '' };
    const sheet = h('section', 'sheet');

    sheet.append(h('div', 'head',
      h('div', 'l', d.settings.company),
      h('div', 'r', h('div', null, 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM'), h('div', 'sub', 'Độc lập - Tự do - Hạnh phúc'))));
    sheet.append(h('h1', null, 'Bảng đánh giá chất lượng bảo vệ'), h('div', 'month', `Tháng ${mm}/${y}`), h('div', 'target', `Mục tiêu bảo vệ: ${d.settings.target}`));

    sheet.append(h('h2', null, 'I. Nhân viên bảo vệ:'));
    const cols = (...w) => { const g = document.createElement('colgroup'); for (const x of w) { const c = document.createElement('col'); if (x) c.style.width = x; g.append(c); } return g; };
    const t1 = h('table');
    t1.append(cols('11mm', '', '25mm', '17mm', '15mm', '15mm', '40mm'));
    const th = (t, o = {}) => { const e = h('th', null, t); for (const [k, v] of Object.entries(o)) e.setAttribute(k, v); return e; };
    t1.append(h('thead', null,
      h('tr', null, th('STT', { rowspan: 2 }), th('Họ và tên', { rowspan: 2 }), th('Mã đánh giá bảo vệ', { rowspan: 2 }), th('Thời gian làm việc', { colspan: 3 }), th('Thời gian', { rowspan: 2 })),
      h('tr', null, th('Hành chính'), th('12/24h'), th('24/24h'))));
    t1.append(h('tbody', null, h('tr', null,
      h('td', 'c', '01'), h('td', null, s.name), h('td', 'c', s.code || ''),
      mark(s.shift_type === 'hc'), mark(s.shift_type === '12'), mark(s.shift_type === '24'),
      h('td', 'c', `Từ ngày 01/${mm}/${y}`, document.createElement('br'), `đến ngày ${last}/${mm}/${y}`))));
    sheet.append(t1);

    sheet.append(h('h2', null, 'II. Nội dung đánh giá:'));
    const t2 = h('table');
    t2.append(cols('11mm', '', '13mm', '13mm', '19mm', '13mm', '26mm'));
    t2.append(h('thead', null,
      h('tr', null, th('STT', { rowspan: 2 }), th('NỘI DUNG ĐÁNH GIÁ', { rowspan: 2 }), th('KẾT QUẢ ĐÁNH GIÁ', { colspan: 4 }), th('GHI CHÚ', { rowspan: 2 })),
      h('tr', null, th('Tốt'), th('Khá'), th('Trung bình'), th('Yếu'))));
    const body = h('tbody');
    for (const c of d.criteria) {
      if (c.is_group) {
        const tr = h('tr', 'g', h('td', 'c', c.code), h('td', null, c.text));
        for (let i = 0; i < 5; i += 1) tr.append(h('td'));
        body.append(tr);
      } else {
        const rating = ev.ratings[c.code] || 'tot';
        const tr = h('tr', null, h('td', 'c', c.code), h('td', 'j', c.text));
        for (const rk of RATING) tr.append(mark(prefill && rating === rk));
        tr.append(h('td', null, ev.notes[c.code] || ''));
        body.append(tr);
      }
    }
    t2.append(body);
    sheet.append(t2);

    const cmt = h('div', 'cmt', h('h3', null, 'Ý kiến nhận xét khác của người đánh giá:'));
    const line = (label, text) => {
      cmt.append(h('div', 'line', h('b', null, `${label}:`), h('div', 'dots', prefill ? text : '')));
      cmt.append(h('div', 'dots2'));
    };
    line('Ưu điểm của bảo vệ', ev.uu_diem);
    line('Khuyết điểm của bảo vệ', ev.khuyet_diem);
    line('Đánh giá chung', ev.danh_gia_chung);
    line('Kiến nghị', ev.kien_nghi);
    sheet.append(cmt);

    sheet.append(h('div', 'sign',
      h('div', null, `${d.settings.place}, ngày ......... tháng ${mm} năm ${y}`),
      h('b', null, 'Người đánh giá'),
      h('div', 'sp'),
      h('div', null, '(Ký, ghi rõ họ tên và đóng dấu)')));

    sheets.append(sheet);
    if (idx === staff.length - 1) sheet.dataset.last = '1';
  });
})();
