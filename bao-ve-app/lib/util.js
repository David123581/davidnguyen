'use strict';

const TZ = 'Asia/Ho_Chi_Minh';

/** Ngày hiện tại theo giờ Việt Nam, dạng YYYY-MM-DD (VPS thường chạy giờ UTC). */
function today() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
}

function isDay(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

function isMonth(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function clean(v, max) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

module.exports = { TZ, today, isDay, isMonth, HttpError, clean };
