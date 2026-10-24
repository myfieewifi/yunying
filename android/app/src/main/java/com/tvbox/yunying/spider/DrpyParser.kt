package com.tvbox.yunying.spider

/**
 * js.md (drpy / drpy2 / 海阔视界) 格式解析器（安卓版）。
 *
 * 与 apple-patches/Sources/TVCore/DrpyParser.swift 逻辑完全一致：
 * 从 Markdown 文本中抽取 ```js ... ``` 代码块，与 drpy 模板库（模板.js）拼合，
 * 交给 QuickJS 执行，使 js.md 源能与普通 .js 爬虫走同一条调用路径。
 */
object DrpyParser {

    /**
     * 把 js.md 原文解析为可直接 eval 的 JS 源码。
     * @param markdown js.md / .md 原文
     * @param template drpy 模板库（模板.js）内容；null 时使用内置精简版
     */
    fun parse(markdown: String, template: String? = null): String {
        val blocks = extractCodeBlocks(markdown)
        val body = if (blocks.isEmpty()) {
            markdown.trim()
        } else {
            blocks.filter { (lang, _) ->
                val l = lang?.lowercase() ?: return@filter true
                l == "js" || l == "javascript" || l.isEmpty()
            }.joinToString("\n\n") { it.content }
        }
        val wrapped = wrapAsSpider(body)
        val tpl = template ?: DEFAULT_TEMPLATE
        return "$tpl\n\n$wrapped"
    }

    fun isDrpy(url: String?): Boolean {
        val s = url?.lowercase()?.trim() ?: return false
        val path = s.split('?').first()
        return path.endsWith(".js.md") || path.endsWith(".md") || path.contains(".js.md")
    }

    // ----- 内部 -----

    private data class Block(val lang: String?, val content: String)

    private fun extractCodeBlocks(text: String): List<Block> {
        val re = Regex("```([a-zA-Z0-9_-]*)\\s*\\r?\\n([\\s\\S]*?)```")
        return re.findAll(text).map { m ->
            val lang = m.groupValues[1].ifEmpty { null }
            Block(lang, m.groupValues[2])
        }.toList()
    }

    private fun wrapAsSpider(body: String): String {
        val out = StringBuilder(";(function(){\n")
        val hasVarRule = Regex("""(var|let|const)\s+rule\s*=""").containsMatchIn(body)
        val hasExport = Regex("""export\s+default""").containsMatchIn(body)
        when {
            hasExport -> out.append(body.replace(Regex("""export\s+default\s*"""), "var rule = "))
            hasVarRule -> out.append(body)
            else -> {
                out.append("var rule = (function(){\n").append(body).append("\n})();\n")
            }
        }
        out.append(
            """
            |if (typeof Spider === 'undefined' && typeof rule === 'object') {
            |  __drpy_rule = rule;
            |  Spider = function(){ this.extend = (rule.ext || ''); };
            |  Spider.prototype.init = function(ext){ this.extend = ext; };
            |  Spider.prototype.getDependence = function(){ return rule.depends || []; };
            |  Spider.prototype.homeContent = function(f){ return JSON.stringify(rule.homeContent ? rule.homeContent(f) : {'class':[],'list':[]}); };
            |  Spider.prototype.categoryContent = function(t,p,f,ex){ return JSON.stringify(rule.categoryContent ? rule.categoryContent(t,p,f,ex) : {'list':[]}); };
            |  Spider.prototype.searchContent = function(wd,quick,p){ return JSON.stringify(rule.searchContent ? rule.searchContent(wd,quick,p) : {'list':[]}); };
            |  Spider.prototype.detailContent = function(ids){ return JSON.stringify(rule.detailContent ? rule.detailContent(ids) : {'list':[]}); };
            |  Spider.prototype.playerContent = function(flag,id,flags){ return rule.playerContent ? rule.playerContent(flag,id,flags) : ''; };
            |}
            |})();
            """.trimMargin()
        )
        return out.toString()
    }

    /**
     * 精简版 drpy 模板库（template）。真实模板.js 很长（约 3000+ 行，包含 request/pdfh/pdfa/pd/$/$44/...），
     * 实际项目里应从 TVBox 社区模板.js 原文件作为 Asset 加载。这里给出最小可运行骨架保证编译通过。
     */
    private val DEFAULT_TEMPLATE = """
        var __drpy_rule = null;
        var __this = this;
        function request(url, opts) { return org.jsoup.Jsoup.connect(url).ignoreContentType(true).execute().body(); }
        function pdfh(html, rule, parse_url) { return html; }
        function pdfa(html, rule, parse_url) { return []; }
        function pd(html, rule) { return html; }
        function $(a,b,c){ return ''; }
        function $44(){ return ''; }
        function getProxyUrl(p) { return p; }
    """.trimIndent()
}
