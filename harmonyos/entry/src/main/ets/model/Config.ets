import common from '@ohos.app.ability.common';
import http from '@ohos.net.http';
import dataPreferences from '@ohos.data.preferences';
import window from '@ohos.window';
import { BusinessError } from '@ohos.base';

/**
 * 云映全局上下文（EntryAbility.onCreate 注入）
 */
export class Global {
  static context: common.Context | null = null;
  /** 主窗口（EntryAbility.onWindowStageCreate 注入，横竖屏/投屏用） */
  static mainWindow: window.Window | undefined = undefined;
}

/**
 * TVBox 订阅配置结构（对齐安卓端 Models.kt）：
 *   sites: 点播站点（v1 仅展示）
 *   lives: [{ group, channels: [{ name, urls: ["url", ...] }] }]
 */
export interface SiteItem {
  key?: string;
  name?: string;
  api?: string;
}

export interface LiveChannelItem {
  name?: string;
  urls?: string[];
}

export interface LiveGroupItem {
  group?: string;
  channels?: LiveChannelItem[];
}

export interface TvBoxConfig {
  spider?: string;
  sites?: SiteItem[];
  lives?: LiveGroupItem[];
}

// ---- 猫影视 CatVodSpiderios 配置结构（如 唐三 index.js GET /config）----

export interface CatSiteItem {
  key?: string;
  name?: string;
  api?: string;
  type?: number;
}

export interface CatVideoSection {
  sites?: CatSiteItem[];
}

export interface CatConfig {
  video?: CatVideoSection;
}

/** 直播页 UI 模型（避免可空字段，便于 ArkTS 状态管理） */
export class UILiveChannel {
  name: string = '';
  url: string = '';
}

export class UILiveGroup {
  group: string = '';
  channels: UILiveChannel[] = [];
}

/** 下载结果载体（ArkTS 不用内联对象字面量） */
export class DownloadResult {
  code: number = 0;
  text: string = '';
}

/**
 * 订阅配置加载器：
 *   - UA 依次回退（摸鱼儿等订阅站按 UA 拦截，okhttp/3.12.0 优先，与安卓端一致）
 *   - 3xx 手动跟随重定向（ArkTS http 不自动跟随）
 *   - JSON.parse 后按 TvBoxConfig 结构取值
 */
export class ConfigStore {

  static async loadFromUrl(url: string): Promise<TvBoxConfig> {
    const agents: string[] = ['okhttp/3.12.0', 'Mozilla/5.0', 'okhttp/4.12.0'];
    const client = http.createHttp();
    let lastCode = 0;
    try {
      for (const ua of agents) {
        let dr: DownloadResult;
        try {
          dr = await ConfigStore.fetchText(client, url, ua);
        } catch (e) {
          // 网络层失败：换下一个 UA 重试
          const err = e as BusinessError;
          lastCode = err.code;
          continue;
        }
        lastCode = dr.code;
        if (dr.text === '') {
          // 非 2xx（重定向耗尽/404 等）：换下一个 UA
          continue;
        }
        // 内容层（parse）错误直接传播——与 UA 无关，重试无意义；
        // "不是有效 JSON" 由 Index 侧接住转内嵌引擎
        return ConfigStore.parse(dr.text, url);
      }
    } finally {
      client.destroy();
    }
    throw new Error(`订阅下载失败 HTTP ${lastCode}（已尝试 ${agents.length} 种 UA）`);
  }

  /** 单 UA 下载：手动跟随 3xx 重定向（ArkTS http 不自动跟随，kstore 等存储站 http→https 301 常见）。
   *  返回最后响应码与 2xx 响应体；非 2xx / 重定向耗尽 text 为空串；网络异常抛出。订阅与站点 API 共用。 */
  static async fetchText(client: http.HttpRequest, url: string, ua: string): Promise<DownloadResult> {
    const out = new DownloadResult();
    let current = url;
    for (let hops = 0; hops < 5; hops++) {
      const resp = await client.request(current, {
        method: http.RequestMethod.GET,
        header: { 'User-Agent': ua },
        connectTimeout: 15000,
        readTimeout: 15000,
        expectDataType: http.HttpDataType.STRING
      });
      const code = resp.responseCode;
      out.code = code;
      if (code >= 300 && code < 400) {
        const loc = ConfigStore.headerValue(resp.header, 'location');
        if (loc === '') {
          break;
        }
        current = ConfigStore.resolveRedirect(current, loc);
        continue;
      }
      if (code >= 200 && code < 300) {
        const text = resp.result as string;
        if (text.length > 0) {
          out.text = text;
        }
      }
      break;
    }
    return out;
  }

