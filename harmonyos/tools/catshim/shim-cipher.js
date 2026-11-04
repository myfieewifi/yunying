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
