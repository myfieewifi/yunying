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
