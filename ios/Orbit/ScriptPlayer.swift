import Foundation
import UIKit

// MARK: - 脚本播放引擎（对齐安卓 OsrManager + OsrSyncService 的下发循环）
//
// 安卓靠「前台服务 + 协程 while 循环」每 RESAMPLE_MS(40ms) 按播放时钟插值下发；
// iOS 没有前台服务，这里用 DispatchSourceTimer 在专用队列上做同一件事。
//
// ⚠ iOS 的硬约束（与安卓最大的差异，必须在文案里说清）：
//   App 进入后台后系统会在数秒内挂起进程，定时器随之停止 —— 没有任何保活手段
//   （没有前台服务、没有唤醒锁、也不能声明 audio 之外的后台模式）。
//   所以本引擎只保证**前台**连续驱动；进后台时冻结时钟，回前台再重新锚定，
//   绝不伪造「后台仍在动」的假象（早期安卓那套 bgHold 自驱在 iOS 上做不到）。
//
// 与安卓的语义对齐点：
//   · 时钟是「墙钟锚点 + 自驱推进」，前端每 250ms 上报一次只用于纠偏（漂移 >500ms 才重锚），
//     逐次硬锚会把解码抖动搬到设备位置上（位置毛刺）。
//   · stop 必须连脚本一起卸掉：只停时钟的话循环仍会按锚点把脚本首帧位置持续下发，
//     与手控触板的手动指令抢同一条链路（表现为「脚本停了设备还乱动」）。
//   · 换到无脚本视频时必须 clearScript()，否则上一部片的脚本会继续推（串片）。

final class ScriptPlayer {

    static let shared = ScriptPlayer()

    private let lock = NSLock()
    private let queue = DispatchQueue(label: "orbit.script.player", qos: .userInteractive)
    private var timer: DispatchSourceTimer?

    // ── 脚本数据源 ──
    private var script: FunscriptData?

    // ── 时钟 ──
    private var playing = false
    private var clockMediaAnchorMs: Int64 = 0
    private var clockWallAnchorMs: Double = 0

    // ── 同步开关（用户「同步播放」设置）──
    private var syncEnabled = false

    // ── 自动模式（playmode）──
    // ⚠ 对齐安卓 OsrManager：freeplay = SimPattern 7 图案 × 6 轴 + 渐变过渡 +
    //   图案选择/自动轮换；sine = 6 轴正弦相位差 120°；random = TestStrokeMode 5 笔划。
    //   旧版这里是「单轴 L0 三角波」占位实现 —— 用户实测「自动播放不如安卓流畅」的根因。
    private var autoMode: String = ""      // "" | "sine" | "random" | "freeplay"

    // sine（对齐安卓 startSine：仅强度参数，固定 0.4Hz）
    private var autoIntensity: Float = 0.6
    private var sineStartMs: Double = 0

    // freeplay（对齐安卓 simSpeed / simIntensity / simDuration / simAutoSwitch / simSelectedIndex）
    private var simSpeed: Float = 50
    private var simIntensity: Float = 0.7
    private var simDuration: Float = 0.3
    private var simAutoSwitch: Bool = true
    private var simSelectedIndex: Int = 0

    // random（对齐安卓 randomMode / randomChange / randomFreq）
    private var strokeMode: Int = 1        // TestStrokeMode：0 Short / 1 Long / 2 Jerk / 3 Orbit / 4 Hops
    private var randomChange: Float = 30
    private var randomFreq: Int = 50

    // 运行态（对齐安卓 runSimulationLoop / runRandomLoop 的循环局部变量，跨 tick 保持）
    private var activeIdx: Int = 0
    private var patternStartMs: Double = 0
    private var transStartMs: Double = 0
    private var fromTargets: [String: Int] = [:]
    private var livePos: [String: Int] = AXIS_NAMES.reduce(into: [:]) { $0[$1] = AXIS_VALUE_MAX / 2 }
    private var randomStep: Int = 0
    private var randomDir: Int = 1
    private var randomCarryMs: Double = 0

    // ── 独立冲刺 ──
    private var dashOn = false
    private var dashSpeed: Float = 60
    private var dashAmp = 100
    private var dashPhases: [String: Float] = [:]

