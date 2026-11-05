'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(3, '0');
  let lastSeq = null; // seq của lần gọi cuối đã thấy; null = chưa nhận trạng thái nào
  let audioReady = false;
  let audioCtx = null;
  const speechQueue = [];
  let speaking = false;

  // --- giọng đọc ---
  function pickVoice() {
    const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    return voices.find((v) => /^vi/i.test(v.lang)) || null;
  }

  function chime() {
    if (!audioCtx) return Promise.resolve();
    return new Promise((resolve) => {
      const t = audioCtx.currentTime;
      [[880, 0], [660, 0.35]].forEach(([f, d]) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + d);
        g.gain.exponentialRampToValueAtTime(0.35, t + d + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.5);
        o.connect(g).connect(audioCtx.destination);
        o.start(t + d); o.stop(t + d + 0.55);
      });
      setTimeout(resolve, 900);
    });
  }

  function say(text) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'vi-VN';
      const v = pickVoice();
      if (v) u.voice = v;
      u.rate = 0.9;
      u.onend = resolve;
      u.onerror = resolve;
      speechSynthesis.speak(u);
      setTimeout(resolve, 15000); // tránh treo nếu trình duyệt không phát sự kiện kết thúc
    });
  }

  async function drain() {
    if (speaking) return;
    speaking = true;
    while (speechQueue.length) {
      const { number, counter } = speechQueue.shift();
      const text = `Mời khách hàng số ${number}, đến quầy ${counter}`;
      await chime();
      await say(text);
      await new Promise((r) => setTimeout(r, 400));
      await say(text); // đọc lặp lại một lần cho khách nghe rõ
    }
    speaking = false;
  }

  function announce(call) {
    if (!audioReady) return;
    speechQueue.push(call);
    if (speechQueue.length > 5) speechQueue.shift();
    drain();
  }

  // --- hiển thị ---
  function render(s) {
    $('branch').textContent = s.branch || 'PGD';
    $('note').textContent = s.note || '';
    $('waiting').textContent = `Đang chờ: ${s.waiting} khách`;
    const list = $('counters');
    list.replaceChildren();
    const by = new Map(s.serving.map((x) => [x.counter, x.number]));
    for (let c = 1; c <= s.counters; c += 1) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = `Quầy ${c}`;
      const b = document.createElement('b');
      b.textContent = by.has(c) ? pad(by.get(c)) : '---';
      if (!by.has(c)) li.className = 'idle';
      li.append(name, b);
      list.append(li);
    }
    const next = $('next');
    next.replaceChildren();
    for (const n of s.next) {
      const sp = document.createElement('span');
      sp.textContent = pad(n);
      next.append(sp);
    }
    if (s.last_call) {
      $('num').textContent = pad(s.last_call.number);
      $('cnt').textContent = s.last_call.counter;
    } else {
      $('num').textContent = '---';
      $('cnt').textContent = '-';
    }
  }

  function onState(s) {
    render(s);
    const call = s.last_call;
    if (lastSeq === null) { lastSeq = call ? call.seq : 0; return; } // lần đầu: không đọc lại cuộc gọi cũ
    if (call && call.seq > lastSeq) {
      lastSeq = call.seq;
      const cur = $('current');
      cur.classList.remove('flash');
      void cur.offsetWidth;
      cur.classList.add('flash');
      announce(call);
    }
  }

  function connect() {
    const es = new EventSource('/api/stream');
    es.addEventListener('state', (e) => { try { onState(JSON.parse(e.data)); } catch { /* bỏ qua gói lỗi */ } });
    es.onerror = () => { /* EventSource tự kết nối lại sau 3 giây */ };
  }

  // --- đồng hồ ---
  function tick() {
    $('clock').textContent = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  tick();
  setInterval(tick, 15000);

  // --- khởi động ---
  function voiceInfo() {
    $('voiceInfo').textContent = pickVoice() ? '' : 'Cảnh báo: máy này chưa có giọng đọc tiếng Việt. Hãy dùng Microsoft Edge hoặc Chrome trên Windows/Android, hoặc cài giọng "Tiếng Việt" trong cài đặt hệ thống.';
  }
  if (window.speechSynthesis) speechSynthesis.addEventListener('voiceschanged', voiceInfo);
  voiceInfo();

  $('enable').addEventListener('click', async () => {
    audioReady = true;
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); await audioCtx.resume(); } catch { audioCtx = null; }
    await say('Hệ thống gọi số đã sẵn sàng');
    $('start').classList.add('hidden');
    if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  });

  // Hiển thị ngay cả khi chưa bấm bật âm thanh (chỉ không có tiếng).
  connect();
})();
