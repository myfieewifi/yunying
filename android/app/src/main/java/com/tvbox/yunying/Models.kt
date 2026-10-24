package com.tvbox.yunying

import com.google.gson.annotations.SerializedName

/**
 * TVBox 订阅配置（json 源）结构，完全对齐映匣/TVBox 标准。
 * 支持 spider jar、js、py、js.md；sites 里每一项独立指定 api 爬虫。
 */
data class TvBoxConfig(
    @JvmField var spider: String? = null,          // 全局爬虫路径: xxx.jar;md5xxx / xxx.js / xxx.py / xxx.js.md
    @JvmField var sites: List<Site> = emptyList(),
    @JvmField var lives: List<LiveGroup>? = null,
    @JvmField var flags: List<String>? = null,
    @JvmField var wall: String? = null,
    @JvmField var logo: String? = null,
)

data class Site(
    @JvmField var key: String,
    @JvmField var name: String,
    @JvmField var type: Int = 3,                   // 0=直链解析,1=html(废弃),2=CMS,3=JSON/自定义(主流),4=XML
    @JvmField var api: String,                     // 爬虫路径：csp_Xxx、/path/to.js、.py、.js.md
    @JvmField var searchable: Int = 1,
    @JvmField var quickSearch: Int = 0,
    @JvmField var filterable: Int = 1,
    @JvmField var playerUrl: String? = null,
    @JvmField var ext: String? = null,            // 爬虫初始化参数：json字符串/子配置地址/另一个 js.md 的路径
    @JvmField var categories: String? = null,
    @JvmField var timeout: Int = 15,
) {
    /** 爬虫类型：按 api 后缀判定 */
    val spiderType: SpiderType
        get() = when {
            api.endsWith(".js.md", ignoreCase = true)
                    || api.endsWith(".md", ignoreCase = true)
                    || ext?.endsWith(".js.md", ignoreCase = true) == true
                    || ext?.endsWith(".md", ignoreCase = true) == true -> SpiderType.DRPY
            api.endsWith(".js", ignoreCase = true)
                    || ext?.endsWith(".js", ignoreCase = true) == true -> SpiderType.JS
            api.endsWith(".py", ignoreCase = true)
                    || ext?.endsWith(".py", ignoreCase = true) == true -> SpiderType.PY
            api.startsWith("csp_", ignoreCase = true)
                    || api.endsWith(".jar", ignoreCase = true)
                    || ext?.endsWith(".jar", ignoreCase = true) == true -> SpiderType.JAR
            else -> SpiderType.JSON
        }
}

enum class SpiderType { JSON, JAR, JS, PY, DRPY }

data class LiveGroup(
    @JvmField var group: String,
    @JvmField var channels: List<LiveChannel>,
)
data class LiveChannel(
    @JvmField var name: String,
    @JvmField var urls: List<String>,
)

// ---- spider 调用返回 ----
data class SpiderResult(
    @JvmField var list: List<Vod>? = null,
    @JvmField var `class`: List<Category>? = null,
    @JvmField var filters: Map<String, List<Filter>>? = null,
    @JvmField var url: String? = null,
    @JvmField var parse: Int = 0,
    @JvmField var playUrl: String? = null,
    @JvmField var jx: Int = 0,
    @JvmField var pagecount: Int = 1,
)
data class Vod(
    @JvmField var vod_id: String,
    @JvmField var vod_name: String,
    @JvmField var vod_pic: String? = null,
    @JvmField var vod_remarks: String? = null,
)
data class VodDetail(
    @JvmField var vod_id: String,
    @JvmField var vod_name: String,
    @JvmField var vod_pic: String? = null,
    @JvmField var vod_remarks: String? = null,
    @JvmField var vod_year: String? = null,
    @JvmField var vod_area: String? = null,
    @JvmField var vod_director: String? = null,
    @JvmField var vod_actor: String? = null,
    @JvmField var vod_content: String? = null,
    @JvmField var vod_play_from: String? = null,
    @JvmField var vod_play_url: String? = null,
)
data class Category(@JvmField var type_id: String, @JvmField var type_name: String)
data class Filter(@JvmField var key: String, @JvmField var name: String, @JvmField var value: List<FilterValue>?)
data class FilterValue(@JvmField var n: String, @JvmField var v: String)
