package com.tvbox.yunying.player

import android.content.Context
import com.tvbox.yunying.player.mpv.ExoPlayerEngine
import com.tvbox.yunying.player.mpv.MpvPlayerEngine

/**
 * 播放器内核类型。
 * - EXO: 默认，ExoPlayer（Media3），省电、HLS 原生、常用源友好
 * - MPV: mpv 内核（libmpv），全能兜底，几乎支持所有视频/音频编码与容器
 * - AUTO: 播放失败时自动从 EXO 切换到 MPV 重试
 */
enum class PlayerCoreType { EXO, MPV, AUTO }

object PlayerFactory {
    fun create(context: Context, type: PlayerCoreType): PlayerEngine {
        return when (type) {
            PlayerCoreType.MPV -> MpvPlayerEngine(context.applicationContext)
            PlayerCoreType.EXO -> ExoPlayerEngine(context.applicationContext)
            PlayerCoreType.AUTO -> ExoPlayerEngine(context.applicationContext)
        }
    }
}
