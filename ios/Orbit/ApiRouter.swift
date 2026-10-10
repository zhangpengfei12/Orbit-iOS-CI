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
        ApiOsr.register(into: server)   // 设备链路真实实现，覆盖上面的占位同名路径
    }
}
