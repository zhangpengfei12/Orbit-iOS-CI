import Foundation

// MARK: - T-Code 下行队列与 MTU 分片（纯逻辑）
//
// 对齐安卓 OsrCore 的指令下发：指令以「\n」分隔的多行 T-Code 文本下发。
// BLE 写有 MTU 上限（通常 20/23 字节），需要按行拼装、必要时切分。
// 本文件只做队列与分片的纯算法，真机发送（CoreBluetooth writeValue）留待 M2。

/// 一包待下发的指令（已切到 MTU 内）。
struct OutgoingChunk {
    let text: String
    let seq: Int64
}

/// T-Code 下行队列：入队多行指令，按 MTU 逐包取出。
class CommandQueue {
    private var pending: [String] = []   // 待下发指令行（不含换行）
    private let mtu: Int
    private var seq: Int64 = 0

    init(mtu: Int = 20) { self.mtu = max(mtu, 1) }

    /// 入队一条完整指令（可能含多行）。
    func enqueue(_ cmd: String) {
        for line in cmd.components(separatedBy: "\n") {
            let t = line.trimmingCharacters(in: .whitespaces)
            if !t.isEmpty { pending.append(t) }
        }
    }

    /// 取出下一包（不超过 MTU 的多行拼接）。返回 nil 表示空。
    func takeNextChunk() -> OutgoingChunk? {
        guard !pending.isEmpty else { return nil }
        var built = ""
        while !pending.isEmpty {
            let line = pending[0]
            let candidate = built.isEmpty ? line : built + "\n" + line
            if candidate.utf8.count > mtu {
                if built.isEmpty {
                    // 单行都超过 MTU：按字符硬切（罕见，固件一般不支持，但保持不丢数据）
                    let prefix = String(line.prefix(mtu))
                    let rest = String(line.dropFirst(mtu))
                    pending[0] = rest
                    built = prefix
                }
                break
            }
            built = candidate
            pending.removeFirst()
        }
        seq += 1
        return OutgoingChunk(text: built, seq: seq)
    }

    var isEmpty: Bool { pending.isEmpty }
    var count: Int { pending.count }
}

/// 把一段多行 T-Code 文本按 MTU 切成若干包（纯函数，供测试/真机复用）。
func chunkCommandsForMtu(_ cmd: String, _ mtu: Int) -> [String] {
    let m = max(mtu, 1)
    var lines: [String] = []
    for line in cmd.components(separatedBy: "\n") {
        let t = line.trimmingCharacters(in: .whitespaces)
        if !t.isEmpty { lines.append(t) }
    }
    var result: [String] = []
    var cur = ""
    for line in lines {
        let candidate = cur.isEmpty ? line : cur + "\n" + line
        if candidate.utf8.count > m {
            if !cur.isEmpty { result.append(cur); cur = "" }
            if line.utf8.count > m {
                var rest = line
                while !rest.isEmpty {
                    let take = String(rest.prefix(m))
                    result.append(take)
                    rest = String(rest.dropFirst(m))
                }
            } else {
                cur = line
            }
        } else {
            cur = candidate
        }
    }
    if !cur.isEmpty { result.append(cur) }
    return result
}
