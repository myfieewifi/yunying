package com.tvbox.yunying.player

import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.view.*
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.ui.PlayerView
import com.tvbox.yunying.R
import com.tvbox.yunying.player.mpv.ExoPlayerEngine
import com.tvbox.yunying.player.mpv.MpvPlayerEngine

/**
 * 播放器 Activity：支持 ExoPlayer（默认）与 mpv（全能内核）双内核切换。
 *
 * - 启动时读取 SharedPreferences 中 yunying_player_core 配置（exo/mpv/auto），默认 AUTO。
 * - AUTO 模式下 ExoPlayer 播放失败自动切 mpv 重试一次。
 * - 右上角提供内核切换按钮，点击后实时切换。
 */
class PlayerActivity : AppCompatActivity(), PlayerEngine.PlayerListener {

    companion object {
        const val EXTRA_URL = "url"
        const val EXTRA_PLAY_URL = "playUrl"
        const val EXTRA_TITLE = "title"
        const val PREF_CORE = "yunying_player_core"
    }

    private lateinit var playerContainer: FrameLayout
    private lateinit var playerView: PlayerView
    private var textureViewForMpv: android.view.TextureView? = null
    private var currentEngine: PlayerEngine? = null
    private var currentType: PlayerCoreType = PlayerCoreType.AUTO
    private var finalUrl: String = ""
    private var fallbackUsed = false
    private var coreSwitchBtn: ImageButton? = null
    private var coreLabel: TextView? = null

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

        // 右上角内核切换按钮+标签
        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
            setPadding(24, 24, 24, 24)
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP
            )
        }
        coreLabel = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 14f
            setPadding(16, 8, 16, 8)
            setBackgroundColor(Color.parseColor("#88000000"))
        }
        coreSwitchBtn = ImageButton(this).apply {
            setImageResource(android.R.drawable.ic_media_play)
            setBackgroundColor(Color.TRANSPARENT)
            setOnClickListener { switchCore() }
        }
        topBar.addView(coreLabel)
        topBar.addView(coreSwitchBtn)
        playerContainer.addView(topBar)

        // 返回按钮
        val backBtn = ImageButton(this).apply {
            setImageResource(android.R.drawable.ic_menu_close_clear_cancel)
            setBackgroundColor(Color.TRANSPARENT)
            setOnClickListener { finish() }
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP or Gravity.START
            ).apply { setMargins(24, 24, 0, 0) }
        }
        playerContainer.addView(backBtn)

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

        updateCoreLabel(type)
        engine.play(finalUrl)
    }

    private fun updateCoreLabel(type: PlayerCoreType) {
        val name = when (type) {
            PlayerCoreType.EXO -> "ExoPlayer"
            PlayerCoreType.MPV -> "mpv"
            PlayerCoreType.AUTO -> "Auto (Exo→mpv)"
        }
        coreLabel?.text = "内核: $name"
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
