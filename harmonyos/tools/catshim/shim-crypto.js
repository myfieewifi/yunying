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
