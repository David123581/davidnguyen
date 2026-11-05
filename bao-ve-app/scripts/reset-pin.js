'use strict';

// Dùng khi quên PIN:  npm run reset-pin -- 123456
const path = require('node:path');
const { open, setSetting } = require('../lib/db');
const { hashPin, validatePin } = require('../lib/auth');

const pin = process.argv[2];
try {
  validatePin(pin);
} catch (e) {
  console.error(e.message || 'Cú pháp: npm run reset-pin -- <PIN mới>');
  process.exit(1);
}
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const db = open(path.join(dataDir, 'baove.db'));
setSetting(db, 'pin_hash', hashPin(pin));
console.log('Đã đặt lại PIN. Khởi động lại dịch vụ để mọi phiên đăng nhập cũ bị thoát.');
