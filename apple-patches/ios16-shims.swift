// YunYing iOS 16 兼容垫片（由 apple-patches/apply.sh 拷入 App/）
//
// 设计要点：
// - 上游映匣深绑 iOS 17/18 API；这里为 iOS 16.0 部署目标提供同签名/同标签的替代实现。
// - 利用 Swift 的“可用性重载消歧”：本文件的函数统一只标注 `@available(iOS 16.0, *)`，
//   在 tvOS(17)/macOS(15) 的编译域中它们不可用，SDK 原生 API 正常命中；
//   在 iOS 16 编译域中 SDK 的新 API 不可用，则自动落到这里的垫片。
// - `import Observation` 的 @Observable 观察体系无法在 iOS 16 上驱动 SwiftUI，
//   因此 apple-patches/ios16.py 会把上游 25 个 @Observable 类转换为 ObservableObject；
//   本文件只提供转换后所需的运行时支持。

import SwiftUI
import Combine
import Foundation
#if os(macOS)
import AppKit
#endif

// MARK: - 局部 @Bindable 的对应物（iOS 17 为 @Bindable 的动态成员 Binding）
// 上游写法：`@Bindable var store = store` → 转换后：
//   let store = store
//   let _yyBstore = YyBind(store)
// 之后 `$store.section` 会变为 `_yyBstore.section`（动态成员 → Binding）。
// 三平台 unconditional 使用的辅助（GlassKit 的 else 分支在 tvOS/macOS 也走这里）：
@dynamicMemberLookup
struct YyBind<M: ObservableObject> {
    private let model: M
    init(_ model: M) { self.model = model }

    // 只有这一个可写形态：类模型的 var 成员对应 ReferenceWritableKeyPath。
    // 旧版还曾按 WritableKeyPath 重载一份，keypath 字面量可上转型成多个候选，产生
    // "ambiguous use of 'subscript(dynamicMember:)'"，故删除（let 成员走下面的只读档）。
    subscript<V>(dynamicMember kp: ReferenceWritableKeyPath<M, V>) -> Binding<V> {
        Binding(get: { model[keyPath: kp] }, set: { model[keyPath: kp] = $0 })
    }
    @_disfavoredOverload
    subscript<V>(dynamicMember kp: KeyPath<M, V>) -> Binding<V> {
        Binding(get: { model[keyPath: kp] }, set: { _ in })
    }
}

// MARK: - 子模型（@Observable嵌套模型）的变化转发
// Store.searchModel/music 等是“被观察的子对象”。UIView 观察的是父级
// ObservableObject，所以这里把子对象的 objectWillChange 合流进父级的
// objectWillChange，保持 iOS 17 中隐式追踪的视觉行为。
// Swift 6 严格并发：共享单例标 @unchecked Sendable；事件投递序列化由锁保护。
final class YyObservationHub: @unchecked Sendable {
    static let shared = YyObservationHub()
    private let lock = NSLock()
    private var bag: [ObjectIdentifier: [AnyCancellable]] = [:]

    func hook(_ target: ObservableObject, _ children: [ObservableObject]) {
        lock.lock(); defer { lock.unlock() }
        let id = ObjectIdentifier(target)
        guard bag[id] == nil else { return }
        var items: [AnyCancellable] = []
        for child in children {
            // 泛型 ObservableObject 的 objectWillChange 是关联类型，统一收敛到默认 publisher
            guard let publisher = child.objectWillChange as? ObservableObjectPublisher else { continue }
            let cancellable = publisher.sink { [weak target] _ in
                (target?.objectWillChange as? ObservableObjectPublisher)?.send()
            }
            items.append(cancellable)
        }
        bag[id] = items
    }

    func drop(_ target: AnyObject) {
        lock.lock(); defer { lock.unlock() }
        bag[ObjectIdentifier(target)] = nil
    }
}

extension ObservableObject where Self: AnyObject {
    /// 由 ios16.py 注入到转换后类的 init 末尾
    func _yyHookChildren(_ children: [ObservableObject]) {
        YyObservationHub.shared.hook(self, children)
    }
    /// 由 ios16.py 注入到转换后类的 deinit
    func _yyDropChildren() {
        YyObservationHub.shared.drop(self)
    }
}

// MARK: - onChange(of:initial:_:)（iOS 17 双参数闭包）在 iOS 16 的实现
// iOS16 专用：tvOS17/macOS15 目标走 SDK 原生 onChange（同签名重载在这些平台会二义）。
#if os(iOS)
@available(iOS 16.0, *)
private struct YyOnChangeSync<V: Equatable>: ViewModifier {
    let value: V
    let initial: Bool
    let action: (V, V) -> Void
    @State private var last: V?

    func body(content: Content) -> some View {
        content.task(id: value) {
            let previous = last
            last = value
            if let previous {
                action(previous, value)
            } else if initial {
                action(value, value)
            }
        }
    }
}

