#!/usr/bin/env python3
# YunYing iOS 16 兼容转换器：把映匣源码从 iOS 17/18 绑定降级到 iOS 16 可编译。
#
# 1) @Observable → ObservableObject（存储属性加 @Published；子模型在 init 末尾用 Combine 合流转发）
# 2) @Environment(T.self) → @EnvironmentObject；.environment(obj) → .environmentObject(obj)
# 3) @Bindable → YyBind 局部包装（iOS 17 专属局部属性包装器）或 @ObservedObject
# 4) iOS 17+ 视图 API 的文本替换 / 平衡括号删除
# 5) 结构性补丁：GlassKit、DiscoveryView 的 ScrollStrip、HomeView、MusicRemoteControl
# 6) project.yml 部署目标 iOS 18.0 → 16.0
import sys
import pathlib
import re

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

ROOT = pathlib.Path(sys.argv[1])
SRC = ROOT / 'yingxia-src'

warnings = []
converted = []   # 已转换类名

# ────────────────────────── 基础工具 ──────────────────────────

def brace_delta(line: str) -> int:
    s = re.sub(r'//.*', '', line)
    s = re.sub(r'"(?:\\.|[^"\\])*"', '""', s)
    s = re.sub(r'\$"(?:\\.|[^\\"$]|\$\([^)]*\))*"', '""', s)
    return s.count('{') - s.count('}')


def walk(paths):
    files = []
    for d in paths:
        if d.is_dir():
            files.extend(sorted(d.rglob('*.swift')))
    return files


def find_matching_end(lines, start, base):
    """从 start 行（包含其自身的 brace 增量）向后找平衡结束行；base 为开始计深度的初值。"""
    d = base
    for i in range(start, len(lines)):
        d += brace_delta(lines[i])
        if d <= 0:
            return i
    return len(lines) - 1


def depth_before(lines, start, end, base):
    """返回 [start..end] 每一行“处理前”的深度列表（base 为 start 行处理前的深度）。"""
    out = []
    d = base
    for i in range(start, end + 1):
        out.append(d)
        d += brace_delta(lines[i])
    return out

# ────────────────────────── 手工精确补丁 ──────────────────────────

def patch_text(rel, old, new, label):
    p = SRC / rel
    if not p.exists():
        warnings.append(f'missing {rel}')
        return
    s = p.read_text(encoding='utf-8')
    if f'// YunYing marker: {label}' in s:
        warnings.append(f'"{label}" already applied to {rel}')
        return
    if old not in s:
        warnings.append(f'"{label}" pattern not found in {rel}')
        return
    p.write_text(s.replace(old, new, 1) + f'\n// YunYing marker: {label}', encoding='utf-8')
    print(f'  patched {rel}: {label}')


IOS_STRUCT_SCROLLSTRIP = '''/// iOS 16 简化版（YunYing 补丁）：没有 ScrollPosition/onScrollGeometryChange 这些 iOS 18 API。
/// 保留横滑与外部 scrollTo 定位；边界渐隐与 Mac 拖拽由 #else 分支的原 iOS 17+ 实现承担。
struct ScrollStrip<Content: View>: View {
    let scrollTo: String?
    let leftLabel: String
    let rightLabel: String
    var overlayArrows = false
    var arrowCenter: CGFloat?
    let content: Content

    init(scrollTo: String? = nil, leftLabel: String = "Scroll left", rightLabel: String = "Scroll right",
         overlayArrows: Bool = false, arrowCenter: CGFloat? = nil, @ViewBuilder content: () -> Content) {
        self.scrollTo = scrollTo
        self.leftLabel = leftLabel
        self.rightLabel = rightLabel
        self.overlayArrows = overlayArrows
        self.arrowCenter = arrowCenter
        self.content = content()
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    content
                }
            }
            .onAppear { if let scrollTo { proxy.scrollTo(scrollTo, anchor: .center) } }
            .onChange(of: scrollTo) { target in
                if let target { proxy.scrollTo(target, anchor: .center) }
            }
        }
    }
}'''


