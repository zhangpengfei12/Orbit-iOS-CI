import Foundation

// MARK: - funscript 后处理管线 + 运动分析信号工具
//
// 从安卓 osr/FunscriptPost.kt（383 行）与 ScriptRecorder.kt 的信号工具段忠实移植，
// 全是纯数学、零依赖，不碰 UIKit / 网络 / 文件系统，可在任何线程调用。
//
// 移植纪律：Kotlin 的 roundToInt() 是「四舍五入、.5 远离零」，Swift 的 rounded()
// 默认 .toNearestOrAwayFromZero，二者在 pos（0–100 非负）上完全一致，可直接替换。
// 但 limitSpeed 里必须**显式用 floor/ceil 朝零取整**，不能图省事用 rounded()——
// 见该函数内的说明。

/// 后处理参数（对齐安卓 RecordOptions 里参与后处理的那几个字段）。
struct ScriptPostOptions {
    /// 平滑强度 0–1：0 = 不平滑
    var smooth: Float = 0.5
    var minPos: Int = 0
    var maxPos: Int = 100
}

enum FunscriptPost {

    /* ===================== 默认参数 ===================== */

    /// 设备安全速度上限（units/s）。超过它机械结构跟不上，甚至过载。
    static let speedUps: Float = 600
    /// 相邻动作点的最小时间间隔（ms）。更密的点对设备没意义，只会制造抖动。
    static let minIntervalMs: Int64 = 55
    /// 抖动阈值：小于该幅度的反向折返视为噪声而非真实动作。
    static let jerkThreshold: Float = 15
    /// RDP 简化容差（pos 单位）。点已经稀疏，这里只做保守裁剪。
    static let rdpEps: Float = 4
    /// 归一化后的轻微放大（围绕中位），让行程更饱满但不撞限位。
    static let amplifyScale: Float = 1.08
    /// 滚动归一化的时间窗（ms）：窗口内的笔触共用一套幅度映射。
    static let segmentWindowMs: Int64 = 20_000
    /// 归一化目标区间：窗口内 p10→p90 映射到 [lo, hi]。
    static let targetLo: Float = 12
    static let targetHi: Float = 88
    /// 动态范围下限：窗口内 p90-p10 小于它判定为静止段。
    static let minRange: Float = 8

    /* ===================== 管线入口 ===================== */

    /// 完整后处理。输入必须按时间升序、无重复时刻；输出仍升序且首尾点必定保留。
    static func run(_ actions: [FunscriptAction], opt: ScriptPostOptions) -> [FunscriptAction] {
        if actions.count < 3 { return actions }
        var a = removeShortIntervals(actions, minIntervalMs)
        let s = clampF(opt.smooth, 0, 1)
        a = smooth(a, Int64(60 + 340 * s), s)
        a = removeJerk(a, jerkThreshold)
        a = normalizeRolling(a, segmentWindowMs, targetLo, targetHi)
        a = amplify(a, amplifyScale, 50, opt.minPos, opt.maxPos)
        a = rdpSimplify(a, rdpEps)
        a = limitSpeed(a, speedUps)
        return dedup(a, minIntervalMs)
    }

    /// 轻量管线，给辅助轴（L1 等）用。
    /// 辅助轴大量段落处于回中状态，跑 run 的滚动归一化会把偶尔的稀疏峰值拉成满行程——那是失真。
    static func runAux(_ actions: [FunscriptAction], opt: ScriptPostOptions) -> [FunscriptAction] {
        if actions.count < 3 { return actions }
        var a = removeShortIntervals(actions, minIntervalMs)
        let s = clampF(opt.smooth, 0, 1)
        a = smooth(a, Int64(60 + 340 * s), s)
        a = limitSpeed(a, speedUps)
        return dedup(a, minIntervalMs)
    }

    /* ===================== 各步骤 ===================== */

