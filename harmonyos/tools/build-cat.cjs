#!/usr/bin/env node
/* build-cat: 生成 ArkWeb 沙盒产物（纯 node，无 npm 依赖）
 *
 * 输入  tools/catshim/*.js      —— shim 全套 + pako + 唐三 bundle 源（index.js）
 * 输出  entry/src/main/resources/rawfile/cat/
 *   cat.html   —— 极小 loader（__catFeed 分块收集 + __catBoot eval）
 *   catboot.js —— mini CJS 装载器 + shim 工厂表 + bundle 运行面（对齐 harness2.cjs）
 *                 + fake server + 双向桥（__catBridgeFetch / __catInject）
 *   bundle.js  —— 结构 patch 后的引擎包（注入 globalThis.__catStart）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'catshim');
const OUT = path.join(__dirname, '..', 'entry', 'src', 'main', 'resources', 'rawfile', 'cat');

/* shim 注册键（裸名；工厂体内 require('./xxx.js') 由装载器规范化解析） */
const SHIM_KEYS = [
  'shim-core', 'shim-buffer', 'hash-constants', 'shim-hash', 'shim-cipher',
  'shim-crypto', 'shim-util', 'shim-path', 'shim-os', 'shim-stream',
  'shim-fs', 'shim-zlib', 'shim-http', 'shim-stubs', 'pako.min',
];
const SHIM_FILES = {
  'shim-core': 'shim-core.js',
  'shim-buffer': 'shim-buffer.js',
  'hash-constants': 'hash-constants.js',
  'shim-hash': 'shim-hash.js',
  'shim-cipher': 'shim-cipher.js',
  'shim-crypto': 'shim-crypto.js',
  'shim-util': 'shim-util.js',
  'shim-path': 'shim-path.js',
  'shim-os': 'shim-os.js',
  'shim-stream': 'shim-stream.js',
  'shim-fs': 'shim-fs.js',
  'shim-zlib': 'shim-zlib.js',
  'shim-http': 'shim-http.js',
  'shim-stubs': 'shim-stubs.js',
  'pako.min': 'pako.min.js',
};

function readShim(key) {
  const p = path.join(SRC, SHIM_FILES[key]);
  const s = fs.readFileSync(p, 'utf8');
  if (s.length === 0) throw new Error('空文件: ' + SHIM_FILES[key]);
  return s;
}

/* ---------- bundle 结构 patch：定位 BOOT_ANCHOR，注入 __catStart ----------
 * minified 名随构建变化（aSr/Het 已失效过一轮），只依赖结构特征：
 *   X()&&Y().catch(e=>{console.error(e),process.exit(1)});
 * 其中 Y 即启动函数 Het。
 */
function patchBundle(src) {
  const re = /([A-Za-z_$][\w$]*)\(\)&&([A-Za-z_$][\w$]*)\(\)\.catch\(\s*function\s*\(\s*\w+\s*\)\s*\{console\.error\(\w+\),process\.exit\(1\)\}\s*\)\s*;|([A-Za-z_$][\w$]*)\(\)&&([A-Za-z_$][\w$]*)\(\)\.catch\(\s*\w+\s*=>\s*\{console\.error\(\w+\),process\.exit\(1\)\}\s*\)\s*;/;
  const m = src.match(re);
  if (!m) {
    throw new Error('BOOT_ANCHOR 未匹配：bundle 启动结构变化，需人工定位（grep "process.exit(1)" 收敛到 && .catch 结构）');
  }
  const bootFn = m[2] || m[4];
  const anchor = m[0];
  return src.replace(anchor, 'globalThis.__catStart=' + bootFn + ';' + anchor);
}

