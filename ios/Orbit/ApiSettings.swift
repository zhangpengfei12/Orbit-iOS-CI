import Foundation
import Swifter

/// 设置类端点：settings/* 与 osr/settings、osr/axes、osr/status、osr/reset。
/// 全部读写 OrbitConfig（对齐安卓 ConfigStore.kt 的字段名），纯逻辑可完整实现。
enum ApiSettings {

    static func register(into server: HttpServer) {
        registerSimple(server, "/api/settings/local", "settings.local")
        registerSimple(server, "/api/settings/smb", "settings.smb")
        registerSimple(server, "/api/settings/axes", "settings.axes")
        registerSimple(server, "/api/settings/analyze", "settings.analyze")
        registerSimple(server, "/api/osr/settings", "settings.osr")
        registerSimple(server, "/api/osr/axes", "settings.axes")
        // 注：osr/status、osr/reset 已移到 ApiOsr（真实设备链路实现）
    }

    /// 通用「GET 返回当前子字典 / POST 用请求体整体覆盖该子字典」处理器
    private static func registerSimple(_ server: HttpServer, _ path: String, _ cfgPath: String) {
        server.get[path] = { _ in
            json(OrbitConfig.shared.dictionary(forKeyPath: cfgPath))
        }
        server.post[path] = { req in
            guard let body = parseJSON(req) else {
                return apiError("invalid_json")
            }
            OrbitConfig.shared.set(body, forKeyPath: cfgPath)
            return json(["ok": true])
        }
    }
}
