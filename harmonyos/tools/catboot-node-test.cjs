#!/usr/bin/env node
/* catboot-node-test: 伪 ArkWeb 宿主验证沙盒产物（catboot.js + bundle.js）
 *   - window := globalThis（catboot 的 IIFE 挂载点）
 *   - catHost 桥：fetchBridge 用 node 原生 fetch 实现（对偶 ArkTS 侧实现），
 *     onInjectDone 直接 resolve pending
 *   - 断言：/config 200 + home/category/detail POST 200（与 harness2 结果对拍）
 * 进 ArkWeb 前先跑通这里；CI 上作为 HAP 构建前哨。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const RAW = path.join(__dirname, '..', 'entry', 'src', 'main', 'resources', 'rawfile', 'cat');
const nativeFetch = globalThis.fetch;
const nativeAbort = globalThis.AbortController;
let bridgeCount = 0;

/* setTimeout 在 catboot 装载前是 node 原生（catboot 会 core.setImmediate 覆盖 setImmediate，setTimeout 不动） */
const nodeSetTimeout = globalThis.setTimeout;

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ok ' + name); } else { fail++; console.log('  FAIL ' + name); } }

/* ---------- 伪 ArkWeb 宿主 ---------- */
globalThis.window = globalThis;
function b64Decode(s) { return Buffer.from(String(s), 'base64'); }
function b64Encode(buf) { return Buffer.from(buf).toString('base64'); }

const injectPending = {};
function onInjectDone(id, status, body, errMsg) {
  const p = injectPending[id];
  if (!p) return;
  delete injectPending[id];
  if (errMsg) p.reject(new Error(errMsg));
  else p.resolve({ status, body });
}

/* catHost 桥（ArkTS 侧的对偶） */
globalThis.catHost = {
  log: function (s) { console.log('[cat-host] ' + s); },
  onInjectDone: onInjectDone,
  fetchBridge: function (id, optsJson) {
    bridgeCount++;
    if (bridgeCount <= 10 || bridgeCount % 500 === 0) {
      const o = JSON.parse(optsJson);
      console.log('[bridge #' + bridgeCount + '] ' + (o.method || 'GET') + ' ' + String(o.url).slice(0, 90));
    }
    const opts = JSON.parse(optsJson);
    const controller = new nativeAbort();
    const t = nodeSetTimeout(() => { try { controller.abort(); } catch (e) { } }, 60000);
    /* body 转"真"Uint8Array：shim Buffer 直传原生 fetch（undici）会炸 FastBuffer；
     * ArkTS 桥走 decodeSync→ArrayBuffer→extraData，此转换与真机语义对齐 */
    let reqBody;
    if (opts.body) {
      const raw = b64Decode(opts.body);
      const ab = new ArrayBuffer(raw.length);
      new Uint8Array(ab).set(raw);
      reqBody = new Uint8Array(ab);
    }
    (nativeFetch(opts.url, {
      method: opts.method || 'GET',
      /* 强制 identity：undici 透明解压 + 保留 content-encoding 头会让 axios fork 二次 inflate */
      headers: Object.assign({}, opts.headers, { 'Accept-Encoding': 'identity' }),
      body: reqBody,
      signal: controller.signal,
    }).then(function (resp) {
      clearTimeout(t);
      return resp.arrayBuffer().then(function (ab) {
        const hdrs = {};
        if (resp.headers && typeof resp.headers.forEach === 'function') {
          resp.headers.forEach(function (v, k) { if (typeof v === 'string') hdrs[k] = v; });
        } else if (resp.headers) {
          for (const k of Object.keys(resp.headers)) {
            const v = resp.headers[k];
            if (typeof v === 'string') hdrs[k] = v;
            else if (typeof v === 'number') hdrs[k] = String(v);
          }
        }
        const js = `__catBridgeResolve(${JSON.stringify(String(id))},${JSON.stringify(resp.status)},${JSON.stringify(JSON.stringify(hdrs))},${JSON.stringify(b64Encode(Buffer.from(ab)))},${JSON.stringify('')})`;
        return globalThis.eval(js);
      });
    }, function (err) {
      clearTimeout(t);
      const js = `__catBridgeResolve(${JSON.stringify(String(id))},0,{},${JSON.stringify('')},${JSON.stringify(String(err && err.message || err))})`;
      return globalThis.eval(js);
    })).catch(function (e) {
      console.log('[bridge] resolve error: ' + (e && e.message));
    });
  },
};

/* ---------- 装载产物 ---------- */
const catbootSrc = fs.readFileSync(path.join(RAW, 'catboot.js'), 'utf8');
const bundleSrc = fs.readFileSync(path.join(RAW, 'bundle.js'), 'utf8');

console.log('== catboot.js 装载 ==');
globalThis.eval(catbootSrc);
ok('__catBootState=booted', globalThis.__catBootState === 'booted');
ok('process shim 挂载', typeof globalThis.process === 'object' && typeof globalThis.process.nextTick === 'function');
ok('Buffer shim 挂载', typeof globalThis.Buffer === 'function' || typeof globalThis.Buffer === 'object');
ok('catServerFactory 已定义', typeof globalThis.catServerFactory === 'function');
ok('__catBridgeFetch 已定义', typeof globalThis.__catBridgeFetch === 'function');
ok('require 映射表就绪', (function () { try { return globalThis.require('crypto') === globalThis.require('node:crypto'); } catch (e) { return false; } })());

