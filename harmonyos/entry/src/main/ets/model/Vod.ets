import http from '@ohos.net.http';
import { BusinessError } from '@ohos.base';

/**
 * 云映点播 API 客户端（ArkTS 薄客户端，纯 HTTP），支持两种协议：
 *   1) maccms JSON 接口（type 0，GET ?ac=class/detail…）
 *      ?ac=class               → 分类
 *      ?ac=detail&t=xx&pg=n    → 分类列表（含播放地址）
 *      ?ac=detail&ids=xx       → 详情
 *      ?ac=detail&wd=xx        → 搜索
 *   2) 猫影视 Cat 协议（type 3 POST 端点，唐三 CatVodSpiderios 网关）
 *      POST {api}/home         → 分类+筛选
 *      POST {api}/category     → 分类列表 {id, page}
 *      POST {api}/detail       → 详情 {id}（vod_play_url 与 maccms 同构）
 *      POST {api}/search       → 搜索 {wd, page}
 *      POST {api}/play         → 播放解析 {id:<集URL>} → {url: 直链}
 *      jar/Python 爬虫站点（csp_/py_ 前缀）在鸿蒙端无法运行，自动跳过。
 */

// ---- maccms JSON 响应模型 ----
export interface RsClass {
  type_id?: string;
  type_name?: string;
}

export interface RsVod {
  vod_id?: string;
  vod_name?: string;
  vod_pic?: string;
  vod_remarks?: string;
  type_name?: string;
  vod_year?: string;
  vod_content?: string;
  vod_play_url?: string;
  vod_actor?: string;
  vod_director?: string;
}

export interface RsList {
  class?: RsClass[];
  list?: RsVod[];
  total?: number;
  pagecount?: number;
}

/** 站点可解析性判定：API 型站点（不含 csp_/py_ 前缀爬虫标记） */
export function isApiSite(api: string | undefined): boolean {
  const a = api ?? '';
  return a.startsWith('http') && !a.startsWith('csp_') && !a.startsWith('py_');
}

/** Cat 协议站点判定：api 形如 http://host:9988/spider/{key}/{type} */
export function isCatSite(api: string | undefined): boolean {
  const a = api ?? '';
  return a.startsWith('http') && a.includes('/spider/');
}

/** 站点 api 清洗：去掉 ;type=0 等参数段与首尾空白 */
export function cleanApi(api: string | undefined): string {
  const a = (api ?? '').trim();
  const cut = a.indexOf(';');
  if (cut >= 0) {
    return a.substring(0, cut).trim();
  }
  return a;
}

/** 选集 UI 模型（避免可空字段） */
export class UIEpisode {
  name: string = '';
  url: string = '';
}

/** 线路 UI 模型 */
export class UILine {
  flag: string = '';
  episodes: UIEpisode[] = [];
}

/** 详情 UI 模型 */
export class UIVodDetail {
  vodId: string = '';
  vodName: string = '';
  vodPic: string = '';
  remarks: string = '';
  year: string = '';
  content: string = '';
  lines: UILine[] = [];
}

/** 列表页 UI 模型 */
export class UIVod {
  vodId: string = '';
  vodName: string = '';
  vodPic: string = '';
  remarks: string = '';
  year: string = '';
}

export class UIClass {
  id: string = '';
  name: string = '';
}

// ---- 猫影视 Cat 协议（唐三 CatVodSpiderios）----

/** Cat 请求体（home/category/detail/search/play 复用） */
export interface CatBody {
  id?: string;
  page?: number;
  wd?: string;
  flag?: string;
}

/** Cat play 响应（url 直链；部分为 [名称,url,…] 交错数组） */
export interface CatPlayRs {
  parse?: number;
  url?: string | string[];
  header?: object;
}

/** Cat fastify 错误响应（如 网盘 Cookie 未配置） */
export interface CatErrorRs {
  message?: string;
}

