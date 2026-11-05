'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { open, tx, getSetting, setSetting } = require('./lib/db');
const { createAuth, ensurePin } = require('./lib/auth');
const { createQueue } = require('./lib/queue');
const { today, isDay, isMonth, HttpError, clean } = require('./lib/util');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const TICKET_IP_LIMIT = Number(process.env.TICKET_IP_LIMIT) || 30; // số phiếu / giờ / IP
const PUBLIC_DIR = path.join(__dirname, 'public');

const db = open(path.join(DATA_DIR, 'baove.db'));
const auth = createAuth(db);
const initialPin = ensurePin(db, process.env.ADMIN_PIN);

// ---------- SSE (đẩy trạng thái lên tivi) ----------
const sseClients = new Set();
const MAX_SSE = 200;

function broadcast() {
  const msg = `event: state\ndata: ${JSON.stringify(queue.publicState())}\n\n`;
  for (const res of sseClients) res.write(msg);
}
const queue = createQueue(db, broadcast);
setInterval(() => { for (const res of sseClients) res.write(': ping\n\n'); }, 25_000).unref();

// ---------- Tiện ích HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
const PAGES = { '/': 'index.html', '/lay-so': 'lay-so.html', '/tv': 'tv.html', '/in-danh-gia': 'in-danh-gia.html' };

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
};

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function isHttps(req) {
  return TRUST_PROXY ? req.headers['x-forwarded-proto'] === 'https' : Boolean(req.socket.encrypted);
}

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS, ...headers });
  res.end(data);
}

function readBody(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Dữ liệu quá lớn')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'JSON không hợp lệ')); }
    });
    req.on('error', reject);
  });
}

// ---------- Router ----------
const routes = [];
function route(method, pattern, opts, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, auth: opts.auth !== false, raw: Boolean(opts.raw), handler });
}

const ipTickets = new Map(); // ip -> [timestamps]
function limitTickets(ip) {
  const now = Date.now();
  const arr = (ipTickets.get(ip) || []).filter((t) => now - t < 3600_000);
  if (arr.length >= TICKET_IP_LIMIT) throw new HttpError(429, 'Đã lấy quá nhiều số từ thiết bị này, vui lòng đến gặp bảo vệ');
  arr.push(now);
  ipTickets.set(ip, arr);
}
setInterval(() => { const now = Date.now(); for (const [ip, a] of ipTickets) if (!a.some((t) => now - t < 3600_000)) ipTickets.delete(ip); }, 600_000).unref();

const sameKey = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// --- công khai ---
route('GET', '/api/public/state', { auth: false }, () => queue.publicState());

route('GET', '/api/stream', { auth: false, raw: true }, (ctx) => {
  const { req, res } = ctx;
  if (sseClients.size >= MAX_SSE) throw new HttpError(503, 'Quá nhiều kết nối');
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SEC_HEADERS });
  res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(queue.publicState())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

route('POST', '/api/ticket', { auth: false }, ({ body, ip }) => {
  const existing = queue.byToken(body.token);
  if (existing && existing.status === 'waiting') return { token: existing.token, ...queue.ticketView(existing) };
  if (!sameKey(body.k || '', getSetting(db, 'ticket_key'))) {
    throw new HttpError(403, 'Mã QR không hợp lệ hoặc đã hết hạn. Vui lòng quét lại mã QR tại quầy bảo vệ.');
  }
  limitTickets(ip);
  const t = queue.issue({ name: body.name, source: 'phone' });
  return { token: t.token, ...queue.ticketView(t) };
});

route('GET', '/api/ticket/:token', { auth: false }, ({ params }) => {
  const t = queue.byToken(params.token);
  if (!t) throw new HttpError(404, 'Không tìm thấy số');
  return { ...queue.ticketView(t), waiting: queue.publicState().waiting };
});

