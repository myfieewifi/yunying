package com.tvbox.yunying.spider

import android.content.Context
import com.github.catvod.crawler.Spider
import com.github.catvod.net.Net
import com.github.catvod.utils.RuntimeModule
import com.google.gson.Gson
import com.tvbox.yunying.Site
import com.tvbox.yunying.SpiderResult
import com.tvbox.yunying.YunYingApp
import com.tvbox.yunying.Vod
import com.tvbox.yunying.Category
import com.tvbox.yunying.VodDetail
import dalvik.system.DexClassLoader
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/**
 * CatVod（FongMi）协议 JAR 爬虫运行时。
 * 宿主 com.github.catvod.* 类由 android/catvod + android/quickjs 两个 vendored 模块提供，
 * jar 通过 DexClassLoader（parent = SPIDER_LOADER）解析到宿主运行时，流程对齐 FongMi JarLoader：
 *   1. 下载 jar（`.../xxx.jar;md5;<md5|md5url>` 校验）
 *   2. DexClassLoader 装载，自举 com.github.catvod.spider.Init.init(Context)（加密壳在此完成解密）
 *   3. 实例化 com.github.catvod.spider.<csp_ 类名>，设置 siteKey/net/local 后 init(context, ext)
 * Vod/Runtime 依赖均在宿主内；QuickJS 运行时经 RuntimeModule 补丁进程内加载。
 */
object CatJarRuntime {

    private var appContext: Context? = null
    private val loaders = ConcurrentHashMap<String, DexClassLoader>()
    private val locks = ConcurrentHashMap<String, Any>()

    fun init(ctx: Context) {
        appContext = ctx.applicationContext
        com.github.catvod.Runtime.set(ctx.applicationContext)
    }

    /** 按 jar 描述加载（含缓存），失败抛 IllegalStateException */
    fun loader(jar: String): DexClassLoader {
        val ctx = requireNotNull(appContext) { "CatJarRuntime 未初始化" }
        val url = jar.split(';').first().trim()
        require(url.isNotBlank()) { "spider jar 地址为空" }
        val identity = md5Hex(url.toByteArray()).also { if (it.isBlank()) error("jar key") }
        val md5 = jar.split(";md5;").getOrNull(1)?.trim().orEmpty()
        val lock = locks.computeIfAbsent(identity) { Any() }
        synchronized(lock) {
            loaders[identity]?.let { return it }
            val dir = File(ctx.filesDir, "catvod/jars").apply { mkdirs() }
            val file = File(dir, "$identity.jar")
            if (!file.exists() || file.length() == 0L) fetchJar(url, file)
            // md5 校验；md5 还可能是 .md5 文件 URL（社区习惯）
            if (md5.isNotBlank()) {
                val expected = if (md5.startsWith("http")) {
                    val httpApp = ctx
                    runCatching {
                        val req = okhttp3.Request.Builder().url(md5).build()
                        okhttp3.OkHttpClient().newCall(req).execute().use { it.body?.string()?.trim().orEmpty() }
                    }.getOrDefault("")
                } else md5
                if (expected.isNotBlank() && md5File(file) != expected) {
                    file.delete()
                    throw IllegalStateException("spider jar md5 校验失败")
                }
            }
            val cachePath = File(ctx.cacheDir, "catvod").apply { mkdirs() }.absolutePath
            // Android 10+（API 29+）W^X 限制：可写位置的 dex 禁止加载（"Writable dex file" 报错），
            // 加载前必须把 jar 置为只读（对齐 FongMi JarLoader.openDex）
            if (!file.setReadOnly()) throw IllegalStateException("无法将 jar 置为只读: $file")
            val loader = DexClassLoader(file.absolutePath, cachePath, cachePath, RuntimeModule.getSpiderClassLoader())
            runCatching {
                val clz = loader.loadClass("com.github.catvod.spider.Init")
                clz.getMethod("init", Context::class.java).invoke(clz, ctx)
            } // 无 Init 自举类时跳过（非加密 jar）
            loaders[identity] = loader
            return loader
        }
    }

    private fun fetchJar(url: String, dest: File) {
        val temp = File(dest.path + ".part")
        val http = okhttp3.OkHttpClient.Builder().followRedirects(true).build()
        // 部分订阅站按 UA 拦截（如 摸鱼儿 要求 okhttp/3.12.0），依次尝试常见 UA
        val agents = listOf("okhttp/3.12.0", "Mozilla/5.0", "okhttp/4.12.0", "pluto-sdk/1.0")
        var lastCode = 0
        var bytes: ByteArray = ByteArray(0)
        for (ua in agents) {
            val req = okhttp3.Request.Builder().url(url).header("User-Agent", ua).build()
            runCatching {
                http.newCall(req).execute().use { resp ->
                    lastCode = resp.code
                    if (resp.isSuccessful) bytes = resp.body?.bytes() ?: ByteArray(0)
                }
            }
            if (bytes.size > 4) break
        }
        require(bytes.size > 4 && bytes.size < 512 * 1024 * 1024) {
            "jar 下载失败 HTTP $lastCode（已尝试 ${agents.size} 种 UA）: $url"
        }
        temp.writeBytes(bytes)
        if (!temp.renameTo(dest)) {
            dest.delete(); check(temp.renameTo(dest)) { "jar 落盘失败" }
        }
    }

