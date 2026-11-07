import webview from '@ohos.web.webview';
import http from '@ohos.net.http';
import util from '@ohos.util';
import resourceManager from '@ohos.resourceManager';
import { BusinessError } from '@ohos.base';
import { Global } from './Config';

/**
 * A 轨内嵌 Cat 引擎（ArkWeb 沙盒）：
 *   - Web 壳（1px 隐藏组件）加载 rawfile/cat/cat.html，__catFeed 分块喂入
 *     catboot.js（shim 全套 + fake server + 桥）与 bundle.js（唐三引擎包）后 __catBoot 启动；
 *   - 沙盒内 require 全落 shim 映射表，axios 走 http 适配器 → __catBridgeFetch → ArkTS @ohos.net.http（无 CORS）；
 *   - VodClient Cat 协议请求经 __catInject 注入沙盒 fake server（harness2 同构链路），
 *     完成后经 catHost.onInjectDone 回调 ArkTS。
 *
 * 桥协议：
 *   ArkTS → JS  runJavaScript("__catInject(id, method, path, bodyJson)")
 *               runJavaScript("__catBridgeResolve(id, status, headersJson, b64, errMsg)")
 *   JS → ArkTS  catHost.fetchBridge(id, optsJson)        （shim-http 出站请求）
 *               catHost.onInjectDone(id, status, body, errMsg)
 *               catHost.log(s)
 */

/** fetch 桥请求参数（__catBridgeFetch 组装的 optsJson 结构） */
export interface BridgeOpts {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** inject 结果（fake server 响应） */
export class CatInjectResult {
  status: number = 0;
  body: string = '';
}

/** pending inject 回调载体（ArkTS 不用内联对象字面量） */
class PendingInject {
  resolve: (r: CatInjectResult) => void = (_r: CatInjectResult) => { };
  reject: (e: Error) => void = (_e: Error) => { };
}

/** 喂入分块大小（字符）：64KB——runJavaScript 大脚本 IPC 在部分真机上有长度上限，
 * 64KB 远低于已知阈值；bundle 6.4MB 约 100 次 IPC，真机实测 1-5s 可接受 */
const FEED_CHUNK: number = 64 * 1024;
/** 注入请求超时（ms）：fake server 挂起/桥丢失时兜底，防"加载中"永挂 */
const INJECT_TIMEOUT: number = 90000;

export class CatEngine {
  static controller: webview.WebviewController | null = null;
  /** idle → booting → ready / error */
  static bootState: string = 'idle';
  static errMsg: string = '';
  static injectSeq: number = 0;
  static pendingInject: Map<string, PendingInject> = new Map();
  /** idle 恢复：重发 cat.html 加载（$rawfile 仅 UI 上下文可用，CatEngineView 挂载时注入闭包） */
  static retryLoad: (() => void) | null = null;
  static retryCount: number = 0;

  /** 引擎是否支持站点（isCatSite 判定后调用） */
  static isReady(): boolean {
    return CatEngine.bootState === 'ready';
  }

  static publishState(): void {
    AppStorage.setOrCreate<string>('catEngineState', CatEngine.bootState);
  }

  /** 引擎进度/日志上屏（homeHint 可引用；只留最后一行，防内存增长） */
  static publishDebug(line: string): void {
    const s = line.length > 160 ? line.substring(0, 160) : line;
    AppStorage.setOrCreate<string>('catEngineDebug', s);
  }

