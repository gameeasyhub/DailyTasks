/* ============ Мои дела — приложение (vanilla JS, localStorage, PWA) ============ */
'use strict';

/* ---------------- состояние ---------------- */
const LS_KEY = 'dailytasks.v1';
const DEFAULTS = {
  tasks: {},                                   // { "YYYY-MM-DD": [task, ...] }
  settings: { pushOn: true, channel: 'pushover', poUser: '', poToken: '', theme: 'auto' },
  sub: null,                                   // { vapid: {pub, priv}, sub: {endpoint, keys} }
  missed: {},                                  // { taskId: "YYYY-MM-DD" } — уже напомнили
};
let state = load();
let view = (() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; })();
let activeDay = null;          // открытая дата в окне дня
let moveCtx = null;            // { id, from }
let timers = {};

/* ---------------- утилиты ---------------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return {
      tasks: s.tasks || {},
      settings: Object.assign({}, DEFAULTS.settings, s.settings || {}),
      sub: s.sub || null,
      missed: s.missed || {},
    };
  } catch (e) { return JSON.parse(JSON.stringify(DEFAULTS)); }
}
function save() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), ms);
}
function toKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fromKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function todayKey() { return toKey(new Date()); }
function fmtDay(k) {
  const d = fromKey(k);
  return d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- календарь ---------------- */
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

function renderCalendar() {
  $('#monthTitle').textContent = `${MONTHS[view.m]} ${view.y}`;
  const first = new Date(view.y, view.m, 1);
  const offset = (first.getDay() + 6) % 7;              // Пн = 0
  const daysIn = new Date(view.y, view.m + 1, 0).getDate();
  const prevDays = new Date(view.y, view.m, 0).getDate();
  const today = todayKey();
  const cells = [];
  for (let i = 0; i < offset; i++) {                    // хвост прошлого месяца
    const d = new Date(view.y, view.m, i - offset + 1);
    cells.push({ k: toKey(d), n: d.getDate(), dim: true, pm: true });
  }
  for (let d = 1; d <= daysIn; d++) {
    const k = toKey(new Date(view.y, view.m, d));
    cells.push({ k, n: d, dim: false, pm: false });
  }
  while (cells.length % 7) {                            // начало следующего месяца
    const last = cells[cells.length - 1];
    const d = fromKey(last.k); d.setDate(d.getDate() + 1);
    cells.push({ k: toKey(d), n: d.getDate(), dim: true, pm: true });
  }
  $('#calendar').innerHTML = cells.map(c => {
    const tasks = state.tasks[c.k] || [];
    const done = tasks.filter(t => t.done).length;
    let badge = '';
    if (tasks.length) {
      const cls = done === tasks.length ? 'ok' : done > 0 ? 'part' : 'many';
      badge = `<span class="badge ${cls}">${done}/${tasks.length}</span>`;
    }
    const cls = ['day', c.dim ? 'dim' : '', c.k === today ? 'today' : ''].join(' ');
    return `<div class="${cls}" data-date="${c.k}" data-pm="${c.pm}"><span class="dnum">${c.n}</span>${badge}</div>`;
  }).join('');
  renderWeekStats();
}

function renderWeekStats() {
  const now = new Date();
  const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  let total = 0, done = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday); d.setDate(monday.getDate() + i);
    const tasks = state.tasks[toKey(d)] || [];
    total += tasks.length; done += tasks.filter(t => t.done).length;
  }
  const pct = total ? Math.round(done / total * 100) : 0;
  $('#weekStats').innerHTML = total
    ? `За эту неделю выполнено <b>${done} из ${total}</b> (${pct}%)<div class="bar"><i style="width:${pct}%"></i></div>`
    : `На этой неделе дел пока нет. Нажми на день — и добавь первое 🙂`;
}

/* ---------------- окно дня ---------------- */
function openDay(k) {
  activeDay = k;
  $('#dayTitle').textContent = fmtDay(k);
  renderDay();
  $('#dayModal').classList.remove('hidden');
  setTimeout(() => $('#newText').focus(), 80);
}
function closeModals() { $$('.modal').forEach(m => m.classList.add('hidden')); }

