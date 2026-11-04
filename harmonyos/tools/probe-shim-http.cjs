'use strict';
/* probe-shim-http: 只装 catboot（无 bundle），用 shim-http + 桥最小复现外站 GET */
globalThis.window = globalThis;
const fs = require('fs');
const path = require('path');
const RAW = path.join('D:', 'eclipse-workspace', 'yunying', 'harmonyos', 'entry', 'src', 'main', 'resources', 'rawfile', 'cat');
const catbootSrc = fs.readFileSync(path.join(RAW, 'catboot.js'), 'utf8');

const nodeSetTimeout = globalThis.setTimeout;
const nativeFetch = globalThis.fetch;
const nativeAbort = globalThis.AbortController;
function b64Decode(s) { return Buffer.from(String(s), 'base64'); }
function b64Encode(buf) { return Buffer.from(buf).toString('base64'); }

globalThis.catHost = {
  log: function (s) { console.log('[cat-host] ' + s); },
  onInjectDone: function () { },
  fetchBridge: function (id, optsJson) {
    const opts = JSON.parse(optsJson);
    console.log('[bridge] ->', opts.method, opts.url, 'headers=', JSON.stringify(opts.headers));
    const controller = new nativeAbort();
    const t = nodeSetTimeout(() => { try { controller.abort(); } catch (e) { } }, 60000);
    /* body 转"真"Uint8Array（shim Buffer 直传 undici 炸 FastBuffer） */
    let reqBody;
    if (opts.body) {
      const raw = b64Decode(opts.body);
      const ab = new ArrayBuffer(raw.length);
      new Uint8Array(ab).set(raw);
      reqBody = new Uint8Array(ab);
    }
    nativeFetch(opts.url, {
      method: opts.method || 'GET',
      /* 强制 identity：undici 透明解压 + 保留 content-encoding 头会让 axios fork 二次 inflate */
      headers: Object.assign({}, opts.headers, { 'Accept-Encoding': 'identity' }),
      body: reqBody,
      signal: controller.signal,
    }).then(function (resp) {
      clearTimeout(t);
      return resp.arrayBuffer().then(function (ab) {
        const hdrs = {};
        resp.headers.forEach(function (v, k) { if (typeof v === 'string') hdrs[k] = v; });
        const js = `__catBridgeResolve(${JSON.stringify(String(id))},${JSON.stringify(resp.status)},${JSON.stringify(JSON.stringify(hdrs))},${JSON.stringify(b64Encode(Buffer.from(ab)))},${JSON.stringify('')})`;
        return globalThis.eval(js);
      });
    }, function (err) {
      clearTimeout(t);
      console.log('[bridge] native fetch err:', err && err.message);
      if (err && err.cause && err.cause.stack) {
        console.log('[bridge] cause stack:\n' + String(err.cause.stack).split('\n').slice(0, 12).join('\n'));
      }
      const js = `__catBridgeResolve(${JSON.stringify(String(id))},0,{},${JSON.stringify('')},${JSON.stringify(String(err && err.message || err))})`;
      return globalThis.eval(js);
    }).catch(function (e) { console.log('[bridge] resolve err:', e && e.message); });
  },
};

globalThis.eval(catbootSrc);
console.log('[probe] catboot loaded');

/* 60s 全局看门狗（防 OOM 卡死终端） */
const watchdog = nodeSetTimeout(function () {
  console.log('[probe] WATCHDOG 60s exit —— 桥链路挂起或死循环');
  process.exit(2);
}, 60000);
watchdog.unref && watchdog.unref();

const httpMod = globalThis.require('http');
console.log('[probe] start GET');
const started = Date.now();
const req = httpMod.get('http://upload.baicanuc.cn/ossfiles/1768320816/api.txt', function (res) {
  console.log('[probe] response statusCode=', res.statusCode, 'ms=', Date.now() - started);
  const chunks = [];
  let n = 0;
  res.on('data', function (c) { n++; chunks.push(Buffer.from(c)); if (n < 5) console.log('[probe] data chunk', n, 'len=', c && c.length, c && c.constructor && c.constructor.name); });
  res.on('end', function () {
    console.log('[probe] end after', n, 'chunks; total=', Buffer.concat(chunks).length);
    console.log('[probe] body head=', JSON.stringify(Buffer.concat(chunks).toString('utf8').slice(0, 50)));
    process.exit(0);
  });
  res.on('error', function (e) { console.log('[probe] res error:', e.message); process.exit(1); });
});
req.on('error', function (e) { console.log('[probe] req error:', e.message); process.exit(1); });
