package com.tvbox.yunying.player

import android.content.Context
import android.content.ContentValues
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.media.AudioManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Log
import android.view.*
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.EditText
import android.widget.ImageButton
import android.widget.SeekBar
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.PopupMenu
import androidx.media3.ui.PlayerView
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import com.tvbox.yunying.ConfigLoader
import com.tvbox.yunying.Episode
import com.tvbox.yunying.HistoryItem
import com.tvbox.yunying.HistoryStore
import com.tvbox.yunying.player.mpv.ExoPlayerEngine
import com.tvbox.yunying.player.mpv.MpvPlayerEngine
import com.tvbox.yunying.spider.SpiderManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * 播放器 Activity：支持 ExoPlayer（默认）与 mpv（全能内核）双内核切换。
 *
 * 仿腾讯视频播放器交互：
 * - 顶栏：返回（左）+ 标题（中）+ 选集 + ⋯ 菜单（右）
 * - ⋯ 菜单：倍速（0.5~3.0）/ 切换内核（Exo/mpv/Auto）/ 刷新重试
 * - 手势：左侧上下滑=亮度，右侧上下滑=音量，横向滑动=快进快退（全屏 ±90s），长按=3 倍速
 * - 选集：顶栏"选集"按钮弹窗选集，播完自动连播下一集
 * - 历史：暂停/切集/退出时记录进度，支持续播
 * - mpv 未内置 libmpv 时：切换内核给出提示并保持 Exo，播放异常自动回退，绝不闪退
 */
class PlayerActivity : AppCompatActivity(), PlayerEngine.PlayerListener {

    companion object {
        const val EXTRA_URL = "url"
        const val EXTRA_PLAY_URL = "playUrl"
        const val EXTRA_TITLE = "title"
        const val EXTRA_HEADERS = "headers"
        const val EXTRA_SITE_INDEX = "siteIndex"
        const val EXTRA_VOD_ID = "vodId"
        const val EXTRA_VOD_NAME = "vodName"
        const val EXTRA_VOD_PIC = "vodPic"
        const val EXTRA_FLAG = "flag"
        const val EXTRA_EPISODE_ID = "episodeId"
        const val EXTRA_EPISODES = "episodes"
        const val EXTRA_POSITION = "position"
        const val PREF_CORE = "yunying_player_core"
        const val EXTRA_DANMAKU_URL = "danmakuUrl"
        const val AUTO_HIDE_MS = 5000L   // 无操作 5 秒隐藏全部控件
        const val SKIP_PREF_PREFIX = "yunying_skip_" // 片头片尾设置 key 前缀

        private val SPEEDS = floatArrayOf(0.5f, 0.75f, 1.0f, 1.25f, 1.5f, 2.0f, 3.0f)
        private const val LONG_PRESS_MS = 600L
        private const val BOOST_SPEED = 3.0f
        private const val SEEK_RANGE_MS = 90_000L
    }

    // 视图
    private lateinit var playerContainer: GestureLayout
    private lateinit var playerView: PlayerView
    private var textureViewForMpv: android.view.TextureView? = null
    private var titleView: TextView? = null
    private var overlayBox: LinearLayout? = null
    private var overlayText: TextView? = null
    private var overlayProgress: ProgressBar? = null
    private var overlayHideRunnable: Runnable? = null

    // 引擎状态
    private var currentEngine: PlayerEngine? = null
    private var currentType: PlayerCoreType = PlayerCoreType.AUTO
    private var finalUrl: String = ""
    private var headers: Map<String, String> = emptyMap()
    private var titleText: String = ""
    private var fallbackUsed = false
    private var currentSpeed: Float = 1.0f

    // 选集/历史上下文
    private var siteIndex = 0
    private var vodId = ""
    private var vodName = ""
    private var vodPic = ""
    private var flag = ""
    private var episodeId = ""
    private var episodeName = ""
    private var episodes: List<Episode> = emptyList()
    private var pendingSeekMs = 0L

    // 手势状态
    private var boosting = false
    private var savedSpeed = 1.0f
    private var gestureAccum = 0f
    private var gestureBaseBright = 0.5f
    private var gestureBaseVolume = 0
    private var seekBaseMs = 0L
    private var seekTargetMs = 0L

    // ---- 新播放界面（三端统一布局）----
    private var topBar: LinearLayout? = null
    private var midRow: LinearLayout? = null
    private var bottomBar: LinearLayout? = null
    private var seekBar: SeekBar? = null
    private var timeLeftView: TextView? = null
    private var timeRightView: TextView? = null
    private var playPauseBtn: TextView? = null
    private var danmakuView: DanmakuView? = null
    private var danmakuUrl: String = ""
    private var danmakuItems: List<DanmakuView.Danmaku> = emptyList()
    private var danmakuOn = false
    private var locked = false
    private var isFullscreen = true
    private var introMs = 0L        // 片头设置（0=未设置）
    private var outroMs = 0L        // 片尾设置（0=未设置）
    private var introSkipped = false

    private val uiHandler = Handler(Looper.getMainLooper())
    private val hideRunnable = Runnable { setControlsVisible(false) }
    private val tickRunnable = object : Runnable {
        override fun run() {
            val eng = currentEngine
            if (eng != null) {
                val pos = eng.getCurrentPosition()
                val dur = eng.getDuration()
                val sb = seekBar
                if (sb != null && !sb.isPressed) {
                    if (dur > 0) sb.progress = ((pos.toFloat() / dur) * 1000f).toInt().coerceIn(0, 1000)
                }
                timeLeftView?.text = formatTime(pos)
                timeRightView?.text = formatTime(dur)
                playPauseBtn?.text = if (eng.isPlaying()) "⏸" else "▶"
            }
            uiHandler.postDelayed(this, 500)
        }
    }

