import Foundation
import Swifter

/// OSR 设备链路端点（真实实现）：bt-status / bt-disconnect / send / reset /
/// connect-test / status / settings（合并写）。
/// 在 ApiRouter 里注册在 ApiSettings / ApiStubs 之后，同名路径覆盖占位实现。
enum ApiOsr {

    static func register(into server: HttpServer) {

        // ── 蓝牙状态：前端轮询 + 开机自动重连判断 ──
        server.get["/api/osr/bt-status"] = { _ in
            json(BtLink.shared.statusDict())
        }
        server.post["/api/osr/bt-disconnect"] = { _ in
            BtLink.shared.disconnect()
            return json(BtLink.shared.statusDict())
        }

        // ── 手动发送：{axis,pos,durationMs} 或 {axes:[{axis,pos}],durationMs} ──
        // 回显 payload 供触板排查（对齐安卓 WebServer.kt 的 send 分支）。
        server.post["/api/osr/send"] = { req in
            guard let body = parseJSON(req) else { return apiError("invalid_json") }
            let ctx = OsrLink.cmdContext()
            let dur = Int64(OsrLink.asInt(body["durationMs"], 600))
            let payload: String
            if let arr = body["axes"] as? [[String: Any]], !arr.isEmpty {
                var entries: [(String, Int)] = []
                for o in arr {
                    guard let axis = o["axis"] as? String, !axis.isEmpty else { continue }
                    entries.append((axis, OsrLink.asInt(o["pos"], 5000)))
                }
                guard !entries.isEmpty else {
                    return json(["ok": false, "detail": "axes 里没有有效轴"])
                }
                payload = buildAxesPosCommand(ctx, entries, dur)
            } else if let axis = body["axis"] as? String, !axis.isEmpty {
                payload = buildAxisPosCommand(ctx, axis, OsrLink.asInt(body["pos"], 5000), dur)
            } else {
                return json(["ok": false, "detail": "缺少 axis/axes 参数"])
            }
            let full = ctx.prefix + payload + ctx.suffix
            let r = OsrLink.dispatch(full)
            return json(["ok": r.ok, "detail": r.detail,
                         "payload": String(full.prefix(120))])
        }

        // ── 设备复位：六轴回中。ok 恒 true，delivered 表示指令是否真的送达
        //（对齐安卓：本地状态一定复位成功，指令没送达只报 delivered=false）。
        server.post["/api/osr/reset"] = { _ in
            let ctx = OsrLink.cmdContext()
            let entries = AXIS_NAMES.map { ($0, AXIS_VALUE_MAX / 2) }
            let cmd = buildAxesPosCommand(ctx, entries, 600)
            let full = ctx.prefix + cmd + ctx.suffix
            let r = OsrLink.dispatch(full)
            Diagnostics.shared.log("OSR", "reset delivered=\(r.ok) detail=\(r.detail)")
            return json(["ok": true, "delivered": r.ok, "detail": r.detail])
        }

        // ── 连接测试：按协议发一组示例动作（L0 大幅往复）──
        server.post["/api/osr/connect-test"] = { _ in
            let ctx = OsrLink.cmdContext()
            let cmd = buildTestCommand(ctx)
            let full = ctx.prefix + cmd + ctx.suffix
            let r = OsrLink.dispatch(full)
            return json(["ok": r.ok, "detail": r.detail])
        }

        // ── 真实链路状态（首页「设备」磁贴副标题的依据）──
        server.get["/api/osr/status"] = { _ in
            let d = OsrLink.osrSettings()
            let type = OsrLink.asStr(d["connectionType"], "UDP")
            let connected = (type == "BluetoothSerial") ? BtLink.shared.isConnected : true
            return json(["ok": true, "connected": connected, "connectionType": type])
        }

        // ── 设置保存：合并写（对齐安卓 saveSettingsJson 的合并语义）并回显全量。
        // 旧版整体覆盖会把前端未带的 axisParams/connectionType 冲回默认值。
        server.post["/api/osr/settings"] = { req in
            guard let body = parseJSON(req) else { return apiError("invalid_json") }
            var cur = OrbitConfig.shared.dictionary(forKeyPath: "settings.osr")
            for (k, v) in body { cur[k] = v }
            OrbitConfig.shared.set(cur, forKeyPath: "settings.osr")
            OrbitConfig.shared.save()
            return json(cur)
        }
    }
}
