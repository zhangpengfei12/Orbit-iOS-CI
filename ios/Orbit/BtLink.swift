import Foundation
import CoreBluetooth
import UIKit

// MARK: - 原生 → JS 全局出口
//
// RootViewController 启动时把 webView 的 evaluateJavaScript 注入 sink；
// 服务器端点（Swifter 线程，无 webView 引用）回传前端也统一走这里。
// 回调形式保持与安卓 notifyJs 同构："window.__onXxx && window.__onXxx(...)"。
enum JsEmit {
    static var sink: ((String) -> Void)?
    static func js(_ js: String) {
        DispatchQueue.main.async {
            sink?(js)
        }
    }
}

// MARK: - iOS 蓝牙链路（CoreBluetooth，仅 BLE —— iOS 不支持经典蓝牙 SPP）
//
// 前端契约对齐安卓 BtLink.kt / MainActivity.kt：
//   JS→原生（BridgeProxy 分发）：startBluetoothScan / stopBluetoothScan /
//     connectBluetooth(address, kind, name) / disconnectBluetooth
//   原生→JS（JsEmit）：
//     __onBluetoothPermission(granted)   权限结论（仅状态变化时发一次，防循环）
//     __onBtScanStart / __onBtScanFinished / __onBtScanError(msg)
//     __onBtDeviceFound({name,address,rssi,kind,paired})
//     __onBtConnecting(addr,kind,name) / __onBtConnected(addr,kind,name) /
//     __onBtDisconnected / __onBtError(msg)
//
// 写特征对齐安卓 BtLink.kt：FFF1 写 / FFF2 通知（FFF0 服务），
// 找不到固定 UUID 时回退「首个可写 + 首个可通知」特征提升兼容性。
// 扫描 12 秒自动收尾；写走 writeWithoutResponse + canSendWriteWithoutResponse 流控。
final class BtLink: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    static let shared = BtLink()

    private static let UUID_WRITE = "0000fff1-0000-1000-8000-00805f9b34fb"
    private static let UUID_NOTIFY = "0000fff2-0000-1000-8000-00805f9b34fb"
    private static let SCAN_TIMEOUT_SEC: Double = 12

    private var central: CBCentralManager?
    private var scanPending = false            // 等蓝牙可用后自动开扫
    private var autoConnectPending = false     // 扫描中按名称/地址自动连（自动重连兜底）
    private var scanTimer: DispatchWorkItem?
    private var lastReportedState: CBManagerState?

    private var known: [String: CBPeripheral] = [:]   // identifier.uuidString -> peripheral

    private var target: CBPeripheral?
    private var writeChar: CBCharacteristic?
    private var notifyChar: CBCharacteristic?
    private var charsPending = 0
    private var finalizedConnection = false
    private var writeQueue: [Data] = []

    private(set) var connectedAddress: String?
    private(set) var connectedName = ""
    private(set) var connectedKind = "ble"
    private(set) var lastError: String?
    private var pendingConnect: (address: String, name: String)?

    var isConnected: Bool { connectedAddress != nil && writeChar != nil }

    // MARK: - JS 入口（BridgeProxy 分发）

    func startScan() {
        lastError = nil
        if let c = central {
            if c.state == .poweredOn { beginScan(); return }
            scanPending = true
            handleCentralState(c.state)   // 授权被拒/蓝牙关闭时给前端提示
            return
        }
        scanPending = true
        // 首次创建即触发系统蓝牙权限弹窗（Info.plist 已配 NSBluetoothAlwaysUsageDescription）
        central = CBCentralManager(delegate: self, queue: .main)
    }

    func stopScan() {
        scanPending = false
        cancelScanTimer()
        central?.stopScan()
    }

    func connect(_ address: String, _ kind: String, _ name: String) {
        lastError = nil
        let addr = address.trimmingCharacters(in: .whitespaces)
        guard !addr.isEmpty else { fail("蓝牙地址为空"); return }
        // iOS 只有 BLE（不支持经典蓝牙 SPP），kind 统一按 'ble' 回传
        let c: CBCentralManager
        if let existing = central { c = existing }
        else {
            scanPending = false
            let m = CBCentralManager(delegate: self, queue: .main)
            central = m
            c = m
        }
        pendingConnect = (addr, name)
        Diagnostics.shared.log("BT", "连接 \(name.isEmpty ? addr : name)（\(addr)）")
        emit("window.__onBtConnecting && window.__onBtConnecting(\(q(addr)),'ble',\(q(name)))")

        if let p = known[addr] {
            c.connect(p, options: nil)
            return
        }
        // 不在本次扫描结果里：按 identifier 找系统已知外设（覆盖自动重连场景）
        if let uuid = UUID(uuidString: addr),
           let p = c.retrievePeripherals(withIdentifiers: [uuid]).first {
            known[addr] = p
            c.connect(p, options: nil)
            return
        }
        // 系统还不认识它（重装 App 后 identifier 失效等）：扫描并按名称兜底自动连
        autoConnectPending = true
        if c.state == .poweredOn { beginScan() }
        // 蓝牙未就绪时由 didUpdateState 驱动 beginScan
    }

    func disconnect() {
        let had = isConnected
        if let p = target { central?.cancelPeripheralConnection(p) }
        cleanupLink()
        if had {
            emit("window.__onBtDisconnected && window.__onBtDisconnected()")
            Diagnostics.shared.log("BT", "已断开（主动）")
        }
    }

    /// 发送 TCode 文本。按 MTU 分片 + writeWithoutResponse 流控。
    @discardableResult
    func write(_ text: String) -> Bool {
        guard let p = target, let ch = writeChar, p.state == .connected else {
            lastError = "蓝牙未连接"
            return false
        }
        let mtu = max(p.maximumWriteValueLength(for: .withoutResponse), 20)
        for chunk in chunkCommandsForMtu(text, mtu) {
            writeQueue.append(Data(chunk.utf8))
        }
        drain()
        return true
    }

    func statusDict() -> [String: Any] {
        return ["ok": true,
                "connected": isConnected,
                "address": connectedAddress ?? "",
                "kind": isConnected ? connectedKind : ""]
    }

    // MARK: - CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        handleCentralState(central.state)
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let addr = peripheral.identifier.uuidString
        known[addr] = peripheral
        var name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? ""
        if name.isEmpty { name = peripheral.name ?? "" }

        // 自动重连兜底：地址或名称命中即连（BtLink.connect 里发起了扫描）
        if autoConnectPending, let pend = pendingConnect {
            let addrMatch = (addr.caseInsensitiveCompare(pend.address) == .orderedSame)
            let nameMatch = !pend.name.isEmpty && !name.isEmpty && name == pend.name
            if addrMatch || nameMatch {
                autoConnectPending = false
                cancelScanTimer()
                central.stopScan()
                Diagnostics.shared.log("BT", "扫描命中目标（\(nameMatch ? "按名称" : "按地址")），发起连接")
                central.connect(peripheral, options: nil)
                return
            }
        }

        emit("window.__onBtDeviceFound && window.__onBtDeviceFound(" +
             encodeJsArg(.object(["name": name, "address": addr,
                                  "rssi": RSSI.intValue, "kind": "ble", "paired": false])) + ")")
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        Diagnostics.shared.log("BT", "GATT 已连接，开始发现服务")
        target = peripheral
        peripheral.delegate = self
        finalizedConnection = false
        peripheral.discoverServices(nil)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        fail("连接失败：\(error?.localizedDescription ?? "未知原因")")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard peripheral.identifier.uuidString == connectedAddress else { return }
        let abnormal = error != nil
        cleanupLink()
        emit("window.__onBtDisconnected && window.__onBtDisconnected()")
        Diagnostics.shared.log("BT", abnormal ? "连接异常断开：\(error!.localizedDescription)" : "已断开")
    }

    // MARK: - CBPeripheralDelegate

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error { fail("发现服务失败：\(error.localizedDescription)"); return }
        let services = peripheral.services ?? []
        guard !services.isEmpty else { fail("设备没有可用的 BLE 服务"); return }
        charsPending = services.count
        for s in services { peripheral.discoverCharacteristics(nil, for: s) }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor characteristic: CBCharacteristic, error: Error?) {
        if let error { Diagnostics.shared.log("BT", "特征发现出错：\(error.localizedDescription)") }
        charsPending -= 1
        guard charsPending <= 0, !finalizedConnection else { return }
        finalizeConnection(peripheral)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        if let error { Diagnostics.shared.log("BT", "订阅通知失败：\(error.localizedDescription)") }
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error { Diagnostics.shared.log("BT", "写入报错：\(error.localizedDescription)") }
    }

    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        drain()
    }

    // MARK: - 内部

    private func handleCentralState(_ state: CBManagerState) {
        // 权限结论只在状态变化时发一次：否则「granted→前端重扫→native 再发 granted」死循环
        if state != lastReportedState {
            lastReportedState = state
            switch state {
            case .poweredOn:
                emit("window.__onBluetoothPermission && window.__onBluetoothPermission(true)")
            case .unauthorized, .restricted:
                emit("window.__onBluetoothPermission && window.__onBluetoothPermission(false)")
            default: break
            }
        }
        switch state {
        case .poweredOn:
            if scanPending { scanPending = false; beginScan() }
            else if autoConnectPending { autoConnectPending = false; beginScan() }
        case .poweredOff:
            scanPending = false
            emit("window.__onBtScanError && window.__onBtScanError('bluetooth_off')")
        case .unsupported:
            scanPending = false
            emit("window.__onBtScanError && window.__onBtScanError('bluetooth_off')")
        case .unauthorized:
            scanPending = false
            fail("蓝牙权限未授权：请到 系统设置 → 隐私与安全性 → 蓝牙 中允许 Orbit")
        case .unknown, .resetting: break
        @unknown default: break
        }
    }

    private func beginScan() {
        guard let central, central.state == .poweredOn else { return }
        central.scanForPeripherals(withServices: nil, options: nil)
        emit("window.__onBtScanStart && window.__onBtScanStart()")
        cancelScanTimer()
        let t = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.central?.stopScan()
            self.emit("window.__onBtScanFinished && window.__onBtScanFinished()")
        }
        scanTimer = t
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.SCAN_TIMEOUT_SEC, execute: t)
    }

    private func cancelScanTimer() {
        scanTimer?.cancel()
        scanTimer = nil
    }

    private func finalizeConnection(_ p: CBPeripheral) {
        var w: CBCharacteristic?
        var n: CBCharacteristic?
        var fallbackW: CBCharacteristic?
        var fallbackN: CBCharacteristic?
        for s in p.services ?? [] {
            for ch in s.characteristics ?? [] {
                let u = ch.uuid.uuidString.lowercased()
                if u == Self.UUID_WRITE { w = ch }
                if u == Self.UUID_NOTIFY { n = ch }
                if fallbackW == nil && ch.properties.contains(.writeWithoutResponse) { fallbackW = ch }
                if fallbackN == nil && ch.properties.contains(.notify) { fallbackN = ch }
            }
        }
        writeChar = w ?? fallbackW
        notifyChar = n ?? fallbackN
        guard let wc = writeChar else {
            fail("未找到可写特征（该设备可能不是 TCode 串口服务）")
            return
        }
        finalizedConnection = true
        connectedAddress = p.identifier.uuidString
        connectedName = pendingConnect?.name ?? (p.name ?? "")
        connectedKind = "ble"
        if let nc = notifyChar { p.setNotifyValue(true, for: nc) }
        let mtu = p.maximumWriteValueLength(for: .withoutResponse)
        Diagnostics.shared.log("BT", "已连接 \(connectedName) 写=\(wc.uuid.uuidString) 通知=\(notifyChar?.uuid.uuidString ?? "-") MTU=\(mtu)")
        emit("window.__onBtConnected && window.__onBtConnected(\(q(connectedAddress ?? "")),'ble',\(q(connectedName)))")

        // 对齐安卓：连接成功即回写设置，自动重连靠持久化的 btAddress
        var cur = OrbitConfig.shared.dictionary(forKeyPath: "settings.osr")
        cur["btAddress"] = connectedAddress
        cur["btKind"] = "ble"
        cur["btName"] = connectedName
        cur["connectionType"] = "BluetoothSerial"
        OrbitConfig.shared.set(cur, forKeyPath: "settings.osr")
        OrbitConfig.shared.save()
    }

    private func drain() {
        guard let p = target, let ch = writeChar else { return }
        while !writeQueue.isEmpty && p.canSendWriteWithoutResponse {
            let d = writeQueue.removeFirst()
            p.write(d, for: ch, type: .withoutResponse)
        }
    }

    private func cleanupLink() {
        target = nil
        writeChar = nil
        notifyChar = nil
        finalizedConnection = false
        writeQueue.removeAll()
        connectedAddress = nil
        connectedName = ""
    }

    private func fail(_ msg: String) {
        lastError = msg
        Diagnostics.shared.log("BT", "失败：\(msg)")
        emit("window.__onBtError && window.__onBtError(\(q(msg)))")
    }

    private func emit(_ js: String) {
        JsEmit.js(js)
    }

    private func q(_ s: String) -> String {
        encodeJsArg(.string(s))
    }
}