    /// 去掉间隔过密的动作点。
    /// 直接丢弃会误伤真正的峰值（峰值常紧跟谷底），所以丢弃前比较一次：
    /// 若新点更远离中位（更像极值），就用它替换，保证极值不被吞掉。
    static func removeShortIntervals(_ actions: [FunscriptAction], _ minMs: Int64) -> [FunscriptAction] {
        if actions.count < 3 { return actions }
        var out: [FunscriptAction] = [actions[0]]
        for i in 1..<actions.count {
            let cur = actions[i]
            let last = out[out.count - 1]
            if cur.at - last.at >= minMs {
                out.append(cur)
                continue
            }
            if abs(cur.pos - 50) > abs(last.pos - 50) { out[out.count - 1] = cur }
        }
        return out
    }

    /// 局部线性加权回归平滑（对不均匀时间序列的 Savitzky-Golay 等价形式）。
    /// funscript 的动作点在时间上不均匀，直接套等距 SG 卷积会失真，
    /// 所以对每点在其时间邻域内做加权最小二乘一次多项式拟合，取截距作为平滑值：
    /// 解 [Sw Swt; Swt Swtt]·[a b] = [Swy Swty]，a 即该点平滑结果。
    static func smooth(_ actions: [FunscriptAction], _ windowMs: Int64, _ strength: Float) -> [FunscriptAction] {
        let n = actions.count
        if n < 5 || windowMs <= 0 || strength <= 0 { return actions }
        let sigma = Float(windowMs) / 2
        var out: [FunscriptAction] = []
        out.reserveCapacity(n)
        for i in 0..<n {
            let ti = actions[i].at
            var sw = 0.0, swt = 0.0, swtt = 0.0, swy = 0.0, swty = 0.0
            var cnt = 0
            for j in 0..<n {
                let dt = Double(actions[j].at - ti)
                if abs(dt) > Double(windowMs) { continue }
                let w = exp(-0.5 * (dt / Double(sigma)) * (dt / Double(sigma)))
                let y = Double(actions[j].pos)
                sw += w; swt += w * dt; swtt += w * dt * dt
                swy += w * y; swty += w * dt * y
                cnt += 1
            }
            if cnt < 3 {
                out.append(actions[i])
                continue
            }
            let det = sw * swtt - swt * swt
            if abs(det) < 1e-9 {
                out.append(actions[i])
                continue
            }
            let fit = (swy * swtt - swty * swt) / det
            let v = Double(actions[i].pos) + (fit - Double(actions[i].pos)) * Double(strength)
            out.append(FunscriptAction(at: ti, pos: clamp(Int(v.rounded()), 0, 100)))
        }
        return out
    }

    /// 去抖动：删掉「幅度很小却发生方向反转」的中间点。
    /// 这类点是平滑残留或估计噪声，设备跟着走只会表现为无意义的哆嗦。
    static func removeJerk(_ actions: [FunscriptAction], _ threshold: Float) -> [FunscriptAction] {
        if actions.count < 3 { return actions }
        var out: [FunscriptAction] = [actions[0]]
        var i = 1
        while i < actions.count - 1 {
            let cur = actions[i]
            let nxt = actions[i + 1]
            let last = out[out.count - 1]
            let d1 = Float(cur.pos - last.pos)
            let d2 = Float(nxt.pos - cur.pos)
            let isJerk = (d1 * d2 < 0) && (abs(d1) < threshold)
            if !isJerk { out.append(cur) }
            i += 1
        }
        out.append(actions[actions.count - 1])
        return out
    }