def patch_scrollstrip():
    p = SRC / 'App' / 'DiscoveryView.swift'
    if not p.exists():
        warnings.append('missing App/DiscoveryView.swift')
        return
    text = p.read_text(encoding='utf-8')
    if 'ScrollStrip iOS16 rewrite marker' in text:
        warnings.append('scrollstrip already applied')
        return
    lines = text.split('\n')
    start = next((i for i, l in enumerate(lines) if 'struct ScrollStrip<Content: View>: View {' in l), None)
    if start is None:
        warnings.append('ScrollStrip declaration not found in DiscoveryView.swift')
        return
    end = find_matching_end(lines, start, 0)
    original = '\n'.join(lines[start:end + 1])
    replacement = ('#if os(iOS)\n' + IOS_STRUCT_SCROLLSTRIP + '\n#else\n'
                   + original + '\n#endif\n// ScrollStrip iOS16 rewrite marker')
    new_text = '\n'.join(lines[:start]) + '\n' + replacement + '\n' + '\n'.join(lines[end + 1:])
    p.write_text(new_text, encoding='utf-8')
    print('  patched App/DiscoveryView.swift: ScrollStrip iOS16 rewrite')

# ────────────────────────── 视图 API 文本级处理 ──────────────────────────

def spring_map(text):
    def one(m):
        dur = float(m.group(1))
        if m.group(2) is None:
            return f'.spring(response: {dur:.2f})'
        bounce = float(m.group(2))
        return f'.spring(response: {dur:.2f}, dampingFraction: {max(0.05, min(1.0, 1.0 - bounce)):.2f})'
    return re.sub(r'\.spring\(duration: ([\d.]+)(?:, bounce: ([\d.]+))?\)', one, text)


def rewrite_zero_param_onchange(text):
    """iOS17 的 onChange(of:_:) 有零参数闭包形态；iOS16 只有 onChange(of:perform:)（单参）。
    把零参数闭包 `）{ body }` 改写为 `）{ _, _ in body }`，匹配 shims 里的双参数实现。
    闭包体含 ` in`（iOS16 的两参/单参源码形态）则保持原样。"""
    pattern = re.compile(r'(\.onChange\(of: [^{}\n]*?\)\s*)\{([^{}]*)\}')

    def repl(m):
        head, body = m.group(1), m.group(2)
        if re.search(r'\bin\b', body):
            return m.group(0)
        stripped = re.sub(r'\s+', ' ', body.strip())
        return f'{head}{{ _, _ in {stripped} }}' if stripped else f'{head}{{ _, _ in }}'

    return pattern.sub(repl, text)


def numeric_text_downgrade(text):
    """numericText(value:) 需要 iOS 17；且 Xcode 26 SDK 下 iOS16 的 .numericText 属性
    也已不可访问（报 need to call numericText(countsDown:)），统一换成 ContentTransition.opacity。"""
    return re.sub(r'\.numericText\(value:\s*[^()]+?\)', '.opacity', text)


def symbol_effect_downgrade(text):
    """symbolEffect 需要 iOS 17；已知的两处调用点直接删除修饰符（仅视觉动画损失）。
    GlassKit breathingSymbol 由 manual_patches 单独处理（保留 if #available 分支）。"""
    text = re.sub(r'\.symbolEffect\(\.bounce,\s*value:\s*[A-Za-z0-9_.]+?\)', '', text)
    return text.replace('.symbolEffect(.variableColor.iterative)', '')


def _find_matching_brace(text, start):
    """从 start（应指向 '{'）返回匹配 '}' 的下标；找不到返回 len(text)。"""
    depth = 0
    for i in range(start, len(text)):
        c = text[i]
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return i
    return len(text)


def toolbar_disambiguate(text):
    """Xcode 26 SDK 把 ToolbarItem 归入 View，令 `.toolbar { ToolbarItem(...) }` 与
    toolbar(content:) 的 ViewBuilder/ToolbarContentBuilder 两候选二义。
    含 ToolbarItem 的块改写为 `.yyToolbar {`（shim 显式泛型 ToolbarContent 档）。"""
    marker = '.toolbar {'
    idx = 0
    while True:
        i = text.find(marker, idx)
        if i < 0:
            return text
        j = text.find('{', i)
        k = _find_matching_brace(text, j)
        block = text[j:k]
        if re.search(r'\bToolbarItem(?:Group)?\s*\(', block):
            text = text[:i] + '.yyToolbar {' + text[i + len(marker):]
            idx = i + len('.yyToolbar {')
        else:
            idx = i + len(marker)