    // ── 旋转 / 摆动相位（跨帧保持连续）──
    private var spinAngles: [String: Int] = [:]
    private var sweepPhases: [String: Float] = [:]

    private var lastTickMs: Double = 0

    private init() {
        observeLifecycle()
    }

    // MARK: - 对外：脚本装载

    /// 加载单份 funscript 文本（根 actions 走 L0）。
    @discardableResult
    func loadText(_ text: String) -> Bool {
        guard let data = parseFunscript(text: text) else { return false }
        lock.lock(); script = data; lock.unlock()
        return true
    }

    /// 合并多份脚本（按文件名定轴，对齐安卓 OsrManager.mergeFunscripts）。
    /// - Parameter pairs: (文件名, 文本) —— 文件名用于 axisFromFilename 定轴。
    @discardableResult
    func merge(_ pairs: [(String, String)]) -> Bool {
        var merged: [FunscriptAxis] = []
        var fileAxis = 0
        var maxDur: Float = 0
        for (name, text) in pairs {
            guard let data = parseFunscript(text: text) else { continue }
            if data.durationSec > maxDur { maxDur = data.durationSec }
            for ax in data.axes {
                let id: String
                if ax.id == "L0" {
                    if let byName = axisFromFilename(name) {
                        id = byName
                    } else {
                        id = AXIS_NAMES.indices.contains(fileAxis) ? AXIS_NAMES[fileAxis] : "L\(fileAxis)"
                        fileAxis += 1
                    }
                } else {
                    id = ax.id
                }
                merged.append(FunscriptAxis(id: id, actions: ax.actions))
            }
        }
        guard !merged.isEmpty else { return false }
        lock.lock(); script = FunscriptData(durationSec: maxDur, axes: merged); lock.unlock()
        return true
    }

    /// 卸掉脚本数据源（不动同步开关、不停时钟）——换片时防串片的关键。
    func clearScript() {
        lock.lock(); script = nil; lock.unlock()
    }

    func durationSec() -> Float {
        lock.lock(); defer { lock.unlock() }
        return script?.durationSec ?? 0
    }

    func hasScript() -> Bool {
        lock.lock(); defer { lock.unlock() }
        return script != nil
    }

    /// 首页「设备」磁贴判定运行中态用：返回当前生效的运动模式。
    func motionMode() -> String {
        lock.lock(); defer { lock.unlock() }
        if !autoMode.isEmpty { return autoMode }            // sine / random / freeplay
        if dashOn { return "dash" }
        if syncEnabled && playing && script != nil { return "script" }
        return "idle"
    }

    /// 脚本播放时钟是否在走（设备页播放按钮态同步用）。
    func isPlaying() -> Bool {
        lock.lock(); defer { lock.unlock() }
        return playing
    }

    // MARK: - 对外：播放控制

    /// scriptControl：play / pause / stop（对齐安卓 OsrManager.scriptControl）。
    func control(_ action: String) -> Bool {
        switch action {
        case "play":
            guard hasScript() else { return false }
            setSync(true)
            // ⚠ 不能 applyClock(playing:true, mediaMs:0)：那样会把媒体时钟打回 0，
            //   用户在第 30 分钟按一下播放就跳回片头。play 只负责「接着当前锚点继续走」，
            //   真正的对齐交给 /api/osr/playback-time（漂移 >500ms 才重锚）。
            lock.lock()
            if !playing {
                clockWallAnchorMs = nowMs()
                playing = true
            }
            lock.unlock()
            startLoop()
            return true
        case "pause":
            applyClock(playing: false, mediaMs: currentPlaybackMs())
            return true
        case "stop":
            stopLoop()
            clearScript()
            applyClock(playing: false, mediaMs: 0)
            dashOn = false
            autoMode = ""
            return true
        default:
            return false
        }
    }

    /// 同步开关：关闭时顺手收掉冲刺（没脚本驱动却一直满程往复属于意外动作）。
    func setSync(_ enabled: Bool) {
        lock.lock()
        syncEnabled = enabled
        if !enabled { dashOn = false; dashPhases.removeAll() }
        lock.unlock()
        if enabled { startLoop() } else { stopLoop() }
    }

