import Foundation
import Network
import AVFoundation
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
            let d = OsrLink.osrSettings()
            let tgt = (OsrLink.asStr(d["connectionType"], "UDP") == "BluetoothSerial")
                ? "bt:\(OsrLink.asStr(d["btAddress"], ""))"
                : "\(OsrLink.asStr(d["ip"], "192.168.1.88")):\(OsrLink.asInt(d["port"], 8000))"
            Diagnostics.shared.log("OSR", "reset target=\(tgt) delivered=\(r.ok) detail=\(r.detail)")
            return json(["ok": true, "delivered": r.ok, "detail": r.detail])
        }

        // ── 连接测试：按协议发一组示例动作（L0 大幅往复）──
        // 除发送结果外附带两样诊断信息（UDP 无回执，「已发送」≠「设备收到」）：
        //   target —— 指令实际发往的地址，排掉「填错 IP 还以为连着」
        //   tcp    —— 对同一地址的 TCP 探测，作可达性参考
        server.post["/api/osr/connect-test"] = { _ in
            let d = OsrLink.osrSettings()
            let type = OsrLink.asStr(d["connectionType"], "UDP")
            let ctx = OsrLink.cmdContext()
            let cmd = buildTestCommand(ctx)
            let full = ctx.prefix + cmd + ctx.suffix
            let r = OsrLink.dispatch(full)
            if type == "BluetoothSerial" {
                return json(["ok": r.ok, "detail": r.detail,
                             "target": "蓝牙 \(OsrLink.asStr(d["btAddress"], ""))"])
            }
            let host = OsrLink.asStr(d["ip"], "192.168.1.88")
            let port = OsrLink.asInt(d["port"], 8000)
            let tcp = Self.tcpProbe(host: host, port: port)
            Diagnostics.shared.log("OSR", "connect-test target=\(host):\(port) sent=\(r.ok) detail=\(r.detail) tcp=\(tcp)")
            return json(["ok": r.ok, "detail": r.detail,
                         "target": "\(host):\(port)", "tcp": tcp])
        }

        // ── 真实链路状态（首页「设备」磁贴 + 设备页状态共用）──
        // 字段对齐前端：home.js 读 linkState / motionMode / lastSendError；
        // osr.js.refreshStatus 读 linkState / motionMode / lastSendError / clockPlaying。
        // ⚠ 之前只回 connected / connectionType，缺 linkState → 首页永远跌进 default 显示
        //   「未连接」（OSR 面板读的是 connected 所以正常，首页才错）。
        server.get["/api/osr/status"] = { _ in
            let d = OsrLink.osrSettings()
            let type = OsrLink.asStr(d["connectionType"], "UDP")
            let linkState: String
            if type == "BluetoothSerial" {
                linkState = BtLink.shared.isConnected ? "connected" : "disconnected"
            } else {
                linkState = OsrLink.udpLinkState()
            }
            return json([
                "ok": true,
                "connectionType": type,
                "linkState": linkState,
                "connected": (linkState == "connected"),
                "lastSendError": OsrLink.udpLastError ?? "",
                "motionMode": ScriptPlayer.shared.motionMode(),
                "clockPlaying": ScriptPlayer.shared.isPlaying()
            ])
        }

        // ── 设置读取：前端进面板时 fillForm 依赖它回填（osr.js:1273/1279）。
        // ⚠ 之前只有 POST 没有 GET → 前端 404 后把表单回填成默认值 192.168.1.88，
        //    表现为「保存后重进 IP 变回去」「改了 IP 复位仍发旧地址」。
        server.get["/api/osr/settings"] = { _ in
            json(OrbitConfig.shared.dictionary(forKeyPath: "settings.osr"))
        }

        // ── 设置保存：合并写（对齐安卓 saveSettingsJson 的合并语义）并回显全量。
        // 旧版整体覆盖会把前端未带的 axisParams/connectionType 冲回默认值。
        server.post["/api/osr/settings"] = { req in
            guard let body = parseJSON(req) else { return apiError("invalid_json") }
            var cur = OrbitConfig.shared.dictionary(forKeyPath: "settings.osr")
            for (k, v) in body { cur[k] = v }
            // 白盒诊断：记录「前端传了什么」与「写后回读是什么」。
            // 用户反馈「改 IP 保存后仍发旧地址」——有这两行就能分清是前端没传对、还是后端没写进。
            let inIp = body["ip"].map { "\($0)" } ?? "nil"
            let inPort = body["port"].map { "\($0)" } ?? "nil"
            Diagnostics.shared.log("OSR", "设置保存：收到 ip=\(inIp) port=\(inPort)")
            OrbitConfig.shared.set(cur, forKeyPath: "settings.osr")
            let back = OrbitConfig.shared.dictionary(forKeyPath: "settings.osr")
            let outIp = back["ip"].map { "\($0)" } ?? "nil"
            let outPort = back["port"].map { "\($0)" } ?? "nil"
            Diagnostics.shared.log("OSR", "设置保存：写后回读 ip=\(outIp) port=\(outPort)")
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

        // 自动模式：stop / sine / random / freeplay（字段对齐安卓 WebServer.kt "playmode" 分支）
        // ⚠ 前端 modePayload 发的是 speed（osrSimSpeed），不是 freq —— 旧版读 freq 恒取默认 50，
        //   且丢 autoSwitch / selectedIndex，freeplay 退化成「固定速度、不能选图案的单轴波」。
        server.post["/api/osr/playmode"] = { req in
            guard let body = parseJSON(req) else { return apiError("invalid_json") }
            let mode = OsrLink.asStr(body["mode"], "")
            let action = OsrLink.asStr(body["action"], "start")
            if mode == "stop" {
                ScriptPlayer.shared.stopMotion()
                return json(["ok": true])
            }
            guard ["sine", "random", "freeplay"].contains(mode) else { return apiError("unknown_mode") }
            // intensity / duration 前端传 0–1 小数；speed 是次数/分（freeplay）；
            // 用 dbl 取值再缩放，不能走 asInt（0.6 会被截成 0）。
            let intensity = Float(dbl(body["intensity"], 0.7))
            let speed = Float(dbl(body["speed"], 50))
            let duration = Float(dbl(body["duration"], 0.3))
            let auto = OsrLink.asBool(body["autoSwitch"], true)
            let sel = OsrLink.asInt(body["selectedIndex"], 0)
            // random 专用字段（strokeMode: 0 Short / 1 Long / 2 Jerk / 3 Orbit / 4 Hops）
            let stroke = OsrLink.asInt(body["strokeMode"], 1)
            let change = Float(dbl(body["change"], 30))
            let freq = Int(dbl(body["freq"], 50))
            if action == "update" {
                ScriptPlayer.shared.updateAutoMode(mode, intensity: intensity, speed: speed,
                                                   duration: duration, autoSwitch: auto,
                                                   selectedIndex: sel, strokeMode: stroke,
                                                   change: change, freq: freq)
            } else {
                ScriptPlayer.shared.setAutoMode(mode, intensity: intensity, speed: speed,
                                                duration: duration, autoSwitch: auto,
                                                selectedIndex: sel, strokeMode: stroke,
                                                change: change, freq: freq)
            }
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
            // iOS 本地脚本生成：本地（Documents/Media）视频且无同名脚本时，允许自动生成；
            // SMB 共享 / 外部路径读不了 smb://，不支持；已存在同名脚本则直接随播、不生成。
            let canGen: Bool
            let genId: String
            let genReason: String
            if !pairs.isEmpty {
                canGen = false; genId = ""; genReason = ""
            } else if key.isEmpty {
                canGen = false; genId = ""; genReason = "no_key"
            } else if let url = ApiOsr.mediaURL(key), FileManager.default.fileExists(atPath: url.path) {
                canGen = true; genId = key
            } else {
                canGen = false; genId = ""; genReason = "smb"
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
                "canGenerate": canGen,
                "genId": genId,
                "genReason": genReason,
                "genBusy": false
            ]
            return json(out)
        }

        // MARK: 本地视频自动生成脚本（对齐安卓「无脚本视频自动生成随播」）
        //
        // 前置：funscript-auto 在「本地 Media 视频且无同名脚本」时回 canGenerate:true + genId(key)；
        // 前端 startAutoGenerate 拿 genId 投递本 start，再 pollGenStatus 轮询，done 后 applyGenDone
        // 重发 funscript-auto 即可命中刚落盘的 <视频基名>.funscript → 随播。
        // 字段严格对齐 player.js 的解析分支（ok / already_running+busyId / error）。

        // ① 投递生成任务：id = 视频 key（Documents 相对路径，与 funscript-auto 的 genId 一致）。
        server.post["/api/osr/funscript-gen/start"] = { req in
            guard let body = parseJSON(req) else { return apiError("invalid_json") }
            let id = OsrLink.asStr(body["id"], "")
            guard !id.isEmpty else { return json(["ok": false, "error": "no_id"]) }
            let (ok, busyId, error) = FunscriptGenerator.shared.start(videoRel: id)
            if ok { return json(["ok": true]) }
            if let busy = busyId {
                // already_running：busyId 对得上说明是同一部片（页面重载/重复进入），
                // 前端 enterRunning 接管进度；对不上则是「AI生成脚本」页手动跑的，别抢。
                return json(["ok": false, "error": "already_running", "busyId": busy])
            }
            return json(["ok": false, "error": error ?? "start_failed"])
        }

        // ② 进度轮询：前端 pollGenStatus 轻量 {} 与全量 {full:1} 都走这里。
        // 后端统一回完整形状（含 points / duration），前端拿到 points 就不再补一次全量请求。
        server.post["/api/osr/funscript-gen/status"] = { _ in
            json(FunscriptGenerator.shared.status())
        }

        // ③ 取消：前端现状不会主动调，但要返回 200 + ok:true 兜底（状态机可能用到）。
        server.post["/api/osr/funscript-gen/cancel"] = { _ in
            FunscriptGenerator.shared.cancel()
            return json(["ok": true])
        }

        // MARK: 手动「AI 生成脚本」面板（/api/record/*）
        //
        // 与上面的自动随播共用同一个 FunscriptGenerator 单例（天然互斥：同一时刻只有一个任务），
        // 差别只是入口与参数来源：这里由用户在面板里挑视频、调参数后显式触发。
        // 视频 id 是 Documents 相对路径的 base64url（前端 libB64Url(uri)），需要先解码还原。

        // ① 探针：时长 / 分辨率 / 有无音轨（前端 recProbe 展示）。
        server.post["/api/record/probe"] = { req in
            guard let body = parseJSON(req) else { return apiError("invalid_json") }
            guard let rel = Self.decodeRecordId(OsrLink.asStr(body["id"], "")),
                  let url = mediaURL(rel), FileManager.default.fileExists(atPath: url.path) else {
                return json(["ok": false, "error": "找不到视频文件"])
            }
            let asset = AVAsset(url: url)
            let dur = CMTimeGetSeconds(asset.duration)
            var w = 0, h = 0
            if let vt = asset.tracks(withMediaType: .video).first {
                let sz = vt.naturalSize
                w = Int(sz.width); h = Int(sz.height)
            }
            let hasAudio = !asset.tracks(withMediaType: .audio).isEmpty
            let hasVideo = !asset.tracks(withMediaType: .video).isEmpty
            return json(["ok": true,
                         "duration": dur.isFinite ? dur : 0,
                         "width": w, "height": h,
                         "hasAudio": hasAudio, "hasVideo": hasVideo])
        }

        // ② 同目录可写自检：iOS 沙盒内视频天生可写（脚本就落同一目录），无需授权。
        server.post["/api/record/check"] = { _ in
            json(["ok": true, "writable": true, "fallback": false, "reason": ""])
        }

        // ③ 投递生成任务：id 解码成 rel，参数来自前端 recReadOptions()。
        server.post["/api/record/start"] = { req in
            guard let body = parseJSON(req) else { return apiError("invalid_json") }
            guard let rel = Self.decodeRecordId(OsrLink.asStr(body["id"], "")), !rel.isEmpty else {
                return json(["ok": false, "error": "no_id"])
            }
            guard let url = mediaURL(rel), FileManager.default.fileExists(atPath: url.path) else {
                return json(["ok": false, "error": "video_not_found"])
            }
            let opt = Self.recordOptions(from: body["options"] as? [String: Any])
            let (ok, busyId, error) = FunscriptGenerator.shared.start(videoRel: rel, options: opt)
            if ok { return json(["ok": true]) }
            if let busy = busyId {
                return json(["ok": false, "error": "already_running", "busyId": busy])
            }
            return json(["ok": false, "error": error ?? "start_failed"])
        }

        // ④ 进度轮询：与 funscript-gen/status 共用 status()（done 时回填 out/actions/axes/fallback）。
        server.post["/api/record/status"] = { _ in
            json(FunscriptGenerator.shared.status())
        }

        // ⑤ 改存到视频同目录：iOS 生成时已直接写到视频旁边，无需二次搬运，直接回成功。
        server.post["/api/record/write"] = { _ in
            json(["ok": true])
        }

        // ⑥ 取消。
        server.post["/api/record/cancel"] = { _ in
            FunscriptGenerator.shared.cancel()
            return json(["ok": true])
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
                  "note": "iOS 不支持 USB 主机（OTG）与串口，请用 WiFi 连接"])
        }
        server.post["/api/osr/usb-scan"] = { _ in
            json(["ok": true, "devices": [] as [Any],
                  "note": "iOS 不支持 USB 主机（OTG）与串口，请用 WiFi 连接"])
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

    // MARK: - 可达性探测（诊断用）

    /// 对 host:port 做一次 TCP 连接探测（2 秒超时），结果只作诊断参考：
    /// - connected：设备在线且该端口开 TCP，链路一定通
    /// - refused：主机可达但该端口没开 TCP（设备可能只监听 UDP）
    /// - timeout / failed：整机不可达 —— IP/端口错、不同网段 / 路由器 AP 隔离，
    ///   或 iOS「本地网络」权限被拒（包根本发不出网卡，UDP 也会被静默丢弃）
    private static func tcpProbe(host: String, port: Int) -> String {
        guard let p = NWEndpoint.Port(rawValue: UInt16(clamping: port)), p.rawValue != 0 else {
            return "invalid_port"
        }
        let conn = NWConnection(host: NWEndpoint.Host(host), port: p, using: .tcp)
        let sem = DispatchSemaphore(value: 0)
        var state = "timeout"
        conn.stateUpdateHandler = { s in
            switch s {
            case .ready:
                state = "connected"
                sem.signal()
            case .waiting:
                // 默认参数下连不上会停在 waiting（系统自动重试），视作不可达
                state = "timeout"
                sem.signal()
            case .failed(let err):
                if case .posix(let code) = err, code == .ECONNREFUSED {
                    state = "refused"
                } else {
                    state = "failed"
                }
                sem.signal()
            default:
                break
            }
        }
        conn.start(queue: DispatchQueue(label: "orbit.osr.tcp-probe"))
        _ = sem.wait(timeout: .now() + 2.0)
        conn.cancel()
        return state
    }

    // MARK: - 脚本文件定位（App 沙盒 Media 目录）

    /// 取浮点参数：intensity / duration 前端传 0–1 小数，整数解析会把 0.6 截成 0。
    private static func dbl(_ v: Any?, _ def: Double) -> Double {
        if let n = v as? NSNumber { return n.doubleValue }
        if let d = v as? Double { return d }
        if let s = v as? String { return Double(s) ?? def }
        return def
    }

    /// 解码 /api/record/* 的视频 id：前端对 Documents 相对路径做了 base64url（与视频库一致）。
    private static func decodeRecordId(_ s: String) -> String? {
        let t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let pad = s.count % 4
        let padded = pad > 0 ? t + String(repeating: "=", count: 4 - pad) : t
        guard let data = Data(base64Encoded: padded) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// 把前端 recReadOptions() 的字典映射成 RecordOptions（缺省用默认值）。
    private static func recordOptions(from o: [String: Any]?) -> RecordOptions {
        guard let o = o else { return RecordOptions() }
        return RecordOptions(
            fps: OsrLink.asInt(o["fps"], 10),
            maxHz: Float(dbl(o["maxHz"], 4)),
            sensitivity: Float(dbl(o["sensitivity"], 1.8)),
            smooth: Float(dbl(o["smooth"], 0.25)),
            minPos: 5, maxPos: 95,
            offsetMs: OsrLink.asInt(o["offsetMs"], 0),
            maxSeconds: OsrLink.asInt(o["maxSeconds"], 0)
        )
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
        // ① 沙盒内（本地导入的片）：视频文件确实在 Documents 下才只走本地，绝不多跑一次网络。
        //    ⚠ 判据必须是「文件存在」而不是「目录存在」——SMB 的 key 是共享内相对路径，
        //    万一与本地某个目录同名（如 Media/..），按目录判会误走本地而永远找不到脚本。
        if let url = mediaURL(key), FileManager.default.fileExists(atPath: url.path) {
            return localScripts(in: url.deletingLastPathComponent(), base: videoBase(of: key))
        }
        // ② 沙盒里没这个目录 —— 说明是 SMB 共享里的片，去共享上找同目录同名脚本。
        return smbScriptsBesideVideo(key)
    }

    private static func localScripts(in dir: URL, base: String) -> [(String, String)] {
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

    /// SMB 视频的同名脚本：进共享里视频所在目录，按同一套「同名」规则取 .funscript。
    /// 凭据取已保存的 SMB 设置；共享根目录用 "/"。读不到（没连共享 / 没权限 / 超时）
    /// 一律返回空，由前端胶囊显示「未加载脚本」，不在这里弹错。
    private static func smbScriptsBesideVideo(_ key: String) -> [(String, String)] {
        guard let creds = SmbClient.credsFromSettings(), let rel = smbRelPath(of: key) else { return [] }
        let base = videoBase(of: rel)
        guard !base.isEmpty else { return [] }
        var dir = (rel as NSString).deletingLastPathComponent
        if dir.isEmpty { dir = "/" }
        guard case .success(let entries) = SmbClient.listAll(creds, path: dir) else { return [] }
        var out: [(String, String)] = []
        for e in entries where !e.isDir && e.name.hasSuffix(".funscript") {
            let body = (e.name as NSString).deletingPathExtension
            guard body == base || body.hasPrefix(base + ".") else { continue }
            // 目录里脚本可能成百上千，只取与视频同名那一组（够用，也不拖慢列目录）
            let p = (dir == "/") ? e.name : dir + "/" + e.name
            guard case .success(let text) = SmbClient.readText(creds, path: p) else { continue }
            out.append((e.name, text))
            if out.count >= 8 { break }
        }
        return out
    }

    /// 把视频 key 归一成「共享内的相对路径」。
    /// 正常情况 key 本来就是相对路径（SMB 浏览项给的就是它）；万一前端塞了完整的
    /// smb://host/share/... 也在这里剥掉，避免拼出无效路径导致取不到脚本。
    private static func smbRelPath(of key: String) -> String? {
        var s = key
        if s.lowercased().hasPrefix("smb://") {
            let rest = String(s.dropFirst(6))
            var comps = rest.split(separator: "/").map(String.init)
            if !comps.isEmpty { comps.removeFirst() }      // host
            if !comps.isEmpty { comps.removeFirst() }      // share
            s = comps.joined(separator: "/")
        }
        s = s.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return s.isEmpty ? nil : s
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
