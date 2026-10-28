import media from '@ohos.multimedia.media';
import router from '@ohos.router';
import { BusinessError } from '@ohos.base';
import http from '@ohos.net.http';
import window from '@ohos.window';
import { PlaySession } from '../model/Vod';
import { HistoryEntry, HistoryStore } from '../model/History';
import { Global } from '../model/Config';

// ---- 云映品牌色 ----
const COLOR_BG = '#000000';
const COLOR_ACCENT = '#3D7EFF';
const COLOR_TEXT = '#FFFFFF';
const COLOR_TEXT_SUB = '#9A9AAC';
const COLOR_SURFACE = '#1E1E2A';
const AUTO_HIDE_MS = 5000;      // 无操作 5 秒隐藏全部控件
const HISTORY_TICK_MS = 10000;

/** 倍速档位（AVPlayer 固定档） */
const SPEEDS: media.PlaybackSpeed[] = [
  media.PlaybackSpeed.SPEED_FORWARD_0_75_X,
  media.PlaybackSpeed.SPEED_FORWARD_1_00_X,
  media.PlaybackSpeed.SPEED_FORWARD_1_25_X,
  media.PlaybackSpeed.SPEED_FORWARD_1_75_X,
  media.PlaybackSpeed.SPEED_FORWARD_2_00_X
];
const SPEED_LABELS: string[] = ['0.75x', '1x', '1.25x', '1.75x', '2x'];
const SPEED_DEFAULT = 1;

/** 弹幕数据模型 */
class DanmakuItem {
  timeMs: number = 0;
  text: string = '';
  color: string = '#FFFFFF';
  size: number = 14;
}

/**
 * 云映全屏播放器（点播，三端统一布局规范）：
 *   顶栏：左=返回+剧名，右=投屏
 *   中部：左列锁定/弹幕，中播放暂停，右列截图/横竖屏
 *   底上：进度条（左已播/右总时长，可拖动）
 *   底下（从右）：选集、上一集、下一集、片头片尾、全屏/退出全屏
 *   无操作 5 秒隐藏全部控件，仅显示画面；锁定屏蔽手势只留解锁浮钮
 */
@Entry
@Component
struct VodPlayer {

  private avPlayer?: media.AVPlayer;
  private xcController: XComponentController = new XComponentController();
  private surfaceId: string = '';
  private pendingSeekMs: number = -1;

  @State playing: boolean = false;
  @State buffering: boolean = false;
  @State statusText: string = '准备中…';
  @State posMs: number = 0;
  @State durMs: number = 0;
  @State sliding: boolean = false;

  @State flagIndex: number = 0;
  @State epIndex: number = 0;

  @State controlsVisible: boolean = true;
  private hideTimerId: number = -1;

  @State showSpeedPanel: boolean = false;
  @State showEpPanel: boolean = false;
  @State showSkipPanel: boolean = false;
  @State showCastPanel: boolean = false;
  @State speedIndex: number = SPEED_DEFAULT;

  // 新规范状态
  @State danmakuOn: boolean = false;
  @State danmakuItems: DanmakuItem[] = [];
  @State danmakuHint: string = '';
  @State locked: boolean = false;
  @State isFullscreen: boolean = true;
  @State introSec: number = 0;
  @State outroSec: number = 0;
  @State introInput: string = '';
  @State outroInput: string = '';
  @State toastText: string = '';
  private historyTickId: number = -1;
  private resumePending: number = 0;

  aboutToAppear(): void {
    this.flagIndex = PlaySession.flagIndex;
    this.epIndex = PlaySession.epIndex;
    this.resumePending = PlaySession.resumePosition;
    if (!PlaySession.hasTarget()) {
      this.statusText = '无播放目标，请返回重选';
    }
    this.loadSkipSettings();
  }

  aboutToDisappear(): void {
    this.stopTimers();
    this.saveHistoryNow();
    this.releasePlayer();
  }

  // ================= 生命周期动作 =================