    /// 滚动窗口幅度归一化 —— 提升体感质量最关键的一步。
    /// 合成层输出的是全局归一化结果，安静段与激烈段挤在同一窄区间 → 整片「没劲」。
    /// 改成局部：每点用其时间邻域的 p10/p90 做映射，让每段都充分利用 [lo, hi]。
    /// 静止段（邻域动态范围 < minRange）不放大（否则噪声被拉成满行程），而是向中位收缩。
    /// 用滚动窗而非硬分段，是为了避免段边界出现幅度跳变。
    static func normalizeRolling(
        _ actions: [FunscriptAction],
        _ windowMs: Int64,
        _ lo: Float,
        _ hi: Float
    ) -> [FunscriptAction] {
        let n = actions.count
        if n < 5 { return actions }
        let half = Double(windowMs) / 2.0
        var out: [FunscriptAction] = []
        out.reserveCapacity(n)
        var buf = [Double](repeating: 0, count: n)
        for i in 0..<n {
            let ti = Double(actions[i].at)
            var m = 0
            for j in 0..<n {
                if abs(Double(actions[j].at) - ti) <= half {
                    buf[m] = Double(actions[j].pos)
                    m += 1
                }
            }
            if m < 5 {
                out.append(actions[i])
                continue
            }
            var slice = Array(buf[0..<m])
            slice.sort()
            let p10 = slice[Int(Double(m - 1) * 0.10)]
            let p90 = slice[Int(Double(m - 1) * 0.90)]
            let range = Float(p90 - p10)
            let pos = Float(actions[i].pos)
            let v: Float
            if range < minRange {
                v = 50 + (pos - 50) * (range / minRange)
            } else {
                v = lo + (pos - Float(p10)) / range * (hi - lo)
            }
            out.append(FunscriptAction(at: actions[i].at, pos: clamp(Int(v.rounded()), 0, 100)))
        }
        return out
    }

    /// 围绕中位线性放大幅度，并夹到 [minPos, maxPos]。
    static func amplify(
        _ actions: [FunscriptAction],
        _ scale: Float,
        _ center: Float,
        _ minPos: Int,
        _ maxPos: Int
    ) -> [FunscriptAction] {
        return actions.map {
            let v = center + (Float($0.pos) - center) * scale
            return FunscriptAction(at: $0.at, pos: clamp(Int(v.rounded()), minPos, maxPos))
        }
    }

    /// RDP 简化（Douglas-Peucker，显式栈避免深递归）。
    /// 距离度量用**沿时间轴的投影距离**而非欧氏垂距：动作点是时序信号，
    /// 关心的是「该点偏离首尾连线的位置量」，欧氏距离会被时间尺度干扰。
    static func rdpSimplify(_ actions: [FunscriptAction], _ eps: Float) -> [FunscriptAction] {
        let n = actions.count
        if n < 3 { return actions }
        var keep = [Bool](repeating: false, count: n)
        keep[0] = true
        keep[n - 1] = true
        var stack = [Int]()
        stack.append(0)
        stack.append(n - 1)
        while !stack.isEmpty {
            let last = stack.removeLast()
            let first = stack.removeLast()
            if last - first < 2 { continue }
            let t0 = actions[first].at
            let t1 = actions[last].at
            let p0 = Double(actions[first].pos)
            let p1 = Double(actions[last].pos)
            let dt = Double(t1 - t0)
            var maxD = -1.0
            var maxI = -1
            for i in (first + 1)..<last {
                let r = dt > 0 ? (Double(actions[i].at - t0) / dt) : 0
                let proj = p0 + r * (p1 - p0)
                let d = abs(Double(actions[i].pos) - proj)
                if d > maxD { maxD = d; maxI = i }
            }
            if maxD > Double(eps), maxI > 0 {
                keep[maxI] = true
                stack.append(first); stack.append(maxI)
                stack.append(maxI); stack.append(last)
            }
        }
        var out: [FunscriptAction] = []
        for i in 0..<n where keep[i] { out.append(actions[i]) }
        return out
    }

