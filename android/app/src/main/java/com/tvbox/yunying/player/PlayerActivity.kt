package com.tvbox.yunying.player

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.media.AudioManager
import android.os.Bundle
import android.util.Log
import android.view.*
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.ImageButton
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
            useController = true
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

        buildTopBar()
        buildOverlay()
        setContentView(playerContainer)
        setupGestures()

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

    /** 顶栏：返回 + 标题 + 选集 + ⋯（腾讯视频式） */
    private fun buildTopBar() {
        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(12, 20, 12, 20)
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP
            )
        }
        val backBtn = ImageButton(this).apply {
            setImageResource(android.R.drawable.ic_menu_revert)
            setBackgroundColor(Color.TRANSPARENT)
            setOnClickListener { finish() }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        titleView = TextView(this).apply {
            text = titleText
            setTextColor(Color.WHITE)
            textSize = 16f
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            setPadding(16, 0, 16, 0)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        val epBtn = TextView(this).apply {
            text = "选集"
            setTextColor(Color.WHITE)
            textSize = 14f
            setPadding(20, 8, 20, 8)
            setOnClickListener { showEpisodeDialog() }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        val menuBtn = ImageButton(this).apply {
            setImageResource(android.R.drawable.ic_menu_more)
            setBackgroundColor(Color.TRANSPARENT)
            setOnClickListener { showPlayerMenu(it) }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        topBar.addView(backBtn)
        topBar.addView(titleView)
        topBar.addView(epBtn)
        topBar.addView(menuBtn)
        playerContainer.addView(topBar)
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
            if (currentEngine is ExoPlayerEngine) {
                boosting = true
                savedSpeed = currentSpeed
                currentEngine.setSpeed(BOOST_SPEED)
                showOverlay("⚡ ${BOOST_SPEED}倍速快进中", null)
            } else {
                boosting = false
                showOverlay("当前内核不支持长按倍速", null)
            }
        }
        playerContainer.onLongPressEnd = {
            if (boosting) {
                boosting = false
                currentEngine?.setSpeed(savedSpeed)
                hideOverlayDelayed()
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
    }

    var onGestureStart: ((mode: Int) -> Unit)? = null
    var onVerticalScroll: ((side: Int, dyPercent: Float) -> Unit)? = null
    var onHorizontalScroll: ((dxPercent: Float) -> Unit)? = null
    var onGestureEnd: ((mode: Int) -> Unit)? = null
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
        postDelayed(longPressRunnable, 600L)
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
                decideMode(ev)
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