  /** 响应头大小写不敏感取值（Location 可能是数组形态） */
  private static headerValue(h: object, name: string): string {
    try {
      const rec = h as Record<string, Object>;
      const keys = Object.keys(rec);
      for (let i = 0; i < keys.length; i++) {
        if (keys[i].toLowerCase() !== name) {
          continue;
        }
        const v = rec[keys[i]];
        if (typeof v === 'string') {
          return v as string;
        }
        if (typeof v === 'number') {
          return String(v);
        }
        if (Array.isArray(v)) {
          const arr = v as Array<Object>;
          return arr.length > 0 ? String(arr[0]) : '';
        }
      }
    } catch (e) {
      // 头解析失败按缺失处理
    }
    return '';
  }

  /** 相对 Location 解析为绝对 URL（含换协议/换站点跳转） */
  private static resolveRedirect(base: string, loc: string): string {
    const l = loc.trim();
    if (l.startsWith('http://') || l.startsWith('https://')) {
      return l;
    }
    const i = base.indexOf('://');
    if (i < 0) {
      return l;
    }
    const schemeEnd = i + 3;
    const slash = base.indexOf('/', schemeEnd);
    const origin = slash < 0 ? base : base.substring(0, slash);
    if (l.startsWith('/')) {
      return origin + l;
    }
    const dir = slash < 0 ? base + '/' : base.substring(0, base.lastIndexOf('/') + 1);
    return dir + l;
  }

  static parse(text: string, baseUrl: string | undefined): TvBoxConfig {
    let obj: object;
    try {
      obj = JSON.parse(text) as object;
    } catch (e) {
      // .js / .js.md5 猫影视源码包（唐三等）：内容是 JS 程序/校验串，不是 JSON 配置——Index 侧接住后转内嵌引擎
      throw new Error('订阅内容不是有效 JSON（.js/.md5 猫影视源码包将转内嵌引擎处理）');
    }
    if (obj === null) {
      throw new Error('订阅内容不是有效 JSON');
    }
    // 猫影视 Cat 配置（video.sites，api 为 /spider/{key}/{type} 相对路径）
    const cat = obj as CatConfig;
    if (cat.video !== undefined && Array.isArray(cat.video.sites) && (obj as TvBoxConfig).sites === undefined) {
      const out: TvBoxConfig = {};
      const sites: SiteItem[] = [];
      const base = (baseUrl ?? '').trim();
      const root = base.endsWith('/') ? base.substring(0, base.length - 1) : base;
      for (const s of cat.video.sites) {
        const api = (s.api ?? '').trim();
        if (api === '') {
          continue;
        }
        const abs = api.startsWith('http') ? api : `${root}${api}`;
        const item: SiteItem = {
          key: s.key ?? '',
          name: s.name ?? (s.key ?? '').replace(/^nodejs_/, ''),
          api: abs
        };
        sites.push(item);
      }
      out.sites = sites;
      return out;
    }
    return obj as TvBoxConfig;
  }

  /** 原始 urls 项可能是 "线路名$url"，取最后一段 */
  static pickUrl(raw: string): string {
    const t = raw.trim();
    if (t.includes('$')) {
      return t.substring(t.lastIndexOf('$') + 1);
    }
    return t;
  }
}

/** 轻量持久化（订阅地址等偏好） */
export class Prefs {

  static async getString(ctx: common.Context, key: string): Promise<string> {
    const p = await dataPreferences.getPreferences(ctx, 'yunying');
    const v = await p.get(key, '');
    return v as string;
  }

  static async putString(ctx: common.Context, key: string, value: string): Promise<void> {
    const p = await dataPreferences.getPreferences(ctx, 'yunying');
    await p.put(key, value);
    await p.flush();
  }
}
