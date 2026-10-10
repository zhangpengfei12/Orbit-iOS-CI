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
    private var autoMode: String = ""      // "" | "sine" | "random" | "freeplay"
    private var autoIntensity: Float = 0.6
    private var autoSpeed: Float = 50
    private var autoDuration: Float = 0.3
    private var sinePhase: Float = 0
    private var randomPhase: Float = 0

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

    /// 自动模式：sine / random / freeplay / stop。
    /// iOS 上做简化实现——三角/正弦波驱动 L0，参数沿用安卓字段，够覆盖「设备页自动档」。
    func setAutoMode(_ mode: String, intensity: Float, speed: Float, duration: Float) {
        lock.lock()
        autoMode = mode
        autoIntensity = intensity
        autoSpeed = speed
        autoDuration = duration > 0 ? duration : 0.3
        lock.unlock()
        if mode == "stop" {
            stopLoop()
            applyClock(playing: false, mediaMs: currentPlaybackMs())
        } else {
            startLoop()
        }
    }

    func stopMotion() {
        lock.lock()
        autoMode = ""
        dashOn = false
        dashPhases.removeAll()
        lock.unlock()
        stopLoop()
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
        let aSpeed = autoSpeed
        let aDur = autoDuration
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

        // ③ 自动模式（无脚本时也能让设备动起来）
        if !mode.isEmpty && mode != "stop" && !dash {
            body += autoCommand(ctx, mode: mode, elapsed: elapsed,
                                intensity: intensity, speed: aSpeed, duration: aDur)
        }

        // ④ 旋转 / 摆动：只在播放态推进相位
        if pl || !mode.isEmpty {
            body += buildRotationCommands(ctx, elapsed, &spinAngles, &sweepPhases)
        }

        guard !body.isEmpty else { return }
        let full = ctx.prefix + body + ctx.suffix
        OsrLink.dispatch(full)
    }

    /// 自动模式指令：正弦 / 随机 / 自由发挥统一用「L0 三角波 + 强度缩放」生成。
    private func autoCommand(_ ctx: CmdContext, mode: String, elapsed: Int64,
                             intensity: Float, speed: Float, duration: Float) -> String {
        var phase: Float
        switch mode {
        case "sine":
            sinePhase += Float(elapsed) * max(speed, 1) / 60000.0
            if sinePhase > 1 { sinePhase -= 1 }
            phase = sinePhase
        case "random":
            // 伪随机：相位按速度推进后取正弦叠加，避免真正随机导致的跳变伤设备
            randomPhase += Float(elapsed) * max(speed, 1) / 60000.0
            if randomPhase > 1 { randomPhase -= 1 }
            phase = (randomPhase + 0.33).truncatingRemainder(dividingBy: 1)
        default: // freeplay
            sinePhase += Float(elapsed) / max(duration * 1000, 1)
            if sinePhase > 1 { sinePhase -= 1 }
            phase = sinePhase
        }
        let tri: Float = (phase < 0.5) ? phase * 2 : 2 - phase * 2
        let cfg = ctx.axisParams["L0"] ?? AxisParamConfig()
        let pct = clamp(Int(tri * intensity * 100), 0, 100)
        let out = scaleByAmplitude(mapAxisPositionToOutput(pct, cfg), 100)
        var sb = ""
        appendAxisCommand(&sb, "L0", out, RESAMPLE_MS, cfg, ctx)
        return sb
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
            self.stopMotion()
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