    private val audioManager by lazy { getSystemService(Context.AUDIO_SERVICE) as AudioManager }
    private val gson = Gson()
    private val playerScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        supportRequestWindowFeature(Window.FEATURE_NO_TITLE)
        window.setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            WindowManager.LayoutParams.FLAG_FULLSCREEN
        )

        val url = intent.getStringExtra(EXTRA_URL) ?: run { finish(); return }
        val playUrl = intent.getStringExtra(EXTRA_PLAY_URL) ?: ""
        finalUrl = if (url.startsWith("http")) url else playUrl
        titleText = intent.getStringExtra(EXTRA_TITLE) ?: "云映"
        @Suppress("UNCHECKED_CAST")
        headers = (intent.getSerializableExtra(EXTRA_HEADERS) as? HashMap<String, String>)?.toMap() ?: emptyMap()
        siteIndex = intent.getIntExtra(EXTRA_SITE_INDEX, 0)
        vodId = intent.getStringExtra(EXTRA_VOD_ID) ?: ""
        vodName = intent.getStringExtra(EXTRA_VOD_NAME) ?: ""
        vodPic = intent.getStringExtra(EXTRA_VOD_PIC) ?: ""
        flag = intent.getStringExtra(EXTRA_FLAG) ?: ""
        episodeId = intent.getStringExtra(EXTRA_EPISODE_ID) ?: ""
        episodeName = titleText.substringAfterLast("·", titleText)
        pendingSeekMs = intent.getLongExtra(EXTRA_POSITION, 0L)
        episodes = intent.getStringExtra(EXTRA_EPISODES)?.let { json ->
            runCatching {
                val t: TypeToken<List<Episode>> = object : TypeToken<List<Episode>>() {}
                gson.fromJson<List<Episode>>(json, t.type)
            }.getOrNull()
        } ?: emptyList()

        // 根容器（手势层）
        playerContainer = GestureLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        // ExoPlayer 的 PlayerView
        playerView = PlayerView(this).apply {
            id = View.generateViewId()
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            // 两内核（Exo/mpv）共用统一控件层，禁用 Exo 自带控制器
            useController = false
            setShowSubtitleButton(false)
        }
        playerContainer.addView(playerView)

        // TextureView（mpv 渲染用）——默认隐藏
        val tv = android.view.TextureView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            visibility = View.GONE
        }
        textureViewForMpv = tv
        playerContainer.addView(tv)

        buildOverlay()
        buildControls()
        danmakuUrl = intent.getStringExtra(EXTRA_DANMAKU_URL) ?: ""
        loadSkipSettings()
        setContentView(playerContainer)
        setupGestures()
        uiHandler.post(tickRunnable)
        if (danmakuUrl.isNotBlank()) {
            playerScope.launch {
                danmakuItems = withContext(Dispatchers.IO) { DanmakuView.fetch(danmakuUrl) }
                danmakuView?.load(danmakuItems)
                if (danmakuItems.isEmpty()) {
                    Toast.makeText(this@PlayerActivity, "弹幕加载为空", Toast.LENGTH_SHORT).show()
                }
            }
        }

        // 读取内核选择并启动
        val saved = getSharedPreferences("yunying", Context.MODE_PRIVATE)
            .getString(PREF_CORE, "auto")
        currentType = when (saved) {
            "exo" -> PlayerCoreType.EXO
            "mpv" -> if (MpvPlayerEngine.isAvailable()) PlayerCoreType.MPV else PlayerCoreType.AUTO
            else -> PlayerCoreType.AUTO
        }
        startEngine(currentType)
    }

    /** 播放界面（三端统一规范）：
     *  顶栏：左=返回+剧名，右=投屏
     *  中部：左列（锁定/弹幕）纵向，中=播放暂停，右列（截图/横竖屏）纵向
     *  底上：进度条（左已播/右总时长，可拖动）
     *  底下（从右）：选集、上一集、下一集、片头片尾、全屏/退出全屏
     *  无操作 5 秒全部隐藏，仅显示画面；锁定时只剩解锁按钮 */
    private fun buildControls() {
        val density = resources.displayMetrics.density
        fun dp(v: Int) = (v * density).toInt()

        fun chipBg(active: Boolean) = GradientDrawable().apply {
            cornerRadius = 20 * density
            setColor(if (active) 0xFF3D7EFF.toInt() else 0x66000000.toInt())
        }

        fun textBtn(text: String, size: Float, active: Boolean = false): TextView =
            TextView(this).apply {
                this.text = text
                setTextColor(if (active) Color.WHITE else 0xE6FFFFFF.toInt())
                textSize = size
                gravity = Gravity.CENTER
                background = chipBg(active)
                setPadding(dp(14), dp(8), dp(14), dp(8))
            }

        // ── 顶栏 ──
        topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(18), dp(12), dp(10))
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP
            )
        }.also { bar ->
            val back = textBtn("←", 20f).apply {
                setPadding(dp(4), 0, dp(4), 0)
                background = null
                setOnClickListener { finish() }
            }
            titleView = TextView(this).apply {
                text = titleText
                setTextColor(Color.WHITE)
                textSize = 16f
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
                setPadding(dp(12), 0, dp(12), 0)
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            val cast = TextView(this).apply {
                text = "投"
                textSize = 16f
                setTextColor(Color.WHITE)
                gravity = Gravity.CENTER
                setOnClickListener { showCastDialog(it) }
            }
            bar.addView(back)
            bar.addView(titleView)
            bar.addView(cast)
            playerContainer.addView(bar)
        }

        // ── 弹幕层（置于手势层之上、控件之下）──
        danmakuView = DanmakuView(this).apply {
            visibility = View.GONE
            timeProvider = { currentEngine?.getCurrentPosition() ?: 0L }
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT
            )
        }
        playerContainer.addView(danmakuView)

        // ── 中部行：左列（锁定/弹幕）| 中（播放暂停）| 右列（截图/横竖屏）──
        midRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT
            )
            setPadding(dp(14), dp(60), dp(14), dp(140)) // 避开顶栏/底栏
        }.also { mid ->
            // 左列：锁定 / 弹幕（纵向）
            val leftCol = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_VERTICAL
            }
            val lockBtn = textBtn("🔒", 16f).apply {
                setOnClickListener { toggleLock() }
            }
            val danmakuBtn = textBtn("弹", 14f).apply {
                setOnClickListener { toggleDanmaku() }
            }
            leftCol.addView(lockBtn)
            leftCol.addView(danmakuBtn, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) })

            // 中：播放/暂停
            val playBtn = textBtn("▶", 26f).apply {
                setPadding(dp(22), dp(16), dp(22), dp(22))
                setOnClickListener { togglePlayPause() }
            }
            playPauseBtn = playBtn

            // 右列：截图 / 横竖屏（纵向）
            val rightCol = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_VERTICAL
            }
            val shotBtn = textBtn("📷", 16f).apply {
                setOnClickListener { takeScreenshot() }
            }
            val rotateBtn = textBtn("⇄", 18f).apply {
                setOnClickListener { toggleScreenOrientation() }
            }
            rightCol.addView(shotBtn)
            rightCol.addView(rotateBtn, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) })

            mid.addView(leftCol, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.MATCH_PARENT))
            mid.addView(playBtn, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.CENTER
            })
            mid.addView(rightCol, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.MATCH_PARENT, 1f).apply {
                gravity = Gravity.END or Gravity.CENTER_VERTICAL
            })
            playerContainer.addView(mid)
        }

        // ── 底部容器：靠上进度条 + 靠下按钮行 ──
        bottomBar = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(6), dp(16), dp(14))
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM
            )
        }.also { bot ->
            // 进度条行（靠上）
            val seekRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            timeLeftView = TextView(this).apply {
                text = "00:00"
                setTextColor(0xFF9A9AAC.toInt())
                textSize = 11f
            }
            seekBar = SeekBar(this).apply {
                max = 1000
                progress = 0
                val pad = dp(40)
                setPadding(pad, 0, pad, 0)
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    setMargins(dp(8), 0, dp(8), 0)
                }
                thumbTintList = android.content.res.ColorStateList.valueOf(0xFF3D7EFF.toInt())
                progressTintList = android.content.res.ColorStateList.valueOf(0xFF3D7EFF.toInt())
                setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                    override fun onProgressChanged(sb: SeekBar?, progress: Int, fromUser: Boolean) {
                        if (fromUser) poke()
                    }
                    override fun onStartTrackingTouch(sb: SeekBar?) { poke() }
                    override fun onStopTrackingTouch(sb: SeekBar?) {
                        val dur = currentEngine?.getDuration() ?: 0L
                        if (dur > 0) {
                            currentEngine?.seekTo(sb?.progress?.let { it.toLong() * dur / 1000 } ?: 0)
                        }
                        findControlsVisible(true)
                        poke()
                    }
                })
            }
            timeRightView = TextView(this).apply {
                text = "00:00"
                setTextColor(0xFF9A9AAC.toInt())
                textSize = 11f
            }
            seekRow.addView(timeLeftView)
            seekRow.addView(seekBar)
            seekRow.addView(timeRightView)

            // 按钮行（靠下，从右：选集、上一集、下一集、片头片尾、全屏）
            val actionsRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.END or Gravity.CENTER_VERTICAL
            }.also { row ->
                fun act(label: String, idTag: String, onClick: () -> Unit) {
                    val lp = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    )
                    lp.marginEnd = dp(10)
                    row.addView(textBtn(label, 13f).apply {
                        tag = idTag
                        setOnClickListener { onClick(); poke() }
                    }, lp)
                }
                act("选集", "episodes") { showEpisodeDialog() }
                act("上一集", "prev") { gotoEpisode(-1) }
                act("下一集", "next") { gotoEpisode(1) }
                act("片头片尾", "skip") { setupSkipDialog() }
                val coreBtn = textBtn("内核·${coreName(currentType)}", 13f).apply {
                    setOnClickListener {
                        switchCore()
                        (it as TextView).text = "内核·${coreName(currentType)}"
                    }
                }
                row.addView(coreBtn)
                val fullscreen = textBtn(if (isFullscreen) "退出全屏" else "全屏", 13f).apply {
                    setOnClickListener {
                        toggleFullscreen()
                        (it as TextView).text = if (isFullscreen) "退出全屏" else "全屏"
                    }
                }
                row.addView(fullscreen)
            }

            bot.addView(seekRow)
            bot.addView(actionsRow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) })
            playerContainer.addView(bot)
        }

        // 锁定后浮动解锁按钮（锁定时唯一可见控件）
        val unlockChip = TextView(this).apply {
            text = "🔓"
            textSize = 18f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            background = chipBg(true)
            setPadding(dp(16), dp(10), dp(16), dp(10))
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP or Gravity.CENTER_HORIZONTAL
            ).apply { topMargin = dp(60) }
            setOnClickListener {
                locked = false
                playerContainer.locked = false
                visibility = View.GONE
                setControlsVisible(true); poke()
                Toast.makeText(applicationContext, "已解锁操作", Toast.LENGTH_SHORT).show()
            }
        }
        playerContainer.addView(unlockChip)
        unlockChipBtn = unlockChip

        findControlsVisible(true)
        poke()
    }

    private var unlockChipBtn: TextView? = null

    /** 控件显隐总开关（锁定时只留解锁按钮） */
    private fun setControlsVisible(show: Boolean) {
        val vis = if (show) View.VISIBLE else View.GONE
        if (locked) {
            topBar?.visibility = View.GONE
            midRow?.visibility = View.GONE
            bottomBar?.visibility = View.GONE
            unlockChipBtn?.visibility = View.VISIBLE
        } else {
            topBar?.visibility = vis
            midRow?.visibility = vis
            bottomBar?.visibility = vis
            unlockChipBtn?.visibility = View.GONE
        }
    }

    private fun findControlsVisible(@Suppress("UNUSED_PARAMETER") show: Boolean) {
        setControlsVisible(true)
    }

    /** 无操作计时 */
    private fun poke() {
        uiHandler.removeCallbacks(hideRunnable)
        setControlsVisible(true)
        uiHandler.postDelayed(hideRunnable, AUTO_HIDE_MS)
    }

    // ================= 新规范功能 =================

    /** 锁定/解锁：锁定后屏蔽手势，只留解锁浮钮 */
    private fun toggleLock() {
        locked = !locked
        playerContainer.locked = locked
        setControlsVisible(!locked)
        if (locked) {
            unlockChipBtn?.visibility = View.VISIBLE
            uiHandler.removeCallbacks(hideRunnable)
            Toast.makeText(this, "已锁定，播放不会被手势打断", Toast.LENGTH_SHORT).show()
        } else {
            unlockChipBtn?.visibility = View.GONE
            poke()
            Toast.makeText(this, "已解锁", Toast.LENGTH_SHORT).show()
        }
    }

    /** 弹幕开关（无源时提示） */
    private fun toggleDanmaku() {
        if (danmakuUrl.isBlank()) {
            Toast.makeText(this, "暂无弹幕源，该站点未提供弹幕", Toast.LENGTH_SHORT).show()
            return
        }
        danmakuOn = !danmakuOn
        danmakuView?.setEnabled(danmakuOn)
        Toast.makeText(this, if (danmakuOn) "弹幕已开启（${danmakuItems.size}条）" else "弹幕已关闭", Toast.LENGTH_SHORT).show()
    }

    /** 播放/暂停切换 */
    private fun togglePlayPause() {
        val eng = currentEngine ?: return
        if (eng.isPlaying()) { eng.pause(); Toast.makeText(this, "已暂停", Toast.LENGTH_SHORT).show() }
        else { eng.play(); Toast.makeText(this, "继续播放", Toast.LENGTH_SHORT).show() }
    }

    /** 截图：TextureView 直接取位图；SurfaceView（Exo）走 PixelCopy → 存入相册 */
    private fun takeScreenshot() {
        val eng = currentEngine ?: return
        val density = resources.displayMetrics.density
        fun savedToast(u: Uri?) =
            Toast.makeText(this, if (u != null) "截图已保存到相册" else "截图失败", Toast.LENGTH_SHORT).show()

        fun storeBitmap(bmp: Bitmap) {
            playerScope.launch {
                val uri = withContext(Dispatchers.IO) {
                    runCatching {
                        val values = ContentValues().apply {
                            put(MediaStore.MediaColumns.DISPLAY_NAME, "yunying_${System.currentTimeMillis()}.png")
                            put(MediaStore.MediaColumns.MIME_TYPE, "image/png")
                            put(MediaStore.MediaColumns.RELATIVE_PATH, "Pictures/YunYing")
                        }
                        val u = contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)!!
                        contentResolver.openOutputStream(u)!!.use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
                        u
                    }.getOrNull()
                }
                savedToast(uri)
            }
        }

        if (eng is ExoPlayerEngine) {
            val sv = playerView.videoSurfaceView
            if (sv == null) {
                Toast.makeText(this, "未找到画面可截取", Toast.LENGTH_SHORT).show()
                return
            }
            val bmp = Bitmap.createBitmap(sv.width.coerceAtLeast(1), sv.height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
            try {
                PixelCopy.request(sv, bmp, { r -> if (r == PixelCopy.SUCCESS) storeBitmap(bmp) }, Handler(Looper.getMainLooper()))
            } catch (t: Throwable) {
                Log.e("PlayerActivity", "PixelCopy 失败", t)
            }
        } else {
            val tv = textureViewForMpv
            val bmp = tv?.bitmap
            if (bmp == null) {
                Toast.makeText(this, "暂无画面可截取", Toast.LENGTH_SHORT).show()
            } else storeBitmap(bmp)
        }
        Toast.makeText(this, "正在截取画面…", Toast.LENGTH_SHORT).show()
    }

    /** 横竖屏切换 */
    private fun toggleScreenOrientation() {
        val target = if (resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE)
            ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        requestedOrientation = target
        Toast.makeText(this, if (target == ActivityInfo.SCREEN_ORIENTATION_PORTRAIT) "切换到竖屏" else "切换到横屏", Toast.LENGTH_SHORT).show()
    }

    /** 全屏/退出全屏：退出=竖屏 + 16:9 顶置；恢复=全屏横屏 */
    private fun toggleFullscreen() {
        isFullscreen = !isFullscreen
        val vui = playerView
        if (isFullscreen) {
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            vui.layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT
            )
            midRow?.setPadding(
                (14 * resources.displayMetrics.density).toInt(),
                (60 * resources.displayMetrics.density).toInt(),
                (14 * resources.displayMetrics.density).toInt(),
                (140 * resources.displayMetrics.density).toInt()
            )
        } else {
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            val w = resources.displayMetrics.widthPixels
            vui.layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, (w * 9 / 16)
            )
            midRow?.setPadding(
                (14 * resources.displayMetrics.density).toInt(),
                (16 * resources.displayMetrics.density).toInt(),
                (14 * resources.displayMetrics.density).toInt(),
                (60 * resources.displayMetrics.density).toInt()
            )
        }
    }

    /** 上一集/下一集 */
    private fun gotoEpisode(delta: Int) {
        if (episodes.isEmpty()) {
            Toast.makeText(this, "暂无选集信息", Toast.LENGTH_SHORT).show()
            return
        }
        val idx = episodes.indexOfFirst { it.id == episodeId }
        val target = episodes.getOrNull(idx + delta)
        if (target == null) {
            Toast.makeText(this, if (delta < 0) "已经是第一集" else "已经是最后一集", Toast.LENGTH_SHORT).show()
            return
        }
        playEpisodeDirect(target)
    }

    /** 投屏：系统 MediaRouter2 路由探测 + 路由选择；无可用路由时打开系统投屏设置 */
    private fun showCastDialog(anchor: View) {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            try {
                val router = android.media.MediaRouter2.getInstance(this)
                val routes = router.routes
                if (routes.isEmpty()) {
                    openSystemCastSettings()
                    return
                }
                val items = routes.map { r -> "📺 ${r.name}" }
                AlertDialog.Builder(this)
                    .setTitle("投屏到…")
                    .setItems(items.toTypedArray()) { d, which ->
                        val route = routes[which]
                        try {
                            router.selectRoute(route)
                            Toast.makeText(this, "已切换输出：${route.name}", Toast.LENGTH_SHORT).show()
                        } catch (t: Throwable) {
                            Toast.makeText(this, "切换输出失败：${t.message}", Toast.LENGTH_SHORT).show()
                        }
                        d.dismiss()
                    }
                    .setNegativeButton("取消", null)
                    .show()
            } catch (t: Throwable) {
                openSystemCastSettings()
            }
        } else {
            openSystemCastSettings()
        }
    }

    private fun openSystemCastSettings() {
        AlertDialog.Builder(this)
            .setTitle("投屏")
            .setMessage("当前未发现可投屏的设备。\n\n请确认手机与目标设备在同一 Wi-Fi，或在系统设置中打开投屏后重试。")
            .setPositiveButton("打开系统投屏") { d, _ ->
                runCatching {
                    startActivity(Intent("android.settings.CAST_SETTINGS")
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
                d.dismiss()
            }
            .setNegativeButton("关闭", null)
            .show()
    }

    /** 片头片尾设置弹窗（本剧本地保存 ds 单位秒） */
    private fun setupSkipDialog() {
        val v = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding((24 * resources.displayMetrics.density).toInt(), (16 * resources.displayMetrics.density).toInt(), (24 * resources.displayMetrics.density).toInt(), 0) }
        fun field(label: String, value: Long): Pair<TextView, EditText> {
            val lab = TextView(this).apply { text = label; setTextColor(Color.WHITE); textSize = 13f }
            val et = EditText(this).apply {
                setText((value / 1000).let { if (it > 0) it.toString() else "" })
                hint = "秒"
                inputType = android.text.InputType.TYPE_CLASS_NUMBER
            }
            v.addView(lab); v.addView(et)
            return lab to et
        }
        val introEt = field("跳过片头时间", introMs).second
        val outroEt = field("跳过片尾时间", outroMs).second
        AlertDialog.Builder(this)
            .setTitle("设置片头片尾")
            .setView(v)
            .setPositiveButton("保存") { _, _ ->
                introMs = (introEt.text.toString().trim().toLongOrNull() ?: 0L) * 1000
                outroMs = (outroEt.text.toString().trim().toLongOrNull() ?: 0L) * 1000
                saveSkipSettings()
                Toast.makeText(this, "已保存：片头${introMs / 1000}秒 / 片尾${outroMs / 1000}秒", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("直接跳过片头") { d, _ ->
                d.dismiss()
                if (introMs > 0) { currentEngine?.seekTo(introMs); Toast.makeText(this, "已跳过片头", Toast.LENGTH_SHORT).show() }
                else Toast.makeText(this, "尚未设置片头时长", Toast.LENGTH_SHORT).show()
            }
            .setNeutralButton("取消", null)
            .show()
        // 点按钮行里的「片头片尾」= 跳过片头（快速），长按进设置
    }

    private fun skipSettingsKey(): String = SKIP_PREF_PREFIX + siteIndex + "_" + vodId

    private fun loadSkipSettings() {
        val sp = getSharedPreferences("yunying", Context.MODE_PRIVATE)
        introMs = sp.getLong(skipSettingsKey() + "_intro", 0L)
        outroMs = sp.getLong(skipSettingsKey() + "_outro", 0L)
    }

    private fun saveSkipSettings() {
        getSharedPreferences("yunying", Context.MODE_PRIVATE).edit()
            .putLong(skipSettingsKey() + "_intro", introMs)
            .putLong(skipSettingsKey() + "_outro", outroMs)
            .apply()
    }

    /** 手势指示浮层：圆角黑底 + 文字 + 进度条 */
    private fun buildOverlay() {
        val density = resources.displayMetrics.density
        overlayBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding((28 * density).toInt(), (18 * density).toInt(), (28 * density).toInt(), (18 * density).toInt())
            background = GradientDrawable().apply {
                cornerRadius = 16 * density
                setColor(0xAA000000.toInt())
            }
            elevation = 10 * density
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER
            )
        }
        overlayText = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 15f
        }
        overlayProgress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progress = 0
            layoutParams = LinearLayout.LayoutParams((220 * density).toInt(), ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        overlayBox?.addView(overlayText)
        overlayBox?.addView(overlayProgress)
        playerContainer.addView(overlayBox)
    }

    /** 接线手势回调 */
    private fun setupGestures() {
        playerContainer.onGestureStart = { mode ->
            gestureAccum = 0f
            if (mode == GestureLayout.MODE_VERTICAL) {
                val b = window.attributes.screenBrightness
                gestureBaseBright = if (b in 0.01f..1f) b else 0.5f
                gestureBaseVolume = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC)
            } else {
                seekBaseMs = currentEngine?.getCurrentPosition() ?: 0L
                seekTargetMs = seekBaseMs
            }
        }
        playerContainer.onVerticalScroll = { side, dyPercent ->
            gestureAccum += dyPercent
            if (side == 0) {
                // 左侧：亮度
                val b = (gestureBaseBright + gestureAccum * 1.5f).coerceIn(0.01f, 1f)
                val lp = window.attributes
                lp.screenBrightness = b
                window.attributes = lp
                showOverlay("亮度 ${(b * 100).roundToInt()}%", (b * 100).roundToInt())
            } else {
                // 右侧：音量
                val max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
                if (max > 0) {
                    val v = (gestureBaseVolume + gestureAccum * 2f * max).roundToInt().coerceIn(0, max)
                    audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, v, 0)
                    showOverlay("音量 ${v * 100 / max}%", v * 100 / max)
                }
            }
        }
        playerContainer.onHorizontalScroll = { dxPercent ->
            gestureAccum += dxPercent
            val dur = currentEngine?.getDuration() ?: 0L
            val upper = if (dur > 0) dur else Long.MAX_VALUE
            seekTargetMs = (seekBaseMs + gestureAccum * SEEK_RANGE_MS).toLong().coerceIn(0L, upper)
            val delta = seekTargetMs - seekBaseMs
            val label = if (delta >= 0) "快进" else "快退"
            showOverlay("$label ${formatTime(abs(delta))}  →  ${formatTime(seekTargetMs)}", null)
        }
        playerContainer.onGestureEnd = { mode ->
            if (mode == GestureLayout.MODE_HORIZONTAL) currentEngine?.seekTo(seekTargetMs)
            hideOverlayDelayed()
        }
        playerContainer.onLongPressStart = {
            val eng = currentEngine
            if (eng != null) {
                boosting = true
                savedSpeed = currentSpeed
                eng.setSpeed(BOOST_SPEED)
                showOverlay("⚡ ${BOOST_SPEED}倍速快进中", null)
            } else {
                boosting = false
                showOverlay("当前无可用内核", null)
            }
        }
        playerContainer.onLongPressEnd = {
            if (boosting) {
                boosting = false
                currentEngine?.setSpeed(savedSpeed)
                hideOverlayDelayed()
            }
        }
        playerContainer.onSingleTap = {
            if (locked) {
                Toast.makeText(this, "已锁定，可点击顶部解锁按钮", Toast.LENGTH_SHORT).show()
            } else if (topBar?.visibility == View.VISIBLE) {
                // 已显示 → 立即隐藏（提前于 5 秒计时）
                uiHandler.removeCallbacks(hideRunnable)
                setControlsVisible(false)
            } else {
                poke()
            }
        }
    }

    private fun showOverlay(text: String, percent: Int?) {
        val box = overlayBox ?: return
        overlayText?.text = text
        if (percent != null) {
            overlayProgress?.visibility = View.VISIBLE
            overlayProgress?.progress = percent.coerceIn(0, 100)
        } else {
            overlayProgress?.visibility = View.GONE
        }
        if (box.visibility != View.VISIBLE) {
            box.alpha = 0f
            box.visibility = View.VISIBLE
            box.animate().alpha(1f).setDuration(120).start()
        }
        overlayHideRunnable?.let { playerContainer.removeCallbacks(it) }
    }

    private fun hideOverlayDelayed() {
        val box = overlayBox ?: return
        overlayHideRunnable?.let { playerContainer.removeCallbacks(it) }
        val r = Runnable {
            box.animate().alpha(0f).setDuration(150).withEndAction { box.visibility = View.GONE }.start()
        }
        overlayHideRunnable = r
        playerContainer.postDelayed(r, 700)
    }

    private fun formatTime(ms: Long): String {
        val totalSec = ms / 1000
        return "%02d:%02d".format(totalSec / 60, totalSec % 60)
    }

    /** 右上角 ⋯ 菜单：倍速 / 内核 / 刷新（腾讯视频式下拉） */
    private fun showPlayerMenu(anchor: View) {
        val popup = PopupMenu(this, anchor)
        popup.menu.apply {
            val speedItem = add(Menu.NONE, Menu.NONE, 1, "倍速")
            speedItem.isEnabled = currentEngine is ExoPlayerEngine
            val speedMenu = speedItem.subMenu
            SPEEDS.forEachIndexed { i, s ->
                speedMenu?.add(1, Menu.FIRST + i, i, speedLabel(s))?.isChecked = s == currentSpeed
            }
            speedMenu?.setGroupCheckable(1, true, true)
            add(Menu.NONE, Menu.NONE, 2, "切换内核（当前：${coreName(currentType)}）")
            add(Menu.NONE, Menu.NONE, 3, "刷新重试")
        }
        popup.setOnMenuItemClickListener { item ->
            when {
                item.groupId == 1 -> {
                    currentSpeed = SPEEDS[item.itemId - Menu.FIRST]
                    currentEngine?.setSpeed(currentSpeed)
                    Toast.makeText(this, "倍速 ${speedLabel(currentSpeed)}", Toast.LENGTH_SHORT).show()
                    true
                }
                item.title.toString().startsWith("切换内核") -> {
                    switchCore(); true
                }
                item.title.toString() == "刷新重试" -> {
                    startEngine(currentType); true
                }
                else -> false
            }
        }
        popup.show()
    }

    /** 顶栏"选集"弹窗：4 列网格，当前集高亮，点击直接切集 */
    private fun showEpisodeDialog() {
        if (episodes.isEmpty()) {
            Toast.makeText(this, "暂无选集信息", Toast.LENGTH_SHORT).show()
            return
        }
        val density = resources.displayMetrics.density
        val grid = GridLayout(this).apply {
            columnCount = 4
            setPadding((12 * density).toInt(), (8 * density).toInt(), (12 * density).toInt(), (8 * density).toInt())
        }
        var dialogRef: AlertDialog? = null
        episodes.forEach { ep ->
            val isCurrent = ep.id == episodeId
            val cell = TextView(this).apply {
                text = ep.name
                gravity = Gravity.CENTER
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
                textSize = 13f
                setPadding(0, (10 * density).toInt(), 0, (10 * density).toInt())
                background = GradientDrawable().apply {
                    cornerRadius = 8 * density
                    setColor(if (isCurrent) 0xFF3D7EFF.toInt() else 0xFF2A2A38.toInt())
                }
                setTextColor(if (isCurrent) Color.WHITE else 0xFFCCCCCC.toInt())
                layoutParams = GridLayout.LayoutParams(
                    GridLayout.spec(GridLayout.UNDEFINED, 1f),
                    GridLayout.spec(GridLayout.UNDEFINED)
                ).apply {
                    setMargins(
                        (4 * density).toInt(), (4 * density).toInt(),
                        (4 * density).toInt(), (4 * density).toInt()
                    )
                }
                setOnClickListener {
                    dialogRef?.dismiss()
                    playEpisodeDirect(ep)
                }
            }
            grid.addView(cell)
        }
        val scroll = ScrollView(this).apply { addView(grid) }
        val dialog = AlertDialog.Builder(this)
            .setTitle("选集（共 ${episodes.size} 集）")
            .setView(scroll)
            .setNegativeButton("关闭", null)
            .create()
        dialogRef = dialog
        dialog.show()
        dialog.window?.setLayout(
            (resources.displayMetrics.widthPixels * 0.85).toInt(),
            (resources.displayMetrics.heightPixels * 0.6).toInt()
        )
    }

    private fun speedLabel(s: Float): String =
        if (s == 1.0f) "1.0 倍（正常）" else "${s} 倍"

    private fun coreName(t: PlayerCoreType): String = when (t) {
        PlayerCoreType.EXO -> "ExoPlayer"
        PlayerCoreType.MPV -> "mpv"
        PlayerCoreType.AUTO -> "Auto (Exo→mpv)"
    }

    private fun startEngine(type: PlayerCoreType) {
        currentEngine?.release()
        fallbackUsed = false

        var effective = type
        if (type == PlayerCoreType.MPV && !MpvPlayerEngine.isAvailable()) {
            Toast.makeText(this, "当前 APK 未内置 mpv 内核，已回退 ExoPlayer", Toast.LENGTH_SHORT).show()
            effective = PlayerCoreType.EXO
            currentType = effective
        }

        val engine = when (effective) {
            PlayerCoreType.MPV -> MpvPlayerEngine(this)
            else -> ExoPlayerEngine(this)
        }
        currentEngine = engine
        engine.init(this)
        // init 失败会在 onError 里同步回退 EXO；此时本引擎已被替换，直接退出避免画面错乱
        if (currentEngine !== engine) return

        when (engine) {
            is ExoPlayerEngine -> {
                playerView.visibility = View.VISIBLE
                textureViewForMpv?.visibility = View.GONE
                engine.attachPlayerView(playerView)
            }
            is MpvPlayerEngine -> {
                playerView.visibility = View.GONE
                textureViewForMpv?.visibility = View.VISIBLE
                textureViewForMpv?.let { engine.attachSurface(it) }
            }
        }

        var played = false
        try {
            engine.play(finalUrl, headers)
            played = true
        } catch (t: Throwable) {
            Log.e("PlayerActivity", "engine.play 失败", t)
            if (engine is MpvPlayerEngine && !fallbackUsed) {
                fallbackUsed = true
                Toast.makeText(this, "mpv 内核不可用，已回退 ExoPlayer", Toast.LENGTH_SHORT).show()
                startEngine(PlayerCoreType.EXO)
                return
            }
            Toast.makeText(this, "播放失败：${t.message ?: "未知错误"}", Toast.LENGTH_SHORT).show()
        }
        if (played) {
            engine.setSpeed(currentSpeed)
            titleView?.text = "$titleText · ${coreName(effective)}"
        }
    }

    private fun switchCore() {
        val next = when (currentType) {
            PlayerCoreType.EXO -> PlayerCoreType.MPV
            PlayerCoreType.MPV -> PlayerCoreType.AUTO
            PlayerCoreType.AUTO -> PlayerCoreType.EXO
        }
        if (next == PlayerCoreType.MPV && !MpvPlayerEngine.isAvailable()) {
            Toast.makeText(this, "当前 APK 未内置 mpv 内核，无法切换", Toast.LENGTH_SHORT).show()
            return
        }
        currentType = next
        getSharedPreferences("yunying", Context.MODE_PRIVATE).edit()
            .putString(PREF_CORE, next.name.lowercase()).apply()
        startEngine(next)
    }

    // ---- 选集 / 自动连播 ----

    private fun nextEpisode(): Episode? {
        if (episodes.isEmpty()) return null
        val idx = episodes.indexOfFirst { it.id == episodeId }
        return episodes.getOrNull(idx + 1)
    }

    /** 播放器内直接切集（重新解析播放地址，不退出播放页） */
    private fun playEpisodeDirect(ep: Episode) {
        playerScope.launch {
            try {
                val site = withContext(Dispatchers.IO) {
                    ConfigLoader.last(this@PlayerActivity)?.sites?.getOrNull(siteIndex)
                } ?: throw IllegalStateException("订阅配置不可用")
                val map = withContext(Dispatchers.IO) {
                    SpiderManager.get(site).playerContent(flag, ep.id, listOf(flag))
                }
                @Suppress("UNCHECKED_CAST")
                val hs = (map["header"] as? String)?.let { raw ->
                    runCatching {
                        gson.fromJson<Map<String, String>>(raw, Map::class.java)
                    }.getOrNull()
                }
                if (!hs.isNullOrEmpty()) headers = hs
                val url = (map["url"] as? String).orEmpty()
                val playUrl = (map["playUrl"] as? String).orEmpty()
                val target = url.takeIf { it.startsWith("http") || it.startsWith("rtmp") || it.startsWith("rtsp") }
                    ?: playUrl.takeIf { it.startsWith("http") }
                if (target.isNullOrBlank()) throw IllegalStateException("获取播放地址失败，请换线路")
                episodeId = ep.id
                episodeName = ep.name
                finalUrl = target
                pendingSeekMs = 0L
                currentEngine?.play(finalUrl, headers)
                titleText = "$vodName·${ep.name}"
                titleView?.text = "$titleText · ${coreName(currentType)}"
                saveHistory(finished = false)
            } catch (e: Throwable) {
                Toast.makeText(this@PlayerActivity, "切集失败：${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // ---- 播放历史 ----

    private fun saveHistory(finished: Boolean) {
        if (vodId.isBlank()) return
        val pos = if (finished) (currentEngine?.getDuration() ?: 0L) else (currentEngine?.getCurrentPosition() ?: 0L)
        val dur = currentEngine?.getDuration() ?: 0L
        HistoryStore.record(
            this,
            HistoryItem(
                siteIndex = siteIndex, vodId = vodId, vodName = vodName, vodPic = vodPic,
                flag = flag, episodeId = episodeId, episodeName = episodeName,
                position = pos, duration = dur, updatedAt = System.currentTimeMillis(),
            )
        )
    }

    override fun onPause() {
        // 长按倍速兜底：任何路径漏掉恢复都不允许把 3x 带入后台
        if (boosting) {
            boosting = false
            currentEngine?.setSpeed(savedSpeed)
        }
        saveHistory(finished = false)
        super.onPause()
    }

    // ---- PlayerListener ----

    override fun onPrepared() {
        if (pendingSeekMs > 0L) {
            currentEngine?.seekTo(pendingSeekMs)
            runOnUiThread {
                Toast.makeText(this, "已从 ${formatTime(pendingSeekMs)} 续播", Toast.LENGTH_SHORT).show()
            }
            pendingSeekMs = 0L
        }
    }

    override fun onCompletion() {
        saveHistory(finished = true)
        val next = nextEpisode()
        if (next != null) {
            runOnUiThread {
                Toast.makeText(this, "自动播放：${next.name}", Toast.LENGTH_SHORT).show()
            }
            playEpisodeDirect(next)
        } else {
            runOnUiThread { finish() }
        }
    }

    override fun onError(msg: String) {
        // mpv 初始化/播放失败：自动回退 Exo，避免黑屏或闪退
        if (currentEngine is MpvPlayerEngine && !fallbackUsed) {
            fallbackUsed = true
            runOnUiThread {
                Toast.makeText(this, "mpv 内核不可用，已回退 ExoPlayer", Toast.LENGTH_SHORT).show()
            }
            startEngine(PlayerCoreType.EXO)
            return
        }
        // AUTO 模式下，Exo 失败自动切 mpv 重试一次
        if (currentType == PlayerCoreType.AUTO && !fallbackUsed && currentEngine is ExoPlayerEngine) {
            fallbackUsed = true
            startEngine(PlayerCoreType.MPV)
        }
    }

    override fun onDestroy() {
        playerScope.cancel()
        currentEngine?.release()
        currentEngine = null
        super.onDestroy()
    }
}

/**
 * 手势层：仿主流视频 APP 播控手势。
 * - 单击放行给子视图（PlayerView 控制器自行显隐）
 * - 横/竖滑动超过 touchSlop 后拦截：竖滑分左右半屏（亮度/音量），横滑快进快退
 * - 底部 25% 区域留给播放控制条（进度条拖动），不启手势
 * - 按住 600ms 不动 = 长按倍速
 */
class GestureLayout(context: Context) : FrameLayout(context) {

    companion object {
        const val MODE_VERTICAL = 1
        const val MODE_HORIZONTAL = 2
        const val LONG_PRESS_MS = 600L
    }

    var onGestureStart: ((mode: Int) -> Unit)? = null
    var onVerticalScroll: ((side: Int, dyPercent: Float) -> Unit)? = null
    var onHorizontalScroll: ((dxPercent: Float) -> Unit)? = null
    var onGestureEnd: ((mode: Int) -> Unit)? = null
    var onSingleTap: (() -> Unit)? = null
    /** 锁定状态：屏蔽全部手势（解锁由浮层按钮触发） */
    var locked = false
    var onSingleTap: (() -> Unit)? = null
    var onLongPressStart: (() -> Unit)? = null
    var onLongPressEnd: (() -> Unit)? = null

    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
    private var downX = 0f
    private var downY = 0f
    private var lastX = 0f
    private var lastY = 0f
    private var mode = 0
    private var longPressFired = false
    private val longPressRunnable = Runnable {
        if (mode == 0 && !longPressFired) {
            longPressFired = true
            onLongPressStart?.invoke()
        }
    }

    private fun initDown(ev: MotionEvent) {
        downX = ev.x; downY = ev.y; lastX = ev.x; lastY = ev.y
        mode = 0
        longPressFired = false
        if (locked) {
            // 锁定：不启动长按计时
            return
        }
        postDelayed(longPressRunnable, LONG_PRESS_MS)
    }

    private fun decideMode(ev: MotionEvent): Boolean {
        if (mode != 0) return true
        val dx = ev.x - downX
        val dy = ev.y - downY
        if (abs(dx) > touchSlop && abs(dx) >= abs(dy)) {
            mode = MODE_HORIZONTAL
            removeCallbacks(longPressRunnable)
            onGestureStart?.invoke(mode)
            return true
        }
        if (abs(dy) > touchSlop && abs(dy) > abs(dx)) {
            mode = MODE_VERTICAL
            removeCallbacks(longPressRunnable)
            onGestureStart?.invoke(mode)
            return true
        }
        return false
    }

    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> initDown(ev)
            MotionEvent.ACTION_MOVE -> {
                // 底部 25% 留给控制条
                if (downY < height * 0.75f && decideMode(ev)) return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                removeCallbacks(longPressRunnable)
                // 长按倍速的收尾必须放在拦截路径里：boost 后手指滑动会使本布局
                // 拦截事件流，此刻 UP/CANCEL 只会经过这里而不再进入 onTouchEvent，
                // 不补 onLongPressEnd 会导致恢复不了原速（一直卡 3x）
                if (longPressFired) {
                    longPressFired = false
                    onLongPressEnd?.invoke()
                }
                if (mode != 0) {
                    onGestureEnd?.invoke(mode)
                    mode = 0
                }
            }
        }
        return false
    }

    override fun onTouchEvent(ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                removeCallbacks(longPressRunnable)
                initDown(ev)
            }
            MotionEvent.ACTION_MOVE -> {
                if (locked || !decideMode(ev)) {
                    lastX = ev.x; lastY = ev.y
                    return true
                }
                if (mode == MODE_VERTICAL) {
                    val dy = lastY - ev.y
                    onVerticalScroll?.invoke(
                        if (downX < width / 2f) 0 else 1,
                        dy / height.coerceAtLeast(1)
                    )
                } else if (mode == MODE_HORIZONTAL) {
                    val dx = ev.x - lastX
                    onHorizontalScroll?.invoke(dx / width.coerceAtLeast(1))
                }
                lastX = ev.x; lastY = ev.y
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                removeCallbacks(longPressRunnable)
                if (longPressFired) {
                    longPressFired = false
                    onLongPressEnd?.invoke()
                } else if (mode == 0 && ev.actionMasked == MotionEvent.ACTION_UP) {
                    onSingleTap?.invoke()
                }
                if (mode != 0) {
                    onGestureEnd?.invoke(mode)
                    mode = 0
                }
            }
        }
        return true
    }
}