  static sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void) => {
      setTimeout(() => {
        resolve();
      }, ms);
    });
  }

  /** runJavaScript 封装 */
  static async run(script: string): Promise<string> {
    const c = CatEngine.controller;
    if (c === null) {
      throw new Error('引擎 Web 壳未挂载');
    }
    return await c.runJavaScript(script);
  }

  /** rawfile JS 分块喂入：__catFeed × N（代理对边界回退），喂完即返回 */
  static async feed(rm: resourceManager.ResourceManager, name: string): Promise<void> {
    const raw = await rm.getRawFileContent(`cat/${name}`);
    const dec = util.TextDecoder.create('utf-8');
    const src = dec.decodeToString(raw);
    const total = Math.ceil(src.length / FEED_CHUNK);
    CatEngine.publishDebug(`喂入 ${name} 0/${total}`);
    for (let i = 0; i < src.length; i += FEED_CHUNK) {
      let end = Math.min(i + FEED_CHUNK, src.length);
      if (end < src.length) {
        // 代理对边界：尾字符是高代理则回退一码元
        const cc = src.charCodeAt(end - 1);
        if (cc >= 0xD800 && cc <= 0xDBFF) {
          end -= 1;
        }
      }
      const chunk = src.substring(i, end);
      await CatEngine.run(`__catFeed(${JSON.stringify(chunk)})`);
      CatEngine.publishDebug(`喂入 ${name} ${Math.round(i / FEED_CHUNK) + 1}/${total}`);
    }
  }

  /** Web 壳 onPageEnd 触发：喂 catboot+bundle → eval → __catStart → 轮询 fake server 就绪 */
  static async boot(): Promise<void> {
    if (CatEngine.bootState === 'booting' || CatEngine.bootState === 'ready') {
      return;
    }
    CatEngine.bootState = 'booting';
    CatEngine.errMsg = '';
    CatEngine.publishState();
    try {
      const ctx = Global.context;
      if (ctx === null) {
        throw new Error('无全局上下文');
      }
      const rm = ctx.resourceManager;
      CatEngine.publishDebug('引擎：读取内置源码');
      await CatEngine.feed(rm, 'catboot.js');
      await CatEngine.feed(rm, 'bundle.js');
      // cat.html 的 __catBoot：(0,eval) 拼接源 —— catboot IIFE 铺全局面，bundle 顶层执行并暴露 __catStart
      CatEngine.publishDebug('引擎：eval 启动（真机 10-30s 正常）');
      await CatEngine.run('__catBoot()');
      await CatEngine.run('typeof __catStart === "function" ? __catStart() : 0');
      let ok = false;
      for (let i = 0; i < 240; i++) {
        const s = await CatEngine.run('(globalThis.__catServerStatus ? String(__catServerStatus()) : "0")');
        if (s === '1') {
          ok = true;
          break;
        }
        if (i % 8 === 0) {
          CatEngine.publishDebug(`引擎：等待 fake server 就绪 ${Math.round(i * 0.25)}s/60s`);
        }
        await CatEngine.sleep(250);
      }
      if (!ok) {
        throw new Error('引擎启动超时（60s）');
      }
      CatEngine.publishDebug('引擎：就绪');
      CatEngine.bootState = 'ready';
    } catch (e) {
      CatEngine.bootState = 'error';
      const err = e as BusinessError;
      CatEngine.errMsg = err.message ?? '未知错误';
      CatEngine.publishDebug(`引擎启动失败：${CatEngine.errMsg}`);
    }
    CatEngine.publishState();
  }

  /** 等引擎就绪（booting/idle 阻塞等待最长 5 分钟；error 立即抛）。
   * 5 分钟下限依据：boot 自身预算 = 喂入 ~100 次 IPC + eval 7MB（真机 10-30s）
   * + fake server 等待 60s，真机低端机可超 60s，waitReady 必须比它更长 */
  static async waitReady(): Promise<void> {
    CatEngine.retryCount = 0;
    let guard = 0;
    while ((CatEngine.bootState === 'booting' || CatEngine.bootState === 'idle') && guard < 1200) {
      await CatEngine.sleep(250);
      guard++;
      if (CatEngine.bootState === 'idle') {
        // idle=boot 从未启动（onPageEnd 未触发）：显示接线状态区分"控制器没挂"和"页面没加载"
        if (guard % 16 === 0) {
          const wired = CatEngine.controller !== null;
          CatEngine.publishDebug(`引擎：等待 Web 壳挂载 ${Math.round(guard / 4)}s/300s（controller=${wired ? '已挂载' : '未挂载'}）`);
        }
        // 恢复路径：控制器已挂载但页面 20/40/60s 仍未加载完成 → 重发 loadUrl
        if (CatEngine.controller !== null && CatEngine.retryLoad !== null
          && guard % 80 === 0 && guard <= 240) {
          CatEngine.retryCount++;
          if (CatEngine.retryCount <= 3) {
            CatEngine.publishDebug(`引擎：页面 ${Math.round(guard / 4)}s 未就绪，重试加载（第 ${CatEngine.retryCount} 次）`);
            CatEngine.retryLoad();
          }
        }
      }
    }
    if (CatEngine.bootState !== 'ready') {
      let m = `Cat 引擎未就绪（${CatEngine.bootState}）`;
      if (CatEngine.bootState === 'booting') {
        m += '：引擎仍在启动中，请稍候重试';
      } else if (CatEngine.errMsg !== '') {
        m += `：${CatEngine.errMsg}`;
      }
      throw new Error(m);
    }
  }

  /**
   * 注入沙盒请求（VodClient Cat 协议统一入口）。
   * target 为站点 api（绝对 URL 自动截 /spider/ 起的路径；相对路径直用）。
   */
  static async catRequest(method: string, target: string, bodyJson: string): Promise<CatInjectResult> {
    await CatEngine.waitReady();
    let path = target;
    const sp = target.indexOf('/spider/');
    if (sp > 0) {
      path = target.substring(sp);
    }
    const id = `i${CatEngine.injectSeq}`;
    CatEngine.injectSeq++;
    const pi = new PendingInject();
    const done = new Promise<CatInjectResult>((resolve: (r: CatInjectResult) => void, reject: (e: Error) => void) => {
      pi.resolve = resolve;
      pi.reject = reject;
    });
    const timer = setTimeout(() => {
      // 沙盒挂起/桥丢失兜底：防"加载中"永挂
      if (CatEngine.pendingInject.delete(id)) {
        CatEngine.publishDebug(`注入超时 ${id}: ${path}`);
        pi.reject(new Error(`引擎注入超时（${Math.round(INJECT_TIMEOUT / 1000)}s）：${path}`));
      }
    }, INJECT_TIMEOUT);
    CatEngine.pendingInject.set(id, pi);
    try {
      await CatEngine.run(`__catInject(${JSON.stringify(id)},${JSON.stringify(method)},${JSON.stringify(path)},${JSON.stringify(bodyJson)})`);
    } catch (e) {
      clearTimeout(timer);
      CatEngine.pendingInject.delete(id);
      throw e as Error;
    }
    try {
      return await done;
    } finally {
      clearTimeout(timer);
    }
  }

  /** fetch 桥回调（catHost.fetchBridge → 此处）：ArkTS http 出站，结果回注沙盒 */
  static async fetchBridge(id: string, optsJson: string): Promise<void> {
    const opts = JSON.parse(optsJson) as BridgeOpts;
    const client = http.createHttp();
    let status = 0;
    let hdrJson = '{}';
    let b64 = '';
    let errMsg = '';
    try {
      const m = (opts.method ?? 'GET').toUpperCase();
      let method = http.RequestMethod.GET;
      if (m === 'POST') {
        method = http.RequestMethod.POST;
      } else if (m === 'PUT') {
        method = http.RequestMethod.PUT;
      } else if (m === 'DELETE') {
        method = http.RequestMethod.DELETE;
      } else if (m === 'HEAD') {
        method = http.RequestMethod.HEAD;
      } else if (m === 'OPTIONS') {
        method = http.RequestMethod.OPTIONS;
      }
      let extra: ArrayBuffer | undefined = undefined;
      if (opts.body !== undefined && opts.body !== '' && m !== 'GET' && m !== 'HEAD') {
        const bytes = new util.Base64Helper().decodeSync(opts.body);
        const ab = new ArrayBuffer(bytes.length);
        new Uint8Array(ab).set(bytes);
        extra = ab;
      }
      /* 强制 identity：netstack/服务端任一侧引入压缩都会与 axios fork 的 unzip 二次解压冲突
       *（shim-http 侧另有魔数校验兜底：头声明与 body 魔数不符时剥头） */
      const reqHdr: Record<string, string> = {};
      const srcHdr: Record<string, string> = opts.headers ?? {};
      const hdrKeys = Object.keys(srcHdr);
      for (let i = 0; i < hdrKeys.length; i++) {
        reqHdr[hdrKeys[i]] = srcHdr[hdrKeys[i]];
      }
      reqHdr['Accept-Encoding'] = 'identity';
      const resp = await client.request(opts.url ?? '', {
        method: method,
        header: reqHdr,
        extraData: extra,
        connectTimeout: 15000,
        readTimeout: 60000,
        expectDataType: http.HttpDataType.ARRAY_BUFFER,
        usingCache: false
      });
      status = resp.responseCode;
      const ab2 = resp.result as ArrayBuffer;
      b64 = new util.Base64Helper().encodeToStringSync(new Uint8Array(ab2));
      const hdrObj: Record<string, string> = {};
      const h = resp.header as object;
      if (h !== null && h !== undefined) {
        const ks = Object.keys(h);
        for (const k of ks) {
          const v = (h as Record<string, Object>)[k];
          if (typeof v === 'string') {
            hdrObj[k] = v as string;
          } else if (typeof v === 'number') {
            hdrObj[k] = String(v);
          }
        }
      }
      hdrJson = JSON.stringify(hdrObj);
    } catch (e) {
      const err = e as BusinessError;
      errMsg = err.message ?? `http ${err.code}`;
    } finally {
      client.destroy();
    }
    try {
      await CatEngine.run(`__catBridgeResolve(${JSON.stringify(id)},${status},${JSON.stringify(hdrJson)},${JSON.stringify(b64)},${JSON.stringify(errMsg)})`);
    } catch (e) {
      // Web 壳已销毁：静默
    }
  }

  /** inject 完成回调（catHost.onInjectDone → 此处） */
  static onInjectDone(id: string, status: number, body: string, errMsg: string): void {
    const pi = CatEngine.pendingInject.get(id);
    if (pi === undefined) {
      return;
    }
    CatEngine.pendingInject.delete(id);
    if (errMsg !== '') {
      pi.reject(new Error(errMsg));
      return;
    }
    const r = new CatInjectResult();
    r.status = status;
    r.body = body;
    pi.resolve(r);
  }
}

