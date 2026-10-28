import media from '@ohos.multimedia.media';
import router from '@ohos.router';
import { BusinessError } from '@ohos.base';
import {
  ConfigStore,
  Global,
  Prefs,
  UILiveChannel,
  UILiveGroup
} from '../model/Config';
import {
  cleanApi,
  PlaySession,
  RsList,
  UIClass,
  UIVod,
  UIVodDetail,
  UILine,
  UIEpisode,
  VodClient
} from '../model/Vod';
import { HistoryEntry, HistoryStore } from '../model/History';

// ---- 云映品牌色（仿腾讯视频：深色底 + 腾讯蓝） ----
const COLOR_BG = '#0B0B0F';
const COLOR_SURFACE = '#14141C';
const COLOR_SURFACE_HIGH = '#1E1E2A';
const COLOR_BAR = '#12121A';
const COLOR_ACCENT = '#3D7EFF';
const COLOR_GOLD = '#FFB03A';
const COLOR_TEXT = '#FFFFFF';
const COLOR_TEXT_SUB = '#9A9AAC';
const COLOR_TEXT_DIM = '#66667A';

/**
 * 云映主界面（HarmonyOS NEXT / ArkTS Stage 模型）：
 *   底部导航：首页(点播) / 直播 / 设置
 *   首页：继续观看 + 站点源条 + 搜索 + 分类 + 视频流（腾讯视频式）+ 详情面板
 *   直播：频道组列表 + AVPlayer 播放（XComponent surface）
 *   设置：订阅管理 + 历史管理 + 关于（云映 1.0.0）
 */
@Entry
@Component
struct Index {

  // ---- 全局状态 ----
  @State currentIndex: number = 0;
  private tabController: TabsController = new TabsController();

  // ---- 订阅 ----
  @State configUrl: string = '';
  @State urlInput: string = '';
  @State siteNames: string[] = [];
  @State siteApis: string[] = [];
  @State currentSiteIndex: number = 0;
  @State loading: boolean = false;
  @State homeHint: string = '导入 TVBox 订阅，开启追剧之旅';

  // ---- 点播：分类/列表/分页 ----
  @State classList: UIClass[] = [];
  @State currentClassIndex: number = 0;
  @State vods: UIVod[] = [];
  @State page: number = 1;
  @State pagecount: number = 1;
  @State vodLoading: boolean = false;

  // ---- 点播：搜索 ----
  @State searchInput: string = '';
  @State searching: boolean = false;
  @State searchResults: UIVod[] = [];
  @State searchActive: boolean = false;

  // ---- 点播：详情面板 ----
  @State showDetail: boolean = false;
  @State detailLoading: boolean = false;
  @State detail: UIVodDetail = new UIVodDetail();
  @State detailLineIndex: number = 0;
  @State detailError: string = '';

  // ---- 继续观看 ----
  @State history: HistoryEntry[] = [];

  // ---- 直播 ----
  @State liveGroups: UILiveGroup[] = [];
  @State currentGroupIndex: number = 0;
  @State playingName: string = '';
  @State playingUrl: string = '';
  @State playerStatus: string = '';
  private avPlayer?: media.AVPlayer;
  private surfaceId: string = '';
  private pendingPlay: string = '';
  private xcController: XComponentController = new XComponentController();

  // ================= 生命周期 =================

  aboutToAppear(): void {
    this.initAsync();
  }

  /** 从播放器返回时刷新历史（@Entry 页面回调） */
  onPageShow(): void {
    this.refreshHistory();
  }

  private async initAsync(): Promise<void> {
    const ctx = Global.context;
    if (ctx === null) {
      return;
    }
    const saved = await Prefs.getString(ctx, 'config_url');
    if (saved !== '') {
      this.configUrl = saved;
      this.urlInput = saved;
      await this.importConfig(saved);
    }
  }

  private async refreshHistory(): Promise<void> {
    const ctx = Global.context;
    if (ctx === null) {
      return;
    }
    this.history = await HistoryStore.all(ctx);
  }

  aboutToDisappear(): void {
    this.releasePlayer();
  }

  // ================= 订阅 =================

  private async importConfig(url: string): Promise<void> {
    const target = url.trim();
    if (!target.startsWith('http://') && !target.startsWith('https://')) {
      this.homeHint = '请输入 http(s) 开头的订阅地址';
      return;
    }
    this.loading = true;
    this.homeHint = '正在加载订阅…';
    try {
      const cfg = await ConfigStore.loadFromUrl(target);
      // 站点条（仅保留鸿蒙可用的 API 型站点）
      const names: string[] = [];
      const apis: string[] = [];
      const sites = cfg.sites ?? [];
      for (const s of sites) {
        const apiRaw = cleanApi(s.api);
        if (apiRaw === '') {
          continue;
        }
        const n = s.name ?? s.key ?? '';
        if (!apiRaw.startsWith('http')) {
          // jar/Python 爬虫站点：鸿蒙端暂不支持，跳过
          continue;
        }
        names.push(n);
        apis.push(apiRaw);
      }
      this.siteNames = names;
      this.siteApis = apis;
      this.currentSiteIndex = 0;
      // 直播频道
      const groups: UILiveGroup[] = [];
      const lives = cfg.lives ?? [];
      for (const g of lives) {
        const ug = new UILiveGroup();
        ug.group = g.group ?? '直播';
        const channels = g.channels ?? [];
        for (const c of channels) {
          const rawList = c.urls ?? [];
          if (rawList.length === 0) {
            continue;
          }
          const url2 = ConfigStore.pickUrl(rawList[0]);
          if (url2 === '') {
            continue;
          }
          const uc = new UILiveChannel();
          uc.name = c.name ?? '频道';
          uc.url = url2;
          ug.channels.push(uc);
        }
        if (ug.channels.length > 0) {
          groups.push(ug);
        }
      }
      this.liveGroups = groups;
      this.currentGroupIndex = 0;
      this.configUrl = target;
      this.loading = false;
      const usable = names.length === sites.length ? `${names.length} 个站点` :
        `${names.length} 个站点（另 ${sites.length - names.length} 个爬虫站点暂不支持）`;
      this.homeHint = `已加载：${usable} / ${groups.length} 个频道组`;
      const ctx = Global.context;
      if (ctx !== null) {
        await Prefs.putString(ctx, 'config_url', target);
      }
      // 默认加载第一个站点（对齐苹果端：进首页即有内容）
      this.refreshHistory();
      if (names.length > 0) {
        await this.openSite(0);
      }
    } catch (e) {
      const err = e as BusinessError;
      this.loading = false;
      this.homeHint = `加载失败：${err.message}`;
    }
  }

