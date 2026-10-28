import media from '@ohos.multimedia.media';
import router from '@ohos.router';
import { BusinessError } from '@ohos.base';
import { PlaySession } from '../model/Vod';
import { HistoryEntry, HistoryStore } from '../model/History';
import { Global } from '../model/Config';

// ---- 云映品牌色 ----
const COLOR_BG = '#000000';
const COLOR_ACCENT = '#3D7EFF';
const COLOR_TEXT = '#FFFFFF';
const COLOR_TEXT_SUB = '#9A9AAC';
const COLOR_SURFACE = '#1E1E2A';

/** 倍速档位（AVPlayer 支持的固定档） */
const SPEEDS: media.PlaybackSpeed[] = [
  media.PlaybackSpeed.SPEED_FORWARD_0_75_X,
  media.PlaybackSpeed.SPEED_FORWARD_1_00_X,
  media.PlaybackSpeed.SPEED_FORWARD_1_25_X,
  media.PlaybackSpeed.SPEED_FORWARD_1_75_X,
  media.PlaybackSpeed.SPEED_FORWARD_2_00_X
];
const SPEED_LABELS: string[] = ['0.75x', '1x', '1.25x', '1.75x', '2x'];
const SPEED_DEFAULT = 1;
const AUTO_HIDE_MS = 3600;
const HISTORY_TICK_MS = 10000;

/**
 * 云映全屏播放器（点播）：
 *   - AVPlayer + XComponent 全屏画面
 *   - 底部进度条 + 播放暂停 + 集切换；顶部返回/标题
 *   - 倍速快捷条 / 选集面板（半屏，腾讯视频式）
 *   - 自动连播、播放历史（含续播位置）
 */
@Entry
@Component
struct VodPlayer {

  // ---- 播放状态 ----
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

  // ---- 控件显隐 ----
  @State controlsVisible: boolean = true;
  private hideTimerId: number = -1;

  // ---- 面板 ----
  @State showSpeedPanel: boolean = false;
  @State showEpPanel: boolean = false;
  @State speedIndex: number = SPEED_DEFAULT;

  // ---- 历史记录节流 ----
  private historyTickId: number = -1;
  private resumePending: number = 0;

  aboutToAppear(): void {
    this.flagIndex = PlaySession.flagIndex;
    this.epIndex = PlaySession.epIndex;
    this.resumePending = PlaySession.resumePosition;
    if (!PlaySession.hasTarget()) {
      this.statusText = '无播放目标，请返回重选';
    }
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
      player.on('bufferingUpdate', (_info: media.BufferingInfoType) => {
        // 缓冲比例仅作提示，状态栏以 stateChange 为准
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
          // 播完：自动连播下一集（最后一集停在完成态页面）
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

  // ================= 定时任务 =================

  private startTimers(): void {
    this.stopTimers();
    this.historyTickId = setInterval(() => {
      this.saveHistoryNow();
    }, HISTORY_TICK_MS);
    this.hideTimerId = setInterval(() => {
      if (this.playing) {
        this.controlsVisible = false;
      }
    }, AUTO_HIDE_MS);
  }

  private stopTimers(): void {
    if (this.historyTickId !== -1) {
      clearInterval(this.historyTickId);
      this.historyTickId = -1;
    }
    if (this.hideTimerId !== -1) {
      clearInterval(this.hideTimerId);
      this.hideTimerId = -1;
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
    }
  }

  private async togglePlay(): Promise<void> {
    const p = this.avPlayer;
    if (p === undefined) {
      return;
    }
    // 暂停时同步落历史
    await this.saveHistoryNow();
    if (this.playing) {
      await p.pause();
    } else {
      await p.play();
    }
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
        .height('100%')
        .onLoad(() => {
          this.onSurfaceReady();
        })
        .onDestroy(() => {
          this.releasePlayer();
        })

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
      }

      // 控件层
      if (this.controlsVisible) {
        Column() {
          this.buildTopBar()
          Blank()
          this.buildBottomBar()
        }
        .width('100%')
        .height('100%')
        .onClick(() => {
          this.showControls();
        })
      }

      // 倍速面板
      if (this.showSpeedPanel) {
        this.buildSpeedPanel()
      }

      // 选集面板
      if (this.showEpPanel) {
        this.buildEpPanel()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(COLOR_BG)
    .onTouch((_e: TouchEvent) => {
      // 任意触点视为保活
    })
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
        Text((PlaySession.epNames[this.flagIndex] ?? [])[this.epIndex] ?? '')
          .fontSize(12)
          .fontColor(COLOR_TEXT_SUB)
          .maxLines(1)
          .margin({ top: 2 })
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      .margin({ left: 12 })
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 12, bottom: 8 })
  }

  @Builder
  buildBottomBar() {
    Column() {
      // 进度条行
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
              const p = this.avPlayer;
              if (p !== undefined && this.durMs > 0) {
                p.seek(target, media.SeekMode.SEEK_PREV_SYNC);
              }
              this.posMs = target;
              this.sliding = false;
            }
          })
        Text(this.fmt(this.durMs))
          .fontSize(11)
          .fontColor(COLOR_TEXT_SUB)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      // 按钮行
      Row({ space: 18 }) {
        Text('▶ 上一集')
          .fontSize(13)
          .fontColor(this.epIndex > 0 ? COLOR_TEXT : COLOR_TEXT_SUB)
          .onClick(() => {
            if (this.epIndex > 0) {
              this.switchEpisode(this.flagIndex, this.epIndex - 1);
            }
          })
        Text(this.playing ? '⏸ 暂停' : '▶ 播放')
          .fontSize(15)
          .fontWeight(FontWeight.Bold)
          .fontColor(COLOR_TEXT)
          .onClick(() => {
            this.togglePlay();
          })
        Text('下一集 ▶')
          .fontSize(13)
          .fontColor(this.epIndex + 1 < (PlaySession.epUrls[this.flagIndex] ?? []).length
            ? COLOR_TEXT : COLOR_TEXT_SUB)
          .onClick(() => {
            this.playNext();
          })
        Blank()
        Text('倍速')
          .fontSize(13)
          .fontColor(COLOR_SPEED_LABEL(this.speedIndex))
          .onClick(() => {
            this.showSpeedPanel = !this.showSpeedPanel;
            this.showEpPanel = false;
          })
        Text('选集')
          .fontSize(13)
          .fontColor(COLOR_TEXT)
          .onClick(() => {
            this.showEpPanel = !this.showEpPanel;
            this.showSpeedPanel = false;
          })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .margin({ top: 6 })
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 10, bottom: 22 })
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
      // 遮罩关闭
      Column()
        .width('100%')
        .height('100%')
        .onClick(() => {
          this.showEpPanel = false;
        })
      // 半屏选集面板
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
                  // 切线路默认播该线路第一集
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
        // 吞掉面板内部点击，不关闭
      })
    }
    .width('100%')
    .height('100%')
  }
}

function COLOR_SPEED_LABEL(idx: number): string {
  return idx === SPEED_DEFAULT ? COLOR_TEXT : COLOR_ACCENT;
}
