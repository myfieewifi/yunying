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
