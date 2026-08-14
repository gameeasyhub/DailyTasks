/* Сквозной тест Web Push self-send: реальный Chrome headless + CDP.
   Chrome запускается отдельно с --remote-debugging-port=9223. */
'use strict';
const CDP = 'http://127.0.0.1:9223';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(path) {
  const r = await fetch(CDP + path);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + path);
  return r.json();
}

class Cdp {
  constructor(ws, onEvent) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      } else if (onEvent) {
        onEvent(m);
      }
    };
  }
  static async connect(url, onEvent) {
    const ws = new WebSocket(url);
    await Promise.race([
      new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail ' + url)); }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('ws timeout ' + url)), 10000)),
    ]);
    return new Cdp(ws, onEvent);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function waitTargets(pred, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = await getJSON('/json/list');
      const hit = list.find(pred);
      if (hit) return hit;
    } catch (e) { /* cdp ещё поднимается */ }
    await sleep(500);
  }
  throw new Error('target not found');
}

async function main() {
  // 1) дождаться CDP
  let ver = null;
  for (let i = 0; i < 60; i++) {
    try { ver = await getJSON('/json/version'); break; } catch (e) { await sleep(500); }
  }
  if (!ver) throw new Error('CDP не поднялся на 9223');
  console.log('CDP OK:', ver.Browser);

  // 2) выдать разрешение на уведомления для origin приложения
  const browser = await Cdp.connect(ver.webSocketDebuggerUrl);
  await browser.send('Browser.grantPermissions', {
    origin: 'http://127.0.0.1:8731',
    permissions: ['notifications'],
  });
  console.log('grantPermissions OK');

  // 3) открыть приложение
  const page = await waitTargets(t => t.type === 'page');
  const consoleMsgs = [];
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl, m => {
    if (m.method === 'Runtime.consoleAPICalled' && m.params && (m.params.type === 'warning' || m.params.type === 'error')) {
      consoleMsgs.push(m.params.type + ': ' + m.params.args.map(a => a.value || a.description || '').join(' '));
    }
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8731/index.html' });
  await sleep(3000);
  console.log('page loaded');

  // 3.5) хукаем showNotification в контексте SW, чтобы увидеть реальную доставку пуша
  let cdpSw = null;
  try {
    const sw = await waitTargets(t => t.type === 'service_worker', 20);
    cdpSw = await Cdp.connect(sw.webSocketDebuggerUrl);
    await cdpSw.send('Runtime.evaluate', {
      expression: `(() => { self.__shown = []; const orig = self.registration.showNotification.bind(self.registration); self.registration.showNotification = (t, o) => { self.__shown.push({ title: t, body: o && o.body, tag: o && o.tag }); return orig(t, o); }; return 'hooked'; })()`,
      returnByValue: true,
    });
    console.log('SW showNotification hooked');
  } catch (e) {
    console.log('SW hook failed (продолжаем):', e.message);
  }

  // 4) в странице: хуки + прогон обоих каналов
  const r1 = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      window.__pushLog = [];
      const orig = window.fetch;
      window.fetch = async (...a) => { try { const r = await orig(...a); window.__pushLog.push({ url: String(a[0]).slice(0,90), status: r.status }); return r; } catch(e) { window.__pushLog.push({ url: String(a[0]).slice(0,90), err: e.message }); throw e; } };
      window.__steps = [];
      window.__testDone = false;
      (async () => {
        try {
          let perm = 'n/a';
          try { perm = await Notification.requestPermission(); window.__steps.push('perm=' + perm); } catch(e) { perm = 'err:' + e.message; window.__steps.push('perm err: ' + e.message); }
          window.__perm = perm;
          // канал 1: Pushover (заглушки ключей — проверяем, что POST уходит)
          const s = JSON.parse(localStorage.getItem('dailytasks.v1'));
          s.settings.channel = 'pushover'; s.settings.poUser = 'u_dummy_test'; s.settings.poToken = 'a_dummy_test';
          localStorage.setItem('dailytasks.v1', JSON.stringify(s)); location.reload();
        } catch (e) { window.__testErr = String(e && e.message || e); window.__steps.push('ERR: ' + window.__testErr); window.__testDone = true; }
      })();
      return 'reloading for pushover';
    })()`,
    returnByValue: true,
  });
  console.log('step4:', JSON.stringify(r1.result.value));
  await sleep(3500); // перезагрузка страницы

  // 4.1) pushover-тест на перезагруженной странице
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      window.__steps = [];
      window.__testDone = false;
      (async () => {
        try {
          window.__steps.push('testPush(pushover)');
          await window.testPush();
          window.__steps.push('done');
          window.__iframeSeen = !!document.querySelector('iframe[name=poFrame]');
          window.__err = null;
        } catch (e) { window.__err = String(e && e.message || e); }
        window.__testDone = true;
      })();
    })()`,
    returnByValue: true,
  });
  // ждём завершения pushover-теста
  for (let i = 0; i < 40; i++) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(() => { try { return { done: !!window.__testDone, steps: window.__steps || [], err: window.__err || null, iframeSeen: !!window.__iframeSeen, statusText: document.getElementById('pushStatus') ? document.getElementById('pushStatus').textContent : 'n/a' }; } catch (e) { return { evalErr: String(e) }; } })()`,
      returnByValue: true,
    });
    const v = r.result.value;
    if (v && v.evalErr) { console.log('poll evalErr:', v.evalErr); process.exit(1); }
    if (v && v.done) { console.log('PUSHOVER RESULT:', JSON.stringify(v, null, 2)); break; }
    await sleep(1000);
  }

  // 4.2) webpush-тест (Chrome: ожидаем аккуратный отказ CORS, не краш)
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      window.__steps = [];
      window.__testDone = false;
      window.__pushLog = [];
      const orig = window.fetch;
      window.fetch = async (...a) => { try { const r = await orig(...a); window.__pushLog.push({ url: String(a[0]).slice(0,90), status: r.status }); return r; } catch(e) { window.__pushLog.push({ url: String(a[0]).slice(0,90), err: e.message }); throw e; } };
      (async () => {
        try {
          const s = JSON.parse(localStorage.getItem('dailytasks.v1'));
          s.settings.channel = 'webpush';
          localStorage.setItem('dailytasks.v1', JSON.stringify(s));
          location.reload();
        } catch (e) { window.__testDone = true; }
      })();
    })()`,
    returnByValue: true,
  });
  await sleep(3500);
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      window.__steps = [];
      window.__testDone = false;
      (async () => {
        try {
          window.__steps.push('testPush(webpush)');
          await window.testPush();
          window.__steps.push('done');
          window.__err = null;
        } catch (e) { window.__err = String(e && e.message || e); }
        window.__testDone = true;
      })();
    })()`,
    returnByValue: true,
  });
  let wpResult = null;
  for (let i = 0; i < 40; i++) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(() => { try { const s = JSON.parse(localStorage.getItem('dailytasks.v1') || '{}'); return { done: !!window.__testDone, steps: window.__steps || [], err: window.__err || null, pushLog: window.__pushLog || [], hasSub: !!(s.sub && s.sub.sub), statusText: document.getElementById('pushStatus') ? document.getElementById('pushStatus').textContent : 'n/a' }; } catch (e) { return { evalErr: String(e) }; } })()`,
      returnByValue: true,
    });
    const v = r.result.value;
    if (v && v.evalErr) { console.log('poll evalErr:', v.evalErr); process.exit(1); }
    if (v && v.done) { wpResult = v; console.log('WEBPUSH RESULT:', JSON.stringify(v, null, 2)); break; }
    await sleep(1000);
  }
  if (!wpResult) throw new Error('webpush-тест не завершился');

  // 5) тест SW-будильника: шлём расписание с задержкой 3с, ждём showNotification в SW
  if (cdpSw) {
    await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const reg = await navigator.serviceWorker.ready;
        reg.active.postMessage({ type: 'schedule', items: [{ at: Date.now() + 3000, title: '⏰ SW-будильник', body: 'проверка таймера в service worker', tag: 'test-sw-alarm' }] });
        return 'scheduled';
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    await sleep(6000);
    try {
      const r2 = await cdpSw.send('Runtime.evaluate', {
        expression: `(() => ({ shown: self.__shown || [] }))()`,
        returnByValue: true,
      });
      console.log('SW ALARM TEST:', JSON.stringify(r2.result.value, null, 2));
    } catch (e) {
      console.log('SW alarm read failed:', e.message);
    }
  }

  // 6) проверить, что SW реально показал уведомление (доставка через FCM)
  if (cdpSw) {
    await sleep(3000);
    try {
      const r2 = await cdpSw.send('Runtime.evaluate', {
        expression: `(() => ({ shown: self.__shown || [], url: self.location ? self.location.href : '?' }))()`,
        returnByValue: true,
      });
      console.log('SW SHOWN:', JSON.stringify(r2.result.value, null, 2));
    } catch (e) {
      console.log('SW read failed:', e.message);
    }
  }

  // 7) финальная проверка состояния подписки после отправки
  const r3 = await cdp.send('Runtime.evaluate', {
    expression: `(async () => { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); return { activeSub: !!sub, endpoint: sub ? sub.endpoint.slice(0, 70) : null, swState: reg.active ? reg.active.state : null }; })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('FINAL:', JSON.stringify(r3.result.value));
  process.exit(0);
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
