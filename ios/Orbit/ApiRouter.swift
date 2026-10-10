import Foundation
import Swifter

// MARK: - 全局响应 / 解析辅助

/// 把字典包成 200 JSON 响应。Swifter 会自动加 Content-Type: application/json，
/// 与安卓 WebServer.kt 的响应头对齐（前端 fetch().json() 依赖这个）。
func json(_ obj: [String: Any]) -> HttpResponse {
    return .ok(.json(obj))
}

/// 解析 POST 请求体 JSON。安卓要求 Content-Type: application/json（见 ENDPOINTS.md），
/// Swifter 已按 Content-Length 预读 body 到 request.body（[UInt8]）。
func parseJSON(_ req: HttpRequest) -> [String: Any]? {
    let data = Data(req.body)
    guard !data.isEmpty else { return [:] }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
}

/// 错误响应：对齐 ENDPOINTS.md 的约定字段 "ok":false,"error":"..."。
func apiError(_ error: String) -> HttpResponse {
    return .ok(.json(["ok": false, "error": error]))
}

/// 取 URL 查询参数。
///
/// ⚠ 刻意自己从 request.path 解析，而不是用 Swifter 的 request.queryParams：
///   Swifter 备份源码里看不到 queryParams 的填充点，无法确认它是否做过
///   percent-decoding；而安卓侧 NanoHTTPD 是解码一次。解码次数不一致的后果很隐蔽——
///   中文路径/空格会出现「解码两次变乱码」或「一次都没解、带 %E4%B8%AD 去连 SMB」。
///   这里保证**有且仅有一次**解码，与安卓行为对齐。
///   （request.path 在 Swifter 里是带查询串的，见 OrbitServer.serveFile 的剥离逻辑。）
func queryParams(_ req: HttpRequest) -> [String: String] {
    var out: [String: String] = [:]
    guard let qIdx = req.path.firstIndex(of: "?") else {
        // 兜底：万一这个 Swifter 版本的 path 已经剥掉了查询串，就退回用库自带的
        // queryParams（它是否解码过不确定，故只对仍带 %XX 的值补一次解码）。
        for (k, v) in req.queryParams {
            out[k.removingPercentEncoding ?? k] = v.removingPercentEncoding ?? v
        }
        return out
    }
    let raw = String(req.path[req.path.index(after: qIdx)...])
    // 先按 & 切，再按第一个 = 切：值里可能自带 =（base64 类参数不能被截断）
    for pair in raw.components(separatedBy: "&") {
        guard let eq = pair.firstIndex(of: "=") else { continue }
        let k = String(pair[..<eq])
        let v = String(pair[pair.index(after: eq)...])
        out[k.removingPercentEncoding ?? k] = v.removingPercentEncoding ?? v
    }
    return out
}

/// 未实现端点占位：返回 ok:true + implemented:false + note，避免前端 404 静默失败。
/// 设备/媒体类端点先走这里，等 M1/M2 联调时再补全真实逻辑。
func notImplemented(_ note: String) -> HttpResponse {
    return .ok(.json(["ok": true, "implemented": false, "note": note]))
}

// MARK: - 路由总注册

/// 所有 /api/* 路由的集中注册处。
/// 分组：系统类（status/progress/refresh/license）、设置类（settings/*、osr/settings 等）、
/// 设备/媒体类占位（其余暂时返回未实现状态，避免前端 404 崩溃）。
enum ApiRouter {
    static func register(into server: HttpServer) {
        ApiSystem.register(into: server)
        ApiSettings.register(into: server)
        ApiStubs.register(into: server)
        ApiSmb.register(into: server)   // SMB 真实实现，覆盖 ApiStubs 里的占位同名路径
        ApiDeovr.register(into: server) // DeoVR TCP 真实实现，覆盖 ApiStubs 里的占位同名路径
        ApiOsr.register(into: server)   // 设备链路真实实现，覆盖上面的占位同名路径
    }
}