def balanced_delete(text, name):
    token = '.' + name + '('
    while True:
        idx = text.find(token)
        if idx < 0:
            return text
        i = idx + len(token)
        depth = 1
        n = len(text)
        while i < n and depth > 0:
            c = text[i]
            if c == '(':
                depth += 1
            elif c == ')':
                depth -= 1
            i += 1
        # 若紧跟着尾随闭包 `{ ... }`（如 sensoryFeedback），一并吞掉，避免残留
        j = i
        while j < n and text[j] in ' \t\r\n':
            j += 1
        if j < n and text[j] == '{':
            k, bdepth = j, 0
            while k < n:
                c = text[k]
                if c == '{':
                    bdepth += 1
                elif c == '}':
                    bdepth -= 1
                    if bdepth == 0:
                        break
                k += 1
            i = k + 1
        text = text[:idx] + text[i:]


def balanced_delete_brace(text, name):
    """删除 `.name { ... }`（闭包参数修饰符），平衡大括号。"""
    token = '.' + name + ' '
    while True:
        idx = text.find(token)
        if idx < 0:
            return text
        brace = text.find('{', idx)
        # 必须紧邻（ inspira：中间只能是空格/换行）
        if brace < 0 or brace - idx > len(token) + 4:
            return text
        i, depth, n = brace, 0, len(text)
        while i < n:
            c = text[i]
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    break
            i += 1
        text = text[:idx] + text[i + 1:]

# ────────────────────────── 类转换 ──────────────────────────

def convert_classes(lines):
    """就地转换所有 @Observable 类。返回是否修改过、新增类名列表。"""
    modified = False
    added = []
    guard = 0
    while any('@Observable' in l for l in lines) and guard < 40:
        guard += 1
        idx = next((i for i, l in enumerate(lines) if '@Observable' in l), None)
        if idx is None:
            break
        decl = None
        if re.search(r'\bclass\b', lines[idx]):
            decl = idx
        elif idx + 1 < len(lines) and re.search(r'\bclass\b', lines[idx + 1]):
            # @Observable 独立行：删除标记行，类声明上移到 idx
            del lines[idx]
            modified = True
            decl = idx
            idx = decl
        else:
            # 非类定义（注释等）：仅剥标记
            lines[idx] = lines[idx].replace('@Observable', '')
            modified = True
            continue
        # 1) 剥标记
        lines[decl] = re.sub(r'\s*@Observable\s*', ' ', lines[decl], count=1)
        modified = True
        dline = lines[decl]
        m = re.search(r'\bclass\s+([A-Za-z0-9_]+)', dline)
        if not m:
            continue
        name = m.group(1)
        if name not in converted and name not in added:
            added.append(name)
        close = dline.rfind('{')
        colon = dline[m.end():close].find(':')
        if colon >= 0:
            lines[decl] = dline[:close] + ', ObservableObject' + dline[close:]
        else:
            lines[decl] = dline[:close] + ': ObservableObject ' + dline[close:]
        dline = lines[decl]
        # 类体范围：从 decl 行起平衡
        end = find_matching_end(lines, decl, 0)
        depths = depth_before(lines, decl + 1, len(lines) - 1, 1)
        children = []
        for k, i in enumerate(range(decl + 1, end + 1)):
            if depths[k] != 1:
                continue
            s = lines[i].strip()
            mm = (re.match(r'^(?:public\s+|private\s+|internal\s+|fileprivate\s+)?let\s+([A-Za-z0-9_]+)\s*=\s*([A-Za-z0-9_.]+)', s)
                  or re.match(r'^(?:public\s+|private\s+|internal\s+|fileprivate\s+)?let\s+([A-Za-z0-9_]+):\s*([A-Za-z0-9_.]+)', s))
            if not mm:
                continue
            pname, typ = mm.group(1), mm.group(2).split('(')[0].split(':')[0].strip()
            if typ in converted or typ in added:
                if pname not in children:
                    children.append(pname)
        if not children:
            # 无子模型：仍然要做 @Published 注解
            annotate_published(lines, decl, end)
            modified = True
            continue
        hook_args = ', '.join(children)
        # init 注入：收集所有显式 init，倒序处理避免插入错位；体里已带 _yyHookChildren 的跳过
        depths0 = depth_before(lines, decl + 1, len(lines) - 1, 1)
        end0 = find_matching_end(lines, decl, 0)
        inits = []
        for k, xx in enumerate(range(decl + 1, end0 + 1)):
            if depths0[k] == 1 and re.match(r'^(?:nonisolated\s+)?(?:public\s+)?(?:private\s+)?init\b', lines[xx].strip()):
                inits.append(xx)
        for pos in reversed(inits):
            iend = find_matching_end(lines, pos, 0)
            if any('_yyHookChildren' in lines[zz] for zz in range(pos, iend + 1)):
                continue
            indent = re.match(r'\s*', lines[pos]).group(0)
            lines.insert(iend, f'{indent}_yyHookChildren([{hook_args}])')
            modified = True
        # 没有 init：补一个便捷 init
        if not inits:
            indent = re.match(r'\s*', lines[decl]).group(0) + '    '
            lines.insert(end, f'{indent}init() {{ _yyHookChildren([{hook_args}]) }}')
            modified = True
        # deinit 注入
        depths = depth_before(lines, decl + 1, len(lines) - 1, 1)
        end = find_matching_end(lines, decl, 0)
        dpos = next((xx for k, xx in enumerate(range(decl + 1, end + 1))
                     if depths[k] == 1 and lines[xx].strip().startswith('deinit')), None)
        if dpos is None:
            indent = re.match(r'\s*', lines[decl]).group(0) + '    '
            lines.insert(end, f'{indent}deinit {{ _yyDropChildren() }}')
            modified = True
        else:
            if '_yyDropChildren' not in lines[dpos]:
                dend = find_matching_end(lines, dpos, 0)
                indent = re.match(r'\s*', lines[dpos]).group(0)
                lines.insert(dend, f'{indent}_yyDropChildren()')
                modified = True
        # @Published 注解（类直属作用域）
        annotate_published(lines, decl, end)
    return modified, added


