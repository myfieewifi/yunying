/* shim-core: events + process + timers（沙盒 require('events'/'process'/'timers') 映射层，纯 JS 无 node 依赖） */
'use strict';

/* ---------------- EventEmitter（node 语义：error 无监听抛出；once 可用原函数引用移除） ---------------- */
function safeLogError(e) {
  try { (console.__real || console).error && console.error('[shim] EE handler error', (e && (e.message || e)) || e); } catch (e2) { }
}
function EE() { this._ev = this._ev || {}; }
/* pino 用 Object.create(EE.prototype) 造 logger（构造函数没跑）：
 * 所有方法必须对 _ev 缺失宽容 —— 与 node EE.emit 对 _events === undefined 的行为一致 */
function evOf(self) { return self._ev || (self._ev = {}); }
EE.prototype.on = function (t, f) { (evOf(this)[t] = evOf(this)[t] || []).push(f); return this; };
EE.prototype.addListener = EE.prototype.on;
EE.prototype.prependListener = function (t, f) { (evOf(this)[t] = evOf(this)[t] || []).unshift(f); return this; };
EE.prototype.once = function (t, f) {
  var self = this;
  function g() { self.off(t, g); f.apply(self, arguments); }
  g._orig = f;
  return self.on(t, g);
};
EE.prototype.prependOnceListener = function (t, f) {
  var self = this;
  function g() { self.off(t, g); f.apply(self, arguments); }
  g._orig = f;
  return self.prependListener(t, g);
};
EE.prototype.off = function (t, f) {
  var a = evOf(this)[t]; if (!a) return this;
  for (var i = 0; i < a.length; i++) if (a[i] === f || a[i]._orig === f) { a.splice(i, 1); break; }
  return this;
};
EE.prototype.removeListener = EE.prototype.off;
EE.prototype.removeAllListeners = function (t) { if (t) delete evOf(this)[t]; else this._ev = {}; return this; };
EE.prototype.emit = function (t) {
  var a = evOf(this)[t];
  if (!a || a.length === 0) {
    if (t === 'error') {
      var ex = arguments[1];
      if (ex instanceof Error) throw ex;
      throw new Error("Unhandled 'error' event: " + ex);
    }
    return false;
  }
  var args = Array.prototype.slice.call(arguments, 1);
  var ls = a.slice();
  for (var i = 0; i < ls.length; i++) { try { ls[i].apply(this, args); } catch (e) { safeLogError(e); } }
  return true;
};
EE.prototype.listenerCount = function (t) { return (this._ev && this._ev[t] || []).length; };
EE.prototype.setMaxListeners = function () { return this; };
EE.prototype.getMaxListeners = function () { return EE.defaultMaxListeners; };
EE.prototype.eventNames = function () { return this._ev ? Object.keys(this._ev) : []; };
EE.prototype.listeners = function (t) { return ((this._ev && this._ev[t]) || []).map(function (f) { return f._orig || f; }); };
EE.prototype.rawListeners = EE.prototype.listeners;
EE.EventEmitter = EE;
EE.defaultMaxListeners = 100;

/* node:events 模块面 */
function eventsOnce(emitter, name) {
  return new Promise(function (resolve, reject) {
    function onEvent() { emitter.off(name, onEvent); resolve(Array.prototype.slice.call(arguments)); }
    emitter.on(name, onEvent);
    emitter.once('error', function (e) { reject(e); });
  });
}
var eventsModule = {
  EventEmitter: EE,
  defaultMaxListeners: 100,
  once: eventsOnce,
  listenerCount: function (emitter, t) { return emitter.listenerCount ? emitter.listenerCount(t) : 0; },
};

/* ---------------- timers（宿主原生优先；无 setImmediate 的宿主用 setTimeout(0)） ----------------
 * 引用必须装载时捕获：catboot 会把 global.setImmediate/clearImmediate 覆盖为 shim 自身，
 * 运行时 typeof 探测会解析到 shim 自己 → 无限自递归（RangeError → 上层 catch 重试 → OOM） */
var hostSetTimeout = typeof setTimeout === 'function' ? setTimeout : null;
var hostClearTimeout = typeof clearTimeout === 'function' ? clearTimeout : null;
var hostSetInterval = typeof setInterval === 'function' ? setInterval : null;
var hostClearInterval = typeof clearInterval === 'function' ? clearInterval : null;
var hostSetImmediate = typeof setImmediate === 'function' ? setImmediate : null;
var hostClearImmediate = typeof clearImmediate === 'function' ? clearImmediate : null;
if (hostSetTimeout === null || hostClearTimeout === null) {
  throw new Error('shim-core: host setTimeout/clearTimeout required');
}
function shimSetImmediate(fn) {
  var a = Array.prototype.slice.call(arguments, 1);
  return hostSetTimeout(function () { fn.apply(null, a); }, 0);
}
var immediateImpl = hostSetImmediate
  ? function (fn) { return hostSetImmediate(fn); }
  : shimSetImmediate;