@available(iOS 16.0, *)
private struct YyOnChangeAsync<V: Equatable>: ViewModifier {
    let value: V
    let initial: Bool
    let action: (V, V) async -> Void
    @State private var last: V?

    func body(content: Content) -> some View {
        content.task(id: value) {
            let previous = last
            last = value
            if let previous {
                await action(previous, value)
            } else if initial {
                await action(value, value)
            }
        }
    }
}

extension View {
    /// iOS 17 原生 onChange（支持双参数闭包与 initial:），iOS 16 走 task(id:) 手动跟踪。
    @available(iOS 16.0, *)
    func onChange<V: Equatable>(of value: V, initial: Bool = false, _ action: @escaping (V, V) -> Void) -> some View {
        modifier(YyOnChangeSync(value: value, initial: initial, action: action))
    }

    @available(iOS 16.0, *)
    func onChange<V: Equatable>(of value: V, initial: Bool = false, _ action: @escaping (V, V) async -> Void) -> some View {
        modifier(YyOnChangeAsync(value: value, initial: initial, action: action))
    }

    /// 零参数闭包形态（iOS 17 独占）：`onChange(of: x, initial: true) { ... }`
    @available(iOS 16.0, *)
    func onChange<V: Equatable>(of value: V, initial: Bool = false, _ action: @escaping () -> Void) -> some View {
        modifier(YyOnChangeSync(value: value, initial: initial, action: { _, _ in action() }))
    }

    @available(iOS 16.0, *)
    func onChange<V: Equatable>(of value: V, initial: Bool = false, _ action: @escaping () async -> Void) -> some View {
        modifier(YyOnChangeAsync(value: value, initial: initial, action: { _, _ in await action() }))
    }
}
#endif

// MARK: - withAnimation(_:completion:_:)（iOS 17 动画完成回调）的近似实现（iOS16 专用，见上）
#if os(iOS)
@available(iOS 16.0, *)
func withAnimation<Result>(_ animation: Animation?, completion: @escaping () -> Void, _ body: () -> Result) -> Result {
    let value = withAnimation(animation) { body() }
    // 没有完成回调钩子：用动画时长 + 余量的延迟近似时序
    let delay = animation == nil ? 0.35 : 0.45
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: completion)
    return value
}
#endif

// MARK: - 只在 iOS 17+ 可用、且参数不引用新类型的无副作用垫片（iOS16 专用）
#if os(iOS)
extension View {
    /// scrollClipDisabled 在 iOS 17+；iOS 16 上保持默认裁剪（视觉差异可接受）
    @available(iOS 16.0, *)
    func scrollClipDisabled(_ disabled: Bool = true) -> some View { self }

    /// scrollPosition(id:anchor:) 在 iOS 17+；iOS 16 保持不记忆滚动位置的降级
    @available(iOS 16.0, *)
    func scrollPosition<ID: Hashable>(id: Binding<ID?>, anchor: UnitPoint? = nil) -> some View { self }

    /// containerRelativeFrame 各形态在 iOS 17+；iOS 16 返回自身（调用点已被 ios16.py 替换为 .frame）
    @available(iOS 16.0, *)
    func containerRelativeFrame(_ axes: Axis.Set, alignment: Alignment = .center) -> some View { self }

    @available(iOS 16.0, *)
    func containerRelativeFrame(_ axes: Axis.Set, count: Int, spacing: CGFloat? = nil, alignment: Alignment = .center) -> some View { self }

    @available(iOS 16.0, *)
    func containerRelativeFrame(_ axes: Axis.Set, alignment: Alignment = .center, _ length: @escaping (CGFloat, Axis) -> CGFloat) -> some View { self }
}
#endif

// MARK: - ContentUnavailableView 的 iOS16 对应物（已把调用点重命名为 CUV）
struct CUV: View {
    private let icon: Image?
    private let title: Text?
    private let description: Text?
    private let labelView: AnyView?
    private let descView: AnyView?
    private let actionsView: AnyView?

    init(_ title: String, systemImage: String, description: Text? = nil) {
        self.title = Text(title)
        self.icon = Image(systemName: systemImage)
        self.description = description
        self.labelView = nil
        self.descView = nil
        self.actionsView = nil
    }

    init<DL: View, DD: View>(@ViewBuilder label: () -> DL, @ViewBuilder description: () -> DD) {
        self.labelView = AnyView(label())
        self.descView = AnyView(description())
        self.title = nil
        self.icon = nil
        self.description = nil
        self.actionsView = nil
    }

    init<DL: View, DD: View, DA: View>(@ViewBuilder label: () -> DL, @ViewBuilder description: () -> DD, @ViewBuilder actions: () -> DA) {
        self.labelView = AnyView(label())
        self.descView = AnyView(description())
        self.actionsView = AnyView(actions())
        self.title = nil
        self.icon = nil
        self.description = nil
    }

    static func search(text: String) -> CUV {
        CUV(text, systemImage: "magnifyingglass")
    }

