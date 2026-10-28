package com.tvbox.yunying.player

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.util.Log
import android.view.View
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import javax.xml.parsers.SAXParserFactory
import org.xml.sax.Attributes
import org.xml.sax.helpers.DefaultHandler
import kotlin.math.floor

/**
 * 云映弹幕层：真实渲染引擎（Canvas 滚动）。
 * - 数据源：B 站/Common 弹幕 XML（<d p="time,mode,size,color,...">text</d>），
 *   从弹幕 URL 拉取；暂无源时上层提示「暂无弹幕」。
 * - 参数 attach(playerTimeMsProvider)：由播放器每帧喂当前播放位置。
 */
class DanmakuView(context: Context) : View(context) {

    class Danmaku(val timeMs: Long, val text: String, val color: Int, val sizeRatio: Float)

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = Typeface.DEFAULT_BOLD
        textAlign = Paint.Align.LEFT
    }
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 3f
        typeface = Typeface.DEFAULT_BOLD
        textAlign = Paint.Align.LEFT
        color = Color.BLACK
    }

    // 全量弹幕（按时间排序）
    private var danmaku: List<Danmaku> = emptyList()
    // 屏幕上正在滚动的弹幕：track → item+offset
    private data class OnScreen(var y: Int, var x: Float, val text: String, val color: Int, val sizeRatio: Float)
    private val onScreen = mutableListOf<OnScreen>()
    private val occupied = mutableMapOf<Int, Long>()

    private var currentPositionMs = 0L
    private var enabled = false
    private var lastFrameNanos = 0L

    /** 播放引擎时间提供者 */
    var timeProvider: (() -> Long)? = null

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        setLayerType(LAYER_TYPE_HARDWARE, null)
    }

    fun setOn(on: Boolean) {
        enabled = on
        visibility = if (on) VISIBLE else GONE
        if (on) { invalidate(); scheduleFrame() }
    }

    fun isOn(): Boolean = enabled

    fun load(items: List<Danmaku>) {
        danmaku = items.sortedBy { it.timeMs }
        onScreen.clear()
        occupied.clear()
    }

    fun clear() {
        danmaku = emptyList()
        onScreen.clear()
        occupied.clear()
        invalidate()
    }

    fun itemCount(): Int = danmaku.size

    private fun scheduleFrame() {
        postInvalidateOnAnimation()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (!enabled) return
        val now = System.nanoTime()
        val dt = if (lastFrameNanos == 0L) 0L else (now - lastFrameNanos) / 1_000_000L
        lastFrameNanos = now
        val t = timeProvider?.invoke() ?: 0L
        currentPositionMs = t

        val wid = width.coerceAtLeast(1)
        val hei = height.coerceAtLeast(1)
        val rowHeight = (hei / 12).coerceAtLeast(30)
        val speed = wid * dt / 9000f   // 9 秒横向穿屏

        // 入场：取时间窗口内未播的弹幕
        for (d in danmaku) {
            if (d.timeMs in (t - 120)..t) {
                if (onScreen.any { it.text == d.text && it.color == d.color }) continue
                val y = nextFreeRow(rowHeight, hei)
                onScreen.add(OnScreen(y, wid.toFloat(), d.text, d.color, d.sizeRatio))
            }
        }

        onScreen.removeAll { s -> s.x < -paint.measureText(s.text) * s.sizeRatio }

        for (s in onScreen) {
            val base = rowHeight * 0.42f * s.sizeRatio
            paint.textSize = base * (textSizeScale(s))
            paint.color = s.color
            strokePaint.textSize = paint.textSize
            val x = s.x - speed * 1f
            s.x = x
            val y = s.y.toFloat()
            strokePaint.drawText(s.text, x, y, strokePaint)
            canvas.drawText(s.text, x, y, paint)
        }
        if (onScreen.isNotEmpty()) scheduleFrame()
    }

    private fun textSizeScale(s: OnScreen): Float = (0.8f + s.sizeRatio * 0.4f)

    private fun nextFreeRow(rowHeight: Int, hei: Int): Int {
        val rows = (hei / rowHeight).coerceAtLeast(1)
        for (r in 0 until rows) {
            val free = occupied[r] ?: 0L
            if (free <= System.currentTimeMillis()) {
                occupied[r] = System.currentTimeMillis() + 800L
                return (r + 1) * rowHeight
            }
        }
        return rowHeight
    }

    companion object {
        private const val TAG = "DanmakuView"

        /** 从 URL 拉取并解析 B 站格式 XML 弹幕（网络必须在子线程调用） */
        fun fetch(url: String): List<Danmaku> {
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            conn.setRequestProperty("User-Agent", "Mozilla/5.0")
            try {
                if (conn.responseCode !in 200..299) {
                    Log.w(TAG, "弹幕加载失败 code=${conn.responseCode}")
                    return emptyList()
                }
                val bytes = conn.inputStream.use { it.readBytes() }
                return parseBilibiliXml(bytes)
            } catch (e: Throwable) {
                Log.e(TAG, "弹幕加载异常", e)
                return emptyList()
            } finally {
                conn.disconnect()
            }
        }

        /** B 站 XML 解析：<d p="time,mode,pool,uid,rowid,color,size,...">文本</d> */
        fun parseBilibiliXml(bytes: ByteArray): List<Danmaku> {
            val items = mutableListOf<Danmaku>()
            val parser = SAXParserFactory.newInstance().newSAXParser()
            val handler = object : DefaultHandler() {
                private var p = ""
                private var attrs: Attributes? = null
                override fun startElement(uri: String?, local: String?, q: String?, a: Attributes?) {
                    if (local == "d" || q == "d") attrs = a
                }
                override fun characters(ch: CharArray?, start: Int, length: Int) {
                    if (attrs != null) p += String(ch!!, start, length)
                }
                override fun endElement(uri: String?, local: String?, q: String?) {
                    if (local == "d" || q == "d") {
                        val a = attrs
                        attrs = null
                        if (a != null && p.isNotBlank()) {
                            runCatching {
                                val pv = a.getValue("p") ?: ""
                                val parts = pv.split(",")
                                val time = (parts.getOrNull(0)?.toDoubleOrNull() ?: 0.0)
                                val mode = parts.getOrNull(1)?.toIntOrNull() ?: 1
                                val colorInt = parts.getOrNull(3)?.toIntOrNull() ?: 0xFFFFFF
                                val sizeRatio = (parts.getOrNull(2)?.toIntOrNull() ?: 25).toFloat() / 25f
                                val text = p.trim()
                                if (time >= 0 && text.isNotEmpty() && mode != 8 && mode != 9) {
                                    items.add(Danmaku(
                                        (floor(time * 1000)).toLong(), text,
                                        0xFF000000.toInt() or colorInt, sizeRatio
                                    ))
                                }
                            }
                        }
                        p = ""
                    }
                }
            }
            runCatching {
                parser.parse(ByteArrayInputStream(bytes), handler)
            }.onFailure { Log.e(TAG, "弹幕 XML 解析失败", it) }
            return items
        }
    }
}
