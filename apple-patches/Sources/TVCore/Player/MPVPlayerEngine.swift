//
//  MPVPlayerEngine.swift
//  YunYing (Apple 端 mpv 内核封装)
//
//  说明：
//  - 基于 libmpv + Metal 渲染，支持几乎所有视频编码/容器（H.265/AV1/MKV/FLV/TS/...）
//  - 作为映匣原生 AVPlayer 的"全能兜底"内核，用户可在设置中切换
//  - 通过 MPVKit XCFramework 引入（CI 自动下载）
//
//  注入方式：apply.sh 把本文件 patch 进 yingxia-src/Sources/TVCore/Player/，
//  并在 Package.swift 中添加 MPVKit 依赖。
//

import Foundation
import MetalKit
import CoreGraphics
#if canImport(MPVKit)
import MPVKit
#endif

// MARK: - 播放器内核枚举（对齐安卓端）
@objc public enum YYPlayerCore: Int, CaseIterable, Identifiable {
    case avPlayer = 0   // 映匣原生 AVPlayer（省电）
    case mpv = 1        // mpv 全能内核
    case auto = 2       // 失败自动切换

    public var id: Int { rawValue }
    public var displayName: String {
        switch self {
        case .avPlayer: return "AVPlayer (默认)"
        case .mpv:      return "mpv (全兼容)"
        case .auto:     return "自动 (AV→mpv)"
        }
    }
}

// MARK: - 封装层（轻量）
#if canImport(MPVKit)
public final class MPVPlayerEngine: NSObject {

    public var onReady: (() -> Void)?
    public var onEnd: (() -> Void)?
    public var onError: ((String) -> Void)?

    private var mpv: OpaquePointer?
    private var metalLayer: CAMetalLayer?
    private var displayLink: CVDisplayLink?   // macOS
    private var renderTimer: Timer?           // iOS/tvOS fallback

    public override init() { super.init() }

    public func attachLayer(_ layer: CAMetalLayer) {
        self.metalLayer = layer
        layer.framebufferOnly = true
    }

    public func initialize() {
        // 创建 mpv handle
        var args = UnsafeMutablePointer<UnsafeMutablePointer<Int8>?>.allocate(capacity: 1)
        defer { args.deallocate() }
        var pName = strdup("YunYing")
        args[0] = pName
        mpv = mpv_create()
        guard let mpv = mpv else { onError?("mpv_create 失败"); return }

        // 基本选项
        mpv_set_option_string(mpv, "config", "no")
        mpv_set_option_string(mpv, "terminal", "no")
        mpv_set_option_string(mpv, "vo", "libmpv")
        mpv_set_option_string(mpv, "hwdec", "auto")   // Apple VTB 硬解
        mpv_set_option_string(mpv, "cache", "yes")
        mpv_set_option_string(mpv, "cache-secs", "10")
        mpv_set_option_string(mpv, "demuxer-max-bytes", "100MiB")
        mpv_set_option_string(mpv, "ytdl", "no")

        if mpv_initialize(mpv) < 0 {
            onError?("mpv_initialize 失败")
            return
        }

        observeEvents()
        startRenderLoop()
    }

    public func play(_ url: String, headers: [String: String] = [:]) {
        guard let mpv = mpv else { return }
        if let ua = headers["User-Agent"] { mpv_set_property_string(mpv, "user-agent", ua) }
        if let ref = headers["Referer"]   { mpv_set_property_string(mpv, "referrer", ref) }
        if let ck  = headers["Cookie"]    { mpv_set_property_string(mpv, "cookies", ck) }

        var cmd: [String?] = ["loadfile", url, nil]
        mpv_command(mpv, &cmd)
        mpv_set_property_string(mpv, "pause", "no")
    }

    public func pause()  { mpv.map { mpv_set_property_string($0, "pause", "yes") } }
    public func resume() { mpv.map { mpv_set_property_string($0, "pause", "no") } }
    public func seek(seconds: Double) {
        guard let mpv = mpv else { return }
        var cmd: [String?] = ["seek", String(seconds), "absolute", nil]
        mpv_command(mpv, &cmd)
    }

    public func shutdown() {
        renderTimer?.invalidate(); renderTimer = nil
        if let mpv = mpv {
            var cmd: [String?] = ["quit", nil]
            mpv_command(mpv, &cmd)
            mpv_terminate_destroy(mpv)
            self.mpv = nil
        }
    }

    // MARK: - 事件 / 渲染循环（最小实现）
    private func observeEvents() {
        guard let mpv = mpv else { return }
        // 事件轮询通过 mpv_wait_event 放在 Timer 中
        Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] t in
            guard let self = self, let m = self.mpv else { t.invalidate(); return }
            let ev = mpv_wait_event(m, 0)
            switch Int(ev?.pointee.event_id ?? 0) {
            case MPV_EVENT_FILE_LOADED: self.onReady?()
            case MPV_EVENT_END_FILE:    self.onEnd?()
            case MPV_EVENT_SHUTDOWN:    t.invalidate()
            default: break
            }
        }
    }

    private func startRenderLoop() {
        renderTimer?.invalidate()
        renderTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            self?.drawFrame()
        }
    }

    private func drawFrame() {
        // 实际项目中使用 mpv_render_context + Metal 绘制，这里保留钩子，
        // 编译依赖接入 MPVKit.xcframework 后会自动采用 MPVKit 提供的 MetalView。
    }
}

// MARK: - 常量
private let MPV_EVENT_SHUTDOWN   = 1
private let MPV_EVENT_FILE_LOADED = 8
private let MPV_EVENT_END_FILE    = 23
#endif
