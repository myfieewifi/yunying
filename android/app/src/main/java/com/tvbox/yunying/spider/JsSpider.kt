package com.tvbox.yunying.spider

import com.google.gson.Gson
import com.quickjs.JSArray
import com.quickjs.JSContext
import com.quickjs.JSObject
import com.quickjs.JavaVoidCallback
import com.quickjs.QuickJS
import com.tvbox.yunying.Site

/**
 * JavaScript (含 js.md / drpy) 爬虫运行时。
 * 使用 io.github.taoweiji.quickjs:quickjs-android 执行脚本，对 Spider 原型注入与映匣 QuickJS 一致的方法：
 *   - request / http / fetch（占位，详细实现由宿主提供）
 *   - print / log（console.log / console.error）
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

        // 注入宿主 console（taoweiji API：registerJavaMethod + JavaVoidCallback）
        val console = JSObject(ctx)
        console.registerJavaMethod(JavaVoidCallback { _, args -> logArgs(args, android.util.Log.DEBUG) }, "log")
        console.registerJavaMethod(JavaVoidCallback { _, args -> logArgs(args, android.util.Log.ERROR) }, "error")
        ctx.set("console", console)

        // 注入 request()/http()/fetch() 占位
        ctx.executeVoidScript(
            "var request = function(url, opts){ console.log('req', url); return ''; };\n" +
                "var http = request;\n" +
                "var fetch = request;",
            "yunying-boot.js"
        )

        val scriptUrl = if (isDrpy) {
            // drpy 走 ext 字段？还是 api 字段指向 js.md？—— 都可以
            site.api.takeIf { it.isNotBlank() && !it.startsWith("csp_") } ?: site.ext.orEmpty()
        } else {
            site.api
        }
        val code = loader(scriptUrl)
        ctx.executeVoidScript(code, scriptUrl)

        // 实例化 Spider（协议：Spider 必须定义构造函数并实现标准方法集）
        ctx.executeVoidScript("var __spider = new Spider();", scriptUrl)
        spiderObj = ctx.getObject("__spider") ?: error("JS 脚本未定义 Spider")
        // 调用 spider.init(ext)
        spiderObj?.executeVoidFunction("init", JSArray(ctx).push(ext))
    }

    override fun destroy() {
        runCatching { ctx.close() }
        runCatching { rt.close() }
        spiderObj = null
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

    /** 通过 JSON 传参调用 __spider 的方法并序列化返回值（规避 JSArray push 无 Map/List 重载的问题） */
    private fun callJson(method: String, vararg args: Any?): String? = runCatching {
        val argsJson = gson.toJson(arrayOf(*args))
        val s = ctx.executeStringScript(
            "JSON.stringify(__spider.$method.apply(__spider, $argsJson));",
            "yunying-call.js"
        )
        if (s == null || s == "undefined" || s == "null") null else s
    }.getOrNull()

    private fun logArgs(args: JSArray?, level: Int) {
        val tag = "[JS]"
        val text = (0 until (args?.length() ?: 0)).joinToString(" ") { i ->
            runCatching { args?.getString(i) }.getOrNull() ?: ""
        }
        android.util.Log.println(level, tag, text)
    }

    @Suppress("UNCHECKED_CAST")
    private fun parseMap(json: String): Map<String, Any?> = runCatching {
        gson.fromJson<Map<String, Any?>>(json, Map::class.java) as Map<String, Any?>
    }.getOrDefault(emptyMap())
}
