# 鸿蒙内嵌猫影视 JS 引擎（A 轨预研笔记）· 唐三 CatVodSpiderios

> B 轨（HTTP 网关 + ArkTS POST 协议客户端）已实现；本文记录把唐三
> `index.js`（6.5MB，MD5 f74942b8d68e6bc5297ac945e1718c66）跑在手机本地的可行性发现。

## 事实（已逆向确认）

1. **降级模式是官方设计**：启动检测到非标准 Node（iOS JSCore/flutter_js 宿主）时
   打印 `[system] [http] 检测到旧版Node/iOS环境，已全局切换为 node-fetch v3`
   —— 内部 HTTP 客户端自动退到 fetch，说明 bundle 可以脱离 Node 核心模块跑网络。
2. **HTTP 服务层可替换**：`globalThis.catServerFactory` 钩子存在时：
   - 不自动启动（autostart 判定为 false）
   - fastify 用 `serverFactory(opts, handler)` 创建服务实例 → 宿主自实现
     （Flutter 端即靠此把 fastify 请求引到自己实现的 Dart HTTP 报文层）
3. **profile 同步钩子**：`globalThis.messageToDart(type, payload)`，事件
   `queryProfile` / `saveProfile`（网盘 Cookie/memory 配置的云端同步）。
   本地模式返回 null / 存 preferences 即可。
4. **路由全面貌**（fastify，POST + JSON）：
   - `GET /health` → `{"ok":true,"name":"CatVodSpiderios"}`
   - `GET /config` / `/full-config` → `{video:{sites:[97]}}`，site.api=`/spider/{key}/{type}`
   - `POST /spider/{key}/{type}/init|home|homeVideo|category|detail|search|play`
   - `POST /spider/{key}/3/proxy/**`（音频歌词缓存、B 站 MPD 代理等）
5. **自启动条件**：`CATVOD_DISABLE_AUTOSTART=1` 环境变量或 argv[1] 不以
   `index.js` 结尾 → 不启动；`catServerFactory` 为函数 → 不启动。
6. 部分站点（fake115share 等）使用 `db.prepare/bind/step` —— 类 sqlite hinted，
   疑似 sql-wasm 内嵌（WebView 支持 wasm，需验证）。

## 鸿蒙内嵌路线（ArkWeb 沙盒方案）

```
ArkWeb(WebView)  ←→  ArkTS Bridge
  ├─ 注入 Node 垫片: Buffer / process / node:crypto(MD5,RSA,AES) / fetch
  ├─ 注入 globalThis.catServerFactory = (opts, handler) => BridgeServer
  │    BridgeServer: 轻量 req/res 模拟（light-my-request 复刻）
  │    ArkTS 侧把 POST /spider/... 请求转向 fake server.emit('request')
  ├─ messageToDart → preferences
  └─ autostart: argv 探测需要 polyfill process.argv（注入假路径 index.js 但
     由 CATVOD_DISABLE_AUTOSTART=1 控制，服务手动 init）
```

预计工作量：
- Node 垫片（Buffer/crypto/fetch/process）：大头，crypto 内含 RSA PKCS1、
  MD5、AES 等大量站点加密（guazi/189/xunlei 等直接 require node:crypto）。
  可用 jsrsasign/asmCrypto 之类纯 JS 库在前置注入（bundle 外再注入一段垫片 js）。
- light-my-request 复刻：几百行，官方 npm 包 light-my-request 逻辑可裁剪移植。
- WASM/worker 站点兼容：first release 可先不支持（少数站）。

## 风险

- 每个站的加密五花八门，垫片缺口按站点逐个补（B 轨已经把协议面定型，
  垫片只需让 bundle 能 init 起 spiders，不用的站点可挑）。
- ArkWeb runJavaScript 大代码块注入需要 http url 加载本地 html 方案
  （www 目录 + file 访问权限），长筒袜加载 6.5MB bundle 内存 OK（V8 堆）。

## 决定

- 先 B 轨上线（host 可配置的 POST 协议客户端），真实设备验证。
- A 轨沿用 B 轨的 `VodClient` 接口：`isCatSite/classes/list/detail/search/resolvePlayUrl`
  ——将来把「HTTP 去 127.0.0.1:9988」替换为「Bridge 直调」即零 UI 改动。
