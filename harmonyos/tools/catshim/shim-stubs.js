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