/* ---------- catboot.js 组装 ---------- */
function buildCatboot(bundleSrc) {
  const parts = [];
  parts.push('/* catboot: ArkWeb 沙盒引导（build-cat.cjs 生成，勿手改）');
  parts.push(' * mini CJS 装载器 + shim 工厂表 + bundle 运行面（对齐 harness2.cjs ctx）');
  parts.push(' * + fake server + 双向桥（__catBridgeFetch / __catInject）');
  parts.push(' */');
  parts.push('(function (global) {');
  parts.push("'use strict';");
  parts.push('var __f = {};');
  parts.push('var __cache = {};');
  parts.push('function __norm(n) { return String(n).replace(/^\\.\\//, ""); }');
  parts.push('function __req(name) {');
  parts.push('  var n = __norm(name);');
  parts.push('  var key = Object.prototype.hasOwnProperty.call(__f, n) ? n : (Object.prototype.hasOwnProperty.call(__f, n.replace(/\\.js$/, "")) ? n.replace(/\\.js$/, "") : null);');
  parts.push('  if (key === null) throw new Error("[catboot] 未知模块: " + name);');
  parts.push('  if (key in __cache) return __cache[key].exports;');
  parts.push('  var m = { exports: {} };');
  parts.push('  __cache[key] = m;');
  parts.push('  __f[key].call(m.exports, m, m.exports, __req);');
  parts.push('  return m.exports;');
  parts.push('}');

  /* shim 工厂：源码原文内联（工厂体自带 'use strict' 者自动严格化） */
  for (const key of SHIM_KEYS) {
    const src = readShim(key);
    parts.push('');
    parts.push('/* ===== ' + SHIM_FILES[key] + ' ===== */');
    parts.push("__f['" + key + "'] = function (module, exports, require) {");
    parts.push(src);
    parts.push('};');
  }

  parts.push('');
  parts.push('/* ===== 装载 shim ===== */');
  parts.push("var core = __req('shim-core');");
  parts.push("var U8 = __req('shim-buffer');");
  parts.push("var shimCrypto = __req('shim-crypto');");
  parts.push("var shimUtil = __req('shim-util');");
  parts.push("var shimPath = __req('shim-path');");
  parts.push("var shimOs = __req('shim-os');");
  parts.push("var shimStream = __req('shim-stream');");
  parts.push("var shimFs = __req('shim-fs');");
  parts.push("var shimZlib = __req('shim-zlib');");
  parts.push("var shimHttp = __req('shim-http');");
  parts.push("var stubs = __req('shim-stubs');");

  parts.push('');
  parts.push('/* ===== bundle 运行面（对齐 harness2 ctx） ===== */');
  parts.push('global.process = core.process;');
  parts.push('global.Buffer = U8;');
  parts.push('global.setImmediate = core.setImmediate;');
  parts.push('global.clearImmediate = core.clearImmediate;');
  parts.push('/* bundle 顶层 module.exports（入口导出 start/stop）：harness2 ctx 同款 */');
  parts.push('global.module = { exports: {} };');
  parts.push('global.exports = global.module.exports;');
  parts.push('/* 藏 fetch：axios 探测到 fetch 走 fetch 适配器 → ArkWeb CORS 必炸；强制 http 适配器 → __catBridgeFetch */');
  parts.push('try { global.fetch = undefined; } catch (e) { }');
  parts.push('global.Buffer.INSPECT_MAX_BYTES = 50;');

  parts.push('');
  parts.push('/* ===== bundle 的 external require 映射表 ===== */');
  parts.push('var reg = {');
  parts.push("  'events': core.events, 'node:events': core.events,");
  parts.push("  'process': core.process, 'node:process': core.process,");
  parts.push("  'timers': core.timers, 'node:timers': core.timers,");
  parts.push("  'timers/promises': stubs.timersPromises, 'node:timers/promises': stubs.timersPromises,");
  parts.push("  'buffer': U8, 'node:buffer': U8,");
  parts.push("  'crypto': shimCrypto, 'node:crypto': shimCrypto,");
  parts.push("  'util': shimUtil.util, 'node:util': shimUtil.util,");
  parts.push("  'assert': shimUtil.assert, 'node:assert': shimUtil.assert, 'assert/strict': shimUtil.assert.strict,");
  parts.push("  'path': shimPath, 'node:path': shimPath,");
  parts.push("  'os': shimOs, 'node:os': shimOs,");
  parts.push("  'stream': shimStream, 'node:stream': shimStream,");
  parts.push("  'stream/web': {}, 'node:stream/web': {},");
  parts.push("  'fs': shimFs, 'node:fs': shimFs,");
  parts.push("  'fs/promises': shimFs.promises, 'node:fs/promises': shimFs.promises,");
  parts.push("  'zlib': shimZlib, 'node:zlib': shimZlib,");
  parts.push("  'http': shimHttp.http, 'node:http': shimHttp.http,");
  parts.push("  'https': shimHttp.https, 'node:https': shimHttp.https,");
  parts.push("  'url': stubs.url, 'node:url': stubs.url,");
  parts.push("  'querystring': stubs.querystring, 'node:querystring': stubs.querystring,");
  parts.push("  'string_decoder': { StringDecoder: stubs.StringDecoder }, 'node:string_decoder': { StringDecoder: stubs.StringDecoder },");
  parts.push("  'dns': stubs.dns, 'node:dns': stubs.dns, 'dns/promises': stubs.dns.promises,");
  parts.push("  'net': stubs.net, 'node:net': stubs.net,");
  parts.push("  'tls': stubs.tls, 'node:tls': stubs.tls,");
  parts.push("  'http2': stubs.http2, 'node:http2': stubs.http2,");
  parts.push("  'tty': stubs.tty, 'node:tty': stubs.tty,");
  parts.push("  'worker_threads': stubs.worker_threads, 'node:worker_threads': stubs.worker_threads,");
  parts.push("  'async_hooks': stubs.async_hooks, 'node:async_hooks': stubs.async_hooks,");
  parts.push("  'diagnostics_channel': stubs.diagnostics_channel, 'node:diagnostics_channel': stubs.diagnostics_channel,");
  parts.push("  'perf_hooks': stubs.perf_hooks, 'node:perf_hooks': stubs.perf_hooks,");
  parts.push("  'module': stubs.module, 'node:module': stubs.module");
  parts.push('};');
  parts.push('global.require = function (name) {');
  parts.push('  if (name in reg) return reg[name];');
  parts.push('  throw new Error("[catboot] 未知模块: " + name);');
  parts.push('};');

  parts.push('');
  parts.push('/* ===== fake server（对齐 harness2 Request2/Response2/FakeServer；stream 用 shim-stream） ===== */');
  parts.push('var EE = core.EE;');
  parts.push('function toU8(c) { return c instanceof Uint8Array ? c : new TextEncoder().encode(String(c)); }');
  parts.push('function FakeRequest(url, method, headers, body) {');
  parts.push('  var r = new shimStream.Readable();');
  parts.push('  r.url = url; r.method = method; r.headers = headers || {};');
  parts.push("  r.httpVersion = '1.1'; r.rawHeaders = [];");
  parts.push("  r.socket = { remoteAddress: '127.0.0.1', remotePort: 0 };");
  parts.push('  if (body) r.push(body);');
  parts.push('  r.push(null);');
  parts.push('  return r;');
  parts.push('}');
  parts.push('function FakeResponse(ondone) {');
  parts.push('  var w = new shimStream.Writable();');
  parts.push('  w.statusCode = 200; w.headers = {}; w.chunks = [];');
  parts.push('  w.ondone = ondone; w.finished2 = false; w._headersSent = false;');
  parts.push('  w.getHeader = function (name) { return this.headers[String(name).toLowerCase()]; };');
  parts.push('  w.setHeader = function (name, value) { this.headers[String(name).toLowerCase()] = value; };');
  parts.push('  w.hasHeader = function (name) { return this.headers[String(name).toLowerCase()] !== undefined; };');
  parts.push('  w.appendHeader = function (name, value) {');
  parts.push('    var k = String(name).toLowerCase();');
  parts.push('    var cur = this.headers[k];');
  parts.push('    if (cur === undefined) this.headers[k] = value;');
  parts.push('    else if (Array.isArray(cur)) cur.push(value);');
  parts.push('    else this.headers[k] = [cur, value];');
  parts.push('  };');
  parts.push('  w.removeHeader = function (name) { delete this.headers[String(name).toLowerCase()]; };');
  parts.push("  Object.defineProperty(w, 'headersSent', { get: function () { return w._headersSent === true; } });");
  parts.push('  w.writeHead = function (status, headers) {');
  parts.push('    this.statusCode = status;');
  parts.push('    this._headersSent = true;');
  parts.push('    if (headers) for (var k in headers) this.headers[String(k).toLowerCase()] = headers[k];');
  parts.push('    return this;');
  parts.push('  };');
  parts.push('  w._write = function (chunk, enc, cb) { w.chunks.push(toU8(chunk)); cb(); };');
  parts.push('  w.end = function (chunk) {');
  parts.push('    if (chunk !== undefined && chunk !== null) w.chunks.push(toU8(chunk));');
  parts.push('    if (w.finished2) return;');
  parts.push('    w.finished2 = true;');
  parts.push('    try { shimStream.Writable.prototype.end.call(w); } catch (e) { }');
  parts.push('    /* 采样延后：shim-stream write 是微任务异步 _write，handler 里 write(); end() 序列下');
  parts.push('     * 同步采样会拿到空集（/config 空体根因）。宏任务时机（微任务排空后）再 concat */');
  parts.push('    setImmediate(function () {');
  parts.push('      var payload = Buffer.concat(w.chunks);');
  parts.push('      var text = "";');
  parts.push("      try { text = payload.toString('utf8'); } catch (e2) { text = String(payload); }");
  parts.push('      ondone(w.statusCode, w.headers, text);');
  parts.push('    });');
  parts.push('  };');
  parts.push('  return w;');
  parts.push('}');
  parts.push('function FakeServer() { EE.call(this); this.listened = false; this.port = 9988; }');
  parts.push('FakeServer.prototype = Object.create(EE.prototype);');
  parts.push('FakeServer.prototype.constructor = FakeServer;');
  parts.push('FakeServer.prototype.listen = function (opts, cb) {');
  parts.push('  this.listened = true;');
  parts.push('  this.port = typeof opts === "number" ? opts : (opts && opts.port);');
  parts.push('  var self = this;');
  parts.push('  setImmediate(function () { if (cb) cb(); self.emit("listening"); });');
  parts.push('  return this;');
  parts.push('};');
  parts.push("FakeServer.prototype.address = function () { return { port: this.port || 9988, address: '127.0.0.1', family: 'IPv4' }; };");
  parts.push('FakeServer.prototype.close = function (cb) { if (cb) setImmediate(cb); return this; };');
  parts.push('FakeServer.prototype.inject = function (url, o) {');
  parts.push('  var opts = o || {};');
  parts.push("  var method = opts.method || 'GET';");
  parts.push('  var body = opts.body || null;');
  parts.push('  var headers = Object.assign({ "content-type": "application/json" }, opts.headers || {});');
  parts.push('  var self = this;');
  parts.push('  return new Promise(function (resolve, reject) {');
  parts.push('    var req = new FakeRequest(url, method, headers, body);');
  parts.push('    var res = new FakeResponse(function (status, resHeaders, text) {');
  parts.push('      resolve({ status: status, headers: resHeaders, body: text });');
  parts.push('    });');
  parts.push('    try { self.emit("request", req, res); } catch (e) { reject(e); }');
  parts.push('  });');
  parts.push('};');
  parts.push('var fakeServerRef = null;');
  parts.push('global.catServerFactory = function (handler, opts) {');
  parts.push('  fakeServerRef = new FakeServer();');
  parts.push('  fakeServerRef.on("request", handler);');
  parts.push('  return fakeServerRef;');
  parts.push('};');
  parts.push('/* ArkTS 轮询探针：fake server 是否已 listen */');
  parts.push('global.__catServerStatus = function () { return (fakeServerRef !== null && fakeServerRef.listened) ? 1 : 0; };');

  parts.push('');
  parts.push('/* ===== 双向桥 ===== */');
  parts.push('/* U8 → base64（分块 fromCharCode + btoa） */');
  parts.push('function u8ToB64(u8) {');
  parts.push('  var CH = 0x8000; var parts = [];');
  parts.push('  for (var i = 0; i < u8.length; i += CH) {');
  parts.push('    parts.push(String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length))));');
  parts.push('  }');
  parts.push('  return global.btoa(parts.join(""));');
  parts.push('}');
  parts.push('/* 沙盒 → ArkTS：fetch 桥（shim-http 契约：resolve {status, headers, body: Promise<b64>}） */');
  parts.push('var bridgeSeq = 0;');
  parts.push('var bridgePending = {};');
  parts.push('global.__catBridgeFetch = function (url, init) {');
  parts.push('  return new Promise(function (resolve, reject) {');
  parts.push('    var id = ++bridgeSeq;');
  parts.push('    bridgePending[id] = { resolve: resolve, reject: reject };');
  parts.push('    var body = (init && init.body) ? init.body : "";');
  parts.push('    var bodyB64 = "";');
  parts.push('    try {');
  parts.push('      if (body instanceof Uint8Array) bodyB64 = u8ToB64(body);');
  parts.push('      else if (typeof body === "string" && body.length > 0) bodyB64 = u8ToB64(new TextEncoder().encode(body));');
  parts.push('    } catch (e) { }');
  parts.push('    var opts = {');
  parts.push('      url: String(url),');
  parts.push('      method: (init && init.method) ? String(init.method).toUpperCase() : "GET",');
  parts.push('      headers: (init && init.headers) ? init.headers : {},');
  parts.push('      body: bodyB64');
  parts.push('    };');
  parts.push('    try { global.catHost.fetchBridge(String(id), JSON.stringify(opts)); }');
  parts.push('    catch (e) { delete bridgePending[id]; reject(new Error("[catboot] bridge down: " + (e && e.message || e))); }');
  parts.push('  });');
  parts.push('};');
  parts.push('global.__catBridgeResolve = function (id, status, headersJson, b64body, errMsg) {');
  parts.push('  var p = bridgePending[id];');
  parts.push('  if (!p) return;');
  parts.push('  delete bridgePending[id];');
  parts.push('  if (errMsg) { p.reject(new Error(errMsg)); return; }');
  parts.push('  var headers = {};');
  parts.push('  try { headers = JSON.parse(headersJson || "{}"); } catch (e) { }');
  parts.push('  p.resolve({ status: status, headers: headers, body: Promise.resolve(b64body || "") });');
  parts.push('};');
  parts.push('/* ArkTS → 沙盒：inject 面（VodClient Cat 协议请求） */');
  parts.push('global.__catInject = function (id, method, url, body) {');
  parts.push('  var sv = fakeServerRef;');
  parts.push('  if (!sv || !sv.listened) {');
  parts.push('    try { global.catHost.onInjectDone(String(id), 503, "", "sandbox not ready"); } catch (e) { }');
  parts.push('    return;');
  parts.push('  }');
  parts.push('  sv.inject(url, { method: method, body: body === "" ? null : body }).then(function (r) {');
  parts.push('    try { global.catHost.onInjectDone(String(id), r.status, r.body, ""); } catch (e) { }');
  parts.push('  }, function (e) {');
  parts.push('    try { global.catHost.onInjectDone(String(id), 500, "", String(e && e.message || e)); } catch (e2) { }');
  parts.push('  });');
  parts.push('};');
  parts.push('/* 沙盒日志出口（ArkWeb 里 console 走 webview debuggable 日志） */');
  parts.push('global.__catLog = function (s) { try { global.catHost.log(String(s)); } catch (e) { } };');
  parts.push('global.__catBootState = "booted";');
  parts.push('})(window);');

  const js = parts.join('\n');
  /* 语法自检（node 能解析） */
  new Function(js);
  return js;
}

/* ---------- cat.html ---------- */
const CAT_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>cat</title>
<script>
window.__catChunks = [];
window.__catFeed = function (c) { window.__catChunks.push(String(c)); };
window.__catBoot = function () {
  var src = window.__catChunks.join('');
  window.__catChunks = [];
  (0, eval)(src);
  return 'booted';
};
</script>
</head>
<body>CAT</body>
</html>
`;

/* ---------- main ---------- */
function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const indexSrc = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');
  const bundleSrc = patchBundle(indexSrc);
  if (bundleSrc.indexOf('globalThis.__catStart') < 0) throw new Error('patch 未生效');
  console.log('bundle.js: patched, ' + (bundleSrc.length / 1024).toFixed(1) + 'KB');

  const catboot = buildCatboot();
  fs.writeFileSync(path.join(OUT, 'cat.html'), CAT_HTML);
  fs.writeFileSync(path.join(OUT, 'catboot.js'), catboot);
  fs.writeFileSync(path.join(OUT, 'bundle.js'), bundleSrc);
  console.log('catboot.js: ' + (catboot.length / 1024).toFixed(1) + 'KB');
  console.log('cat.html: ' + CAT_HTML.length + 'B');
  console.log('OK → ' + OUT);
}

main();
