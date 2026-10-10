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

        // MARK: - 脚本播放链路
        //
        // ⚠ iOS 之前整段缺失（只有 send/reset 这类单次指令），后果是：
        //   前端 postJson('/api/osr/script', {action:'play'}) 拿到 404 →
        //   osrSyncEnabled 永远 false → **加载了脚本设备也不动**。
        //   这是「iOS 版功能不正常」里最致命的一条，故整套补齐（由 ScriptPlayer 驱动）。

        // 脚本播放页：开始 / 暂停 / 停止
        server.post["/api/osr/script"] = { req in
            guard let body = parseJSON(req) else { return apiError("invalid_json") }
            let action = OsrLink.asStr(body["action"], "")
            return json(["ok": ScriptPlayer.shared.control(action)])
        }

        // 同步开关（用户「同步播放」设置）
        server.post["/api/osr/sync"] = { req in
            guard let body = parseJSON(req) else { return apiError("invalid_json") }
            ScriptPlayer.shared.setSync(OsrLink.asBool(body["enabled"], false))
            return json(["ok": true])
        }

        // 播放时钟上报（前端每 250ms 一次，只作纠偏：漂移 >500ms 才重锚）
        server.post["/api/osr/playback-time"] = { req in
            guard let body = parseJSON(req) else { return apiError("invalid_json") }
            ScriptPlayer.shared.setPlaybackClock(
                playing: OsrLink.asBool(body["playing"], true),
                timeMs: Int64(OsrLink.asInt(body["timeMs"], 0)))
            return json(["ok": true])
        }

        // 独立冲刺：GET 回读真实状态（前端刷新按钮态），POST 设置
        server.get["/api/osr/dash-mode"] = { _ in json(ScriptPlayer.shared.dashState()) }
        server.post["/api/osr/dash-mode"] = { req in
            guard let body = parseJSON(req) else { return apiError("invalid_json") }
            ScriptPlayer.shared.setDash(on: OsrLink.asBool(body["on"], false),
                                        speed: Float(dbl(body["speed"], 60)),
                                        amp: OsrLink.asInt(body["amp"], 100))
            return json(ScriptPlayer.shared.dashState())
        }

        // 自动模式：stop / sine / random / freeplay
        server.post["/api/osr/playmode"] = { req in
            guard let body = parseJSON(req) else { return apiError("invalid_json") }
            let mode = OsrLink.asStr(body["mode"], "")
            if mode == "stop" {
                ScriptPlayer.shared.stopMotion()
                return json(["ok": true])
            }
            guard ["sine", "random", "freeplay"].contains(mode) else { return apiError("unknown_mode") }
            // intensity / duration 前端传 0–1 小数，freq 是次数（整数）；
            // 用 dbl 取值再缩放，不能走 asInt（0.6 会被截成 0）。
            ScriptPlayer.shared.setAutoMode(mode,
                                            intensity: Float(dbl(body["intensity"], 0.6)),
                                            speed: Float(dbl(body["freq"], 50)),
                                            duration: Float(dbl(body["duration"], 0.3)))
            return json(["ok": true])
        }

        // 直接塞脚本文本（AI 生成兜底路径用）
        server.post["/api/osr/funscript"] = { req in
            guard let body = parseJSON(req) else { return apiError("invalid_json") }
            let text = OsrLink.asStr(body["text"], "")
            return json(["ok": text.isEmpty ? false : ScriptPlayer.shared.loadText(text)])
        }

        // 视频随播脚本：按视频 key 找同名脚本组（<video>.funscript / <video>.<轴>.funscript）
        server.post["/api/osr/funscript-auto"] = { req in
            guard let body = parseJSON(req) else { return apiError("invalid_json") }
            let key = OsrLink.asStr(body["key"], "")
            let pairs = ApiOsr.scriptsBesideVideo(key)
            let ok: Bool
            if pairs.isEmpty {
                // 关键：换到无脚本视频必须显式卸掉，否则上一部片的脚本会继续推（串片）
                if !key.isEmpty { ScriptPlayer.shared.clearScript() }
                ok = false
            } else {
                ok = ScriptPlayer.shared.merge(pairs)
            }
            var out: [String: Any] = [
                "ok": ok,
                "source": ok ? "beside" : "none",
                "count": pairs.count,
                "names": pairs.map { $0.0 },
                "videoBase": ApiOsr.videoBase(of: key),
                "folderRoots": [] as [Any],
                "tried": ["beside=\(pairs.count)"],
                "duration": ScriptPlayer.shared.durationSec(),
                // iOS 无视频逐帧分析管线，明确告知前端别发起生成
                "canGenerate": false,
                "genId": "",
                "genReason": "iOS 暂无视频逐帧分析管线，AI 生成脚本不可用",
                "genBusy": false
            ]
            return json(out)
        }

        // 脚本播放页：加载文件夹内所有 .funscript 并合并
        server.post["/api/osr/funscripts"] = { req in
            guard let body = parseJSON(req) else { return apiError("invalid_json") }
            let folder = OsrLink.asStr(body["folder"], "")
            guard !folder.isEmpty else { return apiError("missing_folder") }
            let pairs = ApiOsr.readFunscriptsIn(folder)
            guard !pairs.isEmpty else { return apiError("no_funscript") }
            let ok = ScriptPlayer.shared.merge(pairs)
            return json(["ok": ok, "count": pairs.count,
                         "duration": ScriptPlayer.shared.durationSec(),
                         "names": pairs.map { $0.0 }])
        }

        // 手控触板「运行已保存脚本」：按路径读回 → 合并 → 立即起播
        server.post["/api/osr/funscript-play"] = { req in
            guard let body = parseJSON(req) else { return apiError("invalid_json") }
            guard let arr = body["files"] as? [[String: Any]] else { return apiError("missing_files") }
            var pairs: [(String, String)] = []
            for o in arr {
                let p = OsrLink.asStr(o["path"], "")
                guard !p.isEmpty, let t = ApiOsr.readMediaText(p) else { continue }
                pairs.append(((p as NSString).lastPathComponent, t))
            }
            guard !pairs.isEmpty else { return apiError("no_file") }
            guard ScriptPlayer.shared.merge(pairs) else { return apiError("bad_script") }
            return json(["ok": ScriptPlayer.shared.control("play"),
                         "count": pairs.count,
                         "duration": ScriptPlayer.shared.durationSec()])
        }

        // ── 触板轨迹存脚本：iOS 没有 SAF 树授权，固定落到沙盒 Media/Patterns ──
        server.post["/api/osr/touchpad-save"] = { req in
            guard let body = parseJSON(req) else { return apiError("invalid_json") }
            let name = OsrLink.asStr(body["name"], "").trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty else { return apiError("missing_name") }
            guard let actions = body["actions"] as? [[String: Any]], !actions.isEmpty else {
                return apiError("no_action")
            }
            return json(ApiOsr.saveTouchpad(name: name, actions: actions))
        }
        server.post["/api/osr/touchpad-delete"] = { req in
            guard let body = parseJSON(req) else { return apiError("invalid_json") }
            let files = body["files"] as? [String] ?? []
            var removed = 0
            for rel in files {
                guard let url = Self.mediaURL(rel) else { continue }
                if (try? FileManager.default.removeItem(at: url)) != nil { removed += 1 }
            }
            return json(["ok": true, "removed": removed])
        }

        // ── USB / 串口：iOS 没有任何对应能力，返回空列表而不是 404 ──
        // 前端 osr.js 启动会拉 usb-devices；404 会让设备页初始化中断。
        server.get["/api/osr/usb-devices"] = { _ in
            json(["ok": true, "devices": [] as [Any],
                  "note": "iOS 不支持 USB 主机（OTG）与串口，请用蓝牙或 WiFi 连接"])
        }
        server.post["/api/osr/usb-scan"] = { _ in
            json(["ok": true, "devices": [] as [Any],
                  "note": "iOS 不支持 USB 主机（OTG）与串口，请用蓝牙或 WiFi 连接"])
        }

        // ── TCode 版本：真实落盘（此前占位恒回 AUTO，改了不生效）──
        server.post["/api/osr/tcode-version"] = { req in
            guard let body = parseJSON(req) else { return apiError("invalid_json") }
            let v = OsrLink.asStr(body["version"], "V3")
            var cur = OrbitConfig.shared.dictionary(forKeyPath: "settings.osr")
            cur["tcodeVersion"] = v
            OrbitConfig.shared.set(cur, forKeyPath: "settings.osr")
            OrbitConfig.shared.save()
            return json(["ok": true, "tcodeVersion": v])
        }
    }

    // MARK: - 脚本文件定位（App 沙盒 Media 目录）

    /// 取浮点参数：intensity / duration 前端传 0–1 小数，整数解析会把 0.6 截成 0。
    private static func dbl(_ v: Any?, _ def: Double) -> Double {
        if let n = v as? NSNumber { return n.doubleValue }
        if let d = v as? Double { return d }
        if let s = v as? String { return Double(s) ?? def }
        return def
    }

    /// Documents 根。
    private static func docsDir() -> URL? {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
    }

    /// 把「Documents 相对路径」解析成 URL；挡掉 ../ 穿越。
    private static func mediaURL(_ rel: String) -> URL? {
        let t = rel.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !t.isEmpty, !t.components(separatedBy: "/").contains("..") else { return nil }
        return docsDir()?.appendingPathComponent(t)
    }

    private static func readMediaText(_ rel: String) -> String? {
        guard let url = mediaURL(rel) else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }

    /// 视频基名（去掉目录与扩展名），用于匹配同名脚本。
    private static func videoBase(of key: String) -> String {
        let name = (key as NSString).lastPathComponent
        return (name as NSString).deletingPathExtension
    }

    /// 找视频同目录里与视频同名的脚本组：<base>.funscript 与 <base>.<轴>.funscript。
    /// 只认「同目录 + 同名」，不做跨目录兜底（否则会串到别的视频的脚本上）。
    private static func scriptsBesideVideo(_ key: String) -> [(String, String)] {
        guard let url = mediaURL(key) else { return [] }
        let dir = url.deletingLastPathComponent()
        let base = videoBase(of: key)
        guard !base.isEmpty,
              let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
        var out: [(String, String)] = []
        for n in names where n.hasSuffix(".funscript") {
            let body = (n as NSString).deletingPathExtension
            guard body == base || body.hasPrefix(base + ".") else { continue }
            if let t = try? String(contentsOf: dir.appendingPathComponent(n), encoding: .utf8) {
                out.append((n, t))
            }
        }
        return out
    }

    /// 读某个目录下所有 .funscript（脚本播放页「整个文件夹」模式）。
    private static func readFunscriptsIn(_ folder: String) -> [(String, String)] {
        guard let dir = mediaURL(folder) else { return [] }
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
        var out: [(String, String)] = []
        for n in names where n.hasSuffix(".funscript") {
            if let t = try? String(contentsOf: dir.appendingPathComponent(n), encoding: .utf8) {
                out.append((n, t))
            }
        }
        return out
    }

    // MARK: - 触板轨迹 → funscript

    /// 触板录制轨迹存成多轴脚本：<name>.funscript（L0，上下）+ <name>.R0/R1.funscript（左右）。
    /// 对齐安卓 TouchpadSaver 的分轴命名——后续 funscript-play 靠文件名定轴。
    private static func saveTouchpad(name: String, actions: [[String: Any]]) -> [String: Any] {
        guard let docs = docsDir() else { return ["ok": false, "error": "no_documents"] }
        let dir = docs.appendingPathComponent("Media/Patterns", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        var l0: [[String: Any]] = []
        var r0: [[String: Any]] = []
        var r1: [[String: Any]] = []
        var lastAt: Int64 = 0
        for a in actions {
            let at = (a["at"] as? NSNumber)?.int64Value ?? 0
            let x = Int((a["x"] as? NSNumber)?.doubleValue ?? 50)
            let y = Int((a["y"] as? NSNumber)?.doubleValue ?? 50)
            // 触板坐标 0–100：y 向上为行程高位（L0），x 左右映射到两臂
            l0.append(["at": at, "pos": clamp(100 - y, 0, 100)])
            let lateral = clamp(50 + (x - 50), 0, 100)
            r0.append(["at": at, "pos": lateral])
            r1.append(["at": at, "pos": clamp(100 - lateral, 0, 100)])
            if at > lastAt { lastAt = at }
        }
        let files = [
            ("\(name).funscript", l0),
            ("\(name).R0.funscript", r0),
            ("\(name).R1.funscript", r1)
        ]
        var rels: [String] = []
        for (fn, arr) in files {
            let target = dir.appendingPathComponent(fn)
            let obj: [String: Any] = ["actions": arr,
                                      "metadata": ["duration": Double(lastAt) / 1000.0]]
            guard let data = try? JSONSerialization.data(withJSONObject: obj) else { continue }
            do {
                try data.write(to: target)
                rels.append("Media/Patterns/\(fn)")
            } catch {
                Diagnostics.shared.log("TOUCHPAD", "写脚本失败 \(fn)：\(error)")
            }
        }
        guard !rels.isEmpty else { return ["ok": false, "error": "write_failed"] }
        return ["ok": true, "name": name, "path": rels[0],
                "count": l0.count, "durationMs": lastAt, "files": rels]
    }
}
