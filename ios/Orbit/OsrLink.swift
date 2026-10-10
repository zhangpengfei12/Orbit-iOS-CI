import Foundation
import Network
import UIKit

// MARK: - OSR 指令下发链路（对齐安卓 OsrConnections.dispatch）
//
// 连接方式二选一（iOS 版已移除 USB 数据线）：
//   UDP（WiFi）  —— NWConnection，地址/端口来自 settings.osr 的 ip/port
//   蓝牙（BLE） —— BtLink.write，地址来自 settings.osr 的 btAddress
// TCode 指令组装复用 TCode.swift 纯函数（对齐安卓 OsrManager.sendManual）。
enum OsrLink {

    private static var udpConn: NWConnection?
    private static var udpKey = ""
    private static let udpQueue = DispatchQueue(label: "orbit.osr.udp")

    static func osrSettings() -> [String: Any] {
        OrbitConfig.shared.dictionary(forKeyPath: "settings.osr")
    }

    /// 从 settings.osr 组装 CmdContext（对齐安卓 OsrSettings.toCmdContext）。
    static func cmdContext() -> CmdContext {
        let d = osrSettings()
        var ctx = CmdContext()
        let proto = (asStr(d["protocol"], "AUTO")).uppercased()
        ctx.sendProtocol = (proto == "CUSTOM") ? .custom : .tcode
        ctx.newline = asBool(d["tcodeNewline"], true)
        ctx.prefix = asStr(d["prefix"], "")
        ctx.suffix = asStr(d["suffix"], "")
        ctx.tcodeVersion = asStr(d["tcodeVersion"], "V3")
        if let ap = d["axisParams"] as? [String: Any] {
            for (k, v) in ap {
                guard let o = v as? [String: Any] else { continue }
                var c = AxisParamConfig()
                c.reversed = asBool(o["reversed"], false)
                c.min = asInt(o["min"], 0)
                c.max = asInt(o["max"], AXIS_VALUE_MAX)
                c.amplitude = asInt(o["amplitude"], 100)
                ctx.axisParams[k] = c
            }
        }
        if let ar = d["axisRoutes"] as? [String: Any] {
            for (k, v) in ar {
                guard let o = v as? [String: Any] else { continue }
                var r = AxisRoute()
                r.enabled = asBool(o["enabled"], false)
                r.source = asStr(o["source"], "L0")
                switch asStr(o["mode"], "follow") {
                case "reverse": r.mode = .reverse
                case "sweep": r.mode = .sweep
                case "spin": r.mode = .spin
                default: r.mode = .follow
                }
                r.amplitude = asInt(o["amplitude"], 100)
                r.speed = asInt(o["speed"], 60)
                r.sweepRange = asInt(o["sweepRange"], 180)
                r.reversed = asBool(o["reversed"], false)
                ctx.routes[k] = r
            }
        }
        return ctx
    }

    /// 按当前设置把 payload 送达设备。返回 (ok, detail)。
    @discardableResult
    static func dispatch(_ payload: String) -> (ok: Bool, detail: String) {
        let d = osrSettings()
        let type = asStr(d["connectionType"], "UDP")
        if type == "BluetoothSerial" {
            let addr = asStr(d["btAddress"], "")
            guard !addr.isEmpty else { return (false, "未选择蓝牙设备") }
            guard BtLink.shared.isConnected else { return (false, "蓝牙未连接，请先在设置 → 设备里连接") }
            return BtLink.shared.write(payload)
                ? (true, "蓝牙已发送")
                : (false, "蓝牙发送失败：\(BtLink.shared.lastError ?? "未知原因")")
        }
        // 其余（UDP / 遗留 TCP 字段）一律按 UDP 处理 —— 前端已固定 UDP
        let host = asStr(d["ip"], "192.168.1.88")
        let port = asInt(d["port"], 8000)
        return sendUdp(host: host, port: port, payload: payload)
    }

    // MARK: - UDP（WiFi）

    /// UDP 发送（NWConnection，连接按 host:port 缓存复用，避免手动滑块高频发攛建连）。
    /// UDP 无回执，发出即视为成功（对齐安卓 DatagramSocket 行为）。
    static func sendUdp(host: String, port: Int, payload: String) -> (ok: Bool, detail: String) {
        let key = "\(host):\(port)"
        if udpKey != key {
            udpConn?.cancel()
            udpConn = nil
            udpKey = key
        }
        if udpConn == nil {
            guard let p = NWEndpoint.Port(rawValue: UInt16(clamping: port)), p.rawValue != 0 else {
                return (false, "端口无效：\(port)")
            }
            let conn = NWConnection(host: NWEndpoint.Host(host), port: p, using: .udp)
            conn.stateUpdateHandler = { state in
                if case .failed(let err) = state {
                    Diagnostics.shared.log("OSR", "UDP 连接失败：\(err)")
                }
            }
            conn.start(queue: udpQueue)
            udpConn = conn
        }
        guard let conn = udpConn else { return (false, "UDP 连接创建失败") }
        let data = Data(payload.utf8)
        let sem = DispatchSemaphore(value: 0)
        var result = (false, "UDP 发送超时")
        conn.send(content: data, completion: .contentProcessed { error in
            if let error {
                result = (false, "UDP 发送失败：\(error)")
            } else {
                result = (true, "UDP 已发送")
            }
            sem.signal()
        })
        _ = sem.wait(timeout: .now() + 2.0)
        return result
    }

