package com.tvbox.yunying.player.mpv

import android.content.Context
import android.graphics.SurfaceTexture
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Surface
import android.view.TextureView
import com.tvbox.yunying.player.PlayerEngine
import com.tvbox.yunying.player.PlayerEngine.PlayerListener
import `is`.xyz.mpv.MPV
import `is`.xyz.mpv.MPVNode

/**
 * mpv 播放器内核封装（直调 mpv-android-lib AAR：io.github.abdallahmehiz:mpv-android-lib）。
 *
 * AAR 由 CI 的 android/scripts/download-mpv.sh 从 Maven Central 下载到 app/libs/
 * （含 libmpv.so + libplayer.so JNI 桥 + ffmpeg，全 ABI），随 APK 打包内置。
 * 本地无 AAR 时编译会失败——此时可临时注释 build.gradle.kts 的 fileTree 依赖。
 *
 * 0.1.12 API：MPV() 无参构造（类加载静态块即 loadLibrary("mpv")+("player")），
 * 初始化序列 create(context) → setOptionString(...) → init()；
 * so 缺失时构造/类加载抛 UnsatisfiedLinkError → init() 捕获并触发 onError，
 * PlayerActivity 自动回退 ExoPlayer，绝不闪退。
 */
class MpvPlayerEngine(private val context: Context) : PlayerEngine {

