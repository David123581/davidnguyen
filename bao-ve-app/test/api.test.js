'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let proc;
let dir;
let cookie = '';

async function call(method, url, body, extra = {}) {
  const r = await fetch(BASE + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baove-'));
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, ADMIN_PIN: '654321' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i += 1) {
    try { await fetch(BASE + '/api/public/state'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});

test.after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('API quản lý cần đăng nhập, PIN sai bị từ chối', async () => {
  assert.equal((await call('GET', '/api/queue')).status, 401);
  assert.equal((await call('POST', '/api/login', { pin: 'sai-pin' })).status, 401);
  assert.equal((await call('POST', '/api/login', { pin: '654321' })).status, 200);
  assert.equal((await call('GET', '/api/queue')).status, 200);
});

test('lấy số: mặc định link gọn không cần mã; bật chống từ xa thì cần mã QR đúng', async () => {
  const { data: { key, require } } = await call('GET', '/api/ticket-key');
  assert.equal(require, false);
  const open = await call('POST', '/api/ticket', { name: 'Nguyễn Văn An' });
  assert.equal(open.data.number, 1);

  assert.equal((await call('PUT', '/api/settings', { require_key: '1' })).status, 200);
  assert.equal((await call('POST', '/api/ticket', { k: 'sai' })).status, 403);
  const b = await call('POST', '/api/ticket', { k: key });
  assert.equal(b.data.number, 2);
  const again = await call('POST', '/api/ticket', { token: open.data.token });
  assert.equal(again.data.number, 1, 'cùng thiết bị không lấy trùng số');
  assert.equal((await call('PUT', '/api/settings', { require_key: '0' })).status, 200);
});

test('hai trang tách biệt: / là trang khách, /bao-ve là trang nội bộ', async () => {
  const root = await (await fetch(BASE + '/')).text();
  const internal = await (await fetch(BASE + '/bao-ve')).text();
  assert.match(root, /lay-so\.js/);
  assert.match(internal, /app\.js/);
});

test('gọi số theo thứ tự, gọi lại, bỏ qua, hoàn tất', async () => {
  const c1 = await call('POST', '/api/queue/call', { counter: 2 });
  assert.equal(c1.data.ticket.number, 1);
  assert.equal(c1.data.ticket.counter, 2);
  const s1 = (await call('GET', '/api/public/state')).data;
  assert.equal(s1.last_call.number, 1);
  assert.equal(s1.last_call.name, 'Nguyễn Văn An', 'tên khách được đọc cùng số');
  const seq1 = s1.last_call.seq;

  const re = await call('POST', '/api/queue/recall', { counter: 2 });
  assert.equal(re.status, 200);
  assert.ok((await call('GET', '/api/public/state')).data.last_call.seq > seq1, 'gọi lại phải tăng seq để tivi đọc lại');

  const c2 = await call('POST', '/api/queue/call', { counter: 1 });
  assert.equal(c2.data.ticket.number, 2);
  assert.equal((await call('POST', '/api/queue/skip', { counter: 1 })).status, 200);
  assert.equal((await call('POST', '/api/queue/done', { counter: 1 })).status, 409);
  assert.equal((await call('POST', '/api/queue/call', { counter: 9 })).status, 400);

  const again = await call('POST', '/api/queue/call-number', { counter: 3, number: 2 });
  assert.equal(again.data.ticket.counter, 3);
  assert.equal((await call('POST', '/api/queue/call-number', { counter: 1, number: 1 })).status, 409, 'số đang ở quầy khác');
});

test('từ chối POST không phải JSON (chặn CSRF dạng form)', async () => {
  const r = await fetch(BASE + '/api/queue/call', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }, body: 'counter=1' });
  assert.equal(r.status, 415);
});

test('phiếu đánh giá: lưu và đọc lại, giá trị lạ bị loại', async () => {
  const { data: ev } = await call('GET', '/api/evaluations?month=2026-10');
  assert.equal(ev.staff.length, 3);
  assert.ok(ev.criteria.some((c) => c.code === '3.7'));
  const id = ev.staff[0].id;
  const put = await call('PUT', `/api/evaluations/2026-10/${id}`, { ratings: { '1.1': 'kha', '1.2': 'hack', zzz: 'tot' }, uu_diem: 'Tốt' });
  assert.equal(put.status, 200);
  const back = (await call('GET', '/api/evaluations?month=2026-10')).data.evals[id];
  assert.deepEqual(back.ratings, { '1.1': 'kha' });
  assert.equal((await call('GET', '/api/evaluations?month=2026-13')).status, 400);
});

test('lịch trực, danh bạ, kiểm tra an ninh', async () => {
  const staff = (await call('GET', '/api/staff')).data;
  assert.equal((await call('PUT', '/api/shifts', { day: '2026-11-05', staff_id: staff[0].id, code: '24' })).status, 200);
  assert.equal((await call('PUT', '/api/shifts', { day: '2026-11-05', staff_id: staff[0].id, code: 'XX' })).status, 400);
  assert.equal((await call('GET', '/api/shifts?month=2026-11')).data.shifts[staff[0].id]['2026-11-05'], '24');

  const c = await call('POST', '/api/contacts', { name: 'Công an phường A', category: 'Công an', phone: '0290 123 456' });
  assert.equal(c.status, 200);
  assert.equal((await call('POST', '/api/contacts', { name: 'thiếu số' })).status, 400);

  const day = '2026-11-05';
  await call('POST', '/api/checklist/assign', { day, staff_ids: staff.map((s) => s.id).slice(0, 2) });
  const cl = (await call('GET', `/api/checklist?day=${day}`)).data;
  const owners = new Set(Object.values(cl.logs).map((l) => l.staff_id));
  assert.equal(owners.size, 2, 'việc được chia cho 2 người');
  const first = cl.items[0].id;
  await call('PUT', '/api/checklist', { day, item_id: first, done: true });
  assert.equal((await call('GET', `/api/checklist?day=${day}`)).data.logs[first].done, 1);
});

test('không đọc được file ngoài thư mục public', async () => {
  const r = await fetch(BASE + '/%2e%2e/server.js');
  assert.equal(r.status, 404);
});
