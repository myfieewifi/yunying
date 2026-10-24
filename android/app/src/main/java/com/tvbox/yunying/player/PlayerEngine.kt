package com.tvbox.yunying.player

import android.view.TextureView

/**
 * 统一的播放器内核接口。
 * ExoPlayer（默认，流畅省电）与 mpv（全能兜底，格式全支持）均实现该接口，
 * MainViewModel 通过该接口调用，可运行时切换内核。
 */
interface PlayerEngine {

    interface PlayerListener {
        fun onPrepared() {}
        fun onCompletion() {}
        fun onError(msg: String) {}
        fun onBuffering(buffering: Boolean) {}
        fun onVideoSizeChanged(width: Int, height: Int) {}
    }

    /** 初始化内核，注册监听器 */
    fun init(listener: PlayerListener)

    /** 绑定渲染 Surface（TextureView） */
    fun attachSurface(textureView: TextureView)

    /** 开始播放指定 URL，携带 headers */
    fun play(url: String, headers: Map<String, String> = emptyMap())

    fun play()
    fun pause()
    fun seekTo(positionMs: Long)
    fun release()

    fun isPlaying(): Boolean
    fun getCurrentPosition(): Long
    fun getDuration(): Long
}