function renderDay() {
  const tasks = (state.tasks[activeDay] || []).slice()
    .sort((a, b) => (a.done - b.done) || (a.time || '99').localeCompare(b.time || '99') || (a.created - b.created));
  const done = tasks.filter(t => t.done).length;
  const cnt = $('#dayCount');
  cnt.textContent = tasks.length ? `${done}/${tasks.length}` : '';
  cnt.className = 'chip' + (tasks.length && done === tasks.length ? ' ok' : '');
  $('#dayEmpty').classList.toggle('hidden', tasks.length > 0);
  $('#taskList').innerHTML = tasks.map(t => taskHTML(t)).join('');
}

function taskHTML(t) {
  const meta = [];
  if (t.time) meta.push(`<span class="tag">🕒 ${esc(t.time)}</span>`);
  if (t.remind) meta.push(`<span class="tag">🔔 напомнить</span>`);
  if (t.comment) meta.push(`<span class="tag">💬</span>`);
  return `<li class="task${t.done ? ' done' : ''}" data-id="${t.id}">
    <label class="check"><input type="checkbox" ${t.done ? 'checked' : ''}></label>
    <div class="task-body">
      <div class="task-text">${esc(t.text)}</div>
      ${meta.length ? `<div class="task-meta">${meta.join('')}</div>` : ''}
      ${t.comment ? `<div class="task-comment">${esc(t.comment)}</div>` : ''}
      <div class="task-edit hidden"></div>
    </div>
    <div class="task-actions">
      <button class="icon-btn" data-act="move" title="Перенести">⇄</button>
      <button class="icon-btn" data-act="edit" title="Изменить">✎</button>
      <button class="icon-btn" data-act="del" title="Удалить">🗑</button>
    </div>
  </li>`;
}

function editHTML(t) {
  return `<div class="task-edit" data-id="${t.id}">
    <input class="ed-text" type="text" value="${esc(t.text)}" maxlength="300">
    <textarea class="ed-comment" rows="2" placeholder="Комментарий…">${esc(t.comment || '')}</textarea>
    <div class="task-edit-row">
      <input class="ed-time" type="time" value="${esc(t.time || '')}">
      <label class="opt" style="margin:auto 0"><input class="ed-remind" type="checkbox" ${t.remind ? 'checked' : ''}> напомнить</label>
    </div>
    <div class="btn-row">
      <button class="btn-primary" data-act="save">Сохранить</button>
      <button class="btn-secondary" data-act="cancel">Отмена</button>
    </div>
  </div>`;
}

function addTask(e) {
  e.preventDefault();
  const text = $('#newText').value.trim();
  if (!text) return;
  const remind = $('#newRemind').checked;
  if (remind && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission(); // Android: браузер спросит разрешение сразу
  }
  const tasks = state.tasks[activeDay] || (state.tasks[activeDay] = []);
  tasks.push({
    id: uid(), text, done: false,
    comment: '', time: $('#newTime').value || null,
    remind, created: Date.now(),
  });
  $('#newText').value = ''; $('#newTime').value = ''; $('#newRemind').checked = false;
  save(); renderDay(); renderCalendar(); scheduleReminders(); scheduleSW();
  toast('Дело добавлено');
  $('#newText').focus();
}

function toggleTask(id, done) {
  const t = findTask(id); if (!t) return;
  t.done = done;
  save(); renderDay(); renderCalendar(); scheduleReminders();
}

function deleteTask(id) {
  const t = findTask(id); if (!t) return;
  if (!confirm(`Удалить дело «${t.text.slice(0, 60)}»?`)) return;
  const list = state.tasks[activeDay] || [];
  state.tasks[activeDay] = list.filter(x => x.id !== id);
  if (!state.tasks[activeDay].length) delete state.tasks[activeDay];
  save(); renderDay(); renderCalendar(); scheduleReminders();
  toast('Удалено');
}

function findTask(id) {
  const list = state.tasks[activeDay] || [];
  return list.find(t => t.id === id);
}

