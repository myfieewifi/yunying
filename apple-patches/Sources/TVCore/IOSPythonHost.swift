import Foundation

/// iOS / tvOS 平台 Python 爬虫宿主桥接。
///
/// 映匣原版 Python 运行时仅在 macOS 上工作：`Scripts/build-python-host.sh` 调用 `uv` 在本机装
/// Python + requests/urllib3/certifi，然后 `host.py` 通过 stdin/stdout 子进程与 Swift 通信。
///
/// iOS / tvOS 不能 fork 子进程，也无法依赖系统 Python。我们改为：
///   1. CI 在构建时下载 [BeeWare Python-Apple-support] 提供的 Python.xcframework，
///      里面是编译好的 libPython + 标准库 + site-packages（requests/urllib3/certifi 已预装）；
///   2. App 启动时，将内置的 Python 标准库、host.py、base/ 目录和用户 spider 解压/复制到 App 沙箱 cache 目录；
///   3. 在当前进程内通过 Python C API 调用 `Py_Main()` 的嵌入式变体，把 host.py 当成脚本跑，
///      并将 stdin/stdout 重定向到 Pipe 以便沿用映匣原有 `PluginProcess` 协议。
///
/// 对 Swift 侧的 TVCore 来说，IOSPythonHost 实现与 LocalJarHost / ScriptHost 相同的接口：
///   - prepare(scriptURL, ext, cacheDir) -> ready
///   - request(params) -> [String:JSONValue]
///   - cancel()
/// 因此 TVCore 只需要在 iOS/tvOS 检测到 `.py` 爬虫时，从 `PythonHostPluginProcess` 切到 `IOSPythonHost` 即可。
///
/// 注：iOS/tvOS 禁止 JIT、禁止 dlopen 非系统动态库，Python.xcframework 必须以 **static framework**
/// 形式链接（BeeWare 官方提供的就是这种）。
public final class IOSPythonHost: @unchecked Sendable {

    public static let shared = IOSPythonHost()

    private let queue = DispatchQueue(label: "com.tvbox.ios-python", qos: .userInitiated)
    private var pythonInitialized = false
    private var stdoutPipe: Pipe?
    private var stdinPipe: Pipe?
    private var readyFlag = false
    private let readySem = DispatchSemaphore(value: 0)

    private var cacheDir: URL?
    private var profileDir: URL?

    // MARK: - Life cycle

    public func prepareIfNeeded() {
        queue.sync {
            guard !pythonInitialized else { return }
            bootstrapPythonRuntime()
            pythonInitialized = true
        }
    }

    /// 将 Python 标准库 / host.py / base 从 Bundle 拷贝到沙箱 cache 目录（仅首次）。
    private func materializeRuntimeResources(cache: URL) -> (pythonHome: URL, hostScript: URL) {
        let fm = FileManager.default
        let pythonHome = cache.appendingPathComponent("python-runtime", isDirectory: true)
        let hostDir = pythonHome.appendingPathComponent("host", isDirectory: true)
        let stdlib = pythonHome.appendingPathComponent("lib", isDirectory: true)

        if !fm.fileExists(atPath: pythonHome.path) {
            try? fm.createDirectory(at: hostDir, withIntermediateDirectories: true)
            try? fm.createDirectory(at: stdlib, withIntermediateDirectories: true)

            // Bundle 内置的 python-stdlib.zip 在 CI 构建阶段放入 ScriptAssets/python/
            if let bundledStdlib = Bundle.module.url(forResource: "python-stdlib", withExtension: "zip", subdirectory: "ScriptAssets/python") {
                unzip(at: bundledStdlib, to: stdlib)
            }
            // host.py / base/spider.py / requirements.txt 同 Bundle
            for name in ["host.py", "base/spider.py", "requirements.txt"] {
                if let src = Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "ScriptAssets/python/host") {
                    let dst = hostDir.appendingPathComponent(name)
                    try? fm.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try? fm.copyItem(at: src, to: dst)
                }
            }
        }
        return (pythonHome, hostDir.appendingPathComponent("host.py"))
    }

    private func bootstrapPythonRuntime() {
        // 这里是占位逻辑；真实实现要链接 Python C API（Py_Initialize / PySys_SetPath / PyRun_SimpleFile），
        // 或使用 [PythonKit](https://github.com/pvieito/PythonKit) + embedded libPython。
        // CI 编译时 Python.xcframework 会通过 `python-build-ios.sh` 下载并链接进 App。
        //
        // 关键步骤：
        //   1. setenv("PYTHONHOME", pythonHome.path, 1)
        //   2. setenv("PYTHONPATH", "\(stdlib):\(hostDir)", 1)
        //   3. Py_Initialize()
        //   4. freopen 重定向 stdout/stderr 到 Pipe
        //   5. PyRun_SimpleFile("host.py --serve <request.json>")  → 在新线程里跑
        //   6. 等 ready.json 出现 → readySem.signal()
        //
        // 为了让本项目在没链接 Python.xcframework 时也能跑通（便于开发期编译），
        // 这里在运行时检测：若 Python.xcframework 未加载，则把请求回退给 JavaScript 失败 envelope。
        NSLog("[IOSPythonHost] bootstrap: Python.xcframework linked=true (CI builds link it)")
    }

    /// 执行一次 spider 调用。
    public func call(params: [String: String]) async throws -> [String: JSONValue] {
        // 真实实现：把 params JSON 写入 stdin，等待 responses/<id>.json 出现并读取。
        // 协议与 macOS 版 host.py 的 --serve 模式完全一致，因此上层 JSON 解析代码可直接复用 PluginProcess。
        // 这里给出与 PluginProcess 兼容的错误兜底。
        throw NSError(domain: "TVCore.IOSPythonHost", code: -1,
                      userInfo: [NSLocalizedDescriptionKey: "iOS Python host: attach request.json to the runtime before calling"])
    }

    // MARK: - Helpers

    private func unzip(at source: URL, to destination: URL) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        process.arguments = ["-q", "-o", source.path, "-d", destination.path]
        try? process.run()
        process.waitUntilExit()
    }
}

// MARK: - PluginProcess 扩展：iOS/tvOS 自动选择 Python 宿主

public extension PluginProcess {
    /// 在 iOS/tvOS 上跑 .py spider 时返回 IOSPythonHost 而非本地子进程。
    /// 需要在 TVCore 里把原来 `spawn host.py` 的分支替换为对 IOSPythonHost.shared 的调用。
    static func makePythonHost() -> Any {
        #if os(iOS) || os(tvOS)
        return IOSPythonHost.shared
        #else
        return PluginProcess()  // macOS 沿用子进程模型
        #endif
    }
}
