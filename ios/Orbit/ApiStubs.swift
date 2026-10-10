import Foundation
import Swifter

/// 设备 / 媒体库 / 分析 / 录制 / 视频类端点的占位实现。
///
/// 这批端点依赖硬件（BLE/TCP/USB）、本地媒体库（Document Picker + bookmark）、
/// 或真机能力，在 M1/M2 联调前无法完整实现。这里统一返回**结构化占位响应（200）**，
/// 避免前端 fetch 拿到 404 后静默失败或白屏。
///
/// 媒体库类（libraries/items/actors）返回空数组，让前端媒体页能正常渲染「暂无内容」；
/// 设备/分析类返回 implemented:false + note，前端据此显示「未支持」提示而非崩溃。
enum ApiStubs {

    static func register(into server: HttpServer) {

        // ── 媒体库类：返回空结构（M1 接 Document Picker + bookmark） ──
        server.get["/api/libraries"] = { _ in
            json(["ok": true, "libraries": [] as [Any],
                  "activeLibraryId": OrbitConfig.shared.int(forKeyPath: "activeLibraryId")])
        }
        server.post["/api/libraries"] = { _ in json(["ok": true]) }
        server.get["/api/items"] = { _ in json(["ok": true, "items": [] as [Any], "total": 0]) }
        server.get["/api/items/:id"] = { _ in json(["ok": true, "item": [:]] as [String: Any]) }
        server.get["/api/actors"] = { _ in json(["ok": true, "actors": [] as [Any]]) }
        server.get["/api/actors/:name"] = { _ in json(["ok": true, "actor": [:]] as [String: Any]) }
        server.get["/api/browse/local"] = { _ in json(["ok": true, "items": [] as [Any]]) }
        server.get["/api/browse/smb"] = { _ in notImplemented("SMB 浏览（iOS M1 接入 AMSMB2）") }

        // ── 分析任务类（iOS 暂无本地扫描管线） ──
        for m in ["/api/analyze/pause", "/api/analyze/resume", "/api/analyze/stop"] {
            server.post[m] = { _ in notImplemented("分析任务（iOS 暂无本地扫描管线）") }
        }
        server.get["/api/analyze/status"] = { _ in json(["ok": true, "running": false]) }

        // ── DeoVR 联动（iOS 暂未实现） ──
        for m in ["/api/deovr/connect", "/api/deovr/disconnect", "/api/deovr/discover"] {
            server.post[m] = { _ in notImplemented("DeoVR 联动（iOS 暂未实现）") }
        }
        server.get["/api/deovr/status"] = { _ in json(["ok": true, "connected": false]) }

        // ── OSR 设备类：真实实现见 ApiOsr.swift（BLE/UDP 链路）──
        server.post["/api/osr/dash-mode"] = { req in
            guard let body = parseJSON(req) else { return apiError("invalid_json") }
            Diagnostics.shared.log("DASH", "冲刺指令 on=\(body["on"] ?? false) speed=\(body["speed"] ?? 0)")
            return json(["ok": true])
        }
        server.post["/api/osr/playback-time"] = { _ in json(["ok": true, "time": 0]) }
        server.post["/api/osr/single-axis-fill"] = { _ in json(["ok": true]) }
        server.post["/api/osr/tcode-version"] = { _ in json(["ok": true, "version": "AUTO"]) }

        // ── 录制 / 扫描 / 上传 / 视频 ──
        server.post["/api/record/status"] = { _ in json(["ok": true, "recording": false]) }
        server.get["/api/scan/status"] = { _ in json(["ok": true, "running": false]) }
        server.post["/api/scan/stop"] = { _ in json(["ok": true]) }
        server.post["/api/upload/cover"] = { _ in notImplemented("封面上传（multipart，M1 接入）") }
        server.get["/api/video/codec"] = { _ in json(["ok": true, "codec": "h264"]) }
        server.get["/api/video/codec-support"] = { _ in json(["ok": true, "codecs": ["h264", "hevc"] as [Any]]) }
        server.get["/api/video/original-uri"] = { _ in apiError("no_source") }
    }
}
