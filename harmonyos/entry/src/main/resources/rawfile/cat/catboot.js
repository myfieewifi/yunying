/* catboot: ArkWeb 沙盒引导（build-cat.cjs 生成，勿手改）
 * mini CJS 装载器 + shim 工厂表 + bundle 运行面（对齐 harness2.cjs ctx）
 * + fake server + 双向桥（__catBridgeFetch / __catInject）
 */
(function (global) {
'use strict';
var __f = {};
var __cache = {};
function __norm(n) { return String(n).replace(/^\.\//, ""); }
function __req(name) {
  var n = __norm(name);
  var key = Object.prototype.hasOwnProperty.call(__f, n) ? n : (Object.prototype.hasOwnProperty.call(__f, n.replace(/\.js$/, "")) ? n.replace(/\.js$/, "") : null);
  if (key === null) throw new Error("[catboot] 未知模块: " + name);
  if (key in __cache) return __cache[key].exports;
  var m = { exports: {} };
  __cache[key] = m;
  __f[key].call(m.exports, m, m.exports, __req);
  return m.exports;
}

/* ===== shim-core.js ===== */
__f['shim-core'] = function (module, exports, require) {
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

};

/* ===== shim-buffer.js ===== */
__f['shim-buffer'] = function (module, exports, require) {
/* shim-buffer: Buffer over Uint8Array（完整覆盖 node Buffer 常用面） */
'use strict';

/* 缓存原生 TypedArray 方法（U8.prototype 覆盖后仍需调用原生态） */
var NAT_SUBARRAY = Uint8Array.prototype.subarray;
var NAT_SET = Uint8Array.prototype.set;
var NAT_FILL = Uint8Array.prototype.fill;

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function u8Sub(view, start, end) { return NAT_SUBARRAY.call(view, start === undefined ? 0 : start, end === undefined ? view.length : end); }

function U8(parts, encOrOff, len) {
  if (!(this instanceof U8)) {
    if (typeof parts === 'string') return fromString(parts, encOrOff);
    if (parts && parts.buffer instanceof ArrayBuffer && typeof parts.length === 'number' && parts.BYTES_PER_ELEMENT !== undefined) {
      /* TypedArray 记录区间 */
      var cls = parts.constructor;
      var bytes = parts.length * (cls.BYTES_PER_ELEMENT || 1);
      var out = alloc(bytes);
      var b8 = new Uint8Array(parts.buffer, parts.byteOffset, bytes);
      NAT_SET.call(out, b8);
      return out;
    }
    if (ArrayBuffer.isView(parts)) {
      var bytes2 = parts.byteLength;
      var out2 = alloc(bytes2);
      NAT_SET.call(out2, new Uint8Array(parts.buffer, parts.byteOffset, bytes2));
      return out2;
    }
    return fromArrayLike(parts);
  }
  /* new U8(...)：跳过对象初始化（由 alloc/from* 完成） */
  return fromArrayLike(parts, encOrOff, len);
}
U8.prototype = Object.create(Uint8Array.prototype);

/* FastBuffer 语义：node 原生 Buffer[Symbol.species] 是 (buffer, byteOffset, length) 快速构造器。
 * undici 内置 fetch 模块**首次加载**时执行 var FastBuffer = Buffer[Symbol.species]，
 * 之后 new FastBuffer(buf.buffer, start, len) 解析响应头/体——
 * 沙盒里 globalThis.Buffer 已被换成本模块，必须提供等价 species，否则 undici 响应解析炸
 * "FastBuffer is not a constructor"，fetch 全灭（bundle 上层重试风暴 → 微任务堆积 OOM）。 */
function U8Species(buffer, off, len) {
  var u = alloc(typeof len === 'number' ? len : 0);
  if (buffer instanceof ArrayBuffer && typeof len === 'number' && len > 0) {
    NAT_SET.call(u, new Uint8Array(buffer, off || 0, len));
  }
  return u;
}
U8Species.prototype = U8.prototype;
U8[Symbol.species] = U8Species;

function alloc(size) {
  var u = new Uint8Array(size);
  u.__proto__ = U8.prototype;
  u._isBuffer = true;
  return u;
}

function fromArrayLike(parts, encOrOff, len) {
  if (typeof parts === 'string') return fromString(parts, encOrOff);
  if (parts && typeof parts === 'object' && typeof parts.length === 'number') {
    var a = alloc(parts.length);
    for (var i = 0; i < parts.length; i++) a[i] = parts[i] & 0xff;
    return a;
  }
  if (typeof parts === 'number') return alloc(parts);
  if (ArrayBuffer.isView(parts)) {
    var bytes = parts.byteLength;
    var b = alloc(bytes);
    NAT_SET.call(b, new Uint8Array(parts.buffer, parts.byteOffset, bytes));
    return b;
  }
  throw new TypeError('Buffer: unsupported init');
}
U8.from = function (parts, encOrOff, len) {
  if (typeof parts === 'string') return fromString(parts, encOrOff);
  /* node 语义 Buffer.from(arrayBuffer, byteOffset, length)：共享内存视图（不拷贝） */
  if (parts instanceof ArrayBuffer) {
    var voff = (typeof encOrOff === 'number') ? encOrOff : 0;
    var vlen = (typeof len === 'number') ? len : (parts.byteLength - voff);
    if (voff < 0 || vlen < 0 || voff + vlen > parts.byteLength) throw new TypeError('Buffer.from(ab): out of range');
    var v = new Uint8Array(parts, voff, vlen);
    v.__proto__ = U8.prototype;
    v._isBuffer = true;
    return v;
  }
  if (parts instanceof Uint8Array || ArrayBuffer.isView(parts)) {
    var bytes = parts.buffer ? parts.byteLength : parts.length;
    if (parts instanceof Uint8Array) {
      var b = alloc(parts.length);
      NAT_SET.call(b, NAT_SUBARRAY.call(parts, 0, parts.length));
      return b;
    }
    var b2 = alloc(parts.byteLength);
    NAT_SET.call(b2, new Uint8Array(parts.buffer, parts.byteOffset, parts.byteLength));
    return b2;
  }
  if (typeof parts === 'number') throw new TypeError('Buffer.from(number) not allowed');
  if (parts && typeof parts.length === 'number') {
    var a = alloc(parts.length);
    for (var i = 0; i < parts.length; i++) a[i] = parts[i] & 0xff;
    return a;
  }
  throw new TypeError('Buffer.from unsupported');
};
U8.alloc = function (size, fill) {
  var b = alloc(size >>> 0);
  if (fill !== undefined) NAT_FILL.call(b, typeof fill === 'number' ? (fill & 0xff) : 0);
  return b;
};
U8.allocUnsafe = function (size) { return alloc(size >>> 0); };

function hexEncode(u8, start, end) {
  var s = '';
  var arr = u8Sub(u8, start, end);
  for (var i = 0; i < arr.length; i++) { var h = arr[i].toString(16); s += h.length < 2 ? '0' + h : h; }
  return s;
}
function hexDecode(str) {
  var out = alloc(str.length >>> 1);
  for (var i = 0; i < out.length; i++) out[i] = parseInt(str.substr(i * 2, 2), 16) || 0;
  return out;
}
function b64Encode(u8, start, end) {
  var arr = u8Sub(u8, start, end);
  var s = '';
  var L = arr.length;
  for (var i = 0; i < L; i += 3) {
    var a = arr[i], b = i + 1 < L ? arr[i + 1] : undefined, c = i + 2 < L ? arr[i + 2] : undefined;
    var w = (a << 16) | ((b === undefined ? 0 : b) << 8) | (c === undefined ? 0 : c);
    s += B64[(w >>> 18) & 63] + B64[(w >>> 12) & 63] + (b === undefined ? '=' : B64[(w >>> 6) & 63]) + (c === undefined ? '=' : B64[w & 63]);
  }
  return s;
}
function b64Decode(str) {
  var std = String(str).replace(/-/g, '+').replace(/_/g, '/').replace(/[\r\n\s=]/g, '');
  var lookup = {};
  for (var li = 0; li < 64; li++) lookup[B64.charAt(li)] = li;
  var out = [];
  var acc = 0, bits = 0;
  for (var ci = 0; ci < std.length; ci++) {
    var v = lookup[std.charAt(ci)];
    if (v === undefined) continue;
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >>> bits) & 0xff); }
  }
  return Uint8Array.from(out);
}
function latin1Decode(u8, start, end) {
  var arr = u8Sub(u8, start, end);
  var s = '';
  for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return s;
}
function utf8Decode(u8, start, end) {
  var arr = u8Sub(u8, start, end);
  var s = '';
  for (var i = 0; i < arr.length; ) {
    var c = arr[i];
    if (c < 0x80) { s += String.fromCharCode(c); i++; }
    else if (c >= 0xc0 && c < 0xe0) { s += String.fromCharCode(((c & 0x1f) << 6) | (arr[i + 1] & 0x3f)); i += 2; }
    else if (c >= 0xe0 && c < 0xf0) {
      s += String.fromCharCode(((c & 0x0f) << 12) | ((arr[i + 1] & 0x3f) << 6) | (arr[i + 2] & 0x3f));
      i += 3;
    } else {
      var cp = ((c & 0x07) << 18) | ((arr[i + 1] & 0x3f) << 12) | ((arr[i + 2] & 0x3f) << 6) | (arr[i + 3] & 0x3f);
      var v = cp - 0x10000;
      s += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      i += 4;
    }
  }
  return s;
}
/* 十六进制解码失败（奇数长度或非法字符） → false */
function decodeHexGuarded(str) {
  if (str.length % 2 !== 0) return false;
  if (!/^[0-9a-fA-F]+$/.test(str)) return false;
  return true;
}

function fromString(str, enc) {
  var e = String(enc || 'utf8').toLowerCase();
  if (e === 'utf8' || e === 'utf-8' || e === 'ascii') {
    var bb = [];
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
        var nx = str.charCodeAt(i + 1);
        if (nx >= 0xdc00 && nx <= 0xdfff) { code = 0x10000 + ((code - 0xd800) << 10) + (nx - 0xdc00); i++; }
      }
      if (code < 0x80) bb.push(code);
      else if (code < 0x800) bb.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      else if (code < 0x10000) bb.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      else bb.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
    return wrapUint8ArrayFrom(bb);
  }
  if (e === 'latin1' || e === 'binary') {
    var la = alloc(str.length);
    for (var j = 0; j < str.length; j++) la[j] = str.charCodeAt(j) & 0xff;
    return la;
  }
  if (e === 'hex') return hexDecode(str);
  if (e === 'base64') return b64Decode(str);
  if (e === 'base64url') return b64Decode(String(str).replace(/-/g, '+').replace(/_/g, '/'));
  if (e === 'ucs2' || e === 'ucs-2' || e === 'utf16le') {
    var u = alloc(str.length * 2);
    for (var k = 0; k < str.length; k++) {
      u[k * 2] = str.charCodeAt(k) & 0xff;
      u[k * 2 + 1] = (str.charCodeAt(k) >>> 8) & 0xff;
    }
    return u;
  }
  throw new Error('shim-buffer: unsupported encoding ' + enc);
}
/* fromString 工厂：把普通 Uint8Array 包装成 Buffer 语义 */
function wrapUint8ArrayFrom(bb) {
  var out = alloc(bb.length);
  NAT_SET.call(out, bb);
  return out;
}

/* 核心模式转换函数（供 cipher/hash 内部调用） */
function utf8Write(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      var nx = str.charCodeAt(i + 1);
      if (nx >= 0xdc00 && nx <= 0xdfff) { code = 0x10000 + ((code - 0xd800) << 10) + (nx - 0xdc00); i++; }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  var u = alloc(out.length);
  for (var j = 0; j < out.length; j++) u[j] = out[j];
  return u;
}

U8.prototype.toString = function (enc, start, end) {
  if (this._isBuffer !== true) { /* 非 Buffer 裸数组除 UTF8 */
    return utf8Decode(this, start, end);
  }
  var e = String(enc || 'utf8').toLowerCase();
  if (e === 'utf8' || e === 'utf-8') return utf8Decode(this, start, end);
  if (e === 'latin1' || e === 'binary' || e === 'ascii') return latin1Decode(this, start, end);
  if (e === 'hex') return hexEncode(this, start, end);
  if (e === 'base64') return b64Encode(this, start, end);
  if (e === 'base64url') return b64Encode(this, start, end).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (e === 'ucs2' || e === 'ucs-2' || e === 'utf16le' || e === 'utf-16le' || e === 'utf16-le') {
    var s = '';
    var arr = u8Sub(this, start, end);
    for (var i = 0; i + 1 < arr.length; i += 2) s += String.fromCharCode(arr[i] | (arr[i + 1] << 8));
    return s;
  }
  return utf8Decode(this, start, end);
};

U8.prototype.subarray = function (start, end) {
  var out = NAT_SUBARRAY.call(this, start, end);
  out._isBuffer = this._isBuffer === true;
  return out;
};
U8.prototype.slice = function (start, end) {
  if (this._isBuffer === true) {
    var s = start === undefined ? 0 : (start < 0 ? this.length + start : start);
    var e = end === undefined ? this.length : (end < 0 ? this.length + end : end);
    var out = alloc(Math.max(0, e - s));
    NAT_SET.call(out, NAT_SUBARRAY.call(this, s, e));
    return out;
  }
  return NAT_SUBARRAY.call(this, start, end);
};

U8.prototype.includes = function (val, off) {
  var arr = (typeof val === 'string') ? fromString(val) : val;
  for (var i = off || 0; i <= this.length - arr.length; i++) {
    var ok = true;
    for (var j = 0; j < arr.length; j++) if (this[i + j] !== arr[j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
};
U8.prototype.indexOf = function (val, off) {
  var bytes = (typeof val === 'string') ? fromString(val) : u8Of2(val);
  for (var i = off || 0; i <= this.length - bytes.length; i++) {
    var ok = true;
    for (var j = 0; j < bytes.length; j++) if (this[i + j] !== bytes[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
};
U8.prototype.lastIndexOf = function (val, off) {
  var bytes = (typeof val === 'string') ? fromString(val) : u8Of2(val);
  for (var i = (off === undefined ? this.length - bytes.length : Math.min(off, this.length - bytes.length)); i >= 0; i--) {
    var ok = true;
    for (var j = 0; j < bytes.length; j++) if (this[i + j] !== bytes[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
};
function u8Of2(v) {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'number') return Uint8Array.of(v & 0xff);
  return fromString(String(v));
}
U8.prototype.equals = function (other) {
  if (!other || this.length !== other.length) return false;
  for (var i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
  return true;
};
U8.prototype.compare = function (other) {
  var n = Math.min(this.length, other.length);
  for (var i = 0; i < n; i++) {
    if (this[i] !== other[i]) return this[i] < other[i] ? -1 : 1;
  }
  return this.length === other.length ? 0 : (this.length < other.length ? -1 : 1);
};
U8.compare = function (a, b) { return a.compare(b); };
U8.prototype.copy = function (target, targetStart, sourceStart, sourceEnd) {
  var ts = targetStart || 0, ss = sourceStart || 0, se = sourceEnd === undefined ? this.length : sourceEnd;
  var n = Math.min(Math.max(0, se - ss), Math.max(0, target.length - ts));
  if (n > 0) NAT_SET.call(target, NAT_SUBARRAY.call(this, ss, ss + n), ts);
  return n;
};
U8.prototype.toJSON = function () {
  return { type: 'Buffer', data: Array.prototype.slice.call(this) };
};
U8.prototype.inspect = function () { return '<Buffer ' + hexEncode(this) + '>'; };

/* -------- 整数读写（LE/BE，8/16/32/64） -------- */
U8.prototype.readUInt8 = function (o) { return this[o | 0]; };
U8.prototype.readUInt16LE = function (o) { o = o || 0; return this[o] | (this[o + 1] << 8); };
U8.prototype.readUInt16BE = function (o) { o = o || 0; return (this[o] << 8) | this[o + 1]; };
U8.prototype.readUInt32LE = function (o) {
  o = o || 0;
  return (this[o] | (this[o + 1] << 8) | (this[o + 2] << 16)) + this[o + 3] * 0x1000000;
};
U8.prototype.readUInt32BE = function (o) {
  o = o || 0;
  /* 保留无符号：th[o]*2^24 用加法避免 32 位符号回绕 */
  var lo = (this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3];
  return this[o] * 0x1000000 + lo;
};
U8.prototype.readInt8 = function (o) { var v = this[o | 0]; return v > 127 ? v - 256 : v; };
U8.prototype.readInt16LE = function (o) { o = o || 0; var v = this[o] | (this[o + 1] << 8); return v > 32767 ? v - 65536 : v; };
U8.prototype.readInt16BE = function (o) { o = o || 0; var v = (this[o] << 8) | this[o + 1]; return v > 32767 ? v - 65536 : v; };
U8.prototype.readInt32LE = function (o) { o = o || 0; return this.readUInt32LE(o) | 0; };
U8.prototype.readInt32BE = function (o) { o = o || 0; return this.readUInt32BE(o) | 0; };
function readBigUInt64LE(u8, o) {
  o = o || 0;
  var lo = BigInt(u8.readUInt32LE(o)), hi = BigInt(u8.readUInt32LE(o + 4));
  return (hi << 32n) | lo;
}
function readBigUInt64BE(u8, o) {
  o = o || 0;
  var hi = BigInt(u8.readUInt32BE(o)), lo = BigInt(u8.readUInt32BE(o + 4));
  return (hi << 32n) | lo;
}
U8.prototype.readBigUInt64LE = function (o) { return readBigUInt64LE(this, o); };
U8.prototype.readBigUInt64BE = function (o) { return readBigUInt64BE(this, o); };
U8.prototype.readBigInt64LE = function (o) {
  var v = readBigUInt64LE(this, o);
  return v >= 0x8000000000000000n ? v - 0x10000000000000000n : v;
};
U8.prototype.readDoubleLE = function (o) { o = o || 0; var dv = new DataView(this.buffer, this.byteOffset + o, 8); return dv.getFloat64(0, true); };
U8.prototype.readDoubleBE = function (o) { o = o || 0; var dv = new DataView(this.buffer, this.byteOffset + o, 8); return dv.getFloat64(0, false); };
U8.prototype.readFloatLE = function (o) { o = o || 0; var dv = new DataView(this.buffer, this.byteOffset + o, 4); return dv.getFloat32(0, true); };
U8.prototype.readFloatBE = function (o) { o = o || 0; var dv = new DataView(this.buffer, this.byteOffset + o, 4); return dv.getFloat32(0, false); };
U8.prototype.write = function (str, off, len, enc) {
  /* 形式兼容 write(str[, off][, len][, enc]) */
  var o = off, e = enc, l = len;
  if (typeof off === 'string') { e = off; o = 0; l = undefined; }
  if (typeof len === 'string') { e = len; l = undefined; }
  o = o || 0;
  var e2 = String(e || 'utf8').toLowerCase();
  var src;
  if (e2 === 'utf8' || e2 === 'utf-8') src = utf8Write(str);
  else if (e2 === 'latin1' || e2 === 'binary' || e2 === 'ascii') {
    src = alloc(str.length);
    for (var i = 0; i < str.length; i++) src[i] = str.charCodeAt(i) & 0xff;
  } else if (e2 === 'hex') src = hexDecode(str);
  else if (e2 === 'base64') src = b64Decode(str);
  else if (e2 === 'ucs2' || e2 === 'utf16le') {
    src = alloc(str.length * 2);
    for (var k = 0; k < str.length; k++) { src[k * 2] = str.charCodeAt(k) & 0xff; src[k * 2 + 1] = str.charCodeAt(k) >>> 8 & 0xff; }
  } else src = utf8Write(str);
  var cap = (l === undefined) ? this.length - o : Math.min(l, this.length - o);
  var n = Math.min(cap, src.length);
  NAT_SET.call(this, NAT_SUBARRAY.call(src, 0, n), o);
  return o + n;
};
U8.prototype.fill = function (val, start, end, enc) {
  var s = start || 0, e = end === undefined ? this.length : end;
  if (typeof val === 'string') {
    var b = fromString(val, enc || 'utf8');
    if (b.length === 0) { return this; }
    for (var p = s; p < e; p++) this[p] = b[(p - s) % b.length];
    return this;
  }
  NAT_FILL.call(this, (typeof val === 'number' ? val : 0) & 0xff, s, e);
  return this;
};
U8.prototype.swap16 = function () {
  for (var i = 0; i + 1 < this.length; i += 2) { var t = this[i]; this[i] = this[i + 1]; this[i + 1] = t; }
  return this;
};
U8.prototype.swap32 = function () {
  for (var i = 0; i + 3 < this.length; i += 4) {
    var t0 = this[i], t1 = this[i + 1], t2 = this[i + 2], t3 = this[i + 3];
    this[i] = t3; this[i + 1] = t2; this[i + 2] = t1; this[i + 3] = t0;
  }
  return this;
};
U8.prototype.swap64 = function () {
  for (var i = 0; i + 7 < this.length; i += 8) {
    for (var k = 0; k < 4; k++) { var t = this[i + k]; this[i + k] = this[i + 7 - k]; this[i + 7 - k] = t; }
  }
  return this;
};
U8.prototype.writeUInt8 = function (v, o) { this[o | 0] = v & 0xff; return (o | 0) + 1; };
U8.prototype.writeUInt16LE = function (v, o) { o = o || 0; this[o] = v & 0xff; this[o + 1] = (v >>> 8) & 0xff; return o + 2; };
U8.prototype.writeUInt16BE = function (v, o) { o = o || 0; this[o] = (v >>> 8) & 0xff; this[o + 1] = v & 0xff; return o + 2; };
U8.prototype.writeUInt32LE = function (v, o) { o = o || 0; v = v >>> 0; this[o] = v & 0xff; this[o + 1] = (v >>> 8) & 0xff; this[o + 2] = (v >>> 16) & 0xff; this[o + 3] = (v >>> 24) & 0xff; return o + 4; };
U8.prototype.writeUInt32BE = function (v, o) { o = o || 0; v = v >>> 0; this[o] = (v >>> 24) & 0xff; this[o + 1] = (v >>> 16) & 0xff; this[o + 2] = (v >>> 8) & 0xff; this[o + 3] = v & 0xff; return o + 4; };
U8.prototype.writeInt8 = function (v, o) { return this.writeUInt8(v, o); };
U8.prototype.writeInt16LE = function (v, o) { return this.writeUInt16LE(v, o); };
U8.prototype.writeInt16BE = function (v, o) { return this.writeUInt16BE(v, o); };
U8.prototype.writeInt32LE = function (v, o) { return this.writeUInt32LE(v, o); };
U8.prototype.writeInt32BE = function (v, o) { return this.writeUInt32BE(v, o); };
U8.prototype.writeBigUInt64LE = function (v, o) {
  o = o || 0;
  var b = BigInt(v);
  this.writeUInt32LE(Number(b & 0xffffffffn), o);
  this.writeUInt32LE(Number((b >> 32n) & 0xffffffffn), o + 4);
  return o + 8;
};
U8.prototype.writeBigUInt64BE = function (v, o) {
  o = o || 0;
  var b = BigInt(v);
  this.writeUInt32BE(Number((b >> 32n) & 0xffffffffn), o);
  this.writeUInt32LE(Number(b & 0xffffffffn), o + 4);
  return o + 8;
};
U8.prototype.writeDoubleLE = function (v, o) { o = o || 0; new DataView(this.buffer, this.byteOffset + o, 8).setFloat64(0, v, true); return o + 8; };
U8.prototype.writeDoubleBE = function (v, o) { o = o || 0; new DataView(this.buffer, this.byteOffset + o, 8).setFloat64(0, v, false); return o + 8; };
U8.prototype.writeFloatLE = function (v, o) { o = o || 0; new DataView(this.buffer, this.byteOffset + o, 4).setFloat32(0, v, true); return o + 4; };
U8.prototype.writeFloatBE = function (v, o) { o = o || 0; new DataView(this.buffer, this.byteOffset + o, 4).setFloat32(0, v, false); return o + 4; };

U8.isBuffer = function (v) { return v instanceof Uint8Array && v._isBuffer === true; };
U8.isEncoding = function (e) {
  var s = String(e || '').toLowerCase();
  return ['utf8', 'utf-8', 'ascii', 'latin1', 'binary', 'hex', 'base64', 'base64url', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le'].indexOf(s) >= 0;
};
U8.byteLength = function (str, enc) {
  if (typeof str !== 'string') return str.length;
  var e = String(enc || 'utf8').toLowerCase();
  if (e === 'utf8' || e === 'utf-8' || e === 'utf-16le' || e === 'utf16le' || e === 'ucs2') {
    if (e === 'utf16le' || e === 'ucs2') return str.length * 2;
    var n = 0;
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
        var nx = str.charCodeAt(i + 1);
        if (nx >= 0xdc00 && nx <= 0xdfff) { code = 0x10000 + ((code - 0xd800) << 10) + (nx - 0xdc00); i++; }
      }
      if (code < 0x80) n++; else if (code < 0x800) n += 2; else if (code < 0x10000) n += 3; else n += 4;
    }
    return n;
  }
  if (e === 'hex') return str.length >>> 1;
  if (e === 'base64') return Math.floor(str.replace(/[=]+$/, '').length * 3 / 4);
  return str.length;
};
U8.concat = function (list, totalLength) {
  var total = totalLength;
  if (total === undefined) { total = 0; for (var i = 0; i < list.length; i++) total += list[i].length; }
  var out = alloc(total);
  var pos = 0;
  for (var j = 0; j < list.length && pos < total; j++) {
    var it = list[j];
    var n = Math.min(it.length, total - pos);
    NAT_SET.call(out, NAT_SUBARRAY.call(it, 0, n), pos);
    pos += n;
  }
  return out;
};
/* 与原生 Buffer 的关键差异点：U8 直接是 Uint8Array 子类，数组索引、length、set/subarray 原生可用 */

module.exports = U8;
module.exports.b64Encode = b64Encode;
module.exports.hexEncode = hexEncode;
module.exports.b64Decode = b64Decode;
module.exports.hexDecode = hexDecode;
module.exports.utf8Write = utf8Write;
module.exports.utf8Decode = utf8Decode;
module.exports.latin1Decode = latin1Decode;
module.exports.fromString = fromString;
module.exports.alloc = alloc;
module.exports.NAT_SET = NAT_SET;
module.exports.NAT_SUBARRAY = NAT_SUBARRAY;
/* node:buffer 常量面（pino/thread-stream 引用 constants.MAX_STRING_LENGTH） */
module.exports.constants = {
  MAX_LENGTH: 4294967296,          /* 2^32（64 位 node 语义） */
  MAX_STRING_LENGTH: 536870888,    /* 2^29 - 24 */
  INSPECT_MAX_BYTES: 50,
};
module.exports.kMaxLength = module.exports.constants.MAX_LENGTH;
module.exports.kStringLength = module.exports.constants.MAX_STRING_LENGTH;
module.exports.INSPECT_MAX_BYTES = 50;
module.exports.File = function File() { throw new Error('shim-buffer: File not supported'); };
module.exports.Blob = (typeof Blob !== 'undefined') ? Blob : function Blob() { throw new Error('shim-buffer: Blob not supported'); };
module.exports.atob = (typeof atob !== 'undefined') ? atob : function (s) { return b64Decode(s); };
module.exports.btoa = (typeof btoa !== 'undefined') ? btoa : function (s) { return b64Encode(s); };
module.exports.transcode = function () { throw new Error('shim-buffer: transcode not supported'); };
module.exports.isAscii = function (u8) { for (var i = 0; i < u8.length; i++) if (u8[i] > 0x7f) return false; return true; };
module.exports.isUtf8 = function (u8) { return true; };
/* node 语义 require('buffer').Buffer 自引用（node-fetch 解构 const { Buffer } = require('buffer')） */
module.exports.Buffer = U8;

};

/* ===== hash-constants.js ===== */
__f['hash-constants'] = function (module, exports, require) {
/* hash-constants: 精确公式生成（勿手改）
 * K256/K512 = 素数立方根小数×2^bits；IV = 素数平方根小数×2^bits；md5K = floor(abs(sin(i))*2^32)
 */
'use strict';

var K256 = [
0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

var IV256 = [
0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
];

var IV224 = [
0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 
  0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4
];

var K512 = [
0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn, 
  0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n, 
  0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n, 
  0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n, 
  0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n, 
  0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n, 
  0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n, 
  0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n, 
  0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn, 
  0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn, 
  0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n, 
  0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n, 
  0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n, 
  0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n, 
  0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn, 
  0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn, 
  0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n, 
  0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn, 
  0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn, 
  0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n
];

var IV512 = [
0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n, 
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n
];

var IV384 = [
0xcbbb9d5dc1059ed8n, 0x629a292a367cd507n, 0x9159015a3070dd17n, 0x152fecd8f70e5939n, 
  0x67332667ffc00b31n, 0x8eb44a8768581511n, 0xdb0c2e0d64f98fa7n, 0x47b5481dbefa4fa4n
];

var md5K = [
0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8, 
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1, 
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
];

var IV160 = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];

module.exports = { K256: K256, IV256: IV256, IV224: IV224, K512: K512, IV512: IV512, IV384: IV384, md5K: md5K, IV160: IV160 };

};

/* ===== shim-hash.js ===== */
__f['shim-hash'] = function (module, exports, require) {
/* shim-hash: 纯 JS md5/sha1/sha224/sha256/sha384/sha512 + hmac（同步链式 API，对齐 node:crypto） */
'use strict';

var C = require('./hash-constants.js');
var K256 = C.K256, IV256 = C.IV256, IV224 = C.IV224, K512 = C.K512, IV512 = C.IV512, IV384 = C.IV384, md5K = C.md5K, IV160 = C.IV160;

function u8Of(bytes) {
  // 接受 Uint8Array / shim Buffer / 字符串 / Array
  if (bytes === undefined || bytes === null) return new Uint8Array(0);
  if (bytes instanceof Uint8Array) return bytes;
  if (typeof bytes === 'string') {
    var out = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i) & 0xff;
    return out;
  }
  if (typeof bytes.length === 'number') {
    var o = new Uint8Array(bytes.length);
    for (var j = 0; j < bytes.length; j++) o[j] = bytes[j] & 0xff;
    return o;
  }
  throw new TypeError('hash: unsupported data type');
}

/* ---------------- md5（RFC 1321 目标槽位模式 a→d→c→b，K 表为 floor|sin(i+1)|*2^32） ---------------- */
function md5cmn(q, a, b, x, s, t) {
  a = (((a + q) | 0) + ((x + t) | 0)) | 0;
  return (((a << s) | (a >>> (32 - s))) + b) | 0;
}
function md5ff(a, b, c, d, x, s, t) { return md5cmn((b & c) | (~b & d), a, b, x, s, t); }
function md5gg(a, b, c, d, x, s, t) { return md5cmn((d & b) | (~d & c), a, b, x, s, t); }
function md5hh(a, b, c, d, x, s, t) { return md5cmn(b ^ c ^ d, a, b, x, s, t); }
function md5ii(a, b, c, d, x, s, t) { return md5cmn(c ^ (b | ~d), a, b, x, s, t); }

function md5Core(data) {
  var u8 = u8Of(data);
  var len = u8.length;
  var blocks = (((len + 8) >>> 6) + 1) << 6;
  var msg = new Uint8Array(blocks);
  msg.set(u8);
  msg[len] = 0x80;
  var bitLen = len * 8;
  var dv = new DataView(msg.buffer);
  dv.setUint32(blocks - 8, bitLen >>> 0, true);
  dv.setUint32(blocks - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);
  var a = IV160[0] | 0, b = IV160[1] | 0, c = IV160[2] | 0, d = IV160[3] | 0;
  var K = md5K;
  var S1 = [7, 12, 17, 22], S2 = [5, 9, 14, 20], S3 = [4, 11, 16, 23], S4 = [6, 10, 15, 21];
  for (var off = 0; off < blocks; off += 64) {
    var x = new Array(16);
    for (var i = 0; i < 16; i++) x[i] = dv.getUint32(off + i * 4, true);
    var AA = a, BB = b, CC = c, DD = d;
    var kk = 0;
    /* run4: 4 步目标槽位循环 a→d→c→b；idx0 组首消息字下标、st 步进 */
    function run4(fn, idx0, st, ss) {
      a = fn(a, b, c, d, x[idx0 & 15], ss[0], K[kk++]);
      d = fn(d, a, b, c, x[(idx0 + st) & 15], ss[1], K[kk++]);
      c = fn(c, d, a, b, x[(idx0 + 2 * st) & 15], ss[2], K[kk++]);
      b = fn(b, c, d, a, x[(idx0 + 3 * st) & 15], ss[3], K[kk++]);
    }
    for (var gr = 0; gr < 4; gr++) run4(md5ff, gr * 4, 1, S1);
    for (var gr2 = 0; gr2 < 4; gr2++) run4(md5gg, (20 * gr2 + 1) & 15, 5, S2);
    for (var gr3 = 0; gr3 < 4; gr3++) run4(md5hh, (12 * gr3 + 5) & 15, 3, S3);
    for (var gr4 = 0; gr4 < 4; gr4++) run4(md5ii, (28 * gr4) & 15, 7, S4);
    a = (a + AA) | 0; b = (b + BB) | 0; c = (c + CC) | 0; d = (d + DD) | 0;
  }
  var out = new Uint8Array(16);
  var odv = new DataView(out.buffer);
  odv.setUint32(0, a >>> 0, true); odv.setUint32(4, b >>> 0, true); odv.setUint32(8, c >>> 0, true); odv.setUint32(12, d >>> 0, true);
  return out;
}

/* ---------------- sha1（big-endian，80 轮） ---------------- */
function sha1Core(data) {
  var u8 = u8Of(data);
  var len = u8.length;
  var blocks = (((len + 9 + 63) >>> 6) << 6);
  var msg = new Uint8Array(blocks);
  msg.set(u8);
  msg[len] = 0x80;
  var dv = new DataView(msg.buffer);
  var bitLen = len * 8;
  dv.setUint32(blocks - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);
  dv.setUint32(blocks - 4, bitLen >>> 0, false);
  var h0 = IV160[0] | 0, h1 = IV160[1] | 0, h2 = IV160[2] | 0, h3 = IV160[3] | 0, h4 = IV160[4] | 0;
  var W = new Uint32Array(80);
  function rot(x, n) { return (x << n) | (x >>> (32 - n)); }
  for (var off = 0; off < blocks; off += 64) {
    for (var i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4, false);
    for (var t = 16; t < 80; t++) W[t] = (rot(W[t - 3] ^ W[t - 8] ^ W[t - 14] ^ W[t - 16], 1)) >>> 0;
    var a = h0, b = h1, c = h2, d = h3, e = h4;
    for (var j = 0; j < 80; j++) {
      var f, k;
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      var tmp = (rot(a, 5) + f + e + k + W[j]) | 0;
      e = d; d = c; c = rot(b, 30); b = a; a = tmp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  var out = new Uint8Array(20);
  var odv = new DataView(out.buffer);
  odv.setUint32(0, h0 >>> 0, false); odv.setUint32(4, h1 >>> 0, false); odv.setUint32(8, h2 >>> 0, false); odv.setUint32(12, h3 >>> 0, false); odv.setUint32(16, h4 >>> 0, false);
  return out;
}

/* ---------------- sha256 家族（big-endian，消息调度 + 64 轮） ---------------- */
function h256Core(data, H, trunc) {
  var u8 = u8Of(data);
  var len = u8.length;
  var blocks = (((len + 9 + 63) >>> 6) << 6);
  var msg = new Uint8Array(blocks);
  msg.set(u8);
  msg[len] = 0x80;
  var dv = new DataView(msg.buffer);
  var bitLen = len * 8;
  dv.setUint32(blocks - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);
  dv.setUint32(blocks - 4, bitLen >>> 0, false);
  var hv = new Array(8);
  for (var i = 0; i < 8; i++) hv[i] = H[i] | 0;
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  var w = new Array(64);
  for (var off = 0; off < blocks; off += 64) {
    for (var t = 0; t < 16; t++) w[t] = dv.getUint32(off + t * 4, false);
    for (var t2 = 16; t2 < 64; t2++) {
      var s0 = rotr(w[t2 - 15], 7) ^ rotr(w[t2 - 15], 18) ^ (w[t2 - 15] >>> 3);
      var s1 = rotr(w[t2 - 2], 17) ^ rotr(w[t2 - 2], 19) ^ (w[t2 - 2] >>> 10);
      w[t2] = (w[t2 - 16] + s0 + w[t2 - 7] + s1) | 0;
    }
    var a = hv[0], b = hv[1], c = hv[2], d = hv[3], e = hv[4], f = hv[5], g = hv[6], h = hv[7];
    for (var j = 0; j < 64; j++) {
      var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      var ch = (e & f) ^ (~e & g);
      var t1 = (h + S1 + ch + K256[j] + w[j]) | 0;
      var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2b = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2b) | 0;
    }
    hv[0] = (hv[0] + a) | 0; hv[1] = (hv[1] + b) | 0; hv[2] = (hv[2] + c) | 0; hv[3] = (hv[3] + d) | 0;
    hv[4] = (hv[4] + e) | 0; hv[5] = (hv[5] + f) | 0; hv[6] = (hv[6] + g) | 0; hv[7] = (hv[7] + h) | 0;
  }
  var n = trunc ? 7 : 8;
  var out = new Uint8Array(n * 4);
  var odv = new DataView(out.buffer);
  for (var q = 0; q < n; q++) odv.setUint32(q * 4, hv[q] >>> 0, false);
  return out;
}
function sha256(bytes) { return h256Core(bytes, IV256); }
function sha224(bytes) { return h256Core(bytes, IV224, true); }

/* ---------------- sha512 家族（BigInt，1024bit 块） ---------------- */
function h512Core(data, H, trunc) {
  var u8 = u8Of(data);
  var len = u8.length;
  var blocks = (((len + 17 + 127) >>> 7) << 7);
  var msg = new Uint8Array(blocks);
  msg.set(u8);
  msg[len] = 0x80;
  var dv = new DataView(msg.buffer);
  var bitLen = len * 8;
  dv.setUint32(blocks - 16, 0, false);
  dv.setUint32(blocks - 12, Math.floor(bitLen / 0x100000000) >>> 0, false);
  /* bitLen 下 64bit */
  var bigBits = BigInt(bitLen);
  var lo = bigBits & 0xffffffffn, hi = (bigBits >> 32n) & 0xffffffffn;
  dv.setUint32(blocks - 8, Number(hi), false);
  dv.setUint32(blocks - 4, Number(lo), false);
  function rotr(x, n) {
    return (x >> BigInt(n)) | (x << BigInt(64 - n));
  }
  var hv = new Array(8);
  for (var i = 0; i < 8; i++) hv[i] = H[i];
  var M = new Array(16);
  var w = new Array(80);
  for (var off = 0; off < blocks; off += 128) {
    for (var t = 0; t < 16; t++) {
      var hiB = BigInt(dv.getUint32(off + t * 8, false));
      var loB = BigInt(dv.getUint32(off + t * 8 + 4, false));
      w[t] = (hiB << 32n) | loB;
    }
    for (var t2 = 16; t2 < 80; t2++) {
      var s0 = rotr(w[t2 - 15], 1) ^ rotr(w[t2 - 15], 8) ^ (w[t2 - 15] >> 7n);
      var s1 = rotr(w[t2 - 2], 19) ^ rotr(w[t2 - 2], 61) ^ (w[t2 - 2] >> 6n);
      w[t2] = (w[t2 - 16] + s0 + w[t2 - 7] + s1) & 0xffffffffffffffffn;
    }
    var a = hv[0], b = hv[1], c = hv[2], d = hv[3], e = hv[4], f = hv[5], g = hv[6], h = hv[7];
    for (var j = 0; j < 80; j++) {
      var S1 = rotr(e, 14) ^ rotr(e, 18) ^ rotr(e, 41);
      var ch = (e & f) ^ ((~e & 0xffffffffffffffffn) & g);
      var t1 = (h + S1 + ch + K512[j] + w[j]) & 0xffffffffffffffffn;
      var S0 = rotr(a, 28) ^ rotr(a, 34) ^ rotr(a, 39);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) & 0xffffffffffffffffn;
      h = g; g = f; f = e; e = (d + t1) & 0xffffffffffffffffn; d = c; c = b; b = a; a = (t1 + t2) & 0xffffffffffffffffn;
    }
    for (var q = 0; q < 8; q++) {
      var upd = (hv[q] + [a, b, c, d, e, f, g, h][q]) & 0xffffffffffffffffn;
      hv[q] = upd;
    }
  }
  var n64 = trunc ? 6 : 8;
  var out = new Uint8Array(n64 * 8 + (trunc ? 0 : 0));
  var odv = new DataView(out.buffer);
  for (var k = 0; k < n64; k++) {
    var v = hv[k];
    odv.setUint32(k * 8, Number((v >> 32n) & 0xffffffffn), false);
    odv.setUint32(k * 8 + 4, Number(v & 0xffffffffn), false);
  }
  return out;
}
function sha512(bytes) { return h512Core(bytes, IV512); }
function sha384(bytes) { return h512Core(bytes, IV384, true); }

/* ---------------- hmac（blockSize: sha224/384/512 族 128, md5/sha1/sha256 族 64） ---------------- */
function blockSizeOf(algo) {
  var a = String(algo || '').toLowerCase();
  if (a === 'sha384' || a === 'sha512' || a === 'sha512-224' || a === 'sha512-256') return 128;
  return 64;
}
function rawHash(algo, bytes) {
  var a = String(algo || '').toLowerCase();
  switch (a) {
    case 'md5': return md5Core(bytes);
    case 'sha1': return sha1Core(bytes);
    case 'sha224': return sha224(bytes);
    case 'sha256': return sha256(bytes);
    case 'sha384': return sha384(bytes);
    case 'sha512': return sha512(bytes);
    default: throw new Error('shim-hash: unknown algo ' + algo);
  }
}

function concatBytes(a, b) {
  var out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}

function hmacCore(algo, key, data) {
  var bs = blockSizeOf(algo);
  var k = u8Of(key);
  if (k.length > bs) k = rawHash(algo, k);
  var kp = new Uint8Array(bs);
  kp.set(k);
  var inner = new Uint8Array(bs);
  var outer = new Uint8Array(bs);
  for (var i = 0; i < bs; i++) { inner[i] = kp[i] ^ 0x36; outer[i] = kp[i] ^ 0x5c; }
  var d = u8Of(data);
  /* HMAC = H(K^opad || H(K^ipad || M)) —— 两层 */
  var h1 = rawHash(algo, concatBytes(inner, d));
  return rawHash(algo, concatBytes(outer, h1));
}

/* ---------------- 同步链式 API ---------------- */
function encodeDigest(enc, u8) {
  if (enc === undefined || enc === 'buffer' || enc === null) return u8;
  var e = String(enc).toLowerCase();
  var b = '';
  if (e === 'hex') {
    for (var i = 0; i < u8.length; i++) { var h = u8[i].toString(16); b += h.length < 2 ? '0' + h : h; }
    return b;
  }
  if (e === 'base64') return b64Of(u8);
  if (e === 'base64url') return b64Of(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (e === 'latin1' || e === 'binary') {
    for (var j = 0; j < u8.length; j++) b += String.fromCharCode(u8[j]);
    return b;
  }
  if (e === 'utf8') { /* decode utf8 */
    var s = '';
    for (var k = 0; k < u8.length; ) {
      var c = u8[k];
      if (c < 0x80) { s += String.fromCharCode(c); k++; }
      else if (c >= 0xc0 && c < 0xe0) { s += String.fromCharCode(((c & 0x1f) << 6) | (u8[k + 1] & 0x3f)); k += 2; }
      else if (c >= 0xe0 && c < 0xf0) { s += String.fromCharCode(((c & 0x0f) << 12) | ((u8[k + 1] & 0x3f) << 6) | (u8[k + 2] & 0x3f)); k += 3; }
      else { var cp = ((c & 0x07) << 18) | ((u8[k + 1] & 0x3f) << 12) | ((u8[k + 2] & 0x3f) << 6) | (u8[k + 3] & 0x3f); var v = cp - 0x10000; s += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff)); k += 4; }
    }
    return s;
  }
  throw new Error('unsupported digest encoding ' + enc);
}
function b64Of(u8) {
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var s = '';
  for (var i = 0; i < u8.length; i += 3) {
    var a = u8[i], b = u8[i + 1], c = u8[i + 2];
    var w = (a << 16) | ((b || 0) << 8) | (c || 0);
    s += B64[(w >>> 18) & 63] + B64[(w >>> 12) & 63];
    s += (b === undefined) ? '=' : B64[(w >>> 6) & 63];
    s += (c === undefined) ? '=' : B64[w & 63];
    if (b === undefined) s = s.slice(0, s.length - 1) + '='; else if (c === undefined) s = s.slice(0, s.length - 1) + '=';
    if (b === undefined && c === undefined) s = s.slice(0, s.length - 2) + '==';
    else if (c === undefined) s = s.slice(0, s.length - 1) + '=';
  }
  return s;
}

function Hash(algo) {
  this._algo = String(algo || '').toLowerCase();
  this._buf = new Uint8Array(0);
}
Hash.prototype.update = function (data, enc) {
  var u8;
  if (typeof data === 'string') u8 = strToU8(data, enc);
  else u8 = u8Of(data);
  var merged = new Uint8Array(this._buf.length + u8.length);
  merged.set(this._buf); merged.set(u8, this._buf.length);
  this._buf = merged;
  return this;
};
function strToU8(str, enc) {
  var e = String(enc || 'utf8').toLowerCase();
  if (e === 'hex') {
    var out = new Uint8Array(Math.floor(str.length / 2));
    for (var i = 0; i < out.length; i++) out[i] = parseInt(str.substr(i * 2, 2), 16);
    return out;
  }
  if (e === 'base64') {
    var std = str.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '');
    var len = Math.floor(std.length * 3 / 4) - (std.charAt(std.length - 1) === '=' ? (std.charAt(std.length - 2) === '=' ? 2 : 1) : 0);
    var ob = new Uint8Array(len > 0 ? len : 0);
    var lookup = {};
    var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    for (var li = 0; li < 64; li++) lookup[B64.charAt(li)] = li;
    var oi = 0, acc = 0, bits = 0;
    for (var ci = 0; ci < std.length; ci++) {
      var chv = std.charAt(ci);
      if (chv === '=') break;
      if (lookup[chv] === undefined) continue;
      acc = (acc << 6) | lookup[chv]; bits += 6;
      if (bits >= 8) { bits -= 8; if (oi < ob.length) ob[oi++] = (acc >>> bits) & 0xff; }
    }
    return ob;
  }
  if (e === 'latin1' || e === 'binary' || e === 'ascii') {
    var la = new Uint8Array(str.length);
    for (var s = 0; s < str.length; s++) la[s] = str.charCodeAt(s) & 0xff;
    return la;
  }
  /* utf8 默认 */
  var bytesArr = [];
  for (var ui = 0; ui < str.length; ui++) {
    var code = str.charCodeAt(ui);
    if (code >= 0xd800 && code <= 0xdbff && ui + 1 < str.length) {
      var next = str.charCodeAt(ui + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00); ui++; }
    }
    if (code < 0x80) bytesArr.push(code);
    else if (code < 0x800) bytesArr.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytesArr.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytesArr.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return new Uint8Array(bytesArr);
}
Hash.prototype.digest = function (enc) {
  var u8 = rawHash(this._algo, this._buf);
  return encodeDigest(enc, u8);
};

function createHash(algo) { return new Hash(algo); }

function Hmac(algo, key) {
  this._algo = String(algo || '').toLowerCase();
  this._key = key;
  this._buf = new Uint8Array(0);
}
Hmac.prototype.update = function (data, enc) {
  var u8 = (typeof data === 'string') ? strToU8(data, enc) : u8Of(data);
  var merged = new Uint8Array(this._buf.length + u8.length);
  merged.set(this._buf); merged.set(u8, this._buf.length);
  this._buf = merged;
  return this;
};
Hmac.prototype.digest = function (enc) {
  var u8 = hmacCore(this._algo, (typeof this._key === 'string') ? strToU8(this._key) : u8Of(this._key), this._buf);
  return encodeDigest(enc, u8);
};
function createHmac(algo, key) { return new Hmac(algo, key); }

var cryptoMod = {
  createHash: createHash,
  createHmac: createHmac,
  md5: function (d) { return md5Core(d); },
  sha1: function (d) { return sha1Core(d); },
  sha224: sha224,
  sha256: sha256,
  sha384: sha384,
  sha512: sha512,
  hmac: hmacCore,
};

module.exports = {
  createHash: createHash,
  createHmac: createHmac,
  md5: cryptoMod.md5,
  sha1: cryptoMod.sha1,
  sha224: sha224,
  sha256: sha256,
  sha384: sha384,
  sha512: sha512,
  hmac: hmacCore,
  strToU8: strToU8,
  _Hash: Hash,
  _Hmac: Hmac,
};

};

/* ===== shim-cipher.js ===== */
__f['shim-cipher'] = function (module, exports, require) {
/* shim-cipher: AES-128/192/256 ECB/CBC/CTR + PKCS7（纯 JS，同步链式 API，node update/final 语义）
 * 状态布局：列优先 s[c*4+r]（FIPS-197 state[r][c] = in[r+4c]）；addRoundKey 用 word 高字节↔行0 对齐
 */
'use strict';

/* ---------------- GF(2^8) 域运算 ---------------- */
function xtime(a) { return ((a << 1) ^ (((a >>> 7) & 1) * 0x1b)) & 0xff; }
function gmul(a, b) {
  var p = 0;
  for (var c = 0; c < 8; c++) { if (b & 1) p ^= a; a = xtime(a); b = b >>> 1; }
  return p & 0xff;
}
function gmulInv(a) {
  if (a === 0) return 0;
  for (var x = 1; x < 256; x++) {
    if (gmul(a, x) === 1) return x;
  }
  return 0;
}

/* ---------------- SBOX（GF(2^8) 逆 + 仿射，c=0x63；仿射电路: a ^ rotl(a,1..4) ^ 0x63） ---------------- */
var SBOX = (function () {
  var t = new Array(256);
  for (var i = 0; i < 256; i++) {
    var a = i === 0 ? 0 : gmulInv(i);
    var r = a;
    r ^= ((a << 1) | (a >>> 7)) & 0xff;
    r ^= ((a << 2) | (a >>> 6)) & 0xff;
    r ^= ((a << 3) | (a >>> 5)) & 0xff;
    r ^= ((a << 4) | (a >>> 4)) & 0xff;
    t[i] = r ^ 0x63;
  }
  return t;
})();
var INV_SBOX = (function () { var t = new Array(256); for (var i = 0; i < 256; i++) t[SBOX[i]] = i; return t; })();
var RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8, 0xab, 0x4d, 0x9a, 0x2f, 0x5e, 0x63];

/* ---------------- 密钥扩展 ---------------- */
function expandKey(keyBytes) {
  var nk = keyBytes.length / 4;
  if (nk !== 4 && nk !== 6 && nk !== 8) throw new Error('AES key size must be 128/192/256 bits');
  var nr = nk + 6;
  var wTotal = 4 * (nr + 1);
  var w = new Array(wTotal);
  for (var i = 0; i < nk; i++) {
    w[i] = ((keyBytes[i * 4] << 24) | (keyBytes[i * 4 + 1] << 16) | (keyBytes[i * 4 + 2] << 8) | keyBytes[i * 4 + 3]) >>> 0;
  }
  for (var t = nk; t < wTotal; t++) {
    var tmp = w[t - 1];
    if (t % nk === 0) {
      tmp = ((tmp << 8) | (tmp >>> 24)) >>> 0; /* RotWord */
      tmp = subWord(tmp);
      tmp = (tmp ^ ((RCON[t / nk - 1] << 24) >>> 0)) >>> 0;
    } else if (nk > 6 && t % nk === 4) {
      tmp = subWord(tmp);
    }
    w[t] = (w[t - nk] ^ tmp) >>> 0;
  }
  return w;
}
function subWord(x) {
  return ((SBOX[(x >>> 24) & 0xff] << 24) | (SBOX[(x >>> 16) & 0xff] << 16) | (SBOX[(x >>> 8) & 0xff] << 8) | SBOX[x & 0xff]) >>> 0;
}

/* ---------------- 状态变换 ---------------- */
function subBytes(s) { for (var i = 0; i < 16; i++) s[i] = SBOX[s[i]]; }
function invSubBytes(s) { for (var i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]]; }

/* ShiftRows 行 r 左移 r；s[c*4+r] 索引 */
function shiftRows(s) {
  var t;
  t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;           /* row1 << 1 */
  t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;   /* row2 << 2 */
  t = s[3]; s[3] = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = t;          /* row3 << 3 (≡>>1) */
}
function invShiftRows(s) {
  var t;
  t = s[1]; s[1] = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = t;            /* row1 >> 1 */
  t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;   /* row2 >> 2 */
  t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;          /* row3 >> 3 (≡<<1) */
}

function mixColumns(s) {
  for (var c = 0; c < 4; c++) {
    var i = c * 4;
    var a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
    s[i] = (gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3) & 0xff;
    s[i + 1] = (a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3) & 0xff;
    s[i + 2] = (a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3)) & 0xff;
    s[i + 3] = (gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2)) & 0xff;
  }
}
function invMixColumns(s) {
  for (var c = 0; c < 4; c++) {
    var i = c * 4;
    var a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
    s[i] = (gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9)) & 0xff;
    s[i + 1] = (gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13)) & 0xff;
    s[i + 2] = (gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11)) & 0xff;
    s[i + 3] = (gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14)) & 0xff;
  }
}
function addRoundKey(s, round, words) {
  for (var c = 0; c < 4; c++) {
    var wj = words[round * 4 + c];
    s[c * 4] ^= (wj >>> 24) & 0xff;
    s[c * 4 + 1] ^= (wj >>> 16) & 0xff;
    s[c * 4 + 2] ^= (wj >>> 8) & 0xff;
    s[c * 4 + 3] ^= wj & 0xff;
  }
}