    private fun md5File(file: File): String {
        val digest = MessageDigest.getInstance("MD5")
        file.inputStream().use { input ->
            val buf = ByteArray(8192)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                digest.update(buf, 0, n)
            }
        }
        // 与社区 jar 的 MD5 文件一致：小写连续 hex
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun md5Hex(data: ByteArray): String =
        MessageDigest.getInstance("MD5").digest(data).joinToString("") { "%02x".format(it) }
}

/** CatVod jar 单站点爬虫包装（对齐 app 内 BaseSpider 接口） */
class CatJarSpider(
    override val site: Site,
    private val jar: String,
) : BaseSpider(site) {

    private val gson = Gson()
    private var spider: Spider? = null

    override fun init(ext: String) {
        val loader = CatJarRuntime.loader(jar)
        val cls = loader.loadClass("com.github.catvod.spider." + site.api.removePrefix("csp_"))
        val instance = cls.getDeclaredConstructor().newInstance() as Spider
        instance.siteKey = site.key
        instance.net = Net(AppCookies, site.key)
        instance.local = com.github.catvod.utils.Local(site.key)
        instance.init(YunYingApp.instance, ext)
        spider = instance
    }

    override fun destroy() {
        runCatching { spider?.destroy() }
        runCatching { spider?.js?.close() }
        runCatching { spider?.net?.close() }
    }

    override fun homeContent(filter: Boolean): SpiderResult =
        result(runCatching { spider?.homeContent(filter) }, SpiderResult())

    override fun categoryContent(tid: String, pg: String, filter: Boolean, ex: Map<String, String>): SpiderResult {
        val map = try { java.util.HashMap(ex) } catch (e: Throwable) { java.util.HashMap() }
        return result(runCatching { spider?.categoryContent(tid, pg, filter, map) }, SpiderResult())
    }

    override fun searchContent(wd: String, quick: Boolean, pg: String): SpiderResult {
        // CatVod 协议有两个重载：(key, quick) 与 (key, quick, pg)
        val direct = pg.isBlank() || pg == "1"
        val json = runCatching {
            if (direct || !hasSearchPg()) spider?.searchContent(wd, quick)
            else spider?.searchContent(wd, quick, pg)
        }
        return result(json, SpiderResult())
    }

    private fun hasSearchPg(): Boolean = runCatching {
        spider!!::class.java.declaredMethods.any {
            it.name == "searchContent" && it.parameterTypes.size >= 3
        }
    }.getOrDefault(false)

    override fun detailContent(ids: List<String>): Map<String, Any?> {
        val json = runCatching { spider?.detailContent(ids) }
        val raw = (json.getOrNull() ?: "").takeIf { it.isNotBlank() } ?: return mapOf("list" to emptyList<Any>())
        val parsed = runCatching { gson.fromJson(raw, Map::class.java) }.getOrNull()
            ?: return mapOf("list" to emptyList<Any>())
        @Suppress("UNCHECKED_CAST")
        return parsed as Map<String, Any?>
    }

    override fun playerContent(flag: String, id: String, flags: List<String>): Map<String, Any?> {
        val json = runCatching { spider?.playerContent(flag, id, flags) }
        val raw = (json.getOrNull() ?: "").takeIf { it.isNotBlank() }
            ?: return mapOf("url" to id, "parse" to 0, "header" to "", "playUrl" to "", "jx" to 0)
        val parsed = runCatching { gson.fromJson(raw, Map::class.java) }.getOrNull()
        @Suppress("UNCHECKED_CAST")
        return (parsed as? Map<String, Any?>) ?: mapOf("url" to id, "parse" to 0, "header" to "", "playUrl" to "", "jx" to 0)
    }

    private fun result(call: Result<String?>, fallback: SpiderResult): SpiderResult {
        val raw = call.getOrNull() ?: return fallback
        if (raw.isBlank()) return fallback
        return runCatching { gson.fromJson(raw, SpiderResult::class.java) }
            .map { r ->
                // list/class/filters 自动通过 Gson 注入；兜底把 list 元素转成 Vod
                r.copy(
                    list = r.list ?: emptyList(),
                    pagecount = if (r.pagecount <= 0) 1 else r.pagecount,
                )
            }
            .getOrDefault(fallback)
    }
}

/** CatVod Cookie 桥：当前应用没有 WebView cookie 存储，先返回空 */
private object AppCookies : Net.Cookies {
    override fun getCookie(url: String): String = ""
    override fun setCookie(url: String, cookie: String): Boolean = false
}
