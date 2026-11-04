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
