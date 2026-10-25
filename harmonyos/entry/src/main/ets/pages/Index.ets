import media from '@ohos.multimedia.media';
import { BusinessError } from '@ohos.base';
import {
  ConfigStore,
  Global,
  Prefs,
  UILiveChannel,
  UILiveGroup
} from '../model/Config';

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
 *   底部导航：首页 / 直播 / 设置（腾讯视频式）
 *   首页：云映 logo + 订阅导入 + 站点源条 + 说明
 *   直播：频道组列表 + AVPlayer 播放（XComponent surface）
 *   设置：订阅管理 + 关于（云映 1.0.0）
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
  @State currentSiteIndex: number = 0;
  @State loading: boolean = false;
  @State homeHint: string = '导入 TVBox 订阅，开启追剧之旅';

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
      // 站点条
      const names: string[] = [];
      const sites = cfg.sites ?? [];
      for (const s of sites) {
        const n = s.name ?? s.key ?? '';
        if (n !== '') {
          names.push(n);
        }
      }
      this.siteNames = names;
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
      this.homeHint = `已加载：${names.length} 个站点 / ${groups.length} 个频道组`;
      const ctx = Global.context;
      if (ctx !== null) {
        await Prefs.putString(ctx, 'config_url', target);
      }
    } catch (e) {
      const err = e as BusinessError;
      this.loading = false;
      this.homeHint = `加载失败：${err.message}`;
    }
  }

  // ================= 播放 =================

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
    Column() {
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
      })
      .width('100%')
      .layoutWeight(1)
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

  // ---- 首页 ----

  @Builder
  buildHome() {
    Column() {
      this.topBar()

      Scroll() {
        Column() {
          // 订阅导入卡片
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
            Button('导入订阅')
              .fontSize(15)
              .fontColor(COLOR_TEXT)
              .fontWeight(FontWeight.Bold)
              .backgroundColor(COLOR_ACCENT)
              .borderRadius(22)
              .height(40)
              .width('100%')
              .margin({ top: 12 })
              .enabled(!this.loading)
              .onClick(() => {
                this.importConfig(this.urlInput);
              })
          }
          .alignItems(HorizontalAlign.Start)
          .width('100%')
          .padding(16)
          .backgroundColor(COLOR_SURFACE)
          .borderRadius(14)
          .margin({ top: 6 })

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
                      this.currentSiteIndex = idx;
                    })
                }, (name: string, idx: number) => `${name}_${idx}`)
              }
              .alignItems(VerticalAlign.Center)
            }
            .scrollable(ScrollDirection.Horizontal)
            .width('100%')
            .margin({ top: 16 })
          }

          // 提示
          Column() {
            Text(this.loading ? '加载中…' : this.homeHint)
              .fontSize(14)
              .fontColor(this.homeHint.startsWith('加载失败') ? COLOR_GOLD : COLOR_TEXT_SUB)
              .textAlign(TextAlign.Center)
          }
          .width('100%')
          .padding({ top: 26, bottom: 26 })

          // 功能说明卡片
          Column() {
            Text('功能说明')
              .fontSize(15)
              .fontWeight(FontWeight.Bold)
              .fontColor(COLOR_TEXT)
            Text('· 直播：导入订阅后，在「直播」页选择频道观看\n· 点播：站点浏览与播放将在后续版本提供\n· 配置与安卓 / 苹果端通用（TVBox 订阅格式）')
              .fontSize(13)
              .fontColor(COLOR_TEXT_SUB)
              .lineHeight(22)
              .margin({ top: 8 })
          }
          .alignItems(HorizontalAlign.Start)
          .width('100%')
          .padding(16)
          .backgroundColor(COLOR_SURFACE)
          .borderRadius(14)
          .margin({ top: 6, bottom: 24 })
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
            this.onSurfaceReady();
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

  private async onSurfaceReady(): Promise<void> {
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
    this.liveGroups = [];
    this.homeHint = '导入 TVBox 订阅，开启追剧之旅';
    await this.stopPlay();
    const ctx = Global.context;
    if (ctx !== null) {
      await Prefs.putString(ctx, 'config_url', '');
    }
  }
}