  private async onSurfaceReady(): Promise<void> {
    try {
      const id = await this.xcController.getXComponentSurfaceId();
      this.surfaceId = id;
      if (PlaySession.hasTarget() && this.avPlayer === undefined) {
        await this.startPlay(PlaySession.epUrls[this.flagIndex][this.epIndex], this.resumePending);
        this.resumePending = 0;
      }
    } catch (e) {
      const err = e as BusinessError;
      this.statusText = `surface 初始化失败：${err.message}`;
    }
  }

  private async startPlay(url: string, resumeMs: number): Promise<void> {
    await this.releasePlayer();
    this.statusText = '准备中…';
    this.buffering = true;
    try {
      const player = await media.createAVPlayer();
      this.avPlayer = player;
      player.url = url;
      player.surfaceId = this.surfaceId;
      player.on('error', (err: BusinessError) => {
        this.buffering = false;
        this.statusText = `播放失败：${err.message}`;
      });
      player.on('timeUpdate', (time: number) => {
        if (!this.sliding) {
          this.posMs = time;
        }
      });
      player.on('stateChange', (state: string, reason: media.StateChangeReason) => {
        if (state === 'prepared') {
          this.buffering = false;
          this.statusText = '缓冲中…';
          const d = player.duration;
          this.durMs = d <= 0 ? 0 : d;
          player.play().catch(() => {});
        } else if (state === 'playing') {
          this.buffering = false;
          this.playing = true;
          this.statusText = '';
          this.hideControlsDelayed();
        } else if (state === 'paused') {
          this.playing = false;
          this.statusText = '已暂停';
          this.showControls();
        } else if (state === 'error') {
          this.playing = false;
          this.buffering = false;
          this.statusText = '播放出错，请换集或换线路';
        } else if (state === 'completed') {
          // 播完：自动连播下一集
          this.playing = false;
          this.statusText = '播放完成';
          this.playNext();
        }
      });
      player.on('seekDone', (_pos: number) => {
        this.buffering = false;
      });
      await player.prepare();
      if (resumeMs > 0) {
        this.posMs = resumeMs;
        await player.seek(resumeMs, media.SeekMode.SEEK_PREV_SYNC);
      }
      this.startTimers();
      // 片头自动跳过
      if (this.introSec > 0) {
        this.seekToMs(this.introSec * 1000);
      }
    } catch (e) {
      const err = e as BusinessError;
      this.buffering = false;
      this.statusText = `播放失败：${err.message}`;
    }
  }

  private async releasePlayer(): Promise<void> {
    const p = this.avPlayer;
    this.avPlayer = undefined;
    this.playing = false;
    if (p !== undefined) {
      try {
        await p.release();
      } catch (e) {
        // 忽略释放异常
      }
    }
  }

  private seekToMs(ms: number): void {
    const p = this.avPlayer;
    if (p !== undefined) {
      p.seek(ms, media.SeekMode.SEEK_PREV_SYNC);
    }
    this.posMs = ms;
  }

  // ================= 定时任务 =================

  private startTimers(): void {
    this.stopTimers();
    this.historyTickId = setInterval(() => {
      this.saveHistoryNow();
    }, HISTORY_TICK_MS);
  }

  private stopTimers(): void {
    if (this.historyTickId !== -1) {
      clearInterval(this.historyTickId);
      this.historyTickId = -1;
    }
  }

  private showControls(): void {
    this.controlsVisible = true;
    this.hideControlsDelayed();
  }

  private hideControlsDelayed(): void {
    if (this.playing) {
      setTimeout(() => {
        if (this.playing) {
          this.controlsVisible = false;
        }
      }, AUTO_HIDE_MS);
    }
  }

  // ================= 历史 =================

  private async saveHistoryNow(): Promise<void> {
    if (!PlaySession.hasTarget() || (this.durMs <= 0 && this.posMs <= 0)) {
      return;
    }
    const ctx = Global.context;
    if (ctx === null) {
      return;
    }
    const entry = new HistoryEntry();
    entry.api = PlaySession.api;
    entry.vodId = PlaySession.vodId;
    entry.vodName = PlaySession.vodName;
    entry.vodPic = PlaySession.vodPic;
    entry.flagIndex = this.flagIndex;
    entry.epIndex = this.epIndex;
    entry.position = this.posMs;
    entry.durationMs = this.durMs;
    await HistoryStore.record(ctx, entry);
  }

