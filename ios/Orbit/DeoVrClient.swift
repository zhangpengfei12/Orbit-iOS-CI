import Foundation
import Network

// MARK: - DeoVR / HereSphere 远程控制客户端（TCP 23554）
//
// 从安卓 DeoVrClient.kt（175 行）移植，协议完全一致：
//   - 头显侧要先在 DeoVR 设置里打开 Remote control，且**必须已打开某个视频**（在播放器内）
//     才接受连接——这是最常见的「连不上」原因，不是代码问题。
//   - 每个包 = 4 字节长度（JSON 的 UTF-8 字节数）+ JSON 正文。
//   - 头显每秒推一个包：{"path":...,"duration":...,"currentTime":...,
//     "playbackSpeed":1.0,"playerState":0}，playerState 0 = 播放、1 = 暂停。
//   - 客户端必须每秒回发一个包做 ping（发长度 0 的空包即可），
//     **超过 3 秒没有包，DeoVR 会主动断开**——所以保活是硬性要求。
//
// 行业分工（ScriptPlayer / MultiFunPlayer 都走这套）：**头显自己播画面，
// 本机只做「脚本桥」**——拿头显的时间轴当统一时钟，按同名 funscript 驱动设备。
//
// ⚠ iOS 与安卓的差异：安卓有前台服务可以把这根 TCP 连到息屏后还保持；
//   iOS 进后台后连接会被系统挂起，这里不做后台保活（需 Background Modes 且
//   实际效果受限），断线后前端会看到 status 回到 STOPPED。

final class DeoVrClient {

    static let defaultPort: UInt16 = 23554

    private static let maxJsonLen = 1_000_000
    private static let pingIntervalMs = 900
    private static let connectTimeoutSec: TimeInterval = 3.0

    /// 头显推来的一次播放状态快照。
    struct State {
        var connected: Bool
        var path: String = ""
        var durationSec: Double = 0
        var currentTimeSec: Double = 0
        var playbackSpeed: Float = 1
        var playing: Bool = false
        var error: String? = nil
    }

    private let host: String
    private let port: UInt16
    private let onState: ((State) -> Void)?

