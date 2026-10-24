package com.tvbox.yunying.player.mpv

import android.content.Context
import android.graphics.SurfaceTexture
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Surface
import android.view.TextureView
import com.tvbox.yunying.player.PlayerEngine
import com.tvbox.yunying.player.PlayerListener
import is.xyz.mpv.MPVLib
import is.xyz.mpv.MPVView

/**
 * mpv 播放器内核封装。
 * 使用 is.xyz.mpv:libmpv 预编译库（基于 mpv-android 的 libmpv AAR）。
 * 支持几乎所有格式/编码，软解硬解自适应，适合作为"兼容性兜底"内核。
 */
class MpvPlayerEngine(private val context: Context) : PlayerEngine, MPVLib.EventObserver {

    companion object {
        private const val TAG = "MpvPlayerEngine"
    }

    private var mpvView: MPVView? = null
    private var textureView: TextureView? = null
    private var surface: Surface? = null
    private var _listener: PlayerListener? = null
    private val handler = Handler(Looper.getMainLooper())
    private var prepared = false
    private var currentUrl: String? = null
    private var currentHeaders: Map<String, String> = emptyMap()

    override fun init(listener: PlayerListener) {
        this._listener = listener
        try {
            MPVLib.create(context)
            MPVLib.setOptionString("vo", "gpu")
            MPVLib.setOptionString("gpu-context", "android")
            MPVLib.setOptionString("hwdec", "mediacodec-copy") // 优先硬解，回退软解
            MPVLib.setOptionString("force-window", "no")
            MPVLib.setOptionString("config", "no")
            MPVLib.setOptionString("terminal", "no")
            MPVLib.setOptionString("cache", "yes")
            MPVLib.setOptionString("cache-secs", "10")
            MPVLib.setOptionString("demuxer-max-bytes", "100MiB")
            MPVLib.setOptionString("ytdl", "no")
            MPVLib.addObserver(this)
            MPVLib.init()
            Log.i(TAG, "mpv 内核初始化成功 (${MPVLib.getPropertyString("mpv-version")})")
        } catch (e: Throwable) {
            Log.e(TAG, "mpv 初始化失败", e)
            _listener?.onError("mpv 内核初始化失败: ${e.message}")
        }
    }

    override fun attachSurface(textureView: TextureView) {
        this.textureView = textureView
        if (textureView.isAvailable) {
            setupSurface(textureView.surfaceTexture)
        } else {
            textureView.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                override fun onSurfaceTextureAvailable(surfaceTexture: SurfaceTexture, w: Int, h: Int) {
                    setupSurface(surfaceTexture)
                }
                override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) {
                    MPVLib.setPropertyString("android-surface-size", "${w}x$h")
                }
                override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
                    releaseSurface()
                    return true
                }
                override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
            }
        }
    }

    private fun setupSurface(st: SurfaceTexture) {
        surface = Surface(st)
        MPVLib.attachSurface(surface)
        MPVLib.setPropertyString("android-surface-size", "${st.getDefaultBufferSize()}")
        Log.d(TAG, "Surface 已附着到 mpv")
    }

    private fun releaseSurface() {
        surface?.let { MPVLib.detachSurface(); it.release() }
        surface = null
    }

    override fun play(url: String, headers: Map<String, String>) {
        this.currentUrl = url
        this.currentHeaders = headers
        this.prepared = false

        // 通过 user-agent / referer / cookies 选项传 headers
        headers["User-Agent"]?.let { MPVLib.setOptionString("user-agent", it) }
        headers["Referer"]?.let { MPVLib.setOptionString("referrer", it) }
        headers["Cookie"]?.let { MPVLib.setOptionString("cookies", it) }

        MPVLib.command(arrayOf("loadfile", url))
        MPVLib.setPropertyBoolean("pause", false)
        Log.i(TAG, "mpv 开始播放: $url")
    }

    override fun play() {
        MPVLib.setPropertyBoolean("pause", false)
    }

    override fun pause() {
        MPVLib.setPropertyBoolean("pause", true)
    }

    override fun seekTo(positionMs: Long) {
        val seconds = positionMs / 1000.0
        MPVLib.command(arrayOf("seek", seconds.toString(), "absolute"))
    }

    override fun release() {
        try {
            MPVLib.removeObserver(this)
            releaseSurface()
            MPVLib.command(arrayOf("stop"))
            MPVLib.destroy()
        } catch (e: Throwable) {
            Log.e(TAG, "mpv release 异常", e)
        }
        mpvView = null
        textureView = null
    }

    override fun isPlaying(): Boolean {
        return try { !MPVLib.getPropertyBoolean("pause") } catch (_: Throwable) { false }
    }

    override fun getCurrentPosition(): Long {
        return try { (MPVLib.getPropertyDouble("time-pos") * 1000).toLong() } catch (_: Throwable) { 0L }
    }

    override fun getDuration(): Long {
        return try { (MPVLib.getPropertyDouble("duration") * 1000).toLong() } catch (_: Throwable) { 0L }
    }

    // --------- MPV Event 回调 ---------
    override fun eventProperty(property: String?) {}

    override fun eventProperty(property: String?, value: Long) {}

    override fun eventProperty(property: String?, value: Boolean) {}

    override fun eventProperty(property: String?, value: String?) {}

    override fun event(eventId: Int) {
        when (eventId) {
            MPVLib.MPV_EVENT_FILE_LOADED -> {
                prepared = true
                handler.post {
                    _listener?.onPrepared()
                }
            }
            MPVLib.MPV_EVENT_END_FILE -> {
                handler.post { _listener?.onCompletion() }
            }
            MPVLib.MPV_EVENT_SEEK -> {
                // seek 完成
            }
            MPVLib.MPV_EVENT_ERROR -> {
                handler.post { _listener?.onError("mpv 播放错误") }
            }
        }
    }
}
