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
        // 注：/api/browse/local 的真实实现在 ApiMedia（浏览 App 沙盒媒体目录），
        //     这里不再注册占位，避免同名路径双重注册。
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

        // ── VR 蓝牙时间桥（安卓 2.7.43 新增；iOS 尚未实现）──
        // 安卓做法是两端都装 Orbit：头显端用回环 127.0.0.1:23554 取时间轴，再经 BLE 广播。
        // iOS 暂无这条链路，但**不能让它 404**——前端 app.js 启动时就会拉 vrbt/status，
        // 404 会走 catch 分支并打断 VR 页初始化。返回 200 + implemented:false 让它降级成「未支持」。
        // scan 两种 method 都注册：安卓的 handleVrBt 对 scan 同时支持 POST（起扫描）与 GET（取结果）。
        for m in ["/api/vrbt/connect", "/api/vrbt/disconnect", "/api/vrbt/scan"] {
            server.post[m] = { _ in notImplemented("VR 蓝牙时间桥（iOS 暂未实现）") }
        }
        server.get["/api/vrbt/scan"] = { _ in json(["ok": true, "devices": [] as [Any]]) }
        server.get["/api/vrbt/status"] = { _ in
            // ⚠ role 必须是**空串**而不是 "sink"：前端 vrbtRenderStatus 的 else 分支才是
            //   「未启用」，而 "SINK" 分支会显示「未连接」——那是"功能存在但没连上"的语义，
            //   在 iOS 上纯属误导（安卓 VrBleBridge 未启用时同样返回空 role）。
            json(["ok": true, "connected": false, "role": "", "transport": "",
                  "script": "", "scriptLoaded": false,
                  "implemented": false, "note": "VR 蓝牙时间桥（iOS 暂未实现）"] as [String: Any])
        }

        // ── AI 生成脚本（iOS 暂无视频逐帧分析管线）──
        // 后处理算法（FunscriptPost）已移植就位，缺的是「解码视频 → 运动分析」这一段。
        // ⚠ 绝不能返回 ok:true + running:false：player.js 的 startAutoGenerate 一旦拿到
        //   ok:true 就 enterRunning() → pollGenStatus()，而 status 的 running=false 且
        //   phase 不是 'done' 会直接判成「生成脚本失败（未知原因）」，胶囊上挂着一句假失败。
        //   正确做法是 start 明确失败（ok:false + error），让前端走 fail 文案而不是假进度。
        //   （正常路径根本不会到这里：funscript-auto 已返回 canGenerate=false。）
        // ⚠ status 是 POST（前端用 postJson 带 {full:1}），不是 GET。
        server.post["/api/osr/funscript-gen/start"] = { _ in
            json(["ok": false, "error": "ios_unsupported", "running": false,
                  "note": "iOS 暂无视频逐帧分析管线，无法生成脚本"] as [String: Any])
        }
        for m in ["/api/osr/funscript-gen/cancel", "/api/osr/funscript-gen/status"] {
            server.post[m] = { _ in
                json(["ok": false, "error": "ios_unsupported", "running": false,
                      "note": "iOS 暂无视频逐帧分析管线，无法生成脚本"] as [String: Any])
            }
        }

        // ── AI 生成脚本的面板入口（/api/record/*；iOS 无视频逐帧分析管线）──
        // ⚠⚠ 绝不能返回 ok:true：recStart() 一见 ok:true 就 recSetBusy('生成中…') 并起轮询，
        //    而 status 恒 running=false → 进度条永远停在「投递任务…」，用户只看到干等。
        //    这和「立即更新」按钮转圈是同一类坑：桥的 Proxy 让前端以为能力存在。
        //    现在 start 明确失败（前端弹「生成未能启动：…」）；更进一步，
        //    app.js 的 recApplyPlatformGate() 在 iOS 上直接禁用按钮并说明替代路径。
        let recMsg = "iOS 暂不支持自动生成脚本（无视频逐帧分析管线）"
        for m in ["/api/record/start", "/api/record/write", "/api/record/probe"] {
            server.post[m] = { _ in
                json(["ok": false, "error": recMsg, "implemented": false] as [String: Any])
            }
        }
        // check 的字段与安卓一致：writable=false + reason，前端会显示 reason。
        server.post["/api/record/check"] = { _ in
            json(["ok": false, "writable": false, "reason": recMsg,
                  "implemented": false] as [String: Any])
        }
        // cancel 是纯取消，没有任务时成功即可，别让前端弹失败。
        server.post["/api/record/cancel"] = { _ in json(["ok": true]) }

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
        // 前端 pollScanStatus 读的是 isScanning（不是 running）：字段对不上会被判成
        // 「没在扫」，进度条直接跳「扫描完成」。iOS 的 /api/refresh 是同步重建索引，
        // 本来就没有长任务，这里如实报「未在扫描」并顺带带上安卓同名字段。
        server.get["/api/scan/status"] = { _ in
            json(["ok": true, "isScanning": false, "running": false,
                  "found": 0, "nfoCount": 0] as [String: Any])
        }
        server.post["/api/scan/stop"] = { _ in json(["ok": true]) }
        server.post["/api/upload/cover"] = { _ in notImplemented("封面上传（multipart，M1 接入）") }
        server.get["/api/video/codec"] = { _ in json(["ok": true, "codec": "h264"]) }
        server.get["/api/video/codec-support"] = { _ in json(["ok": true, "codecs": ["h264", "hevc"] as [Any]]) }
        server.get["/api/video/original-uri"] = { _ in apiError("no_source") }
    }
}
