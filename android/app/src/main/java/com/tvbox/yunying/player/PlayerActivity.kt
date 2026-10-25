package com.tvbox.yunying.player

import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.view.*
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.PopupMenu
import androidx.media3.ui.PlayerView
import com.tvbox.yunying.R
import com.tvbox.yunying.player.mpv.ExoPlayerEngine
import com.tvbox.yunying.player.mpv.MpvPlayerEngine

/**
 * 播放器 Activity：支持 ExoPlayer（默认）与 mpv（全能内核）双内核切换。
 *
 * 仿腾讯视频播放器交互：
 * - 顶栏：返回（左）+ 标题（中）+ ⋯ 菜单（右）
 * - ⋯ 菜单：倍速（0.5~3.0）/ 切换内核（Exo/mpv/Auto）/ 刷新重试
 * - 底部控制条沿用 ExoPlayer 控制器（进度条/暂停/进度时间）
 * - 启动时读取 SharedPreferences 中 yunying_player_core 配置（exo/mpv/auto），默认 AUTO。
 * - AUTO 模式下 ExoPlayer 播放失败自动切 mpv 重试一次。
 */
class PlayerActivity : AppCompatActivity(), PlayerEngine.PlayerListener {

    companion object {
        const val EXTRA_URL = "url"
        const val EXTRA_PLAY_URL = "playUrl"
        const val EXTRA_TITLE = "title"
        const val EXTRA_HEADERS = "headers"
        const val PREF_CORE = "yunying_player_core"

        private val SPEEDS = floatArrayOf(0.5f, 0.75f, 1.0f, 1.25f, 1.5f, 2.0f, 3.0f)
    }

    private lateinit var playerContainer: FrameLayout
    private lateinit var playerView: PlayerView
    private var textureViewForMpv: android.view.TextureView? = null
    private var currentEngine: PlayerEngine? = null
    private var currentType: PlayerCoreType = PlayerCoreType.AUTO
    private var finalUrl: String = ""
    private var headers: Map<String, String> = emptyMap()
    private var titleText: String = ""
    private var fallbackUsed = false
    private var titleView: TextView? = null
    private var currentSpeed: Float = 1.0f

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

        // 根容器
        playerContainer = FrameLayout(this).apply {
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

        // 顶栏：返回 + 标题 + ⋯（腾讯视频式）
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
        topBar.addView(menuBtn)
        playerContainer.addView(topBar)

        setContentView(playerContainer)

        // 读取内核选择并启动
        val saved = getSharedPreferences("yunying", Context.MODE_PRIVATE)
            .getString(PREF_CORE, "auto")
        currentType = when (saved) {
            "exo" -> PlayerCoreType.EXO
            "mpv" -> PlayerCoreType.MPV
            else -> PlayerCoreType.AUTO
        }
        startEngine(currentType)
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

        val engine = when (type) {
            PlayerCoreType.MPV -> MpvPlayerEngine(this)
            else -> ExoPlayerEngine(this)
        }

        currentEngine = engine
        engine.init(this)

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

        engine.play(finalUrl, headers)
        engine.setSpeed(currentSpeed)
        titleView?.text = "$titleText · ${coreName(type)}"
    }

    private fun switchCore() {
        val next = when (currentType) {
            PlayerCoreType.EXO -> PlayerCoreType.MPV
            PlayerCoreType.MPV -> PlayerCoreType.AUTO
            PlayerCoreType.AUTO -> PlayerCoreType.EXO
        }
        currentType = next
        getSharedPreferences("yunying", Context.MODE_PRIVATE).edit()
            .putString(PREF_CORE, next.name.lowercase()).apply()
        startEngine(next)
    }

    // ---- PlayerListener ----
    override fun onPrepared() {}
    override fun onCompletion() { finish() }
    override fun onError(msg: String) {
        // AUTO 模式下，Exo 失败自动切 mpv 重试一次
        if (currentType == PlayerCoreType.AUTO && !fallbackUsed && currentEngine is ExoPlayerEngine) {
            fallbackUsed = true
            startEngine(PlayerCoreType.MPV)
        }
    }

    override fun onDestroy() {
        currentEngine?.release()
        currentEngine = null
        super.onDestroy()
    }
}
