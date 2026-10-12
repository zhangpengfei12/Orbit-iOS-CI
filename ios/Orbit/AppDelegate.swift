import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // 启动诊断：读出上一次运行最后写下的里程碑。若本次在「某步之后」崩溃，
        // 上一轮留下的就是「崩溃前最后完成的步」，据此区分是 main 之前（dyld）还是某启动阶段崩。
        if let prev = Self.lastLaunchStep() {
            Diagnostics.shared.log("LAUNCH", "上一次启动最后到达: \(prev)")
        } else {
            Diagnostics.shared.log("LAUNCH", "无历史启动里程碑（可能是 main 之前 dyld 崩溃，或首次安装）")
        }
        Self.markLaunchStep("main_started")

        Diagnostics.shared.log("APP", "启动 \(Bundle.main.bundleIdentifier ?? "?")")
        // 服务必须早于 WebView 加载，否则首页拿到的是连接失败
        OrbitServer.shared.start()
        Self.markLaunchStep("server_started")

        let window = UIWindow(frame: UIScreen.main.bounds)
        window.backgroundColor = .black
        window.rootViewController = RootViewController()
        window.makeKeyAndVisible()
        self.window = window
        Self.markLaunchStep("window_ready")
        return true
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