/** javaScriptProxy 桥对象（JS 侧 window.catHost） */
export class CatHostBridge {
  fetchBridge(id: string, optsJson: string): void {
    CatEngine.fetchBridge(id, optsJson);
  }

  onInjectDone(id: string, status: number, body: string, errMsg: string): void {
    CatEngine.onInjectDone(id, status, body, errMsg);
  }

  log(s: string): void {
    console.info(`[cat-host] ${s}`);
    CatEngine.publishDebug(`JS: ${s}`);
  }
}

/** 1px 隐藏 Web 壳组件（挂在 Index 页 Stack 底层） */
@Component
export struct CatEngineView {
  private controller: webview.WebviewController = new webview.WebviewController();
  private host: CatHostBridge = new CatHostBridge();

  build() {
    Web({ src: 'about:blank', controller: this.controller })
      .width(1)
      .height(1)
      .opacity(0.01)
      .hitTestBehavior(HitTestMode.None)
      .javaScriptAccess(true)
      .javaScriptProxy({
        object: this.host,
        name: 'catHost',
        methodList: ['fetchBridge', 'onInjectDone', 'log'],
        controller: this.controller
      })
      .onControllerAttached(() => {
        // 接线：run()/runJavaScript 全走这个静态引用（漏赋值会让引擎壳永远"未挂载"）
        CatEngine.controller = this.controller;
        // 供 waitReady 的 idle 恢复路径重发加载（$rawfile 仅 UI 上下文可用，闭包存在视图里）
        CatEngine.retryLoad = () => {
          try {
            this.controller.loadUrl($rawfile('cat/cat.html'));
          } catch (e) {
            CatEngine.publishDebug(`Web 壳：重试 loadUrl 抛错 ${(e as Error).message}`);
          }
        };
        CatEngine.publishDebug('Web 壳：控制器已挂载，加载 cat.html');
        try {
          this.controller.loadUrl($rawfile('cat/cat.html'));
        } catch (e) {
          CatEngine.publishDebug(`Web 壳：loadUrl 抛错 ${(e as Error).message}`);
        }
      })
      .onPageBegin((event) => {
        const u = event ? (event.url ?? '') : '';
        CatEngine.publishDebug(`Web 壳：开始加载 ${u.substring(0, 60)}`);
      })
      .onPageEnd((event) => {
        // 只认 cat.html 的加载完成：about:blank 初始 src 的 onPageEnd 若先行触发，
        // 会把引擎喂进即将被 loadUrl 淘汰的页面上下文（bootState=booting 早退 → 引擎锁死）
        const u = event ? (event.url ?? '') : '';
        CatEngine.publishDebug(`Web 壳：加载完成 ${u.substring(0, 60)}`);
        if (u.indexOf('cat.html') >= 0) {
          CatEngine.boot();
        }
      })
      .onErrorReceive((event) => {
        // 主框架/资源加载失败（文件缺失、找不到页面等）：区分"事件没触发"和"加载失败"
        const u = event && event.request ? event.request.getRequestUrl() : '';
        const msg = event && event.error ? event.error.getErrorInfo() : '';
        CatEngine.publishDebug(`Web 壳：加载错误 ${u.substring(0, 60)} ${msg}`);
      })
  }
}
