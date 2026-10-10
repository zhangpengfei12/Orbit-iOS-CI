import Foundation
import Swifter

/// 本地 HTTP 服务：替代 Android 的 NanoHTTPD。
///
/// 端口必须与 Android 一致（8787）——前端 88 处 fetch() 全是同源相对路径，
/// 换端口就意味着要改前端。路由映射对齐 WebServer.kt:859-861。
///
/// ⚠ 依赖选型变更记录（2026-10-03）：
///   最初写的是 GCDWebServer，但它已在 2022 年归档、**且没有 Package.swift（不支持 SwiftPM）**，
///   CI 直接报 "no versions of 'gcdwebserver' match"。改用 **Swifter 1.5.0**（SPM 原生、
///   无平台限制、无传递依赖）。它的包路径是 XCode/Sources，常规 SPM 引用即可。
final class OrbitServer {

    static let port: in_port_t = 8787
    static let shared = OrbitServer()

    private let server = HttpServer()
    private var webRootPath: String?
    private var startError: String?
    private(set) var listenPort: Int?

    /// bundle 内 web/ 目录路径。
    /// 候选根目录依次探测（存在 home.html 才算有效），防止单一来源失效导致整页黑屏：
    /// 1) <bundle>/web          —— 正常路径：folder reference 拷进 Resources 的目录
    /// 2) <bundle>              —— 兜底：资源被「打平」拷到 Resources 根的情况
    /// ⚠ build 23 黑屏教训：folder reference 指向工程外路径（../web）时，Xcode 26 归档
    ///   会拷出**空目录**（目录在、文件全丢），页面 404 → 纯黑屏。打包已改为工程内拷贝
    ///   （见 project.yml 与 ios.yml），这里保留多候选探测作运行时兜底。
    private var webRoot: String? {
        guard let res = Bundle.main.resourceURL else { return nil }
        let fm = FileManager.default
        let candidates = [
            res.appendingPathComponent("web").path,   // 正常：<bundle>/web/home.html
            res.path                                   // 兜底：<bundle>/home.html
        ]
        for c in candidates where fm.fileExists(atPath: (c as NSString).appendingPathComponent("home.html")) {
            if c != candidates[0] {
                Diagnostics.shared.log("SERVER", "⚠ 常规 web/ 目录无效，已回退到资源根目录")
            }
            return c
        }
        return nil
    }

    var isRunning: Bool { server.operating }

    func start() {
        guard let root = webRoot else {
            startError = "未找到 web 资源目录"
            Diagnostics.shared.log("SERVER", "未找到 web 资源目录，前端无法加载")
            return
        }
        webRootPath = root
        Diagnostics.shared.log("SERVER", "web 根目录: \(root)")

        // 页面路由，对齐 WebServer.kt：`/` → home.html、`/index`/`/app` → index.html、`/player*` → player.html
        server.get["/"] = { [weak self] _ in self?.serveFile("home.html") ?? .internalServerError }
        server.get["/index"] = { [weak self] _ in self?.serveFile("index.html") ?? .internalServerError }
        server.get["/app"] = { [weak self] _ in self?.serveFile("index.html") ?? .internalServerError }
        server.get["/player"] = { [weak self] _ in self?.serveFile("player.html") ?? .internalServerError }

        // 其余一切路径（js/ css/ img/ 子目录下的多级路径）都按静态文件走。
        // Swifter 的路由是按「段」精确匹配的，多级通配不可靠，所以用 notFoundHandler 兜底，
        // 由我们自己做路径清洗 —— 顺手挡掉 ../ 目录穿越。
        server.notFoundHandler = { [weak self] request in
            // 视频流走独立分发：路径段数不固定（SMB 相对路径可能有多层），
            // Swifter 的按段精确匹配注册不了，只能在这里前缀判断后手工接管。
            if let r = ApiVideo.handle(request) { return r }
            return self?.serveFile(request.path) ?? .notFound
        }

        // API 路由：web 实际调用的 /api/* 端点集中注册（见 ApiRouter.swift 及各分组文件）
        ApiRouter.register(into: server)

        do {
            // priority 必须显式给 .userInitiated：Swifter 默认 .background，
            // iOS 对 background QoS 线程限流严格，会拖慢所有请求
            try server.start(OrbitServer.port, forceIPv4: true, priority: .userInitiated)
            listenPort = Int(OrbitServer.port)
            Diagnostics.shared.log("SERVER", "已启动 http://127.0.0.1:\(OrbitServer.port)")
        } catch {
            startError = "\(error)"
            Diagnostics.shared.log("SERVER", "启动失败: \(error)")
        }
    }

    func stop() {
        server.stop()
    }

    /// 供诊断页展示
    func diagnosticsInfo() -> String {
        var out: [String] = []
        out.append("端口: \(OrbitServer.port)（必须与安卓一致，前端 88 处 fetch 是同源相对路径）")
        out.append("运行状态: \(server.operating ? "已启动" : "未启动")（底层状态 \(server.state)）")
        if let p = listenPort { out.append("地址: http://127.0.0.1:\(p)") }
        if let root = webRootPath { out.append("根目录: \(root)") }
        let missing = expectedWebFiles().filter { !FileManager.default.fileExists(atPath: $0) }
        out.append("关键文件缺失: \(missing.isEmpty ? "无" : "\(missing.count) 个")")
        for m in missing { out.append("  缺: \(m)") }
        if let err = startError { out.append("启动错误: \(err)") }
        return out.joined(separator: "\n")
    }

