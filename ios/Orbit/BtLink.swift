import Foundation
import CoreBluetooth
import UIKit

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
// 写特征优先匹配 TCodeESP32 官方固件（jcfain/TCodeESP32，BLE_TCODE=1）：
//   服务 ff1b451d-3070-4276-9c81-5dc5ea1043bc
//   写特征 c5f1543e-338d-47a0-8525-01e3c621359d（READ + WRITE_NR，无 NOTIFY）
// 同时保留安卓侧 FFF1 写 / FFF2 通知（FFF0 服务）作为常见 BLE 串口模块候选。
// 找不到固定 UUID 时回退「首个 writeWithoutResponse + 首个 notify」特征，
// 固件未声明 NOTIFY 也能连接（notifyChar 为 nil 是允许的）。扫描保持全设备以兼容
// 不同 BLE 透传模块，并按广播里的 service UUID 标记 Orbit 设备（详见 didDiscover）。
// 扫描 12 秒自动收尾；写走 writeWithoutResponse + canSendWriteWithoutResponse 流控。
// ⚠ 每个写包必须带 '\n'：固件 TCode v0.4 只在换行时 executeAll() 真正驱动电机。
// ⚠ CoreBluetooth 写入全部收敛主线程：本地 HTTP 服务的请求线程不能直接调 writeValue。
final class BtLink: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    static let shared = BtLink()

    private static let UUID_WRITE = "c5f1543e-338d-47a0-8525-01e3c621359d"
    private static let UUID_WRITE_ALT = "0000fff1-0000-1000-8000-00805f9b34fb"
    private static let UUID_NOTIFY = "0000fff2-0000-1000-8000-00805f9b34fb"
    private static let SCAN_TIMEOUT_SEC: Double = 12

    // 固件广播包只有 31 字节：128 位 service UUID 占掉大半后，设备名常被挤掉，
    // iOS 拿到的 LocalName 为空，列表就显示成 Unknown。按服务 UUID 识别才可靠。
    private static let UUID_SERVICE_TCODE = "ff1b451d-3070-4276-9c81-5dc5ea1043bc"
    private static let UUID_SERVICE_FFF0  = "0000fff0-0000-1000-8000-00805f9b34fb"
    private static let UUID_SERVICE_FFE0  = "0000ffe0-0000-1000-8000-00805f9b34fb"
    private static let ORBIT_NAME_KEYS = ["tcode", "orbit", "sr6"]

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
    private var writeMtu = 20                  // 连接时缓存，避免跨线程读 CoreBluetooth
    private var flushWork: DispatchWorkItem?
    private var writeCount: Int64 = 0          // 累计投递的写包
    private var dropCount: Int64 = 0           // 因积压丢弃的旧包
    private var firstWriteLogged = false       // 每次连接只记一次首包内容
    private static let MAX_PENDING = 32        // 待发包上限，超出整批丢弃旧指令
    private static let MAX_PER_DRAIN = 8       // 单次 drain 最多写几包，防一次倾泻
    private static let FLUSH_INTERVAL: Double = 0.10

    private(set) var connectedAddress: String?
    private(set) var connectedName = ""
    private(set) var connectedKind = "ble"
    private(set) var lastError: String?
    private var pendingConnect: (address: String, name: String)?

    // Swifter 的 HTTP 请求在后台线程：用锁保护连接标志，不跨线程读引用属性。
    private let stateLock = NSLock()
    private var _linkReady = false
    private var linkReady: Bool {
        stateLock.lock(); defer { stateLock.unlock() }
        return _linkReady
    }
    private func setLinkReady(_ v: Bool) {
        stateLock.lock(); _linkReady = v; stateLock.unlock()
    }
    var isConnected: Bool { linkReady }

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
        // /api/osr/bt-disconnect 由 Swifter 后台线程进来，收敛主线程再碰 CoreBluetooth
        if Thread.isMainThread { disconnectOnMain() }
        else { DispatchQueue.main.async { [weak self] in self?.disconnectOnMain() } }
    }

    private func disconnectOnMain() {
        let had = isConnected
        if let p = target { central?.cancelPeripheralConnection(p) }
        cleanupLink()
        if had {
            emit("window.__onBtDisconnected && window.__onBtDisconnected()")
            Diagnostics.shared.log("BT", "已断开（主动）")
        }
    }

    /// 发送 TCode 文本（可由 HTTP 后台线程调用）。
    /// 分片是纯函数可后台算；入队与 CoreBluetooth 写入一律投递主线程，
    /// 否则 CBCentralManager 的 delegate queue(.main) 与写入线程不一致，
    /// canSendWriteWithoutResponse / peripheralIsReady 状态会错乱，
    /// 表现为指令丢失或队列卡死后一次性倾泻。
    @discardableResult
    func write(_ text: String) -> Bool {
        guard linkReady else {
            lastError = "蓝牙未连接"
            return false
        }
        let chunks = chunkCommandsForMtu(text, writeMtu).map { Data($0.utf8) }
        guard !chunks.isEmpty else { return true }
        DispatchQueue.main.async { [weak self] in
            self?.enqueueOnMain(chunks)
        }
        return true
    }

    func statusDict() -> [String: Any] {
        return ["ok": true,
                "connected": isConnected,
                "address": connectedAddress ?? "",
                "kind": isConnected ? connectedKind : "",
                "mtu": writeMtu,
                "writes": writeCount,
                "dropped": dropCount]
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

        // 主广播区与 overflow 区都可能带 service UUID；命中即认为是 Orbit 设备，
        // 不依赖设备名（固件把名字放在 GAP device name，连接前常常读不到）。
        var services: [String] = []
        for key in [CBAdvertisementDataServiceUUIDsKey, CBAdvertisementDataOverflowServiceUUIDsKey] {
            if let list = advertisementData[key] as? [CBUUID] {
                for u in list { services.append(u.uuidString.lowercased()) }
            }
        }
        let serviceHit = services.contains(Self.UUID_SERVICE_TCODE)
                      || services.contains(Self.UUID_SERVICE_FFF0)
                      || services.contains(Self.UUID_SERVICE_FFE0)
        let lowerName = name.lowercased()
        let nameHit = Self.ORBIT_NAME_KEYS.contains(where: { lowerName.contains($0) })
        let isOrbit = serviceHit || nameHit
        // 名字为空时补一个可识别的显示名，前端默认搜索「TCODE」才能命中、才会置顶。
        if isOrbit && name.isEmpty { name = "TCODE-ESP32" }
        if isOrbit {
            Diagnostics.shared.log("BT", "命中 Orbit 设备 \(name) 服务=\(services.joined(separator: ","))")
        }

        // 自动重连兜底：地址或名称命中即连（BtLink.connect 里发起了扫描）
        if autoConnectPending, let pend = pendingConnect {
            let addrMatch = (addr.caseInsensitiveCompare(pend.address) == .orderedSame)
            let nameMatch = !pend.name.isEmpty && !name.isEmpty && name == pend.name
            let orbitMatch = isOrbit && pend.name.lowercased().contains("tcode")
            if addrMatch || nameMatch || orbitMatch {
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
                                  "rssi": RSSI.intValue, "kind": "ble", "paired": false,
                                  "orbit": isOrbit, "services": services])) + ")")
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

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
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
            case .unauthorized:
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
                if u == Self.UUID_WRITE || u == Self.UUID_WRITE_ALT { w = ch }
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
        setLinkReady(true)
        connectedAddress = p.identifier.uuidString
        connectedName = pendingConnect?.name ?? (p.name ?? "")
        connectedKind = "ble"
        if let nc = notifyChar { p.setNotifyValue(true, for: nc) }
        writeMtu = max(p.maximumWriteValueLength(for: .withoutResponse), 20)
        Diagnostics.shared.log("BT", "已连接 \(connectedName) 写=\(wc.uuid.uuidString) 通知=\(notifyChar?.uuid.uuidString ?? "-") MTU=\(writeMtu)")
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

    /// 入队（仅主线程）：实时位置指令只需最新值，积压时整批丢掉过期的，
    /// 否则 BLE 吞吐跟不上会把几秒前的位置排队重放，表现「很久才动一下」。
    private func enqueueOnMain(_ chunks: [Data]) {
        guard let p = target, writeChar != nil, p.state == .connected else { return }
        if !firstWriteLogged, let first = chunks.first {
            firstWriteLogged = true
            let sample = (String(data: first, encoding: .utf8) ?? "")
                .replacingOccurrences(of: "\n", with: "\\n")
            Diagnostics.shared.log("BT", "BLE 首包=[\(sample)] 字节=\(first.count) MTU=\(writeMtu)")
        }
        if writeQueue.count > Self.MAX_PENDING {
            let dropped = writeQueue.count
            dropCount += Int64(dropped)
            writeQueue.removeAll(keepingCapacity: true)
            Diagnostics.shared.log("BT", "BLE 积压：丢弃 \(dropped) 个旧包")
        }
        writeQueue.append(contentsOf: chunks)
        drain()
    }

    /// 写包（仅主线程）。限制单次数量，靠 peripheralIsReady + 定时兜底继续推进，
    /// 避免一次倾泻把底层 ATT 缓冲塞满导致静默丢包。
    private func drain() {
        guard let p = target, let ch = writeChar, p.state == .connected else { return }
        var sent = 0
        while sent < Self.MAX_PER_DRAIN && !writeQueue.isEmpty && p.canSendWriteWithoutResponse {
            let d = writeQueue.removeFirst()
            p.writeValue(d, for: ch, type: .withoutResponse)
            sent += 1
            writeCount += 1
        }
        if sent > 0 && writeCount % 200 == 0 {
            Diagnostics.shared.log("BT", "BLE 累计写入 \(writeCount) 包，丢弃 \(dropCount)，待发 \(writeQueue.count)")
        }
        if !writeQueue.isEmpty { scheduleFlush() }
    }

    /// 流控兜底：个别机型/系统版本不回调 peripheralIsReady，队列会永久卡住。
    /// 每 100ms 在主线程复查一次，canSend 恢复即继续写。
    private func scheduleFlush() {
        flushWork?.cancel()
        let w = DispatchWorkItem { [weak self] in
            self?.drain()
        }
        flushWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.FLUSH_INTERVAL, execute: w)
    }

    private func cleanupLink() {
        target = nil
        writeChar = nil
        notifyChar = nil
        finalizedConnection = false
        writeQueue.removeAll()
        flushWork?.cancel()
        flushWork = nil
        firstWriteLogged = false
        setLinkReady(false)
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
