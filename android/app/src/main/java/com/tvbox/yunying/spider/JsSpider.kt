package com.tvbox.yunying.spider

import com.google.gson.Gson
import com.quickjs.JSContext
import com.quickjs.JSObject
import com.quickjs.QuickJS
import com.tvbox.yunying.Site

/**
 * JavaScript (含 js.md / drpy) 爬虫运行时。
 * 使用 quickjs-android 执行脚本，对 Spider 原型注入与映匣 QuickJS 一致的方法：
 *   - request / http / fetch
 *   - print / log
 *   - 宿主：HtmlParser (jsoup) / Crypto
 * 构造协议与映匣完全一致：spider 实例必须实现 init/homeContent/categoryContent/searchContent/detailContent/playerContent。
 */
class JsSpider(
    override val site: Site,
    private val loader: (String) -> String,
    private val isDrpy: Boolean = false,
) : BaseSpider(site) {

    private val gson = Gson()
    private lateinit var rt: QuickJS
    private lateinit var ctx: JSContext
    private var spiderObj: JSObject? = null

    override fun init(ext: String) {
        rt = QuickJS.createRuntime()
        ctx = rt.createContext()
        // 注入宿主 console
        ctx.set("console", ctx.createJSObject().also { console ->
            console.set("log") { args -> android.util.Log.d("[JS]", args.joinToString(" ")) }
            console.set("error") { args -> android.util.Log.e("[JS]", args.joinToString(" ")) }
        })
        // 注入 request()
        ctx.evaluate("var request = function(url, opts){ console.log('req', url); return ''; };")

        val scriptUrl = if (isDrpy) {
            // drpy 走 ext 字段？还是 api 字段指向 js.md？—— 都可以
            site.api.takeIf { it.isNotBlank() && !it.startsWith("csp_") } ?: site.ext.orEmpty()
        } else {
            site.api
        }
        val code = loader(scriptUrl)
        ctx.evaluate(code, scriptUrl)

        // 取 Spider 构造函数
        val spiderCtor = ctx.get("Spider") ?: error("JS 脚本未定义 Spider")
        spiderObj = ctx.createJSObject(spiderCtor as JSObject)
        // 调用 spider.init(ext)
        spiderObj?.invokeMethod("init", ext)
    }

    override fun destroy() {
        runCatching { ctx.close(); rt.close() }
    }

    override fun homeContent(filter: Boolean) =
        callJson("homeContent", filter)?.let { gson.fromJson(it, com.tvbox.yunying.SpiderResult::class.java) }
            ?: com.tvbox.yunying.SpiderResult()

    override fun categoryContent(tid: String, pg: String, filter: Boolean, ex: Map<String, String>) =
        callJson("categoryContent", tid, pg, filter, ex)?.let { gson.fromJson(it, com.tvbox.yunying.SpiderResult::class.java) }
            ?: com.tvbox.yunying.SpiderResult()

    override fun searchContent(wd: String, quick: Boolean, pg: String) =
        callJson("searchContent", wd, quick, pg)?.let { gson.fromJson(it, com.tvbox.yunying.SpiderResult::class.java) }
            ?: com.tvbox.yunying.SpiderResult()

    override fun detailContent(ids: List<String>): Map<String, Any?> =
        callJson("detailContent", ids)?.let { parseMap(it) } ?: mapOf("list" to emptyList<Any>())

    override fun playerContent(flag: String, id: String, flags: List<String>): Map<String, Any?> =
        callJson("playerContent", flag, id, flags)?.let { parseMap(it) }
            ?: mapOf("url" to id, "parse" to 0, "header" to "", "playUrl" to "")

    private fun callJson(method: String, vararg args: Any?): String? = runCatching {
        val s = spiderObj?.invokeMethod(method, *args) as? String
        s
    }.getOrNull()

    @Suppress("UNCHECKED_CAST")
    private fun parseMap(json: String): Map<String, Any?> = runCatching {
        gson.fromJson<Map<String, Any?>>(json, Map::class.java) as Map<String, Any?>
    }.getOrDefault(emptyMap())
}
