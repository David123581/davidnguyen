'use strict';

const crypto = require('node:crypto');
const { tx, getSetting } = require('./db');
const { today, HttpError, clean } = require('./util');

/**
 * Hàng đợi số thứ tự. Số reset mỗi ngày (giờ Việt Nam).
 * onChange() được gọi sau mỗi thay đổi để đẩy trạng thái mới lên tivi (SSE).
 */
function createQueue(db, onChange) {
  let callSeq = Date.now(); // tăng đơn điệu, kể cả sau khi khởi động lại
  let lastCall = null; // {seq, number, counter, day}

  const counters = () => Math.min(10, Math.max(1, Number(getSetting(db, 'counters', '3')) || 3));

  function assertCounter(c) {
    const n = Number(c);
    if (!Number.isInteger(n) || n < 1 || n > counters()) throw new HttpError(400, 'Quầy không hợp lệ');
    return n;
  }

  function announce(ticket) {
    callSeq += 1;
    lastCall = { seq: callSeq, number: ticket.number, counter: ticket.counter, day: ticket.day };
  }

  function publicState() {
    const day = today();
    const serving = db.prepare("SELECT number, counter FROM tickets WHERE day = ? AND status = 'serving' ORDER BY counter").all(day);
    const waiting = db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE day = ? AND status = 'waiting'").get(day).n;
    const next = db.prepare("SELECT number FROM tickets WHERE day = ? AND status = 'waiting' ORDER BY number LIMIT 5").all(day).map((r) => r.number);
    return {
      day,
      counters: counters(),
      serving,
      waiting,
      next,
      last_call: lastCall && lastCall.day === day ? lastCall : null,
      note: getSetting(db, 'tv_note'),
      branch: getSetting(db, 'branch_title'),
    };
  }

  function issue({ name = '', token = null, source = 'phone' } = {}) {
    const day = today();
    const tk = token || crypto.randomBytes(16).toString('hex');
    const ticket = tx(db, () => {
      const n = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tickets WHERE day = ?').get(day).n;
      db.prepare('INSERT INTO tickets (day, number, name, token, source, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(day, n, clean(name, 40), tk, source, Date.now());
      return db.prepare('SELECT * FROM tickets WHERE day = ? AND number = ?').get(day, n);
    });
    onChange();
    return ticket;
  }

  function byToken(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return null;
    const t = db.prepare('SELECT * FROM tickets WHERE token = ?').get(token);
    return t && t.day === today() ? t : null;
  }

  function ticketView(t) {
    const ahead = t.status === 'waiting'
      ? db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE day = ? AND status = 'waiting' AND number < ?").get(t.day, t.number).n
      : 0;
    return { number: t.number, status: t.status, counter: t.counter, ahead };
  }

  function servingAt(counter) {
    return db.prepare("SELECT * FROM tickets WHERE day = ? AND status = 'serving' AND counter = ?").get(today(), counter);
  }

  function finishServing(counter, status = 'done') {
    const cur = servingAt(counter);
    if (cur) db.prepare('UPDATE tickets SET status = ?, finished_at = ? WHERE id = ?').run(status, Date.now(), cur.id);
    return cur;
  }

  function startServing(ticket, counter) {
    db.prepare("UPDATE tickets SET status = 'serving', counter = ?, called_at = ?, finished_at = NULL, call_count = call_count + 1 WHERE id = ?")
      .run(counter, Date.now(), ticket.id);
    const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
    announce(t);
    return t;
  }

  return {
    counters,
    publicState,
    issue,
    byToken,
    ticketView,

    list() {
      const day = today();
      const rows = db.prepare('SELECT number, name, status, counter, source, created_at, called_at, finished_at, call_count FROM tickets WHERE day = ? ORDER BY number').all(day);
      const stats = { issued: rows.length, waiting: 0, serving: 0, done: 0, skipped: 0 };
      for (const r of rows) stats[r.status] += 1;
      return { day, counters: counters(), tickets: rows, stats };
    },

    /** Gọi số kế tiếp (nhỏ nhất đang chờ) lên quầy; số đang phục vụ ở quầy đó coi như hoàn tất. */
    callNext(counterRaw) {
      const counter = assertCounter(counterRaw);
      const res = tx(db, () => {
        const next = db.prepare("SELECT * FROM tickets WHERE day = ? AND status = 'waiting' ORDER BY number LIMIT 1").get(today());
        if (!next) return null;
        finishServing(counter);
        return startServing(next, counter);
      });
      if (res) onChange();
      return res;
    },

    /** Gọi một số cụ thể (kể cả số đã bị bỏ qua) lên quầy. */
    callNumber(counterRaw, numberRaw) {
      const counter = assertCounter(counterRaw);
      const number = Number(numberRaw);
      if (!Number.isInteger(number) || number < 1) throw new HttpError(400, 'Số không hợp lệ');
      const res = tx(db, () => {
        const t = db.prepare('SELECT * FROM tickets WHERE day = ? AND number = ?').get(today(), number);
        if (!t) throw new HttpError(404, `Chưa có số ${number} hôm nay`);
        if (t.status === 'serving' && t.counter !== counter) throw new HttpError(409, `Số ${number} đang được phục vụ ở quầy ${t.counter}`);
        if (t.status === 'serving') return startServing(t, counter); // gọi lại
        finishServing(counter);
        return startServing(t, counter);
      });
      onChange();
      return res;
    },

    recall(counterRaw) {
      const counter = assertCounter(counterRaw);
      const cur = servingAt(counter);
      if (!cur) throw new HttpError(409, `Quầy ${counter} chưa có số nào đang phục vụ`);
      const res = startServing(cur, counter);
      onChange();
      return res;
    },

    /** Khách vắng mặt: đánh dấu bỏ qua. */
    skip(counterRaw) {
      const counter = assertCounter(counterRaw);
      const cur = finishServing(counter, 'skipped');
      if (!cur) throw new HttpError(409, `Quầy ${counter} chưa có số nào đang phục vụ`);
      onChange();
      return cur;
    },

    done(counterRaw) {
      const counter = assertCounter(counterRaw);
      const cur = finishServing(counter, 'done');
      if (!cur) throw new HttpError(409, `Quầy ${counter} chưa có số nào đang phục vụ`);
      onChange();
      return cur;
    },
  };
}

module.exports = { createQueue };