def annotate_published(lines, decl, end):
    depths = depth_before(lines, decl + 1, len(lines) - 1, 1)
    end = find_matching_end(lines, decl, 0)
    for k, xx in enumerate(range(decl + 1, end + 1)):
        if depths[k] != 1:
            continue
        ln = lines[xx]
        s = ln.strip()
        if '@ObservationIgnored' in s or '@Published' in s or 'lazy' in s:
            continue
        head = ln.split('//')[0]
        if 'static' in head.split():
            continue
        m4 = re.match(r'^((?:public\s+|private\s*\(set\)\s+|private\s+|internal\s+|fileprivate\s+|open\s+)*var\b)', s)
        if not m4:
            continue
        clause = head.strip()
        after = clause.split('var', 1)[1] if 'var' in clause else ''
        # 计算属性判定：'{' 出现在任何 '=' 之前（'=' 在 body 里的 == 不算赋值）
        pos_brace = after.find('{')
        pos_eq = after.find('=')
        if pos_brace != -1 and (pos_eq == -1 or pos_eq > pos_brace) and 'didSet' not in after and 'willSet' not in after:
            # 声明行只有 { 的可能是存储属性+observers（didSet/willSet 在后面几行）：向前看
            ok = False
            for look in range(xx + 1, min(xx + 8, end)):
                nxt = lines[look]
                if 'didSet' in nxt or 'willSet' in nxt:
                    ok = True
                    break
                if re.match(r'^\s*(?:var|let|func|init|deinit|enum|struct|extension|@)\b', nxt):
                    break
            if not ok:
                continue
        if '=' not in head:
            if re.search(r'\?(\s*)$', head.rstrip()):
                ln = ln.rstrip() + ' = nil'
        indent = re.match(r'\s*', ln).group(0)
        lines[xx] = indent + '@Published ' + ln[len(indent):]

# ────────────────────────── 单文件主流程 ──────────────────────────