function encryptBlockN(input, o, words, out, oo) {
  var s = new Array(16);
  for (var i = 0; i < 16; i++) s[i] = input[o + i];
  var nr = words.length / 4 - 1;
  addRoundKey(s, 0, words);
  for (var r = 1; r < nr; r++) { subBytes(s); shiftRows(s); mixColumns(s); addRoundKey(s, r, words); }
  subBytes(s); shiftRows(s); addRoundKey(s, nr, words);
  for (var j = 0; j < 16; j++) out[oo + j] = s[j] & 0xff;
}
function decryptBlockN(input, o, words, out, oo) {
  var s = new Array(16);
  for (var i = 0; i < 16; i++) s[i] = input[o + i];
  var nr = words.length / 4 - 1;
  addRoundKey(s, nr, words);
  for (var r = nr - 1; r >= 1; r--) { invShiftRows(s); invSubBytes(s); addRoundKey(s, r, words); invMixColumns(s); }
  invShiftRows(s); invSubBytes(s); addRoundKey(s, 0, words);
  for (var j = 0; j < 16; j++) out[oo + j] = s[j] & 0xff;
}

/* ---------------- PKCS7 ---------------- */
function pkcs7Pad(data) {
  var pad = 16 - (data.length % 16);
  var out = new Uint8Array(data.length + pad);
  out.set(data);
  for (var i = data.length; i < out.length; i++) out[i] = pad;
  return out;
}
function pkcs7Unpad(data) {
  if (data.length === 0 || data.length % 16 !== 0) throw new Error('bad decrypt (invalid data length)');
  var pad = data[data.length - 1];
  if (pad < 1 || pad > 16) throw new Error('bad decrypt (invalid padding byte)');
  for (var i = data.length - pad; i < data.length; i++) {
    if (data[i] !== pad) throw new Error('bad decrypt (invalid padding byte)');
  }
  return data.subarray(0, data.length - pad);
}

/* ---------------- 工具 ---------------- */
function snap(u8) {
  var out = new Uint8Array(u8.length);
  out.set(u8);
  return out;
}
function concat(a, b) {
  var out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}
