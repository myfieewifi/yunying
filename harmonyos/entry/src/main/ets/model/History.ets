import common from '@ohos.app.ability.common';
import dataPreferences from '@ohos.data.preferences';
import { BusinessError } from '@ohos.base';

/**
 * 云映播放历史（对齐安卓端 HistoryStore）：
 *   - SharedPreferences 存储 JSON，上限 50 条
 *   - 按 api+vodId 去重（同一站点的同一部剧只留一条）
 *   - 记录 到剧集（线路/集）/ 播放位置，首页继续观看与详情续播共用
 */
export class HistoryEntry {
  api: string = '';
  vodId: string = '';
  vodName: string = '';
  vodPic: string = '';
  flagIndex: number = 0;
  epIndex: number = 0;
  /** 播放到毫秒 */
  position: number = 0;
  /** 总时长毫秒（用于完成判定；0 = 未知） */
  durationMs: number = 0;
  updatedAt: number = 0;
}

const MAX_HISTORY = 50;

export class HistoryStore {

  static async all(ctx: common.Context): Promise<HistoryEntry[]> {
    try {
      const p = await dataPreferences.getPreferences(ctx, 'yunying');
      const raw = await p.get('yunying_play_history', '') as string;
      if (raw === '') {
        return [];
      }
      const arr = JSON.parse(raw) as HistoryEntry[];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      const err = e as BusinessError;
      return [];
    }
  }

  private static async save(ctx: common.Context, list: HistoryEntry[]): Promise<void> {
    try {
      const p = await dataPreferences.getPreferences(ctx, 'yunying');
      await p.put('yunying_play_history', JSON.stringify(list));
      await p.flush();
    } catch (e) {
      // 存储失败不致命
    }
  }

  /** 记录/更新一条历史（存在则置顶并更新位置） */
  static async record(ctx: common.Context, entry: HistoryEntry): Promise<void> {
    const list = await HistoryStore.all(ctx);
    let pos = Math.max(0, Math.floor(entry.position));
    if (entry.durationMs > 0 && entry.position >= entry.durationMs - 1000) {
      // 播完从头开始（完成态位置归 0）
      pos = 0;
    }
    const self = new HistoryEntry();
    self.api = entry.api;
    self.vodId = entry.vodId;
    self.vodName = entry.vodName;
    self.vodPic = entry.vodPic;
    self.flagIndex = entry.flagIndex;
    self.epIndex = entry.epIndex;
    self.position = pos;
    self.durationMs = entry.durationMs;
    self.updatedAt = Date.now();
    // 旧记录的封面补齐（首次记录可能没有封面）
    for (const it of list) {
      if (it.api === entry.api && it.vodId === entry.vodId) {
        if (self.vodPic === '') {
          self.vodPic = it.vodPic;
        }
        list.splice(list.indexOf(it), 1);
        break;
      }
    }
    list.unshift(self);
    if (list.length > MAX_HISTORY) {
      list.length = MAX_HISTORY;
    }
    await HistoryStore.save(ctx, list);
  }

  /** 删除一条 */
  static async remove(ctx: common.Context, api: string, vodId: string): Promise<void> {
    const list = await HistoryStore.all(ctx);
    for (const it of list.slice()) {
      if (it.api === api && it.vodId === vodId) {
        list.splice(list.indexOf(it), 1);
      }
    }
    await HistoryStore.save(ctx, list);
  }

  /** 清空 */
  static async clear(ctx: common.Context): Promise<void> {
    await HistoryStore.save(ctx, []);
  }
}