    var body: some View {
        VStack(spacing: 10) {
            if let labelView {
                labelView
            } else if let icon, let title {
                icon.font(.system(size: 42))
                    .foregroundStyle(Color.secondary)
                title.font(.title3.weight(.semibold))
            }
            if let description {
                description.font(.callout).foregroundStyle(Color.secondary)
            }
            if let descView {
                descView
            }
            if let actionsView {
                actionsView
            }
        }
        .multilineTextAlignment(.center)
        .padding(30)
        .frame(maxWidth: .infinity, alignment: .center)
    }
}

// MARK: - onScrolledIntoView 的 iOS 16 近似（GlassKit 会调用 _yyScrolledIntoView）
@available(iOS 16.0, macOS 15.0, tvOS 17.0, *)
private struct YyVisibilityProbe: ViewModifier {
    let threshold: Double
    let action: (Bool) -> Void
    @State private var shown = false

    func body(content: Content) -> some View {
        content.background {
            GeometryReader { g in
                Color.clear
                    .onAppear { measure(g.frame(in: .global)) }
                    .onChange(of: g.frame(in: .global)) { value in
                        measure(value)
                    }
            }
        }
    }

    private func measure(_ rect: CGRect) {
        // 视口近似：iOS/tvOS 用整屏；macOS 用主显示器屏幕
        #if os(macOS)
        let viewport = NSScreen.main?.frame ?? rect
        #else
        let viewport = UIScreen.main.bounds
        #endif
        guard rect.height > 0 else { return }
        let overlap = max(0.0, min(rect.maxY, viewport.maxY) - max(rect.minY, viewport.minY))
        let share = min(1.0, max(0.0, overlap / rect.height))
        let calc = share >= threshold
        if calc != shown {
            shown = calc
            action(calc)
        }
    }
}

extension View {
    @available(iOS 16.0, macOS 15.0, tvOS 17.0, *)
    func _yyScrolledIntoView(threshold: Double, _ action: @escaping (Bool) -> Void) -> some View {
        modifier(YyVisibilityProbe(threshold: threshold, action: action))
    }
}

// MARK: - onGeometryChange(for:of:action:)（iOS 18 API）的 iOS 16/tvOS 17 实现
// macOS 15 原生具备该 API，排除以免同签名重载二义。
#if os(iOS) || os(tvOS)
@available(iOS 16.0, tvOS 17.0, *)
private struct YyGeometryProbe<T: Equatable>: ViewModifier {
    let transform: (GeometryProxy) -> T
    let action: (T) -> Void

    func body(content: Content) -> some View {
        content.background {
            GeometryReader { g in
                Color.clear
                    .onAppear { action(transform(g)) }
                    .onChange(of: transform(g), perform: action)
            }
        }
    }
}

extension View {
    @available(iOS 16.0, tvOS 17.0, *)
    func onGeometryChange<T: Equatable>(for type: T.Type, of transform: @escaping (GeometryProxy) -> T,
                                        action: @escaping (T) -> Void) -> some View {
        modifier(YyGeometryProbe(transform: transform, action: action))
    }
}
#endif

// MARK: - iOS 16.4 才开的 presentationBackground / presentationCornerRadius 垫片
// (iOS16 目标用; tvOS17/macOS15 目标走 SDK 原版——同签名重载在这些平台会二义)
#if os(iOS)
extension View {
    /// iOS 16.0 上保留系统默认面板底色（毛玻璃效果降级为无垫底）。
    @available(iOS 16.0, *)
    func presentationBackground<S: ShapeStyle>(_ background: S) -> some View { self }

    /// iOS 16.0 上保留系统默认面板底色，不渲染自定义背景视图。
    @available(iOS 16.0, *)
    func presentationBackground<C: View>(alignment: Alignment = .center, @ViewBuilder content: () -> C) -> some View { self }

    /// iOS 16.0 上使用系统默认圆角。
    @available(iOS 16.0, *)
    func presentationCornerRadius(_ radius: CGFloat?) -> some View { self }
}
#endif

// MARK: - Xcode 26 SDK 歧义消解：ToolbarItem 同时是 View 与 ToolbarContent，
// `.toolbar { ToolbarItem(...) {...} }` 与 toolbar(content:) 的两个候选二义；
// yyToolbar 显式走 ToolbarContent 泛型档（Content 泛型无法证明是 View，ViewBuilder 档被排除）。
extension View {
    @available(iOS 16.0, macOS 13.0, tvOS 16.4, *)
    func yyToolbar<Content: ToolbarContent>(@ToolbarContentBuilder content: () -> Content) -> some View {
        toolbar(content: content)
    }
}

// MARK: - Text.foregroundStyle 需要 iOS 17（Xcode 26 SDK 报错）；iOS 16 用 foregroundColor 承接
#if os(iOS)
extension Text {
    @available(iOS 16.0, *)
    func foregroundStyle(_ color: Color) -> Text { foregroundColor(color) }
}
#endif
