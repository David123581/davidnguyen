'use strict';

// Sao lưu dữ liệu an toàn khi app đang chạy:  npm run backup   (tạo data/backup-YYYYMMDD.db)
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const out = path.join(dataDir, `backup-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.db`);
fs.rmSync(out, { force: true });
const db = new DatabaseSync(path.join(dataDir, 'baove.db'));
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();
console.log('Đã sao lưu:', out);