var _bufMod = null;
function bufMod() { if (_bufMod === null) _bufMod = require('./shim-buffer.js'); return _bufMod; }
/* 把 plain Uint8Array 结果包装成 shim Buffer（挂上 U8 原型，toString('hex') 等可用） */
function markBuf(u8) {
  var b = bufMod().alloc(u8.length);
  b.set(u8);
  return b;
}
function utf8ToBytesRaw(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      var nx = str.charCodeAt(i + 1);
      if (nx >= 0xdc00 && nx <= 0xdfff) { code = 0x10000 + ((code - 0xd800) << 10) + (nx - 0xdc00); i++; }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return new Uint8Array(out);
}
function bytesIn(data, inputEnc) {
  if (typeof data === 'string') {
    var e = String(inputEnc || 'utf8').toLowerCase();
    if (e === 'utf8' || e === 'utf-8') return utf8ToBytesRaw(data);
    if (e === 'latin1' || e === 'binary' || e === 'ascii') {
      var o = new Uint8Array(data.length);
      for (var i = 0; i < data.length; i++) o[i] = data.charCodeAt(i) & 0xff;
      return o;
    }
    if (e === 'hex') {
      var o2 = new Uint8Array(data.length >>> 1);
      for (var j = 0; j < o2.length; j++) o2[j] = parseInt(data.substr(j * 2, 2), 16) || 0;
      return o2;
    }
    if (e === 'base64' || e === 'base64url') return bufMod().b64Decode(data);
    throw new Error('unsupported input encoding ' + inputEnc);
  }
  if (data instanceof Uint8Array) return data;
  if (data && typeof data.length === 'number') return new Uint8Array(data);
  throw new TypeError('cipher input type');
}
function encKeyFrom(x) { return typeof x === 'string' ? utf8ToBytesRaw(x) : snap(x); }

function parseAlgo(algo) {
  var a = String(algo || '').toLowerCase();
  var m = /^aes-(128|192|256)-(ecb|cbc|ctr)$/.exec(a);
  if (!m) throw new Error('shim-cipher: unsupported algo ' + algo);
  return { bits: +m[1], mode: m[2] };
}
function nextCtr(ctr) { /* 大端 128bit +1 */
  for (var i = 15; i >= 0; i--) {
    if (ctr[i] === 0xff) { ctr[i] = 0; } else { ctr[i] = (ctr[i] + 1) & 0xff; break; }
  }
}

/* ---------------- 基类 ---------------- */
function CipherBase(algo, keyBytes, ivBytes) {
  var spec = parseAlgo(algo);
  var key = encKeyFrom(keyBytes);
  if ([16, 24, 32].indexOf(key.length) < 0) throw new Error('Invalid key length ' + key.length);
  this._algo = spec;
  this._words = expandKey(key);
  this._iv = ivBytes ? encKeyFrom(ivBytes) : null;
  if (spec.mode !== 'ecb' && !this._iv) throw new Error('Missing IV for ' + spec.mode);
  if (this._iv && this._iv.length !== 16) throw new Error('Invalid initialization vector size ' + this._iv.length);
  this._buf = new Uint8Array(0);   /* ECB/CBC 半块（dec 为末块回退）缓冲 */
  this._chain = null;              /* CBC enc 链 */
  this._dchain = null;             /* CBC dec 链 */
  this._stream = null;             /* CTR counter 状态 */
  this._ks = null;                 /* CTR 当前 keystream 块 */
  this._ksPos = 16;                /* CTR keystream 已消耗字节数 */
}

/* ---------------- 加密端 ---------------- */
function Encipher(enc) { this.c = enc; }

Encipher.prototype.update = function (data, inputEnc) {
  var u8 = bytesIn(data, inputEnc);
  var spec = this.c._algo;
  var words = this.c._words;
  if (spec.mode === 'ctr') {
    if (!this.c._stream) { this.c._stream = snap(this.c._iv); this.c._ks = null; this.c._ksPos = 16; }
    var outC = new Uint8Array(u8.length);
    var pos = 0;
    while (pos < u8.length) {
      if (this.c._ks === null || this.c._ksPos >= 16) {
        this.c._ks = new Uint8Array(16);
        encryptBlockN(this.c._stream, 0, words, this.c._ks, 0);
        nextCtr(this.c._stream);
        this.c._ksPos = 0;
      }
      var take = Math.min(16 - this.c._ksPos, u8.length - pos);
      for (var i = 0; i < take; i++) outC[pos + i] = u8[pos + i] ^ this.c._ks[this.c._ksPos + i];
      pos += take;
      this.c._ksPos += take;
    }
    return markBuf(outC);
  }
  var all = concat(this.c._buf, u8);
  var blocks = all.length >> 4;
  var tail = all.length & 15;
  this.c._buf = tail ? all.subarray(blocks << 4) : new Uint8Array(0);
  var out = new Uint8Array(blocks << 4);
  if (spec.mode === 'ecb') {
    for (var b = 0; b < blocks; b++) encryptBlockN(all, b << 4, words, out, b << 4);
  } else { /* cbc */
    var chain = this.c._iv ? snap(this.c._iv) : this.c._chain;
    this.c._iv = null;
    for (var b2 = 0; b2 < blocks; b2++) {
      var pin = new Array(16);
      for (var k = 0; k < 16; k++) pin[k] = all[(b2 << 4) + k] ^ chain[k];
      var ob = new Uint8Array(16);
      encryptBlockN(pin, 0, words, ob, 0);
      out.set(ob, b2 << 4);
      chain = snap(ob);
    }
    this.c._chain = chain;
  }
  return markBuf(out);
};

Encipher.prototype.final = function () {
  var spec = this.c._algo;
  if (spec.mode === 'ctr') return markBuf(new Uint8Array(0)); /* CTR 无填充 */
  var pad = pkcs7Pad(this.c._buf);
  this.c._buf = new Uint8Array(0);
  var blocks = pad.length >> 4;
  var out = new Uint8Array(blocks << 4);
  if (spec.mode === 'ecb') {
    for (var b = 0; b < blocks; b++) encryptBlockN(pad, b << 4, this.c._words, out, b << 4);
  } else {
    var chain = this.c._chain || (this.c._iv ? snap(this.c._iv) : null);
    this.c._iv = null;
    for (var b2 = 0; b2 < blocks; b2++) {
      var pin = new Array(16);
      for (var k = 0; k < 16; k++) pin[k] = pad[(b2 << 4) + k] ^ chain[k];
      var ob = new Uint8Array(16);
      encryptBlockN(pin, 0, this.c._words, ob, 0);
      out.set(ob, b2 << 4);
      chain = snap(ob);
    }
    this.c._chain = null;
  }
  return markBuf(out);
};

/* ---------------- 解密端 ---------------- */
function Decipher(dec) { this.c = dec; }

Decipher.prototype.update = function (data, inputEnc) {
  var u8 = bytesIn(data, inputEnc);
  var spec = this.c._algo;
  var words = this.c._words;
  if (spec.mode === 'ctr') { /* CTR 解密 = 同 keystream XOR */
    return new Encipher(this.c).update(u8);
  }
  var all = concat(this.c._buf, u8);
  /* node 语义：末块留给 final（padding 校验需要整流收尾），非整块尾巴也缓冲 */
  var keep = all.length & 15;
  if (all.length >= 16) keep += 16;
  var usable = all.length - keep;
  if (usable <= 0) { this.c._buf = all; return markBuf(new Uint8Array(0)); }
  this.c._buf = all.subarray(usable);
  var blocks = usable >> 4;
  var out = new Uint8Array(blocks << 4);
  if (spec.mode === 'ecb') {
    for (var b = 0; b < blocks; b++) decryptBlockN(all, b << 4, words, out, b << 4);
  } else { /* cbc: P = D(C) xor prevC */
    var chain = this.c._dchain || (this.c._iv ? snap(this.c._iv) : null);
    this.c._iv = null;
    for (var b2 = 0; b2 < blocks; b2++) {
      var ct = snap(all.subarray(b2 << 4, (b2 << 4) + 16));
      var pb = new Uint8Array(16);
      decryptBlockN(ct, 0, words, pb, 0);
      for (var k = 0; k < 16; k++) pb[k] ^= chain[k];
      out.set(pb, b2 << 4);
      chain = ct;
    }
    this.c._dchain = chain;
  }
  return markBuf(out);
};

Decipher.prototype.final = function () {
  var spec = this.c._algo;
  if (spec.mode === 'ctr') return markBuf(new Uint8Array(0));
  var all = this.c._buf;
  this.c._buf = new Uint8Array(0);
  if (all.length !== 16) throw new Error('bad decrypt (wrong final block length ' + all.length + ')');
  var out = new Uint8Array(16);
  decryptBlockN(all, 0, this.c._words, out, 0);
  if (spec.mode === 'cbc') {
    var chain = this.c._dchain || (this.c._iv ? snap(this.c._iv) : null);
    this.c._iv = null;
    for (var i = 0; i < 16; i++) out[i] ^= chain[i];
  }
  return markBuf(pkcs7Unpad(out));
};

/* ---------------- 工厂 ---------------- */
function createCipheriv(algo, key, iv) {
  var c = new CipherBase(algo, key, iv);
  return new Encipher(c);
}
function createDecipheriv(algo, key, iv) {
  if (iv === null && /-ecb$/i.test(String(algo))) iv = null;
  var c = new CipherBase(algo, key, iv);
  return new Decipher(c);
}

/* setEncoders: 兼容旧 harness（no-op，编码在 bytesIn 内部处理） */
function setEncoders() { }

module.exports = {
  createCipheriv: createCipheriv,
  createDecipheriv: createDecipheriv,
  setEncoders: setEncoders,
  snap: snap,
  encryptBlockN: encryptBlockN,
  decryptBlockN: decryptBlockN,
  expandKey: expandKey,
  SBOX: SBOX,
  INV_SBOX: INV_SBOX,
  _pkcs7Pad: pkcs7Pad,
  _pkcs7Unpad: pkcs7Unpad,
};

};

/* ===== shim-crypto.js ===== */
__f['shim-crypto'] = function (module, exports, require) {
/* shim-crypto: node:crypto 模块面合成（hash + hmac + AES + random；RSA 暂不支持的用清晰报错） */
'use strict';

var Hash = require('./shim-hash.js');
var Cipher = require('./shim-cipher.js');
var bufMod = require('./shim-buffer.js');

/* ---------------- random ---------------- */
function randomFill(u8) {
  var g = typeof globalThis.crypto !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function' ? globalThis.crypto : null;
  if (g) {
    /* getRandomValues 单次上限 65536 字节 */
    for (var off = 0; off < u8.length; off += 65536) g.getRandomValues(u8.subarray(off, Math.min(off + 65536, u8.length)));
    return u8;
  }
  for (var i = 0; i < u8.length; i++) u8[i] = Math.floor(Math.random() * 256) & 0xff;
  return u8;
}
function randomBytes(size, cb) {
  var u8 = bufMod.alloc(size >>> 0);
  randomFill(u8);
  if (typeof cb === 'function') { try { cb(null, u8); } catch (e) { } return undefined; }
  return u8;
}
function randomInt(min, max, cb) {
  var lo = min, hi = max;
  if (hi === undefined) { hi = lo; lo = 0; }
  if (hi <= lo) throw new RangeError('randomInt min must be < max');
  var span = hi - lo;
  var v = Math.floor(Math.random() * span);
  if (typeof cb === 'function') { try { cb(null, lo + v); } catch (e) { } return undefined; }
  return lo + v;
}
function randomUUID() {
  var b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; /* version 4 */
  b[8] = (b[8] & 0x3f) | 0x80; /* variant 10 */
  var h = '';
  for (var i = 0; i < 16; i++) { var x = b[i].toString(16); h += x.length < 2 ? '0' + x : x; }
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}
/* 常用量常量（bundle 引用名面） */
var constants = {
  RSA_PKCS1_PADDING: 1,
  RSA_OAEP_PADDING: 4,
  RSA_NO_PADDING: 3,
  SSL_OP_ALL: 0,
  SSL_OP_NO_SSLv2: 0,
  SSL_OP_NO_SSLv3: 0,
  SSL_OP_NO_TLSv1: 0,
  SSL_OP_NO_TLSv1_1: 0,
  SSL_OP_NO_TLSv1_2: 0,
  SSL_OP_NO_TLSv1_3: 0,
  DH_CHECK_P_NOT_PRIME: 0,
  DH_CHECK_P_NOT_SAFE_PRIME: 0,
  POINT_CONVERSION_COMPRESSED: 2,
  POINT_CONVERSION_UNCOMPRESSED: 4,
};

function unsupported(name) {
  return function () { throw new Error('shim-crypto: ' + name + ' is not supported in this sandbox'); };
}

/* ---------------- KeyObject stub ----------------
 * 某些站点在模块顶层 createPrivateKey({key,format:'der',type:'pkcs8'})（硬编码密钥），
 * 模块装载不能因此失败：返回惰性 stub，真用到 RSA 运算时再清晰报错。
 */
function KeyObjectStub(type) {
  this._ktype = type;
}
Object.defineProperties(KeyObjectStub.prototype, {
  type: { get: function () { return this._ktype; } },
  symmetricKeyType: { get: function () { return this._ktype === 'secret' ? 'aes' : undefined; } },
  asymmetricKeyType: { get: function () { return this._ktype === 'secret' ? undefined : 'rsa'; } },
});
KeyObjectStub.prototype.export = function (opts) { throw new Error('shim-crypto: KeyObject.export not supported in this sandbox'); };
KeyObjectStub.prototype.equals = function (other) { return other instanceof KeyObjectStub && other._ktype === this._ktype; };
KeyObjectStub.prototype.toString = function () { return '[KeyObject: ' + this._ktype + ' (stub)]'; };

function createPrivateKey(spec) { return new KeyObjectStub('private'); }
function createPublicKey(spec) { return new KeyObjectStub('public'); }
function createSecretKey(spec) { return new KeyObjectStub('secret'); }

module.exports = {
  createHash: Hash.createHash,
  createHmac: Hash.createHmac,
  createCipheriv: Cipher.createCipheriv,
  createDecipheriv: Cipher.createDecipheriv,
  randomBytes: randomBytes,
  randomInt: randomInt,
  randomUUID: randomUUID,
  randomFill: function (buf, cb) { randomFill(buf); if (typeof cb === 'function') cb(null, buf); return buf; },
  constants: constants,
  webcrypto: (typeof globalThis.crypto !== 'undefined') ? globalThis.crypto : undefined,
  /* RSA 系（guazi 等站点用）：明确不支持，按需补 PKCS1 v1.5 实现 */
  publicEncrypt: unsupported('publicEncrypt'),
  privateDecrypt: unsupported('privateDecrypt'),
  publicDecrypt: unsupported('publicDecrypt'),
  createSign: unsupported('createSign'),
  createVerify: unsupported('createVerify'),
  generateKeyPair: unsupported('generateKeyPair'),
  generateKeyPairSync: unsupported('generateKeyPairSync'),
  /* KeyObject 工厂：返回惰性 stub（模块顶层 createPrivateKey 不能炸） */
  createPrivateKey: createPrivateKey,
  createPublicKey: createPublicKey,
  createSecretKey: createSecretKey,
  KeyObject: KeyObjectStub,
  pbkdf2Sync: unsupported('pbkdf2Sync'),
  pbkdf2: unsupported('pbkdf2'),
  scryptSync: unsupported('scryptSync'),
  timingSafeEqual: function (a, b) {
    if (a.length !== b.length) return false;
    var d = 0;
    for (var i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  },
  getCiphers: function () { return ['aes-128-cbc', 'aes-192-cbc', 'aes-256-cbc', 'aes-128-ecb', 'aes-192-ecb', 'aes-256-ecb', 'aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr']; },
  getHashes: function () { return ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512']; },
};

};

/* ===== shim-util.js ===== */
__f['shim-util'] = function (module, exports, require) {
/* shim-util: util + assert（对齐 w276 结构；require('./shim-core.js') 取 EE） */
'use strict';
var core = require('./shim-core.js');
var EE = core.EE;

/* ---------------- util ---------------- */
function isBuffer(v) { return v && v._isBuffer === true; }

function inspect(v, opts) {
  var depth = (opts && typeof opts === 'object' && typeof opts.depth === 'number') ? opts.depth : 2;
  if (typeof v === 'string') return v;
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'bigint') return String(v) + 'n';
  if (typeof v === 'function') return '[Function: ' + (v.name || '(anonymous)') + ']';
  if (typeof v !== 'object') return String(v);
  if (isBuffer(v)) {
    var hexs = [];
    for (var i = 0; i < Math.min(v.length, 50); i++) hexs.push(v[i] < 16 ? '0' + v[i].toString(16) : v[i].toString(16));
    return '<Buffer ' + hexs.join(' ') + '>';
  }
  if (v instanceof Error) return (v.name || 'Error') + ': ' + (v.message || '');
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    var inner = v.slice(0, 8).map(function (e) { return inspect(e, { depth: depth - 1 }); });
    return '[ ' + inner.join(', ') + (v.length > 8 ? ', ' + (v.length - 8) + ' more...' : '') + ' ]';
  }
  var keys = [];
  for (var k in v) { if (Object.prototype.hasOwnProperty.call(v, k)) { keys.push(k); if (keys.length > 16) break; } }
  var out = keys.map(function (k2) {
    var sv;
    try { sv = inspect(v[k2], { depth: depth - 1 }); } catch (e) { sv = '<threw>'; }
    return k2 + ': ' + sv;
  });
  return '{ ' + out.join(', ') + ' }';
}

function format(f) {
  if (typeof f !== 'string') {
    var args0 = Array.prototype.slice.call(arguments);
    if (args0.length === 0) return '';
    return args0.map(function (x) { return inspect(x); }).join(' ');
  }
  var i = 1;
  var args = Array.prototype.slice.call(arguments);
  if (args.length === 1) return String(f); /* node 语义：仅 format 串时原样返回 */
  var str = String(f).replace(/%[sdjifoO%]/g, function (m) {
    if (m === '%%') return '%';
    if (i >= args.length) return m;
    var v = args[i++];
    switch (m) {
      case '%s': return String(v);
      case '%d': case '%i': return typeof v === 'bigint' ? String(v) : parseInt(v, 10);
      case '%f': return parseFloat(v);
      case '%j': try { return JSON.stringify(v); } catch (e) { return '[Circular]'; }
      case '%o': case '%O': return inspect(v, { depth: 4 });
      case '%i': return parseInt(v, 10);
      default: return m;
    }
  });
  for (; i < args.length; i++) {
    var r = args[i];
    if (r === null || (typeof r !== 'object' && typeof r !== 'function')) str += ' ' + String(r);
    else str += ' ' + inspect(r);
  }
  return str;
}

function inherits(ctor, superCtor) {
  if (superCtor) {
    try { Object.setPrototypeOf(ctor.prototype, superCtor.prototype); } catch (e) { }
    ctor.super_ = superCtor;
  }
  return ctor;
}

function promisify(orig) {
  if (typeof orig !== 'function') throw new TypeError('promisify requires a function');
  if (orig.customPromisifyArgs || orig[Symbol.for('nodejs.util.promisify.custom')]) {
    var c = orig[Symbol.for('nodejs.util.promisify.custom')];
    if (typeof c === 'function') return promisify(c);
  }
  function wrapped() {
    var args = Array.prototype.slice.call(arguments);
    return new Promise(function (resolve, reject) {
      args.push(function (err) {
        if (err) return reject(err);
        resolve(arguments.length <= 1 ? undefined : (arguments.length === 2 ? arguments[1] : Array.prototype.slice.call(arguments, 1)));
      });
      orig.apply(null, args);
    });
  }
  wrapped.__promisified__ = true;
  return wrapped;
}

function callbackify(orig) {
  return function () {
    var args = Array.prototype.slice.call(arguments);
    var cb = args.pop();
    Promise.resolve(orig.apply(null, args)).then(function (v) { cb(null, v); }, function (e) { cb(e); });
  };
}

function deprecate(fn, msg) {
  var warned = false;
  return function () {
    if (!warned) { warned = true; try { console.error('[shim] DeprecationWarning: ' + msg); } catch (e) { } }
    return fn.apply(this, arguments);
  };
}

function debuglog(ns) { return function () { }; }

var utilTypes = {
  isPromise: function (v) { return v && typeof v.then === 'function' && typeof v.catch === 'function'; },
  isDate: function (v) { return v instanceof Date; },
  isAnyArrayBuffer: function (v) { return v && (v instanceof ArrayBuffer || ArrayBuffer.isView(v)); },
  isUint8Array: function (v) { return v instanceof Uint8Array; },
  /* node-fetch Body 构造的类型判定链用 */
  isBoxedPrimitive: function (v) {
    if (typeof v !== 'object' || v === null) return false;
    return v instanceof Boolean || v instanceof Number || v instanceof String;
  },
  isRegExp: function (v) { return v instanceof RegExp; },
  isArrayBufferView: function (v) { return ArrayBuffer.isView(v); },
  isArrayBuffer: function (v) { return v instanceof ArrayBuffer; },
  isDataView: function (v) { return v instanceof DataView; },
  isMap: function (v) { return v instanceof Map; },
  isSet: function (v) { return v instanceof Set; },
  isTypedArray: function (v) { return ArrayBuffer.isView(v) && !(v instanceof DataView); },
};

var util = {
  inspect: inspect,
  format: format,
  formatWithOptions: function (o, f) { return format.apply(null, Array.prototype.slice.call(arguments, 1)); },
  inherits: inherits,
  promisify: promisify,
  callbackify: callbackify,
  deprecate: deprecate,
  debuglog: debuglog,
  isBuffer: isBuffer,
  types: utilTypes,
  isArray: function (v) { return Array.isArray(v); },
  isFunction: function (v) { return typeof v === 'function'; },
  isNull: function (v) { return v === null; },
  isUndefined: function (v) { return v === undefined; },
  isString: function (v) { return typeof v === 'string'; },
  isNumber: function (v) { return typeof v === 'number'; },
  isObject: function (v) { return v !== null && typeof v === 'object'; },
  TextEncoder: typeof TextEncoder !== 'undefined' ? TextEncoder : undefined,
  TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : undefined,
};

/* ---------------- assert ---------------- */
function AssertionError(opts) {
  var msg = opts && opts.message;
  EE.call(this);
  this.name = 'AssertionError';
  this.message = msg || 'AssertionError';
  if (opts && 'actual' in opts) this.actual = opts.actual;
  if (opts && 'expected' in opts) this.expected = opts.expected;
  if (opts && opts.operator) this.operator = opts.operator;
  this.generatedMessage = !msg;
  var err = new Error(this.message);
  this.stack = err.stack;
}
AssertionError.prototype = Object.create(Error.prototype);
AssertionError.prototype.constructor = AssertionError;

function fmtFail(a, b, op, msg) {
  if (msg) return typeof msg === 'string' ? msg : msg.message || String(msg);
  return format('%s !== %s', inspect(a), inspect(b));
}

function assert(cond, msg) {
  if (!cond) throw new AssertionError({ message: typeof msg === 'string' ? msg : (msg && msg.message) || fmtFail(cond, true, '==') , actual: cond, expected: true, operator: '==' });
}
assert.ok = assert;
assert.AssertionError = AssertionError;

assert.equal = function (a, b, msg) { if (a != b) throw new AssertionError({ message: fmtFail(a, b, '==', msg), actual: a, expected: b, operator: '==' }); };
assert.notEqual = function (a, b, msg) { if (a == b) throw new AssertionError({ message: fmtFail(a, b, '!=', msg), actual: a, expected: b, operator: '!=' }); };
assert.strictEqual = function (a, b, msg) { if (a !== b) throw new AssertionError({ message: fmtFail(a, b, '===', msg), actual: a, expected: b, operator: '===' }); };
assert.notStrictEqual = function (a, b, msg) { if (a === b) throw new AssertionError({ message: fmtFail(a, b, '!==', msg), actual: a, expected: b, operator: '!==' }); };
assert.fail = function (msg) { throw new AssertionError({ message: typeof msg === 'string' ? msg : 'Failed' }); };

/* 结构化比较（node deepEqual 语义的实用子集） */
function deepCmp(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (typeof a === 'number' && typeof b === 'number') return isNaN(a) && isNaN(b);
    return false;
  }
  /* node 宽松 deepEqual 不比原型；原型检查在 deepStrictEqual 层做 */
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return a.toString() === b.toString();
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    var bi = b.entries();
    for (var e1 of a.entries()) {
      var found = false;
      for (var e2 of b.entries()) { if (deepCmp(e1[0], e2[0]) && deepCmp(e1[1], e2[1])) { found = true; break; } }
      if (!found) return false;
    }
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (var v1 of a.values()) {
      var f2 = false;
      for (var v2 of b.values()) if (deepCmp(v1, v2)) { f2 = true; break; }
      if (!f2) return false;
    }
    return true;
  }
  var ka = Object.keys(a).filter(function (k) { return a[k] !== undefined; });
  var kb = Object.keys(b).filter(function (k) { return b[k] !== undefined; });
  if (ka.length !== kb.length) return false;
  for (var i = 0; i < ka.length; i++) {
    if (kb.indexOf(ka[i]) < 0) return false;
    if (!deepCmp(a[ka[i]], b[ka[i]])) return false;
  }
  return true;
}
assert.deepEqual = function (a, b, msg) { if (!deepCmp(a, b)) throw new AssertionError({ message: fmtFail(a, b, 'deepEqual', msg), actual: a, expected: b, operator: 'deepEqual' }); };
assert.notDeepEqual = function (a, b, msg) { if (deepCmp(a, b)) throw new AssertionError({ message: fmtFail(a, b, 'notDeepEqual', msg), actual: a, expected: b, operator: 'notDeepEqual' }); };
function protoSame(a, b) {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return true;
  return Object.getPrototypeOf(a) === Object.getPrototypeOf(b);
}
assert.deepStrictEqual = function (a, b, msg) { if (!deepCmp(a, b) || typeof a !== typeof b || !protoSame(a, b)) throw new AssertionError({ message: fmtFail(a, b, 'deepStrictEqual', msg), actual: a, expected: b, operator: 'deepStrictEqual' }); };
assert.notDeepStrictEqual = function (a, b, msg) { if (deepCmp(a, b) && typeof a === typeof b && protoSame(a, b)) throw new AssertionError({ message: fmtFail(a, b, 'notDeepStrictEqual', msg), actual: a, expected: b, operator: 'notDeepStrictEqual' }); };

function throwsImpl(block, matcher, isNot) {
  var threw = null;
  try { block(); } catch (e) { threw = e; }
  if (isNot) {
    if (threw) throw new AssertionError({ message: 'Got unwanted exception: ' + (threw && threw.message) });
    return;
  }
  if (!threw) throw new AssertionError({ message: 'Missing expected exception' });
  if (matcher) {
    var mOk = false;
    if (typeof matcher === 'function') mOk = matcher(threw) === true;
    else if (matcher instanceof RegExp) mOk = matcher.test(threw.message);
    else if (typeof matcher === 'string') mOk = threw.message.indexOf(matcher) >= 0;
    else if (matcher instanceof Error) mOk = matcher.name === threw.name && matcher.message === threw.message;
    if (!mOk) throw new AssertionError({ message: 'exception does not match: ' + (threw && threw.message) });
  }
}
assert.throws = function (block, matcher) { throwsImpl(block, matcher, false); };
assert.doesNotThrow = function (block) { throwsImpl(block, null, true); };
assert.ifError = function (err) { if (err) throw err; };
assert.strict = {};
for (var ak in assert) { if (Object.prototype.hasOwnProperty.call(assert, ak) && typeof assert[ak] === 'function') assert.strict[ak] = assert[ak]; }
assert.strict.equal = assert.strictEqual;
assert.strict.notEqual = assert.notStrictEqual;
assert.strict.deepEqual = assert.deepStrictEqual;
assert.strict.notDeepEqual = assert.notDeepStrictEqual;
assert.strict.ok = assert.ok;

module.exports = { util: util, assert: assert, AssertionError: AssertionError, deepCmp: deepCmp };

};