  // ================= 点播 =================

  /** 切换站点：加载分类 + 第一页列表 */
  private async openSite(idx: number): Promise<void> {
    if (idx < 0 || idx >= this.siteApis.length || this.vodLoading) {
      return;
    }
    this.currentSiteIndex = idx;
    this.searchActive = false;
    this.searchResults = [];
    this.page = 1;
    this.pagecount = 1;
    this.vods = [];
    this.classList = [];
    this.currentClassIndex = 0;
    this.vodLoading = true;
    const api = this.siteApis[idx];
    try {
      const classes = await VodClient.classes(api);
      this.classList = classes;
      let list: RsList = { list: [] };
      if (classes.length > 0) {
        list = await VodClient.list(api, classes[0].id, 1);
      } else {
        list = await VodClient.list(api, '', 1);
      }
      const items = list.list ?? [];
      const ui: UIVod[] = [];
      for (const v of items) {
        ui.push(VodClient.toUIVod(v));
      }
      this.vods = ui;
      this.page = 1;
      this.pagecount = list.pagecount ?? 1;
      this.vodLoading = false;
    } catch (e) {
      const err = e as BusinessError;
      this.vodLoading = false;
      this.homeHint = `站点加载失败：${err.message}`;
      this.vods = [];
    }
  }

  /** 加载下一页 */
  private async loadMore(): Promise<void> {
    if (this.vodLoading || this.searchActive) {
      return;
    }
    if (this.page >= this.pagecount) {
      return;
    }
    if (this.currentSiteIndex >= this.siteApis.length) {
      return;
    }
    this.vodLoading = true;
    const api = this.siteApis[this.currentSiteIndex];
    const classId = this.classList.length > 0 ? this.classList[this.currentClassIndex].id : '';
    try {
      const list = await VodClient.list(api, classId, this.page + 1);
      const ui: UIVod[] = [];
      for (const v of (list.list ?? [])) {
        ui.push(VodClient.toUIVod(v));
      }
      // 局部刷新替代 splice（避免 ForEach 键冲突）
      this.vods = this.vods.concat(ui);
      this.page = this.page + 1;
      this.pagecount = list.pagecount ?? this.pagecount;
      this.vodLoading = false;
    } catch (e) {
      this.vodLoading = false;
    }
  }

  /** 切分类（清空重新拉第一页） */
  private async switchClass(idx: number): Promise<void> {
    if (idx >= this.classList.length || this.vodLoading) {
      return;
    }
    this.currentClassIndex = idx;
    this.vods = [];
    this.page = 1;
    this.pagecount = 1;
    this.vodLoading = true;
    const api = this.siteApis[this.currentSiteIndex];
    try {
      const list = await VodClient.list(api, this.classList[idx].id, 1);
      const ui: UIVod[] = [];
      for (const v of (list.list ?? [])) {
        ui.push(VodClient.toUIVod(v));
      }
      this.vods = ui;
      this.page = 1;
      this.pagecount = list.pagecount ?? 1;
      this.vodLoading = false;
    } catch (e) {
      this.vodLoading = false;
      this.homeHint = '该分类加载失败';
    }
  }

  /** 搜索 */
  private async doSearch(): Promise<void> {
    const kw = this.searchInput.trim();
    if (kw === '' || this.searching) {
      return;
    }
    if (this.currentSiteIndex >= this.siteApis.length) {
      return;
    }
    this.searching = true;
    this.searchActive = true;
    this.searchResults = [];
    const api = this.siteApis[this.currentSiteIndex];
    try {
      const list = await VodClient.search(api, kw);
      const ui: UIVod[] = [];
      for (const v of (list.list ?? [])) {
        ui.push(VodClient.toUIVod(v));
      }
      this.searchResults = ui;
    } catch (e) {
      // 搜索失败留空结果
    }
    this.searching = false;
  }

  /** 退出搜索回到分类浏览 */
  private exitSearch(): void {
    this.searchActive = false;
    this.searchResults = [];
    this.searchInput = '';
  }

