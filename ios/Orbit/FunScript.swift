import Foundation

// MARK: - funscript 数据结构
//
// 对齐安卓 OsrCore.kt 的 funscript 解析/插值/轴识别逻辑。
// 这里全部是「纯逻辑」——不依赖任何 Android Context / 文件 / 网络，
// iOS 端 /api/osr/funscript* 系列端点（M2 设备链路）直接复用本文件。
//
// 约定：脚本位置 pos 取值 0–100；设备输出值取值 0–9999（AXIS_VALUE_MAX）。

/// 单个动作点（at：毫秒；pos：0–100）
struct FunscriptAction {
    let at: Int64
    let pos: Int
}

/// 单轴动作序列（id：标准轴名，如 "L0"/"R0"）
struct FunscriptAxis {
    let id: String
    let actions: [FunscriptAction]
}

/// 一份完整脚本（可能含多轴）
struct FunscriptData {
    let durationSec: Float
    let axes: [FunscriptAxis]
}

// MARK: - 轴标识归一化 / 文件名推断

/// 把脚本里的轴标识（"L1"/"pitch"/"r0"）归一化成标准轴名。
/// 必须与 AXIS_NAMES / AXIS_ALIASES 保持一致，否则标准 OSR 脚本会被送到错误的轴。
func normalizeAxisId(_ raw: String) -> String {
    let t = raw.trimmingCharacters(in: .whitespaces)
    let upper = t.uppercased()
    if AXIS_NAMES.contains(upper) { return upper }
    return AXIS_ALIASES[t.lowercased()] ?? upper
}

/// 从 funscript 文件名推断轴：用于「多文件分轴」场景。
/// 规则：去掉 .funscript 扩展名后，按 . _ - 空格 # 拆成若干段，从最后一段往前逐段
/// （先显式轴名、后语义别名）精确匹配（大小写不敏感）。从后往前扫是关键：
/// 分轴命名里轴 token 总在最后（...Workout.pitch.funscript），而标题里经常出现
/// roll/left/right/in 这类词，从前往后会先命中标题里的词、把轴认错。
/// 识别不到（如 video1.funscript）返回 nil，由调用方回退到位置分配。
func axisFromFilename(_ name: String) -> String? {
    let body = name.substringBeforeLast(".")
    let segs = body.components(separatedBy: CharacterSet(charactersIn: "._- #"))
    for seg in segs.reversed() {
        if let idx = AXIS_NAMES.firstIndex(where: { $0.lowercased() == seg.lowercased() }) {
            return AXIS_NAMES[idx]
        }
    }
    for seg in segs.reversed() {
        if let hit = AXIS_ALIASES[seg.lowercased()] { return hit }
    }
    return nil
}

/// 一段文本（通常是「文件名去掉视频基名后的剩余部分」）里是否含可识别的轴 token。
/// 用于判定 Workout.pitch.funscript 属于 Workout.mp4，而 Workout 2.funscript 不属于。
func containsAxisToken(_ raw: String) -> Bool {
    let segs = raw.components(separatedBy: CharacterSet(charactersIn: "._- #"))
    for seg in segs where !seg.isEmpty {
        if AXIS_NAMES.contains(where: { $0.compare(seg, options: .caseInsensitive) == .orderedSame }) { return true }
        if AXIS_ALIASES[seg.lowercased()] != nil { return true }
    }
    return false
}

// MARK: - 连续重采样（按当前播放时钟插值）

/// 二分查找第一个 at >= timeMs 的下标，找不到返回 -1。
func findActionIndex(_ actions: [FunscriptAction], _ timeMs: Int64) -> Int {
    var lo = 0, hi = actions.count - 1, result = -1
    while lo <= hi {
        let mid = (lo + hi) / 2
        if actions[mid].at >= timeMs {
            result = mid
            hi = mid - 1
        } else {
            lo = mid + 1
        }
    }
    return result
}

/// 线性插值出 timeMs 时刻的轴位置（0–100）；越界钳到首尾动作。
/// 用于按当前时钟连续重采样：无论两次轮询之间时钟跳过多远，都给出该时刻的连续位置，
/// 避免「边沿触发 + 去重」写法跳过中间动作点导致的卡顿/跳变。
func interpPosAt(_ actions: [FunscriptAction], _ timeMs: Int64) -> Int {
    if actions.isEmpty { return 0 }
    if timeMs <= actions.first!.at { return actions.first!.pos }
    if timeMs >= actions.last!.at { return actions.last!.pos }
    let idx = findActionIndex(actions, timeMs)
    if idx <= 0 { return actions.first!.pos }
    let a = actions[idx - 1]
    let b = actions[idx]
    let span = b.at - a.at
    if span <= 0 { return b.pos }
    let frac = Double(timeMs - a.at) / Double(span)
    // Swift 不会像 Kotlin 那样在算术里隐式把 Int 拓宽为 Double，这里显式转 Double 再插值。
    let interp = Int(Double(a.pos) + (Double(b.pos) - Double(a.pos)) * frac)
    return clamp(interp, 0, 100)
}

// MARK: - 解析

/// 解析 actions 数组（[String:Any]，来自 JSONSerialization）。
func parseActionsArray(_ arr: [[String: Any]]) -> [FunscriptAction] {
    var actions: [FunscriptAction] = []
    for o in arr {
        let at = (o["at"] as? NSNumber)?.int64Value ?? 0
        let pos = (o["pos"] as? NSNumber)?.intValue ?? 0
        actions.append(FunscriptAction(at: at, pos: Int(pos)))
    }
    return actions.sorted { $0.at < $1.at }
}

/// 解析 .funscript 字典：根节点 actions → L0，axes 数组每项带 id。
func parseFunscript(json dict: [String: Any]) -> FunscriptData? {
    let durNum = (dict["metadata"] as? [String: Any])?["duration"] as? NSNumber
    let durationSec: Float = durNum?.floatValue ?? 0
    var axesList: [FunscriptAxis] = []
    if let actionsArr = dict["actions"] as? [[String: Any]] {
        let actions = parseActionsArray(actionsArr)
        if !actions.isEmpty { axesList.append(FunscriptAxis(id: "L0", actions: actions)) }
    }
    if let axes = dict["axes"] as? [[String: Any]] {
        for ax in axes {
            let rawId = (ax["id"] as? String) ?? "?"
            let id = normalizeAxisId(rawId.isEmpty ? "?" : rawId)
            guard let actionsArr = ax["actions"] as? [[String: Any]] else { continue }
            let actions = parseActionsArray(actionsArr)
            if actions.isEmpty { continue }
            axesList.append(FunscriptAxis(id: id, actions: actions))
        }
    }
    return axesList.isEmpty ? nil : FunscriptData(durationSec: durationSec, axes: axesList)
}

/// 解析 .funscript 文本（文件内容）。
func parseFunscript(text: String) -> FunscriptData? {
    guard let data = text.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return nil
    }
    return parseFunscript(json: obj)
}

// MARK: - 字符串辅助

extension String {
    /// 返回最后一个分隔符之前的部分；没有分隔符则返回自身。
    func substringBeforeLast(_ delim: Character) -> String {
        if let r = self.lastIndex(of: delim) {
            return String(self[startIndex..<r])
        }
        return self
    }
}