var clearImmediateImpl = hostClearImmediate
  ? function (id) { return hostClearImmediate(id); }
  : function (id) { if (hostClearTimeout) hostClearTimeout(id); };
var timersModule = {
  setTimeout: function (fn, ms) { return hostSetTimeout.apply(null, arguments); },
  clearTimeout: function (id) { return hostClearTimeout(id); },
  setInterval: function (fn, ms) { return hostSetInterval.apply(null, arguments); },
  clearInterval: function (id) { return hostClearInterval(id); },
  setImmediate: function (fn) { return immediateImpl.apply(null, arguments); },
  clearImmediate: clearImmediateImpl,
};
/* 宿主没有 setImmediate 时补全局（沙盒 ArkWeb 无 setImmediate） */
if (!hostSetImmediate) {
  globalThis.setImmediate = timersModule.setImmediate;
  globalThis.clearImmediate = timersModule.clearImmediate;
}

/* ---------------- process（EE 实例 + 常用字段；stdout/stderr 转发 console） ---------------- */
function makeProcess() {
  var p = new EE();
  var hrStart = Date.now();
  var hrBase = typeof performance !== 'undefined' && performance.now ? performance.now() : 0;
  p.env = {};
  p.argv = ['node', '/index.js'];
  p.argv0 = 'node';
  p.execPath = '/usr/bin/node';
  p.execArgv = [];
  p.pid = 10000;
  p.ppid = 1;
  p.exitCode = null;
  p.version = 'v20.13.1';
  p.versions = { node: '20.13.1', v8: '11.3.244.8', http_parser: '6.0', icu: '73.1' };
  p.platform = 'harmony';
  p.arch = 'arm64';
  p.connected = false;
  p.features = { inspector: false };
  p.binding = function () { throw new Error('process.binding is not supported'); };
  p.cwd = function () { return '/'; };
  p.chdir = function () { };
  p.exit = function (code) {
    if (code !== undefined) p.exitCode = code;
    try { console.error('__bridge__exit ' + code); } catch (e) { }
  };
  p.kill = function () { return true; };
  p.hrtime = function (prev) {
    var now = Date.now();
    var ms = now - hrStart;
    var r = [Math.floor(ms / 1000), Math.floor((ms % 1000) * 1e6)];
    if (prev) {
      var d = [r[0] - prev[0], r[1] - prev[1]];
      if (d[1] < 0) { d[0] -= 1; d[1] += 1e9; }
      return d;
    }
    return r;
  };
  p.hrtime.bigint = function () { return BigInt(Math.floor(((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - hrBase) * 1e6)); };
  p.nextTick = function (fn) { var a = Array.prototype.slice.call(arguments, 1); return Promise.resolve().then(function () { fn.apply(null, a); }); };
  p.uptime = function () { return Math.floor((Date.now() - hrStart) / 1000); };
  p.memoryUsage = function () { return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }; };
  p.cpuUsage = function () { return { user: 0, system: 0 }; };
  p.stdout = { write: function (s) { try { console.log(String(s).replace(/\n$/, '')); } catch (e) { } return true; }, on: function () { return this; }, isTTY: false, columns: 80, rows: 24 };
  p.stderr = { write: function (s) { try { console.error(String(s).replace(/\n$/, '')); } catch (e) { } return true; }, on: function () { return this; }, isTTY: false };
  p.stdin = { on: function () { return this; }, resume: function () { }, pause: function () { }, isTTY: false };
  p.abort = function () { throw new Error('process.abort is not supported'); };
  p.umask = function () { return 0o022; };
  p.emitWarning = function (w) { try { console.error('[shim] warning', typeof w === 'string' ? w : (w && w.message)); } catch (e) { } };
  p.assert = function (cond, msg) { if (!cond) throw new Error('process.assert: ' + msg); };
  p.hasUncaughtExceptionCaptureCallback = function () { return false; };
  p.noDeprecation = false;
  p.throwDeprecation = false;
  /* axios 用 Object.prototype.toString.call(process) 鉴别进程对象（kindOf(process)==='process'） */
  Object.defineProperty(p, Symbol.toStringTag, { value: 'process' });
  return p;
}
var processShim = makeProcess();

module.exports = {
  EE: EE,
  events: eventsModule,
  process: processShim,
  timers: timersModule,
  setImmediate: timersModule.setImmediate,
  clearImmediate: timersModule.clearImmediate,
};