  /** 打开详情面板 */
  private async openDetail(vodId: string): Promise<void> {
    if (this.currentSiteIndex >= this.siteApis.length) {
      return;
    }
    this.showDetail = true;
    this.detailLoading = true;
    this.detailError = '';
    const api = this.siteApis[this.currentSiteIndex];
    try {
      const list = await VodClient.detail(api, vodId);
      const items = list.list ?? [];
      if (items.length === 0) {
        throw new Error('未找到详情');
      }
      const d = VodClient.toUIDetail(items[0]);
      if (d.lines.length === 0) {
        // 详情接口异常时回退：用列表里的原始数据兜底
        throw new Error('无可用播放线路');
      }
      this.detail = d;
      this.detailLineIndex = 0;
      this.detailLoading = false;
    } catch (e) {
      const err = e as BusinessError;
      this.detailLoading = false;
      this.detailError = err.message ?? '详情加载失败';
    }
  }

  /** 从详情面板播放选集（含历史续播判断） */
  private async playEpisode(lineIdx: number, epIdx: number): Promise<void> {
    const lines = this.detail.lines;
    if (lineIdx >= lines.length || epIdx >= lines[lineIdx].episodes.length) {
      return;
    }
    PlaySession.reset();
    PlaySession.api = this.siteApis[this.currentSiteIndex];
    PlaySession.vodId = this.detail.vodId;
    PlaySession.vodName = this.detail.vodName;
    PlaySession.vodPic = this.detail.vodPic;
    for (const l of lines) {
      PlaySession.flags.push(l.flag);
      const names: string[] = [];
      const urls: string[] = [];
      for (const ep of l.episodes) {
        names.push(ep.name);
        urls.push(ep.url);
      }
      PlaySession.epNames.push(names);
      PlaySession.epUrls.push(urls);
    }
    PlaySession.flagIndex = lineIdx;
    PlaySession.epIndex = epIdx;
    // 续播：历史里是同一站的同部剧才恢复位置
    PlaySession.resumePosition = 0;
    for (const h of this.history) {
      if (h.api === PlaySession.api && h.vodId === PlaySession.vodId
        && h.flagIndex === lineIdx && h.epIndex === epIdx && h.position > 5000) {
        PlaySession.resumePosition = h.position;
        break;
      }
    }
    this.showDetail = false;
    router.pushUrl({ url: 'pages/VodPlayer' }).catch(() => {});
  }

  /** 直接从历史继续播放（先拉详情拿线路再续播） */
  private async resumeFromHistory(h: HistoryEntry): Promise<void> {
    this.showDetail = false;
    this.detailLoading = true;
    this.detailError = '';
    try {
      // 历史的 api 与当前站点条无关：直接用历史存的 api
      const list = await VodClient.detail(h.api, h.vodId);
      const items = list.list ?? [];
      if (items.length === 0) {
        throw new Error('未找到剧集详情');
      }
      const d = VodClient.toUIDetail(items[0]);
      if (d.lines.length === 0) {
        throw new Error('无可用播放线路');
      }
      PlaySession.reset();
      PlaySession.api = h.api;
      PlaySession.vodId = d.vodId;
      PlaySession.vodName = d.vodName;
      PlaySession.vodPic = d.vodPic === '' ? h.vodPic : d.vodPic;
      for (const l of d.lines) {
        PlaySession.flags.push(l.flag);
        const names: string[] = [];
        const urls: string[] = [];
        for (const ep of l.episodes) {
          names.push(ep.name);
          urls.push(ep.url);
        }
        PlaySession.epNames.push(names);
        PlaySession.epUrls.push(urls);
      }
      // 历史存的线路/集索引可能失效，越界回退 0
      const fi = d.lines.length === 0 ? 0 : Math.min(h.flagIndex, d.lines.length - 1);
      const line = d.lines[fi];
      const ei = line === undefined ? 0 : Math.min(h.epIndex, line.episodes.length - 1);
      PlaySession.flagIndex = fi;
      PlaySession.epIndex = ei;
      PlaySession.resumePosition = h.position;
      this.detailLoading = false;
      router.pushUrl({ url: 'pages/VodPlayer' }).catch(() => {});
    } catch (e) {
      const err = e as BusinessError;
      this.detailLoading = false;
      this.homeHint = `继续观看失败：${err.message ?? ''}`;
    }
  }

  /** 找当前站点的某部剧的历史（详情面板显示前次进度） */
  private historyEpLabel(lineIdx: number, epIdx: number): string {
    if (this.currentSiteIndex >= this.siteApis.length) {
      return '';
    }
    const api = this.siteApis[this.currentSiteIndex];
    for (const h of this.history) {
      if (h.api === api && h.vodId === this.detail.vodId
        && h.flagIndex === lineIdx && h.epIndex === epIdx && h.position > 5000) {
        return `已看到${Math.floor(h.position / 60000)}分`;
      }
    }
    return '';
  }

  // ================= 播放（直播） =================

  private async onChannelTap(ch: UILiveChannel): Promise<void> {
    this.playingName = ch.name;
    this.playingUrl = ch.url;
    this.playerStatus = '准备中…';
    if (this.surfaceId === '') {
      // XComponent 尚未就绪，等 onLoad 回调再开播
      this.pendingPlay = ch.url;
    } else {
      await this.startPlay(ch.url);
    }
  }