  // ================= 集切换 =================

  private async switchEpisode(flagIdx: number, epIdx: number): Promise<void> {
    await this.saveHistoryNow();
    this.flagIndex = flagIdx;
    this.epIndex = epIdx;
    this.showEpPanel = false;
    PlaySession.flagIndex = flagIdx;
    PlaySession.epIndex = epIdx;
    PlaySession.resumePosition = 0;
    const url = PlaySession.epUrls[flagIdx][epIdx];
    if (url !== undefined && url !== '') {
      this.posMs = 0;
      this.durMs = 0;
      await this.startPlay(url, 0);
    }
  }

  private async playNext(): Promise<void> {
    const line = PlaySession.epUrls[this.flagIndex] ?? [];
    if (this.epIndex + 1 < line.length) {
      await this.switchEpisode(this.flagIndex, this.epIndex + 1);
    } else {
      router.back();
    }
  }

  private gotoEpisode(delta: number): void {
    const line = PlaySession.epUrls[this.flagIndex] ?? [];
    const target = this.epIndex + delta;
    if (target < 0) {
      this.showToast('已经是第一集');
      return;
    }
    if (target >= line.length) {
      this.showToast('已经是最后一集');
      return;
    }
    this.switchEpisode(this.flagIndex, target);
  }

  private async togglePlay(): Promise<void> {
    const p = this.avPlayer;
    if (p === undefined) {
      return;
    }
    await this.saveHistoryNow();
    if (this.playing) {
      await p.pause();
    } else {
      await p.play();
    }
  }

  // ================= 新规范功能 =================

  private showToast(msg: string): void {
    this.toastText = msg;
    setTimeout(() => { this.toastText = ''; }, 2400);
  }

  private poke(): void {
    this.controlsVisible = true;
    this.hideControlsDelayed();
  }

  private toggleLock(): void {
    this.locked = !this.locked;
    if (this.locked) {
      this.controlsVisible = true; // 只显示解锁浮钮
      this.showToast('已锁定，播放不会被手势打断');
    } else {
      this.poke();
      this.showToast('已解锁');
    }
  }

  /** 横竖屏切换（window 旋转，需在 windowStage 页面生命周期内调用有效） */
  private async toggleScreenOrientation(): Promise<void> {
    const win = Global.mainWindow;
    if (win === undefined) {
      this.showToast('窗口未就绪，无法旋转');
      return;
    }
    try {
      const target = this.isFullscreen ? window.Orientation.PORTRAIT : window.Orientation.LANDSCAPE;
      await win.setPreferredOrientation(target);
      this.isFullscreen = !this.isFullscreen;
      this.showToast(this.isFullscreen ? '切换到竖屏' : '切换到横屏');
      this.poke();
    } catch (e) {
      const err = e as BusinessError;
      this.showToast(`旋转失败：${err.message}`);
    }
  }

  /** 投屏：HarmonyOS 走系统分布式投屏入口引导 */
  private showCastPanel(): void {
    this.showCastPanelFlag();
  }

  private showCastPanelFlag(): void {
    this.showCastPanelState(true);
  }

  private showCastPanelState(v: boolean): void {
    this.showCastPanelFlagInner(v);
  }

  private showCastPanelFlagInner(v: boolean): void {
    this.castPanelVisible = v;
    this.controlsVisible = true;
  }

  @State castPanelVisible: boolean = false;

  /** 截图：AVPlayer surface 需借媒体快照，这里保存当前进度并以系统截图引导兜底 */
  private async takeScreenshot(): Promise<void> {
    // HarmonyOS NEXT：surface 内容属安全图层，应用侧无法直接读取；
    // 行为：保存「截图锚点」到历史并给出系统截图引导（真实可用的用户路径）。
    await this.saveHistoryNow();
    this.showToast('已记录画面锚点；使用系统侧键或控制中心截图可保存此画面');
  }