/** POST JSON（Cat 协议统一请求） */
async function postJson(url: string, body: CatBody): Promise<object> {
  const client = http.createHttp();
  let lastErr = '';
  try {
    const resp = await client.request(url, {
      method: http.RequestMethod.POST,
      header: { 'Content-Type': 'application/json', 'User-Agent': 'okhttp/3.12.0' },
      extraData: JSON.stringify(body),
      connectTimeout: 15000,
      readTimeout: 60000,
      expectDataType: http.HttpDataType.STRING
    });
    const text = resp.result as string;
    if (resp.responseCode >= 200 && resp.responseCode < 300) {
      return JSON.parse(text) as object;
    }
    // fastify 错误响应带真实原因（如 网盘 Cookie 未配置）
    try {
      const eo = JSON.parse(text) as CatErrorRs;
      if (eo.message !== undefined && eo.message !== '') {
        lastErr = eo.message;
      } else {
        lastErr = `HTTP ${resp.responseCode}`;
      }
    } catch (e) {
      lastErr = `HTTP ${resp.responseCode}`;
    }
  } catch (e) {
    const err = e as BusinessError;
    lastErr = `${err.code}: ${err.message}`;
  } finally {
    client.destroy();
  }
  throw new Error(`${lastErr}`);
}

/** API 请求统一 UA/超时/重试 */
async function getJson(url: string): Promise<object> {
  const agents: string[] = ['okhttp/3.12.0', 'Mozilla/5.0'];
  const client = http.createHttp();
  let lastErr = '';
  try {
    for (const ua of agents) {
      try {
        const resp = await client.request(url, {
          method: http.RequestMethod.GET,
          header: { 'User-Agent': ua },
          connectTimeout: 15000,
          readTimeout: 20000,
          expectDataType: http.HttpDataType.STRING
        });
        if (resp.responseCode >= 200 && resp.responseCode < 300) {
          const text = resp.result as string;
          return JSON.parse(text) as object;
        }
      } catch (e) {
        const err = e as BusinessError;
        lastErr = `${err.code}: ${err.message}`;
      }
    }
  } finally {
    client.destroy();
  }
  throw new Error(`接口请求失败 ${url}（${lastErr}）`);
}

export class VodClient {

  /** 分类列表：maccms ?ac=class / Cat POST {api}/home */
  static async classes(api: string): Promise<UIClass[]> {
    let rs: RsList;
    if (isCatSite(api)) {
      const body: CatBody = { page: 1 };
      rs = await postJson(`${api}/home`, body) as RsList;
    } else {
      rs = await getJson(`${api}?ac=class`) as RsList;
    }
    const out: UIClass[] = [];
    const items = rs.class ?? [];
    for (const c of items) {
      const id = c.type_id ?? '';
      const name = c.type_name ?? '';
      if (id !== '' && name !== '') {
        const uc = new UIClass();
        uc.id = id;
        uc.name = name;
        out.push(uc);
      }
    }
    return out;
  }

  /** 分类分页列表：maccms ?ac=detail / Cat POST {api}/category */
  static async list(api: string, typeId: string, page: number): Promise<RsList> {
    if (isCatSite(api)) {
      const body: CatBody = { id: typeId, page: page };
      return await postJson(`${api}/category`, body) as RsList;
    }
    const url = `${api}?ac=detail&t=${encodeURIComponent(typeId)}&pg=${page}`;
    return await getJson(url) as RsList;
  }

  /** 详情：maccms ?ac=detail&ids= / Cat POST {api}/detail */
  static async detail(api: string, vodId: string): Promise<RsList> {
    if (isCatSite(api)) {
      const body: CatBody = { id: vodId };
      return await postJson(`${api}/detail`, body) as RsList;
    }
    const url = `${api}?ac=detail&ids=${encodeURIComponent(vodId)}`;
    return await getJson(url) as RsList;
  }

  /** 搜索：maccms ?ac=detail&wd= / Cat POST {api}/search */
  static async search(api: string, keyword: string): Promise<RsList> {
    if (isCatSite(api)) {
      const body: CatBody = { wd: keyword, page: 1 };
      return await postJson(`${api}/search`, body) as RsList;
    }
    const url = `${api}?ac=detail&wd=${encodeURIComponent(keyword)}`;
    return await getJson(url) as RsList;
  }