    /// 速度限制器（设备安全硬约束）。
    /// 逐点钳制：相邻两点允许的最大变化 = 速度上限 × 时间间隔。
    /// 超限就把当前点拉回「上一点 + 允许最大变化」，因此是顺序传播的——
    /// 一个过快的大行程会被整体拉慢，而不是只削掉末点。
    static func limitSpeed(_ actions: [FunscriptAction], _ maxUps: Float) -> [FunscriptAction] {
        if actions.count < 2 { return actions }
        var out: [FunscriptAction] = [actions[0]]
        for i in 1..<actions.count {
            let prev = out[out.count - 1]
            let cur = actions[i]
            let dtMs = cur.at - prev.at
            if dtMs <= 0 { continue }
            let maxDp = maxUps * (Float(dtMs) / 1000)
            let dp = Float(cur.pos - prev.pos)
            let p: Float
            if abs(dp) > maxDp {
                // ⚠️ 必须朝零方向取整而不是四舍五入：rounded() 会把 60.5 抬成 61，
                // 于是本该刚好合规的一段变成 610 u/s —— 限速器自己制造了超速。
                let target = Float(prev.pos) + (dp > 0 ? maxDp : -maxDp)
                p = dp > 0 ? floor(target) : ceil(target)
            } else {
                p = Float(cur.pos)
            }
            out.append(FunscriptAction(at: cur.at, pos: clamp(Int(p), 0, 100)))
        }
        return out
    }

    /// 去掉间隔过密 / 连续同位置的冗余点（平滑与限速之后会新产生一批）。
    static func dedup(_ actions: [FunscriptAction], _ minMs: Int64) -> [FunscriptAction] {
        if actions.count < 3 { return actions }
        var out: [FunscriptAction] = [actions[0]]
        for i in 1..<actions.count {
            let cur = actions[i]
            let last = out[out.count - 1]
            if cur.at - last.at < minMs { continue }
            if cur.pos == last.pos && i < actions.count - 1 { continue }
            out.append(cur)
        }
        return out
    }

    /* ===================== 诊断工具 ===================== */

    struct Metrics {
        /// 最大瞬时速度（units/s），超过 speedUps 说明限速失效
        let maxSpeed: Float
        let avgSpeed: Float
        /// 行程利用区间，越接近 targetLo..targetHi 说明归一化生效
        let p10: Float
        let p90: Float
        /// 方向反转次数，近似笔触数
        let reversals: Int
    }

    static func metrics(_ actions: [FunscriptAction]) -> Metrics {
        if actions.count < 2 { return Metrics(maxSpeed: 0, avgSpeed: 0, p10: 0, p90: 0, reversals: 0) }
        var maxS: Float = 0, sumS: Float = 0
        var cnt = 0, rev = 0, prevDir = 0
        for i in 1..<actions.count {
            let dtMs = actions[i].at - actions[i - 1].at
            if dtMs <= 0 { continue }
            let s = abs(Float(actions[i].pos - actions[i - 1].pos)) / (Float(dtMs) / 1000)
            if s > maxS { maxS = s }
            sumS += s
            cnt += 1
            let d = actions[i].pos - actions[i - 1].pos
            if d != 0 {
                let dir = d > 0 ? 1 : -1
                if prevDir != 0 && dir != prevDir { rev += 1 }
                prevDir = dir
            }
        }
        let sorted = actions.map { $0.pos }.sorted()
        let p10 = Float(sorted[Int(Double(sorted.count - 1) * 0.10)])
        let p90 = Float(sorted[Int(Double(sorted.count - 1) * 0.90)])
        return Metrics(maxSpeed: maxS, avgSpeed: cnt > 0 ? sumS / Float(cnt) : 0,
                       p10: p10, p90: p90, reversals: rev)
    }
}

// MARK: - 运动分析信号工具（移植自 ScriptRecorder.kt:287-363）

/// AI 生成脚本时从画面/音频通道里提取「事件感」的一组工具。
/// iOS 侧目前还没有视频逐帧分析管线，先把纯算法搬过来，
/// 等 M2 接入 AVAssetReader 逐帧运动估计后即可直接消费。
enum SignalAnalysis {

