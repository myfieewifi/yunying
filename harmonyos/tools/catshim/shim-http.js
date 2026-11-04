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
