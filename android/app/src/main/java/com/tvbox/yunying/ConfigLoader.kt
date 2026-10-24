package com.tvbox.yunying

import android.content.Context
import com.google.gson.Gson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File

/**
 * TVBox 订阅配置加载器：支持 URL、本地文件、assets 默认示例源。
 */
object ConfigLoader {

    private val gson = Gson()
    private val http = OkHttpClient.Builder().followRedirects(true).build()

    /** 加载配置：url 以 http(s) 开头时网络下载，否则读本地文件；空则返回默认示例 */
    suspend fun load(context: Context, url: String?): TvBoxConfig = withContext(Dispatchers.IO) {
        if (url.isNullOrBlank()) return@withContext default(context)
        val text = when {
            url.startsWith("http://") || url.startsWith("https://") -> {
                val req = Request.Builder().url(url).header("User-Agent", "Mozilla/5.0").build()
                http.newCall(req).execute().use { it.body?.string().orEmpty() }
            }
            url.startsWith("file://") -> File(url.removePrefix("file://")).readText()
            url.startsWith("assets://") ->
                context.assets.open(url.removePrefix("assets://")).bufferedReader().readText()
            else -> File(url).readText()
        }
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
        gson.fromJson(text.trim(), TvBoxConfig::class.java)
    }.getOrDefault(TvBoxConfig())

    private fun default(context: Context): TvBoxConfig =
        runCatching {
            val text = context.assets.open("config_default.json").bufferedReader().readText()
            parse(text)
        }.getOrDefault(TvBoxConfig())
}
