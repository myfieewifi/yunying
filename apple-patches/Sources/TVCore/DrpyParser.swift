import Foundation

/// js.md (drpy / drpy2 / 海阔视界) 格式解析器。
///
/// js.md 文件结构（Markdown）：
///   # 源名称
///   任意说明文字……
///   ```js
///   var rule = {
///     title: 'xxx',
///     host: 'https://xxx.com',
///     url: '/fyclass[/fyfilter]/fypage.html',
///     // ... drpy 字段
///   }
///   ```
///
/// 解析目标：
///   1. 抽出 ```js / ```javascript 代码块；
///   2. 与 TVCore 自带的「模板.js」（drpy 模板库）拼合成可执行 JS；
///   3. 包装为与映匣原生 JS 爬虫兼容的 `Spider` 对象，再由 ScriptRuntime / QuickJS 直接执行；
///   4. 支持多代码块（drpy2 常见：rule 块 + 额外 helper 块）。
///
/// 兼容：
///   - 海阔视界 drpy 原生格式（rule 变量 + 模板.js 提供的 $、$44、request、pdfa 等）
///   - drpy2 格式（export default / rule 对象 / 新版 api）
///   - 旧式 ```javascript 块、无 fence 的纯 JS（直接返回原文本）
public enum DrpyParser {

    /// 从 js.md / .md 文本中抽取可执行的 JS 源码。
    /// - Parameters:
    ///   - markdown: js.md 文件原文
    ///   - template: TVCore 内置「模板.js」（drpy 运行时库）原文；nil 则不拼合
    /// - Returns: 可直接交给 QuickJS 执行的完整 JS 字符串
    public static func parse(markdown: String, template: String?) -> String {
        let blocks = extractCodeBlocks(from: markdown)
        var body: String

        if blocks.isEmpty {
            // 没有 fence 代码块：整个文件当 JS 处理（兼容一些直接放 JS 的 drpy 源）
            body = markdown.trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            // 按出现顺序拼接所有 js/javascript 代码块
            body = blocks
                .filter { lang in
                    guard let lang = lang?.lowercased() else { return true } // 无语言标注也视为 JS（drpy2 常见）
                    return lang == "js" || lang == "javascript" || lang.isEmpty
                }
                .map { $0.content }
                .joined(separator: "\n\n")
        }

        // 包裹为 TVBox Spider 接口（homeContent/searchContent/...）
        let wrapped = wrapAsSpider(body: body)

        if let template = template, !template.isEmpty {
            // 模板.js 先注入，再放 Spider 包装；模板里定义了 request/$/$44/pdfa/init 等 drpy 标准库
            return template + "\n\n" + wrapped
        } else {
            return wrapped
        }
    }

    /// 识别 spider 字段的 ext / api 是否指向 js.md。
    public static func isDrpySource(_ extOrUrl: String?) -> Bool {
        guard let s = extOrUrl?.lowercased().trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
        let path = s.split(separator: "?", maxSplits: 1).first.map(String.init) ?? s
        return path.hasSuffix(".js.md") || path.hasSuffix(".md") || path.contains(".js.md")
    }

    // MARK: - 内部实现

    /// 单个代码块
    private struct CodeBlock {
        let lang: String?
        let content: String
    }

    /// 扫描 Markdown，抽取所有 ```lang ... ``` 代码块
    private static func extractCodeBlocks(from text: String) -> [CodeBlock] {
        let ns = text as NSString
        let pattern = "```([a-zA-Z0-9_-]*)\\s*\\r?\\n([\\s\\S]*?)```"
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else { return [] }
        let matches = regex.matches(in: text, options: [], range: NSRange(location: 0, length: ns.length))
        return matches.compactMap { m in
            guard m.numberOfRanges >= 3 else { return nil }
            let langRange = m.range(at: 1)
            let contentRange = m.range(at: 2)
            let lang = langRange.length > 0 ? ns.substring(with: langRange) : nil
            let content = ns.substring(with: contentRange)
            return CodeBlock(lang: lang, content: String(content))
        }
    }

    /// 将 drpy 的 rule 对象包装为 TVBox 期望的 Spider 类。
    ///
    /// drpy 规则对象对外暴露这些字段（由模板.js 实现调用）：
    ///   - 首页: rule.homeUrl / rule.homeParse
    ///   - 分类: rule.classUrl / rule.parse
    ///   - 搜索: rule.searchUrl / rule.searchParse
    ///   - 详情: rule.detailUrl / rule.detailParse
    ///   - 播放: rule.playUrl / rule.playParse
    /// 模板.js 已经负责提供 request / pdfh / pdfa / $ / $44 等工具函数并实现 Spider 类，
    /// 但它要求 rule 变量在全局作用域可用；我们这里兼容两种情况：
    ///   1. 代码里已经 `var rule = {...}`（老 drpy），直接用；
    ///   2. 代码是 `export default {...}` 或直接 `{...}`（drpy2 / 新式），提取对象赋给 rule。
    private static func wrapAsSpider(body: String) -> String {
        var out = ";(function(){\n"

        // 1. 若源码里已经定义了 var/let/const rule，就直接放进去
        // 2. 否则尝试识别 export default { ... } 形式
        let hasVarRule = body.range(of: #"(var|let|const)\s+rule\s*="#, options: .regularExpression) != nil
        let hasExportDefault = body.range(of: #"export\s+default"#, options: .regularExpression) != nil

        if hasExportDefault {
            // 把 `export default { ... }` 改为 `var rule = { ... }`
            out += body.replacingOccurrences(of: #"export\s+default\s*"#, with: "var rule = ", options: .regularExpression)
            out += "\n"
        } else if hasVarRule {
            out += body
            out += "\n"
        } else {
            // 直接对象字面量（或函数 IIFE），包成 rule
            out += "var rule = (function(){\n"
            out += body
            out += "\n})();\n"
        }

        // 3. 如果模板.js 没注入时（template 为 nil），这里兜底一个最小 Spider，
        //    让上层在拿到错误时不会直接崩。通常注入了模板.js 就不会走这个分支。
        out += """
        if (typeof Spider === 'undefined' && typeof rule === 'object') {
          Spider = function() {
            this.__drpy = true;
          };
          Spider.prototype.init = function(ext) { this.extend = ext; };
          Spider.prototype.getDependence = function() { return rule.depends || []; };
          Spider.prototype.homeContent = function(filter) {
            return JSON.stringify({ 'class': rule.class_parse ? rule.class_parse() : [], 'list': [] });
          };
        }
        })();
        """
        return out
    }
}

// MARK: - Site.swift 扩展：识别 js.md 为 js 运行时

public extension Site {
    /// 扩展映匣原生 Site 类型，让 `.js.md` / `.md` 源走 JavaScript 运行时。
    /// 该扩展需要在主工程里配合 Site 源码调整：检测 `api` / `ext` 后缀为 js.md 时，runtime 设为 .javascript，
    /// 并在加载脚本前用 DrpyParser.parse 把 md 预处理成 JS。
}