def process_file(path):
    original = path.read_text(encoding='utf-8')
    rel = str(path.relative_to(SRC))
    text = original

    # 全局小替换
    text = text.replace('import Observation', 'import Combine')
    text = re.sub(r'\.smooth\(', '.easeInOut(', text)
    text = spring_map(text)
    text = text.replace('.contentTransition(.symbolEffect(.replace))', '')
    text = numeric_text_downgrade(text)
    text = symbol_effect_downgrade(text)
    text = rewrite_zero_param_onchange(text)
    # transition(.blurReplace) 需要 iOS 17；iOS 16 用普通 opacity 过渡
    text = text.replace('.transition(.blurReplace)', '.transition(.opacity)')
    # ScrollView 无参尾闭调用在 Xcode 26 SDK 下与 init(_:content:) 新候选二义；
    # 显式 showsIndicators 让新候选不适用（它没有该参数）
    text = re.sub(r'(?<![\w.])ScrollView \{', 'ScrollView(.vertical, showsIndicators: true) {', text)
    # toolbar 且内容含 ToolbarItem 的块改写为 .yyToolbar {（消 Xcode 26 SDK 二义）
    text = toolbar_disambiguate(text)
    # 平衡删除
    for name in ('scrollIndicators', 'scrollTargetLayout', 'sensoryFeedback', 'contentMargins'):
        text = balanced_delete(text, name)
    text = balanced_delete_brace(text, 'onScrollPhaseChange')
    # ContentUnavailableView → CUV（shim 自身文件除外）
    if 'Shims' not in path.name:
        text = text.replace('ContentUnavailableView', 'CUV')

    # @Environment(T.self) → @EnvironmentObject（限已转换类；类型补到同一行的 var 声明上）
    out_lines = []
    for line in text.split('\n'):
        m = re.match(r'^(\s*)@Environment\(([A-Za-z][A-Za-z0-9_]*)\.self\)(.*)$', line)
        if m and m.group(2) in converted:
            indent, ty, rest = m.group(1), m.group(2), m.group(3)
            rest2 = re.sub(r'\bvar\b(\s+)([A-Za-z0-9_]+)', rf'var\1\2: {ty}', rest, count=1)
            out_lines.append(f'{indent}@EnvironmentObject {rest2.lstrip()}')
            continue
        out_lines.append(line)
    text = '\n'.join(out_lines)

    # .environment(obj) → .environmentObject(obj)（上游对象注入的固定形态）
    text = re.sub(r'\.environment\((store|updates|announcements)\)', r'.environmentObject(\1)', text)

    # @Bindable 属性级 → @ObservedObject
    text = re.sub(r'@Bindable\s+(var\s+[A-Za-z0-9_]+\s*:\s*[A-Za-z][A-Za-z0-9_<>.,\s]*)$', r'@ObservedObject \1', text,
                  flags=re.M | re.S)
    # 局部级：顺序扫描
    lines = text.split('\n')
    binding_map = {}
    final = []
    pat_local = re.compile(r'^(\s*)@Bindable\s+var\s+([A-Za-z0-9_]+)\s*=\s+(.+?)(\s*)$')
    for line in lines:
        m = pat_local.match(line)
        if m:
            indent, name, expr, _t = m.groups()
            wrapper = f'_yyB{name}'
            binding_map[name] = wrapper
            final.append(f'{indent}let {name} = {expr}')
            final.append(f'{indent}let {wrapper} = YyBind({expr})')
            continue
        for name, wrapper in binding_map.items():
            line = re.sub(r'(?<![\w.])\$' + re.escape(name) + r'\b', wrapper, line)
        final.append(line)
    text = '\n'.join(final)

    original_pre_class = text
    # 类转换（@Observable → ObservableObject 等）
    lines = text.split('\n')
    _mod, _added = convert_classes(lines)
    text = '\n'.join(lines)

    # ObservationIgnored 清理
    text = re.sub(r'@\s*ObservationIgnored\s*', '', text)
    path.write_text(text, encoding='utf-8')
    if text != original:
        print(f'  transformed {rel}')
    return text != original_pre_class or text != original

# ────────────────────────── 手工补丁 ──────────────────────────

