package com.tvbox.yunying.spider

import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import com.tvbox.yunying.Site
import com.tvbox.yunying.SpiderResult
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * JSON 源爬虫（type=1/2：苹果CMS/海洋CMS 的标准 json.php 接口）。
 * 完全按 TVBox 协议拼 URL 调用，不依赖任何外部脚本。
 */
class JsonSpider(override val site: Site) : BaseSpider(site) {

    private val gson = Gson()
    private val http = OkHttpClient.Builder().followRedirects(true).build()
    private var ext: String = ""
    private val baseUrl get() = site.api.trimEnd('/')

    override fun init(ext: String) { this.ext = ext }

    override fun homeContent(filter: Boolean): SpiderResult {
        val json = get("$baseUrl/api.php/provide/vod/?ac=list&t=&pg=1&wd=")
            ?: return SpiderResult()
        return parseList(json)
    }

    override fun categoryContent(tid: String, pg: String, filter: Boolean, ex: Map<String, String>): SpiderResult {
        val extStr = ex.entries.joinToString("&") { "${it.key}=${it.value}" }
        val url = buildString {
            append(baseUrl).append("/api.php/provide/vod/?ac=detail&t=").append(tid)
            append("&pg=").append(pg)
            if (extStr.isNotEmpty()) append("&").append(extStr)
        }
        val json = get(url) ?: return SpiderResult()
        return parseList(json)
    }

    override fun searchContent(wd: String, quick: Boolean, pg: String): SpiderResult {
        val json = get("$baseUrl/api.php/provide/vod/?ac=detail&wd=$wd&pg=$pg")
            ?: return SpiderResult()
        return parseList(json)
    }

    override fun detailContent(ids: List<String>): Map<String, Any?> {
        val json = get("$baseUrl/api.php/provide/vod/?ac=detail&ids=${ids.joinToString(",")}") ?: return mapOf("list" to emptyList<Any>())
        val type = object : TypeToken<Map<String, Any?>>() {}.type
        val map: Map<String, Any?> = gson.fromJson(json, type)
        return map
    }

    override fun playerContent(flag: String, id: String, flags: List<String>): Map<String, Any?> {
        // id 即播放 URL 时直接返回（JSON 源通常 playUrl 直接可用）
        return mapOf(
            "header" to "",
            "playUrl" to "",
            "url" to id,
            "parse" to 0,
        )
    }

    private fun parseList(json: String): SpiderResult {
        val type = object : TypeToken<SpiderResult>() {}.type
        return runCatching { gson.fromJson<SpiderResult>(json, type) }.getOrDefault(SpiderResult())
    }

    private fun get(url: String): String? = runCatching {
        val req = Request.Builder().url(url)
            .header("User-Agent", "Mozilla/5.0")
            .build()
        http.newCall(req).execute().use { it.body?.string() }
    }.getOrNull()
}
