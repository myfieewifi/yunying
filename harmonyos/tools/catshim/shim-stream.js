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
