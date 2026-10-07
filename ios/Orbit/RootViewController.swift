import UIKit
import WebKit

/// 主容器：WKWebView 直接加载 127.0.0.1:8787，替代 Android 的 MainActivity + WebView。
///
/// 桥接约定（务必保持）：
/// - 网页 → 原生：window.webkit.messageHandlers.Orbit.postMessage(...)
/// - 原生 → 网页：必须是「在 window 上挂全局函数 + 字符串调用」——
///   前端 manual_record.js 与 touchpad.js 重新赋值过 __onXxx（猴子补丁），
///   改用其它通道那两处补丁会全部失效。
final class RootViewController: UIViewController {

    private lazy var webView: WKWebView = {
        let content = WKUserContentController()
        content.add(BridgeProxy.shared, name: "Orbit")
        content.add(BridgeProxy.shared, name: "OrbitPlayer")
        let config = WKWebViewConfiguration()
        config.userContentController = content
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self
        view.scrollView.bounces = false
        view.isOpaque = false
        view.backgroundColor = .black
        return view
    }()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        view.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        loadHome()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        becomeFirstResponder()
    }

    private func loadHome() {
        guard let url = URL(string: "http://127.0.0.1:\(OrbitServer.port)/") else { return }
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        Diagnostics.shared.log("WEB", "加载 \(url.absoluteString)")
        webView.load(request)
    }

    // MARK: - 诊断页入口（摇一摇）
    //
    // 本机是 Windows，无法联调模拟器，真机排障全靠这个页面 —— 别删。
    override var canBecomeFirstResponder: Bool { true }

    override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        guard motion == .motionShake else { return }
        let nav = UINavigationController(rootViewController: DiagnosticsViewController())
        nav.modalPresentationStyle = .fullScreen
        present(nav, animated: true)
    }

    /// 原生 → 网页：保持与 Android evaluateJavascript 完全一致的字符串调用形式。
    func emit(_ js: String) {
        webView.evaluateJavaScript(js) { _, error in
            if let error { print("[Orbit] evaluateJS 失败: \(error)") }
        }
    }
}

extension RootViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Diagnostics.shared.log("WEB", "页面加载完成 \(webView.url?.absoluteString ?? "-")")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Diagnostics.shared.log("WEB", "页面加载失败: \(error)")
    }
}

/// WKUserContentController 会强引用 handler，用单例代理避免控制器泄漏。
final class BridgeProxy: NSObject, WKScriptMessageHandler {
    static let shared = BridgeProxy()

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        // M1 起在这里分发 39 个桥方法（见 ENDPOINTS.md 与 Android MainActivity.kt:610-1036）
        print("[Orbit] js -> native: \(message.name) body=\(message.body)")
    }
}
