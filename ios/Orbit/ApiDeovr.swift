import Foundation
import Swifter

/// DeoVR / HereSphere 联动端点（真实 TCP 实现）。
///
/// 对齐安卓 WebServer.kt:443-473 的契约，覆盖 ApiStubs 里那几个占位：
///   GET  /api/deovr/status
///   POST /api/deovr/connect     { host, mode }
///   POST /api/deovr/disconnect
///   POST /api/deovr/discover    → { found, ip }
///
/// 前端 app.js:2801-2851 消费：connect 带 {host, mode:'deovr'}，
/// discover 成功后把返回的 ip 填进 host 输入框再自动 connect。
enum ApiDeovr {

    private static let lock = NSLock()
    private static var client: DeoVrClient?
    private static var host_ = ""
    private static var mode_ = "NONE"

    static func register(into server: HttpServer) {
        server.get["/api/deovr/status"] = { _ in json(statusDict()) }

        server.post["/api/deovr/connect"] = { req in
            guard let body = parseJSON(req) else { return apiError("invalid_json") }
            let host = ((body["host"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
            guard !host.isEmpty else { return apiError("missing host") }
            let mode = (body["mode"] as? String) ?? "deovr"
            disconnect()

            lock.lock()
            host_ = host
            mode_ = mode
            // 状态回调只记诊断日志；对外状态由 /api/deovr/status 轮询拉取
            // （enum 的 static 上下文里没有 self，不能用 [weak self]）
            let c = DeoVrClient(host: host) { st in
                Diagnostics.shared.log("DEOVR", "状态 \(st.connected ? "已连接" : "未连接")"
                    + " playing=\(st.playing) t=\(st.currentTimeSec)"
                    + (st.error.map { " 错误=\($0)" } ?? ""))
            }
            client = c
            lock.unlock()
            c.start()
            return json(statusDict())
        }

        server.post["/api/deovr/disconnect"] = { _ in
            disconnect()
            return json(statusDict())
        }

        server.post["/api/deovr/discover"] = { _ in
            let ip = DeoVrClient.discoverLocal()
            return json(["found": ip != nil, "ip": ip ?? ""] as [String: Any])
        }
    }

    // MARK: - 状态

    /// 字段对齐安卓 deovrStatusJson()：前端只读 status / host / mode /
    /// connected / path / title / currentTime / duration / playing。
    private static func statusDict() -> [String: Any] {
        lock.lock()
        let s = client?.state()
        let host = host_
        let mode = mode_
        lock.unlock()

        let connected = s?.connected == true
        let st: String
        if s?.error != nil { st = "ERROR" }
        else if !connected { st = "STOPPED" }
        else if s?.playing == true { st = "PLAYING" }
        else { st = "PAUSED" }

        let path = s?.path ?? ""
        // title 取路径最后一段，两种分隔符都要认（Windows 共享路径可能带反斜杠）
        let title = path.components(separatedBy: "/").last?
            .components(separatedBy: "\\").last ?? path

        var out: [String: Any] = [
            "status": st,
            "host": host,
            "mode": mode,
            "connected": connected,
            "path": path,
            "title": title,
            "currentTime": s?.currentTimeSec ?? 0.0,
            "duration": s?.durationSec ?? 0.0,
            "playing": s?.playing == true,
            // 脚本随动需要本地 funscript 加载链路，iOS 尚未接入，先给空值占位
            "scriptName": "",
            "scriptLoaded": false
        ]
        if let e = s?.error { out["error"] = e }
        return out
    }

    private static func disconnect() {
        lock.lock()
        let c = client
        client = nil
        host_ = ""
        mode_ = "NONE"
        lock.unlock()
        c?.stop()
    }
}
