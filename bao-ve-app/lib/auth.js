'use strict';

const crypto = require('node:crypto');
const { getSetting, setSetting } = require('./db');
const { HttpError } = require('./util');

const SESSION_MS = 12 * 3600 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 10 * 60 * 1000;

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pin, salt, 32).toString('hex')}`;
}

function verifyPin(pin, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(String(pin), Buffer.from(salt, 'hex'), 32);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function validatePin(pin) {
  if (typeof pin !== 'string' || pin.length < 4 || pin.length > 64) {
    throw new HttpError(400, 'Mã PIN phải từ 4 đến 64 ký tự');
  }
}

/** Tạo PIN lần đầu: lấy từ ADMIN_PIN, nếu không có thì sinh ngẫu nhiên và trả về để in ra console. */
function ensurePin(db, envPin) {
  if (getSetting(db, 'pin_hash')) return null;
  const pin = envPin || String(crypto.randomInt(100000, 1000000));
  validatePin(pin);
  setSetting(db, 'pin_hash', hashPin(pin));
  return envPin ? null : pin;
}

function createAuth(db) {
  const sessions = new Map(); // sid -> expiry
  const fails = new Map(); // ip -> {count, until}

  function sweep() {
    const now = Date.now();
    for (const [k, exp] of sessions) if (exp < now) sessions.delete(k);
    for (const [k, v] of fails) if (v.until && v.until < now) fails.delete(k);
  }
  setInterval(sweep, 60_000).unref();

  return {
    login(pin, ip) {
      const rec = fails.get(ip) || { count: 0, until: 0 };
      if (rec.until > Date.now()) throw new HttpError(429, 'Nhập sai quá nhiều lần, vui lòng thử lại sau 10 phút');
      if (typeof pin !== 'string' || !verifyPin(pin, getSetting(db, 'pin_hash'))) {
        rec.count += 1;
        if (rec.count >= MAX_FAILS) { rec.until = Date.now() + LOCK_MS; rec.count = 0; }
        fails.set(ip, rec);
        throw new HttpError(401, 'Mã PIN không đúng');
      }
      fails.delete(ip);
      const sid = crypto.randomBytes(24).toString('hex');
      sessions.set(sid, Date.now() + SESSION_MS);
      return sid;
    },
    check(sid) {
      if (!sid) return false;
      const exp = sessions.get(sid);
      if (!exp || exp < Date.now()) { sessions.delete(sid); return false; }
      sessions.set(sid, Date.now() + SESSION_MS); // gia hạn khi còn dùng
      return true;
    },
    logout(sid) { sessions.delete(sid); },
    changePin(oldPin, newPin) {
      if (!verifyPin(String(oldPin), getSetting(db, 'pin_hash'))) throw new HttpError(403, 'PIN hiện tại không đúng');
      validatePin(newPin);
      setSetting(db, 'pin_hash', hashPin(newPin));
      sessions.clear();
    },
    SESSION_MS,
  };
}

module.exports = { createAuth, ensurePin, hashPin, validatePin };
