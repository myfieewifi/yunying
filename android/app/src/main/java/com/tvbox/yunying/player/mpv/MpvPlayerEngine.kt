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
import java.lang.reflect.InvocationHandler
import java.lang.reflect.Method
import java.lang.reflect.Proxy

/**
 * mpv 播放器内核封装（纯反射实现）。
 *
 * libmpv（is.xyz.mpv:libmpv）并非稳定的 Maven 坐标，mpv-android 官方 Release 只发布 APK；
 * 为让 APK 在无 libmpv AAR 时也能编译/打包，这里全部通过反射调用 MPVLib：
 *   - APK 另行内置 libmpv.so + MPVLib 类时（例如后续接入官方 AAR），功能完整可用；
 *   - 未内置时 init() 会失败并触发 onError，不崩溃，播放自动留在 ExoPlayer 内核。
 */
class MpvPlayerEngine(private val context: Context) : PlayerEngine {

    companion object {
        private const val TAG = "MpvPlayerEngine"
        private const val MPV_CLASS = "is.xyz.mpv.MPVLib"
        private const val OBSERVER_CLASS = "is.xyz.mpv.MPVLib\$EventObserver"
    }

    private val handler = Handler(Looper.getMainLooper())
    private var textureView: TextureView? = null
    private var surface: Surface? = null
    private var _listener: PlayerListener? = null
    private var prepared = false

    /** 反射得到 mpv 的 Java API，为 null 表示运行时不存在 libmpv */
    private var mpvCls: Class<*>? = null
    private var mpvMethods: MutableMap<String, Method>? = null

    override fun init(listener: PlayerListener) {
        this._listener = listener
        try {
            @Suppress("UNCHECKED_CAST")
            val cls = Class.forName(MPV_CLASS) as Class<*>
            val methods = HashMap<String, Method>()
            for (m in cls.declaredMethods) {
                val key = m.name + "(" + m.parameterTypes.joinToString(",") { it.simpleName } + ")"
                methods[key] = m
            }
            mpvCls = cls
            mpvMethods = methods

            invoke("create", context)
            invoke("setOptionString", "vo", "gpu")
            invoke("setOptionString", "gpu-context", "android")
            invoke("setOptionString", "hwdec", "mediacodec-copy") // 优先硬解，回退软解
            invoke("setOptionString", "force-window", "no")
            invoke("setOptionString", "config", "no")
            invoke("setOptionString", "terminal", "no")
            invoke("setOptionString", "cache", "yes")
            invoke("setOptionString", "cache-secs", "10")
            invoke("setOptionString", "demuxer-max-bytes", "100MiB")
            invoke("setOptionString", "ytdl", "no")

            // 注册事件回调（MPVLib.EventObserver 通过动态代理实现）
            try {
                val observerCls = Class.forName(OBSERVER_CLASS)
                val loader = observerCls.classLoader
                val observer = Proxy.newProxyInstance(
                    loader,
                    arrayOf(observerCls),
                    object : InvocationHandler {
                        override fun invoke(proxy: Any, method: Method, args: Array<out Any?>?): Any? {
                            handleMpvEvent(method.name, args)
                            return null
                        }
                    }
                )
                invoke("addObserver", observer)
            } catch (e: Throwable) {
                Log.w(TAG, "EventObserver 注册失败（事件回调不可用）", e)
            }

            invoke("init")
            val version = try {
                invoke("getPropertyString", "mpv-version")?.toString() ?: "unknown"
            } catch (_: Throwable) { "unknown" }
            Log.i(TAG, "mpv 内核初始化成功 ($version)")
        } catch (e: Throwable) {
            // 常见于：APK 未内置 libmpv.so（UnsatisfiedLinkError）或类不存在（ClassNotFoundException）
            mpvCls = null
            mpv_methods_cleanup()
            Log.e(TAG, "mpv 初始化失败（将回退 ExoPlayer）", e)
            _listener?.onError("mpv 内核不可用: ${e.message}")
        }
    }

    private fun mpv_methods_cleanup() { mpvMethods = null }

    /** 处理来自动态代理的 mpv 事件回调 */
    private fun handleMpvEvent(methodName: String, args: Array<out Any?>?) {
        when (methodName) {
            "eventProperty" -> Unit // 属性变化，忽略
            "event", "eventCommand" -> {
                val eventId = (args?.firstOrNull() as? Int) ?: -1
                handleEventId(eventId)
            }
        }
    }