console.log('== bundle.js 装载 ==');
/* 插桩：包 __catBridgeFetch（shim-http 动态查找 globalThis，包装生效） */
let bridgeFetchCount = 0;
const origBridge = globalThis.__catBridgeFetch;
globalThis.__catBridgeFetch = function (url, init) {
  bridgeFetchCount++;
  if (bridgeFetchCount <= 10 || bridgeFetchCount % 200 === 0) {
    console.log('[bridgeFetch #' + bridgeFetchCount + '] ' + ((init && init.method) || 'GET') + ' ' + String(url).slice(0, 90) + ' bodyLen=' + ((init && init.body) ? String(init.body).length : 0));
  }
  return origBridge(url, init);
};
globalThis.eval(bundleSrc);
ok('__catStart 已暴露', typeof globalThis.__catStart === 'function');

console.log('== 引擎启动 ==');
/* 心跳：内存增速观测（OOM 定位用） */
let heartbeats = 0;
const hb = nodeSetTimeout(function tick() {
  heartbeats++;
  const mu = process.memoryUsage();
  console.log('[hb ' + heartbeats + '] heapUsed=' + Math.round(mu.heapUsed / 1048576) + 'MB bridgeFetch=' + bridgeFetchCount + ' catHostFetch=' + bridgeCount);
  if (heartbeats < 40) nodeSetTimeout(tick, 1000);
}, 1000);
hb.unref && hb.unref();
(async function main() {
  try {
    globalThis.__catStart();
  } catch (e) {
    console.log('FAIL __catStart sync error ' + (e && e.message));
    process.exit(1);
  }
  let ready = false;
  for (let i = 0; i < 300; i++) {
    if (typeof globalThis.__catServerStatus === 'function' && globalThis.__catServerStatus() === 1) { ready = true; break; }
    await new Promise(function (r) { nodeSetTimeout(r, 100); });
  }
  ok('fake server listen（30s 内）', ready);
  if (!ready) { console.log('==== PASS=' + pass + ' FAIL=' + fail); process.exit(1); }

  /* ---------- inject 对拍 ---------- */
  async function inject(url, method, body) {
    const id = 't' + Math.random().toString(36).slice(2);
    const p = new Promise(function (resolve, reject) {
      injectPending[id] = { resolve, reject };
    });
    globalThis.eval(`__catInject(${JSON.stringify(id)},${JSON.stringify(method)},${JSON.stringify(url)},${JSON.stringify(body)})`);
    return await p;
  }

  const cfg = await inject('/config', 'GET', '');
  ok('/config 200', cfg.status === 200);
  const cfgJson = JSON.parse(cfg.body);
  const siteCount = (cfgJson.video && cfgJson.video.sites) ? cfgJson.video.sites.length : 0;
  ok('/config 站点数 > 90（96 站基线）', siteCount >= 90);

  const home = await inject('/spider/rebo/3/home', 'POST', '{}');
  ok('/home 200', home.status === 200);
  ok('/home 16161B 基线', home.body.length === 16161 || home.body.length > 15000);

  const cat = await inject('/spider/rebo/3/category', 'POST', '{"id":"1","page":1}');
  ok('/category 200', cat.status === 200);
  ok('/category 2246B 基线', cat.body.length === 2246 || cat.body.length > 1800);

  const det = await inject('/spider/rebo/3/detail', 'POST', '{"id":75674}');
  ok('/detail 200', det.status === 200);
  ok('/detail 957B 基线', det.body.length === 957 || det.body.length > 700);

  /* play：真实集 URL 解析（外站依赖，失败仅提示不失败） */
  try {
    const detailJson = JSON.parse(det.body);
    const firstVod = detailJson.list && detailJson.list[0];
    const segs = firstVod && firstVod.vod_play_url ? firstVod.vod_play_url.split('$$$') : [];
    let epUrl = '';
    if (segs.length > 0) {
      const body = segs[0].includes('$') ? segs[0].substring(segs[0].indexOf('$') + 1) : segs[0];
      const parts = body.split('#');
      if (parts.length > 0) {
        const seg = parts[0].trim();
        epUrl = seg.lastIndexOf('$') >= 0 ? seg.substring(seg.lastIndexOf('$') + 1) : seg;
      }
    }
    if (epUrl !== '') {
      const play = await inject('/spider/rebo/3/play', 'POST', JSON.stringify({ id: epUrl }));
      console.log('  [info] /play ' + play.status + ' len=' + play.body.length + ' ' + play.body.slice(0, 80));
    }
  } catch (e) {
    console.log('  [info] /play 跳过 ' + (e && e.message).slice(0, 80));
  }

  console.log('');
  console.log('==== catboot-node-test: PASS=' + pass + ' FAIL=' + fail);
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  const st = (e && e.stack || '').split('\n').filter(function (l) { return l.length < 300; }).slice(0, 10).join('\n');
  console.error('FATAL ' + (e && e.message || e) + '\n' + st);
  process.exit(1);
});
