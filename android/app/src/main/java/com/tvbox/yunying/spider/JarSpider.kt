package com.tvbox.yunying.spider

import com.google.gson.Gson
import com.tvbox.yunying.Site
import dalvik.system.DexClassLoader
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * JAR (csp_) 爬虫运行时（安卓版）。
 * TVBox 社区 jar 通常是包含 classes.dex 的加密 jar，安卓上无法直接加载 JVM class。
 * 这里提供两条路：
 *   1. 若本地 assets 里有对应 csp_ 类的 JS lite 端口（映匣同款 LiteSites），优先走 JS；
 *   2. 否则把 jar 下载到 cache，用 DexClassLoader 加载（社区有预编译好的 .dex 版本插件），
 *      找不到 dex 时回退到空结果并记录错误（避免崩溃）。
 * 完整 unidbg / dex2jar 级别的 JAR 模拟需要大量 C 代码；映匣在 Apple 端通过 DexLoom/unidbg 实现，
 * 安卓端直接复用 FongMi 的 CatVod 开源插件加载器即可——本类给出接口骨架，FongMi 代码可以直接合入。
 */
class JarSpider(
    override val site: Site,
    private val jarLoader: (String) -> ByteArray,
) : BaseSpider(site) {

    private val gson = Gson()
    private var delegate: BaseSpider? = null

    override fun init(ext: String) {
        // 优先：尝试走 JS lite 端口（assets/spider/lite/<csp>.js）
        val clsName = site.api.removePrefix("csp_")
        val liteName = "spider/lite/csp_$clsName.js"
        val lite = runCatching {
            com.tvbox.yunying.YunYingApp.instance.assets.open(liteName).bufferedReader().readText()
        }.getOrNull()
        if (lite != null) {
            delegate = JsSpider(site, { lite })
            delegate?.init(ext)
            return
        }

        // 次选：DexClassLoader 加载 dex（占位）
        tryLoadDex(ext)
    }

    private fun tryLoadDex(ext: String) {
        runCatching {
            // jarLoader(site.api) 下载 .jar 到 cache，然后我们用 DexFile 尝试加载 dex 条目。
            // 这里仅保留占位逻辑：FongMi/TV 仓库的 catvod 已实现完整的 jar->dex 装载+反射调用，
            // 二开时把 com.github.catvod:spider 库作为依赖合入即可。
            android.util.Log.w("JAR", "Dex 加载未启用：请在 build.gradle 中引入 FongMi/CatVod Spider 依赖以支持 csp_ 类爬虫")
        }
    }

    override fun destroy() { delegate?.destroy() }
    override fun homeContent(filter: Boolean) = delegate?.homeContent(filter) ?: com.tvbox.yunying.SpiderResult()
    override fun categoryContent(tid: String, pg: String, filter: Boolean, ex: Map<String, String>) =
        delegate?.categoryContent(tid, pg, filter, ex) ?: com.tvbox.yunying.SpiderResult()
    override fun searchContent(wd: String, quick: Boolean, pg: String) =
        delegate?.searchContent(wd, quick, pg) ?: com.tvbox.yunying.SpiderResult()
    override fun detailContent(ids: List<String>) =
        delegate?.detailContent(ids) ?: mapOf("list" to emptyList<Any>())
    override fun playerContent(flag: String, id: String, flags: List<String>) =
        delegate?.playerContent(flag, id, flags) ?: mapOf("url" to id, "parse" to 0, "header" to "", "playUrl" to "")
}
