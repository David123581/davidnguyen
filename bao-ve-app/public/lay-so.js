'use strict';

(() => {
  const view = document.getElementById('view');
  const params = new URLSearchParams(location.search);
  const key = params.get('k') || '';
  const store = {
    get() { try { return localStorage.getItem('ticket-token'); } catch { return null; } },
    set(v) { try { v ? localStorage.setItem('ticket-token', v) : localStorage.removeItem('ticket-token'); } catch { /* bỏ qua */ } },
  };
  let token = store.get();
  let timer = null;
  let wasCalled = false;

  const pad = (n) => String(n).padStart(3, '0');

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  async function api(path, body) {
    const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || 'Có lỗi xảy ra'), { status: r.status });
    return data;
  }

  function renderStart(msg) {
    clearInterval(timer);
    view.replaceChildren();
    const p = el('div', 'panel');
    p.append(el('div', 'label', 'Nhập tên để nhân viên gọi đúng tên bạn trên loa (không bắt buộc), rồi bấm LẤY SỐ.'));
    const name = el('input');
    name.placeholder = 'Ví dụ: Nguyễn Văn An';
    name.maxLength = 40;
    name.setAttribute('aria-label', 'Tên của bạn');
    name.autocomplete = 'name'; // điện thoại gợi ý sẵn tên đã lưu trong trình duyệt
    name.autocapitalize = 'words';
    name.enterKeyHint = 'done';
    try { name.value = localStorage.getItem('ticket-name') || ''; } catch { /* bỏ qua */ }
    const btn = el('button', 'primary take', 'LẤY SỐ');
    const err = el('div', 'status', msg || '');
    err.style.color = 'var(--red)';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        try { localStorage.setItem('ticket-name', name.value.trim()); } catch { /* bỏ qua */ }
        const t = await api('/api/ticket', { k: key, name: name.value, token });
        token = t.token;
        store.set(token);
        wasCalled = false;
        track(t);
      } catch (e) {
        err.textContent = e.message;
        btn.disabled = false;
      }
    });
    p.append(name, btn, err);
    view.append(p);
  }

  function renderTicket(t, waiting) {
    view.replaceChildren();
    const p = el('div', 'panel');
    p.append(el('div', 'label', 'Số thứ tự của bạn'), el('div', 'big', pad(t.number)));
    if (t.status === 'waiting') {
      p.append(el('div', 'status', t.ahead === 0 ? 'Bạn là người kế tiếp' : `Còn ${t.ahead} người trước bạn`));
      p.append(el('div', 'label', 'Vui lòng ngồi chờ, số của bạn sẽ hiện trên màn hình và được đọc loa.'));
    } else if (t.status === 'serving') {
      p.className = 'panel called';
      p.append(el('div', 'status', `Mời bạn đến QUẦY ${t.counter}`));
      if (!wasCalled) { wasCalled = true; if (navigator.vibrate) navigator.vibrate([300, 150, 300]); }
    } else if (t.status === 'done') {
      p.className = 'panel done';
      p.append(el('div', 'status', 'Đã hoàn tất. Cảm ơn quý khách!'));
    } else {
      p.className = 'panel done';
      p.append(el('div', 'status', 'Số của bạn đã được bỏ qua do chưa có mặt. Vui lòng gặp bảo vệ để được hỗ trợ.'));
    }
    if (t.status === 'done' || t.status === 'skipped') {
      const again = el('button', 'primary take', 'Lấy số mới');
      again.addEventListener('click', () => { store.set(null); token = null; renderStart(); });
      p.append(again);
    }
    if (waiting !== undefined && t.status === 'waiting') view.append(p, el('div', 'note', `Tổng số người đang chờ: ${waiting}`));
    else view.append(p);
  }

  async function refresh() {
    if (!token) { clearInterval(timer); return; }
    try {
      const t = await api(`/api/ticket/${token}`);
      renderTicket(t, t.waiting);
      if (t.status === 'done' || t.status === 'skipped') clearInterval(timer);
    } catch (e) {
      if (e.status === 404) { store.set(null); token = null; renderStart(); }
    }
  }

  function track(first) {
    if (first) renderTicket(first);
    else view.replaceChildren(el('div', 'note', 'Đang tải...'));
    clearInterval(timer);
    timer = setInterval(refresh, 4000);
    refresh();
  }

  fetch('/api/public/state').then((r) => r.json()).then((s) => {
    document.getElementById('branch').textContent = s.branch || 'Lấy số thứ tự';
  }).catch(() => {});

  if (token) track(); else renderStart();
})();