def manual_patches():
    # 上游新代码在 Xcode 26.5 下：闭包捕获了后面才声明的局部 `var sites = sites`，把声明挪到前面。
    patch_text('Sources/TVCore/ScriptSniffing.swift',
               '''        let pending = sites.indices.filter { sites[$0].needsSniffing }
        guard !pending.isEmpty else { return self }
        var sites = sites''',
               '''        var sites = sites
        let pending = sites.indices.filter { sites[$0].needsSniffing }
        guard !pending.isEmpty else { return self }''',
               'ScriptSniffing capture-before-declaration')

    patch_text('App/GlassKit.swift',
               'extension EnvironmentValues { @Entry var stripDrag: StripDrag? = nil }',
               '''/// YunYing iOS16 补丁：@Entry 需要 iOS 18 宏展开，改为手写 EnvironmentKey。
private struct StripDragEnvironmentKey: EnvironmentKey {
    static let defaultValue: StripDrag? = nil
}
extension EnvironmentValues {
    var stripDrag: StripDrag? {
        get { self[StripDragEnvironmentKey.self] }
        set { self[StripDragEnvironmentKey.self] = newValue }
    }
}''', '@Entry → EnvironmentKey')

    patch_text('App/GlassKit.swift',
               '''        } else {
            onGeometryChange(for: Bool.self) { geometry in
                let own = CGRect(origin: .zero, size: geometry.size)
                guard own.width * own.height > 0, let viewport = geometry.bounds(of: .scrollView) else { return false }
                let shown = own.intersection(viewport)
                return !shown.isNull && shown.width * shown.height >= own.width * own.height * threshold
            } action: { action($0) }
        }''',
               '''        } else {
            // YunYing iOS16 补丁：onGeometryChange/onScrollVisibilityChange 需要 iOS18+，改用全局坐标近似
            _yyScrolledIntoView(threshold: threshold, action)
        }''', 'onScrolledIntoView')

    patch_text('App/GlassKit.swift',
               '''        } else {
            symbolEffect(.pulse, options: .repeating.speed(0.4))
        }''',
               '''        } else {
            self // YunYing iOS16 补丁：symbolEffect 需要 iOS 17+，退化为静态图标
        }''', 'breathingSymbol')

    patch_text('App/GlassKit.swift',
               '''        let environment = EnvironmentValues()
        let from = resolve(in: environment), to = other.resolve(in: environment)
        // Resolved components are linear; blending gamma-encoded values looks closer to mix's perceptual default.
        func encoded(_ linear: Float) -> Double { Double(pow(max(0, linear), 1 / 2.2)) }
        func mixed(_ a: Float, _ b: Float) -> Double { encoded(a) + (encoded(b) - encoded(a)) * fraction }
        return Color(.sRGB, red: mixed(from.red, to.red), green: mixed(from.green, to.green), blue: mixed(from.blue, to.blue),
                     opacity: Double(from.opacity + (to.opacity - from.opacity) * Float(fraction)))''',
               '''        // YunYing iOS16 补丁：Color.Resolved 是 iOS17+，iOS16 用 UIColor 提取分量混色（其他平台保留 resolve）
        #if os(iOS)
        let frac = CGFloat(fraction)
        var rf = CGFloat(0), gf = CGFloat(0), bf = CGFloat(0), af = CGFloat(0)
        UIColor(self).getRed(&rf, green: &gf, blue: &bf, alpha: &af)
        var rr = CGFloat(0), rg = CGFloat(0), rb = CGFloat(0), ra = CGFloat(0)
        UIColor(other).getRed(&rr, green: &rg, blue: &rb, alpha: &ra)
        func blendMix(_ a: CGFloat, _ b: CGFloat) -> CGFloat { a + (b - a) * frac }
        return Color(.sRGB, red: Double(blendMix(rf, rr)), green: Double(blendMix(gf, rg)), blue: Double(blendMix(bf, rb)),
                     opacity: Double(blendMix(af, ra)))
        #else
        let environment = EnvironmentValues()
        let from = resolve(in: environment), to = other.resolve(in: environment)
        // Resolved components are linear; blending gamma-encoded values looks closer to mix's perceptual default.
        func encoded(_ linear: Float) -> Double { Double(pow(max(0, linear), 1 / 2.2)) }
        func mixed(_ a: Float, _ b: Float) -> Double { encoded(a) + (encoded(b) - encoded(a)) * fraction }
        return Color(.sRGB, red: mixed(from.red, to.red), green: mixed(from.green, to.green), blue: mixed(from.blue, to.blue),
                     opacity: Double(from.opacity + (to.opacity - from.opacity) * Float(fraction)))
        #endif''', 'GlassKit blend UIColor path')

    patch_text('App/HomeView.swift',
               '        .containerRelativeFrame(.vertical, alignment: .center) { height, _ in height * 0.82 }',
               '''        #if os(iOS)
        // YunYing iOS16 补丁：containerRelativeFrame 需要 iOS17+，按整屏高度的 0.82 近似
        .frame(height: max(1.0, UIScreen.main.bounds.height * 0.82))
        #else
        .containerRelativeFrame(.vertical, alignment: .center) { height, _ in height * 0.82 }
        #endif''', 'HomeView containerRelativeFrame')

    patch_text('App/MusicRemoteControl.swift',
               '''    private func observe() {
        withObservationTracking { _ = state } onChange: { [weak self] in
            Task { @MainActor [weak self] in self?.update(); self?.observe() }
        }
    }''',
               '''    // YunYing iOS16 补丁：Observation 的追踪回调需要 iOS 17+，改为轻量轮询
    private var shownState: State? = nil
    private var loop: Task<Void, Never>? = nil

    private func observe() {
        shownState = state
        loop?.cancel()
        loop = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                if let self = self {
                    let current = self.state
                    if current != self.shownState {
                        self.shownState = current
                        self.update()
                    }
                }
                try? await Task.sleep(nanoseconds: 400_000_000)
            }
        }
    }''', 'MusicRemoteControl observe → 轮询')

    patch_scrollstrip()


