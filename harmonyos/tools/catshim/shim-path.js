/* shim-path: posix 语义 path（fastify/vendor require 面） */
'use strict';
var SEP = '/';

function normalize(p) {
  var abs = String(p).charAt(0) === SEP;
  var parts = String(p).split(/[\\/]+/).filter(function (x) { return x.length > 0 && x !== '.'; });
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
    } else out.push(parts[i]);
  }
  var s = out.join(SEP);
  return (abs ? SEP : '') + (s.length ? s : (abs ? '' : '.'));
}
function join() {
  var args = Array.prototype.slice.call(arguments).filter(function (x) { return x !== undefined && x !== null && String(x).length > 0; });
  if (args.length === 0) return '.';
  return normalize(args.join(SEP));
}
function resolve() {
  var args = Array.prototype.slice.call(arguments);
  var abs = false;
  var parts = [];
  for (var i = args.length - 1; i >= 0; i--) {
    var seg = String(args[i]);
    if (seg.length === 0) continue;
    if (seg.charAt(0) === SEP) { abs = true; parts.unshift(seg); break; }
    parts.unshift(seg);
  }
  if (!abs) parts.unshift(typeof process !== 'undefined' && process.cwd ? process.cwd() : '/');
  return normalize(parts.join(SEP)) || SEP;
}
function dirname(p) {
  var s = String(p);
  var i = s.lastIndexOf(SEP);
  if (i < 0) return '.';
  if (i === 0) return SEP;
  return s.slice(0, i) || SEP;
}
function basename(p, ext) {
  var s = String(p);
  var i = s.lastIndexOf(SEP);
  var b = i < 0 ? s : s.slice(i + 1);
  if (ext && b.endsWith(String(ext))) b = b.slice(0, b.length - String(ext).length);
  return b || SEP;
}
function extname(p) {
  var b = basename(String(p));
  var i = b.lastIndexOf('.');
  if (i <= 0) return '';
  return b.slice(i);
}
function isAbsolute(p) { return String(p).charAt(0) === SEP; }
function relative(from, to) {
  var f = normalize(String(from)).split(SEP).filter(Boolean);
  var t = normalize(String(to)).split(SEP).filter(Boolean);
  var i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  var up = f.length - i;
  var out = [];
  for (var u = 0; u < up; u++) out.push('..');
  for (var d = i; d < t.length; d++) out.push(t[d]);
  return out.join(SEP) || '.';
}
function parse(p) {
  var s = String(p);
  var base = basename(s);
  var ext = extname(s);
  return {
    root: s.charAt(0) === SEP ? SEP : '',
    dir: dirname(s),
    base: base,
    ext: ext,
    name: ext ? base.slice(0, base.length - ext.length) : base,
  };
}
function format(po) {
  if (!po || typeof po !== 'object') return '.';
  var dir = po.dir || '';
  var base = po.base || ((po.name || '') + (po.ext || ''));
  if (!dir) return base || '.';
  return dir.endsWith(SEP) ? dir + base : dir + SEP + base;
}

module.exports = {
  normalize: normalize,
  join: join,
  resolve: resolve,
  dirname: dirname,
  basename: basename,
  extname: extname,
  isAbsolute: isAbsolute,
  relative: relative,
  parse: parse,
  format: format,
  sep: SEP,
  delimiter: ':',
  posix: null,
  win32: null,
};
module.exports.posix = module.exports;
module.exports.win32 = module.exports;
