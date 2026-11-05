'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  number INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','serving','done','skipped')),
  counter INTEGER,
  token TEXT,
  source TEXT NOT NULL DEFAULT 'phone',
  created_at INTEGER NOT NULL,
  called_at INTEGER,
  finished_at INTEGER,
  call_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (day, number)
);
CREATE INDEX IF NOT EXISTS idx_tickets_token ON tickets(token);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  shift_type TEXT NOT NULL DEFAULT '24' CHECK (shift_type IN ('hc','12','24')),
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS criteria (
  code TEXT PRIMARY KEY,
  is_group INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  sort INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS evaluations (
  month TEXT NOT NULL,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  ratings TEXT NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '{}',
  uu_diem TEXT NOT NULL DEFAULT '',
  khuyet_diem TEXT NOT NULL DEFAULT '',
  danh_gia_chung TEXT NOT NULL DEFAULT '',
  kien_nghi TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (month, staff_id)
);

CREATE TABLE IF NOT EXISTS shifts (
  day TEXT NOT NULL,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  code TEXT NOT NULL,
  PRIMARY KEY (day, staff_id)
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  phone2 TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS check_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS check_logs (
  day TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES check_items(id),
  staff_id INTEGER,
  done INTEGER NOT NULL DEFAULT 0,
  done_at INTEGER,
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (day, item_id)
);
`;

/** Nội dung phiếu "Bảng đánh giá chất lượng bảo vệ" theo mẫu công ty (nhóm = is_group). */
const CRITERIA = [
  ['1', 1, 'Chấp hành nội quy làm việc:'],
  ['1.1', 0, 'Tuân thủ giờ làm việc, nội quy và qui chế, đến nhận ca đúng giờ theo quy định (đến trước tối thiểu 15 phút).'],
  ['1.2', 0, 'Trang phục: Mũ có sao, cà vạt, thẻ tên, đồng phục theo quy định, giầy da đen, thắt lưng đen. Ăn mặc gọn gàng, sạch sẽ.'],
  ['1.3', 0, 'Đeo CCHT được Công ty cấp phát trên người và giấy chứng nhận sử dụng (trong trường hợp mục tiêu được cấp CCHT)'],
  ['1.4', 0, 'Nhận và Bàn giao ca (vị trí 24/24h) hoặc bàn giao cho đại diện Ngân hàng (ca HC) cụ thể, chi tiết theo quy định.'],
  ['1.5', 0, 'Không cho người lạ ra vào mục tiêu bảo vệ ngoài giờ hành chính.'],
  ['1.6', 0, 'Không tổ chức đánh bạc dưới mọi hình thức tại mục tiêu bảo vệ.'],
  ['1.7', 0, 'Không sử dụng bia rượu, chất kích thích trong thời gian làm việc.'],
  ['1.8', 0, 'Không tự ý bỏ chốt bảo vệ'],
  ['2', 1, 'Tác phong làm việc và Giao tiếp ứng xử:'],
  ['2.1', 0, 'Tác phong nhanh nhẹn, nghiêm trang, linh hoạt, hỗ trợ khách hàng ra/vào giao dịch.'],
  ['2.2', 0, 'Tư thế đứng, ngồi nghiêm chỉnh, đúng điều lệnh, thể hiện sự chủ động kiểm soát đảm bảo an ninh an toàn.'],
  ['2.3', 0, 'Nhân viên luôn trong tư thế chủ động sẵn sàng chào đón tiếp khách, Lãnh đạo và Cán bộ nhân viên Ngân hàng.'],
  ['2.4', 0, 'Luôn chào hỏi, kính trọng, lễ phép, lịch sự và đúng mực với khách hàng Lãnh đạo và Cán bộ nhân viên Ngân hàng.'],
  ['3', 1, 'Chuyên môn Nghiệp vụ:'],
  ['3.1', 0, 'Kiểm soát khu vực bảo vệ được phân công đảm bảo an ninh an toàn mục tiêu.'],
  ['3.2', 0, 'Hướng dẫn khách đưa xe vào đúng vị trí quy định, phát vé và mời khách vào làm việc.'],
  ['3.3', 0, 'Nắm rõ danh mục tài sản cần bảo vệ tại mục tiêu'],
  ['3.4', 0, 'Chủ động quan sát, kiểm soát chặt chẽ con người và tài sản ra/vào khu vực bảo vệ. Thực hiện hỗ trợ khách hàng đến làm việc với Ngân hàng (đặc biệt người già, phụ nữ, người tàn tật,...)'],
  ['3.5', 0, 'Nắm rõ quy trình và biết vận hành, xử lý công tác Phòng cháy chữa cháy, Phòng chống Bão lụt.'],
  ['3.6', 0, 'Tinh thần chấp hành, kỷ luật cao.'],
  ['3.7', 0, 'Quan sát và phát hiện các hiện tượng, vấn đề xảy ra tại mục tiêu để có báo cáo sớm và có biện pháp khắc phục'],
];

const DEFAULT_SETTINGS = {
  company: 'CÔNG TY CPDV BẢO VỆ SAO VÀNG FB',
  target: 'PGT Tân Châu',
  place: 'Tân Châu',
  branch_title: 'PGD Tân Châu',
  counters: '3',
  require_key: '0',
  tv_note: 'Kính chào quý khách. Vui lòng giữ trật tự và chờ đến lượt.',
};

const DEFAULT_STAFF = [
  ['Nguyễn Cường Quốc', '24'],
  ['Nguyễn Khánh Luận', '24'],
  ['Nguyễn Minh Nhựt', 'hc'],
];

const DEFAULT_CHECKS = [
  'Kiểm tra cửa ra vào, khóa cổng, cửa sau',
  'Kiểm tra camera và đầu ghi hình hoạt động bình thường',
  'Kiểm tra hệ thống báo cháy, bình chữa cháy còn áp suất',
  'Kiểm tra đèn chiếu sáng, bảng hiệu',
  'Kiểm tra khu vực để xe, sắp xếp xe gọn gàng',
  'Kiểm tra khu vực quầy giao dịch trước giờ mở cửa',
  'Bàn giao ca, ghi sổ giao nhận',
];

// Chỉ các số khẩn cấp quốc gia; các số khác do người dùng tự nhập.
const DEFAULT_CONTACTS = [
  ['Công an (cảnh sát) khẩn cấp', 'Công an', '113'],
  ['Cảnh sát phòng cháy chữa cháy', 'PCCC', '114'],
  ['Cấp cứu y tế', 'Y tế', '115'],
];

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  seed(db);
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function seed(db) {
  const setIfMissing = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setIfMissing.run(k, v);
  setIfMissing.run('ticket_key', crypto.randomBytes(6).toString('hex'));

  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;

  if (count('criteria') === 0) {
    const ins = db.prepare('INSERT INTO criteria (code, is_group, text, sort) VALUES (?, ?, ?, ?)');
    CRITERIA.forEach(([code, g, text], i) => ins.run(code, g, text, i));
  }
  if (count('staff') === 0) {
    const ins = db.prepare('INSERT INTO staff (name, shift_type, sort) VALUES (?, ?, ?)');
    DEFAULT_STAFF.forEach(([n, t], i) => ins.run(n, t, i));
  }
  if (count('check_items') === 0) {
    const ins = db.prepare('INSERT INTO check_items (text, sort) VALUES (?, ?)');
    DEFAULT_CHECKS.forEach((t, i) => ins.run(t, i));
  }
  if (count('contacts') === 0) {
    const ins = db.prepare('INSERT INTO contacts (name, category, phone) VALUES (?, ?, ?)');
    for (const c of DEFAULT_CONTACTS) ins.run(...c);
  }
}

function getSetting(db, key, fallback = '') {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

module.exports = { open, tx, getSetting, setSetting, CRITERIA };
