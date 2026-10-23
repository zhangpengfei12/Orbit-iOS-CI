import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // 崩溃自报器必须最先装：兜住 main 之后、首屏渲染前的任何原生崩溃，
        // 把调用栈写进沙盒，下次启动弹窗。千万别在它之前放可能崩的代码。
        CrashReporter.install()

        // 启动诊断：读出上一次运行最后写下的里程碑。若本次在「某步之后」崩溃，
        // 上一轮留下的就是「崩溃前最后完成的步」，据此区分是 main 之前（dyld）还是某启动阶段崩。
        if let prev = Self.lastLaunchStep() {
            Diagnostics.shared.log("LAUNCH", "上一次启动最后到达: \(prev)")
        } else {
            Diagnostics.shared.log("LAUNCH", "无历史启动里程碑（可能是 main 之前 dyld 崩溃，或首次安装）")
        }
        Self.markLaunchStep("main_started")

        // 启动日志带上 build 号：对外版本号一直是 1.0.1，光看「版本信息」分不清
        // 手机装的到底是哪一次 CI 构建。诊断页截图里有 (76) 这种才是真·build 号。
        let info = Bundle.main.infoDictionary
        let shortVer = info?["CFBundleShortVersionString"] as? String ?? "?"
        let buildNo = info?["CFBundleVersion"] as? String ?? "?"
        Diagnostics.shared.log("APP", "启动 \(Bundle.main.bundleIdentifier ?? "?") v\(shortVer) build \(buildNo)")
        // 服务必须早于 WebView 加载，否则首页拿到的是连接失败
        OrbitServer.shared.start()
        Self.markLaunchStep("server_started")

        let window = UIWindow(frame: UIScreen.main.bounds)
        window.backgroundColor = .black
        let rootVC = RootViewController()
        // 若上次运行崩过：弹窗展示调用栈，且暂不加载 web，避免立刻二次崩溃（留出截图时间）
        if CrashReporter.pendingCrashText() != nil {
            rootVC.suppressWebLoad = true
        }
        window.rootViewController = rootVC
        window.makeKeyAndVisible()
        self.window = window
        Self.markLaunchStep("window_ready")

        if let crash = CrashReporter.pendingCrashText() {
            CrashReporter.present(on: window, text: crash)
        }

        // 冷启动场景：从相册 / 文件 App「分享 → Orbit」打开时，系统把文件 URL 放在
        // launchOptions 里（热启动走下面的 application(_:open:options:)）。
        if let url = launchOptions?[.url] as? URL {
            ingestExternalFiles([url])
        }
        return true
    }

    // MARK: - 接收外部文件（相册 / 文件 App 的「分享 → 拷贝到 Orbit」）
    //
    // 之前只做了 App 内部的选择器（MediaPicker），没有任何「被外部打开」的入口，
    // 所以相册里分享面板根本找不到本 App —— 那需要 Info.plist 注册
    // CFBundleDocumentTypes（已补 public.movie / funscript），二者缺一不可。

    func application(_ app: UIApplication, open url: URL,
                     options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        ingestExternalFiles([url])
        return true
    }

    /// 把外部文件拷进媒体库，并通知网页刷新列表。
    private func ingestExternalFiles(_ urls: [URL]) {
        var imported: [(name: String, rel: String, size: Int64)] = []
        for url in urls {
            // 外部容器里的文件必须先拿安全作用域授权才能读；Inbox 内的副本会返回 false，
            // 但不影响读取（统一成对调用，别漏 stop）。
            let scoped = url.startAccessingSecurityScopedResource()
            let r = MediaStore.shared.importFiles([url])
            if scoped { url.stopAccessingSecurityScopedResource() }
            imported.append(contentsOf: r)
            if r.isEmpty {
                Diagnostics.shared.log("PICK", "外部分享文件导入失败：\(url.lastPathComponent)")
            }
        }
        guard !imported.isEmpty else { return }
        Diagnostics.shared.log("PICK", "外部分享导入成功 \(imported.count) 个")
        // 冷启动时网页可能还没加载完（sink 建立晚于本方法），延迟一点再通知前端刷新。
        let js = buildCallback("__onFolderPicked", [.string(MediaStore.rootRel)])
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            JsEmit.js(js)
        }
    }

    // MARK: - 启动里程碑诊断（摇一摇诊断页可见；用于无 .ips 日志时定位启动崩溃点）

    private static func launchStepURL() -> URL? {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
            .appendingPathComponent(".orbit_launch_step")
    }

    /// 把当前启动里程碑同步写入沙盒文档目录；try? 包裹，绝不因诊断而崩溃。
    private static func markLaunchStep(_ step: String) {
        guard let url = launchStepURL() else { return }
        try? "\(step) @ \(Int(Date().timeIntervalSince1970))".write(to: url, atomically: true, encoding: .utf8)
    }

    private static func lastLaunchStep() -> String? {
        guard let url = launchStepURL() else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }
}