    /// M0 只要求这 5 个文件到位，首页才可能跑起来
    func expectedWebFiles() -> [String] {
        guard let root = webRootPath else { return [] }
        return ["home.html", "index.html", "player.html", "js/app.js", "css/app.css"]
            .map { (root as NSString).appendingPathComponent($0) }
    }

    // MARK: - 静态资源

    /// 显式 MIME 映射。
    /// ⚠⚠ 页面全裸根因（build 30 真机实锤，抽帧确认 CSS 全被拒）：不能用 Swifter 的
    ///   `String.mimeType()` —— 它的实现是 `NSString(string: self).mimeType()`，
    ///   内部又取一次 pathExtension；对裸扩展名（如 "css"，无点号）pathExtension 返回空串，
    ///   matchMimeType("") 落到兜底 `application/octet-stream`。
    ///   之前写的 `(full as NSString).pathExtension.mimeType()` 恰好踩中：先取出 "css"，
    ///   再对 "css" 调 mimeType() → 恒 octet-stream。
    ///   后果：图片 <img> 与主文档靠 WebKit 内容嗅探还能渲染，但 CSS/JS 被 WebKit
    ///   严格 MIME 校验拒绝（样式表/脚本不应用）→ 页面元素全裸、竖排堆叠、文字重叠。
    private static let mimeByExt: [String: String] = [
        "html": "text/html; charset=utf-8", "htm": "text/html; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "js": "application/javascript; charset=utf-8",
        "json": "application/json; charset=utf-8",
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "gif": "image/gif", "svg": "image/svg+xml", "webp": "image/webp",
        "ico": "image/x-icon",
        "mp4": "video/mp4", "webm": "video/webm", "m3u8": "application/vnd.apple.mpegurl",
        "mp3": "audio/mpeg", "wav": "audio/wav", "m4a": "audio/x-m4a",
        "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf", "otf": "font/otf",
        "txt": "text/plain; charset=utf-8", "xml": "text/xml; charset=utf-8"
    ]

    /// 从 bundle 的 web/ 里取文件返回。HTML/JS/CSS 一律 no-cache，
    /// 对齐 WebServer.kt 的策略 —— 覆盖安装后「旧 HTML 配新 JS」会表现成升级后点击无反应。
    private func serveFile(_ relative: String) -> HttpResponse {
        guard let root = webRootPath else { return .internalServerError }

        var rel = relative
        // ⚠ 页面错乱根因（build 29 真机实锤）：Swifter 的 request.path 带查询串，
        //   而 HTML 里资源引用都带缓存戳（如 /css/home.css?v=20261001r），
        //   不剥掉的话文件查找恒 404 → CSS/JS 全挂、页面无样式（背景图能显示
        //   是因为 img src 恰好不带 ?v=）。安卓端 WebServer.kt 按 URI path/query
        //   分离处理所以无此问题，iOS 端必须在这里对齐。
        if let q = rel.firstIndex(of: "?") { rel = String(rel[..<q]) }
        if let h = rel.firstIndex(of: "#") { rel = String(rel[..<h]) }
        if rel.hasPrefix("/") { rel.removeFirst() }
        if rel.isEmpty { rel = "home.html" }
        // 目录穿越防护：任何 .. 片段直接拒掉
        guard !rel.components(separatedBy: "/").contains("..") else { return .notFound }

        let full = (root as NSString).appendingPathComponent(rel)
        guard FileManager.default.fileExists(atPath: full),
              let data = try? Data(contentsOf: URL(fileURLWithPath: full)) else {
            Diagnostics.shared.logRequest(method: "GET", path: "/" + rel, status: 404)
            return .notFound
        }
        let ext = (full as NSString).pathExtension.lowercased()
        let mime = Self.mimeByExt[ext] ?? "application/octet-stream"
        Diagnostics.shared.logRequest(method: "GET", path: "/" + rel, status: 200)
        // ⚠ 黑屏迭代史（真机诊断实证，别回退）：
        //   build 23: 404 空体 → didFinish ✓（但没内容，黑屏）
        //   build 26: .raw 200 无 Content-Length → WebKit 等不到 body 边界，挂起 ✗
        //   build 27: .raw + 手写 Content-Length + "Connection: close" → 响应完立即断开，
        //             命中 WebKit 网络栈连接池/预连接竞态，主文档 102「帧框加载已中断」✗
        //   根因：.raw 在 Swifter 里 content().length 恒为 -1，respond() 永远走
        //   keep-alive 分支不成立 → 必然响应完关连接。唯一出路是 length >= 0 的
        //   响应构造：.ok(.data(...)) 会自动写 Content-Length + Connection: keep-alive
        //   并保持连接打开 —— 与主流服务器一致，WebKit 千锤百炼的路径。
        //   代价：Swifter 1.5.0 的 .ok 仅单参数（body），无法附加 Cache-Control 头。
        //   子资源「旧缓存」靠前端资源引用自带的 ?v= 缓存戳规避：每次发版都升戳，
        //   子资源 URL 必然变化，WKWebView 不会命中旧版本；主文档另用
        //   reloadIgnoringLocalAndRemoteCacheData 兜底。因此无需 .ok 携带 no-cache。
        return .ok(.data(data, contentType: mime))
    }
}