def product_renames():
    """云映产品化：所有 .strings 与 project.yml 里的 映匣/Yingxia 显示名 → 云映。"""
    for path in sorted(SRC.rglob('*.strings')):
        s = path.read_text(encoding='utf-8')
        new = s.replace('映匣', '云映').replace('"Yingxia"', '"云映"')
        if new != s:
            path.write_text(new, encoding='utf-8')
            print(f'  renamed display-name in {path.relative_to(SRC)}')
    py = SRC / 'project.yml'
    if py.exists():
        s = py.read_text(encoding='utf-8')
        for old, new in (('INFOPLIST_KEY_CFBundleDisplayName: Yingxia', 'INFOPLIST_KEY_CFBundleDisplayName: 云映'),
                         ('CFBundleDisplayName: Yingxia', 'CFBundleDisplayName: 云映')):
            if old in s:
                s = s.replace(old, new, 1)
        py.write_text(s, encoding='utf-8')


def product_versions():
    """版本号初始化为 1.0（marketing 1.0.0 / build 1）。"""
    py = SRC / 'project.yml'
    if not py.exists():
        warnings.append('product_versions: missing project.yml')
        return
    s = py.read_text(encoding='utf-8')
    new = s.replace("MARKETING_VERSION: '1.7.13'", "MARKETING_VERSION: '1.0.0'", 1)
    new = new.replace("CURRENT_PROJECT_VERSION: '32'", "CURRENT_PROJECT_VERSION: '1'", 1)
    if new == s:
        warnings.append("product_versions: MARKETING_VERSION/CURRENT_PROJECT_VERSION patterns not found")
    py.write_text(new, encoding='utf-8')


def product_patches():
    """云映产品化补丁：改名、版本 1.0、关闭更新/新功能模块、删除问题反馈入口。"""
    product_renames()
    product_versions()

    # 1) 强制更新渠道为 none：关闭自动更新检查、启动 What's New 弹窗、"New" 徽标
    patch_text('App/Updates.swift',
               '    static var channel: Channel { Distribution.isTestFlight ? .testFlight : Distribution.isAppStore ? .none : .direct }',
               '    static var channel: Channel { .none } // YunYing product patch: 关闭更新检查/新功能弹窗',
               'Updates channel → .none')

    # 2) Mac：禁用 Sparkle（release 构建会静默下载上游映匣构建覆盖云映）
    patch_text('App/MacUpdater.swift',
               '        guard !Distribution.isAppStore else { return nil }',
               '''        // YunYing product patch: 关闭 Sparkle 自动更新（上游 appcast 会拉回映匣构建）
        return nil''',
               'MacUpdater.make() → nil')

    # 3) 删除 设置页 → 发送反馈（iOS/macOS Form 变体）
    patch_text('App/SettingsView.swift',
               '''            // Right under the app, so a problem or an idea is never more than one click away.
            Section {
                #if os(macOS)
                SettingsLinkRow(symbol: "bubble.left.and.text.bubble.right.fill", tint: Brand.indigo, title: L10n.text("Send Feedback"),
                                subtitle: L10n.text("Report a problem or share an idea")) { FeedbackView() }
                #else
                FormLink(symbol: "bubble.left.and.text.bubble.right.fill", tint: Brand.indigo, title: L10n.text("Send Feedback")) { FeedbackView() }
                #endif
            }
''',
               '',
               'SettingsView Send Feedback section removed')

    # 4) 删除 设置页 → What's New in Version（Form 变体）
    patch_text('App/SettingsView.swift',
               '''                if !updates.currentNotes.isEmpty {
                    Button(action: updates.showCurrentNotes) {
                        HStack(spacing: 8) {
                            FormLabel(symbol: "sparkles", tint: .purple, title: L10n.text("What's New in Version %@", updates.displayVersion))
                                .foregroundStyle(.primary).lineLimit(1)
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.forward").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                        }
                    }
                    .tint(.primary)
                }
''',
               '',
               "SettingsView What's New (Form) removed")

    # 5) 删除 设置页 → What's New in Version（macOS Settings 变体）
    patch_text('App/SettingsView.swift',
               '''                if !updates.currentNotes.isEmpty {
                    Button(action: updates.showCurrentNotes) {
                        FormLabel(symbol: "sparkles", tint: .purple, title: L10n.text("What's New in Version %@", updates.displayVersion))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }.formRowButton()
                }
''',
               '',
               "SettingsView What's New (macOS) removed")

    # 6) 删除 tvOS 设置 → 软件更新 Section 入口（含 Check Now / What's New）
    patch_text('App/SettingsView.swift',
               '            if !updates.available.isEmpty { updateSection }\n',
               '',
               'tvOS updateSection entry removed')

    # 7) 删除 tvOS 设置 → 发送反馈 Section
    patch_text('App/SettingsView.swift',
               '''            // First in the list, beside the app: a problem or an idea is one press away.
            TVSettingsSection {
                TVSettingsLink(title: L10n.text("Send Feedback")) { FeedbackView() }
            }
''',
               '',
               'tvOS Send Feedback section removed')


