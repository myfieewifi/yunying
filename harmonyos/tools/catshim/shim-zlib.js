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