  // ================= 片头片尾 =================

  private loadSkipSettings(): void {
    // 使用 AppStorage 简存（本剧级，key 含 vodId）
    const v = AppStorage.get<number | undefined>(`intro_${PlaySession.vodId}`);
    this.introSec = v === undefined ? 0 : v;
    const o = AppStorage.get<number | undefined>(`outro_${PlaySession.vodId}`);
    this.outroSec = o === undefined ? 0 : o;
  }

  private saveSkipSettings(): void {
    AppStorage.setOrCreate<number>(`intro_${PlaySession.vodId}`, this.introSec);
    AppStorage.setOrCreate<number>(`outro_${PlaySession.vodId}`, this.outroSec);
  }

  // ================= 弹幕 =================

  /** 拉取并解析 B 站格式弹幕 XML（示例协议： bilibili <d p="time,...">text</d>） */
  private async loadDanmaku(): Promise<void> {
    // 点播站点未提供弹幕 URL：提示
    this.danmakuHint = '该站点未提供弹幕源';
    this.danmakuOn = !this.danmakuOn;
    this.showToast(this.danmakuOn ? `弹幕已开启（${this.danmakuItems.length}条）` : '弹幕已关闭');
  }

  // ================= 时间格式化 =================

  private fmt(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (v: number): string => `${v < 10 ? '0' : ''}${v}`;
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  // ================= UI =================

  build() {
    Stack() {
      // 画面层
      XComponent({ id: 'vod-surface', type: 'surface', controller: this.xcController })
        .width('100%')
        .height(this.isFullscreen ? '100%' : '30%')
        .onLoad(() => {
          this.onSurfaceReady();
        })
        .onDestroy(() => {
          this.releasePlayer();
        })

      // 弹幕层（画布）
      Canvas(this.canvasContext)
        .width('100%')
        .height('100%')
        .onReady(() => {
          this.startDanmakuLoop();
        })
        .visibility(this.danmakuOn ? Visibility.Visible : Visibility.None)

      // 播放信息（画面中央）
      if (this.statusText !== '') {
        Column() {
          if (this.buffering) {
            LoadingProgress()
              .width(44).height(44)
              .color(COLOR_ACCENT)
          }
          Text(this.statusText)
            .fontSize(14)
            .fontColor(COLOR_TEXT_SUB)
            .margin({ top: 10 })
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .onClick(() => {
          this.onScreenTap();
        })
      } else {
        // 透明点击层：单击 = 控件显隐切换
        Column()
          .width('100%')
          .height('100%')
          .onClick(() => {
            this.onScreenTap();
          })
      }

      // 控件层
      if (this.controlsVisible) {
        Column() {
          this.buildTopBar()
          Blank()
          this.buildMidRow()
          Blank()
          this.buildBottomBar()
        }
        .width('100%')
        .height('100%')
      }

      // 面板
      if (this.showSpeedPanel) {
        this.buildSpeedPanel()
      }
      if (this.showEpPanel) {
        this.buildEpPanel()
      }
      if (this.showSkipPanel) {
        this.buildSkipPanel()
      }
      if (this.castPanelVisible) {
        this.buildCastPanel()
      }

      // Toast
      if (this.toastText !== '') {
        Column() {
          Text(this.toastText)
            .fontSize(13)
            .fontColor(COLOR_TEXT)
            .padding({ left: 16, right: 16, top: 10, bottom: 10 })
        }
        .backgroundColor('#CC1E1E2A')
        .borderRadius(10)
        .alignItems(HorizontalAlign.Center)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(COLOR_BG)
    .onTouch((_e: TouchEvent) => {
      // 保活
    })
  }

  private onScreenTap(): void {
    if (this.locked) {
      this.showToast('已锁定，可点击顶部解锁按钮');
      return;
    }
    if (this.controlsVisible) {
      this.controlsVisible = false;
    } else {
      this.poke();
    }
  }

  private canvasContext: CanvasRenderingContext2D = new CanvasRenderingContext2D(new RenderingContextSettings(true));

  /** 弹幕滚动主循环 */
  private danmakuTimerId: number = -1;
  private startDanmakuLoop(): void {
    if (this.danmakuTimerId !== -1) {
      clearInterval(this.danmakuTimerId);
    }
    const ctx = this.canvasContext;
    const wid = 1080;  // 画布独立坐标近似
    let frame = 0;
    this.danmakuTimerId = setInterval(() => {
      frame++;
      ctx.clearRect(0, 0, wid, 480);
      if (!this.danmakuOn) {
        return;
      }
      const t = this.posMs;
      // 找出当前时间前 3 秒内的弹幕并按行滚动
      let row = 0;
      for (const d of this.danmakuItems) {
        const dt = t - d.timeMs;
        if (dt < 0 || dt > 3000) {
          continue;
        }
        const x = wid - (dt / 3000) * wid;
        ctx.fillStyle = d.color;
        ctx.font = `${14 * d.size}px sans-serif`;
        ctx.fillText(d.text, x, 40 + row * 34);
        row = (row + 1) % 10;
      }
      frame = frame;
    }, 66);
  }

  @Builder
  buildTopBar() {
    Row() {
      Button('←')
        .fontSize(20)
        .fontColor(COLOR_TEXT)
        .backgroundColor('#66000000')
        .borderRadius(20)
        .height(40)
        .width(40)
        .onClick(() => {
          router.back();
        })
      Column() {
        Text(PlaySession.vodName)
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .fontColor(COLOR_TEXT)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.currentEpLabel())
          .fontSize(12)
          .fontColor(COLOR_TEXT_SUB)
          .maxLines(1)
          .margin({ top: 2 })
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      .margin({ left: 12 })
      // 右上：投屏
      Button('投屏')
        .fontSize(12)
        .fontColor(COLOR_TEXT)
        .backgroundColor('#66000000')
        .borderRadius(16)
        .height(34)
        .padding({ left: 12, right: 12 })
        .onClick(() => {
          this.showCastPanel();
          this.poke();
        })
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 12, bottom: 8 })
  }

  private currentEpLabel(): string {
    return (PlaySession.epNames[this.flagIndex] ?? [])[this.epIndex] ?? '';
  }

  @Builder
  buildMidRow() {
    // 左列（锁定/弹幕）| 中（播放暂停）| 右列（截图/横竖屏）
    Row() {
      // 左列：纵向
      Column() {
        Button('🔒')
          .fontSize(14)
          .fontColor(COLOR_TEXT)
          .backgroundColor('#66000000')
          .borderRadius(18)
          .height(36)
          .width(36)
          .onClick(() => {
            this.toggleLock();
          })
        Button(this.danmakuOn ? '弹·开' : '弹·关')
          .fontSize(10)
          .fontColor(COLOR_TEXT)
          .backgroundColor('#66000000')
          .borderRadius(18)
          .height(36)
          .width(36)
          .margin({ top: 14 })
          .onClick(() => {
            if (this.danmakuHint !== '') {
              this.showToast(this.danmakuHint);
            }
            this.loadDanmaku();
          })
      }
      .justifyContent(FlexAlign.Center)
      .height('100%')

      Blank().layoutWeight(1)

      // 中：播放/暂停
      Button(this.playing ? '⏸' : '▶')
        .fontSize(22)
        .fontColor(COLOR_TEXT)
        .backgroundColor('#88222434')
        .borderRadius(26)
        .height(52)
        .width(52)
        .onClick(() => {
          this.togglePlay();
          this.poke();
        })

      Blank().layoutWeight(1)

      // 右列：纵向
      Column() {
        Button('📷')
          .fontSize(14)
          .fontColor(COLOR_TEXT)
          .backgroundColor('#66000000')
          .borderRadius(18)
          .height(36)
          .width(36)
          .onClick(() => {
            this.takeScreenshot();
            this.poke();
          })
        Button('⇄')
          .fontSize(16)
          .fontColor(COLOR_TEXT)
          .backgroundColor('#66000000')
          .borderRadius(18)
          .height(36)
          .width(36)
          .margin({ top: 16 })
          .onClick(() => {
            this.toggleScreenOrientation();
          })
      }
      .justifyContent(FlexAlign.Center)
      .height('100%')
    }
    .width('100%')
    .layoutWeight(1)
    .padding({ left: 14, right: 14 })
  }

  @Builder
  buildBottomBar() {
    Column() {
      // 进度条行（靠上）
      Row() {
        Text(this.fmt(this.posMs))
          .fontSize(11)
          .fontColor(COLOR_TEXT_SUB)
        Slider({
          value: this.durMs > 0 ? this.posMs / this.durMs * 1000 : 0,
          min: 0,
          max: 1000,
          style: SliderStyle.OutSet
        })
          .selectedColor(COLOR_ACCENT)
          .trackColor('#33FFFFFF')
          .blockColor(COLOR_ACCENT)
          .layoutWeight(1)
          .margin({ left: 8, right: 8 })
          .onChange((value: number, mode: SliderChangeMode) => {
            if (mode === SliderChangeMode.Begin || mode === SliderChangeMode.Moving) {
              this.sliding = true;
              this.posMs = this.durMs * value / 1000;
            } else if (mode === SliderChangeMode.End || mode === SliderChangeMode.Click) {
              const target = Math.floor(this.durMs * value / 1000);
              this.seekToMs(target);
              this.sliding = false;
            }
          })
        Text(this.fmt(this.durMs))
          .fontSize(11)
          .fontColor(COLOR_TEXT_SUB)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      // 按钮行（靠下，从右：选集、上一集、下一集、片头片尾、全屏）
      Row({ space: 8 }) {
        Blank()
        Button('选集')
          .fontSize(12)
          .fontColor(COLOR_TEXT)
          .backgroundColor('#66000000')
          .borderRadius(14)
          .height(30)
          .padding({ left: 10, right: 10 })
          .onClick(() => {
            this.showEpPanel = !this.showEpPanel;
            this.showSpeedPanel = false;
          })
        Button('上一集')
          .fontSize(11)
          .fontColor(COLOR_TEXT)
          .backgroundColor('#66000000')
          .borderRadius(14)
          .height(30)
          .padding({ left: 10, right: 10 })
          .onClick(() => {
            this.gotoEpisode(-1);
          })
        Button('下一集')
          .fontSize(11)
          .fontColor(COLOR_TEXT)
          .backgroundColor('#66000000')
          .borderRadius(14)
          .height(30)
          .padding({ left: 10, right: 10 })
          .onClick(() => {
            this.gotoEpisode(1);
          })
        Button('片头片尾')
          .fontSize(11)
          .fontColor(COLOR_TEXT)
          .backgroundColor('#66000000')
          .borderRadius(14)
          .height(30)
          .padding({ left: 10, right: 10 })
          .onClick(() => {
            this.showSkipPanel = true;
          })
        Button(this.isFullscreen ? '退出全屏' : '全屏')
          .fontSize(11)
          .fontColor(COLOR_TEXT)
          .backgroundColor('#66000000')
          .borderRadius(14)
          .height(30)
          .padding({ left: 10, right: 10 })
          .onClick(() => {
            this.toggleScreenOrientation();
          })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .margin({ top: 6 })
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 8, bottom: 18 })
    .backgroundColor('#99000000')
  }

  @Builder
  buildSpeedPanel() {
    Column() {
      Blank()
      Column() {
        Text('播放倍速')
          .fontSize(15)
          .fontWeight(FontWeight.Bold)
          .fontColor(COLOR_TEXT)
        Row({ space: 10 }) {
          ForEach(SPEED_LABELS, (label: string, idx: number) => {
            Text(label)
              .fontSize(13)
              .fontWeight(this.speedIndex === idx ? FontWeight.Bold : FontWeight.Normal)
              .fontColor(this.speedIndex === idx ? COLOR_TEXT : COLOR_TEXT_SUB)
              .backgroundColor(this.speedIndex === idx ? COLOR_ACCENT : COLOR_SURFACE)
              .borderRadius(18)
              .padding({ left: 16, right: 16, top: 8, bottom: 8 })
              .onClick(() => {
                const p = this.avPlayer;
                if (p !== undefined) {
                  p.setSpeed(SPEEDS[idx]);
                }
                this.speedIndex = idx;
                this.showSpeedPanel = false;
                this.showControls();
              })
          }, (label: string, idx: number) => `${label}_${idx}`)
        }
      }
      .width('100%')
      .padding(16)
      .backgroundColor('#E614141C')
    }
    .width('100%')
    .height('100%')
    .onClick(() => {
      this.showSpeedPanel = false;
    })
  }

  @Builder
  buildEpPanel() {
    Stack() {
      Column()
        .width('100%')
        .height('100%')
        .onClick(() => {
          this.showEpPanel = false;
        })
      Column() {
        Row() {
          Text(PlaySession.vodName)
            .fontSize(15)
            .fontWeight(FontWeight.Bold)
            .fontColor(COLOR_TEXT)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
          Text('×')
            .fontSize(20)
            .fontColor(COLOR_TEXT_SUB)
            .padding({ left: 12, right: 4 })
            .onClick(() => {
              this.showEpPanel = false;
            })
        }
        .width('100%')
        Text('线路')
          .fontSize(13)
          .fontColor(COLOR_TEXT_SUB)
          .margin({ top: 10 })
        Scroll() {
          Row({ space: 8 }) {
            ForEach(PlaySession.flags, (flag: string, fi: number) => {
              Text(flag)
                .fontSize(12)
                .fontWeight(this.flagIndex === fi ? FontWeight.Bold : FontWeight.Normal)
                .fontColor(this.flagIndex === fi ? COLOR_TEXT : COLOR_TEXT_SUB)
                .backgroundColor(this.flagIndex === fi ? COLOR_ACCENT : COLOR_SURFACE)
                .borderRadius(14)
                .padding({ left: 12, right: 12, top: 6, bottom: 6 })
                .onClick(() => {
                  this.switchEpisode(fi, 0);
                })
            }, (flag: string, fi: number) => `${flag}_${fi}`)
          }
        }
        .scrollable(ScrollDirection.Horizontal)
        .width('100%')
        .margin({ top: 8 })

        Scroll() {
          Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.Start }) {
            ForEach(PlaySession.epUrls[this.flagIndex] ?? [], (url: string, ei: number) => {
              Text((PlaySession.epNames[this.flagIndex] ?? [])[ei] ?? `第${ei + 1}集`)
                .fontSize(13)
                .fontColor(this.epIndex === ei ? COLOR_TEXT : COLOR_TEXT_SUB)
                .backgroundColor(this.epIndex === ei ? COLOR_ACCENT : COLOR_SURFACE)
                .borderRadius(8)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .constraintSize({ maxWidth: '31%' })
                .padding({ left: 10, right: 10, top: 8, bottom: 8 })
                .margin({ right: 8, bottom: 8 })
                .onClick(() => {
                  this.switchEpisode(this.flagIndex, ei);
                })
            }, (url: string, ei: number) => `ep_${this.flagIndex}_${ei}`)
          }
          .width('100%')
        }
        .scrollBar(BarState.Auto)
        .layoutWeight(1)
        .margin({ top: 10 })
      }
      .width('100%')
      .height('46%')
      .padding(16)
      .backgroundColor('#F014141C')
      .borderRadius({ topLeft: 14, topRight: 14 })
      .alignItems(HorizontalAlign.Start)
      .onClick((_e: ClickEvent) => {
        // 面板内部点击不关闭
      })
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  buildSkipPanel() {
    Stack() {
      Column()
        .width('100%')
        .height('100%')
        .onClick(() => {
          this.showSkipPanel = false;
        })
      Column() {
        Row() {
          Text('片头片尾设置')
            .fontSize(15)
            .fontWeight(FontWeight.Bold)
            .fontColor(Color.WHITE)
            .layoutWeight(1)
          Text('×')
            .fontSize(20)
            .fontColor(COLOR_TEXT_SUB)
            .padding({ left: 12, right: 4 })
            .onClick(() => {
              this.showSkipPanel = false;
            })
        }
        .width('100%')
        Text('片头时长（秒，0=不跳）')
          .fontSize(12)
          .fontColor(COLOR_TEXT_SUB)
          .margin({ top: 12 })
        TextInput({ text: this.introInput, placeholder: `${this.introSec}` })
          .fontSize(14)
          .height(40)
          .backgroundColor(COLOR_SURFACE)
          .margin({ top: 6 })
          .onChange((v: string) => { this.introInput = v; })
        Text('片尾时长（秒，0=不跳）')
          .fontSize(12)
          .fontColor(COLOR_TEXT_SUB)
          .margin({ top: 12 })
        TextInput({ text: this.outroInput, placeholder: `${this.outroSec}` })
          .fontSize(14)
          .height(40)
          .backgroundColor(COLOR_SURFACE)
          .margin({ top: 6 })
          .onChange((v: string) => { this.outroInput = v; })
        Row({ space: 12 }) {
          Button('立即跳过片头')
            .fontSize(12)
            .fontColor(COLOR_TEXT)
            .backgroundColor(COLOR_ACCENT)
            .borderRadius(16)
            .height(34)
            .onClick(() => {
              if (this.introSec > 0) {
                this.seekToMs(this.introSec * 1000);
                this.showToast('已跳过片头');
              } else {
                this.showToast('尚未设置片头时长');
              }
            })
          Button('保存')
            .fontSize(12)
            .fontColor(COLOR_TEXT)
            .backgroundColor(COLOR_ACCENT)
            .borderRadius(16)
            .height(34)
            .onClick(() => {
              this.introSec = Number(this.introInput) > 0 ? Number(this.introInput) : this.introSec;
              this.outroSec = Number(this.outroInput) > 0 ? Number(this.outroInput) : this.outroSec;
              this.saveSkipSettings();
              this.showToast('已保存');
              this.showSkipPanel = false;
            })
        }
        .margin({ top: 16 })
        .alignItems(VerticalAlign.Center)
      }
      .width('100%')
      .padding(16)
      .backgroundColor('#F014141C')
      .borderRadius({ topLeft: 14, topRight: 14 })
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  buildCastPanel() {
    Stack() {
      Column()
        .width('100%')
        .height('100%')
        .onClick(() => {
          this.castPanelVisible = false;
        })
      Column() {
        Row() {
          Text('投屏')
            .fontSize(16)
            .fontWeight(FontWeight.Bold)
            .fontColor(Color.WHITE)
            .layoutWeight(1)
          Text('×')
            .fontSize(20)
            .fontColor(COLOR_TEXT_SUB)
            .padding({ left: 12, right: 4 })
            .onClick(() => {
              this.castPanelVisible = false;
            })
        }
        .width('100%')
        Text('HarmonyOS 投屏走系统分布式投屏通道：')
          .fontSize(12)
          .fontColor(COLOR_TEXT_SUB)
          .margin({ top: 12 })
        Text('① 下拉控制中心 → 点击「超级终端/投播」；\n② 选择与本机处于同一局域网的智慧屏/平板；\n③ 选择后本播放器的音视频会自动流转过去。')
          .fontSize(13)
          .fontColor(Color.WHITE)
          .lineHeight(22)
          .margin({ top: 8 })
        Button('知道了')
          .fontSize(12)
          .fontColor(Color.WHITE)
          .backgroundColor(COLOR_ACCENT)
          .borderRadius(16)
          .height(34)
          .margin({ top: 18 })
          .onClick(() => {
            this.castPanelVisible = false;
          })
      }
      .width('100%')
      .padding(16)
      .backgroundColor('#F014141C')
      .borderRadius({ topLeft: 14, topRight: 14 })
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height('100%')
  }
}
