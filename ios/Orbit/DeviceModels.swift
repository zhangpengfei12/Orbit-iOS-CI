import Foundation

// MARK: - 设备模型与状态机（纯逻辑）
//
// 对齐安卓 BtLink.kt 的 emitBtDevice（name/address/rssi/kind/paired）与
// MainActivity 的连接/扫描生命周期。BLE 真机扫描/连接留待 M2，本文件只建模数据与状态转换。

/// 一台蓝牙设备（与安卓 emitBtDevice 的 JSON 字段一一对应）。
struct BtDevice: Equatable {
    let name: String
    let address: String
    let rssi: Int?
    let kind: String      // "ble" / "classic"
    let paired: Bool
}

/// 扫描状态机。
enum ScanState: Equatable {
    case idle
    case starting
    case scanning
    case finished
    case error(String)
}

/// 连接状态机。
enum ConnectionState: Equatable {
    case disconnected
    case connecting(address: String, kind: String, name: String)
    case connected(address: String, kind: String, name: String)
    case error(String)
}

/// 生成 window.__onBtDeviceFound 回传脚本（对象字面量，对齐安卓 emitBtDevice 的
/// `window.__onBtDeviceFound && window.__onBtDeviceFound($obj)`）。
func emitBtDeviceScript(_ d: BtDevice) -> String {
    var obj: [String: Any] = [
        "name": d.name,
        "address": d.address,
        "kind": d.kind,
        "paired": d.paired
    ]
    if let r = d.rssi { obj["rssi"] = r } else { obj["rssi"] = NSNull() }
    return buildCallback("__onBtDeviceFound", [.object(obj)])
}

/// 连接状态变化 → 回调脚本。
func btConnectingScript(_ address: String, _ kind: String, _ name: String) -> String {
    buildCallback("__onBtConnecting", [.string(address), .string(kind), .string(name)])
}
func btConnectedScript(_ address: String, _ kind: String, _ name: String) -> String {
    buildCallback("__onBtConnected", [.string(address), .string(kind), .string(name)])
}
func btDisconnectedScript() -> String {
    buildCallback("__onBtDisconnected", [])
}
func btErrorScript(_ msg: String) -> String {
    buildCallback("__onBtError", [.string(msg)])
}
