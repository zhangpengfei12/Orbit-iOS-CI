import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        Diagnostics.shared.log("APP", "启动 \(Bundle.main.bundleIdentifier ?? "?")")
        // 服务必须早于 WebView 加载，否则首页拿到的是连接失败
        OrbitServer.shared.start()

        let window = UIWindow(frame: UIScreen.main.bounds)
        window.backgroundColor = .black
        window.rootViewController = RootViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