  private async startPlay(url: string): Promise<void> {
    await this.releasePlayerAsync();
    try {
      const player = await media.createAVPlayer();
      this.avPlayer = player;
      player.on('error', (err: BusinessError) => {
        this.playerStatus = `播放失败：${err.message}`;
      });
      player.on('stateChange', (state: string, reason: media.StateChangeReason) => {
        if (state === 'prepared') {
          this.playerStatus = '缓冲中…';
          player.play();
        } else if (state === 'playing') {
          this.playerStatus = '正在播放';
        } else if (state === 'paused') {
          this.playerStatus = '已暂停';
        } else if (state === 'error') {
          this.playerStatus = '播放出错，请换频道';
        }
      });
      player.url = url;
      if (this.surfaceId !== '') {
        player.surfaceId = this.surfaceId;
      }
      await player.prepare();
    } catch (e) {
      const err = e as BusinessError;
      this.playerStatus = `播放失败：${err.message}`;
    }
  }

  private async releasePlayerAsync(): Promise<void> {
    const p = this.avPlayer;
    this.avPlayer = undefined;
    if (p !== undefined) {
      try {
        await p.release();
      } catch (e) {
        // 忽略释放异常
      }
    }
  }

  private releasePlayer(): void {
    this.releasePlayerAsync();
  }

  // ================= UI =================

