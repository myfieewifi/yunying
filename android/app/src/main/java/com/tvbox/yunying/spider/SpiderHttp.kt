package com.tvbox.yunying.spider

import com.quickjs.JSArray
import com.quickjs.JSObject
import com.quickjs.JavaCallback
import java.io.ByteArrayOutputStream
import java.nio.charset.Charset
import java.util.zip.GZIPInputStream
import java.util.zip.InflaterInputStream
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.mozilla.universalchardet.UniversalDetector

/**
 * JS 爬虫的 HTTP 桥（替换之前的空实现 stub）。
 * - request(url, opts) / http / fetch 同一实现，同步阻塞返回响应体；
 * - opts 支持 method / headers / body / timeout；
 * - 自动 gzip/deflate 解压；按 HTTP 头或 BOM/内容探测编码（drpy 源站大量 GBK）。
 */
object SpiderHttp {

    private val client: OkHttpClient = OkHttpClient.Builder()
        .followRedirects(true)
        .build()

    /** JS 同步调用入口：request(url[, opts]) */
    val requestCallback: JavaCallback = JavaCallback { _, args -> request(args) }

    /** 同一个实现挂多个别名 */
    val fetchCallback: JavaCallback = requestCallback
    val httpCallback: JavaCallback = requestCallback

    private fun request(args: JSArray?): Any? {
        if (args == null || args.length() < 1) return ""
        val url = runCatching { args.getString(0) }.getOrNull() ?: return ""
        val opts = when {
            args.length() > 1 -> runCatching { args.getObject(1) }.getOrNull()
            else -> null
        }
        return try {
            fetchBody(url, opts)
        } catch (e: Throwable) {
            android.util.Log.w("SpiderHttp", "request failed: $url, ${e}")
            ""
        }
    }

    private fun fetchBody(url: String, opts: JSObject?): String {
        val method = (opts?.get("method") as? String)?.uppercase() ?: "GET"
        val builder = Request.Builder().url(url)
            .header("User-Agent", "Mozilla/5.0 (Android; Mobile)")
            .header("Accept", "*/*")
            .header("Accept-Encoding", "gzip, deflate")

        opts?.let { o ->
            val headers = runCatching { o.getObject("headers") }.getOrNull()
            headers?.let { h ->
                for (i in 0 until h.length()) {
                    val k = h.getString(i) ?: continue
                    val v = runCatching { h.get(i).toString() }.getOrNull() ?: continue
                    if (k.equals("User-Agent", true) || k.equals("Accept-Encoding", true)) continue
                    builder.header(k, v)
                }
            }
        }

        val bodyText = (opts?.get("body") as? String)
            ?: (opts?.get("data") as? String)
        val isForm = method == "POST" || method == "PUT"
        if (isForm && bodyText != null) {
            val contentType = (opts?.get("contentType") as? String)
                ?.let { it.toMediaTypeOrNull() } ?: "application/x-www-form-urlencoded".toMediaTypeOrNull()
            builder.method(method, bodyText.toRequestBody(contentType))
        } else if (isForm) {
            builder.method(method, ByteArray(0).let { "".toRequestBody(it.toMediaTypeOrNull()) })
        } else {
            builder.get()
        }

        val resp = client.newBuilder()
            .callTimeout((opts?.get("timeout") as? Int)?.toLong()?.let { it * 1000 + 5000 } ?: 20_000L, java.util.concurrent.TimeUnit.MILLISECONDS)
            .build()
            .newCall(builder.build())
            .execute()

        resp.use { r ->
            require(r.isSuccessful) { "HTTP ${r.code} $url" }
            val bytes = readAll(r)
            val contentTypeHeader = r.header("Content-Type").orEmpty()
            val charset = charsetFromHeader(contentTypeHeader)
                ?: charsetFromBom(bytes)
                ?: charsetFromSniff(bytes)
                ?: Charsets.UTF_8
            return String(bytes, charset)
        }
    }

    private fun readAll(r: okhttp3.Response): ByteArray {
        val src = r.body?.byteStream() ?: return ByteArray(0)
        val unwrapped = when (r.header("Content-Encoding")) {
            "gzip" -> GZIPInputStream(src)
            "deflate" -> InflaterInputStream(src)
            else -> src
        }
        val out = ByteArrayOutputStream()
        unwrapped.use { input -> input.copyTo(out, 64 * 1024) }
        return out.toByteArray()
    }

    private fun charsetFromHeader(header: String): Charset? =
        header.split(';').map { it.trim() }
            .firstOrNull { it.startsWith("charset=", true) }
            ?.substringAfter('=')
            ?.trim('"')
            ?.let { runCatching { Charset.forName(it) }.getOrNull() }

    private fun charsetFromBom(bytes: ByteArray): Charset? = when {
        bytes.size > 3 && bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte() && bytes[2] == 0xBF.toByte() -> Charsets.UTF_8
        bytes.size > 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xFE.toByte() -> Charset.forName("UTF-16LE")
        bytes.size > 2 && bytes[0] == 0xFE.toByte() && bytes[1] == 0xFF.toByte() -> Charset.forName("UTF-16BE")
        else -> null
    }

    private fun charsetFromSniff(bytes: ByteArray): Charset? {
        if (bytes.size < 64 || bytes.size > 512 * 1024) return null
        val detector = UniversalDetector(null)
        try {
            detector.handleData(bytes, 0, bytes.size)
            detector.dataEnd()
            return detector.detectedCharset?.let { runCatching { Charset.forName(it) }.getOrNull() }
        } catch (e: Throwable) {
            return null
        } finally {
            runCatching { detector.reset() }
        }
    }
}