    // MARK: - JSON 取值辅助（JSONSerialization 出来的 NSNumber 兼容处理）

    static func asInt(_ v: Any?, _ def: Int) -> Int {
        if let n = v as? NSNumber { return n.intValue }
        if let i = v as? Int { return i }
        if let s = v as? String { return Int(s) ?? def }
        return def
    }
    static func asBool(_ v: Any?, _ def: Bool) -> Bool {
        if let b = v as? Bool { return b }
        if let n = v as? NSNumber { return n.boolValue }
        return def
    }
    static func asStr(_ v: Any?, _ def: String) -> String {
        (v as? String) ?? def
    }
}

// MARK: - JS 桥分发（Orbit 命名空间）
//
// M1 只挂设备连接相关方法；媒体/更新等其余方法未知时记诊断日志，前端自行降级。
enum NativeBridge {
    static func handle(_ call: JsCall) {
        guard call.namespace == .orbit else {
            Diagnostics.shared.log("JS", "桥命名空间未处理: \(call.namespace.rawValue).\(call.method)")
            return
        }
        let a = call.args
        switch call.method {
        case "startBluetoothScan":
            BtLink.shared.startScan()
        case "stopBluetoothScan":
            BtLink.shared.stopScan()
        case "connectBluetooth":
            BtLink.shared.connect(a.count > 0 ? (a[0].asString ?? "") : "",
                                  a.count > 1 ? (a[1].asString ?? "ble") : "ble",
                                  a.count > 2 ? (a[2].asString ?? "") : "")
        case "disconnectBluetooth":
            BtLink.shared.disconnect()
        case "requestBluetoothPermission":
            // iOS 无法编程再次弹授权框：跳到本 App 的系统设置页手动开
            openAppSettings()
        case "openBluetoothSettings":
            // iOS 没有「蓝牙设置」直达入口，同样跳 App 设置
            openAppSettings()
        case "openAppSettings":
            openAppSettings()

        // MARK: 视频选择 —— iOS 没有安卓那套 SAF 文件夹授权，
        //   系统不允许 App 遍历外部存储，只能把选来的视频拷进沙盒再播。
        //   入口统一走 MediaPicker（相册 / 文件双通道），导入结果由 MediaStore 落地。
        case "pickFolder":
            // 「添加视频到媒体库」：可多选，视频与 .funscript 一起导入
            MediaPicker.shared.presentFromTop(multiple: true) { urls in
                guard !urls.isEmpty else { return }     // 用户取消：不回抛，前端右侧提示保持原样
                let imported = MediaStore.shared.importFiles(urls)
                // 回给前端的是「媒体根目录」——后续 __onFolderPicked 会 saveLocalRoot →
                // browsePath → /api/refresh，整条选片后自动加载的流程原样复用。
                JsEmit.js(buildCallback("__onFolderPicked", [.string(MediaStore.rootRel)]))
                Diagnostics.shared.log("PICK", "添加视频：选中 \(urls.count) 个，导入 \(imported.count) 个")
            }
        case "pickVideo", "pickVideoManualRec":
            MediaPicker.shared.presentFromTop(multiple: false) { urls in
                guard !urls.isEmpty else { return }
                let imported = MediaStore.shared.importFiles(urls)
                guard let first = imported.first else { return }
                JsEmit.js(buildCallback("__onPickVideo", [
                    .string(first.rel), .string(first.name), .int(Int(first.size)), .bool(false)
                ]))
                JsEmit.js(buildCallback("__onFolderPicked", [.string(MediaStore.rootRel)]))
            }
        case "grantRecordFolder":
            // iOS 没有「给某个目录写权限」这一步：App 沙盒本来就可写。
            // 直接回授脚本输出目录（= 媒体根），contains=true 表示能承接所选视频。
            MediaStore.shared.ensureRoot()
            JsEmit.js(buildCallback("__onGrantFolder", [.string(MediaStore.rootRel), .bool(true), .bool(true)]))

        default:
            Diagnostics.shared.log("JS", "桥方法未实现: orbit.\(call.method)（\(a.count) 参）")
        }
    }

    private static func openAppSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        DispatchQueue.main.async {
            UIApplication.shared.open(url)
        }
    }
}