  build() {
    Stack() {
      Tabs({
        barPosition: BarPosition.End,
        controller: this.tabController
      }) {
        TabContent() {
          this.buildHome()
        }
        .tabBar(this.tabBarItem(0, '首页'))

        TabContent() {
          this.buildLive()
        }
        .tabBar(this.tabBarItem(1, '直播'))

        TabContent() {
          this.buildSettings()
        }
        .tabBar(this.tabBarItem(2, '设置'))
      }
      .barHeight(56)
      .barMode(BarMode.Fixed)
      .backgroundColor(COLOR_BAR)
      .onChange((index: number) => {
        this.currentIndex = index;
        if (index !== 1 && this.avPlayer !== undefined) {
          // 离开直播页暂停，省资源
          this.avPlayer.pause();
        }
        if (index === 0) {
          this.refreshHistory();
        }
      })
      .width('100%')
      .layoutWeight(1)

      // 详情面板（全屏覆盖层）
      if (this.showDetail) {
        this.buildDetailPanel()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(COLOR_BG)
  }

  // ---- 底部导航项 ----

  @Builder
  tabBarItem(index: number, title: string) {
    Column() {
      Text(title)
        .fontSize(13)
        .fontWeight(this.currentIndex === index ? FontWeight.Bold : FontWeight.Normal)
        .fontColor(this.currentIndex === index ? COLOR_ACCENT : COLOR_TEXT_SUB)
    }
    .justifyContent(FlexAlign.Center)
    .width('100%')
    .height('100%')
  }

  // ---- 顶栏（腾讯视频式 logo） ----

  @Builder
  topBar() {
    Row() {
      Text('云映')
        .fontSize(24)
        .fontWeight(FontWeight.Bold)
        .fontColor(COLOR_TEXT)
      Text('VIDEO')
        .fontSize(11)
        .fontWeight(FontWeight.Bold)
        .fontColor(COLOR_ACCENT)
        .margin({ left: 4, bottom: 4 })
    }
    .alignItems(VerticalAlign.Bottom)
    .width('100%')
    .padding({ left: 20, right: 20, top: 14, bottom: 10 })
  }

  // ---- 首页（点播） ----

  @Builder
  buildHome() {
    Column() {
      this.topBar()

      Scroll() {
        Column() {
          // 继续观看
          if (this.history.length > 0) {
            Text('继续观看')
              .fontSize(16)
              .fontWeight(FontWeight.Bold)
              .fontColor(COLOR_TEXT)
              .margin({ top: 4, bottom: 2 })
            Scroll() {
              Row({ space: 10 }) {
                ForEach(this.history, (h: HistoryEntry) => {
                  Column() {
                    Image(h.vodPic === '' ? '' : h.vodPic)
                      .width(96).height(128)
                      .objectFit(ImageFit.Cover)
                      .borderRadius(8)
                      .backgroundColor(COLOR_SURFACE_HIGH)
                    Text(h.vodName)
                      .fontSize(12)
                      .fontColor(COLOR_TEXT)
                      .maxLines(1)
                      .textOverflow({ overflow: TextOverflow.Ellipsis })
                      .width(96)
                      .margin({ top: 6 })
                    Text(`第${h.epIndex + 1}集`)
                      .fontSize(10)
                      .fontColor(COLOR_TEXT_SUB)
                  }
                  .alignItems(HorizontalAlign.Start)
                  .onClick(() => {
                    this.resumeFromHistory(h);
                  })
                }, (h: HistoryEntry) => `${h.vodId}_${h.updatedAt}`)
              }
            }
            .scrollable(ScrollDirection.Horizontal)
            .width('100%')
            .margin({ top: 8 })
          }

          // 订阅导入卡片
          this.buildSubscribeCard()

          // 搜索框
          if (this.siteApis.length > 0) {
            Row() {
              TextInput({ text: this.searchInput, placeholder: `在${this.siteNames[this.currentSiteIndex]}内搜索…` })
                .fontSize(14)
                .fontColor(COLOR_TEXT)
                .placeholderColor(COLOR_TEXT_DIM)
                .placeholderFont({ size: 13 })
                .backgroundColor(COLOR_SURFACE_HIGH)
                .borderRadius(10)
                .height(40)
                .layoutWeight(1)
                .onChange((value: string) => {
                  this.searchInput = value;
                })
                .onSubmit(() => {
                  this.doSearch();
                })
              Button('搜索')
                .fontSize(13)
                .fontColor(COLOR_TEXT)
                .backgroundColor(COLOR_ACCENT)
                .borderRadius(16)
                .height(34)
                .margin({ left: 8 })
                .onClick(() => {
                  this.doSearch();
                })
            }
            .width('100%')
            .alignItems(VerticalAlign.Center)
            .margin({ top: 14 })
          }

          // 站点源条（腾讯视频频道条样式）
          if (this.siteNames.length > 0) {
            Scroll() {
              Row({ space: 10 }) {
                ForEach(this.siteNames, (name: string, idx: number) => {
                  Text(name)
                    .fontSize(13)
                    .fontColor(idx === this.currentSiteIndex ? COLOR_TEXT : COLOR_TEXT_SUB)
                    .fontWeight(idx === this.currentSiteIndex ? FontWeight.Bold : FontWeight.Normal)
                    .backgroundColor(idx === this.currentSiteIndex ? COLOR_ACCENT : COLOR_SURFACE_HIGH)
                    .borderRadius(18)
                    .padding({ left: 16, right: 16, top: 8, bottom: 8 })
                    .onClick(() => {
                      this.openSite(idx);
                    })
                }, (name: string, idx: number) => `${name}_${idx}`)
              }
              .alignItems(VerticalAlign.Center)
            }
            .scrollable(ScrollDirection.Horizontal)
            .width('100%')
            .margin({ top: 14 })
          }

          // 分类条
          if (this.classList.length > 0 && !this.searchActive) {
            Scroll() {
              Row({ space: 8 }) {
                ForEach(this.classList, (c: UIClass, idx: number) => {
                  Text(c.name)
                    .fontSize(13)
                    .fontColor(idx === this.currentClassIndex ? COLOR_TEXT : COLOR_TEXT_SUB)
                    .fontWeight(idx === this.currentClassIndex ? FontWeight.Bold : FontWeight.Normal)
                    .backgroundColor(idx === this.currentClassIndex ? COLOR_ACCENT : COLOR_SURFACE_HIGH)
                    .borderRadius(14)
                    .padding({ left: 12, right: 12, top: 6, bottom: 6 })
                    .onClick(() => {
                      this.switchClass(idx);
                    })
                }, (c: UIClass, idx: number) => `${c.id}_${idx}`)
              }
              .alignItems(VerticalAlign.Center)
            }
            .scrollable(ScrollDirection.Horizontal)
            .width('100%')
            .margin({ top: 10 })
          }

          // 提示
          if (!this.searchActive && this.homeHint !== '' && this.vods.length === 0
            && !this.vodLoading && this.classList.length === 0) {
            Column() {
              Text(this.loading ? '加载中…' : this.homeHint)
                .fontSize(14)
                .fontColor(this.homeHint.startsWith('加载失败') ? COLOR_GOLD : COLOR_TEXT_SUB)
                .textAlign(TextAlign.Center)
            }
            .width('100%')
            .padding({ top: 26, bottom: 26 })
          }

          // 搜索状态条
          if (this.searchActive) {
            Row() {
              Text(`搜索“${this.searchInput}” 结果 ${this.searchResults.length} 条`)
                .fontSize(13)
                .fontColor(COLOR_TEXT_SUB)
                .layoutWeight(1)
              Button('返回浏览')
                .fontSize(12)
                .fontColor(COLOR_TEXT)
                .backgroundColor(COLOR_SURFACE_HIGH)
                .borderRadius(14)
                .height(28)
                .padding({ left: 12, right: 12 })
                .onClick(() => {
                  this.exitSearch();
                })
            }
            .width('100%')
            .alignItems(VerticalAlign.Center)
            .margin({ top: 12 })
          }

          // 视频网格（点播列 / 搜索结果列，内联保证响应式刷新）
          Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.Start }) {
            ForEach(this.searchActive ? this.searchResults : this.vods, (v: UIVod) => {
              Column() {
                Stack() {
                  Image(v.vodPic === '' ? '' : v.vodPic)
                    .width('100%').height(170)
                    .objectFit(ImageFit.Cover)
                    .borderRadius(10)
                    .backgroundColor(COLOR_SURFACE_HIGH)
                  if (v.vodPic === '') {
                    Text(v.vodName)
                      .fontSize(13)
                      .fontColor(COLOR_TEXT_SUB)
                  }
                }
                .width('100%')
                .alignContent(Alignment.Top)

                Row() {
                  Text(v.vodName)
                    .fontSize(13)
                    .fontColor(COLOR_TEXT)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .layoutWeight(1)
                  if (v.remarks !== '') {
                    Text(v.remarks)
                      .fontSize(10)
                      .fontColor(COLOR_GOLD)
                  }
                }
                .width('100%')
                .margin({ top: 6 })
              }
              .alignItems(HorizontalAlign.Start)
              .width('30%')
              .margin({ right: '3.333%', bottom: 14 })
              .onClick(() => {
                this.openDetail(v.vodId);
              })
            }, (v: UIVod) => `${v.vodId}_${v.vodName}`)
          }
          .width('100%')
          .margin({ top: 12 })

          // 加载更多
          if (!this.searchActive && this.page < this.pagecount && this.vods.length > 0
            && this.currentSiteIndex < this.siteApis.length) {
            Text(this.vodLoading ? '加载中…' : `加载更多（第${this.page + 1}/${Math.max(this.pagecount, 1)}页）`)
              .fontSize(13)
              .fontColor(COLOR_ACCENT)
              .textAlign(TextAlign.Center)
              .width('100%')
              .padding(12)
              .onClick(() => {
                this.loadMore();
              })
          }

          // 空态
          if (this.searchActive && !this.searching && this.searchResults.length === 0) {
            Text('没有找到相关内容')
              .fontSize(14)
              .fontColor(COLOR_TEXT_SUB)
              .width('100%')
              .textAlign(TextAlign.Center)
              .padding({ top: 40 })
          }
        }
        .width('100%')
        .padding({ left: 20, right: 20 })
        .alignItems(HorizontalAlign.Start)
      }
      .scrollBar(BarState.Off)
      .width('100%')
      .layoutWeight(1)
      .align(Alignment.Top)
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  buildSubscribeCard() {
    Column() {
      Text('订阅源')
        .fontSize(15)
        .fontWeight(FontWeight.Bold)
        .fontColor(COLOR_TEXT)
      TextInput({ text: this.urlInput, placeholder: 'https://example.com/config.json' })
        .fontSize(14)
        .fontColor(COLOR_TEXT)
        .placeholderColor(COLOR_TEXT_DIM)
        .placeholderFont({ size: 13 })
        .backgroundColor(COLOR_SURFACE_HIGH)
        .borderRadius(10)
        .height(44)
        .margin({ top: 10 })
        .onChange((value: string) => {
          this.urlInput = value;
        })
      Row({ space: 10 }) {
        Button('导入订阅')
          .fontSize(15)
          .fontColor(COLOR_TEXT)
          .fontWeight(FontWeight.Bold)
          .backgroundColor(COLOR_ACCENT)
          .borderRadius(22)
          .height(40)
          .layoutWeight(1)
          .enabled(!this.loading)
          .onClick(() => {
            this.importConfig(this.urlInput);
          })
      }
      .margin({ top: 12 })
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .padding(16)
    .backgroundColor(COLOR_SURFACE)
    .borderRadius(14)
    .margin({ top: 6 })
  }

  // ---- 详情面板（全屏覆盖层） ----

  @Builder
  buildDetailPanel() {
    Column() {
      // 顶栏
      Row() {
        Button('←')
          .fontSize(20)
          .fontColor(COLOR_TEXT)
          .backgroundColor(COLOR_SURFACE_HIGH)
          .borderRadius(20)
          .height(40)
          .width(40)
          .onClick(() => {
            this.showDetail = false;
          })
        Text('详情')
          .fontSize(17)
          .fontWeight(FontWeight.Bold)
          .fontColor(COLOR_TEXT)
          .margin({ left: 12 })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 14, bottom: 10 })

      if (this.detailLoading) {
        Column() {
          LoadingProgress()
            .width(40).height(40)
            .color(COLOR_ACCENT)
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else if (this.detailError !== '') {
        Column() {
          Text(this.detailError)
            .fontSize(14)
            .fontColor(COLOR_GOLD)
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else {
        Scroll() {
          Column() {
            // 海报 + 标题
            Row({ space: 14 }) {
              Image(this.detail.vodPic === '' ? '' : this.detail.vodPic)
                .width(110).height(148)
                .objectFit(ImageFit.Cover)
                .borderRadius(10)
                .backgroundColor(COLOR_SURFACE_HIGH)
              Column() {
                Text(this.detail.vodName)
                  .fontSize(18)
                  .fontWeight(FontWeight.Bold)
                  .fontColor(COLOR_TEXT)
                  .maxLines(2)
                Text([this.detail.remarks, this.detail.year].filter((s: string) => s !== '').join(' · '))
                  .fontSize(12)
                  .fontColor(COLOR_TEXT_SUB)
                  .margin({ top: 6 })
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)
            }
            .width('100%')
            .alignItems(VerticalAlign.Top)

            // 简介
            if (this.detail.content !== '') {
              Text(this.detail.content)
                .fontSize(13)
                .fontColor(COLOR_TEXT_SUB)
                .lineHeight(20)
                .maxLines(6)
                .margin({ top: 12 })
            }

            // 单线路：无选集概念直接播；多线路：显示线路条
            if (this.detail.lines.length >= 1) {
              if (this.detail.lines.length > 1) {
                Text('线路')
                  .fontSize(15)
                  .fontWeight(FontWeight.Bold)
                  .fontColor(COLOR_TEXT)
                  .margin({ top: 16, bottom: 8 })
                Scroll() {
                  Row({ space: 8 }) {
                    ForEach(this.detail.lines, (l: UILine, li: number) => {
                      Text(l.flag === '' ? `线路${li + 1}` : l.flag)
                        .fontSize(13)
                        .fontWeight(this.detailLineIndex === li ? FontWeight.Bold : FontWeight.Normal)
                        .fontColor(this.detailLineIndex === li ? COLOR_TEXT : COLOR_TEXT_SUB)
                        .backgroundColor(this.detailLineIndex === li ? COLOR_ACCENT : COLOR_SURFACE_HIGH)
                        .borderRadius(16)
                        .padding({ left: 14, right: 14, top: 7, bottom: 7 })
                        .onClick(() => {
                          this.detailLineIndex = li;
                        })
                    }, (l: UILine, li: number) => `${l.flag}_${li}`)
                  }
                }
                .scrollable(ScrollDirection.Horizontal)
                .width('100%')
              }
              this.buildEpGrid()
            } else {
              Text('无可用播放线路，请换站点')
                .fontSize(13)
                .fontColor(COLOR_GOLD)
                .margin({ top: 16 })
            }
            Column().height(30).width('100%')
          }
          .width('100%')
          .padding({ left: 20, right: 20 })
          .alignItems(HorizontalAlign.Start)
        }
        .scrollBar(BarState.Off)
        .width('100%')
        .layoutWeight(1)
        .align(Alignment.Top)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(COLOR_BG)
  }

  @Builder
  buildEpGrid() {
    Column() {
      Text('选集')
        .fontSize(15)
        .fontWeight(FontWeight.Bold)
        .fontColor(COLOR_TEXT)
        .margin({ top: 16, bottom: 8 })
      Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.Start }) {
        ForEach(this.detail.lines[this.detailLineIndex].episodes, (ep: UIEpisode, ei: number) => {
          Column() {
            Text(ep.name)
              .fontSize(13)
              .fontColor(COLOR_TEXT)
              .fontWeight(FontWeight.Medium)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
            Text(this.historyEpLabel(this.detailLineIndex, ei) === '' ? '点击播放' : this.historyEpLabel(this.detailLineIndex, ei))
              .fontSize(10)
              .fontColor(this.historyEpLabel(this.detailLineIndex, ei) === '' ? COLOR_TEXT_DIM : COLOR_GOLD)
              .margin({ top: 3 })
          }
          .alignItems(HorizontalAlign.Center)
          .justifyContent(FlexAlign.Center)
          .width('31%')
          .height(52)
          .backgroundColor(COLOR_SURFACE_HIGH)
          .borderRadius(8)
          .margin({ right: '3.5%', bottom: 10 })
          .onClick(() => {
            this.playEpisode(this.detailLineIndex, ei);
          })
        }, (ep: UIEpisode, ei: number) => `${ep.url}_${ei}`)
      }
      .width('100%')
    }
    .width('100%')
  }

  // ---- 直播 ----

  @Builder
  buildLive() {
    Column() {
      this.topBar()

      // 播放器区域（16:9，黑色底）
      Stack() {
        XComponent({ id: 'live-surface', type: 'surface', controller: this.xcController })
          .width('100%')
          .height('100%')
          .onLoad(() => {
            this.onSurfaceReadyLive();
          })
          .onDestroy(() => {
            this.releasePlayer();
          })

        if (this.playingUrl === '') {
          Column() {
            Text(this.playingName === '' ? '选择下方频道开始观看' : '')
              .fontSize(14)
              .fontColor(COLOR_TEXT_SUB)
          }
          .width('100%')
          .height('100%')
          .justifyContent(FlexAlign.Center)
        }
      }
      .width('100%')
      .aspectRatio(1.777)
      .backgroundColor('#000000')

      // 正在播放信息条
      Row() {
        Text(this.playingName === '' ? '未在播放' : `${this.playingName} · ${this.playerStatus}`)
          .fontSize(13)
          .fontColor(this.playerStatus.startsWith('播放失败') || this.playerStatus === '播放出错，请换频道' ? COLOR_GOLD : COLOR_TEXT_SUB)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Blank()
        if (this.playingUrl !== '') {
          Button('停止')
            .fontSize(12)
            .fontColor(COLOR_TEXT)
            .backgroundColor(COLOR_SURFACE_HIGH)
            .borderRadius(14)
            .height(28)
            .padding({ left: 14, right: 14 })
            .onClick(() => {
              this.stopPlay();
            })
        }
      }
      .width('100%')
      .padding({ left: 20, right: 20, top: 10, bottom: 6 })

      Scroll() {
        Column() {
          ForEach(this.liveGroups, (g: UILiveGroup, gi: number) => {
            Text(g.group)
              .fontSize(16)
              .fontWeight(FontWeight.Bold)
              .fontColor(COLOR_TEXT)
              .margin({ top: 14, bottom: 8 })
            Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.Start }) {
              ForEach(g.channels, (c: UILiveChannel, ci: number) => {
                Text(c.name)
                  .fontSize(13)
                  .fontColor(this.playingUrl === c.url ? COLOR_TEXT : COLOR_TEXT_SUB)
                  .backgroundColor(this.playingUrl === c.url ? COLOR_ACCENT : COLOR_SURFACE_HIGH)
                  .borderRadius(8)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .constraintSize({ maxWidth: '46%' })
                  .padding({ left: 12, right: 12, top: 9, bottom: 9 })
                  .margin({ right: 10, bottom: 10 })
                  .onClick(() => {
                    this.onChannelTap(c);
                  })
              }, (c: UILiveChannel, ci: number) => `${c.name}_${gi}_${ci}`)
            }
            .width('100%')
          }, (g: UILiveGroup, gi: number) => `${g.group}_${gi}`)

          if (this.liveGroups.length === 0) {
            Column() {
              Text('暂无直播频道\n请先在「首页」导入订阅')
                .fontSize(14)
                .fontColor(COLOR_TEXT_SUB)
                .textAlign(TextAlign.Center)
            }
            .width('100%')
            .padding({ top: 60 })
          }
        }
        .width('100%')
        .padding({ left: 20, right: 20, bottom: 24 })
        .alignItems(HorizontalAlign.Start)
      }
      .scrollBar(BarState.Off)
      .width('100%')
      .layoutWeight(1)
      .align(Alignment.Top)
    }
    .width('100%')
    .height('100%')
  }

  // ---- 设置 ----

  @Builder
  buildSettings() {
    Column() {
      this.topBar()

      Scroll() {
        Column() {
          // 订阅管理
          Column() {
            Text('订阅源')
              .fontSize(15)
              .fontWeight(FontWeight.Bold)
              .fontColor(COLOR_TEXT)
            Text(this.configUrl === '' ? '未导入' : this.configUrl)
              .fontSize(13)
              .fontColor(COLOR_TEXT_SUB)
              .maxLines(2)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .margin({ top: 6 })
            Row({ space: 10 }) {
              Button('重新加载')
                .fontSize(13)
                .fontColor(COLOR_TEXT)
                .backgroundColor(COLOR_ACCENT)
                .borderRadius(18)
                .height(34)
                .padding({ left: 16, right: 16 })
                .enabled(this.configUrl !== '' && !this.loading)
                .onClick(() => {
                  this.importConfig(this.configUrl);
                })
              Button('清除')
                .fontSize(13)
                .fontColor(COLOR_TEXT_SUB)
                .backgroundColor(COLOR_SURFACE_HIGH)
                .borderRadius(18)
                .height(34)
                .padding({ left: 16, right: 16 })
                .onClick(() => {
                  this.clearConfig();
                })
            }
            .margin({ top: 12 })
          }
          .alignItems(HorizontalAlign.Start)
          .width('100%')
          .padding(16)
          .backgroundColor(COLOR_SURFACE)
          .borderRadius(14)

          // 播放
          Column() {
            Text('播放')
              .fontSize(15)
              .fontWeight(FontWeight.Bold)
              .fontColor(COLOR_TEXT)
            Text('内核：AVPlayer（系统）')
              .fontSize(13)
              .fontColor(COLOR_TEXT_SUB)
              .margin({ top: 6 })
          }
          .alignItems(HorizontalAlign.Start)
          .width('100%')
          .padding(16)
          .backgroundColor(COLOR_SURFACE)
          .borderRadius(14)
          .margin({ top: 14 })

          // 观看历史
          Column() {
            Row() {
              Text('观看历史')
                .fontSize(15)
                .fontWeight(FontWeight.Bold)
                .fontColor(COLOR_TEXT)
                .layoutWeight(1)
              Button('清空')
                .fontSize(12)
                .fontColor(COLOR_TEXT_SUB)
                .backgroundColor(COLOR_SURFACE_HIGH)
                .borderRadius(14)
                .height(28)
                .padding({ left: 12, right: 12 })
                .enabled(this.history.length > 0)
                .onClick(() => {
                  this.clearHistory();
                })
            }
            .width('100%')
            .alignItems(VerticalAlign.Center)
            Text(`${this.history.length} 条记录`)
              .fontSize(12)
              .fontColor(COLOR_TEXT_DIM)
              .margin({ top: 6 })
          }
          .alignItems(HorizontalAlign.Start)
          .width('100%')
          .padding(16)
          .backgroundColor(COLOR_SURFACE)
          .borderRadius(14)
          .margin({ top: 14 })

          // 关于
          Column() {
            Text('关于')
              .fontSize(15)
              .fontWeight(FontWeight.Bold)
              .fontColor(COLOR_TEXT)
            Text('云映 1.0.0 (HarmonyOS)')
              .fontSize(13)
              .fontColor(COLOR_TEXT_SUB)
              .margin({ top: 6 })
            Text('© 2026 云映')
              .fontSize(12)
              .fontColor(COLOR_TEXT_DIM)
              .margin({ top: 4 })
          }
          .alignItems(HorizontalAlign.Start)
          .width('100%')
          .padding(16)
          .backgroundColor(COLOR_SURFACE)
          .borderRadius(14)
          .margin({ top: 14, bottom: 24 })
        }
        .width('100%')
        .padding({ left: 20, right: 20 })
        .alignItems(HorizontalAlign.Start)
      }
      .scrollBar(BarState.Off)
      .width('100%')
      .layoutWeight(1)
      .align(Alignment.Top)
    }
    .width('100%')
    .height('100%')
  }

  // ================= 辅助 =================

  private async onSurfaceReadyLive(): Promise<void> {
    try {
      const id = await this.xcController.getXComponentSurfaceId();
      this.surfaceId = id;
      if (this.pendingPlay !== '') {
        const url = this.pendingPlay;
        this.pendingPlay = '';
        await this.startPlay(url);
      }
    } catch (e) {
      const err = e as BusinessError;
      this.playerStatus = `surface 初始化失败：${err.message}`;
    }
  }

  private async stopPlay(): Promise<void> {
    await this.releasePlayerAsync();
    this.playingName = '';
    this.playingUrl = '';
    this.playerStatus = '';
    this.pendingPlay = '';
  }

  private async clearConfig(): Promise<void> {
    this.configUrl = '';
    this.urlInput = '';
    this.siteNames = [];
    this.siteApis = [];
    this.liveGroups = [];
    this.classList = [];
    this.vods = [];
    this.history = [];
    this.homeHint = '导入 TVBox 订阅，开启追剧之旅';
    await this.stopPlay();
    const ctx = Global.context;
    if (ctx !== null) {
      await Prefs.putString(ctx, 'config_url', '');
      await HistoryStore.clear(ctx);
    }
  }

  private async clearHistory(): Promise<void> {
    const ctx = Global.context;
    if (ctx !== null) {
      await HistoryStore.clear(ctx);
      this.history = [];
    }
  }
}
