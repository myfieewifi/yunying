/* shim-os: os 模块基本面（沙盒静态值） */
'use strict';
module.exports = {
  platform: function () { return 'harmony'; },
  arch: function () { return 'arm64'; },
  type: function () { return 'HarmonyOS'; },
  release: function () { return '1.0.0'; },
  EOL: '\n',
  tmpdir: function () { return '/tmp'; },
  homedir: function () { return '/'; },
  hostname: function () { return 'catsandbox'; },
  userInfo: function () { return { username: 'sandbox', uid: -1, gid: -1, homedir: '/', shell: null }; },
  cpus: function () { return [{ model: 'sandbox', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }]; },
  totalmem: function () { return 0; },
  freemem: function () { return 0; },
  loadavg: function () { return [0, 0, 0]; },
  uptime: function () { return 0; },
  networkInterfaces: function () { return {}; },
  endianness: function () { return 'LE'; },
};