function openEdit(id) {
  const t = findTask(id); if (!t) return;
  const li = document.querySelector(`#taskList .task[data-id="${id}"]`);
  li.querySelector('.task-edit').innerHTML = editHTML(t);
  li.querySelector('.task-edit').classList.remove('hidden');
}
function saveEdit(id) {
  const t = findTask(id); if (!t) return;
  const box = document.querySelector(`#taskList .task[data-id="${id}"] .task-edit`);
  t.text = box.querySelector('.ed-text').value.trim() || t.text;
  t.comment = box.querySelector('.ed-comment').value.trim();
  t.time = box.querySelector('.ed-time').value || null;
  t.remind = box.querySelector('.ed-remind').checked;
  save(); renderDay(); renderCalendar(); scheduleReminders();
  toast('Сохранено');
}

/* перенос */
function openMove(id) {
  const t = findTask(id); if (!t) return;
  moveCtx = { id, from: activeDay };
  $('#moveTaskName').textContent = `«${t.text.slice(0, 80)}»`;
  $('#moveDate').value = activeDay;
  $('#moveModal').classList.remove('hidden');
}
function doMove() {
  if (!moveCtx) return;
  const to = $('#moveDate').value;
  if (!to) return;
  const list = state.tasks[moveCtx.from] || [];
  const i = list.findIndex(x => x.id === moveCtx.id);
  if (i >= 0) {
    const [task] = list.splice(i, 1);
    if (!list.length) delete state.tasks[moveCtx.from];
    (state.tasks[to] || (state.tasks[to] = [])).push(task);
    save(); renderCalendar();
    activeDay = to;
    $('#dayTitle').textContent = fmtDay(to);
    renderDay(); scheduleReminders();
    toast('Перенесено');
  }
  moveCtx = null;
  $('#moveModal').classList.add('hidden');
}

/* ---------------- напоминания ---------------- */
function allTasks() {
  const out = [];
  for (const k in state.tasks) for (const t of state.tasks[k]) out.push({ k, ...t });
  return out;
}
/* Notification Triggers (Android Chrome, установленный PWA): браузер сам
   показывает уведомление в назначенное время, даже когда приложение закрыто. */
function supportsTriggers() {
  return ('showTrigger' in Notification.prototype) && ('TimestampTrigger' in window);
}
async function cancelTrigger(tag) {
  if (!supportsTriggers()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const scheduled = await reg.getScheduledNotifications();
    for (const n of scheduled) if (n.tag === tag) n.close();
  } catch (e) { /* не критично */ }
}
async function syncTriggers() {
  if (!supportsTriggers()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const scheduled = await reg.getScheduledNotifications();
    // отменяем все старые триггеры напоминаний и создаём актуальные заново
    for (const n of scheduled) if (n.tag && n.tag.startsWith('remind-')) n.close();
    const now = Date.now();
    for (const { k, id, remind, time, done, text } of allTasks()) {
      if (!remind || done || !time) continue;
      const at = fromKey(k); const [hh, mm] = time.split(':').map(Number);
      at.setHours(hh, mm, 0, 0);
      const t = at.getTime();
      if (t > now && t - now <= 48 * 3600 * 1000) {
        try {
          new Notification('⏰ Напоминание', { body: text, icon: './icons/icon-192.png', tag: `remind-${id}`, showTrigger: new TimestampTrigger(t) });
        } catch (e) { /* permission не выдано и т.п. */ }
      }
    }
  } catch (e) { /* не критично */ }
}
function scheduleReminders() {
  Object.keys(timers).forEach(id => { clearTimeout(timers[id]); delete timers[id]; });
  const now = Date.now();
  for (const { k, id, remind, time, done, text } of allTasks()) {
    if (!remind || done || !time) continue;
    const at = fromKey(k); at.setHours(0, 0, 0, 0);
    const [hh, mm] = time.split(':').map(Number);
    at.setHours(hh, mm, 0, 0);
    const delay = at.getTime() - now;
    if (delay > 0 && delay <= 48 * 3600 * 1000) {
      timers[id] = setTimeout(() => {
        cancelTrigger(`remind-${id}`);
        notify('⏰ Напоминание', text, `remind-${id}`);
        delete timers[id];
      }, delay);
    }
  }
  syncTriggers();
}
function checkMissed() {
  const today = todayKey();
  const now = new Date();
  const [hh, mm] = [now.getHours(), now.getMinutes()];
  const cur = hh * 60 + mm;
  for (const t of (state.tasks[today] || [])) {
    if (!t.remind || t.done || !t.time) continue;
    if (state.missed[t.id] === today) continue;
    const [h2, m2] = t.time.split(':').map(Number);
    if (h2 * 60 + m2 <= cur) {
      state.missed[t.id] = today;
      cancelTrigger(`remind-${t.id}`);
      notify('🔔 Пропущенное напоминание', t.text, `remind-${t.id}`);
    }
  }
  save();
}
function scheduleSW() {
  if (!('serviceWorker' in navigator)) return;
  const items = [];
  const now = Date.now();
  for (const { k, id, remind, time, done, text } of allTasks()) {
    if (!remind || done || !time) continue;
    const at = fromKey(k); const [hh, mm] = time.split(':').map(Number);
    at.setHours(hh, mm, 0, 0);
    const delay = at.getTime() - now;
    if (delay > 0 && delay <= 48 * 3600 * 1000) items.push({ at: at.getTime(), title: '⏰ Напоминание', body: text, tag: `remind-${id}` });
  }
  navigator.serviceWorker.ready.then(reg => reg.active && reg.active.postMessage({ type: 'schedule', items }));
}

