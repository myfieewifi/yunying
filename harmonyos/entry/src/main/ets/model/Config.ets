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

/**
 * 订阅配置加载器：
 *   - UA 依次回退（摸鱼儿等订阅站按 UA 拦截，okhttp/3.12.0 优先，与安卓端一致）
 *   - JSON.parse 后按 TvBoxConfig 结构取值
 */
export class ConfigStore {

  static async loadFromUrl(url: string): Promise<TvBoxConfig> {
    const agents: string[] = ['okhttp/3.12.0', 'Mozilla/5.0', 'okhttp/4.12.0'];
    const client = http.createHttp();
    let lastCode = 0;
    try {
      for (const ua of agents) {
        try {
          const resp = await client.request(url, {
            method: http.RequestMethod.GET,
            header: { 'User-Agent': ua },
            connectTimeout: 15000,
            readTimeout: 15000,
            expectDataType: http.HttpDataType.STRING
          });
          lastCode = resp.responseCode;
          if (resp.responseCode >= 200 && resp.responseCode < 300) {
            const text = resp.result as string;
            if (text.length > 0) {
              return ConfigStore.parse(text, url);
            }
          }
        } catch (e) {
          // 换下一个 UA 重试
          const err = e as BusinessError;
          lastCode = err.code;
        }
      }
    } finally {
      client.destroy();
    }
    throw new Error(`订阅下载失败 HTTP ${lastCode}（已尝试 ${agents.length} 种 UA）`);
  }

  static parse(text: string, baseUrl: string | undefined): TvBoxConfig {
    const obj = JSON.parse(text) as object;
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