def patch_project_yml():
    p = SRC / 'project.yml'
    if not p.exists():
        warnings.append('missing project.yml')
        return
    s = p.read_text(encoding='utf-8')
    # 上游可能是 '17.0' 或 '18.0'，一并用正则归到 '16.0'
    new = re.sub(r"iOS:\s*'1[78]\.0'", "iOS: '16.0'", s)
    if new == s:
        warnings.append("project.yml iOS deployment target '17/18.0' pattern not found")
    p.write_text(new, encoding='utf-8')
    if "iOS: '16.0'" in new and not new == s:
        print("  patched project.yml: deploymentTarget iOS → 16.0")


def patch_package_swift():
    path = SRC / 'Package.swift'
    if not path.exists():
        warnings.append('missing Package.swift')
        return
    s = path.read_text(encoding='utf-8')
    if '.iOS(.v16)' in s:
        return
    if '.iOS(.v17)' not in s:
        warnings.append('Package.swift .iOS(.v17) pattern not found')
        return
    path.write_text(s.replace('.iOS(.v17)', '.iOS(.v16)', 1), encoding='utf-8')
    print('  patched Package.swift: TVCore platforms .iOS(.v17) → .iOS(.v16)')

# ────────────────────────── 入口 ──────────────────────────

def main():
    if not SRC.exists():
        print(f'!! 未找到 {SRC}')
        sys.exit(1)
    print('▶ 1/5 manual & structural patches')
    manual_patches()
    print('▶ 2/5 product patches (云映改名/1.0/删模块)')
    product_patches()
    print('▶ 3/5 project.yml deployment target')
    patch_project_yml()
    patch_package_swift()
    print('▶ 4/5 collect @Observable class names')
    Searching = [SRC / 'App', SRC / 'Sources' / 'TvCore' if (SRC / 'Sources' / 'TvCore').exists() else SRC / 'Sources' / 'TVCore']
    for path in walk([SRC / 'App', SRC / 'Sources' / 'TVCore']):
        text = path.read_text(encoding='utf-8')
        for m in re.finditer(r'@Observable\s+[\w@ ]{0,80}?class\s+([A-Za-z0-9_]+)', text):
            if m.group(1) not in converted:
                converted.append(m.group(1))
        for m in re.finditer(r'^@Observable\s*\n\s*(?:@\w+\s+)*(?:public\s+|private\s+)?(?:final\s+)?class\s+([A-Za-z0-9_]+)', text, re.M):
            if m.group(1) not in converted:
                converted.append(m.group(1))
    print(f'   converted classes ({len(converted)}): {", ".join(converted)}')
    print('▶ 5/5 per-file transform')
    for path in walk([SRC / 'App', SRC / 'Sources' / 'TVCore']):
        try:
            process_file(path)
        except Exception as exc:
            warnings.append(f'{path.name}: {exc!r}')
    print('▶ residual check')
    for path in walk([SRC / 'App', SRC / 'Sources' / 'TVCore']):
        text = path.read_text(encoding='utf-8')
        for bad in ('@Observable',
                    'ObservationIgnored', '@Bindable',
                    'import Observation', 'scrollTargetLayout',
                    'sensoryFeedback', 'ContentUnavailableView(',
                    '.numericText(', '.blurReplace', '.contentMargins(',
                    'toolbar { ToolbarItem', '.symbolEffect(.bounce', '.symbolEffect(.variableColor'):
            if bad in text and 'Shims' not in path.name:
                warnings.append(f'{path.name}: residual "{bad}"')
    if warnings:
        print('⚠️ warnings:')
        for w in warnings:
            print('  -', w)
    print(f'DONE: {len(converted)} classes converted, {len(warnings)} warnings')

if __name__ == '__main__':
    main()