/* ---------------- уведомления ---------------- */
function notify(title, body, tag) {
  try {
    if (Notification.permission === 'granted') new Notification(title, { body, icon: './icons/icon-192.png', tag });
  } catch (e) { /* некоторые мобильные браузеры кидают на конструкторе */ }
  sendPush(title, body, tag);
}
async function sendPush(title, body, tag) {
  if (!state.settings.pushOn) return false;
  try {
    if (state.settings.channel === 'pushover') { sendPushover(title, body); return true; }
    await sendWebPush(title, body, tag); return true;
  } catch (e) {
    console.warn('push failed:', e);
    pushStatus('Ошибка отправки: ' + e.message, true);
    return false;
  }
}

/* ---------- канал 1: Web Push (self-send, без сервера) ---------- */
const b64u = {
  enc: b => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); },
};
const utf8 = s => new TextEncoder().encode(s);
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8);
  return new Uint8Array(bits);
}
async function exportRawPub(jwk) {           // JWK -> 65 байт (0x04 || X || Y)
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const raw = await crypto.subtle.exportKey('raw', key);
  return new Uint8Array(raw);
}
function u16(n) { return new Uint8Array([n >> 8 & 255, n & 255]); }

async function ensureKeys() {
  if (!state.sub || !state.sub.vapid) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
    state.sub = { vapid: { pub, priv } };
    save();
  }
  return state.sub;
}
async function getSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Web Push не поддерживается браузером');
  await ensureKeys();
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const raw = await exportRawPub(state.sub.vapid.pub);
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
    state.sub.sub = { endpoint: sub.endpoint, keys: { p256dh: sub.toJSON().keys.p256dh, auth: sub.toJSON().keys.auth } };
    save();
  }
  return { reg, sub, keys: sub.toJSON().keys };
}
async function encryptPayload(payload, subKeys) {
  const server = state.sub.vapid;
  const serverPubRaw = await exportRawPub(server.pub);
  const serverPriv = await crypto.subtle.importKey('jwk', server.priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const clientPubRawBytes = b64u.dec(subKeys.p256dh);          // 65 байт из подписки
  const clientPub = await crypto.subtle.importKey('raw', clientPubRawBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const auth = b64u.dec(subKeys.auth);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPub }, serverPriv, 256));
  const ikm = await hkdf(auth, shared, utf8('Content-Encoding: auth\0'), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const context = concat(utf8('P-256\0'), u16(65), clientPubRawBytes, u16(serverPubRaw.length), serverPubRaw);
  const cek = await hkdf(salt, ikm, concat(utf8('Content-Encoding: aes128gcm\0'), context), 16);
  const nonce = await hkdf(salt, ikm, concat(utf8('Content-Encoding: nonce\0'), context), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, utf8(payload)));
  // aes128gcm record: salt(16) || rs(4) || idlen(1) || keyid(65) || ciphertext
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  const record = concat(salt, rs, Uint8Array.of(serverPubRaw.length), serverPubRaw, ct);
  return { record, serverPubRaw };
}
async function makeJWT(aud) {
  const jwk = Object.assign({}, state.sub.vapid.priv);
  delete jwk.key_ops; delete jwk.ext;                     // ключ из ECDH — чистим операции
  const priv = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const h = b64u.enc(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const p = b64u.enc(utf8(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:dailytasks@localhost' })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, utf8(h + '.' + p)));
  return h + '.' + p + '.' + b64u.enc(sig);
}
async function sendWebPush(title, body, tag, ttl = 86400) {
  const { sub, keys } = await getSubscription();
  if (!sub || !keys) return;
  const payload = JSON.stringify({ title, body, url: './', tag });
  const { record, serverPubRaw } = await encryptPayload(payload, keys);
  const aud = new URL(sub.endpoint).origin;
  const jwt = await makeJWT(aud);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: String(ttl),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: `vapid t=${jwt}, k=${b64u.enc(serverPubRaw)}`,
    },
    body: record,
  });
  if (res.status === 404 || res.status === 410 || res.status === 401 || res.status === 403) {
    // подписка умерла или не принимает наш ключ — переподписка
    const reg = await navigator.serviceWorker.ready;
    const old = await reg.pushManager.getSubscription();
    if (old) await old.unsubscribe();
    state.sub.sub = null; save();
  } else if (!res.ok) {
    throw new Error(`push service: HTTP ${res.status}`);
  }
}
/* ---------- канал 2: Pushover (через скрытую form-POST, обход CORS) ---------- */
function sendPushover(title, message) {
  const u = (state.settings.poUser || '').trim(), t = (state.settings.poToken || '').trim();
  if (!u || !t) throw new Error('Pushover: не указаны ключи');
  const iframe = document.createElement('iframe');
  iframe.name = 'poFrame'; iframe.style.display = 'none';
  document.body.appendChild(iframe);
  const f = document.createElement('form');
  f.method = 'POST'; f.action = 'https://api.pushover.net/1/messages.json'; f.target = 'poFrame';
  f.style.display = 'none';
  [['token', t], ['user', u], ['title', title], ['message', message.slice(0, 1024)], ['url', location.href], ['sound', 'pushover']]
    .forEach(([k, v]) => { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i); });
  document.body.appendChild(f);
  f.submit();
  setTimeout(() => { f.remove(); iframe.remove(); }, 8000);
  toast('Отправлено через Pushover');
}