    companion object {
        private const val TAG = "MpvPlayerEngine"

        /** 运行时检测 mpv 原生库是否可加载（与 MPV 类 init 块的加载序列一致） */
        fun isAvailable(): Boolean = try {
            System.loadLibrary("mpv")
            System.loadLibrary("player")
            true
        } catch (_: Throwable) {
            false
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var textureView: TextureView? = null
    private var surface: Surface? = null
    private var _listener: PlayerListener? = null
    private var prepared = false
    private var mpv: MPV? = null

    private val eventObserver = object : MPV.EventObserver {
        override fun event(eventId: Int, data: MPVNode) {
            when (eventId) {
                MPV.mpvEvent.MPV_EVENT_FILE_LOADED ->
                    handler.post { prepared = true; _listener?.onPrepared() }
                MPV.mpvEvent.MPV_EVENT_END_FILE ->
                    handler.post { _listener?.onCompletion() }
                MPV.mpvEvent.MPV_EVENT_SHUTDOWN ->
                    handler.post { _listener?.onError("mpv 已关闭") }
            }
        }

        override fun eventProperty(property: String) {}
        override fun eventProperty(property: String, value: Long) {}
        override fun eventProperty(property: String, value: Boolean) {}
        override fun eventProperty(property: String, value: String) {}
        override fun eventProperty(property: String, value: Double) {}
        override fun eventProperty(property: String, value: MPVNode) {}
    }

    override fun init(listener: PlayerListener) {
        this._listener = listener
        try {
            // MPV 类加载时静态块即 loadLibrary("mpv") + loadLibrary("player")，
            // so 缺失时这里直接抛 UnsatisfiedLinkError → 捕获并回退 ExoPlayer
            val m = MPV()
            mpv = m
            // 0.1.12 API：create(context) 建 mpv 句柄 → 选项必须在 init() 前设置
            m.create(context)
            val configDir = java.io.File(context.filesDir, "mpv").apply { mkdirs() }
            val cacheDir = java.io.File(context.cacheDir, "mpv").apply { mkdirs() }
            m.setOptionString("config-dir", configDir.absolutePath)
            m.setOptionString("cache-dir", cacheDir.absolutePath)
            // 优先硬解，回退软解；关闭 ytdl/终端日志；开缓存
            m.setOptionString("hwdec", "mediacodec-copy")
            m.setOptionString("cache", "yes")
            m.setOptionString("cache-secs", "10")
            m.setOptionString("demuxer-max-bytes", "100MiB")
            m.setOptionString("ytdl", "no")
            m.setOptionString("terminal", "no")
            m.init()
            m.addObserver(eventObserver)
            Log.i(TAG, "mpv 内核初始化成功")
        } catch (e: Throwable) {
            // 常见于：APK 未内置 libmpv.so（UnsatisfiedLinkError）
            mpv = null
            Log.e(TAG, "mpv 初始化失败（将回退 ExoPlayer）", e)
            _listener?.onError("mpv 内核不可用: ${e.message}")
        }
    }

    override fun attachSurface(textureView: TextureView) {
        this.textureView = textureView
        if (textureView.isAvailable) {
            setupSurface(textureView.surfaceTexture ?: return, textureView.width, textureView.height)
        } else {
            textureView.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                override fun onSurfaceTextureAvailable(surfaceTexture: SurfaceTexture, w: Int, h: Int) {
                    setupSurface(surfaceTexture, w, h)
                }
                override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) {
                    try { mpv?.setPropertyString("android-surface-size", "${w}x$h") } catch (_: Throwable) {}
                }
                override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
                    releaseSurface()
                    return true
                }
                override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
            }
        }
    }

    private fun setupSurface(st: SurfaceTexture, w: Int, h: Int) {
        surface = Surface(st)
        try {
            mpv?.attachSurface(surface)
            mpv?.setPropertyString("android-surface-size", "${w}x$h")
        } catch (e: Throwable) {
            Log.e(TAG, "attachSurface 失败", e)
        }
        Log.d(TAG, "Surface 已附着到 mpv")
    }

    private fun releaseSurface() {
        surface?.let {
            try { mpv?.detachSurface() } catch (_: Throwable) {}
            it.release()
        }
        surface = null
    }

    override fun play(url: String, headers: Map<String, String>) {
        val m = mpv ?: throw IllegalStateException("mpv 不可用（缺少 libmpv 运行库）")
        prepared = false
        headers["User-Agent"]?.let { try { m.setOptionString("user-agent", it) } catch (_: Throwable) {} }
        // Referer/Cookie 走 http-header-fields（mpv 无独立 cookies 选项）
        val extraHeaders = listOfNotNull(
            headers["Referer"]?.let { "Referer: $it" },
            headers["Cookie"]?.let { "Cookie: $it" },
        ).joinToString(",")
        if (extraHeaders.isNotEmpty()) {
            try { m.command("set", "http-header-fields", extraHeaders) } catch (_: Throwable) {}
        }
        m.command("loadfile", url)
        try { m.setPropertyBoolean("pause", false) } catch (_: Throwable) {}
        Log.i(TAG, "mpv 开始播放: $url")
    }

    override fun play() { try { mpv?.setPropertyBoolean("pause", false) } catch (_: Throwable) {} }
    override fun pause() { try { mpv?.setPropertyBoolean("pause", true) } catch (_: Throwable) {} }

    override fun seekTo(positionMs: Long) {
        try { mpv?.command("seek", (positionMs / 1000.0).toString(), "absolute") } catch (_: Throwable) {}
    }

    override fun setSpeed(speed: Float) {
        try { mpv?.setPropertyDouble("speed", speed.toDouble()) } catch (_: Throwable) {}
    }

    override fun release() {
        try {
            releaseSurface()
            // destroy() = destroySession() + nativeDestroy()
            mpv?.destroy()
        } catch (_: Throwable) {
        }
        mpv = null
        textureView = null
    }

    override fun isPlaying(): Boolean {
        return try { mpv?.getPropertyBoolean("pause")?.let { !it } ?: false } catch (_: Throwable) { false }
    }

    override fun getCurrentPosition(): Long {
        return try { ((mpv?.getPropertyDouble("time-pos") ?: 0.0) * 1000).toLong() } catch (_: Throwable) { 0L }
    }

    override fun getDuration(): Long {
        return try { ((mpv?.getPropertyDouble("duration") ?: 0.0) * 1000).toLong() } catch (_: Throwable) { 0L }
    }
}
