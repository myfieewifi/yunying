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