    func isSyncOn() -> Bool {
        lock.lock(); defer { lock.unlock() }
        return syncEnabled
    }

    /// 前端上报播放时钟（每 250ms 一次），只用于纠偏。
    func setPlaybackClock(playing: Bool, timeMs: Int64) {
        applyClock(playing: playing, mediaMs: timeMs)
        if playing { startLoop() }
    }

    // MARK: - 对外：自动模式 / 冲刺

    func setDash(on: Bool, speed: Float, amp: Int) {
        lock.lock()
        dashOn = on
        dashSpeed = speed > 0 ? speed : 60
        dashAmp = amp > 0 ? amp : 100
        if !on { dashPhases.removeAll() }
        lock.unlock()
        if on { startLoop() }
    }

    func dashState() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return ["ok": true, "on": dashOn, "speed": dashSpeed, "amp": dashAmp]
    }

    /// 自动模式：sine / random / freeplay / stop（对齐安卓 startSine / startRandom / startFreePlay）。
    func setAutoMode(_ mode: String, intensity: Float, speed: Float, duration: Float,
                     autoSwitch: Bool = true, selectedIndex: Int = 0,
                     strokeMode m: Int = 1, change: Float = 30, freq: Int = 50) {
        lock.lock()
        autoMode = mode
        autoIntensity = intensity
        if mode == "sine" {
            sineStartMs = nowMs()
        } else if mode == "random" {
            strokeMode = m
            randomChange = change
            randomFreq = freq
            randomStep = 0
            randomDir = 1
            randomCarryMs = 0
        } else if mode == "freeplay" {
            simSpeed = speed
            simIntensity = intensity
            simDuration = duration
            simAutoSwitch = autoSwitch
            simSelectedIndex = selectedIndex
            // 对齐安卓 startFreePlay：sel >= 图案数 = 随机全场（任意图案起步），否则用所选图案
            if selectedIndex >= SIM_PATTERN_COUNT || selectedIndex < 0 {
                activeIdx = Int.random(in: 0..<SIM_PATTERN_COUNT)
            } else {
                activeIdx = selectedIndex
            }
            patternStartMs = nowMs()
            transStartMs = patternStartMs
            fromTargets = livePos
        }
        lock.unlock()
        if mode == "stop" {
            stopLoop()
            applyClock(playing: false, mediaMs: currentPlaybackMs())
        } else {
            startLoop()
        }
    }

    /// 运行中实时更新参数（不重启循环、不重置图案相位，对齐安卓 updateSine / updateRandom / updateFreePlay）。
    /// 图案切换（selectedIndex 变化）由 tick 里的 sel != activeIdx 分支自然处理。
    func updateAutoMode(_ mode: String, intensity: Float, speed: Float, duration: Float,
                        autoSwitch: Bool = true, selectedIndex: Int = 0,
                        strokeMode m: Int = 1, change: Float = 30, freq: Int = 50) {
        lock.lock()
        switch mode {
        case "sine":
            autoIntensity = intensity
        case "random":
            strokeMode = m
            randomChange = change
            randomFreq = freq
        case "freeplay":
            simSpeed = speed
            simIntensity = intensity
            simDuration = duration
            simAutoSwitch = autoSwitch
            simSelectedIndex = selectedIndex
        default:
            break
        }
        lock.unlock()
    }

    /// 停止自动运动。home=true 时六轴缓动回中位（对齐安卓 stopMotion(home=true)：
    /// 自动模式点「停止」设备回到初始位置，避免停在最后动作点）；进后台的清理传 false。
    func stopMotion(home: Bool = true) {
        lock.lock()
        autoMode = ""
        dashOn = false
        dashPhases.removeAll()
        lock.unlock()
        stopLoop()
        guard home else { return }
        let ctx = OsrLink.cmdContext()
        var body = ""
        for axis in AXIS_NAMES {
            body += buildAxisPosCommand(ctx, axis, AXIS_VALUE_MAX / 2, 600)
            livePos[axis] = AXIS_VALUE_MAX / 2
        }
        OsrLink.dispatch(body)
    }

    // MARK: - 时钟

    private func nowMs() -> Double {
        return Date().timeIntervalSince1970 * 1000
    }

    func currentPlaybackMs() -> Int64 {
        lock.lock(); defer { lock.unlock() }
        if playing {
            return max(0, clockMediaAnchorMs + Int64(nowMs() - clockWallAnchorMs))
        }
        return max(0, clockMediaAnchorMs)
    }

    private func applyClock(playing: Bool, mediaMs: Int64) {
        lock.lock()
        if playing {
            let drift = mediaMs - currentPlaybackMsLocked()
            // 只在「之前没在播」或「漂移超过 500ms（发生了 seek/跳转）」时重锚
            if !self.playing || abs(drift) > 500 {
                clockMediaAnchorMs = max(0, mediaMs)
                clockWallAnchorMs = nowMs()
            }
            self.playing = true
        } else {
            clockMediaAnchorMs = max(0, mediaMs)
            self.playing = false
        }
        lock.unlock()
    }

    /// 锁内版本：调用方必须已持锁（避免 applyClock 里重复加锁死锁）。
    private func currentPlaybackMsLocked() -> Int64 {
        if playing {
            return max(0, clockMediaAnchorMs + Int64(nowMs() - clockWallAnchorMs))
        }
        return max(0, clockMediaAnchorMs)
    }

    // MARK: - 下发循环

    private func startLoop() {
        queue.async {
            if self.timer != nil { return }
            let t = DispatchSource.makeTimerSource(queue: self.queue)
            // 40ms：与安卓 RESAMPLE_MS 一致，再快对 UDP/BLE 都是纯浪费且易被固件丢包
            t.schedule(deadline: .now(), repeating: .milliseconds(Int(RESAMPLE_MS)))
            t.setEventHandler { [weak self] in self?.tick() }
            self.timer = t
            t.resume()
            self.lastTickMs = self.nowMs()
        }
    }

    private func stopLoop() {
        queue.async {
            self.timer?.cancel()
            self.timer = nil
        }
    }

    private func tick() {
        let now = nowMs()
        let elapsed: Int64 = max(0, Int64(now - lastTickMs))
        lastTickMs = now

        let ctx = OsrLink.cmdContext()
        var body = ""

        lock.lock()
        let s = script
        let sync = syncEnabled
        let pl = playing
        let dash = dashOn
        let dSpeed = dashSpeed
        let dAmp = dashAmp
        let mode = autoMode
        let intensity = autoIntensity
        // freeplay / random 运行态的读写都在本锁内（tick 由专用串行队列驱动，无并发 tick）
        lock.unlock()

        // ① 独立冲刺：与脚本并存时冲刺接管 L0（安卓 dashRaw 语义）
        if dash {
            var phases = dashPhases
            body += buildDashSweepCommand(ctx, "L0", elapsed, &phases, dSpeed, dAmp)
            dashPhases = phases
        }

        // ② 脚本驱动：只有同步开关打开且时钟在走才下发
        if sync, let sc = s, pl, !dash {
            body += buildAxisCommandsFromFunscript(ctx, sc, currentPlaybackMs())
        }

        // ③ 自动模式（无脚本时也能让设备动起来）——完整移植安卓三模式引擎
        if !mode.isEmpty && mode != "stop" && !dash {
            switch mode {
            case "sine":
                body += autoSineBody(ctx, intensity: intensity)
            case "random":
                body += autoRandomBody(ctx, elapsed: elapsed)
            default: // freeplay
                body += autoFreeplayBody(ctx)
            }
        }

        // ④ 旋转 / 摆动：只在播放态推进相位
        if pl || !mode.isEmpty {
            body += buildRotationCommands(ctx, elapsed, &spinAngles, &sweepPhases)
        }

        guard !body.isEmpty else { return }
        let full = ctx.prefix + body + ctx.suffix
        OsrLink.dispatch(full)
    }

    // MARK: - 自动模式引擎（完整移植安卓 OsrManager.runSineLoop / runRandomLoop / runSimulationLoop）

    /// 6 轴目标一次性合并成一条指令下发（对齐安卓 dispatchTargets：
    /// 逐轴单独发会成倍放大发包开销，合并后一帧一次 send，帧率才有保障）。
    private func dispatchTargets(_ ctx: CmdContext, _ targets: [String: Int], _ durationMs: Int64) -> String {
        var entries: [(String, Int)] = []
        for axis in AXIS_NAMES {
            guard let p = targets[axis] else { continue }
            let v = min(max(p, 0), AXIS_VALUE_MAX)
            livePos[axis] = v
            entries.append((axis, v))
        }
        guard !entries.isEmpty else { return "" }
        return buildAxesPosCommand(ctx, entries, durationMs)
    }

    /// sine：对齐安卓 runSineLoop —— 固定 0.4Hz，L 组三轴相位差 120°，
    /// R 组 0.3 倍幅度同相位差，I60 缓动。安卓的 sine 本就没有速度参数。
    private func autoSineBody(_ ctx: CmdContext, intensity: Float) -> String {
        let t = (nowMs() - sineStartMs) / 1000.0
        let phase = 2 * Double.pi * 0.4 * t
        let c = AXIS_VALUE_MAX / 2
        let amp = Double(min(max(intensity, 0), 1)) * Double(AXIS_VALUE_MAX / 2) * 0.9
        let p2 = phase + 2 * Double.pi / 3
        let p4 = phase + 4 * Double.pi / 3
        let targets: [String: Int] = [
            "L0": c + Int(amp * sin(phase)),
            "L1": c + Int(amp * sin(p2)),
            "L2": c + Int(amp * sin(p4)),
            "R0": c + Int(amp * 0.3 * sin(phase)),
            "R1": c + Int(amp * 0.3 * sin(p2)),
            "R2": c + Int(amp * 0.3 * sin(p4))
        ]
        return dispatchTargets(ctx, targets, 60)
    }

    /// random：对齐安卓 runRandomLoop —— 5 种笔划（Short/Long/Jerk/Orbit/Hops），
    /// 帧间隔 randomFreq(20-500ms)，用 carry 累计适配 40ms tick。
    private func autoRandomBody(_ ctx: CmdContext, elapsed: Int64) -> String {
        randomCarryMs += Double(elapsed)
        let interval = Double(min(max(randomFreq, 20), 500))
        guard randomCarryMs >= interval else { return "" }
        randomCarryMs = 0

        let range = AXIS_VALUE_MAX
        let center = range / 2
        let factor: Float = {
            switch strokeMode {
            case 0: return 0.35   // Short
            case 3: return 0.9    // Orbit
            default: return 1.0   // Long / Jerk / Hops
            }
        }()
        let amp = Int((min(max(randomChange, 0), 100) / 100) * Float(range) * factor)
        let weight: [String: Float] = ["L0": 1.0, "L1": 0.85, "L2": 0.7, "R0": 0.5, "R1": 0.5, "R2": 0.4]

        let targets: [String: Int]
        switch strokeMode {
        case 3: // Orbit：圆周轨迹
            let theta = Double(randomStep) * (2 * Double.pi / 24)
            targets = [
                "L0": center + Int(amp * sin(theta)),
                "L1": center + Int(amp * cos(theta)),
                "L2": center + Int(amp * 0.4 * sin(2 * theta)),
                "R0": center + Int(amp * 0.5 * sin(theta)),
                "R1": center + Int(amp * 0.5 * cos(theta)),
                "R2": center
            ]
        case 2, 4: // Jerk / Hops：每轴独立随机落点
            targets = AXIS_NAMES.reduce(into: [:]) { acc, axis in
                let r = Float.random(in: 0..<1) * 2 - 1
                acc[axis] = center + Int(r * Float(amp) * (weight[axis] ?? 0.6))
            }
        default: // Short / Long：方向反转的加权往返
            randomDir = -randomDir
            targets = AXIS_NAMES.reduce(into: [:]) { acc, axis in
                acc[axis] = center + randomDir * amp * Int(weight[axis] ?? 0.6)
            }
        }
        randomStep += 1
        return dispatchTargets(ctx, targets, Int64(max(randomFreq, 20)))
    }

    /// freeplay：对齐安卓 runSimulationLoop —— SimPattern 图案采样 + 图案间渐变过渡 +
    /// 自动轮换 / 手动选择，速度单位「次/分」(60=1Hz)，强度即行程比例。
    private func autoFreeplayBody(_ ctx: CmdContext) -> String {
        let now = nowMs()
        let freq = min(max(Double(simSpeed) / 60.0, 1.0 / 3.0), 3.0)
        let intensity = Double(min(max(simIntensity, 0.2), 1.0))
        let sel = simSelectedIndex
        let isRandom = sel >= SIM_PATTERN_COUNT
        let autoSwitch = simAutoSwitch || isRandom
        let dur = Double(min(max(simDuration, 1), 30))
        let trans = min(max(dur * 1000 / 4, 150), 800)

        let t = (now - patternStartMs) / 1000.0
        if autoSwitch && t >= dur {
            // 切换起点取旧图案在 t 时刻的采样（对齐安卓 fromTargets 语义），渐变才连续
            fromTargets = SimPattern.allCases[activeIdx].sample(t, freq, intensity)
            activeIdx = isRandom ? simRandomOther(activeIdx) : (activeIdx + 1) % SIM_PATTERN_COUNT
            patternStartMs = now
            transStartMs = now
        } else if !isRandom && sel != activeIdx {
            fromTargets = SimPattern.allCases[activeIdx].sample(t, freq, intensity)
            activeIdx = sel
            patternStartMs = now
            transStartMs = now
        }

        let tt = (now - patternStartMs) / 1000.0
        let desired = SimPattern.allCases[activeIdx].sample(tt, freq, intensity)
        let k = Float((now - transStartMs) / trans)
        let out: [String: Int]
        if k >= 1 {
            out = desired
        } else {
            var m: [String: Int] = [:]
            for (ax, v) in desired {
                let from = fromTargets[ax] ?? AXIS_VALUE_MAX / 2
                m[ax] = Int(Float(from) + Float(v - from) * k)
            }
            out = m
        }
        return dispatchTargets(ctx, out, 60)
    }

    private func simRandomOther(_ current: Int) -> Int {
        var n = Int.random(in: 0..<SIM_PATTERN_COUNT)
        if n == current && SIM_PATTERN_COUNT > 1 { n = (n + 1) % SIM_PATTERN_COUNT }
        return n
    }

    // MARK: - 生命周期

    /// 进后台：冻结时钟（iOS 必然挂起，不能假装还在跑）。
    /// 回前台：把锚点重设到「冻结时的位置」，避免用户看到位置突跳。
    private func observeLifecycle() {
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.didEnterBackgroundNotification,
                       object: nil, queue: .main) { [weak self] _ in
            guard let self = self else { return }
            let held = self.currentPlaybackMs()
            self.stopMotion(home: false)
            self.applyClock(playing: false, mediaMs: held)
            Diagnostics.shared.log("PLAYER", "进入后台：时钟冻结于 \(held)ms（iOS 无法后台驱动）")
        }
        nc.addObserver(forName: UIApplication.didBecomeActiveNotification,
                       object: nil, queue: .main) { [weak self] _ in
            guard let self = self else { return }
            Diagnostics.shared.log("PLAYER", "回到前台：时钟锚点 \(self.currentPlaybackMs())ms")
        }
    }
}

