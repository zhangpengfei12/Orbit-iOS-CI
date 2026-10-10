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
        // JS 错误捕获：黑屏排障靠它 —— 前端任何未捕获异常 / console.error 都回传诊断日志
        let errHook = WKUserScript(source: Self.jsErrorHook, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        content.addUserScript(errHook)
        let config = WKWebViewConfiguration()
        config.userContentController = content
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self
        view.scrollView.bounces = false
        view.isOpaque = false
        view.backgroundColor = .black
        return view
    }()

    /// documentStart 注入：捕获 JS 未捕获异常与 console.error / console.warn，
    /// 经 messageHandlers.Orbit 回传给 BridgeProxy 写入诊断日志。
    /// 每类消息限 30 条，防止渲染循环刷爆诊断缓冲（800 行上限）。
    private static let jsErrorHook = """
    (function(){
      var N = 0;
      function post(text){
        if (N++ > 90) return;
        try { window.webkit.messageHandlers.Orbit.postMessage(text); } catch(e){}
      }
      window.onerror = function(msg, src, line, col){
        post('JSERROR: ' + msg + ' @' + src + ':' + line + ':' + col);
      };
      window.addEventListener('unhandledrejection', function(ev){
        post('JSREJECT: ' + (ev.reason && (ev.reason.stack || ev.reason.message) || ev.reason));
      });
      ['error','warn'].forEach(function(level){
        var orig = console[level];
        console[level] = function(){
          post('CONSOLE-' + level.toUpperCase() + ': ' + Array.prototype.map.call(arguments, String).join(' '));
          orig.apply(console, arguments);
        };
      });
    })();
    """

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
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        Diagnostics.shared.log("WEB", "开始请求 \(webView.url?.absoluteString ?? "-")")
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        Diagnostics.shared.log("WEB", "已收到响应开始渲染")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        Diagnostics.shared.log("WEB", "❌ 主文档加载失败: \(error)")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Diagnostics.shared.log("WEB", "页面加载完成 \(webView.url?.absoluteString ?? "-")")
        // dump 页面实况：纯黑屏时靠它区分「没渲染」还是「渲染了但内容空」
        webView.evaluateJavaScript("""
        (function(){
          var b = document.body;
          return 'readyState=' + document.readyState +
                 ' | title=' + document.title +
                 ' | body文本长度=' + (b ? b.innerText.length : -1) +
                 ' | 子资源数=' + (window.performance ? performance.getEntriesByType('resource').length : -1);
        })()
        """) { result, _ in
            Diagnostics.shared.log("WEB", "页面实况: \(result ?? "nil")")
        }
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
        // jsErrorHook（documentStart 注入）会把 JS 异常 / console.error 经这里回传诊断日志
        if message.name == "Orbit", let text = message.body as? String,
           text.hasPrefix("JSERROR:") || text.hasPrefix("JSREJECT:") || text.hasPrefix("CONSOLE-") {
            Diagnostics.shared.log("JS", text)
            return
        }
        // M1 起在这里分发 39 个桥方法（见 ENDPOINTS.md 与 Android MainActivity.kt:610-1036）
        print("[Orbit] js -> native: \(message.name) body=\(message.body)")
    }
}
