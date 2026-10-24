package com.tvbox.yunying.spider

import com.chaquo.python.PyException
import com.chaquo.python.PyObject
import com.chaquo.python.Python
import com.google.gson.Gson
import com.tvbox.yunying.Site
import com.tvbox.yunying.YunYingApp
import java.io.File
import java.nio.charset.Charset

/**
 * Python 爬虫运行时（安卓版）。
 * 使用 Chaquopy 在 App 进程内直接调用 Python，复用映匣 Runtime/PythonHost/host.py 协议。
 * .py spider 文件下载到 cache 后由 host.py 加载，提供 TVBox 标准 Spider 接口。
 */
class PySpider(
    override val site: Site,
    private val loader: (String) -> ByteArray,
) : BaseSpider(site) {

    private val gson = Gson()
    private var py: Python = Python.getInstance()
    private var spiderModule: PyObject? = null
    private var spiderInstance: PyObject? = null
    private var scriptFile: File? = null

    override fun init(ext: String) {
        val scriptBytes = loader(site.api)
        // 写入沙箱
        val dir = File(YunYingApp.instance.cacheDir, "pyspiders").apply { mkdirs() }
        val name = "spider_${site.key}.py"
        val script = File(dir, name).also { it.writeBytes(scriptBytes) }
        scriptFile = script

        // 保证 host.py 模块（tvbox_host）可 import
        val hostDir = File(YunYingApp.instance.filesDir, "pyhost").apply { mkdirs() }
        copyAssetToDirIfNeeded("spider/python/host.py", File(hostDir, "host.py"))
        copyAssetToDirIfNeeded("spider/python/spider_base.py", File(hostDir, "spider_base.py"))

        // 把 hostDir 加入 sys.path
        py.getModule("sys")?.get("path")?.callAttr("insert", 0, hostDir.absolutePath)

        // 用 host.initialize(script, ext) 方式启动（与映匣 host.py initialize() 等价）
        val host = py.getModule("host")
        spiderInstance = host.callAttr("load_spider", script.absolutePath, ext)
    }

    override fun destroy() {
        runCatching { spiderInstance?.callAttr("__del__") }
        spiderInstance = null
    }

    override fun homeContent(filter: Boolean): com.tvbox.yunying.SpiderResult =
        callJson("homeContent", filter)?.let { parseResult(it) } ?: com.tvbox.yunying.SpiderResult()

    override fun categoryContent(tid: String, pg: String, filter: Boolean, ex: Map<String, String>): com.tvbox.yunying.SpiderResult =
        callJson("categoryContent", tid, pg, filter, ex)?.let { parseResult(it) } ?: com.tvbox.yunying.SpiderResult()

    override fun searchContent(wd: String, quick: Boolean, pg: String): com.tvbox.yunying.SpiderResult =
        callJson("searchContent", wd, quick, pg)?.let { parseResult(it) } ?: com.tvbox.yunying.SpiderResult()

    override fun detailContent(ids: List<String>): Map<String, Any?> {
        val r = callJson("detailContent", ids) ?: return mapOf("list" to emptyList<Any>())
        return gson.fromJson(r, Map::class.java) as Map<String, Any?>
    }

    override fun playerContent(flag: String, id: String, flags: List<String>): Map<String, Any?> {
        val r = callJson("playerContent", flag, id, flags)
            ?: return mapOf("url" to id, "parse" to 0, "header" to "", "playUrl" to "")
        return gson.fromJson(r, Map::class.java) as Map<String, Any?>
    }

    private fun callJson(method: String, vararg args: Any?): String? = runCatching {
        val inst = spiderInstance ?: return@runCatching null
        val result = inst.callAttr(method, *args)
        val obj: Any = result.toJava(Object::class.java)
        when (obj) {
            is String -> obj
            else -> gson.toJson(obj)
        }
    }.getOrElse {
        (it as? PyException)?.message?.let { msg -> android.util.Log.e("PY", msg) }
        null
    }

    private fun parseResult(json: String): com.tvbox.yunying.SpiderResult =
        runCatching { gson.fromJson(json, com.tvbox.yunying.SpiderResult::class.java) }
            .getOrDefault(com.tvbox.yunying.SpiderResult())

    private fun copyAssetToDirIfNeeded(assetPath: String, dst: File) {
        if (dst.exists()) return
        runCatching {
            YunYingApp.instance.assets.open(assetPath).use { inp ->
                dst.outputStream().use { out -> inp.copyTo(out) }
            }
        }
    }
}