    /// 鲁棒归一化：减 p05、除 (p95-p05)。比 min-max 抗异常值，避免一个尖峰把整体压低。
    static func robustNorm(_ a: [Float]) -> [Float] {
        if a.count < 8 { return [Float](repeating: 0, count: a.count) }
        let s = a.filter { $0.isFinite }.sorted()
        if s.count < 8 { return [Float](repeating: 0, count: a.count) }
        let p05 = s[clamp(Int(Float(s.count) * 0.05), 0, s.count - 1)]
        let p95 = s[clamp(Int(Float(s.count) * 0.95), 0, s.count - 1)]
        let span = max(p95 - p05, 1e-4)
        return a.map { clampF(($0 - p05) / span, 0, 1) }
    }

    static func percentile(_ a: [Float], _ p: Float) -> Float {
        if a.isEmpty { return 0 }
        let s = a.sorted()
        return s[clamp(Int(Float(s.count) * p), 0, s.count - 1)]
    }

    /// 通道「信息量」：归一化后信号的 p90-p10 动态范围。
    /// 一条几乎是常数的通道（固定镜头下几乎无画面变化）不该和起伏明显的通道等权。
    static func dynRange(_ a: [Float]) -> Float {
        if a.count < 8 { return 0 }
        let s = a.sorted()
        let p10 = s[clamp(Int(Float(s.count) * 0.10), 0, s.count - 1)]
        let p90 = s[clamp(Int(Float(s.count) * 0.90), 0, s.count - 1)]
        return clampF(p90 - p10, 0, 1)
    }

    /// 因果移动平均的正偏差 —— 音频与运动都能用的通用 novelty。
    static func novelty(_ x: [Float], win: Int) -> [Float] {
        let n = x.count
        var out = [Float](repeating: 0, count: n)
        let w = max(1, win)
        var sum = 0.0
        for i in 0..<n {
            sum += Double(x[i])
            if i >= w { sum -= Double(x[i - w]) }
            let cnt = min(i + 1, w)
            out[i] = max(0, x[i] - Float(sum / Double(cnt)))
        }
        return out
    }

    static func threshold(_ nov: [Float], k: Float) -> Float {
        if nov.isEmpty { return Float.greatestFiniteMagnitude }
        let mean = nov.reduce(0, +) / Float(nov.count)
        var varSum: Float = 0
        for v in nov { varSum += (v - mean) * (v - mean) }
        let std = sqrt(varSum / Float(nov.count))
        return max(mean + k * std, 0.015)
    }

    /// 不应期峰值挑选：按幅度从大到小收敛，再去重排序。
    static func pickPeaks(_ nov: [Float], thr: Float, minGap: Int) -> [Int] {
        var cand: [Int] = []
        if nov.count < 3 { return cand }
        for i in 1..<(nov.count - 1) {
            if nov[i] >= thr && nov[i] >= nov[i - 1] && nov[i] > nov[i + 1] { cand.append(i) }
        }
        var taken = [Bool](repeating: false, count: nov.count)
        var kept: [Int] = []
        for i in cand.sorted(by: { nov[$0] > nov[$1] }) {
            var ok = true
            let lo = max(0, i - minGap)
            let hi = min(nov.count - 1, i + minGap)
            for k in lo...hi where k != i && taken[k] { ok = false; break }
            if ok { taken[i] = true; kept.append(i) }
        }
        return kept.sorted()
    }

    static func meanAbs(_ a: [Float], from: Int, to: Int) -> Float {
        if to <= from { return 0 }
        var s: Float = 0
        for i in from..<min(to, a.count) { s += abs(a[i]) }
        return s / Float(to - from)
    }
}

// MARK: - 私有辅助

/// Float 版钳制（工程里已有的 clamp 只吃 Int）。
private func clampF(_ v: Float, _ lo: Float, _ hi: Float) -> Float {
    return min(max(v, lo), hi)
}