/* ---------------- настройки ---------------- */
function pushStatus(msg, isErr) {
  const el = $('#pushStatus');
  el.textContent = msg;
  el.style.color = isErr ? 'var(--danger)' : 'var(--muted)';
}
async function refreshPushStatus() {
  const el = $('#pushStatus');
  try {
    if (!('Notification' in window)) { el.textContent = 'Уведомления не поддерживаются браузером.'; return; }
    const parts = [`Разрешение: ${Notification.permission}`];
    if ('serviceWorker' in navigator && 'PushManager' in window) {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      parts.push(sub ? 'подписка активна ✅' : 'подписки нет');
    }
    if (state.settings.channel === 'pushover') {
      parts.push(state.settings.poUser && state.settings.poToken ? 'ключи Pushover заданы ✅' : 'ключи Pushover не заданы');
    }
    el.textContent = parts.join(' · ');
    el.style.color = 'var(--muted)';
  } catch (e) { el.textContent = 'Ошибка проверки: ' + e.message; }
}
async function testPush() {
  try {
    if (!('Notification' in window)) { toast('Уведомления не поддерживаются'); return; }
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission === 'granted') {
      try { new Notification('Мои дела', { body: 'Тест уведомления ✅', icon: './icons/icon-192.png', tag: 'test' }); } catch (e) {}
    }
    const ok = await sendPush('Мои дела', 'Тест пуш-уведомления ✅', 'test');
    if (ok) { toast('Тест отправлен'); refreshPushStatus(); }
    else if (state.settings.channel === 'pushover' && !(state.settings.poUser && state.settings.poToken)) {
      toast('Уведомление показано. Ключи Pushover не заданы — вставь их, если хочешь получать пуши на телефон с ПК');
    }
    else { toast('Отправка не удалась — см. статус ниже'); }
  } catch (e) { toast('Ошибка: ' + e.message); pushStatus('Ошибка: ' + e.message, true); }
}