/* ===== shim-path.js ===== */
__f['shim-path'] = function (module, exports, require) {
/* shim-path: posix 语义 path（fastify/vendor require 面） */
'use strict';
var SEP = '/';

function normalize(p) {
  var abs = String(p).charAt(0) === SEP;
  var parts = String(p).split(/[\\/]+/).filter(function (x) { return x.length > 0 && x !== '.'; });
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
    } else out.push(parts[i]);
  }
  var s = out.join(SEP);
  return (abs ? SEP : '') + (s.length ? s : (abs ? '' : '.'));
}
function join() {
  var args = Array.prototype.slice.call(arguments).filter(function (x) { return x !== undefined && x !== null && String(x).length > 0; });
  if (args.length === 0) return '.';
  return normalize(args.join(SEP));
}
function resolve() {
  var args = Array.prototype.slice.call(arguments);
  var abs = false;
  var parts = [];
  for (var i = args.length - 1; i >= 0; i--) {
    var seg = String(args[i]);
    if (seg.length === 0) continue;
    if (seg.charAt(0) === SEP) { abs = true; parts.unshift(seg); break; }
    parts.unshift(seg);
  }
  if (!abs) parts.unshift(typeof process !== 'undefined' && process.cwd ? process.cwd() : '/');
  return normalize(parts.join(SEP)) || SEP;
}
function dirname(p) {
  var s = String(p);
  var i = s.lastIndexOf(SEP);
  if (i < 0) return '.';
  if (i === 0) return SEP;
  return s.slice(0, i) || SEP;
}
function basename(p, ext) {
  var s = String(p);
  var i = s.lastIndexOf(SEP);
  var b = i < 0 ? s : s.slice(i + 1);
  if (ext && b.endsWith(String(ext))) b = b.slice(0, b.length - String(ext).length);
  return b || SEP;
}
function extname(p) {
  var b = basename(String(p));
  var i = b.lastIndexOf('.');
  if (i <= 0) return '';
  return b.slice(i);
}
function isAbsolute(p) { return String(p).charAt(0) === SEP; }
function relative(from, to) {
  var f = normalize(String(from)).split(SEP).filter(Boolean);
  var t = normalize(String(to)).split(SEP).filter(Boolean);
  var i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  var up = f.length - i;
  var out = [];
  for (var u = 0; u < up; u++) out.push('..');
  for (var d = i; d < t.length; d++) out.push(t[d]);
  return out.join(SEP) || '.';
}
function parse(p) {
  var s = String(p);
  var base = basename(s);
  var ext = extname(s);
  return {
    root: s.charAt(0) === SEP ? SEP : '',
    dir: dirname(s),
    base: base,
    ext: ext,
    name: ext ? base.slice(0, base.length - ext.length) : base,
  };
}
function format(po) {
  if (!po || typeof po !== 'object') return '.';
  var dir = po.dir || '';
  var base = po.base || ((po.name || '') + (po.ext || ''));
  if (!dir) return base || '.';
  return dir.endsWith(SEP) ? dir + base : dir + SEP + base;
}

module.exports = {
  normalize: normalize,
  join: join,
  resolve: resolve,
  dirname: dirname,
  basename: basename,
  extname: extname,
  isAbsolute: isAbsolute,
  relative: relative,
  parse: parse,
  format: format,
  sep: SEP,
  delimiter: ':',
  posix: null,
  win32: null,
};
module.exports.posix = module.exports;
module.exports.win32 = module.exports;

};

/* ===== shim-os.js ===== */
__f['shim-os'] = function (module, exports, require) {
/* shim-os: os 模块基本面（沙盒静态值） */
'use strict';
module.exports = {
  platform: function () { return 'harmony'; },
  arch: function () { return 'arm64'; },
  type: function () { return 'HarmonyOS'; },
  release: function () { return '1.0.0'; },
  EOL: '\n',
  tmpdir: function () { return '/tmp'; },
  homedir: function () { return '/'; },
  hostname: function () { return 'catsandbox'; },
  userInfo: function () { return { username: 'sandbox', uid: -1, gid: -1, homedir: '/', shell: null }; },
  cpus: function () { return [{ model: 'sandbox', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }]; },
  totalmem: function () { return 0; },
  freemem: function () { return 0; },
  loadavg: function () { return [0, 0, 0]; },
  uptime: function () { return 0; },
  networkInterfaces: function () { return {}; },
  endianness: function () { return 'LE'; },
};

};

/* ===== shim-stream.js ===== */
__f['shim-stream'] = function (module, exports, require) {
/* shim-stream: mini node:stream（Readable/Writable/Transform/Duplex/PassThrough + pipe/pipeline + asyncIterator）
 * 语义覆盖面：on('data'/'end'/'error'/'finish'/'close')、push/write/end、pipe、async 迭代、destroy、setEncoding、objectMode
 */
'use strict';
var core = require('./shim-core.js');
var EE = core.EE;
/* 裸 Uint8Array 包成 shim Buffer：axios 单 chunk 旁路 Buffer.concat 会直接
 * Uint8Array.toString()（逗号十进制串），U8 的 toString('utf8') 语义正确 */
var BufMod = require('./shim-buffer.js');
function markU8(chunk) {
  if (chunk instanceof Uint8Array && !(chunk instanceof BufMod)) {
    var b = BufMod.alloc(chunk.length);
    b.set(chunk);
    return b;
  }
  return chunk;
}

var u8From = typeof Uint8Array.from === 'function' ? Uint8Array.from.bind(Uint8Array) : null;
function isU8(v) { return v instanceof Uint8Array; }
function toBuf(chunk) {
  if (chunk === undefined || chunk === null) return null;
  if (isU8(chunk)) return chunk;
  if (typeof chunk === 'string') {
    /* 默认 utf8 → bytes */
    var out = [];
    for (var i = 0; i < chunk.length; i++) {
      var code = chunk.charCodeAt(i);
      if (code < 0x80) out.push(code);
      else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      else if (code < 0xd800 || code > 0xdfff) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      else { code = 0x10000 + (((code - 0xd800) << 10) | (chunk.charCodeAt(++i) - 0xdc00)); out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)); }
    }
    return new Uint8Array(out);
  }
  if (chunk && typeof chunk.length === 'number') return u8From ? u8From(chunk) : new Uint8Array(chunk);
  return null;
}
function cat(a, b) {
  if (!a || a.length === 0) return b;
  if (!b || b.length === 0) return a;
  var out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}
function nextTick(fn) { Promise.resolve().then(fn); }

/* ---------------- Readable ---------------- */
function Readable(opts) {
  EE.call(this);
  this.readable = true;
  this._rs = {
    buf: [],
    len: 0,
    ended: false,
    flowing: false,      /* resume/pipe/on('data') 后 true */
    started: false,
    endedEmitted: false,
    enc: null,
    objectMode: !!(opts && opts.objectMode),
    hwm: (opts && opts.highWaterMark) || 16384,
    destroyed: false,
    reading: false,
  };
  this._readFn = null;
}
Readable.prototype = Object.create(EE.prototype);
Readable.prototype.constructor = Readable;

Readable.prototype._read = function () { };

Readable.prototype.push = function (chunk, enc) {
  var st = this._rs;
  if (st.ended) return false;
  if (chunk === null) { st.ended = true; st.reading = false; this._maybeEmitEnd(); return false; }
  var data = st.objectMode ? chunk : markU8(toBuf(typeof chunk === 'string' ? chunk : chunk, enc));
  if (data !== null) { st.buf.push({ data: data, enc: enc }); st.len += (data && data.length) || 0; }
  if (st.flowing || st.reading) this._drain();
  return st.len < st.hwm;
};
/* 内部：滴灌数据到事件/管道目标 */
Readable.prototype._drain = function () {
  var st = this._rs;
  if (st.reading || st.destroyed) return;
  st.reading = true;
  nextTick((function pump() {
    if (st.destroyed) { st.reading = false; return; }
    var self = this;
    function loop() {
      if (st.destroyed) return;
      var item = st.buf.shift();
      if (item === undefined) {
        if (st.ended) { self._maybeEmitEnd(); }
        st.reading = false;
        return;
      }
      var chunk = item.data;
      if (st.enc && isU8(chunk)) {
        try { chunk = chunk.toString ? chunk.toString(st.enc) : decodeStr(chunk, st.enc); } catch (e) { chunk = decodeStr(item.data, st.enc); }
      }
      self.emit('data', chunk);
      if (self._dest && !self._dest.destroyed2) {
        /* pipe 模式：写给目标 */
        var d = self._dest;
        if (d.write) d.write(chunk);
      }
      if (st.buf.length || st.ended) nextTick(loop);
      else st.reading = false;
    }
    loop();
  }).bind(this));
};
function decodeStr(u8, enc) {
  var s = '';
  for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
}
Readable.prototype._maybeEmitEnd = function () {
  var st = this._rs;
  if (!st.ended || st.endedEmitted) return;
  if (st.buf.length > 0) return;
  st.endedEmitted = true;
  var self = this;
  nextTick(function () {
    if (self._dest) {
      var d = self._dest;
      self._dest = null;
      if (d.end) d.end();
      self.emit('end'); /* pipe 完成时同时发 end（node 在可读侧发 end；简化无害） */
      return;
    }
    self.emit('end');
  });
};
Readable.prototype.on = function (t, f) {
  var r = EE.prototype.on.call(this, t, f);
  var st = this._rs;
  if (t === 'data' && !st.flowing) { st.flowing = true; this._drain(); }
  if (t === 'end' && st.ended && st.endedEmitted) nextTick(function () { f(); });
  if (t === 'readable' && !st.flowing) { st.flowing = true; this._drain(); }
  return r;
};
Readable.prototype.removeListener = function (t, f) {
  var r = EE.prototype.removeListener.call(this, t, f);
  var st = this._rs;
  if (t === 'data' && this.listenerCount('data') === 0) st.flowing = false;
  return r;
};
Readable.prototype.read = function (n) {
  var st = this._rs;
  var item = st.buf.shift();
  if (item === undefined) return null;
  st.len -= (item.data && item.data.length) || 0;
  return item.data;
};
Readable.prototype.setEncoding = function (enc) { this._rs.enc = String(enc || 'utf8').toLowerCase(); return this; };
Readable.prototype.resume = function () { this._rs.flowing = true; this._drain(); return this; };
Readable.prototype.pause = function () { this._rs.flowing = false; return this; };
Readable.prototype.isPaused = function () { return !this._rs.flowing; };
Readable.prototype.pipe = function (dest, opts) {
  this._dest = dest;
  var self = this;
  this.on('error', function (e) { if (dest.emit) dest.emit('error', e); });
  if (dest && typeof dest.on === 'function') { /* 目标准备好了 */
    /* 交给 _drain 循环 */
  }
  this.resume();
  return dest;
};
Readable.prototype.uncork = function () { };
Readable.prototype.destroy = function (err) {
  var st = this._rs;
  if (st.destroyed) return this;
  st.destroyed = true;
  if (err) this.emit('error', err);
  this.emit('close');
  return this;
};
Readable.prototype.destroyed = false;
Object.defineProperty(Readable.prototype, 'destroyed2', { get: function () { return this._rs.destroyed; } });
Readable.prototype[Symbol.asyncIterator] = function () {
  var self = this;
  var q = [], done = false, err = null, waiting = [];
  this.on('data', function (c) {
    if (waiting.length) waiting.shift()(c);
    else q.push(c);
  });
  this.on('end', function () { done = true; while (waiting.length) waiting.shift()(undefined); });
  this.on('error', function (e) { err = e; done = true; while (waiting.length) waiting.shift()(undefined); });
  this.resume();
  return {
    next: function () {
      return new Promise(function (resolve) {
        if (q.length) return resolve({ value: q.shift(), done: false });
        if (err) return reject2(resolve, err);
        if (done) return resolve({ value: undefined, done: true });
        waiting.push(function (c) {
          if (c === undefined) return resolve({ value: undefined, done: true });
          resolve({ value: c, done: false });
        });
      });
      function reject2(res, e) { res({ value: undefined, done: true }); }
    },
  };
};
Readable.from = function (src, opts) {
  var r = new Readable(opts);
  function pump(p) {
    Promise.resolve(p).then(function (it) {
      if (it === undefined || it === null || it.done) { r.push(null); return; }
      r.push(it.value);
      if (it.next) pump(it.next());
    }, function (e) { r.emit('error', e); r.push(null); });
  }
  if (src && typeof src.next === 'function') pump(src);       /* iterator */
  else if (src && typeof src[Symbol.iterator] === 'function') pump(src[Symbol.iterator]());
  else if (src && typeof src[Symbol.asyncIterator] === 'function') pump(src[Symbol.asyncIterator]());
  else if (src instanceof Promise) pump(src);
  else pump(src);
  return r;
};

/* ---------------- Writable ---------------- */
function Writable(opts) {
  EE.call(this);
  this.writable = true;
  this._ws = { ending: false, ended: false, destroyed: false, cb: null, objectMode: !!(opts && opts.objectMode), hwm: (opts && opts.highWaterMark) || 16384 };
  this._writeFn = null;
}
Writable.prototype = Object.create(EE.prototype);
Writable.prototype.constructor = Writable;
/* node 语义：Writable.prototype.pipe 存在但抛 ERR_STREAM_CANNOT_PIPE。
 * 必须非枚举 —— Transform 定义处 Object.assign(Transform.prototype, Writable.prototype)
 * 只拷枚举键，避免把抛错 pipe 覆盖掉 Transform 从 Readable 继承的真 pipe。
 * 有了它，pipeline 的流判定（typeof s.pipe === 'function'）才能收尾 Writable。 */
Object.defineProperty(Writable.prototype, 'pipe', {
  value: function () { throw new TypeError('Cannot pipe, not readable'); },
  enumerable: false, configurable: true, writable: true,
});
Writable.prototype._write = function (chunk, enc, cb) { cb(); };
Writable.prototype.write = function (chunk, enc, cb) {
  var st = this._ws;
  if (typeof enc === 'function') { cb = enc; enc = undefined; }
  if (st.ended || st.destroyed) {
    if (cb) nextTick(cb);
    return false;
  }
  var self = this;
  nextTick(function () {
    try { self._write(chunk, enc || 'utf8', function () { if (cb) cb(); }); }
    catch (e) { self.emit('error', e); if (cb) cb(e); }
  });
  return st.bufLen !== -1; /* 简化：总是可写 */
};
Writable.prototype.end = function (chunk, enc, cb) {
  var st = this._ws;
  if (typeof enc === 'function') { cb = enc; enc = undefined; }
  var self = this;
  var finish = function () {
    if (st.ended) return;
    st.ended = true;
    if (cb) cb();
    self.emit('finish');
  };
  if (chunk !== undefined && chunk !== null) return this.write(chunk, enc, finish);
  st.ending = true;
  nextTick(finish);
  return this;
};
Writable.prototype.destroy = function (err) {
  var st = this._ws;
  if (st.destroyed) return this;
  st.destroyed = true;
  if (err) this.emit('error', err);
  this.emit('close');
  return this;
};
Writable.prototype.cork = function () { };
Writable.prototype.uncork = function () { };
Writable.prototype.setDefaultEncoding = function () { return this; };
Writable.prototype.on = function (t, f) {
  var r = EE.prototype.on.call(this, t, f);
  if (t === 'finish' && this._ws.ended) nextTick(f);
  return r;
};
Object.defineProperty(Writable.prototype, 'writableEnded', { get: function () { return this._ws.ended; } });
Object.defineProperty(Writable.prototype, 'writableFinished', { get: function () { return this._ws.ended; } });

/* ---------------- Transform / Duplex ---------------- */
function Transform(opts) {
  Readable.call(this, opts);
  Writable.call(this, opts);
  this._transformFn = null;
}
Transform.prototype = Object.create(Readable.prototype);
Transform.prototype.constructor = Transform;
Object.assign(Transform.prototype, Writable.prototype, {
  _transform: function (chunk, enc, cb) { cb(null, chunk); },
  write: function (chunk, enc, cb) {
    var self = this;
    if (typeof enc === 'function') { cb = enc; enc = undefined; }
    nextTick(function () {
      try {
        self._transform(chunk, enc || 'utf8', function (err, data) {
          if (err) { self.emit('error', err); if (cb) cb(err); return; }
          if (data !== undefined && data !== null) self.push(data);
          if (cb) cb();
        });
      } catch (e) { self.emit('error', e); if (cb) cb(e); }
    });
    return true;
  },
  end: function (chunk, enc, cb) {
    var wst = this._ws;
    if (typeof enc === 'function') { cb = enc; enc = undefined; }
    var self = this;
    function finishUp() {
      wst.ended = true;
      function done() {
        function finishEnd() {
          /* 读侧收尾必须在 _flush 数据推入之后：push() 首行 if (st.ended) return 会丢弃尾部数据 */
          self._rs.ended = true;
          self._maybeEmitEnd();
          if (cb) cb();
          self.emit('finish');
        }
        if (typeof self._flush === 'function' && !self._flushed) {
          self._flushed = true;
          try {
            self._flush(function (err, data) {
              if (err) self.emit('error', err);
              if (data !== undefined && data !== null) self.push(data);
              finishEnd();
            });
          } catch (e) { self.emit('error', e); finishEnd(); }
        } else finishEnd();
      }
      if (self._rs.reading) { /* 滴灌循环未排空：等一拍再收尾 */
        Promise.resolve().then(function () {
          Promise.resolve().then(done);
        });
        return;
      }
      done();
    }
    if (chunk !== undefined && chunk !== null) {
      return this.write(chunk, enc, finishUp);
    }
    wst.ending = true;
    nextTick(finishUp);
    return this;
  },
  on: function (t, f) { /* 合并 Readable.on（data/end 流控）与 Writable.on（finish 补发）：Object.assign 时 Writable.on 会覆盖 Readable.on，必须重合成 */
    var r = Readable.prototype.on.call(this, t, f);
    if (t === 'finish' && this._ws.ended) nextTick(f);
    return r;
  },
  destroy: function (err) { /* 可读+可写两侧都置 destroyed */
    this._rs.destroyed = true;
    this._ws.destroyed = true;
    if (err) this.emit('error', err);
    this.emit('close');
    return this;
  },
});
Object.defineProperty(Transform.prototype, 'writableEnded', { get: function () { return this._ws.ended; } });
Object.defineProperty(Transform.prototype, 'writableFinished', { get: function () { return this._ws.ended; } });
Object.defineProperty(Transform.prototype, 'readableEnded', { get: function () { return this._rs.ended; } });
function Duplex(opts) { Transform.call(this, opts); }
Duplex.prototype = Transform.prototype;
function PassThrough(opts) { Transform.call(this, opts); }
PassThrough.prototype = Transform.prototype;

/* pipeline：node 全形态三态对齐 ——
 *   pipeline(s1, s2, ..., cb) / pipeline([s1, s2, ...], cb)（node 14+ 数组形态）/ promisify(pipeline)(...)
 * 返回值三态：
 *   - 带 cb（含 bundle 的 noop 回调）：返回最后一个流（axios fork 依赖 g0=返回值继续 .on('data')）；
 *     node 原版 cb 式返回 undefined，无实际调用方依赖该 undefined。promisify 路径注入 cb 后
 *     走此分支，promisify 忽略返回值、用注入 cb 收尾 —— 兼容。
 *   - 无 cb（promise 式）：返回完成 Promise（node 15+ pipeline promise 语义，test-stream 回归用）。 */
function pipeline() {
  var args = Array.prototype.slice.call(arguments);
  if (args.length >= 1 && Array.isArray(args[0])) args = args[0].concat(args.slice(1));
  var cb = (args.length > 0 && typeof args[args.length - 1] === 'function') ? args.pop() : null;
  var streams = args.filter(function (s) { return s && typeof s.pipe === 'function'; });
  if (streams.length === 0) {
    var e0 = new Error('shim-stream.pipeline: no streams');
    if (cb) { setImmediate(function () { cb(e0); }); return undefined; }
    return Promise.reject(e0);
  }
  for (var i = 0; i + 1 < streams.length; i++) streams[i].pipe(streams[i + 1]);
  var last = streams[streams.length - 1];
  var doneP = new Promise(function (resolve, reject) {
    last.on('finish', resolve);
    last.on('end', resolve);
    last.on('error', reject);
  });
  if (cb) {
    doneP.then(function () { cb(null); }, function (e) { cb(e); });
    return last;
  }
  return doneP;
}
pipeline.promise = pipeline;

module.exports = {
  Readable: Readable,
  Writable: Writable,
  Transform: Transform,
  Duplex: Duplex,
  PassThrough: PassThrough,
  Stream: { Readable: Readable, Writable: Writable, Transform: Transform, Duplex: Duplex, PassThrough: PassThrough, pipeline: pipeline },
  pipeline: pipeline, finished: function (stream, cb) { stream.on('finish', function () { cb(null); }); stream.on('error', function (e) { cb(e); }); },
};
/* node:stream interop 对齐（bundle 内 node-fetch/viewport 走 t instanceof t2.default 与 t2.default.Readable.from）：
 * esbuild __toESM 会强制 default=模块对象本身，因此模块对象必须是可 instanceof 的函数；全家静态挂函数身上 */
var modStream = function shimStream() { throw new Error('shim-stream: bare call unsupported'); };
modStream.Readable = Readable;
modStream.Writable = Writable;
modStream.Duplex = Duplex;
modStream.Transform = Transform;
modStream.PassThrough = PassThrough;
modStream.Stream = module.exports.Stream;
modStream.pipeline = pipeline;
modStream.finished = module.exports.finished;
modStream.default = modStream;
Object.assign(module.exports, { } /* 保留原导出 */);
module.exports = Object.assign(modStream, Object.assign({}, module.exports, { default: modStream }));

};

/* ===== shim-fs.js ===== */
__f['shim-fs'] = function (module, exports, require) {
/* shim-fs: 内存文件系统 stub（bundle 的 fs/profile 持久化面） */
'use strict';
var store = {}; /* path -> Uint8Array */
var TX = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
var RX = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

function toU8(data) {
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (typeof data === 'string') {
    if (TX) return TX.encode(data);
    var out = [];
    for (var i = 0; i < data.length; i++) {
      var c = data.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return new Uint8Array(out);
  }
  return new Uint8Array(data || []);
}
function fromU8(u8) { return RX ? RX.decode(u8) : String.fromCharCode.apply(null, u8); }

function dirOf(p) { return String(p).replace(/[^/\\]+[\\/]?$/, '') || '/'; }

module.exports = {
  readFileSync: function (p, enc) {
    var k = String(p);
    if (!(k in store)) { var e = new Error('ENOENT: no such file, open ' + k); e.code = 'ENOENT'; throw e; }
    var u8 = store[k];
    if (enc === 'utf8' || (enc && enc.encoding === 'utf8') || typeof enc === 'string' && enc !== 'buffer') return fromU8(u8);
    return u8;
  },
  writeFileSync: function (p, data) { store[String(p)] = toU8(data); },
  appendFileSync: function (p, data) {
    var k = String(p);
    store[k] = (k in store) ? (function () { var a = store[k], b = toU8(data); var o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; })() : toU8(data);
  },
  existsSync: function (p) { return String(p) in store; },
  mkdirSync: function () { /* 内存 fs：目录即空操作 */ },
  mkdir: function (o, cb) { if (typeof o === 'function') o(); else if (typeof cb === 'function') cb(); if (typeof o !== 'function' && typeof cb !== 'function') return Promise.resolve(); },
  rmSync: function (p) { delete store[String(p)]; },
  unlinkSync: function (p) { delete store[String(p)]; },
  readdirSync: function (p) {
    /* 内存 fs 不跟踪目录：按路径前缀聚合下一级条目（文件名或子目录名） */
    var dir = String(p).replace(/[\\/]+$/, '');
    var prefix = dir === '' ? '' : dir + '/';
    var seen = {};
    var out = [];
    Object.keys(store).forEach(function (k) {
      if (prefix !== '' && k.indexOf(prefix) !== 0) return;
      if (prefix === '' && /^[\\/]/.test(k)) return;
      var rest = k.slice(prefix.length);
      if (rest.length === 0) return;
      var m = /^([^\\/]+)/.exec(rest);
      var name = m[1];
      if (!(name in seen)) { seen[name] = true; out.push(name); }
    });
    return out;
  },
  statSync: function (p) {
    var exists = String(p) in store;
    if (!exists) { var e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; }
    var size = store[String(p)].length;
    return { size: size, isFile: function () { return true; }, isDirectory: function () { return false; }, mtime: new Date(), ctime: new Date() };
  },
  readFile: function (p, enc, cb) {
    if (typeof enc === 'function') { cb = enc; enc = undefined; }
    var out;
    try { out = this.readFileSync(p, enc); } catch (e) { if (cb) return cb(e); return Promise.reject(e); }
    if (cb) cb(null, out); else return Promise.resolve(out);
  },
  writeFile: function (p, data, cb) {
    var out;
    try { this.writeFileSync(p, data); out = undefined; } catch (e) { if (cb) return cb(e); return Promise.reject(e); }
    if (cb) cb(null); else return Promise.resolve();
  },
  unlink: function (p, cb) { delete store[String(p)]; if (cb) cb(null); else return Promise.resolve(); },
  createReadStream: function (p, opts) {
    var S = require('./shim-stream.js');
    var k = String(p);
    var r = new S.Readable();
    nextTickAsync(function () {
      if (!(k in store)) { r.emit('error', new Error('ENOENT: ' + k)); r.push(null); return; }
      r.push(store[k]);
      r.push(null);
    });
    return r;
  },
  createWriteStream: function (p, opts) {
    var S = require('./shim-stream.js');
    var k = String(p);
    function WS() { S.Writable.call(this); }
    WS.prototype = Object.create(S.Writable.prototype);
    WS.prototype._write = function (chunk, enc, cb) {
      store[k] = (k in store) ? cat(store[k], typeof chunk === 'string' ? toU8(chunk) : new Uint8Array(chunk)) : (typeof chunk === 'string' ? toU8(chunk) : new Uint8Array(chunk));
      cb();
    };
    return new WS();
  },
  constants: {},
  promises: null,
};
var ReadableStub = null;
function nextTickAsync(fn) { Promise.resolve().then(fn); }
/* 延迟绑定 promises 面（stat 需要参数） */
Object.defineProperty(module.exports, 'promises', {
  get: function () {
    var self = this;
    return {
      readFile: function (p, enc) { return Promise.resolve(self.readFileSync(p, enc)); },
      writeFile: function (p, d) { self.writeFileSync(p, d); return Promise.resolve(); },
      unlink: function (p) { delete store[String(p)]; return Promise.resolve(); },
      mkdir: function () { return Promise.resolve(); },
      rm: function () { return Promise.resolve(); },
      stat: function (p) { return Promise.resolve(self.statSync(String(p))); },
    };
  },
});
function cat(a, b) { var o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }

};

/* ===== shim-zlib.js ===== */
__f['shim-zlib'] = function (module, exports, require) {
/* shim-zlib: pako 包装（bundle 内 vendor pako，沙盒侧用独立下载的 pako.min.js UMD） */
'use strict';

var pako = null;
function Pako() {
  if (pako) return pako;
  /* 沙盒/测试环境：./pako.min.js 与本文件同目录（build 时拷入） */
  pako = require('./pako.min.js');
  return pako;
}
var S = require('./shim-stream.js');

function syncThrough(syncFn, data, opts) {
  try { return syncFn(data, opts); }
  catch (e) { throw new Error('zlib: ' + (e && e.message || e)); }
}

/* 同步面（pako 无 gunzip，用 ungzip） */
function PakoGunzip() { var p = Pako(); return p.ungzip || p.inflate; }
module.exports.gunzipSync = function (data, opts) { return syncThrough(PakoGunzip(), data, opts); };
module.exports.gzipSync = function (data, opts) { return syncThrough(Pako().gzip, data, opts); };
module.exports.inflateSync = function (data, opts) { return syncThrough(Pako().inflate, data, opts); };
module.exports.deflateSync = function (data, opts) { return syncThrough(Pako().deflate, data, opts); };
module.exports.inflateRawSync = function (data, opts) { return syncThrough(Pako().inflateRaw, data, opts); };
module.exports.deflateRawSync = function (data, opts) { return syncThrough(Pako().deflateRaw, data, opts); };
module.exports.brotliDecompressSync = function () { throw new Error('shim-zlib: brotli not supported'); };
module.exports.brotliCompressSync = function () { throw new Error('shim-zlib: brotli not supported'); };

/* ---------------- 常量面（node:zlib constants；pako 不用 flush 参数，值按 node 数值表） ---------------- */
var constants = {
  /* flush codes */
  Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5, Z_TREES: 6,
  /* status codes */
  Z_OK: 0, Z_STREAM_END: 1, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6,
  /* compression level */
  Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1,
  /* strategy */
  Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0,
  /* deflate window bits */
  DEFLATE: 1, INFLATE: 2, GZIP: 3, GUNZIP: 4, DEFRAW: 5, INFLATERAW: 6, UNZIP: 7,
  Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15, Z_DEFAULT_WINDOWBITS: 15,
  Z_MIN_CHUNK: 64, Z_MAX_CHUNK: 16384, Z_DEFAULT_CHUNK: 16384,
  Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9, Z_DEFAULT_MEMLEVEL: 8,
  Z_MIN_STRATEGY: 0, Z_MAX_STRATEGY: 4,
  /* brotli（pako 无 brotli；值仅占位） */
  BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2, BROTLI_OPERATION_EMIT_METADATA: 3,
  BROTLI_PARAM_MODE: 0, BROTLI_PARAM_QUALITY: 6, BROTLI_PARAM_LGWIN: 7, BROTLI_PARAM_LGBLOCK: 8, BROTLI_PARAM_SIZE_HINT: 9,
  BROTLI_DECODER_RESULT_ERROR: 0, BROTLI_DECODER_RESULT_SUCCESS: 1, BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: 2, BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: 3,
  /* zstd（占位） */
  ZSTD_e_continue: 0, ZSTD_e_flush: 1, ZSTD_e_end: 2,
};

/* 顶层常量别名（node-fetch 直接读 zlib.Z_SYNC_FLUSH） */
Object.keys(constants).forEach(function (k) { module.exports[k] = constants[k]; });
module.exports.constants = constants;

/* 流式面：createGunzip/createGzip/createInflate/createDeflate → Transform，整段缓冲后同步解 */
function makeTransform(syncFn, name) {
  function Ctor(opts) {
    if (!(this instanceof Ctor)) return new Ctor(opts); /* node 工厂惯例：无 new 直调 */
    S.Transform.call(this, opts); this._acc = [];
  }
  Ctor.prototype = Object.create(S.Transform.prototype);
  Ctor.prototype.constructor = Ctor;
  Ctor.prototype._transform = function (chunk, enc, cb) { this._acc.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk)); cb(); };
  Ctor.prototype._flush = function (cb) {
    var total = this._acc.reduce(function (n, c) { return n + c.length; }, 0);
    var all = new Uint8Array(total), off = 0;
    this._acc.forEach(function (c) { all.set(c, off); off += c.length; });
    try { cb(null, syncFn(all)); }
    catch (e) { cb(e); }
  };
  return Ctor;
}
module.exports.createGunzip = makeTransform(function (d) { return PakoGunzip()(d); }, 'gunzip');
module.exports.createGzip = makeTransform(function (d) { return Pako().gzip(d); }, 'gzip');
module.exports.createInflate = makeTransform(function (d) { return Pako().inflate(d); }, 'inflate');
module.exports.createDeflate = makeTransform(function (d) { return Pako().deflate(d); }, 'deflate');
module.exports.createInflateRaw = makeTransform(function (d) { return Pako().inflateRaw(d); }, 'inflateRaw');
module.exports.createDeflateRaw = makeTransform(function (d) { return Pako().deflateRaw(d); }, 'deflateRaw');
/* node-fetch deflate 无头分支用 createUnzip：pako.inflate 自动探测 zlib/gzip 头 */
module.exports.createUnzip = module.exports.createInflate;
/* brotli：pako 不支持，保留函数形态（node-fetch 做 Boolean() 探测），调用即清晰报错 */
function brotliUnsupported(name) {
  return function () { throw new Error('shim-zlib: ' + name + ' not supported (pako has no brotli)'); };
}
module.exports.createBrotliDecompress = brotliUnsupported('createBrotliDecompress');
module.exports.createBrotliCompress = brotliUnsupported('createBrotliCompress');

};