  /** Cat 播放解析：POST {api}/play {id:<集URL>} → 直链 */
  static async resolvePlayUrl(api: string, epUrl: string): Promise<string> {
    const body: CatBody = { id: epUrl };
    const rs = await postJson(`${api}/play`, body) as CatPlayRs;
    const raw = rs.url;
    if (typeof raw === 'string' && raw !== '') {
      return raw;
    }
    if (Array.isArray(raw)) {
      // 交错数组 [名称,url,…]：取第一个 http 项
      for (const it of raw) {
        if (typeof it === 'string' && it.startsWith('http')) {
          return it;
        }
      }
    }
    throw new Error('play 未返回可播地址');
  }

  /** RsVod → UIVod（列表卡片） */
  static toUIVod(v: RsVod): UIVod {
    const u = new UIVod();
    u.vodId = v.vod_id ?? '';
    u.vodName = v.vod_name ?? '';
    u.vodPic = v.vod_pic ?? '';
    u.remarks = v.vod_remarks ?? '';
    u.year = v.vod_year ?? '';
    return u;
  }

  /** vod_play_url 解析：线路$$$线路 → 线路内 集#集 → 集= 名称$url */
  static parseLines(playUrl: string): UILine[] {
    const lines: UILine[] = [];
    const flagGroups = playUrl.split('$$$');
    for (const g of flagGroups) {
      if (g.trim() === '') {
        continue;
      }
      const headCut = g.indexOf('$');
      const flag = headCut >= 0 ? g.substring(0, headCut).trim() : '';
      const body = headCut >= 0 ? g.substring(headCut + 1) : g;
      const line = new UILine();
      line.flag = flag;
      const segs = body.split('#');
      for (const seg of segs) {
        const t = seg.trim();
        if (t === '') {
          continue;
        }
        const uCut = t.lastIndexOf('$');
        const ep = new UIEpisode();
        if (uCut >= 0) {
          ep.name = t.substring(0, uCut).trim();
          ep.url = t.substring(uCut + 1).trim();
        } else {
          ep.name = t;
          ep.url = t;
        }
        if (ep.url !== '') {
          line.episodes.push(ep);
        }
      }
      if (line.episodes.length > 0) {
        lines.push(line);
      }
    }
    return lines;
  }

  /** RsVod → UIVodDetail（含线路解析） */
  static toUIDetail(v: RsVod): UIVodDetail {
    const d = new UIVodDetail();
    d.vodId = v.vod_id ?? '';
    d.vodName = v.vod_name ?? '';
    d.vodPic = v.vod_pic ?? '';
    d.remarks = v.vod_remarks ?? '';
    d.year = v.vod_year ?? '';
    d.content = v.vod_content ?? '';
    d.lines = VodClient.parseLines(v.vod_play_url ?? '');
    return d;
  }
}

/**
 * 播放会话（跨页面参数载体）：
 *   详情页选定线路/集后写入，player 页读取并记录历史。
 */
export class PlaySession {
  static api: string = '';
  static vodId: string = '';
  static vodName: string = '';
  static vodPic: string = '';
  static flags: string[] = [];
  static epNames: string[][] = [];
  static epUrls: string[][] = [];
  static flagIndex: number = 0;
  static epIndex: number = 0;
  static resumePosition: number = 0;

  static reset(): void {
    PlaySession.api = '';
    PlaySession.vodId = '';
    PlaySession.vodName = '';
    PlaySession.vodPic = '';
    PlaySession.flags = [];
    PlaySession.epNames = [];
    PlaySession.epUrls = [];
    PlaySession.flagIndex = 0;
    PlaySession.epIndex = 0;
    PlaySession.resumePosition = 0;
  }

  static hasTarget(): boolean {
    return PlaySession.vodName !== '' && PlaySession.epUrls.length > 0
      && PlaySession.flagIndex < PlaySession.flags.length;
  }
}