/* ---------------- экспорт/импорт ---------------- */
function exportData() {
  const blob = new Blob([JSON.stringify({ tasks: state.tasks, settings: state.settings }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `dailytasks-backup-${todayKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Бэкап скачан');
}
function importData(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const d = JSON.parse(rd.result);
      if (!d || typeof d.tasks !== 'object') throw new Error('неверный формат');
      state.tasks = d.tasks; state.missed = {};
      if (d.settings) state.settings = Object.assign({}, state.settings, d.settings);
      save(); renderCalendar(); applySettingsUI(); scheduleReminders();
      toast('Импортировано');
    } catch (e) { toast('Ошибка импорта: ' + e.message); }
  };
  rd.readAsText(file);
}

/* ---------------- тема ---------------- */
function applyTheme() {
  const t = state.settings.theme;
  document.body.classList.toggle('theme-light', t === 'light');
  document.body.classList.toggle('theme-dark', t === 'dark');
}

/* ---------------- init ---------------- */
function applySettingsUI() {
  $('#setPushOn').checked = !!state.settings.pushOn;
  $('#setChannel').value = state.settings.channel;
  $('#setPoUser').value = state.settings.poUser || '';
  $('#setPoToken').value = state.settings.poToken || '';
  $('#setTheme').value = state.settings.theme;
  $('#pushoverWrap').classList.toggle('hidden', state.settings.channel !== 'pushover');
  $('#pushChannelWrap').classList.toggle('hidden', !state.settings.pushOn);
  applyTheme();
}

function bindUI() {
  $('#prevMonth').onclick = () => { view.m--; if (view.m < 0) { view.m = 11; view.y--; } renderCalendar(); };
  $('#nextMonth').onclick = () => { view.m++; if (view.m > 11) { view.m = 0; view.y++; } renderCalendar(); };

  $('#calendar').addEventListener('click', e => {
    const cell = e.target.closest('.day');
    if (!cell) return;
    if (cell.dataset.pm === 'true') {
      const d = fromKey(cell.dataset.date);
      view.y = d.getFullYear(); view.m = d.getMonth();
      renderCalendar();
    }
    openDay(cell.dataset.date);
  });

  $('#addForm').addEventListener('submit', addTask);

  $('#taskList').addEventListener('click', e => {
    const li = e.target.closest('.task'); if (!li) return;
    const id = li.dataset.id;
    const act = e.target.closest('[data-act]');
    if (e.target.type === 'checkbox') { toggleTask(id, e.target.checked); return; }
    if (!act) return;
    if (act.dataset.act === 'del') deleteTask(id);
    else if (act.dataset.act === 'edit') openEdit(id);
    else if (act.dataset.act === 'move') openMove(id);
    else if (act.dataset.act === 'save') saveEdit(id);
    else if (act.dataset.act === 'cancel') { li.querySelector('.task-edit').classList.add('hidden'); }
  });

  $('#moveOk').onclick = doMove;

  $$('[data-close]').forEach(b => b.onclick = closeModals);
  $$('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) closeModals(); }));

  $('#btnSettings').onclick = () => { applySettingsUI(); refreshPushStatus(); $('#settingsModal').classList.remove('hidden'); };
  $('#setPushOn').onchange = e => { state.settings.pushOn = e.target.checked; save(); applySettingsUI(); };
  $('#setChannel').onchange = e => { state.settings.channel = e.target.value; save(); applySettingsUI(); refreshPushStatus(); };
  $('#setPoUser').onchange = e => { state.settings.poUser = e.target.value.trim(); save(); };
  $('#setPoToken').onchange = e => { state.settings.poToken = e.target.value.trim(); save(); };
  $('#setTheme').onchange = e => { state.settings.theme = e.target.value; save(); applyTheme(); };
  $('#btnTestPush').onclick = testPush;
  $('#btnExport').onclick = exportData;
  $('#btnImport').onclick = () => $('#importFile').click();
  $('#importFile').onchange = e => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; };
  $('#btnWipe').onclick = () => {
    if (confirm('Удалить ВСЕ дела и настройки? Это необратимо.')) { localStorage.removeItem(LS_KEY); location.reload(); }
  };
}

function concat(...arrs) {
  const len = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

function init() {
  bindUI();
  applyTheme();
  renderCalendar();
  scheduleReminders();
  checkMissed();
  scheduleSW();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW:', e));
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { renderCalendar(); scheduleReminders(); checkMissed(); scheduleSW(); }
  });
}
init();
