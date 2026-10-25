package com.tvbox.yunying

import android.content.Context
import android.util.Base64
import com.google.gson.Gson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * TVBox 订阅配置加载器：支持 URL、本地文件、assets 默认示例源。
 * 兼容 TVBox ApiConfig.FindResult 的两种加密格式：
 *   - 图片伪装 Base64（[A-Za-z0]{8}\*\* 标记后接 Base64）
 *   - 2423 AES-CBC 自解密（hex，32 头部，key/内嵌在密文段中——影视仓/OK影视同款）
 */
object ConfigLoader {

    private val gson = Gson()
    private val http = OkHttpClient.Builder().followRedirects(true).build()

    /** 加载配置：url 以 http(s) 开头时网络下载，否则读本地文件；空则返回默认示例 */
    suspend fun load(context: Context, url: String?): TvBoxConfig = withContext(Dispatchers.IO) {
        if (url.isNullOrBlank()) return@withContext default(context)
        val text = when {
            url.startsWith("http://") || url.startsWith("https://") -> {
                // 部分订阅站按 UA 拦截（如 摸鱼儿 要求 okhttp/3.12.0），依次尝试常见 UA
                val agents = listOf("okhttp/3.12.0", "Mozilla/5.0", "okhttp/4.12.0", "pluto-sdk/1.0")
                var text: String? = null
                for (ua in agents) {
                    val req = Request.Builder().url(url).header("User-Agent", ua).build()
                    runCatching {
                        http.newCall(req).execute().use { resp ->
                            if (resp.isSuccessful) text = resp.body?.string().orEmpty()
                        }
                    }
                    if (!text.isNullOrBlank()) break
                }
                text ?: throw IllegalStateException("配置下载失败（已尝试多种 UA）: $url")
            }
            url.startsWith("file://") -> File(url.removePrefix("file://")).readText()
            url.startsWith("assets://") ->
                context.assets.open(url.removePrefix("assets://")).bufferedReader().readText()
            else -> File(url).readText()
        }
        if (text.isBlank()) throw IllegalStateException("配置内容为空：$url")
        parse(text).also {
            // 持久化到本地缓存作为"最后一份可用备份"，与映匣 subscription 语义一致
            val last = File(context.filesDir, "config_last.json")
            last.writeText(text)
        }
    }

    /** 上次成功加载的配置 */
    fun last(context: Context): TvBoxConfig? {
        val f = File(context.filesDir, "config_last.json")
        if (!f.exists()) return null
        return runCatching { parse(f.readText()) }.getOrNull()
    }

    fun parse(text: String): TvBoxConfig = runCatching {
        gson.fromJson(decryptIfProtected(text.trim()), TvBoxConfig::class.java)
    }.getOrElse { e ->
        throw IllegalStateException(
            "配置解析失败：" + (e.message ?: e::class.java.simpleName) +
                "（若为加密接口，请确认订阅链接支持自解密）", e,
        )
    }

    /**
     * TVBox 加密配置识别与解密（移植自 ApiConfig.FindResult + AES.java）。
     * 注意保持与上游逐字一致的行为，key/iv 规则非常怪：
     *   - 整体 hex → latin1 字符串后取小写
     *   - key = "$#" 与 "#$" 之间的字段右补 "0" 至 16 位
     *   - iv = 末尾 13 个字符右补 "0" 至 16 位
     *   - 密文 = "2324"（"#$" 的 hex）之后到倒数第 26 字符的 hex
     */
    private fun decryptIfProtected(trimmed: String): String {
        var content = trimmed
        val marker = Regex("[A-Za-z0]{8}\\*\\*")
        marker.find(content)?.let { m ->
            content = content.substring(content.indexOf(m.value) + 10)
            content = String(Base64.decode(content, Base64.DEFAULT), Charsets.UTF_8).trim()
        }
        if (content.startsWith("2423")) {
            val data = content.substring(content.indexOf("2324") + 4, content.length - 26)
            val body = String(content.hexToBytes(), Charsets.ISO_8859_1).lowercase()
            val key = body.substring(body.indexOf("$#") + 2, body.indexOf("#$")).padding('0', 16)
            val iv = body.substring(body.length - 13).padding('0', 16)
            content = String(aesCbc(data.hexToBytes(), key.toByteArray(Charsets.ISO_8859_1), iv.toByteArray(Charsets.ISO_8859_1)), Charsets.UTF_8)
        }
        return content
    }

    private fun aesCbc(data: ByteArray, key: ByteArray, iv: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
        return cipher.doFinal(data)
    }

    private fun String.hexToBytes(): ByteArray {
        val out = ByteArray(length / 2)
        for (i in out.indices) out[i] = ((Character.digit(this[i * 2], 16) shl 4) or Character.digit(this[i * 2 + 2 - 1], 16)).toByte()
        return out
    }

    private fun String.padding(pad: Char, len: Int): String = if (length >= len) take(len).trim() else this.trim() + pad.toString().repeat(len - length)

    private fun default(context: Context): TvBoxConfig =
        runCatching {
            val text = context.assets.open("config_default.json").bufferedReader().readText()
            parse(text)
        }.getOrDefault(TvBoxConfig())
}
