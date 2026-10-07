import Foundation

/// 真机诊断日志缓冲。
///
/// 存在意义：iOS 开发在本机（Windows）无法联调，每轮反馈要等 CI + TestFlight 20~40 分钟，
/// 所以必须能在真机上直接看到运行状态、并把文本分享出来。
///
/// 只写 Swift，不碰共享的 web/ —— iOS 专有能力一律不放进前端。
final class Diagnostics {

    static let shared = Diagnostics()

    private let lock = NSLock()
    private var lines: [String] = []
    private let maxLines = 800

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        f.locale = Locale(identifier: "zh_CN")
        return f
    }()

    private init() {}

    func log(_ tag: String, _ message: String) {
        let line = "[\(Self.timeFormatter.string(from: Date()))] \(tag): \(message)"
        lock.lock()
        lines.append(line)
        if lines.count > maxLines { lines.removeFirst(lines.count - maxLines) }
        lock.unlock()
        #if DEBUG
        print(line)
        #endif
    }

    /// M1 起在有真实端点后接入：记录每个请求的 method / path / 状态码
    func logRequest(method: String, path: String, status: Int) {
        log("HTTP", "\(method) \(path) -> \(status)")
    }

    func snapshot() -> String {
        lock.lock()
        let copy = lines
        lock.unlock()
        return copy.joined(separator: "\n")
    }

    func clear() {
        lock.lock()
        lines.removeAll()
        lock.unlock()
    }
}