    private fun handleEventId(eventId: Int) {
        // mpv-android 的常量：FILE_LOADED=2, END_FILE=8, SEEK=20, ERROR=9（以反射常量为准，缺省用数值）
        val cls = mpvCls
        val fileLoaded = constInt(cls, "MPV_EVENT_FILE_LOADED", 2)
        val endFile = constInt(cls, "MPV_EVENT_END_FILE", 8)
        val error = constInt(cls, "MPV_EVENT_ERROR", 9)
        when (eventId) {
            fileLoaded -> {
                prepared = true
                handler.post { _listener?.onPrepared() }
            }
            endFile -> handler.post { _listener?.onCompletion() }
            error -> handler.post { _listener?.onError("mpv 播放错误") }
            else -> Unit
        }
    }

    private fun constInt(cls: Class<*>?, name: String, fallback: Int): Int {
        return try {
            (cls?.getField(name)?.get(null) as? Int) ?: fallback
        } catch (_: Throwable) { fallback }
    }

    /** 反射执行 MPVLib 静态方法；未初始化或调用失败抛 Throwable 由调用方处理 */
    private fun invoke(method: String, vararg args: Any?): Any? {
        val methods = mpvMethods ?: throw IllegalStateException("MPVLib not available")
        val sig = method + "(" + args.joinToString(",") { it?.javaClass?.simpleName ?: "null" } + ")"
        // 精确签名未命中时做宽松匹配（基本类型/包装类型差异）
        val m = methods[sig] ?: methods.entries.firstOrNull { (k, _) -> k.startsWith("$method(") }?.value
            ?: throw NoSuchMethodException("MPVLib.$method")
        return m.invoke(null, *args)
    }

    private fun ensureMpv(): Class<*> {
        return mpvCls ?: throw IllegalStateException("mpv 不可用（缺少 libmpv 运行库）")
    }

    override fun attachSurface(textureView: TextureView) {
        this.textureView = textureView
        if (textureView.isAvailable) {
            setupSurface(textureView.surfaceTexture ?: return)
        } else {
            textureView.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                override fun onSurfaceTextureAvailable(surfaceTexture: SurfaceTexture, w: Int, h: Int) {
                    setupSurface(surfaceTexture)
                }
                override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) {
                    try { invoke("setPropertyString", "android-surface-size", "${w}x$h") } catch (_: Throwable) {}
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
        try {
            invoke("attachSurface", surface)
            invoke("setPropertyString", "android-surface-size", "${st.defaultBufferSize}x${st.defaultBufferSize}")
        } catch (e: Throwable) {
            Log.e(TAG, "attachSurface 失败", e)
        }
        Log.d(TAG, "Surface 已附着到 mpv")
    }

    private fun releaseSurface() {
        surface?.let {
            try { invoke("detachSurface") } catch (_: Throwable) {}
            it.release()
        }
        surface = null
    }

    override fun play(url: String, headers: Map<String, String>) {
        ensureMpv()
        prepared = false
        headers["User-Agent"]?.let { try { invoke("setOptionString", "user-agent", it) } catch (_: Throwable) {} }
        headers["Referer"]?.let { try { invoke("setOptionString", "referrer", it) } catch (_: Throwable) {} }
        headers["Cookie"]?.let { try { invoke("setOptionString", "cookies", it) } catch (_: Throwable) {} }
        invoke("command", arrayOf("loadfile", url))
        try { invoke("setPropertyBoolean", "pause", false) } catch (_: Throwable) {}
        Log.i(TAG, "mpv 开始播放: $url")
    }

    override fun play() { try { invoke("setPropertyBoolean", "pause", false) } catch (_: Throwable) {} }
    override fun pause() { try { invoke("setPropertyBoolean", "pause", true) } catch (_: Throwable) {} }

    override fun seekTo(positionMs: Long) {
        try { invoke("command", arrayOf("seek", (positionMs / 1000.0).toString(), "absolute")) } catch (_: Throwable) {}
    }

    override fun release() {
        try {
            releaseSurface()
            invoke("command", arrayOf("stop"))
            invoke("destroy")
        } catch (_: Throwable) {
        }
        mpvCls = null
        mpvMethods = null
        textureView = null
    }

    override fun isPlaying(): Boolean {
        return try { !(invoke("getPropertyBoolean", "pause") as Boolean) } catch (_: Throwable) { false }
    }

    override fun getCurrentPosition(): Long {
        return try { ((invoke("getPropertyDouble", "time-pos") as Double) * 1000).toLong() } catch (_: Throwable) { 0L }
    }

    override fun getDuration(): Long {
        return try { ((invoke("getPropertyDouble", "duration") as Double) * 1000).toLong() } catch (_: Throwable) { 0L }
    }
}