/* ===== shim-http.js ===== */
__f['shim-http'] = function (module, exports, require) {
/* shim-http: node:http/https 桥接版（底层走宿主 fetch；node harness 用原生 fetch，ArkWeb 用 __catBridge fetch）
 * 覆盖面：request/get/Agent/STATUS_CODES/IncomingMessage/ClientRequest(Data 拼装)；不做 server
 */
'use strict';
var S = require('./shim-stream.js');
var core = require('./shim-core.js');
var EE = core.EE;

function toBuf(chunk) {
  if (chunk === undefined || chunk === null) return null;
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') {
    var out = [];
    for (var i = 0; i < chunk.length; i++) {
      var code = chunk.charCodeAt(i);
      if (code < 0x80) out.push(code);
      else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      else if (code < 0xd800 || code > 0xdfff) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      else { code = 0x10000 + (((code - 0xd800) << 10) | (chunk.charCodeAt(++i) - 0xdc00)); out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)); }
    }
    return new Uint8Array(out);
  }
  if (chunk && typeof chunk.length === 'number') return new Uint8Array(chunk);
  return null;
}
function cat(a, b) {
  if (!a || a.length === 0) return b;
  if (!b || b.length === 0) return a;
  var o = new Uint8Array(a.length + b.length);
  o.set(a); o.set(b, a.length);
  return o;
}

/* ---------------- STATUS_CODES ---------------- */
var STATUS_CODES = {
  100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created', 202: 'Accepted',
  203: 'Non-Authoritative Information', 204: 'No Content', 205: 'Reset Content', 206: 'Partial Content',
  300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified',
  305: 'Use Proxy', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 406: 'Not Acceptable', 407: 'Proxy Authentication Required', 408: 'Request Timeout',
  409: 'Conflict', 410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Payload Too Large',
  414: 'URI Too Long', 415: 'Unsupported Media Type', 416: 'Range Not Satisfiable', 417: 'Expectation Failed',
  418: 'I\'m a Teapot', 421: 'Misdirected Request', 422: 'Unprocessable Entity', 423: 'Locked', 424: 'Failed Dependency',
  425: 'Too Early', 426: 'Upgrade Required', 428: 'Precondition Required', 429: 'Too Many Requests',
  431: 'Request Header Fields Too Large', 451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable',
  504: 'Gateway Timeout', 505: 'HTTP Version Not Supported', 506: 'Variant Also Negotiates',
  507: 'Insufficient Storage', 508: 'Loop Detected', 510: 'Not Extended', 511: 'Network Authentication Required',
};

/* ---------------- Agent（node-fetch 探测 instanceof http.Agent） ---------------- */
function Agent(opts) { if (!(this instanceof Agent)) return new Agent(opts); Object.assign(this, { keepAlive: !!(opts && opts.keepAlive), maxSockets: (opts && opts.maxSockets) || Infinity, options: opts || {} }); }
Agent.prototype.destroy = function () { };

/* ---------------- IncomingMessage ---------------- */
function IncomingMessage(req, res, underlying) {
  S.Readable.call(this);
  this.statusCode = res ? res.status : 0;
  this.statusMessage = STATUS_CODES[this.statusCode] || '';
  this.req = req;
  this.httpVersion = '1.1';
  this.rawHeaders = [];
  this.headers = {};
  var hk = (res && res.headers) || {};
  for (var k in hk) this.headers[String(k).toLowerCase()] = hk[k];
  this.socket = { remoteAddress: '0.0.0.0', remotePort: 0, bytesRead: 0, bytesWritten: 0, end: function () { } };
  this.underlying = underlying; /* 底层 fetch Response 或 OpenHarmony 桥接对象 */
}
IncomingMessage.prototype = Object.create(S.Readable.prototype);
IncomingMessage.prototype.constructor = IncomingMessage;
/* 响应体已在 dispatch 到达：push 全量 + null */
IncomingMessage.prototype._attachBody = function (u8) {
  if (u8 && u8.length) this.push(u8);
  this.push(null);
};
/* node-fetch 的 res.headers.get 调用：IncomingMessage.headers 是对象，node-fetch 会自己包装；但重定向/压缩探测可能直接 读 headers['location'] 小写 ✓ */
IncomingMessage.prototype.getHeaderNames = function () { return Object.keys(this.headers); };

/* ---------------- ClientRequest ---------------- */
var reqSeq = 0;
/* follow-redirects 要求 socket 是带 setTimeout/removeListener/addListener 的完整 EE，
 * 且监听 'socket' 事件挂超时 —— socket 用真 EE，超时定时器放在 socket 上 */
function makeSocket(host) {
  var sk = new EE();
  sk.remoteAddress = '0.0.0.0';
  sk.remotePort = 0;
  sk.bytesRead = 0;
  sk.bytesWritten = 0;
  sk.writable = true;
  sk.readable = false;
  sk.destroyed = false;
  sk._timeoutId = null;
  sk.setTimeout = function (ms, cb) {
    if (cb) sk.once('timeout', cb);
    if (sk._timeoutId) clearTimeout(sk._timeoutId);
    if (ms > 0) sk._timeoutId = setTimeout(function () { sk.emit('timeout'); }, ms);
    return sk;
  };
  sk.setKeepAlive = function () { return sk; };
  sk.setNoDelay = function () { return sk; };
  sk.end = function () { };
  sk.destroy = function () { sk.destroyed = true; if (sk._timeoutId) clearTimeout(sk._timeoutId); if (host && host.destroy) host.destroy(); };
  sk.address = function () { return { address: '0.0.0.0', port: 0 } };
  return sk;
}

function ClientRequest(options, cb) {
  EE.call(this);
  var self = this;
  this._id = ++reqSeq;
  if (typeof options === 'string' || options instanceof URL) {
    options = { url: String(options) };
  }
  this._opts = options;
  this.method = options.method || 'GET';
  this._url = options.url || null;
  this._body = null;
  this._cb = null;
  this._aborted = false;
  this._disposed = false;
  if (cb) this.on('response', cb);
  this.socket = makeSocket(this);
  this.agent = options.agent || null;
  /* follow-redirects 挂 socket 监听：ready 时发 'socket' */
  setImmediate(function () { if (!self._disposed) self.emit('socket', self.socket); });
}
ClientRequest.prototype = Object.create(EE.prototype);
ClientRequest.prototype.constructor = ClientRequest;
ClientRequest.prototype.abort = function () { return this.destroy(new Error('aborted')); };
ClientRequest.prototype.destroy = function (err) {
  if (this._disposed) return this;
  this._disposed = true;
  this._aborted = true;
  if (this.controller) { try { this.controller.abort(); } catch (e) { } }
  if (err) this.emit('error', err);
  this.emit('close');
  return this;
};
ClientRequest.prototype.setHeader = function (name, value) {
  (this._opts.headers = this._opts.headers || {})[String(name)] = value;
  return this;
};
ClientRequest.prototype.getHeader = function (name) { return (this._opts.headers || {})[String(name)]; };
ClientRequest.prototype.removeHeader = function (name) { var h = this._opts.headers || {}; delete h[String(name)]; return this; };
ClientRequest.prototype.getHeaders = function () { return Object.assign({}, this._opts.headers || {}); };
ClientRequest.prototype.setNoDelay = function () { return this; };
ClientRequest.prototype.setSocketKeepAlive = function () { return this; };
ClientRequest.prototype.setKeepAlive = function () { return this; };
ClientRequest.prototype.flushHeaders = function () { return this; };
ClientRequest.prototype._ending = false;
ClientRequest.prototype.end = function (chunk, enc, cb) {
  var self = this;
  if (typeof enc === 'function') { cb = enc; enc = undefined; }
  if (chunk !== undefined && chunk !== null) {
    var part = toBuf(chunk);
    this._body = cat(this._body, part);
  }
  if (cb) this.once('response', cb);
  if (this._ending) { return this; }
  this._ending = true;
  this._dispatch();
  return this;
};
ClientRequest.prototype.write = function (chunk, enc, cb) {
  var part = toBuf(chunk);
  this._body = cat(this._body, part);
  if (cb) setImmediate(cb);
  return true;
};
ClientRequest.prototype.setTimeout = function (ms, cb) {
  if (cb) this.on('timeout', cb);
  if (this._timeoutId) clearTimeout(this._timeoutId);
  this._timeout = ms;
  if (ms > 0) {
    var self = this;
    this._timeoutId = setTimeout(function () { self.emit('timeout'); }, ms);
  }
  return this;
};

ClientRequest.prototype._dispatch = function () {
  var self = this;
  var doFetch = resolveDispatch();
  if (!doFetch) {
    var err = new Error('[shim-http] no fetch bridge on this host');
    return setImmediate(function () {
      self.emit('error', err);
      self.emit('close');
    });
  }
  if (this._aborted || this._disposed) return;
  /* URL 解析 */
  var href = this._url;
  if (!href) {
    var o = this._opts;
    href = (o.protocol || 'http:') + '//' + (o.hostname || (o.host || '127.0.0.1')) + (o.port ? ':' + o.port : '') + (o.path || '/');
    if (!/^https?:/.test(href.slice(0, 6))) href = (o.port === 443 ? 'https:' : 'http:') + '//' + (o.hostname || o.host) + (o.port ? ':' + o.port : '') + (o.path || '/');
    this._url = href;
  }
  var headers = Object.assign({}, this._opts.headers || {});
  /* Host 头不透传（浏览器/bridge 自带） */
  delete headers.host; delete headers.Host;
  var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  this.controller = ctrl;
  var init = { method: this.method.toUpperCase(), headers: headers, redirect: 'follow' };
  if (this._body && this._body.length > 0 && init.method !== 'GET' && init.method !== 'HEAD') init.body = this._body;
  if (ctrl) init.signal = ctrl.signal;
  if (this._timeout > 0) {
    var self2 = this;
    this._timeoutId = setTimeout(function () {
      self2.emit('timeout');
      self2.destroy(new Error('request timeout ' + self2._url));
    }, self2._timeout);
  }
  Promise.resolve()
    .then(function () { return doFetch(self._url, init); })
    .then(function (res) {
      if (self._disposed) return;
      if (self._timeoutId) clearTimeout(self._timeoutId);
      var im = new IncomingMessage(self, res, res);
      setImmediate(function () {
        try { self.emit('response', im); } catch (e) { self.emit('error', e); }
      });
      /* body 到达源 */
      var bodyDone = false;
      /* 桥 body 是最终字节：宿主栈（undici/ArkTS netstack）可能已透明解压 gzip/deflate，
       * 而响应头仍保留 content-encoding —— 不剥掉 axios fork 会二次 inflate（pako 抛错 → 500）。
       * 判定：声明编码的魔数与实际 body 不符 → 宿主已解压 → 剥 encoding/length 头。
       * br 无魔数无法判定（identity 协商 + 保留头 → 不匹配时走显式报错路径）。 */
      function reconcileEncodingHeaders(im2, u8) {
        try {
          var h = im2.headers || {};
          var ce = String(h['content-encoding'] || h['Content-Encoding'] || '').toLowerCase();
          var ok;
          if (ce === 'gzip') ok = u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b;
          else if (ce === 'deflate') ok = u8.length >= 1 && u8[0] === 0x78;
          else return;
          if (!ok) {
            delete h['content-encoding']; delete h['Content-Encoding'];
            delete h['content-length']; delete h['Content-Length'];
          }
        } catch (e) { }
      }
      function tryPush(u8) {
        if (bodyDone || self._disposed) return;
        bodyDone = true;
        reconcileEncodingHeaders(im, u8);
        im._attachBody(u8);
      }
      if (res && typeof res.arrayBuffer === 'function') {
        res.arrayBuffer().then(function (ab) { tryPush(new Uint8Array(ab)); }, function (e) { bodyDone = true; im.push(null); if (!self._disposed) self.emit('error', e); });
      } else if (res && res.body && typeof res.body.then === 'function') {
        res.body.then(function (b64) { tryPush(b64 ? b64FromBridge(b64) : new Uint8Array(0)); }, function (e) { bodyDone = true; im.push(null); if (!self._disposed) self.emit('error', e); });
      } else {
        tryPush(new Uint8Array(0));
      }
    })
    .catch(function (err) {
      if (self._disposed) return;
      if (self._timeoutId) clearTimeout(self._timeoutId);
      setImmediate(function () {
        var e = new Error('request failed: ' + (err && (err.message || err)) + ' url=' + self._url);
        e.cause = err;
        self.emit('error', e);
        self.emit('close');
      });
    });
};
function b64FromBridge(b64) {
  var bin = globalThis.atob ? globalThis.atob(b64) : '';
  var u8 = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i) & 0xff;
  return u8;
}

/* fetch 分发器：ArkWeb/沙盒 → __catBridge；node harness → 原生 fetch。
 * 注意 __catBridge 必须优先：bundle 适配层会把 globalThis.fetch 覆盖为 node-fetch
 * 自实现（内部走 http.request → 本模块），fetch 优先会无限递归 eb→dispatch→eb。 */
function resolveDispatch() {
  var host = globalThis;
  if (typeof host.__catBridgeFetch === 'function') {
    return function (url, init) { return Promise.resolve(host.__catBridgeFetch(url, init)); };
  }
  if (typeof host.fetch === 'function') {
    var nativeFetch = host.fetch;
    return function (url, init) { return Promise.resolve(nativeFetch.call(host, url, init)); };
  }
  return null;
}

/* ---------------- 模块面 ---------------- */
function makeHttpLib(defaultPort, defaultProtocol) {
  function parseTarget(target) {
    if (typeof target !== 'string' && !(target instanceof URL)) return null;
    var href = String(target);
    if (/^https?:\/\//i.test(href)) return { url: href };
    return null;
  }
  function request(target, options, cb) {
    if (typeof target === 'string' || target instanceof URL) {
      var p = parseTarget(target);
      var oo = Object.assign({}, p, options && typeof options === 'object' ? options : {});
      if (typeof options === 'function') { cb = options; }
      if (p && p.url && options && typeof options === 'object') oo.url = p.url;
      return new ClientRequest(oo, cb);
    }
    var opts = Object.assign({}, target, typeof options === 'object' && options ? options : {});
    if (typeof options === 'function') { cb = options; }
    if (!opts.protocol) opts.protocol = defaultProtocol;
    if (opts.port === 443 && defaultProtocol === 'https:') opts.protocol = 'https:';
    if (opts.hostname && opts.port !== undefined && String(opts.port) !== String(defaultPort) && !opts.url) {
      /* 保持 opts；_dispatch 按 protocol 拼 */
    }
    return new ClientRequest(opts, cb);
  }
  function get(target, options, cb) {
    var req = request(target, options, cb);
    req.end && req.end.call ? req : req; /* get 自动 end：先收集 cb */
    return req;
  }
  /* get 特例：http.get(opts, cb) —— cb 通过 request 传；这里 end */
  return {
    request: request,
    get: function (target, options, cb) {
      var cbb = cb;
      if (typeof options === 'function') { cbb = options; options = undefined; }
      var req = request(target, options, cbb);
      req.end();
      return req;
    },
    Agent: Agent,
    globalAgent: new Agent({ keepAlive: false }),
    ClientRequest: ClientRequest,
    IncomingMessage: IncomingMessage,
    STATUS_CODES: STATUS_CODES,
    defaultMaxHeaderSize: 16384,
    maxHeaderSize: 16384,
    outHeadersKey: Symbol(),
    Server: function () { throw new Error('shim-http: Server not supported (serverFactory 模式无需)'); },
    createServer: function () { throw new Error('shim-http: createServer not supported (serverFactory 模式无需)'); },
    validateHeaderName: function () { },
    validateHeaderValue: function () { },
    setMaxIdleHTTPParsers: function () { },
  };
}

module.exports = {
  http: makeHttpLib(80, 'http:'),
  https: makeHttpLib(443, 'https:'),
  STATUS_CODES: STATUS_CODES,
};

};

