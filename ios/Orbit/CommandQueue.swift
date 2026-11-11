import Foundation

// MARK: - T-Code 下行队列与 MTU 分片（纯逻辑）
//
// ⚠⚠ 固件 TCodeESP32（TCode v0.4 / lib/TCode/TCode.cpp）的 byteInput() 语义：
//   遇到空格 / '\n' / '\r' 才把 _cmdBuffer 提交 processCommand()；
//   **只有 '\n' / '\r' 才调用 executeAll()**，把目标位置真正应用到电机。
//   也就是说每个 BLE 写包都必须以换行结束，否则固件会一直把字符堆在解析
//   缓冲里（最多 47 字节），既不执行当前指令，又会把后续包粘连成畸形串丢弃
//   —— 现场表现就是「蓝牙连上了但设备不动，偶尔才跳一下」。
//   早期实现按行拼接时把行尾换行剥掉了，正是这个故障的根因。
// UDP 通道不受影响（整段文本原样带 \n 发出），所以只有 BLE 暴露该问题。
//
// 分片策略改为「一行一包 + 行尾换行」：TCode 单行一般 10~20 字节，
// 不超过 BLE 默认 20 字节 ATT 载荷，简单且不会把指令从中间切开。

/// 一包待下发的指令（已切到 MTU 内，且一定带行结束符）。
struct OutgoingChunk {
    let text: String
    let seq: Int64
}

/// T-Code 下行队列：入队多行指令，按 MTU 逐包取出。
class CommandQueue {
    private var chunks: [String] = []
    private let mtu: Int
    private var seq: Int64 = 0

    init(mtu: Int = 20) { self.mtu = max(mtu, 1) }

    /// 入队一条完整指令（可能含多行），立即切成带换行的写包。
    func enqueue(_ cmd: String) {
        chunks.append(contentsOf: chunkCommandsForMtu(cmd, mtu))
    }

    /// 取出下一包（一条完整指令 + 换行）。返回 nil 表示空。
    func takeNextChunk() -> OutgoingChunk? {
        guard !chunks.isEmpty else { return nil }
        seq += 1
        return OutgoingChunk(text: chunks.removeFirst(), seq: seq)
    }

    var isEmpty: Bool { chunks.isEmpty }
    var count: Int { chunks.count }
}

/// 把一段多行 T-Code 文本切成若干 BLE 写包（纯函数，供测试/真机复用）。
/// 返回的每个包都不超过 mtu 字节，且以 '\n' 结尾。
func chunkCommandsForMtu(_ cmd: String, _ mtu: Int) -> [String] {
    let m = max(mtu, 2)          // 至少留 1 字节给行结束符；实际 MTU >= 20
    var result: [String] = []
    for rawLine in cmd.components(separatedBy: "\n") {
        let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
        if line.isEmpty { continue }
        if line.utf8.count + 1 <= m {
            result.append(line + "\n")
            continue
        }
        // 单行超过 MTU（罕见）：按字符硬切，每一片仍补换行，末片触发 executeAll()。
        let budget = m - 1
        var rest = line
        while !rest.isEmpty {
            result.append(String(rest.prefix(budget)) + "\n")
            rest = String(rest.dropFirst(budget))
        }
    }
    return result
}
