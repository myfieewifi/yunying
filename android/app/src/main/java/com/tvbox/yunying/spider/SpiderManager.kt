package com.tvbox.yunying.spider

import android.content.Context
import com.google.gson.Gson
import com.tvbox.yunying.R
import com.tvbox.yunying.Site
import com.tvbox.yunying.SpiderResult
import com.tvbox.yunying.SpiderType
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * 爬虫管理器：按 site 类型选择对应 runtime，提供 TVBox 标准接口
 *   - homeContent / categoryContent / searchContent / detailContent / playerContent
 * 支持：JSON / JAR(csp_类) / JS / PY / js.md(DRPY)
 */
object SpiderManager {

    private val gson = Gson()
    private lateinit var appContext: Context
    private val http = OkHttpClient.Builder().followRedirects(true).build()
    private val cache = ConcurrentHashMap<String, BaseSpider>()
    private var globalJar: String? = null

    fun init(ctx: Context) {
        appContext = ctx.applicationContext
        CatJarRuntime.init(ctx)
    }

    /** 配置级的全局 spider jar（xxx.jar;md5;xxx 或 xxx.js/xxx.py），csp_ 站点加载时使用 */
    fun setGlobalJar(jar: String?) {
        globalJar = jar?.trim()?.takeIf { it.isNotBlank() }
    }

    fun clear() {
        cache.values.forEach run@{ it.destroy() }
        cache.clear()
    }

    /** 按 site 返回（或创建）对应 spider 实例 */
    suspend fun get(site: Site): BaseSpider {
        cache[site.key]?.let { return it }
        val spider = when (site.spiderType) {
            SpiderType.JSON -> JsonSpider(site)
            SpiderType.JS -> JsSpider(site, this::fetchScriptText)
            SpiderType.DRPY -> JsSpider(site, this::fetchDrpyScriptText, isDrpy = true)
            SpiderType.PY -> PySpider(site, this::fetchScriptBytes)
            SpiderType.JAR -> {
                val jar = globalJar ?: site.extString?.takeIf { it.contains(".jar", true) }
                val isCsp = site.api.startsWith("csp_", ignoreCase = true)
                if (isCsp && jar != null) CatJarSpider(site, jar)
                else JarSpider(site, this::fetchJarBytes)
            }
        }
        spider.init(site.extString ?: "")
        cache[site.key] = spider
        return spider
    }

    // ---- 资源拉取 ----

    private fun fetchScriptText(url: String): String =
        fetchText(resolveUrl(url))

    private fun fetchDrpyScriptText(url: String): String {
        val raw = fetchText(resolveUrl(url))
        val template = readAssetOrNull("spider/drpy_template.js")
        return DrpyParser.parse(raw, template)
    }

    private fun fetchScriptBytes(url: String): ByteArray =
        fetchBytes(resolveUrl(url))

    private fun fetchJarBytes(url: String): ByteArray =
        fetchBytes(resolveJarUrl(url))

    private fun resolveUrl(url: String): String {
        val u = url.trim()
        if (u.startsWith("http://") || u.startsWith("https://") || u.startsWith("file://") || u.startsWith("assets://"))
            return u
        // 相对路径当作本地 asset
        return "assets://spider/$u"
    }

    private fun resolveJarUrl(spiderUrl: String): String {
        // spider 形如 "xxx.jar;md5xxxx"，取分号前
        return spiderUrl.split(';').first().let(::resolveUrl)
    }

    private fun fetchText(url: String): String {
        if (url.startsWith("assets://")) {
            val path = url.removePrefix("assets://")
            return appContext.assets.open(path).bufferedReader().use { it.readText() }
        }
        if (url.startsWith("file://")) {
            return File(url.removePrefix("file://")).readText()
        }
        val req = Request.Builder().url(url)
            .header("User-Agent", "Mozilla/5.0")
            .build()
        return http.newCall(req).execute().use { resp ->
            require(resp.isSuccessful) { "HTTP ${resp.code}" }
            resp.body?.string().orEmpty()
        }
    }

    private fun fetchBytes(url: String): ByteArray {
        if (url.startsWith("assets://")) {
            val path = url.removePrefix("assets://")
            return appContext.assets.open(path).readBytes()
        }
        if (url.startsWith("file://")) {
            return File(url.removePrefix("file://")).readBytes()
        }
        // 下载到缓存
        val name = java.net.URLEncoder.encode(url, "UTF-8")
        val cacheFile = File(appContext.cacheDir, "spider/$name")
        if (cacheFile.exists()) return cacheFile.readBytes()
        cacheFile.parentFile?.mkdirs()
        val req = Request.Builder().url(url).header("User-Agent", "Mozilla/5.0").build()
        http.newCall(req).execute().use { resp ->
            require(resp.isSuccessful) { "HTTP ${resp.code} $url" }
            val bytes = resp.body?.bytes() ?: ByteArray(0)
            cacheFile.writeBytes(bytes)
            return bytes
        }
    }

    private fun readAssetOrNull(path: String): String? = runCatching {
        appContext.assets.open(path).bufferedReader().use { it.readText() }
    }.getOrNull()
}

/** 所有 spider 的统一接口 */
abstract class BaseSpider(open val site: Site) {
    open fun init(ext: String) {}
    open fun destroy() {}
    abstract fun homeContent(filter: Boolean): SpiderResult
    abstract fun categoryContent(tid: String, pg: String, filter: Boolean, ex: Map<String,String>): SpiderResult
    abstract fun searchContent(wd: String, quick: Boolean, pg: String): SpiderResult
    abstract fun detailContent(ids: List<String>): Map<String, Any?>
    abstract fun playerContent(flag: String, id: String, flags: List<String>): Map<String, Any?>
}