/* ===== shim-stubs.js ===== */
__f['shim-stubs'] = function (module, exports, require) {
/* shim-stubs: net/tls/dns/tty/http2/worker_threads/async_hooks/diagnostics_channel/perf_hooks/module/
 *   url/querystring/string_decoder/timers-promises —— 快件合辑（按 bundle require 面逐个实现/stub） */
'use strict';

/* ---------------- url（原生 URL/URLSearchParams + node 兼容函数） ---------------- */
var url = {
  URL: typeof URL !== 'undefined' ? URL : undefined,
  URLSearchParams: typeof URLSearchParams !== 'undefined' ? URLSearchParams : undefined,
  parse: function (u, sep) {
    var s = String(u || '');
    var m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)?(?:\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(s);
    var proto = m[1] || '', hostPart = m[2] || '', pathPart = m[3] || '', query = m[4] || '', hash = m[5] || '';
    var auth = null, hostname = hostPart, port = null;
    var atIdx = hostPart.lastIndexOf('@');
    if (atIdx >= 0) { auth = hostPart.slice(0, atIdx); hostname = hostPart.slice(atIdx + 1); }
    var colon = hostname.indexOf(':');
    if (colon >= 0 && hostname.indexOf(']', colon) < 0) { port = hostname.slice(colon + 1); hostname = hostname.slice(0, colon); }
    return {
      protocol: proto,
      slashes: hostPart !== undefined && hostPart !== '' ? true : false,
      auth: auth,
      host: hostPart,
      port: port,
      hostname: hostname,
      hash: hash,
      search: query,
      query: query ? query.slice(1) : null,
      pathname: pathPart,
      path: pathPart + query,
      href: s,
    };
  },
  format: function (o) { return typeof o === 'string' ? o : (o && o.href) || String(o); },
  resolve: function (from, to) {
    var b = new URL(String(to), String(from));
    return b.href;
  },
  domainToASCII: function (d) { return d; },
  domainToUnicode: function (d) { return d; },
};

/* ---------------- querystring ---------------- */
var querystring = {
  parse: function (str, sep, eq2, opts) {
    var out = {};
    var sp = new URLSearchParams(String(str || ''));
    sp.forEach(function (v, k) {
      if (k in out) { if (Array.isArray(out[k])) out[k].push(v); else out[k] = [out[k], v]; }
      else out[k] = v;
    });
    return out;
  },
  stringify: function (obj) {
    var sp = new URLSearchParams();
    Object.keys(obj || {}).forEach(function (k) {
      var v = obj[k];
      if (Array.isArray(v)) v.forEach(function (x) { sp.append(k, String(x)); });
      else if (v !== undefined && v !== null) sp.append(k, String(v));
    });
    return sp.toString();
  },
  escape: function (s) { return encodeURIComponent(s); },
  unescape: function (s) { return decodeURIComponent(s); },
};

/* ---------------- string_decoder ---------------- */
function StringDecoder(enc) {
  this._enc = enc || 'utf8';
  this._td = typeof TextDecoder !== 'undefined' ? new TextDecoder(this._enc === 'utf8' ? 'utf-8' : this._enc, { stream: true }) : null;
}
StringDecoder.prototype.write = function (buf) {
  if (!buf || buf.length === 0) return '';
  if (this._td) return this._td.decode(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  var s = '';
  for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
};
StringDecoder.prototype.end = function (buf) {
  if (buf && buf.length && this._td) return this._td.decode(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  if (this._td) return this._td.decode();
  return '';
};

/* ---------------- dns ---------------- */
function dnsLookupStub(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = undefined; }
  var err = new Error('shim-dns: lookup not supported (' + host + ')');
  if (cb) { cb(err); return; }
  return Promise.reject(err);
}
var dns = { lookup: dnsLookupStub, resolve: dnsLookupStub, resolve4: dnsLookupStub, resolve6: dnsLookupStub, getServers: function () { return []; }, promises: { lookup: dnsLookupStub, resolve: dnsLookupStub } };

/* ---------------- net / tls / http2 ---------------- */
function errCtor(name) {
  return function () { throw new Error('shim: ' + name + ' is not supported in this sandbox'); };
}
var net = {
  Socket: (function () { function S() { throw new Error('shim: net.Socket not supported'); } return S; })(),
  connect: errCtor('net.connect'),
  createConnection: errCtor('net.createConnection'),
  Server: errCtor('net.Server'),
  isIP: function (v) { return /^(\d{1,3}\.){3}\d{1,3}$/.test(String(v)) ? 4 : 0; },
};
var tls = {
  connect: errCtor('tls.connect'),
  Server: errCtor('tls.Server'),
  TLSSocket: errCtor('tls.TLSSocket'),
  createSecureContext: function () { return {}; },
  constants: {},
  rootCertificates: [],
};
var http2 = {
  connect: errCtor('http2.connect'),
  constants: {},
  createServer: errCtor('http2.createServer'),
};

/* ---------------- tty ---------------- */
var tty = { isatty: function () { return false; }, WriteStream: function () { throw new Error('shim: tty.WriteStream not supported'); }, ReadStream: function () { throw new Error('shim: tty.ReadStream not supported'); } };

/* ---------------- worker_threads ---------------- */
var worker_threads = {
  Worker: (function () {
    function W(fn) { throw new Error('shim: worker_threads.Worker not supported in this sandbox'); }
    return W;
  })(),
  isMainThread: true,
  threadId: 1,
  parentPort: { on: function () { }, postMessage: function () { } },
  workerData: null,
  MessageChannel: function () { this.port1 = { on: function () { }, postMessage: function () { }, close: function () { } }; this.port2 = { on: function () { }, postMessage: function () { }, close: function () { } }; },
  MessagePort: function () { },
  receivesMessageOnPort: function () { return false; },
};

/* ---------------- async_hooks ---------------- */
var async_hooks = {
  createHook: function () { return { enable: function () { return this; }, disable: function () { return this; } }; },
  AsyncLocalStorage: (function () {
    function ALS() { }
    ALS.prototype.run = function (store, cb) { var old = ALS._cur; ALS._cur = store; try { return cb(); } finally { ALS._cur = old; } };
    ALS.prototype.getStore = function () { return ALS._cur; };
    ALS.prototype.enterWith = function (s) { ALS._cur = s; };
    ALS._cur = undefined;
    return ALS;
  })(),
  AsyncResource: (function () {
    function AR(type, opts) { this.type = type; this._ar = { asyncId: 1, triggerAsyncId: 0 }; }
    AR.prototype.runInAsyncScope = function (fn) { return fn.apply(this, Array.prototype.slice.call(arguments, 2)); };
    AR.prototype.emitDestroy = function () { return this; };
    AR.prototype.asyncId = function () { return 1; };
    AR.prototype.triggerAsyncId = function () { return 0; };
    AR.prototype.bind = function (fn) { return fn.bind(this); };
    AR.bind = function (fn, self) { return self ? fn.bind(self) : fn; };
    return AR;
  })(),
};

/* ---------------- diagnostics_channel ---------------- */
var chans = {};
var diagnostics_channel = {
  subscribe: function (name, cb) { (chans[name] = chans[name] || []).push(cb); return true; },
  unsubscribe: function (name, cb) { var a = chans[name] || []; var i = a.indexOf(cb); if (i >= 0) { a.splice(i, 1); return true; } return false; },
  hasSubscribers: function (name) { return !!((chans[name] || []).length); },
  channel: function (name) {
    return {
      subscribe: function (cb) { diagnostics_channel.subscribe(name, cb); },
      unsubscribe: function (cb) { diagnostics_channel.unsubscribe(name, cb); },
      hasSubscribers: function () { return diagnostics_channel.hasSubscribers(name); },
      publish: function () { },
      bindStore: function () { },
      unbindStore: function () { },
    };
  },
};

/* ---------------- perf_hooks ---------------- */
var perf_hooks = {
  performance: (typeof performance !== 'undefined') ? performance : { now: function () { return Date.now(); } },
  PerformanceObserver: function () { throw new Error('shim: PerformanceObserver not supported'); },
  monitorEventLoopDelay: function () { throw new Error('shim: monitorEventLoopDelay not supported'); },
};

/* ---------------- module ---------------- */
var moduleStub = {
  createRequire: function () {
    return function requireStub() { throw new Error('shim: module.createRequire is not supported in this sandbox'); };
  },
  builtinModules: [],
};

/* ---------------- timers/promises ---------------- */
var timersPromises = {
  setTimeout: function (ms) { var val = arguments[1]; return new Promise(function (r) { setTimeout(function () { r(val); }, ms); }); },
  setImmediate: function (val) { return new Promise(function (r) { (typeof setImmediate === 'function' ? setImmediate : function (f) { setTimeout(f, 0); })(function () { r(val); }); }); },
  setInterval: function (ms, val) { return new Promise(function () { }); },
};

module.exports = {
  url: url,
  querystring: querystring,
  StringDecoder: StringDecoder,
  dns: dns,
  net: net,
  tls: tls,
  http2: http2,
  tty: tty,
  worker_threads: worker_threads,
  async_hooks: async_hooks,
  diagnostics_channel: diagnostics_channel,
  perf_hooks: perf_hooks,
  module: moduleStub,
  timersPromises: timersPromises,
};

};

/* ===== pako.min.js ===== */
__f['pako.min'] = function (module, exports, require) {
/*! pako 2.1.0 https://github.com/nodeca/pako @license (MIT AND Zlib) */
!function(t,e){"object"==typeof exports&&"undefined"!=typeof module?e(exports):"function"==typeof define&&define.amd?define(["exports"],e):e((t="undefined"!=typeof globalThis?globalThis:t||self).pako={})}(this,(function(t){"use strict";function e(t){let e=t.length;for(;--e>=0;)t[e]=0}const a=256,i=286,n=30,s=15,r=new Uint8Array([0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0]),o=new Uint8Array([0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13]),l=new Uint8Array([0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,3,7]),h=new Uint8Array([16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15]),d=new Array(576);e(d);const _=new Array(60);e(_);const f=new Array(512);e(f);const c=new Array(256);e(c);const u=new Array(29);e(u);const w=new Array(n);function m(t,e,a,i,n){this.static_tree=t,this.extra_bits=e,this.extra_base=a,this.elems=i,this.max_length=n,this.has_stree=t&&t.length}let b,g,p;function k(t,e){this.dyn_tree=t,this.max_code=0,this.stat_desc=e}e(w);const v=t=>t<256?f[t]:f[256+(t>>>7)],y=(t,e)=>{t.pending_buf[t.pending++]=255&e,t.pending_buf[t.pending++]=e>>>8&255},x=(t,e,a)=>{t.bi_valid>16-a?(t.bi_buf|=e<<t.bi_valid&65535,y(t,t.bi_buf),t.bi_buf=e>>16-t.bi_valid,t.bi_valid+=a-16):(t.bi_buf|=e<<t.bi_valid&65535,t.bi_valid+=a)},z=(t,e,a)=>{x(t,a[2*e],a[2*e+1])},A=(t,e)=>{let a=0;do{a|=1&t,t>>>=1,a<<=1}while(--e>0);return a>>>1},E=(t,e,a)=>{const i=new Array(16);let n,r,o=0;for(n=1;n<=s;n++)o=o+a[n-1]<<1,i[n]=o;for(r=0;r<=e;r++){let e=t[2*r+1];0!==e&&(t[2*r]=A(i[e]++,e))}},R=t=>{let e;for(e=0;e<i;e++)t.dyn_ltree[2*e]=0;for(e=0;e<n;e++)t.dyn_dtree[2*e]=0;for(e=0;e<19;e++)t.bl_tree[2*e]=0;t.dyn_ltree[512]=1,t.opt_len=t.static_len=0,t.sym_next=t.matches=0},Z=t=>{t.bi_valid>8?y(t,t.bi_buf):t.bi_valid>0&&(t.pending_buf[t.pending++]=t.bi_buf),t.bi_buf=0,t.bi_valid=0},U=(t,e,a,i)=>{const n=2*e,s=2*a;return t[n]<t[s]||t[n]===t[s]&&i[e]<=i[a]},S=(t,e,a)=>{const i=t.heap[a];let n=a<<1;for(;n<=t.heap_len&&(n<t.heap_len&&U(e,t.heap[n+1],t.heap[n],t.depth)&&n++,!U(e,i,t.heap[n],t.depth));)t.heap[a]=t.heap[n],a=n,n<<=1;t.heap[a]=i},D=(t,e,i)=>{let n,s,l,h,d=0;if(0!==t.sym_next)do{n=255&t.pending_buf[t.sym_buf+d++],n+=(255&t.pending_buf[t.sym_buf+d++])<<8,s=t.pending_buf[t.sym_buf+d++],0===n?z(t,s,e):(l=c[s],z(t,l+a+1,e),h=r[l],0!==h&&(s-=u[l],x(t,s,h)),n--,l=v(n),z(t,l,i),h=o[l],0!==h&&(n-=w[l],x(t,n,h)))}while(d<t.sym_next);z(t,256,e)},T=(t,e)=>{const a=e.dyn_tree,i=e.stat_desc.static_tree,n=e.stat_desc.has_stree,r=e.stat_desc.elems;let o,l,h,d=-1;for(t.heap_len=0,t.heap_max=573,o=0;o<r;o++)0!==a[2*o]?(t.heap[++t.heap_len]=d=o,t.depth[o]=0):a[2*o+1]=0;for(;t.heap_len<2;)h=t.heap[++t.heap_len]=d<2?++d:0,a[2*h]=1,t.depth[h]=0,t.opt_len--,n&&(t.static_len-=i[2*h+1]);for(e.max_code=d,o=t.heap_len>>1;o>=1;o--)S(t,a,o);h=r;do{o=t.heap[1],t.heap[1]=t.heap[t.heap_len--],S(t,a,1),l=t.heap[1],t.heap[--t.heap_max]=o,t.heap[--t.heap_max]=l,a[2*h]=a[2*o]+a[2*l],t.depth[h]=(t.depth[o]>=t.depth[l]?t.depth[o]:t.depth[l])+1,a[2*o+1]=a[2*l+1]=h,t.heap[1]=h++,S(t,a,1)}while(t.heap_len>=2);t.heap[--t.heap_max]=t.heap[1],((t,e)=>{const a=e.dyn_tree,i=e.max_code,n=e.stat_desc.static_tree,r=e.stat_desc.has_stree,o=e.stat_desc.extra_bits,l=e.stat_desc.extra_base,h=e.stat_desc.max_length;let d,_,f,c,u,w,m=0;for(c=0;c<=s;c++)t.bl_count[c]=0;for(a[2*t.heap[t.heap_max]+1]=0,d=t.heap_max+1;d<573;d++)_=t.heap[d],c=a[2*a[2*_+1]+1]+1,c>h&&(c=h,m++),a[2*_+1]=c,_>i||(t.bl_count[c]++,u=0,_>=l&&(u=o[_-l]),w=a[2*_],t.opt_len+=w*(c+u),r&&(t.static_len+=w*(n[2*_+1]+u)));if(0!==m){do{for(c=h-1;0===t.bl_count[c];)c--;t.bl_count[c]--,t.bl_count[c+1]+=2,t.bl_count[h]--,m-=2}while(m>0);for(c=h;0!==c;c--)for(_=t.bl_count[c];0!==_;)f=t.heap[--d],f>i||(a[2*f+1]!==c&&(t.opt_len+=(c-a[2*f+1])*a[2*f],a[2*f+1]=c),_--)}})(t,e),E(a,d,t.bl_count)},O=(t,e,a)=>{let i,n,s=-1,r=e[1],o=0,l=7,h=4;for(0===r&&(l=138,h=3),e[2*(a+1)+1]=65535,i=0;i<=a;i++)n=r,r=e[2*(i+1)+1],++o<l&&n===r||(o<h?t.bl_tree[2*n]+=o:0!==n?(n!==s&&t.bl_tree[2*n]++,t.bl_tree[32]++):o<=10?t.bl_tree[34]++:t.bl_tree[36]++,o=0,s=n,0===r?(l=138,h=3):n===r?(l=6,h=3):(l=7,h=4))},I=(t,e,a)=>{let i,n,s=-1,r=e[1],o=0,l=7,h=4;for(0===r&&(l=138,h=3),i=0;i<=a;i++)if(n=r,r=e[2*(i+1)+1],!(++o<l&&n===r)){if(o<h)do{z(t,n,t.bl_tree)}while(0!=--o);else 0!==n?(n!==s&&(z(t,n,t.bl_tree),o--),z(t,16,t.bl_tree),x(t,o-3,2)):o<=10?(z(t,17,t.bl_tree),x(t,o-3,3)):(z(t,18,t.bl_tree),x(t,o-11,7));o=0,s=n,0===r?(l=138,h=3):n===r?(l=6,h=3):(l=7,h=4)}};let F=!1;const L=(t,e,a,i)=>{x(t,0+(i?1:0),3),Z(t),y(t,a),y(t,~a),a&&t.pending_buf.set(t.window.subarray(e,e+a),t.pending),t.pending+=a};var N=(t,e,i,n)=>{let s,r,o=0;t.level>0?(2===t.strm.data_type&&(t.strm.data_type=(t=>{let e,i=4093624447;for(e=0;e<=31;e++,i>>>=1)if(1&i&&0!==t.dyn_ltree[2*e])return 0;if(0!==t.dyn_ltree[18]||0!==t.dyn_ltree[20]||0!==t.dyn_ltree[26])return 1;for(e=32;e<a;e++)if(0!==t.dyn_ltree[2*e])return 1;return 0})(t)),T(t,t.l_desc),T(t,t.d_desc),o=(t=>{let e;for(O(t,t.dyn_ltree,t.l_desc.max_code),O(t,t.dyn_dtree,t.d_desc.max_code),T(t,t.bl_desc),e=18;e>=3&&0===t.bl_tree[2*h[e]+1];e--);return t.opt_len+=3*(e+1)+5+5+4,e})(t),s=t.opt_len+3+7>>>3,r=t.static_len+3+7>>>3,r<=s&&(s=r)):s=r=i+5,i+4<=s&&-1!==e?L(t,e,i,n):4===t.strategy||r===s?(x(t,2+(n?1:0),3),D(t,d,_)):(x(t,4+(n?1:0),3),((t,e,a,i)=>{let n;for(x(t,e-257,5),x(t,a-1,5),x(t,i-4,4),n=0;n<i;n++)x(t,t.bl_tree[2*h[n]+1],3);I(t,t.dyn_ltree,e-1),I(t,t.dyn_dtree,a-1)})(t,t.l_desc.max_code+1,t.d_desc.max_code+1,o+1),D(t,t.dyn_ltree,t.dyn_dtree)),R(t),n&&Z(t)},B={_tr_init:t=>{F||((()=>{let t,e,a,h,k;const v=new Array(16);for(a=0,h=0;h<28;h++)for(u[h]=a,t=0;t<1<<r[h];t++)c[a++]=h;for(c[a-1]=h,k=0,h=0;h<16;h++)for(w[h]=k,t=0;t<1<<o[h];t++)f[k++]=h;for(k>>=7;h<n;h++)for(w[h]=k<<7,t=0;t<1<<o[h]-7;t++)f[256+k++]=h;for(e=0;e<=s;e++)v[e]=0;for(t=0;t<=143;)d[2*t+1]=8,t++,v[8]++;for(;t<=255;)d[2*t+1]=9,t++,v[9]++;for(;t<=279;)d[2*t+1]=7,t++,v[7]++;for(;t<=287;)d[2*t+1]=8,t++,v[8]++;for(E(d,287,v),t=0;t<n;t++)_[2*t+1]=5,_[2*t]=A(t,5);b=new m(d,r,257,i,s),g=new m(_,o,0,n,s),p=new m(new Array(0),l,0,19,7)})(),F=!0),t.l_desc=new k(t.dyn_ltree,b),t.d_desc=new k(t.dyn_dtree,g),t.bl_desc=new k(t.bl_tree,p),t.bi_buf=0,t.bi_valid=0,R(t)},_tr_stored_block:L,_tr_flush_block:N,_tr_tally:(t,e,i)=>(t.pending_buf[t.sym_buf+t.sym_next++]=e,t.pending_buf[t.sym_buf+t.sym_next++]=e>>8,t.pending_buf[t.sym_buf+t.sym_next++]=i,0===e?t.dyn_ltree[2*i]++:(t.matches++,e--,t.dyn_ltree[2*(c[i]+a+1)]++,t.dyn_dtree[2*v(e)]++),t.sym_next===t.sym_end),_tr_align:t=>{x(t,2,3),z(t,256,d),(t=>{16===t.bi_valid?(y(t,t.bi_buf),t.bi_buf=0,t.bi_valid=0):t.bi_valid>=8&&(t.pending_buf[t.pending++]=255&t.bi_buf,t.bi_buf>>=8,t.bi_valid-=8)})(t)}};var C=(t,e,a,i)=>{let n=65535&t|0,s=t>>>16&65535|0,r=0;for(;0!==a;){r=a>2e3?2e3:a,a-=r;do{n=n+e[i++]|0,s=s+n|0}while(--r);n%=65521,s%=65521}return n|s<<16|0};const M=new Uint32Array((()=>{let t,e=[];for(var a=0;a<256;a++){t=a;for(var i=0;i<8;i++)t=1&t?3988292384^t>>>1:t>>>1;e[a]=t}return e})());var H=(t,e,a,i)=>{const n=M,s=i+a;t^=-1;for(let a=i;a<s;a++)t=t>>>8^n[255&(t^e[a])];return-1^t},j={2:"need dictionary",1:"stream end",0:"","-1":"file error","-2":"stream error","-3":"data error","-4":"insufficient memory","-5":"buffer error","-6":"incompatible version"},K={Z_NO_FLUSH:0,Z_PARTIAL_FLUSH:1,Z_SYNC_FLUSH:2,Z_FULL_FLUSH:3,Z_FINISH:4,Z_BLOCK:5,Z_TREES:6,Z_OK:0,Z_STREAM_END:1,Z_NEED_DICT:2,Z_ERRNO:-1,Z_STREAM_ERROR:-2,Z_DATA_ERROR:-3,Z_MEM_ERROR:-4,Z_BUF_ERROR:-5,Z_NO_COMPRESSION:0,Z_BEST_SPEED:1,Z_BEST_COMPRESSION:9,Z_DEFAULT_COMPRESSION:-1,Z_FILTERED:1,Z_HUFFMAN_ONLY:2,Z_RLE:3,Z_FIXED:4,Z_DEFAULT_STRATEGY:0,Z_BINARY:0,Z_TEXT:1,Z_UNKNOWN:2,Z_DEFLATED:8};const{_tr_init:P,_tr_stored_block:Y,_tr_flush_block:G,_tr_tally:X,_tr_align:W}=B,{Z_NO_FLUSH:q,Z_PARTIAL_FLUSH:J,Z_FULL_FLUSH:Q,Z_FINISH:V,Z_BLOCK:$,Z_OK:tt,Z_STREAM_END:et,Z_STREAM_ERROR:at,Z_DATA_ERROR:it,Z_BUF_ERROR:nt,Z_DEFAULT_COMPRESSION:st,Z_FILTERED:rt,Z_HUFFMAN_ONLY:ot,Z_RLE:lt,Z_FIXED:ht,Z_DEFAULT_STRATEGY:dt,Z_UNKNOWN:_t,Z_DEFLATED:ft}=K,ct=258,ut=262,wt=42,mt=113,bt=666,gt=(t,e)=>(t.msg=j[e],e),pt=t=>2*t-(t>4?9:0),kt=t=>{let e=t.length;for(;--e>=0;)t[e]=0},vt=t=>{let e,a,i,n=t.w_size;e=t.hash_size,i=e;do{a=t.head[--i],t.head[i]=a>=n?a-n:0}while(--e);e=n,i=e;do{a=t.prev[--i],t.prev[i]=a>=n?a-n:0}while(--e)};let yt=(t,e,a)=>(e<<t.hash_shift^a)&t.hash_mask;const xt=t=>{const e=t.state;let a=e.pending;a>t.avail_out&&(a=t.avail_out),0!==a&&(t.output.set(e.pending_buf.subarray(e.pending_out,e.pending_out+a),t.next_out),t.next_out+=a,e.pending_out+=a,t.total_out+=a,t.avail_out-=a,e.pending-=a,0===e.pending&&(e.pending_out=0))},zt=(t,e)=>{G(t,t.block_start>=0?t.block_start:-1,t.strstart-t.block_start,e),t.block_start=t.strstart,xt(t.strm)},At=(t,e)=>{t.pending_buf[t.pending++]=e},Et=(t,e)=>{t.pending_buf[t.pending++]=e>>>8&255,t.pending_buf[t.pending++]=255&e},Rt=(t,e,a,i)=>{let n=t.avail_in;return n>i&&(n=i),0===n?0:(t.avail_in-=n,e.set(t.input.subarray(t.next_in,t.next_in+n),a),1===t.state.wrap?t.adler=C(t.adler,e,n,a):2===t.state.wrap&&(t.adler=H(t.adler,e,n,a)),t.next_in+=n,t.total_in+=n,n)},Zt=(t,e)=>{let a,i,n=t.max_chain_length,s=t.strstart,r=t.prev_length,o=t.nice_match;const l=t.strstart>t.w_size-ut?t.strstart-(t.w_size-ut):0,h=t.window,d=t.w_mask,_=t.prev,f=t.strstart+ct;let c=h[s+r-1],u=h[s+r];t.prev_length>=t.good_match&&(n>>=2),o>t.lookahead&&(o=t.lookahead);do{if(a=e,h[a+r]===u&&h[a+r-1]===c&&h[a]===h[s]&&h[++a]===h[s+1]){s+=2,a++;do{}while(h[++s]===h[++a]&&h[++s]===h[++a]&&h[++s]===h[++a]&&h[++s]===h[++a]&&h[++s]===h[++a]&&h[++s]===h[++a]&&h[++s]===h[++a]&&h[++s]===h[++a]&&s<f);if(i=ct-(f-s),s=f-ct,i>r){if(t.match_start=e,r=i,i>=o)break;c=h[s+r-1],u=h[s+r]}}}while((e=_[e&d])>l&&0!=--n);return r<=t.lookahead?r:t.lookahead},Ut=t=>{const e=t.w_size;let a,i,n;do{if(i=t.window_size-t.lookahead-t.strstart,t.strstart>=e+(e-ut)&&(t.window.set(t.window.subarray(e,e+e-i),0),t.match_start-=e,t.strstart-=e,t.block_start-=e,t.insert>t.strstart&&(t.insert=t.strstart),vt(t),i+=e),0===t.strm.avail_in)break;if(a=Rt(t.strm,t.window,t.strstart+t.lookahead,i),t.lookahead+=a,t.lookahead+t.insert>=3)for(n=t.strstart-t.insert,t.ins_h=t.window[n],t.ins_h=yt(t,t.ins_h,t.window[n+1]);t.insert&&(t.ins_h=yt(t,t.ins_h,t.window[n+3-1]),t.prev[n&t.w_mask]=t.head[t.ins_h],t.head[t.ins_h]=n,n++,t.insert--,!(t.lookahead+t.insert<3)););}while(t.lookahead<ut&&0!==t.strm.avail_in)},St=(t,e)=>{let a,i,n,s=t.pending_buf_size-5>t.w_size?t.w_size:t.pending_buf_size-5,r=0,o=t.strm.avail_in;do{if(a=65535,n=t.bi_valid+42>>3,t.strm.avail_out<n)break;if(n=t.strm.avail_out-n,i=t.strstart-t.block_start,a>i+t.strm.avail_in&&(a=i+t.strm.avail_in),a>n&&(a=n),a<s&&(0===a&&e!==V||e===q||a!==i+t.strm.avail_in))break;r=e===V&&a===i+t.strm.avail_in?1:0,Y(t,0,0,r),t.pending_buf[t.pending-4]=a,t.pending_buf[t.pending-3]=a>>8,t.pending_buf[t.pending-2]=~a,t.pending_buf[t.pending-1]=~a>>8,xt(t.strm),i&&(i>a&&(i=a),t.strm.output.set(t.window.subarray(t.block_start,t.block_start+i),t.strm.next_out),t.strm.next_out+=i,t.strm.avail_out-=i,t.strm.total_out+=i,t.block_start+=i,a-=i),a&&(Rt(t.strm,t.strm.output,t.strm.next_out,a),t.strm.next_out+=a,t.strm.avail_out-=a,t.strm.total_out+=a)}while(0===r);return o-=t.strm.avail_in,o&&(o>=t.w_size?(t.matches=2,t.window.set(t.strm.input.subarray(t.strm.next_in-t.w_size,t.strm.next_in),0),t.strstart=t.w_size,t.insert=t.strstart):(t.window_size-t.strstart<=o&&(t.strstart-=t.w_size,t.window.set(t.window.subarray(t.w_size,t.w_size+t.strstart),0),t.matches<2&&t.matches++,t.insert>t.strstart&&(t.insert=t.strstart)),t.window.set(t.strm.input.subarray(t.strm.next_in-o,t.strm.next_in),t.strstart),t.strstart+=o,t.insert+=o>t.w_size-t.insert?t.w_size-t.insert:o),t.block_start=t.strstart),t.high_water<t.strstart&&(t.high_water=t.strstart),r?4:e!==q&&e!==V&&0===t.strm.avail_in&&t.strstart===t.block_start?2:(n=t.window_size-t.strstart,t.strm.avail_in>n&&t.block_start>=t.w_size&&(t.block_start-=t.w_size,t.strstart-=t.w_size,t.window.set(t.window.subarray(t.w_size,t.w_size+t.strstart),0),t.matches<2&&t.matches++,n+=t.w_size,t.insert>t.strstart&&(t.insert=t.strstart)),n>t.strm.avail_in&&(n=t.strm.avail_in),n&&(Rt(t.strm,t.window,t.strstart,n),t.strstart+=n,t.insert+=n>t.w_size-t.insert?t.w_size-t.insert:n),t.high_water<t.strstart&&(t.high_water=t.strstart),n=t.bi_valid+42>>3,n=t.pending_buf_size-n>65535?65535:t.pending_buf_size-n,s=n>t.w_size?t.w_size:n,i=t.strstart-t.block_start,(i>=s||(i||e===V)&&e!==q&&0===t.strm.avail_in&&i<=n)&&(a=i>n?n:i,r=e===V&&0===t.strm.avail_in&&a===i?1:0,Y(t,t.block_start,a,r),t.block_start+=a,xt(t.strm)),r?3:1)},Dt=(t,e)=>{let a,i;for(;;){if(t.lookahead<ut){if(Ut(t),t.lookahead<ut&&e===q)return 1;if(0===t.lookahead)break}if(a=0,t.lookahead>=3&&(t.ins_h=yt(t,t.ins_h,t.window[t.strstart+3-1]),a=t.prev[t.strstart&t.w_mask]=t.head[t.ins_h],t.head[t.ins_h]=t.strstart),0!==a&&t.strstart-a<=t.w_size-ut&&(t.match_length=Zt(t,a)),t.match_length>=3)if(i=X(t,t.strstart-t.match_start,t.match_length-3),t.lookahead-=t.match_length,t.match_length<=t.max_lazy_match&&t.lookahead>=3){t.match_length--;do{t.strstart++,t.ins_h=yt(t,t.ins_h,t.window[t.strstart+3-1]),a=t.prev[t.strstart&t.w_mask]=t.head[t.ins_h],t.head[t.ins_h]=t.strstart}while(0!=--t.match_length);t.strstart++}else t.strstart+=t.match_length,t.match_length=0,t.ins_h=t.window[t.strstart],t.ins_h=yt(t,t.ins_h,t.window[t.strstart+1]);else i=X(t,0,t.window[t.strstart]),t.lookahead--,t.strstart++;if(i&&(zt(t,!1),0===t.strm.avail_out))return 1}return t.insert=t.strstart<2?t.strstart:2,e===V?(zt(t,!0),0===t.strm.avail_out?3:4):t.sym_next&&(zt(t,!1),0===t.strm.avail_out)?1:2},Tt=(t,e)=>{let a,i,n;for(;;){if(t.lookahead<ut){if(Ut(t),t.lookahead<ut&&e===q)return 1;if(0===t.lookahead)break}if(a=0,t.lookahead>=3&&(t.ins_h=yt(t,t.ins_h,t.window[t.strstart+3-1]),a=t.prev[t.strstart&t.w_mask]=t.head[t.ins_h],t.head[t.ins_h]=t.strstart),t.prev_length=t.match_length,t.prev_match=t.match_start,t.match_length=2,0!==a&&t.prev_length<t.max_lazy_match&&t.strstart-a<=t.w_size-ut&&(t.match_length=Zt(t,a),t.match_length<=5&&(t.strategy===rt||3===t.match_length&&t.strstart-t.match_start>4096)&&(t.match_length=2)),t.prev_length>=3&&t.match_length<=t.prev_length){n=t.strstart+t.lookahead-3,i=X(t,t.strstart-1-t.prev_match,t.prev_length-3),t.lookahead-=t.prev_length-1,t.prev_length-=2;do{++t.strstart<=n&&(t.ins_h=yt(t,t.ins_h,t.window[t.strstart+3-1]),a=t.prev[t.strstart&t.w_mask]=t.head[t.ins_h],t.head[t.ins_h]=t.strstart)}while(0!=--t.prev_length);if(t.match_available=0,t.match_length=2,t.strstart++,i&&(zt(t,!1),0===t.strm.avail_out))return 1}else if(t.match_available){if(i=X(t,0,t.window[t.strstart-1]),i&&zt(t,!1),t.strstart++,t.lookahead--,0===t.strm.avail_out)return 1}else t.match_available=1,t.strstart++,t.lookahead--}return t.match_available&&(i=X(t,0,t.window[t.strstart-1]),t.match_available=0),t.insert=t.strstart<2?t.strstart:2,e===V?(zt(t,!0),0===t.strm.avail_out?3:4):t.sym_next&&(zt(t,!1),0===t.strm.avail_out)?1:2};function Ot(t,e,a,i,n){this.good_length=t,this.max_lazy=e,this.nice_length=a,this.max_chain=i,this.func=n}const It=[new Ot(0,0,0,0,St),new Ot(4,4,8,4,Dt),new Ot(4,5,16,8,Dt),new Ot(4,6,32,32,Dt),new Ot(4,4,16,16,Tt),new Ot(8,16,32,32,Tt),new Ot(8,16,128,128,Tt),new Ot(8,32,128,256,Tt),new Ot(32,128,258,1024,Tt),new Ot(32,258,258,4096,Tt)];function Ft(){this.strm=null,this.status=0,this.pending_buf=null,this.pending_buf_size=0,this.pending_out=0,this.pending=0,this.wrap=0,this.gzhead=null,this.gzindex=0,this.method=ft,this.last_flush=-1,this.w_size=0,this.w_bits=0,this.w_mask=0,this.window=null,this.window_size=0,this.prev=null,this.head=null,this.ins_h=0,this.hash_size=0,this.hash_bits=0,this.hash_mask=0,this.hash_shift=0,this.block_start=0,this.match_length=0,this.prev_match=0,this.match_available=0,this.strstart=0,this.match_start=0,this.lookahead=0,this.prev_length=0,this.max_chain_length=0,this.max_lazy_match=0,this.level=0,this.strategy=0,this.good_match=0,this.nice_match=0,this.dyn_ltree=new Uint16Array(1146),this.dyn_dtree=new Uint16Array(122),this.bl_tree=new Uint16Array(78),kt(this.dyn_ltree),kt(this.dyn_dtree),kt(this.bl_tree),this.l_desc=null,this.d_desc=null,this.bl_desc=null,this.bl_count=new Uint16Array(16),this.heap=new Uint16Array(573),kt(this.heap),this.heap_len=0,this.heap_max=0,this.depth=new Uint16Array(573),kt(this.depth),this.sym_buf=0,this.lit_bufsize=0,this.sym_next=0,this.sym_end=0,this.opt_len=0,this.static_len=0,this.matches=0,this.insert=0,this.bi_buf=0,this.bi_valid=0}const Lt=t=>{if(!t)return 1;const e=t.state;return!e||e.strm!==t||e.status!==wt&&57!==e.status&&69!==e.status&&73!==e.status&&91!==e.status&&103!==e.status&&e.status!==mt&&e.status!==bt?1:0},Nt=t=>{if(Lt(t))return gt(t,at);t.total_in=t.total_out=0,t.data_type=_t;const e=t.state;return e.pending=0,e.pending_out=0,e.wrap<0&&(e.wrap=-e.wrap),e.status=2===e.wrap?57:e.wrap?wt:mt,t.adler=2===e.wrap?0:1,e.last_flush=-2,P(e),tt},Bt=t=>{const e=Nt(t);var a;return e===tt&&((a=t.state).window_size=2*a.w_size,kt(a.head),a.max_lazy_match=It[a.level].max_lazy,a.good_match=It[a.level].good_length,a.nice_match=It[a.level].nice_length,a.max_chain_length=It[a.level].max_chain,a.strstart=0,a.block_start=0,a.lookahead=0,a.insert=0,a.match_length=a.prev_length=2,a.match_available=0,a.ins_h=0),e},Ct=(t,e,a,i,n,s)=>{if(!t)return at;let r=1;if(e===st&&(e=6),i<0?(r=0,i=-i):i>15&&(r=2,i-=16),n<1||n>9||a!==ft||i<8||i>15||e<0||e>9||s<0||s>ht||8===i&&1!==r)return gt(t,at);8===i&&(i=9);const o=new Ft;return t.state=o,o.strm=t,o.status=wt,o.wrap=r,o.gzhead=null,o.w_bits=i,o.w_size=1<<o.w_bits,o.w_mask=o.w_size-1,o.hash_bits=n+7,o.hash_size=1<<o.hash_bits,o.hash_mask=o.hash_size-1,o.hash_shift=~~((o.hash_bits+3-1)/3),o.window=new Uint8Array(2*o.w_size),o.head=new Uint16Array(o.hash_size),o.prev=new Uint16Array(o.w_size),o.lit_bufsize=1<<n+6,o.pending_buf_size=4*o.lit_bufsize,o.pending_buf=new Uint8Array(o.pending_buf_size),o.sym_buf=o.lit_bufsize,o.sym_end=3*(o.lit_bufsize-1),o.level=e,o.strategy=s,o.method=a,Bt(t)};var Mt={deflateInit:(t,e)=>Ct(t,e,ft,15,8,dt),deflateInit2:Ct,deflateReset:Bt,deflateResetKeep:Nt,deflateSetHeader:(t,e)=>Lt(t)||2!==t.state.wrap?at:(t.state.gzhead=e,tt),deflate:(t,e)=>{if(Lt(t)||e>$||e<0)return t?gt(t,at):at;const a=t.state;if(!t.output||0!==t.avail_in&&!t.input||a.status===bt&&e!==V)return gt(t,0===t.avail_out?nt:at);const i=a.last_flush;if(a.last_flush=e,0!==a.pending){if(xt(t),0===t.avail_out)return a.last_flush=-1,tt}else if(0===t.avail_in&&pt(e)<=pt(i)&&e!==V)return gt(t,nt);if(a.status===bt&&0!==t.avail_in)return gt(t,nt);if(a.status===wt&&0===a.wrap&&(a.status=mt),a.status===wt){let e=ft+(a.w_bits-8<<4)<<8,i=-1;if(i=a.strategy>=ot||a.level<2?0:a.level<6?1:6===a.level?2:3,e|=i<<6,0!==a.strstart&&(e|=32),e+=31-e%31,Et(a,e),0!==a.strstart&&(Et(a,t.adler>>>16),Et(a,65535&t.adler)),t.adler=1,a.status=mt,xt(t),0!==a.pending)return a.last_flush=-1,tt}if(57===a.status)if(t.adler=0,At(a,31),At(a,139),At(a,8),a.gzhead)At(a,(a.gzhead.text?1:0)+(a.gzhead.hcrc?2:0)+(a.gzhead.extra?4:0)+(a.gzhead.name?8:0)+(a.gzhead.comment?16:0)),At(a,255&a.gzhead.time),At(a,a.gzhead.time>>8&255),At(a,a.gzhead.time>>16&255),At(a,a.gzhead.time>>24&255),At(a,9===a.level?2:a.strategy>=ot||a.level<2?4:0),At(a,255&a.gzhead.os),a.gzhead.extra&&a.gzhead.extra.length&&(At(a,255&a.gzhead.extra.length),At(a,a.gzhead.extra.length>>8&255)),a.gzhead.hcrc&&(t.adler=H(t.adler,a.pending_buf,a.pending,0)),a.gzindex=0,a.status=69;else if(At(a,0),At(a,0),At(a,0),At(a,0),At(a,0),At(a,9===a.level?2:a.strategy>=ot||a.level<2?4:0),At(a,3),a.status=mt,xt(t),0!==a.pending)return a.last_flush=-1,tt;if(69===a.status){if(a.gzhead.extra){let e=a.pending,i=(65535&a.gzhead.extra.length)-a.gzindex;for(;a.pending+i>a.pending_buf_size;){let n=a.pending_buf_size-a.pending;if(a.pending_buf.set(a.gzhead.extra.subarray(a.gzindex,a.gzindex+n),a.pending),a.pending=a.pending_buf_size,a.gzhead.hcrc&&a.pending>e&&(t.adler=H(t.adler,a.pending_buf,a.pending-e,e)),a.gzindex+=n,xt(t),0!==a.pending)return a.last_flush=-1,tt;e=0,i-=n}let n=new Uint8Array(a.gzhead.extra);a.pending_buf.set(n.subarray(a.gzindex,a.gzindex+i),a.pending),a.pending+=i,a.gzhead.hcrc&&a.pending>e&&(t.adler=H(t.adler,a.pending_buf,a.pending-e,e)),a.gzindex=0}a.status=73}if(73===a.status){if(a.gzhead.name){let e,i=a.pending;do{if(a.pending===a.pending_buf_size){if(a.gzhead.hcrc&&a.pending>i&&(t.adler=H(t.adler,a.pending_buf,a.pending-i,i)),xt(t),0!==a.pending)return a.last_flush=-1,tt;i=0}e=a.gzindex<a.gzhead.name.length?255&a.gzhead.name.charCodeAt(a.gzindex++):0,At(a,e)}while(0!==e);a.gzhead.hcrc&&a.pending>i&&(t.adler=H(t.adler,a.pending_buf,a.pending-i,i)),a.gzindex=0}a.status=91}if(91===a.status){if(a.gzhead.comment){let e,i=a.pending;do{if(a.pending===a.pending_buf_size){if(a.gzhead.hcrc&&a.pending>i&&(t.adler=H(t.adler,a.pending_buf,a.pending-i,i)),xt(t),0!==a.pending)return a.last_flush=-1,tt;i=0}e=a.gzindex<a.gzhead.comment.length?255&a.gzhead.comment.charCodeAt(a.gzindex++):0,At(a,e)}while(0!==e);a.gzhead.hcrc&&a.pending>i&&(t.adler=H(t.adler,a.pending_buf,a.pending-i,i))}a.status=103}if(103===a.status){if(a.gzhead.hcrc){if(a.pending+2>a.pending_buf_size&&(xt(t),0!==a.pending))return a.last_flush=-1,tt;At(a,255&t.adler),At(a,t.adler>>8&255),t.adler=0}if(a.status=mt,xt(t),0!==a.pending)return a.last_flush=-1,tt}if(0!==t.avail_in||0!==a.lookahead||e!==q&&a.status!==bt){let i=0===a.level?St(a,e):a.strategy===ot?((t,e)=>{let a;for(;;){if(0===t.lookahead&&(Ut(t),0===t.lookahead)){if(e===q)return 1;break}if(t.match_length=0,a=X(t,0,t.window[t.strstart]),t.lookahead--,t.strstart++,a&&(zt(t,!1),0===t.strm.avail_out))return 1}return t.insert=0,e===V?(zt(t,!0),0===t.strm.avail_out?3:4):t.sym_next&&(zt(t,!1),0===t.strm.avail_out)?1:2})(a,e):a.strategy===lt?((t,e)=>{let a,i,n,s;const r=t.window;for(;;){if(t.lookahead<=ct){if(Ut(t),t.lookahead<=ct&&e===q)return 1;if(0===t.lookahead)break}if(t.match_length=0,t.lookahead>=3&&t.strstart>0&&(n=t.strstart-1,i=r[n],i===r[++n]&&i===r[++n]&&i===r[++n])){s=t.strstart+ct;do{}while(i===r[++n]&&i===r[++n]&&i===r[++n]&&i===r[++n]&&i===r[++n]&&i===r[++n]&&i===r[++n]&&i===r[++n]&&n<s);t.match_length=ct-(s-n),t.match_length>t.lookahead&&(t.match_length=t.lookahead)}if(t.match_length>=3?(a=X(t,1,t.match_length-3),t.lookahead-=t.match_length,t.strstart+=t.match_length,t.match_length=0):(a=X(t,0,t.window[t.strstart]),t.lookahead--,t.strstart++),a&&(zt(t,!1),0===t.strm.avail_out))return 1}return t.insert=0,e===V?(zt(t,!0),0===t.strm.avail_out?3:4):t.sym_next&&(zt(t,!1),0===t.strm.avail_out)?1:2})(a,e):It[a.level].func(a,e);if(3!==i&&4!==i||(a.status=bt),1===i||3===i)return 0===t.avail_out&&(a.last_flush=-1),tt;if(2===i&&(e===J?W(a):e!==$&&(Y(a,0,0,!1),e===Q&&(kt(a.head),0===a.lookahead&&(a.strstart=0,a.block_start=0,a.insert=0))),xt(t),0===t.avail_out))return a.last_flush=-1,tt}return e!==V?tt:a.wrap<=0?et:(2===a.wrap?(At(a,255&t.adler),At(a,t.adler>>8&255),At(a,t.adler>>16&255),At(a,t.adler>>24&255),At(a,255&t.total_in),At(a,t.total_in>>8&255),At(a,t.total_in>>16&255),At(a,t.total_in>>24&255)):(Et(a,t.adler>>>16),Et(a,65535&t.adler)),xt(t),a.wrap>0&&(a.wrap=-a.wrap),0!==a.pending?tt:et)},deflateEnd:t=>{if(Lt(t))return at;const e=t.state.status;return t.state=null,e===mt?gt(t,it):tt},deflateSetDictionary:(t,e)=>{let a=e.length;if(Lt(t))return at;const i=t.state,n=i.wrap;if(2===n||1===n&&i.status!==wt||i.lookahead)return at;if(1===n&&(t.adler=C(t.adler,e,a,0)),i.wrap=0,a>=i.w_size){0===n&&(kt(i.head),i.strstart=0,i.block_start=0,i.insert=0);let t=new Uint8Array(i.w_size);t.set(e.subarray(a-i.w_size,a),0),e=t,a=i.w_size}const s=t.avail_in,r=t.next_in,o=t.input;for(t.avail_in=a,t.next_in=0,t.input=e,Ut(i);i.lookahead>=3;){let t=i.strstart,e=i.lookahead-2;do{i.ins_h=yt(i,i.ins_h,i.window[t+3-1]),i.prev[t&i.w_mask]=i.head[i.ins_h],i.head[i.ins_h]=t,t++}while(--e);i.strstart=t,i.lookahead=2,Ut(i)}return i.strstart+=i.lookahead,i.block_start=i.strstart,i.insert=i.lookahead,i.lookahead=0,i.match_length=i.prev_length=2,i.match_available=0,t.next_in=r,t.input=o,t.avail_in=s,i.wrap=n,tt},deflateInfo:"pako deflate (from Nodeca project)"};const Ht=(t,e)=>Object.prototype.hasOwnProperty.call(t,e);var jt=function(t){const e=Array.prototype.slice.call(arguments,1);for(;e.length;){const a=e.shift();if(a){if("object"!=typeof a)throw new TypeError(a+"must be non-object");for(const e in a)Ht(a,e)&&(t[e]=a[e])}}return t},Kt=t=>{let e=0;for(let a=0,i=t.length;a<i;a++)e+=t[a].length;const a=new Uint8Array(e);for(let e=0,i=0,n=t.length;e<n;e++){let n=t[e];a.set(n,i),i+=n.length}return a};let Pt=!0;try{String.fromCharCode.apply(null,new Uint8Array(1))}catch(t){Pt=!1}const Yt=new Uint8Array(256);for(let t=0;t<256;t++)Yt[t]=t>=252?6:t>=248?5:t>=240?4:t>=224?3:t>=192?2:1;Yt[254]=Yt[254]=1;var Gt=t=>{if("function"==typeof TextEncoder&&TextEncoder.prototype.encode)return(new TextEncoder).encode(t);let e,a,i,n,s,r=t.length,o=0;for(n=0;n<r;n++)a=t.charCodeAt(n),55296==(64512&a)&&n+1<r&&(i=t.charCodeAt(n+1),56320==(64512&i)&&(a=65536+(a-55296<<10)+(i-56320),n++)),o+=a<128?1:a<2048?2:a<65536?3:4;for(e=new Uint8Array(o),s=0,n=0;s<o;n++)a=t.charCodeAt(n),55296==(64512&a)&&n+1<r&&(i=t.charCodeAt(n+1),56320==(64512&i)&&(a=65536+(a-55296<<10)+(i-56320),n++)),a<128?e[s++]=a:a<2048?(e[s++]=192|a>>>6,e[s++]=128|63&a):a<65536?(e[s++]=224|a>>>12,e[s++]=128|a>>>6&63,e[s++]=128|63&a):(e[s++]=240|a>>>18,e[s++]=128|a>>>12&63,e[s++]=128|a>>>6&63,e[s++]=128|63&a);return e},Xt=(t,e)=>{const a=e||t.length;if("function"==typeof TextDecoder&&TextDecoder.prototype.decode)return(new TextDecoder).decode(t.subarray(0,e));let i,n;const s=new Array(2*a);for(n=0,i=0;i<a;){let e=t[i++];if(e<128){s[n++]=e;continue}let r=Yt[e];if(r>4)s[n++]=65533,i+=r-1;else{for(e&=2===r?31:3===r?15:7;r>1&&i<a;)e=e<<6|63&t[i++],r--;r>1?s[n++]=65533:e<65536?s[n++]=e:(e-=65536,s[n++]=55296|e>>10&1023,s[n++]=56320|1023&e)}}return((t,e)=>{if(e<65534&&t.subarray&&Pt)return String.fromCharCode.apply(null,t.length===e?t:t.subarray(0,e));let a="";for(let i=0;i<e;i++)a+=String.fromCharCode(t[i]);return a})(s,n)},Wt=(t,e)=>{(e=e||t.length)>t.length&&(e=t.length);let a=e-1;for(;a>=0&&128==(192&t[a]);)a--;return a<0||0===a?e:a+Yt[t[a]]>e?a:e};var qt=function(){this.input=null,this.next_in=0,this.avail_in=0,this.total_in=0,this.output=null,this.next_out=0,this.avail_out=0,this.total_out=0,this.msg="",this.state=null,this.data_type=2,this.adler=0};const Jt=Object.prototype.toString,{Z_NO_FLUSH:Qt,Z_SYNC_FLUSH:Vt,Z_FULL_FLUSH:$t,Z_FINISH:te,Z_OK:ee,Z_STREAM_END:ae,Z_DEFAULT_COMPRESSION:ie,Z_DEFAULT_STRATEGY:ne,Z_DEFLATED:se}=K;function re(t){this.options=jt({level:ie,method:se,chunkSize:16384,windowBits:15,memLevel:8,strategy:ne},t||{});let e=this.options;e.raw&&e.windowBits>0?e.windowBits=-e.windowBits:e.gzip&&e.windowBits>0&&e.windowBits<16&&(e.windowBits+=16),this.err=0,this.msg="",this.ended=!1,this.chunks=[],this.strm=new qt,this.strm.avail_out=0;let a=Mt.deflateInit2(this.strm,e.level,e.method,e.windowBits,e.memLevel,e.strategy);if(a!==ee)throw new Error(j[a]);if(e.header&&Mt.deflateSetHeader(this.strm,e.header),e.dictionary){let t;if(t="string"==typeof e.dictionary?Gt(e.dictionary):"[object ArrayBuffer]"===Jt.call(e.dictionary)?new Uint8Array(e.dictionary):e.dictionary,a=Mt.deflateSetDictionary(this.strm,t),a!==ee)throw new Error(j[a]);this._dict_set=!0}}function oe(t,e){const a=new re(e);if(a.push(t,!0),a.err)throw a.msg||j[a.err];return a.result}re.prototype.push=function(t,e){const a=this.strm,i=this.options.chunkSize;let n,s;if(this.ended)return!1;for(s=e===~~e?e:!0===e?te:Qt,"string"==typeof t?a.input=Gt(t):"[object ArrayBuffer]"===Jt.call(t)?a.input=new Uint8Array(t):a.input=t,a.next_in=0,a.avail_in=a.input.length;;)if(0===a.avail_out&&(a.output=new Uint8Array(i),a.next_out=0,a.avail_out=i),(s===Vt||s===$t)&&a.avail_out<=6)this.onData(a.output.subarray(0,a.next_out)),a.avail_out=0;else{if(n=Mt.deflate(a,s),n===ae)return a.next_out>0&&this.onData(a.output.subarray(0,a.next_out)),n=Mt.deflateEnd(this.strm),this.onEnd(n),this.ended=!0,n===ee;if(0!==a.avail_out){if(s>0&&a.next_out>0)this.onData(a.output.subarray(0,a.next_out)),a.avail_out=0;else if(0===a.avail_in)break}else this.onData(a.output)}return!0},re.prototype.onData=function(t){this.chunks.push(t)},re.prototype.onEnd=function(t){t===ee&&(this.result=Kt(this.chunks)),this.chunks=[],this.err=t,this.msg=this.strm.msg};var le={Deflate:re,deflate:oe,deflateRaw:function(t,e){return(e=e||{}).raw=!0,oe(t,e)},gzip:function(t,e){return(e=e||{}).gzip=!0,oe(t,e)},constants:K};const he=16209;var de=function(t,e){let a,i,n,s,r,o,l,h,d,_,f,c,u,w,m,b,g,p,k,v,y,x,z,A;const E=t.state;a=t.next_in,z=t.input,i=a+(t.avail_in-5),n=t.next_out,A=t.output,s=n-(e-t.avail_out),r=n+(t.avail_out-257),o=E.dmax,l=E.wsize,h=E.whave,d=E.wnext,_=E.window,f=E.hold,c=E.bits,u=E.lencode,w=E.distcode,m=(1<<E.lenbits)-1,b=(1<<E.distbits)-1;t:do{c<15&&(f+=z[a++]<<c,c+=8,f+=z[a++]<<c,c+=8),g=u[f&m];e:for(;;){if(p=g>>>24,f>>>=p,c-=p,p=g>>>16&255,0===p)A[n++]=65535&g;else{if(!(16&p)){if(0==(64&p)){g=u[(65535&g)+(f&(1<<p)-1)];continue e}if(32&p){E.mode=16191;break t}t.msg="invalid literal/length code",E.mode=he;break t}k=65535&g,p&=15,p&&(c<p&&(f+=z[a++]<<c,c+=8),k+=f&(1<<p)-1,f>>>=p,c-=p),c<15&&(f+=z[a++]<<c,c+=8,f+=z[a++]<<c,c+=8),g=w[f&b];a:for(;;){if(p=g>>>24,f>>>=p,c-=p,p=g>>>16&255,!(16&p)){if(0==(64&p)){g=w[(65535&g)+(f&(1<<p)-1)];continue a}t.msg="invalid distance code",E.mode=he;break t}if(v=65535&g,p&=15,c<p&&(f+=z[a++]<<c,c+=8,c<p&&(f+=z[a++]<<c,c+=8)),v+=f&(1<<p)-1,v>o){t.msg="invalid distance too far back",E.mode=he;break t}if(f>>>=p,c-=p,p=n-s,v>p){if(p=v-p,p>h&&E.sane){t.msg="invalid distance too far back",E.mode=he;break t}if(y=0,x=_,0===d){if(y+=l-p,p<k){k-=p;do{A[n++]=_[y++]}while(--p);y=n-v,x=A}}else if(d<p){if(y+=l+d-p,p-=d,p<k){k-=p;do{A[n++]=_[y++]}while(--p);if(y=0,d<k){p=d,k-=p;do{A[n++]=_[y++]}while(--p);y=n-v,x=A}}}else if(y+=d-p,p<k){k-=p;do{A[n++]=_[y++]}while(--p);y=n-v,x=A}for(;k>2;)A[n++]=x[y++],A[n++]=x[y++],A[n++]=x[y++],k-=3;k&&(A[n++]=x[y++],k>1&&(A[n++]=x[y++]))}else{y=n-v;do{A[n++]=A[y++],A[n++]=A[y++],A[n++]=A[y++],k-=3}while(k>2);k&&(A[n++]=A[y++],k>1&&(A[n++]=A[y++]))}break}}break}}while(a<i&&n<r);k=c>>3,a-=k,c-=k<<3,f&=(1<<c)-1,t.next_in=a,t.next_out=n,t.avail_in=a<i?i-a+5:5-(a-i),t.avail_out=n<r?r-n+257:257-(n-r),E.hold=f,E.bits=c};const _e=15,fe=new Uint16Array([3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258,0,0]),ce=new Uint8Array([16,16,16,16,16,16,16,16,17,17,17,17,18,18,18,18,19,19,19,19,20,20,20,20,21,21,21,21,16,72,78]),ue=new Uint16Array([1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577,0,0]),we=new Uint8Array([16,16,16,16,17,17,18,18,19,19,20,20,21,21,22,22,23,23,24,24,25,25,26,26,27,27,28,28,29,29,64,64]);var me=(t,e,a,i,n,s,r,o)=>{const l=o.bits;let h,d,_,f,c,u,w=0,m=0,b=0,g=0,p=0,k=0,v=0,y=0,x=0,z=0,A=null;const E=new Uint16Array(16),R=new Uint16Array(16);let Z,U,S,D=null;for(w=0;w<=_e;w++)E[w]=0;for(m=0;m<i;m++)E[e[a+m]]++;for(p=l,g=_e;g>=1&&0===E[g];g--);if(p>g&&(p=g),0===g)return n[s++]=20971520,n[s++]=20971520,o.bits=1,0;for(b=1;b<g&&0===E[b];b++);for(p<b&&(p=b),y=1,w=1;w<=_e;w++)if(y<<=1,y-=E[w],y<0)return-1;if(y>0&&(0===t||1!==g))return-1;for(R[1]=0,w=1;w<_e;w++)R[w+1]=R[w]+E[w];for(m=0;m<i;m++)0!==e[a+m]&&(r[R[e[a+m]]++]=m);if(0===t?(A=D=r,u=20):1===t?(A=fe,D=ce,u=257):(A=ue,D=we,u=0),z=0,m=0,w=b,c=s,k=p,v=0,_=-1,x=1<<p,f=x-1,1===t&&x>852||2===t&&x>592)return 1;for(;;){Z=w-v,r[m]+1<u?(U=0,S=r[m]):r[m]>=u?(U=D[r[m]-u],S=A[r[m]-u]):(U=96,S=0),h=1<<w-v,d=1<<k,b=d;do{d-=h,n[c+(z>>v)+d]=Z<<24|U<<16|S|0}while(0!==d);for(h=1<<w-1;z&h;)h>>=1;if(0!==h?(z&=h-1,z+=h):z=0,m++,0==--E[w]){if(w===g)break;w=e[a+r[m]]}if(w>p&&(z&f)!==_){for(0===v&&(v=p),c+=b,k=w-v,y=1<<k;k+v<g&&(y-=E[k+v],!(y<=0));)k++,y<<=1;if(x+=1<<k,1===t&&x>852||2===t&&x>592)return 1;_=z&f,n[_]=p<<24|k<<16|c-s|0}}return 0!==z&&(n[c+z]=w-v<<24|64<<16|0),o.bits=p,0};const{Z_FINISH:be,Z_BLOCK:ge,Z_TREES:pe,Z_OK:ke,Z_STREAM_END:ve,Z_NEED_DICT:ye,Z_STREAM_ERROR:xe,Z_DATA_ERROR:ze,Z_MEM_ERROR:Ae,Z_BUF_ERROR:Ee,Z_DEFLATED:Re}=K,Ze=16180,Ue=16190,Se=16191,De=16192,Te=16194,Oe=16199,Ie=16200,Fe=16206,Le=16209,Ne=t=>(t>>>24&255)+(t>>>8&65280)+((65280&t)<<8)+((255&t)<<24);function Be(){this.strm=null,this.mode=0,this.last=!1,this.wrap=0,this.havedict=!1,this.flags=0,this.dmax=0,this.check=0,this.total=0,this.head=null,this.wbits=0,this.wsize=0,this.whave=0,this.wnext=0,this.window=null,this.hold=0,this.bits=0,this.length=0,this.offset=0,this.extra=0,this.lencode=null,this.distcode=null,this.lenbits=0,this.distbits=0,this.ncode=0,this.nlen=0,this.ndist=0,this.have=0,this.next=null,this.lens=new Uint16Array(320),this.work=new Uint16Array(288),this.lendyn=null,this.distdyn=null,this.sane=0,this.back=0,this.was=0}const Ce=t=>{if(!t)return 1;const e=t.state;return!e||e.strm!==t||e.mode<Ze||e.mode>16211?1:0},Me=t=>{if(Ce(t))return xe;const e=t.state;return t.total_in=t.total_out=e.total=0,t.msg="",e.wrap&&(t.adler=1&e.wrap),e.mode=Ze,e.last=0,e.havedict=0,e.flags=-1,e.dmax=32768,e.head=null,e.hold=0,e.bits=0,e.lencode=e.lendyn=new Int32Array(852),e.distcode=e.distdyn=new Int32Array(592),e.sane=1,e.back=-1,ke},He=t=>{if(Ce(t))return xe;const e=t.state;return e.wsize=0,e.whave=0,e.wnext=0,Me(t)},je=(t,e)=>{let a;if(Ce(t))return xe;const i=t.state;return e<0?(a=0,e=-e):(a=5+(e>>4),e<48&&(e&=15)),e&&(e<8||e>15)?xe:(null!==i.window&&i.wbits!==e&&(i.window=null),i.wrap=a,i.wbits=e,He(t))},Ke=(t,e)=>{if(!t)return xe;const a=new Be;t.state=a,a.strm=t,a.window=null,a.mode=Ze;const i=je(t,e);return i!==ke&&(t.state=null),i};let Pe,Ye,Ge=!0;const Xe=t=>{if(Ge){Pe=new Int32Array(512),Ye=new Int32Array(32);let e=0;for(;e<144;)t.lens[e++]=8;for(;e<256;)t.lens[e++]=9;for(;e<280;)t.lens[e++]=7;for(;e<288;)t.lens[e++]=8;for(me(1,t.lens,0,288,Pe,0,t.work,{bits:9}),e=0;e<32;)t.lens[e++]=5;me(2,t.lens,0,32,Ye,0,t.work,{bits:5}),Ge=!1}t.lencode=Pe,t.lenbits=9,t.distcode=Ye,t.distbits=5},We=(t,e,a,i)=>{let n;const s=t.state;return null===s.window&&(s.wsize=1<<s.wbits,s.wnext=0,s.whave=0,s.window=new Uint8Array(s.wsize)),i>=s.wsize?(s.window.set(e.subarray(a-s.wsize,a),0),s.wnext=0,s.whave=s.wsize):(n=s.wsize-s.wnext,n>i&&(n=i),s.window.set(e.subarray(a-i,a-i+n),s.wnext),(i-=n)?(s.window.set(e.subarray(a-i,a),0),s.wnext=i,s.whave=s.wsize):(s.wnext+=n,s.wnext===s.wsize&&(s.wnext=0),s.whave<s.wsize&&(s.whave+=n))),0};var qe={inflateReset:He,inflateReset2:je,inflateResetKeep:Me,inflateInit:t=>Ke(t,15),inflateInit2:Ke,inflate:(t,e)=>{let a,i,n,s,r,o,l,h,d,_,f,c,u,w,m,b,g,p,k,v,y,x,z=0;const A=new Uint8Array(4);let E,R;const Z=new Uint8Array([16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15]);if(Ce(t)||!t.output||!t.input&&0!==t.avail_in)return xe;a=t.state,a.mode===Se&&(a.mode=De),r=t.next_out,n=t.output,l=t.avail_out,s=t.next_in,i=t.input,o=t.avail_in,h=a.hold,d=a.bits,_=o,f=l,x=ke;t:for(;;)switch(a.mode){case Ze:if(0===a.wrap){a.mode=De;break}for(;d<16;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}if(2&a.wrap&&35615===h){0===a.wbits&&(a.wbits=15),a.check=0,A[0]=255&h,A[1]=h>>>8&255,a.check=H(a.check,A,2,0),h=0,d=0,a.mode=16181;break}if(a.head&&(a.head.done=!1),!(1&a.wrap)||(((255&h)<<8)+(h>>8))%31){t.msg="incorrect header check",a.mode=Le;break}if((15&h)!==Re){t.msg="unknown compression method",a.mode=Le;break}if(h>>>=4,d-=4,y=8+(15&h),0===a.wbits&&(a.wbits=y),y>15||y>a.wbits){t.msg="invalid window size",a.mode=Le;break}a.dmax=1<<a.wbits,a.flags=0,t.adler=a.check=1,a.mode=512&h?16189:Se,h=0,d=0;break;case 16181:for(;d<16;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}if(a.flags=h,(255&a.flags)!==Re){t.msg="unknown compression method",a.mode=Le;break}if(57344&a.flags){t.msg="unknown header flags set",a.mode=Le;break}a.head&&(a.head.text=h>>8&1),512&a.flags&&4&a.wrap&&(A[0]=255&h,A[1]=h>>>8&255,a.check=H(a.check,A,2,0)),h=0,d=0,a.mode=16182;case 16182:for(;d<32;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}a.head&&(a.head.time=h),512&a.flags&&4&a.wrap&&(A[0]=255&h,A[1]=h>>>8&255,A[2]=h>>>16&255,A[3]=h>>>24&255,a.check=H(a.check,A,4,0)),h=0,d=0,a.mode=16183;case 16183:for(;d<16;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}a.head&&(a.head.xflags=255&h,a.head.os=h>>8),512&a.flags&&4&a.wrap&&(A[0]=255&h,A[1]=h>>>8&255,a.check=H(a.check,A,2,0)),h=0,d=0,a.mode=16184;case 16184:if(1024&a.flags){for(;d<16;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}a.length=h,a.head&&(a.head.extra_len=h),512&a.flags&&4&a.wrap&&(A[0]=255&h,A[1]=h>>>8&255,a.check=H(a.check,A,2,0)),h=0,d=0}else a.head&&(a.head.extra=null);a.mode=16185;case 16185:if(1024&a.flags&&(c=a.length,c>o&&(c=o),c&&(a.head&&(y=a.head.extra_len-a.length,a.head.extra||(a.head.extra=new Uint8Array(a.head.extra_len)),a.head.extra.set(i.subarray(s,s+c),y)),512&a.flags&&4&a.wrap&&(a.check=H(a.check,i,c,s)),o-=c,s+=c,a.length-=c),a.length))break t;a.length=0,a.mode=16186;case 16186:if(2048&a.flags){if(0===o)break t;c=0;do{y=i[s+c++],a.head&&y&&a.length<65536&&(a.head.name+=String.fromCharCode(y))}while(y&&c<o);if(512&a.flags&&4&a.wrap&&(a.check=H(a.check,i,c,s)),o-=c,s+=c,y)break t}else a.head&&(a.head.name=null);a.length=0,a.mode=16187;case 16187:if(4096&a.flags){if(0===o)break t;c=0;do{y=i[s+c++],a.head&&y&&a.length<65536&&(a.head.comment+=String.fromCharCode(y))}while(y&&c<o);if(512&a.flags&&4&a.wrap&&(a.check=H(a.check,i,c,s)),o-=c,s+=c,y)break t}else a.head&&(a.head.comment=null);a.mode=16188;case 16188:if(512&a.flags){for(;d<16;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}if(4&a.wrap&&h!==(65535&a.check)){t.msg="header crc mismatch",a.mode=Le;break}h=0,d=0}a.head&&(a.head.hcrc=a.flags>>9&1,a.head.done=!0),t.adler=a.check=0,a.mode=Se;break;case 16189:for(;d<32;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}t.adler=a.check=Ne(h),h=0,d=0,a.mode=Ue;case Ue:if(0===a.havedict)return t.next_out=r,t.avail_out=l,t.next_in=s,t.avail_in=o,a.hold=h,a.bits=d,ye;t.adler=a.check=1,a.mode=Se;case Se:if(e===ge||e===pe)break t;case De:if(a.last){h>>>=7&d,d-=7&d,a.mode=Fe;break}for(;d<3;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}switch(a.last=1&h,h>>>=1,d-=1,3&h){case 0:a.mode=16193;break;case 1:if(Xe(a),a.mode=Oe,e===pe){h>>>=2,d-=2;break t}break;case 2:a.mode=16196;break;case 3:t.msg="invalid block type",a.mode=Le}h>>>=2,d-=2;break;case 16193:for(h>>>=7&d,d-=7&d;d<32;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}if((65535&h)!=(h>>>16^65535)){t.msg="invalid stored block lengths",a.mode=Le;break}if(a.length=65535&h,h=0,d=0,a.mode=Te,e===pe)break t;case Te:a.mode=16195;case 16195:if(c=a.length,c){if(c>o&&(c=o),c>l&&(c=l),0===c)break t;n.set(i.subarray(s,s+c),r),o-=c,s+=c,l-=c,r+=c,a.length-=c;break}a.mode=Se;break;case 16196:for(;d<14;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}if(a.nlen=257+(31&h),h>>>=5,d-=5,a.ndist=1+(31&h),h>>>=5,d-=5,a.ncode=4+(15&h),h>>>=4,d-=4,a.nlen>286||a.ndist>30){t.msg="too many length or distance symbols",a.mode=Le;break}a.have=0,a.mode=16197;case 16197:for(;a.have<a.ncode;){for(;d<3;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}a.lens[Z[a.have++]]=7&h,h>>>=3,d-=3}for(;a.have<19;)a.lens[Z[a.have++]]=0;if(a.lencode=a.lendyn,a.lenbits=7,E={bits:a.lenbits},x=me(0,a.lens,0,19,a.lencode,0,a.work,E),a.lenbits=E.bits,x){t.msg="invalid code lengths set",a.mode=Le;break}a.have=0,a.mode=16198;case 16198:for(;a.have<a.nlen+a.ndist;){for(;z=a.lencode[h&(1<<a.lenbits)-1],m=z>>>24,b=z>>>16&255,g=65535&z,!(m<=d);){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}if(g<16)h>>>=m,d-=m,a.lens[a.have++]=g;else{if(16===g){for(R=m+2;d<R;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}if(h>>>=m,d-=m,0===a.have){t.msg="invalid bit length repeat",a.mode=Le;break}y=a.lens[a.have-1],c=3+(3&h),h>>>=2,d-=2}else if(17===g){for(R=m+3;d<R;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}h>>>=m,d-=m,y=0,c=3+(7&h),h>>>=3,d-=3}else{for(R=m+7;d<R;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}h>>>=m,d-=m,y=0,c=11+(127&h),h>>>=7,d-=7}if(a.have+c>a.nlen+a.ndist){t.msg="invalid bit length repeat",a.mode=Le;break}for(;c--;)a.lens[a.have++]=y}}if(a.mode===Le)break;if(0===a.lens[256]){t.msg="invalid code -- missing end-of-block",a.mode=Le;break}if(a.lenbits=9,E={bits:a.lenbits},x=me(1,a.lens,0,a.nlen,a.lencode,0,a.work,E),a.lenbits=E.bits,x){t.msg="invalid literal/lengths set",a.mode=Le;break}if(a.distbits=6,a.distcode=a.distdyn,E={bits:a.distbits},x=me(2,a.lens,a.nlen,a.ndist,a.distcode,0,a.work,E),a.distbits=E.bits,x){t.msg="invalid distances set",a.mode=Le;break}if(a.mode=Oe,e===pe)break t;case Oe:a.mode=Ie;case Ie:if(o>=6&&l>=258){t.next_out=r,t.avail_out=l,t.next_in=s,t.avail_in=o,a.hold=h,a.bits=d,de(t,f),r=t.next_out,n=t.output,l=t.avail_out,s=t.next_in,i=t.input,o=t.avail_in,h=a.hold,d=a.bits,a.mode===Se&&(a.back=-1);break}for(a.back=0;z=a.lencode[h&(1<<a.lenbits)-1],m=z>>>24,b=z>>>16&255,g=65535&z,!(m<=d);){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}if(b&&0==(240&b)){for(p=m,k=b,v=g;z=a.lencode[v+((h&(1<<p+k)-1)>>p)],m=z>>>24,b=z>>>16&255,g=65535&z,!(p+m<=d);){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}h>>>=p,d-=p,a.back+=p}if(h>>>=m,d-=m,a.back+=m,a.length=g,0===b){a.mode=16205;break}if(32&b){a.back=-1,a.mode=Se;break}if(64&b){t.msg="invalid literal/length code",a.mode=Le;break}a.extra=15&b,a.mode=16201;case 16201:if(a.extra){for(R=a.extra;d<R;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}a.length+=h&(1<<a.extra)-1,h>>>=a.extra,d-=a.extra,a.back+=a.extra}a.was=a.length,a.mode=16202;case 16202:for(;z=a.distcode[h&(1<<a.distbits)-1],m=z>>>24,b=z>>>16&255,g=65535&z,!(m<=d);){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}if(0==(240&b)){for(p=m,k=b,v=g;z=a.distcode[v+((h&(1<<p+k)-1)>>p)],m=z>>>24,b=z>>>16&255,g=65535&z,!(p+m<=d);){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}h>>>=p,d-=p,a.back+=p}if(h>>>=m,d-=m,a.back+=m,64&b){t.msg="invalid distance code",a.mode=Le;break}a.offset=g,a.extra=15&b,a.mode=16203;case 16203:if(a.extra){for(R=a.extra;d<R;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}a.offset+=h&(1<<a.extra)-1,h>>>=a.extra,d-=a.extra,a.back+=a.extra}if(a.offset>a.dmax){t.msg="invalid distance too far back",a.mode=Le;break}a.mode=16204;case 16204:if(0===l)break t;if(c=f-l,a.offset>c){if(c=a.offset-c,c>a.whave&&a.sane){t.msg="invalid distance too far back",a.mode=Le;break}c>a.wnext?(c-=a.wnext,u=a.wsize-c):u=a.wnext-c,c>a.length&&(c=a.length),w=a.window}else w=n,u=r-a.offset,c=a.length;c>l&&(c=l),l-=c,a.length-=c;do{n[r++]=w[u++]}while(--c);0===a.length&&(a.mode=Ie);break;case 16205:if(0===l)break t;n[r++]=a.length,l--,a.mode=Ie;break;case Fe:if(a.wrap){for(;d<32;){if(0===o)break t;o--,h|=i[s++]<<d,d+=8}if(f-=l,t.total_out+=f,a.total+=f,4&a.wrap&&f&&(t.adler=a.check=a.flags?H(a.check,n,f,r-f):C(a.check,n,f,r-f)),f=l,4&a.wrap&&(a.flags?h:Ne(h))!==a.check){t.msg="incorrect data check",a.mode=Le;break}h=0,d=0}a.mode=16207;case 16207:if(a.wrap&&a.flags){for(;d<32;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8}if(4&a.wrap&&h!==(4294967295&a.total)){t.msg="incorrect length check",a.mode=Le;break}h=0,d=0}a.mode=16208;case 16208:x=ve;break t;case Le:x=ze;break t;case 16210:return Ae;default:return xe}return t.next_out=r,t.avail_out=l,t.next_in=s,t.avail_in=o,a.hold=h,a.bits=d,(a.wsize||f!==t.avail_out&&a.mode<Le&&(a.mode<Fe||e!==be))&&We(t,t.output,t.next_out,f-t.avail_out),_-=t.avail_in,f-=t.avail_out,t.total_in+=_,t.total_out+=f,a.total+=f,4&a.wrap&&f&&(t.adler=a.check=a.flags?H(a.check,n,f,t.next_out-f):C(a.check,n,f,t.next_out-f)),t.data_type=a.bits+(a.last?64:0)+(a.mode===Se?128:0)+(a.mode===Oe||a.mode===Te?256:0),(0===_&&0===f||e===be)&&x===ke&&(x=Ee),x},inflateEnd:t=>{if(Ce(t))return xe;let e=t.state;return e.window&&(e.window=null),t.state=null,ke},inflateGetHeader:(t,e)=>{if(Ce(t))return xe;const a=t.state;return 0==(2&a.wrap)?xe:(a.head=e,e.done=!1,ke)},inflateSetDictionary:(t,e)=>{const a=e.length;let i,n,s;return Ce(t)?xe:(i=t.state,0!==i.wrap&&i.mode!==Ue?xe:i.mode===Ue&&(n=1,n=C(n,e,a,0),n!==i.check)?ze:(s=We(t,e,a,a),s?(i.mode=16210,Ae):(i.havedict=1,ke)))},inflateInfo:"pako inflate (from Nodeca project)"};var Je=function(){this.text=0,this.time=0,this.xflags=0,this.os=0,this.extra=null,this.extra_len=0,this.name="",this.comment="",this.hcrc=0,this.done=!1};const Qe=Object.prototype.toString,{Z_NO_FLUSH:Ve,Z_FINISH:$e,Z_OK:ta,Z_STREAM_END:ea,Z_NEED_DICT:aa,Z_STREAM_ERROR:ia,Z_DATA_ERROR:na,Z_MEM_ERROR:sa}=K;function ra(t){this.options=jt({chunkSize:65536,windowBits:15,to:""},t||{});const e=this.options;e.raw&&e.windowBits>=0&&e.windowBits<16&&(e.windowBits=-e.windowBits,0===e.windowBits&&(e.windowBits=-15)),!(e.windowBits>=0&&e.windowBits<16)||t&&t.windowBits||(e.windowBits+=32),e.windowBits>15&&e.windowBits<48&&0==(15&e.windowBits)&&(e.windowBits|=15),this.err=0,this.msg="",this.ended=!1,this.chunks=[],this.strm=new qt,this.strm.avail_out=0;let a=qe.inflateInit2(this.strm,e.windowBits);if(a!==ta)throw new Error(j[a]);if(this.header=new Je,qe.inflateGetHeader(this.strm,this.header),e.dictionary&&("string"==typeof e.dictionary?e.dictionary=Gt(e.dictionary):"[object ArrayBuffer]"===Qe.call(e.dictionary)&&(e.dictionary=new Uint8Array(e.dictionary)),e.raw&&(a=qe.inflateSetDictionary(this.strm,e.dictionary),a!==ta)))throw new Error(j[a])}function oa(t,e){const a=new ra(e);if(a.push(t),a.err)throw a.msg||j[a.err];return a.result}ra.prototype.push=function(t,e){const a=this.strm,i=this.options.chunkSize,n=this.options.dictionary;let s,r,o;if(this.ended)return!1;for(r=e===~~e?e:!0===e?$e:Ve,"[object ArrayBuffer]"===Qe.call(t)?a.input=new Uint8Array(t):a.input=t,a.next_in=0,a.avail_in=a.input.length;;){for(0===a.avail_out&&(a.output=new Uint8Array(i),a.next_out=0,a.avail_out=i),s=qe.inflate(a,r),s===aa&&n&&(s=qe.inflateSetDictionary(a,n),s===ta?s=qe.inflate(a,r):s===na&&(s=aa));a.avail_in>0&&s===ea&&a.state.wrap>0&&0!==t[a.next_in];)qe.inflateReset(a),s=qe.inflate(a,r);switch(s){case ia:case na:case aa:case sa:return this.onEnd(s),this.ended=!0,!1}if(o=a.avail_out,a.next_out&&(0===a.avail_out||s===ea))if("string"===this.options.to){let t=Wt(a.output,a.next_out),e=a.next_out-t,n=Xt(a.output,t);a.next_out=e,a.avail_out=i-e,e&&a.output.set(a.output.subarray(t,t+e),0),this.onData(n)}else this.onData(a.output.length===a.next_out?a.output:a.output.subarray(0,a.next_out));if(s!==ta||0!==o){if(s===ea)return s=qe.inflateEnd(this.strm),this.onEnd(s),this.ended=!0,!0;if(0===a.avail_in)break}}return!0},ra.prototype.onData=function(t){this.chunks.push(t)},ra.prototype.onEnd=function(t){t===ta&&("string"===this.options.to?this.result=this.chunks.join(""):this.result=Kt(this.chunks)),this.chunks=[],this.err=t,this.msg=this.strm.msg};var la={Inflate:ra,inflate:oa,inflateRaw:function(t,e){return(e=e||{}).raw=!0,oa(t,e)},ungzip:oa,constants:K};const{Deflate:ha,deflate:da,deflateRaw:_a,gzip:fa}=le,{Inflate:ca,inflate:ua,inflateRaw:wa,ungzip:ma}=la;var ba=ha,ga=da,pa=_a,ka=fa,va=ca,ya=ua,xa=wa,za=ma,Aa=K,Ea={Deflate:ba,deflate:ga,deflateRaw:pa,gzip:ka,Inflate:va,inflate:ya,inflateRaw:xa,ungzip:za,constants:Aa};t.Deflate=ba,t.Inflate=va,t.constants=Aa,t.default=Ea,t.deflate=ga,t.deflateRaw=pa,t.gzip=ka,t.inflate=ya,t.inflateRaw=xa,t.ungzip=za,Object.defineProperty(t,"__esModule",{value:!0})}));

};

/* ===== 装载 shim ===== */
var core = __req('shim-core');
var U8 = __req('shim-buffer');
var shimCrypto = __req('shim-crypto');
var shimUtil = __req('shim-util');
var shimPath = __req('shim-path');
var shimOs = __req('shim-os');
var shimStream = __req('shim-stream');
var shimFs = __req('shim-fs');
var shimZlib = __req('shim-zlib');
var shimHttp = __req('shim-http');
var stubs = __req('shim-stubs');

/* ===== bundle 运行面（对齐 harness2 ctx） ===== */
global.process = core.process;
global.Buffer = U8;
global.setImmediate = core.setImmediate;
global.clearImmediate = core.clearImmediate;
/* bundle 顶层 module.exports（入口导出 start/stop）：harness2 ctx 同款 */
global.module = { exports: {} };
global.exports = global.module.exports;
/* 藏 fetch：axios 探测到 fetch 走 fetch 适配器 → ArkWeb CORS 必炸；强制 http 适配器 → __catBridgeFetch */
try { global.fetch = undefined; } catch (e) { }
global.Buffer.INSPECT_MAX_BYTES = 50;

/* ===== bundle 的 external require 映射表 ===== */
var reg = {
  'events': core.events, 'node:events': core.events,
  'process': core.process, 'node:process': core.process,
  'timers': core.timers, 'node:timers': core.timers,
  'timers/promises': stubs.timersPromises, 'node:timers/promises': stubs.timersPromises,
  'buffer': U8, 'node:buffer': U8,
  'crypto': shimCrypto, 'node:crypto': shimCrypto,
  'util': shimUtil.util, 'node:util': shimUtil.util,
  'assert': shimUtil.assert, 'node:assert': shimUtil.assert, 'assert/strict': shimUtil.assert.strict,
  'path': shimPath, 'node:path': shimPath,
  'os': shimOs, 'node:os': shimOs,
  'stream': shimStream, 'node:stream': shimStream,
  'stream/web': {}, 'node:stream/web': {},
  'fs': shimFs, 'node:fs': shimFs,
  'fs/promises': shimFs.promises, 'node:fs/promises': shimFs.promises,
  'zlib': shimZlib, 'node:zlib': shimZlib,
  'http': shimHttp.http, 'node:http': shimHttp.http,
  'https': shimHttp.https, 'node:https': shimHttp.https,
  'url': stubs.url, 'node:url': stubs.url,
  'querystring': stubs.querystring, 'node:querystring': stubs.querystring,
  'string_decoder': { StringDecoder: stubs.StringDecoder }, 'node:string_decoder': { StringDecoder: stubs.StringDecoder },
  'dns': stubs.dns, 'node:dns': stubs.dns, 'dns/promises': stubs.dns.promises,
  'net': stubs.net, 'node:net': stubs.net,
  'tls': stubs.tls, 'node:tls': stubs.tls,
  'http2': stubs.http2, 'node:http2': stubs.http2,
  'tty': stubs.tty, 'node:tty': stubs.tty,
  'worker_threads': stubs.worker_threads, 'node:worker_threads': stubs.worker_threads,
  'async_hooks': stubs.async_hooks, 'node:async_hooks': stubs.async_hooks,
  'diagnostics_channel': stubs.diagnostics_channel, 'node:diagnostics_channel': stubs.diagnostics_channel,
  'perf_hooks': stubs.perf_hooks, 'node:perf_hooks': stubs.perf_hooks,
  'module': stubs.module, 'node:module': stubs.module
};
global.require = function (name) {
  if (name in reg) return reg[name];
  throw new Error("[catboot] 未知模块: " + name);
};

/* ===== fake server（对齐 harness2 Request2/Response2/FakeServer；stream 用 shim-stream） ===== */
var EE = core.EE;
function toU8(c) { return c instanceof Uint8Array ? c : new TextEncoder().encode(String(c)); }
function FakeRequest(url, method, headers, body) {
  var r = new shimStream.Readable();
  r.url = url; r.method = method; r.headers = headers || {};
  r.httpVersion = '1.1'; r.rawHeaders = [];
  r.socket = { remoteAddress: '127.0.0.1', remotePort: 0 };
  if (body) r.push(body);
  r.push(null);
  return r;
}
function FakeResponse(ondone) {
  var w = new shimStream.Writable();
  w.statusCode = 200; w.headers = {}; w.chunks = [];
  w.ondone = ondone; w.finished2 = false; w._headersSent = false;
  w.getHeader = function (name) { return this.headers[String(name).toLowerCase()]; };
  w.setHeader = function (name, value) { this.headers[String(name).toLowerCase()] = value; };
  w.hasHeader = function (name) { return this.headers[String(name).toLowerCase()] !== undefined; };
  w.appendHeader = function (name, value) {
    var k = String(name).toLowerCase();
    var cur = this.headers[k];
    if (cur === undefined) this.headers[k] = value;
    else if (Array.isArray(cur)) cur.push(value);
    else this.headers[k] = [cur, value];
  };
  w.removeHeader = function (name) { delete this.headers[String(name).toLowerCase()]; };
  Object.defineProperty(w, 'headersSent', { get: function () { return w._headersSent === true; } });
  w.writeHead = function (status, headers) {
    this.statusCode = status;
    this._headersSent = true;
    if (headers) for (var k in headers) this.headers[String(k).toLowerCase()] = headers[k];
    return this;
  };
  w._write = function (chunk, enc, cb) { w.chunks.push(toU8(chunk)); cb(); };
  w.end = function (chunk) {
    if (chunk !== undefined && chunk !== null) w.chunks.push(toU8(chunk));
    if (w.finished2) return;
    w.finished2 = true;
    try { shimStream.Writable.prototype.end.call(w); } catch (e) { }
    /* 采样延后：shim-stream write 是微任务异步 _write，handler 里 write(); end() 序列下
     * 同步采样会拿到空集（/config 空体根因）。宏任务时机（微任务排空后）再 concat */
    setImmediate(function () {
      var payload = Buffer.concat(w.chunks);
      var text = "";
      try { text = payload.toString('utf8'); } catch (e2) { text = String(payload); }
      ondone(w.statusCode, w.headers, text);
    });
  };
  return w;
}
function FakeServer() { EE.call(this); this.listened = false; this.port = 9988; }
FakeServer.prototype = Object.create(EE.prototype);
FakeServer.prototype.constructor = FakeServer;
FakeServer.prototype.listen = function (opts, cb) {
  this.listened = true;
  this.port = typeof opts === "number" ? opts : (opts && opts.port);
  var self = this;
  setImmediate(function () { if (cb) cb(); self.emit("listening"); });
  return this;
};
FakeServer.prototype.address = function () { return { port: this.port || 9988, address: '127.0.0.1', family: 'IPv4' }; };
FakeServer.prototype.close = function (cb) { if (cb) setImmediate(cb); return this; };
FakeServer.prototype.inject = function (url, o) {
  var opts = o || {};
  var method = opts.method || 'GET';
  var body = opts.body || null;
  var headers = Object.assign({ "content-type": "application/json" }, opts.headers || {});
  var self = this;
  return new Promise(function (resolve, reject) {
    var req = new FakeRequest(url, method, headers, body);
    var res = new FakeResponse(function (status, resHeaders, text) {
      resolve({ status: status, headers: resHeaders, body: text });
    });
    try { self.emit("request", req, res); } catch (e) { reject(e); }
  });
};
var fakeServerRef = null;
global.catServerFactory = function (handler, opts) {
  fakeServerRef = new FakeServer();
  fakeServerRef.on("request", handler);
  return fakeServerRef;
};
/* ArkTS 轮询探针：fake server 是否已 listen */
global.__catServerStatus = function () { return (fakeServerRef !== null && fakeServerRef.listened) ? 1 : 0; };

/* ===== 双向桥 ===== */
/* U8 → base64（分块 fromCharCode + btoa） */
function u8ToB64(u8) {
  var CH = 0x8000; var parts = [];
  for (var i = 0; i < u8.length; i += CH) {
    parts.push(String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length))));
  }
  return global.btoa(parts.join(""));
}
/* 沙盒 → ArkTS：fetch 桥（shim-http 契约：resolve {status, headers, body: Promise<b64>}） */
var bridgeSeq = 0;
var bridgePending = {};
global.__catBridgeFetch = function (url, init) {
  return new Promise(function (resolve, reject) {
    var id = ++bridgeSeq;
    bridgePending[id] = { resolve: resolve, reject: reject };
    var body = (init && init.body) ? init.body : "";
    var bodyB64 = "";
    try {
      if (body instanceof Uint8Array) bodyB64 = u8ToB64(body);
      else if (typeof body === "string" && body.length > 0) bodyB64 = u8ToB64(new TextEncoder().encode(body));
    } catch (e) { }
    var opts = {
      url: String(url),
      method: (init && init.method) ? String(init.method).toUpperCase() : "GET",
      headers: (init && init.headers) ? init.headers : {},
      body: bodyB64
    };
    try { global.catHost.fetchBridge(String(id), JSON.stringify(opts)); }
    catch (e) { delete bridgePending[id]; reject(new Error("[catboot] bridge down: " + (e && e.message || e))); }
  });
};
global.__catBridgeResolve = function (id, status, headersJson, b64body, errMsg) {
  var p = bridgePending[id];
  if (!p) return;
  delete bridgePending[id];
  if (errMsg) { p.reject(new Error(errMsg)); return; }
  var headers = {};
  try { headers = JSON.parse(headersJson || "{}"); } catch (e) { }
  p.resolve({ status: status, headers: headers, body: Promise.resolve(b64body || "") });
};
/* ArkTS → 沙盒：inject 面（VodClient Cat 协议请求） */
global.__catInject = function (id, method, url, body) {
  var sv = fakeServerRef;
  if (!sv || !sv.listened) {
    try { global.catHost.onInjectDone(String(id), 503, "", "sandbox not ready"); } catch (e) { }
    return;
  }
  sv.inject(url, { method: method, body: body === "" ? null : body }).then(function (r) {
    try { global.catHost.onInjectDone(String(id), r.status, r.body, ""); } catch (e) { }
  }, function (e) {
    try { global.catHost.onInjectDone(String(id), 500, "", String(e && e.message || e)); } catch (e2) { }
  });
};
/* 沙盒日志出口（ArkWeb 里 console 走 webview debuggable 日志） */
global.__catLog = function (s) { try { global.catHost.log(String(s)); } catch (e) { } };
global.__catBootState = "booted";
})(window);