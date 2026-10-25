package com.tvbox.yunying.player.mpv

import android.content.Context
import android.net.Uri
import android.view.TextureView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.common.util.Util
import androidx.media3.ui.PlayerView
import android.os.Handler
import android.os.Looper
import com.tvbox.yunying.player.PlayerEngine
import com.tvbox.yunying.player.PlayerEngine.PlayerListener

/**
 * ExoPlayer 内核封装（默认内核，省电/流畅/HLS 原生支持）。
 */
class ExoPlayerEngine(private val context: Context) : PlayerEngine {

    private var exoPlayer: ExoPlayer? = null
    private var listener: PlayerListener? = null
    private var playerView: PlayerView? = null
    private val handler = Handler(Looper.getMainLooper())
    private var progressRunnable: Runnable? = null
    private var _duration: Long = 0L

    override fun init(listener: PlayerListener) {
        this.listener = listener
        exoPlayer = ExoPlayer.Builder(context).build().apply {
            addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(state: Int) {
                    when (state) {
                        Player.STATE_READY -> {
                            _duration = duration
                            listener.onPrepared()
                        }
                        Player.STATE_ENDED -> listener.onCompletion()
                        Player.STATE_BUFFERING -> listener.onBuffering(true)
                        Player.STATE_IDLE -> listener.onBuffering(false)
                    }
                }
                override fun onIsPlayingChanged(isPlaying: Boolean) {
                    if (isPlaying) listener.onBuffering(false)
                }
                override fun onPlayerError(error: PlaybackException) {
                    listener.onError(error.message ?: "ExoPlayer 播放错误")
                }
                override fun onVideoSizeChanged(videoSize: VideoSize) {
                    listener.onVideoSizeChanged(videoSize.width, videoSize.height)
                }
            })
        }
        playerView?.player = exoPlayer
    }

    fun attachPlayerView(view: PlayerView) {
        this.playerView = view
        view.player = exoPlayer
    }

    override fun attachSurface(textureView: TextureView) {
        // ExoPlayer 通过 PlayerView/SurfaceView 渲染，此方法仅用于兼容接口，
        // 实际使用 attachPlayerView(PlayerView)。
    }

    override fun play(url: String, headers: Map<String, String>) {
        val player = exoPlayer ?: return
        val dataSourceFactory = DefaultHttpDataSource.Factory().apply {
            setDefaultRequestProperties(headers)
            setUserAgent(headers["User-Agent"] ?: "YunYing/1.0")
        }
        val uri = Uri.parse(url)
        val mediaSource = when {
            Util.inferContentType(uri) == androidx.media3.common.C.CONTENT_TYPE_HLS ->
                HlsMediaSource.Factory(dataSourceFactory).createMediaSource(MediaItem.fromUri(uri))
            else ->
                ProgressiveMediaSource.Factory(dataSourceFactory).createMediaSource(MediaItem.fromUri(uri))
        }
        player.setMediaSource(mediaSource)
        player.prepare()
        player.playWhenReady = true
    }

    override fun play() { exoPlayer?.playWhenReady = true }
    override fun pause() { exoPlayer?.playWhenReady = false }

    override fun setSpeed(speed: Float) {
        exoPlayer?.setPlaybackSpeed(speed)
    }

    override fun seekTo(positionMs: Long) {
        exoPlayer?.seekTo(positionMs)
    }

    override fun release() {
        progressRunnable?.let { handler.removeCallbacks(it) }
        exoPlayer?.release()
        exoPlayer = null
    }

    override fun isPlaying(): Boolean = exoPlayer?.isPlaying ?: false
    override fun getCurrentPosition(): Long = exoPlayer?.currentPosition ?: 0L
    override fun getDuration(): Long = exoPlayer?.duration?.takeIf { it > 0 } ?: _duration
}