// MARK: - SimPattern（完整移植安卓 OsrManager.kt 的模拟动作库，Ayva Stroker Lite 的 Free Play）
//
// 按 t(秒)/freq(Hz)/intensity(0.2-1.0 行程比例) 采样返回 6 轴目标位置（0..9999，中位 5000）。
// ⚠ 波形公式、轴权重、渐变节奏必须与安卓逐字对齐 —— 两端不一致就是「iOS 不如安卓流畅」。

let SIM_PATTERN_COUNT = SimPattern.allCases.count

enum SimPattern: Int, CaseIterable {
    case constant = 0   // 匀速往返
    case swell = 1      // 渐强渐弱
    case rotation = 2   // 旋转摇摆
    case pulse = 3      // 脉冲
    case shake = 4      // 抖动
    case deep = 5       // 深度按压
    case vibe = 6       // 稳态振动

    var label: String {
        switch self {
        case .constant: return "匀速往返"
        case .swell: return "渐强渐弱"
        case .rotation: return "旋转摇摆"
        case .pulse: return "脉冲"
        case .shake: return "抖动"
        case .deep: return "深度按压"
        case .vibe: return "稳态振动"
        }
    }

    /// 强度 → 行程比例：钳在 0.2-1.0（行程固定 0..9999，超 1.0 会削顶贴死行程端，
    /// 观感反而「又慢又不连贯」——安卓注释原话）。
    static func travelRatio(_ intensity: Double) -> Double {
        min(max(intensity, 0.2), 1.0)
    }

