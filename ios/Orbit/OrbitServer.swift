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

    /// bundle 内 web/ 目录路径。顶层 web/ 以「文件夹引用」方式拷进 Resources，
    /// 因此目录结构保持为 <bundle>/web/{home.html,index.html,player.html,js,css,img}。
    private var webRoot: String? {
        Bundle.main.resourceURL?.appendingPathComponent("web").path
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
            self?.serveFile(request.path) ?? .notFound
        }

        // API 路由：web 实际调用的 /api/* 端点集中注册（见 ApiRouter.swift 及各分组文件）
        ApiRouter.register(into: server)

        do {
            try server.start(OrbitServer.port, forceIPv4: true)
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

    /// 从 bundle 的 web/ 里取文件返回。HTML/JS/CSS 一律 no-cache，
    /// 对齐 WebServer.kt 的策略 —— 覆盖安装后「旧 HTML 配新 JS」会表现成升级后点击无反应。
    private func serveFile(_ relative: String) -> HttpResponse {
        guard let root = webRootPath else { return .internalServerError }

        var rel = relative
        if rel.hasPrefix("/") { rel.removeFirst() }
        if rel.isEmpty { rel = "home.html" }
        // 目录穿越防护：任何 .. 片段直接拒掉
        guard !rel.components(separatedBy: "/").contains("..") else { return .notFound }

        let full = (root as NSString).appendingPathComponent(rel)
        guard FileManager.default.fileExists(atPath: full),
              let data = try? Data(contentsOf: URL(fileURLWithPath: full)) else {
            return .notFound
        }
        let mime = (full as NSString).pathExtension.mimeType()
        return .raw(200, "OK", ["Content-Type": mime, "Cache-Control": "no-cache"]) { writer in
            try writer.write(data)
        }
    }
}