    private var conn: NWConnection?
    private var pingTimer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "orbit.deovr.client")
    private let lock = NSLock()
    private var running = false
    private var lastState = State(connected: false)

    init(host: String, port: UInt16 = DeoVrClient.defaultPort, onState: ((State) -> Void)? = nil) {
        self.host = host
        self.port = port
        self.onState = onState
    }

    // MARK: - 生命周期

    func start() {
        lock.lock()
        if running { lock.unlock(); return }
        running = true
        lock.unlock()

        guard let p = NWEndpoint.Port(rawValue: port) else {
            publish(State(connected: false, error: "端口无效"))
            return
        }
        let c = NWConnection(host: NWEndpoint.Host(host), port: p, using: .tcp)
        conn = c

        c.stateUpdateHandler = { [weak self] state in
            guard let self = self else { return }
            switch state {
            case .ready:
                Diagnostics.shared.log("DEOVR", "已连接 \(self.host):\(self.port)")
                self.publish(State(connected: true))
                self.startPing()
                self.readHeader()
            case .failed(let err):
                Diagnostics.shared.log("DEOVR", "连接失败：\(err)")
                self.publish(State(connected: false, error: "连接失败：\(err.localizedDescription)"))
                self.stop()
            case .cancelled:
                break
            default:
                break
            }
        }
        c.start(queue: queue)

        // NWConnection 不会自己报「连接超时」——对不可达主机可能长时间停在 .preparing，
        // 所以额外挂一个超时：到点还没 ready 就判失败，否则前端会永远停在「连接中」。
        queue.asyncAfter(deadline: .now() + Self.connectTimeoutSec) { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            let connected = self.lastState.connected
            self.lock.unlock()
            if !connected {
                self.publish(State(connected: false, error: "连接超时（\(Self.connectTimeoutSec) 秒）。请确认头显与 iPhone 在同一 Wi-Fi，且 DeoVR 已打开 Remote control 并正处在播放器内。"))
                self.stop()
            }
        }
    }

    func stop() {
        lock.lock()
        running = false
        lock.unlock()
        pingTimer?.cancel()
        pingTimer = nil
        conn?.cancel()
        conn = nil
    }

    /// 最近一次状态；未连接时 connected=false。
    func state() -> State {
        lock.lock()
        defer { lock.unlock() }
        return lastState
    }

    // MARK: - 保活

    /// 每秒回发一个空包（长度 0）。DeoVR 3 秒收不到包就踢人。
    private func startPing() {
        pingTimer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: .milliseconds(Self.pingIntervalMs))
        t.setEventHandler { [weak self] in
            // 长度前缀写 0 即空包
            self?.conn?.send(content: Data([0, 0, 0, 0]), completion: .idempotent)
        }
        t.resume()
        pingTimer = t
    }

    // MARK: - 收包

    private func readHeader() {
        lock.lock()
        let alive = running
        lock.unlock()
        guard alive, let c = conn else { return }

        c.receive(minimumIncompleteLength: 4, maximumLength: 4) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            if let error = error {
                Diagnostics.shared.log("DEOVR", "读长度失败：\(error)")
                self.publish(State(connected: false, error: "连接已断开"))
                self.stop()
                return
            }
            guard let d = data, d.count == 4 else {
                if isComplete { self.stop() }
                return
            }
            let len = Self.parseLength([UInt8](d))
            // len==0 是对方回的 ping，或长度不合理（字节序都不匹配）→ 跳过继续读
            if len <= 0 || len > Self.maxJsonLen {
                self.readHeader()
                return
            }
            self.readBody(len)
        }
    }

    private func readBody(_ len: Int) {
        lock.lock()
        let alive = running
        lock.unlock()
        guard alive, let c = conn else { return }

        c.receive(minimumIncompleteLength: len, maximumLength: len) { [weak self] data, _, _, error in
            guard let self = self else { return }
            if let error = error {
                Diagnostics.shared.log("DEOVR", "读正文失败：\(error)")
                return
            }
            guard let d = data, d.count == len else { return }
            self.publish(Self.parse(String(data: d, encoding: .utf8) ?? ""))
            self.readHeader()
        }
    }

    /// 解析 4 字节长度前缀。
    /// ⚠ 文档没写字节序，参考实现是 C#（BitConverter 走小端）。这里先按小端解析，
    ///   得到不合理值（<=0 或 >1MB）再按大端重试——两种都覆盖，避免因为字节序接不上。
    private static func parseLength(_ b: [UInt8]) -> Int {
        let le = Int(b[0]) | (Int(b[1]) << 8) | (Int(b[2]) << 16) | (Int(b[3]) << 24)
        if le >= 1 && le <= maxJsonLen { return le }
        let be = Int(b[3]) | (Int(b[2]) << 8) | (Int(b[1]) << 16) | (Int(b[0]) << 24)
        if be >= 1 && be <= maxJsonLen { return be }
        return 0
    }

    private static func parse(_ json: String) -> State {
        guard let data = json.data(using: .utf8),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return State(connected: true, error: "数据包解析失败")
        }
        return State(
            connected: true,
            path: (o["path"] as? String) ?? "",
            durationSec: (o["duration"] as? NSNumber)?.doubleValue ?? 0,
            currentTimeSec: (o["currentTime"] as? NSNumber)?.doubleValue ?? 0,
            playbackSpeed: (o["playbackSpeed"] as? NSNumber)?.floatValue ?? 1,
            playing: parsePlaying(o["playerState"])
        )
    }

    /// playerState 官方是 0/1，个别实现可能给字符串，两种都认。
    private static func parsePlaying(_ raw: Any?) -> Bool {
        if let n = raw as? NSNumber { return n.intValue == 0 }
        if let s = raw as? String {
            let low = s.lowercased()
            return low == "play" || low == "playing"
        }
        return true
    }

    private func publish(_ s: State) {
        lock.lock()
        lastState = s
        lock.unlock()
        onState?(s)
    }

    // MARK: - 局域网发现

    /// 扫描本机 /24 网段的 23554 端口，找出开了 Remote control 的头显。
    /// 对齐安卓 scanLanForDeovr()：并发探测 1..254，整体 3 秒上限，找到第一个即返回。
    static func discoverLocal() -> String? {
        guard let prefix = localSubnetPrefix() else { return nil }
        let queue = DispatchQueue(label: "orbit.deovr.discover", attributes: .concurrent)
        let lock = NSLock()
        var found: String?
        var conns: [NWConnection] = []

        for i in 1...254 {
            let ip = "\(prefix).\(i)"
            guard let p = NWEndpoint.Port(rawValue: defaultPort) else { continue }
            let c = NWConnection(host: NWEndpoint.Host(ip), port: p, using: .tcp)
            c.stateUpdateHandler = { state in
                if case .ready = state {
                    lock.lock()
                    if found == nil { found = ip }
                    lock.unlock()
                    c.cancel()
                }
            }
            c.start(queue: queue)
            conns.append(c)
        }

        // 轮询等待（不能用 sleep 阻塞到底：找到就该立刻返回）
        let sem = DispatchSemaphore(value: 0)
        let deadline = Date().addingTimeInterval(3.0)
        while Date() < deadline {
            lock.lock()
            let f = found
            lock.unlock()
            if f != nil { break }
            _ = sem.wait(timeout: .now() + 0.1)
        }
        for c in conns { c.cancel() }

        lock.lock()
        let result = found
        lock.unlock()
        if let r = result {
            Diagnostics.shared.log("DEOVR", "发现头显 \(r)")
        }
        return result
    }

    /// 取本机 IPv4 的网段前缀（a.b.c），取不到返回 nil。
    /// 只认 Wi-Fi / 蜂窝常见的 en0/en1/pdp_ip0，跳过回环。
    private static func localSubnetPrefix() -> String? {
        var addrList: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&addrList) == 0, let first = addrList else { return nil }
        defer { freeifaddrs(addrList) }
        var result: String?
        var ptr: UnsafeMutablePointer<ifaddrs>? = first
        while let p = ptr {
            defer { ptr = p.pointee.ifa_next }
            let sa = p.pointee.ifa_addr
            guard sa != nil, sa!.pointee.sa_family == UInt8(AF_INET) else { continue }
            let name = String(cString: p.pointee.ifa_name)
            if name != "en0" && name != "en1" && !name.hasPrefix("pdp_ip") { continue }
            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(sa, socklen_t(sa!.pointee.sa_len), &hostname,
                           socklen_t(hostname.count), nil, 0, NI_NUMERICHOST) == 0 {
                let ip = String(cString: hostname)
                if let lastDot = ip.lastIndex(of: "."), ip != "127.0.0.1" {
                    result = String(ip[..<lastDot])
                    break
                }
            }
        }
        return result
    }
}