    /// 三角波（值域 -1..1）。匀速往返必须用三角波：正弦是钟摆式（两端慢、中间快），
    /// 与「匀速」对不上，用户按 300% 拉满也只会觉得慢（安卓注释原话）。
    static func triangle(_ phase: Double) -> Double {
        // 与 Kotlin rem 语义一致（truncatingRemainder 可为负），先 %1 再 +1 再 %1
        let p = ((phase / (2 * Double.pi)).truncatingRemainder(dividingBy: 1) + 1)
            .truncatingRemainder(dividingBy: 1)
        return p < 0.5 ? 4.0 * p - 1.0 : 3.0 - 4.0 * p
    }

    func sample(_ t: Double, _ freq: Double, _ intensity: Double) -> [String: Int] {
        let c = AXIS_VALUE_MAX / 2
        let amp = Double(AXIS_VALUE_MAX / 2) * Self.travelRatio(intensity)
        let mid = ["L1": c, "L2": c, "R0": c, "R1": c, "R2": c]
        switch self {
        case .constant:
            let u = Self.triangle(2 * Double.pi * freq * t)
            return ["L0": c + Int(amp * u)].merging(mid) { _, new in new }
        case .swell:
            let env = sin(2 * Double.pi * freq * 0.5 * t) * 0.5 + 0.5
            let u = sin(2 * Double.pi * freq * t) * env
            return ["L0": c + Int(amp * u)].merging(mid) { _, new in new }
        case .rotation:
            let p = 2 * Double.pi * freq * t
            return [
                "R0": c + Int(amp * sin(p)),
                "R1": c + Int(amp * sin(p * 1.3 + Double.pi / 3)),
                "R2": c + Int(amp * sin(p * 0.7 + 2 * Double.pi / 3)),
                "L0": c + Int(amp * 0.3 * sin(p * 0.5)),
                "L1": c, "L2": c
            ]
        case .pulse:
            // 冲到底 → 退回中位 → 停一拍，一拍一个顿挫
            let p = (freq * t).truncatingRemainder(dividingBy: 1)
            let u: Double
            if p < 0.25 { u = (p / 0.25) * 2.0 - 1.0 }
            else if p < 0.5 { u = 1.0 - ((p - 0.25) / 0.25) * 2.0 }
            else { u = 0.0 }
            return ["L0": c + Int(amp * u)].merging(mid) { _, new in new }
        case .shake:
            // 主频 × 3 的小幅抖动，行程只有满幅的三成多
            let a = amp * 0.35
            let u = Self.triangle(2 * Double.pi * freq * 3.0 * t)
            return ["L0": c + Int(a * u)].merging(mid) { _, new in new }
        case .deep:
            // 慢速大幅、到底停留、慢速抽回
            let p = (freq * 0.5 * t).truncatingRemainder(dividingBy: 1)
            let u: Double
            if p < 0.35 { u = (p / 0.35) * 2.0 - 1.0 }
            else if p < 0.6 { u = 1.0 }
            else { u = 1.0 - ((p - 0.6) / 0.4) * 2.0 }
            return ["L0": c + Int(amp * u)].merging(mid) { _, new in new }
        case .vibe:
            // 中位附近持续小幅震动（维持设备唤醒）
            let a = amp * 0.12
            let u = Self.triangle(2 * Double.pi * freq * t)
            return ["L0": c + Int(a * u)].merging(mid) { _, new in new }
        }
    }
}