// --- đăng nhập ---
route('POST', '/api/login', { auth: false }, ({ body, ip, req, res }) => {
  const sid = auth.login(body.pin, ip);
  const secure = isHttps(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${auth.SESSION_MS / 1000}${secure}`);
  return { ok: true };
});
route('POST', '/api/logout', { auth: false }, ({ cookies, res }) => {
  auth.logout(cookies.sid);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  return { ok: true };
});
route('GET', '/api/me', {}, () => ({ ok: true }));
route('POST', '/api/pin', {}, ({ body }) => { auth.changePin(body.old, body.new); return { ok: true }; });

// --- hàng đợi (điều khiển) ---
const brief = (t) => (t ? { number: t.number, counter: t.counter } : null);
route('GET', '/api/queue', {}, () => queue.list());
route('POST', '/api/queue/call', {}, ({ body }) => ({ ticket: brief(queue.callNext(body.counter)) }));
route('POST', '/api/queue/call-number', {}, ({ body }) => ({ ticket: brief(queue.callNumber(body.counter, body.number)) }));
route('POST', '/api/queue/recall', {}, ({ body }) => ({ ticket: brief(queue.recall(body.counter)) }));
route('POST', '/api/queue/skip', {}, ({ body }) => ({ ticket: brief(queue.skip(body.counter)) }));
route('POST', '/api/queue/done', {}, ({ body }) => ({ ticket: brief(queue.done(body.counter)) }));
route('POST', '/api/queue/issue', {}, ({ body }) => {
  const t = queue.issue({ name: body.name, source: 'guard' });
  return { number: t.number };
});
route('GET', '/api/ticket-key', {}, () => ({ key: getSetting(db, 'ticket_key') }));
route('POST', '/api/ticket-key/rotate', {}, () => {
  const key = crypto.randomBytes(6).toString('hex');
  setSetting(db, 'ticket_key', key);
  return { key };
});

// --- cài đặt ---
const SETTING_KEYS = { company: 80, target: 80, place: 60, branch_title: 80, tv_note: 200, counters: 2 };
route('GET', '/api/settings', {}, () => {
  const out = {};
  for (const k of Object.keys(SETTING_KEYS)) out[k] = getSetting(db, k);
  return out;
});
route('PUT', '/api/settings', {}, ({ body }) => {
  for (const [k, max] of Object.entries(SETTING_KEYS)) {
    if (body[k] === undefined) continue;
    let v = clean(body[k], max);
    if (k === 'counters') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 10) throw new HttpError(400, 'Số quầy phải từ 1 đến 10');
      v = String(n);
    }
    setSetting(db, k, v);
  }
  broadcast();
  return { ok: true };
});

// --- nhân viên ---
const SHIFT_TYPES = ['hc', '12', '24'];
const staffRow = (b) => {
  const name = clean(b.name, 60);
  if (!name) throw new HttpError(400, 'Vui lòng nhập họ tên');
  const shift = SHIFT_TYPES.includes(b.shift_type) ? b.shift_type : '24';
  return [name, clean(b.code, 20), shift];
};
route('GET', '/api/staff', {}, () => db.prepare('SELECT id, name, code, shift_type FROM staff WHERE active = 1 ORDER BY sort, id').all());
route('POST', '/api/staff', {}, ({ body }) => {
  const max = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM staff').get().n;
  const r = db.prepare('INSERT INTO staff (name, code, shift_type, sort) VALUES (?, ?, ?, ?)').run(...staffRow(body), max);
  return { id: Number(r.lastInsertRowid) };
});
route('PUT', '/api/staff/:id', {}, ({ params, body }) => {
  db.prepare('UPDATE staff SET name = ?, code = ?, shift_type = ? WHERE id = ?').run(...staffRow(body), Number(params.id));
  return { ok: true };
});
route('DELETE', '/api/staff/:id', {}, ({ params }) => {
  db.prepare('UPDATE staff SET active = 0 WHERE id = ?').run(Number(params.id)); // giữ lại để không mất lịch sử đánh giá
  return { ok: true };
});

// --- phiếu đánh giá tháng ---
const RATINGS = ['tot', 'kha', 'tb', 'yeu'];
route('GET', '/api/evaluations', {}, ({ query }) => {
  if (!isMonth(query.month)) throw new HttpError(400, 'Tháng không hợp lệ (YYYY-MM)');
  const settings = {};
  for (const k of Object.keys(SETTING_KEYS)) settings[k] = getSetting(db, k);
  const rows = db.prepare('SELECT * FROM evaluations WHERE month = ?').all(query.month);
  const evals = {};
  for (const r of rows) {
    evals[r.staff_id] = { ratings: JSON.parse(r.ratings), notes: JSON.parse(r.notes), uu_diem: r.uu_diem, khuyet_diem: r.khuyet_diem, danh_gia_chung: r.danh_gia_chung, kien_nghi: r.kien_nghi };
  }
  return {
    month: query.month,
    settings,
    staff: db.prepare('SELECT id, name, code, shift_type FROM staff WHERE active = 1 ORDER BY sort, id').all(),
    criteria: db.prepare('SELECT code, is_group, text FROM criteria ORDER BY sort').all(),
    evals,
  };
});
route('PUT', '/api/evaluations/:month/:staffId', {}, ({ params, body }) => {
  if (!isMonth(params.month)) throw new HttpError(400, 'Tháng không hợp lệ');
  const codes = new Set(db.prepare('SELECT code FROM criteria WHERE is_group = 0').all().map((r) => r.code));
  const ratings = {};
  const notes = {};
  for (const [code, v] of Object.entries(body.ratings || {})) if (codes.has(code) && RATINGS.includes(v)) ratings[code] = v;
  for (const [code, v] of Object.entries(body.notes || {})) if (codes.has(code) && clean(v, 200)) notes[code] = clean(v, 200);
  const staffId = Number(params.staffId);
  if (!db.prepare('SELECT 1 FROM staff WHERE id = ?').get(staffId)) throw new HttpError(404, 'Không có nhân viên này');
  db.prepare(`INSERT INTO evaluations (month, staff_id, ratings, notes, uu_diem, khuyet_diem, danh_gia_chung, kien_nghi)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(month, staff_id) DO UPDATE SET ratings = excluded.ratings, notes = excluded.notes, uu_diem = excluded.uu_diem,
      khuyet_diem = excluded.khuyet_diem, danh_gia_chung = excluded.danh_gia_chung, kien_nghi = excluded.kien_nghi`)
    .run(params.month, staffId, JSON.stringify(ratings), JSON.stringify(notes), clean(body.uu_diem, 300), clean(body.khuyet_diem, 300), clean(body.danh_gia_chung, 300), clean(body.kien_nghi, 300));
  return { ok: true };
});

// --- lịch trực ---
const SHIFT_CODES = ['HC', '24', 'N', 'D', 'P'];
route('GET', '/api/shifts', {}, ({ query }) => {
  if (!isMonth(query.month)) throw new HttpError(400, 'Tháng không hợp lệ');
  const rows = db.prepare('SELECT day, staff_id, code FROM shifts WHERE day LIKE ?').all(`${query.month}-%`);
  const shifts = {};
  for (const r of rows) (shifts[r.staff_id] ||= {})[r.day] = r.code;
  return { staff: db.prepare('SELECT id, name, shift_type FROM staff WHERE active = 1 ORDER BY sort, id').all(), shifts, codes: SHIFT_CODES };
});
route('PUT', '/api/shifts', {}, ({ body }) => {
  if (!isDay(body.day)) throw new HttpError(400, 'Ngày không hợp lệ');
  const staffId = Number(body.staff_id);
  if (!body.code) {
    db.prepare('DELETE FROM shifts WHERE day = ? AND staff_id = ?').run(body.day, staffId);
  } else {
    if (!SHIFT_CODES.includes(body.code)) throw new HttpError(400, 'Ca không hợp lệ');
    db.prepare('INSERT INTO shifts (day, staff_id, code) VALUES (?, ?, ?) ON CONFLICT(day, staff_id) DO UPDATE SET code = excluded.code')
      .run(body.day, staffId, body.code);
  }
  return { ok: true };
});

/** Điền nhanh cả tháng cho một nhân viên (code rỗng = xoá cả tháng). */
route('PUT', '/api/shifts/bulk', {}, ({ body }) => {
  if (!isMonth(body.month)) throw new HttpError(400, 'Tháng không hợp lệ');
  const staffId = Number(body.staff_id);
  if (body.code && !SHIFT_CODES.includes(body.code)) throw new HttpError(400, 'Ca không hợp lệ');
  const [y, m] = body.month.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  tx(db, () => {
    for (let d = 1; d <= days; d += 1) {
      const day = `${body.month}-${String(d).padStart(2, '0')}`;
      if (!body.code) db.prepare('DELETE FROM shifts WHERE day = ? AND staff_id = ?').run(day, staffId);
      else db.prepare('INSERT INTO shifts (day, staff_id, code) VALUES (?, ?, ?) ON CONFLICT(day, staff_id) DO UPDATE SET code = excluded.code').run(day, staffId, body.code);
    }
  });
  return { ok: true };
});

// --- danh bạ cơ quan ---
const contactRow = (b) => {
  const name = clean(b.name, 120);
  const phone = clean(b.phone, 40);
  if (!name || !phone) throw new HttpError(400, 'Cần nhập tên cơ quan và số điện thoại');
  return [name, clean(b.category, 40), phone, clean(b.phone2, 40), clean(b.address, 200), clean(b.note, 300)];
};
route('GET', '/api/contacts', {}, () => db.prepare('SELECT * FROM contacts ORDER BY category, name').all());
route('POST', '/api/contacts', {}, ({ body }) => {
  const r = db.prepare('INSERT INTO contacts (name, category, phone, phone2, address, note) VALUES (?, ?, ?, ?, ?, ?)').run(...contactRow(body));
  return { id: Number(r.lastInsertRowid) };
});
route('PUT', '/api/contacts/:id', {}, ({ params, body }) => {
  db.prepare('UPDATE contacts SET name = ?, category = ?, phone = ?, phone2 = ?, address = ?, note = ? WHERE id = ?').run(...contactRow(body), Number(params.id));
  return { ok: true };
});
route('DELETE', '/api/contacts/:id', {}, ({ params }) => {
  db.prepare('DELETE FROM contacts WHERE id = ?').run(Number(params.id));
  return { ok: true };
});

// --- kiểm tra an ninh & giao việc ---
route('GET', '/api/checklist', {}, ({ query }) => {
  const day = query.day || today();
  if (!isDay(day)) throw new HttpError(400, 'Ngày không hợp lệ');
  const logs = {};
  for (const r of db.prepare('SELECT item_id, staff_id, done, done_at, note FROM check_logs WHERE day = ?').all(day)) logs[r.item_id] = r;
  return {
    day,
    items: db.prepare('SELECT id, text FROM check_items WHERE active = 1 ORDER BY sort, id').all(),
    staff: db.prepare('SELECT id, name FROM staff WHERE active = 1 ORDER BY sort, id').all(),
    on_duty: db.prepare('SELECT staff_id FROM shifts WHERE day = ? AND code != ?').all(day, 'P').map((r) => r.staff_id),
    logs,
  };
});
route('PUT', '/api/checklist', {}, ({ body }) => {
  if (!isDay(body.day)) throw new HttpError(400, 'Ngày không hợp lệ');
  const itemId = Number(body.item_id);
  if (!db.prepare('SELECT 1 FROM check_items WHERE id = ?').get(itemId)) throw new HttpError(404, 'Không có hạng mục này');
  const cur = db.prepare('SELECT * FROM check_logs WHERE day = ? AND item_id = ?').get(body.day, itemId) || { staff_id: null, done: 0, done_at: null, note: '' };
  const done = body.done === undefined ? cur.done : (body.done ? 1 : 0);
  const next = {
    staff_id: body.staff_id === undefined ? cur.staff_id : (body.staff_id ? Number(body.staff_id) : null),
    done,
    done_at: done ? (cur.done ? cur.done_at : Date.now()) : null,
    note: body.note === undefined ? cur.note : clean(body.note, 200),
  };
  db.prepare(`INSERT INTO check_logs (day, item_id, staff_id, done, done_at, note) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, item_id) DO UPDATE SET staff_id = excluded.staff_id, done = excluded.done, done_at = excluded.done_at, note = excluded.note`)
    .run(body.day, itemId, next.staff_id, next.done, next.done_at, next.note);
  return { ok: true };
});
/** Chia đều các hạng mục chưa giao cho danh sách nhân viên (xoay vòng). */
route('POST', '/api/checklist/assign', {}, ({ body }) => {
  if (!isDay(body.day)) throw new HttpError(400, 'Ngày không hợp lệ');
  const ids = (Array.isArray(body.staff_ids) ? body.staff_ids : []).map(Number).filter(Number.isInteger);
  if (!ids.length) throw new HttpError(400, 'Chọn ít nhất một nhân viên');
  tx(db, () => {
    const items = db.prepare('SELECT id FROM check_items WHERE active = 1 ORDER BY sort, id').all();
    let i = 0;
    for (const { id } of items) {
      const log = db.prepare('SELECT staff_id FROM check_logs WHERE day = ? AND item_id = ?').get(body.day, id);
      if (log && log.staff_id) continue;
      db.prepare(`INSERT INTO check_logs (day, item_id, staff_id) VALUES (?, ?, ?)
        ON CONFLICT(day, item_id) DO UPDATE SET staff_id = excluded.staff_id`).run(body.day, id, ids[i % ids.length]);
      i += 1;
    }
  });
  return { ok: true };
});
route('POST', '/api/check-items', {}, ({ body }) => {
  const text = clean(body.text, 200);
  if (!text) throw new HttpError(400, 'Nhập nội dung hạng mục');
  const max = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM check_items').get().n;
  const r = db.prepare('INSERT INTO check_items (text, sort) VALUES (?, ?)').run(text, max);
  return { id: Number(r.lastInsertRowid) };
});
route('PUT', '/api/check-items/:id', {}, ({ params, body }) => {
  const text = clean(body.text, 200);
  if (!text) throw new HttpError(400, 'Nhập nội dung hạng mục');
  db.prepare('UPDATE check_items SET text = ? WHERE id = ?').run(text, Number(params.id));
  return { ok: true };
});
route('DELETE', '/api/check-items/:id', {}, ({ params }) => {
  db.prepare('UPDATE check_items SET active = 0 WHERE id = ?').run(Number(params.id));
  return { ok: true };
});

// ---------- Dispatcher ----------
function serveStatic(req, res, pathname) {
  const rel = PAGES[pathname] || pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return notFound(res);
  fs.readFile(file, (err, buf) => {
    if (err) return notFound(res);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      ...SEC_HEADERS,
    });
    res.end(buf);
  });
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SEC_HEADERS });
  res.end('Không tìm thấy');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const pathname = decodeURIComponent(url.pathname);

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Không hỗ trợ' });
      return serveStatic(req, res, pathname);
    }

    const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
    if (!r) throw new HttpError(404, 'Không tìm thấy');

    const cookies = parseCookies(req);
    if (r.auth && !auth.check(cookies.sid)) throw new HttpError(401, 'Cần đăng nhập');

    let body = {};
    if (req.method !== 'GET') {
      // Bắt buộc JSON: chặn form chéo trang (CSRF) bên cạnh cookie SameSite=Strict.
      if (!String(req.headers['content-type'] || '').startsWith('application/json') && Number(req.headers['content-length'] || 0) > 0) {
        throw new HttpError(415, 'Cần Content-Type: application/json');
      }
      body = await readBody(req);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Dữ liệu không hợp lệ');
    }

    const params = {};
    const m = r.re.exec(pathname);
    r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
    const ctx = { req, res, body, params, cookies, ip: clientIp(req), query: Object.fromEntries(url.searchParams) };
    const out = r.handler(ctx);
    if (!r.raw) sendJson(res, 200, out);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: 'Lỗi máy chủ' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Bảo vệ app đang chạy tại http://${HOST}:${PORT}  (dữ liệu: ${DATA_DIR})`);
  if (initialPin) {
    console.log('==============================================');
    console.log(`  MÃ PIN QUẢN LÝ LẦN ĐẦU: ${initialPin}`);
    console.log('  Hãy đăng nhập và đổi PIN trong mục Cài đặt.');
    console.log('==============================================');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); });
}

module.exports = { server };
