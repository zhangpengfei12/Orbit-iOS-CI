import Foundation

/// 跨版本稳的整数钳制（部分 Swift 工具链 Int.clamped(to:) 不可用，统一走这个）。
func clamp(_ v: Int, _ lo: Int, _ hi: Int) -> Int { min(max(v, lo), hi) }

// MARK: - 常量（对齐安卓 OsrCore.kt）
//
// T-Code 编码 + 六轴路由 + 多轴合并 + 冲刺三角波的纯逻辑实现。
// 不依赖任何 Android Context / 硬件 / 网络，iOS 端 /api/osr/send、funscript*、
// dash-mode、single-axis-fill 等端点（M2 设备链路）直接复用本文件。

let AXIS_VALUE_MAX = 9999
let AXIS_AMPLITUDE_MAX = 300

let AXIS_NAMES = ["L0", "L1", "L2", "R0", "R1", "R2"]
let ROTATION_AXES = ["R0", "R1", "R2"]
let ROUTE_SOURCE_AXES = ["L0", "L1", "L2", "R0", "R1", "R2"]

let UNITS_PER_TURN = 10000
let SPIN_RPM_MIN = 3
let SPIN_RPM_MAX = 600
let SWEEP_CPM_MIN = 2
let SWEEP_CPM_MAX = 300
let SWEEP_RANGES = [45, 90, 135, 180, 270, 360]
let SPIN_TICK_MS: Int64 = 250

/// 按当前播放位置连续重采样时，每个指令的缓动时长（ms），与同步循环 delay 对齐。
let RESAMPLE_MS: Int64 = 40

/// 轴别名 → 标准轴名。必须与 Orbit 自身轴标签保持一致
/// （L0上下 Stroke / L1前后 Surge / L2左右 Sway / R0旋转 Twist / R1俯仰 Roll / R2翻滚 Pitch）。
/// 注意：必须 internal（非 private），FunScript.swift 的轴识别也要用。
let AXIS_ALIASES: [String: String] = [
    "stroke": "L0", "linear": "L0", "up": "L0", "updown": "L0", "main": "L0", "default": "L0",
    "surge": "L1", "forward": "L1", "in": "L1", "out": "L1",
    "sway": "L2", "side": "L2", "lateral": "L2", "left": "L2", "right": "L2",
    "twist": "R0", "rotate": "R0", "rotation": "R0", "yaw": "R0",
    "roll": "R1", "tilt": "R1", "lean": "R1",
    "pitch": "R2", "nod": "R2",
    "vib": "V0", "vibrate": "V0", "vibration": "V0", "speed": "V0",
    "valve": "V0", "suck": "V0", "air": "V0"
]

// MARK: - 枚举 / 配置

enum SendProtocol {
    case auto, tcode, custom
    var displayName: String {
        switch self {
        case .auto: return "自动"
        case .tcode: return "TCode"
        case .custom: return "自定义 0-100"
        }
    }
}

enum RotationMode {
    case follow, reverse, sweep, spin
    var displayName: String {
        switch self {
        case .follow: return "跟随源轴"
        case .reverse: return "反向"
        case .sweep: return "往复摆动"
        case .spin: return "连续旋转"
        }
    }
}

struct AxisParamConfig {
    var reversed: Bool = false
    var min: Int = 0
    var max: Int = AXIS_VALUE_MAX
    var amplitude: Int = 100
}

struct AxisRoute {
    var enabled: Bool = false
    var source: String = "L0"
    var mode: RotationMode = .follow
    var amplitude: Int = 100    // 0–300
    var speed: Int = 60         // SPIN: 转/分；SWEEP: 往返/分
    var sweepRange: Int = 180   // SWEEP: 摆幅（度）
    var reversed: Bool = false
}

/// 指令构造上下文：把配置一次性传入纯函数，去掉对 Android Context 的依赖。
struct CmdContext {
    var sendProtocol: SendProtocol = .auto
    var newline: Bool = false
    var axisParams: [String: AxisParamConfig] = [:]
    var routes: [String: AxisRoute] = [:]
    var prefix: String = ""
    var suffix: String = ""
    var tcodeVersion: String = "V3"

    /// CUSTOM 协议最终也走 0–100 文本分支，这里统一收敛。
    var effectiveProtocol: SendProtocol {
        return (sendProtocol == .custom) ? .custom : .tcode
    }
    var useTcodeV2: Bool {
        return tcodeVersion.compare("V2", options: .caseInsensitive) == .orderedSame
    }
}

// MARK: - 位置映射 / 幅度缩放

/// 按幅度百分比以行程中点为中心缩放输出值（0–9999）。
func scaleByAmplitude(_ value: Int, _ amplitudePercent: Int) -> Int {
    if amplitudePercent == 100 { return value }
    let center = AXIS_VALUE_MAX / 2
    return clamp(center + (value - center) * amplitudePercent / 100, 0, AXIS_VALUE_MAX)
}

/// 把脚本位置（0–100）换算为设备输出值（0–9999）。
/// 次序：归一化 → 反转 → [min,max] 线性映射 → 幅度缩放 → 收敛 0–9999。
func mapAxisPositionToOutput(_ pos: Int, _ cfg: AxisParamConfig) -> Int {
    var v = clamp(pos, 0, 100) * AXIS_VALUE_MAX / 100
    if cfg.reversed { v = 10000 - v }
    let span = max(cfg.max - cfg.min, 0)
    v = v * span / 10000 + cfg.min
    if cfg.amplitude != 100 {
        let center = (cfg.min + cfg.max) / 2
        v = center + (v - center) * cfg.amplitude / 100
    }
    return clamp(v, 0, AXIS_VALUE_MAX)
}

// MARK: - 指令拼接

/// 单条轴指令拼接。
func appendAxisCommand(_ sb: inout String, _ axisId: String, _ outValue: Int, _ durationMs: Int64, _ cfg: AxisParamConfig, _ ctx: CmdContext) {
    if ctx.effectiveProtocol == .tcode {
        if ctx.useTcodeV2 {
            // T-Code v2：轴 + 4 位位置 + 换行；设备固件普遍不认带 I 参数的 v3
            sb.append(axisId)
            sb.append(String(format: "%04d", Int32(outValue)))
            if ctx.newline { sb.append("\n") }
        } else {
            // T-Code v3：轴 + 4 位位置 + I<间隔 ms> + 分号 + 换行
            sb.append(axisId)
            sb.append(String(format: "%04d", Int32(outValue)))
            sb.append("I")
            sb.append(String(durationMs))
            sb.append(";")
            if ctx.newline { sb.append("\n") }
        }
    } else {
        // 自定义协议：轴 + 百分比 + I<间隔 ms>（不带分号）
        let span = max(cfg.max - cfg.min, 1)
        let pct = clamp((outValue - cfg.min) * 100 / span, 0, 100)
        sb.append(axisId)
        sb.append(String(pct))
        sb.append("I")
        sb.append(String(durationMs))
    }
}

/// 把某轴送到指定位置（0–9999 空间）的指令。
func buildAxisPosCommand(_ ctx: CmdContext, _ axisId: String, _ pos: Int, _ durationMs: Int64) -> String {
    var sb = ""
    appendAxisCommand(&sb, axisId, clamp(pos, 0, AXIS_VALUE_MAX), durationMs, AxisParamConfig(), ctx)
    return sb
}

/// 把多个轴一次送到各自位置的指令（T-Code 多轴协议，如 R01234\nR11234\n）。
func buildAxesPosCommand(_ ctx: CmdContext, _ entries: [(String, Int)], _ durationMs: Int64) -> String {
    var sb = ""
    for (axisId, pos) in entries {
        appendAxisCommand(&sb, axisId, clamp(pos, 0, AXIS_VALUE_MAX), durationMs, AxisParamConfig(), ctx)
        // 多轴必须逐行分隔：无条件补且不会重复补（末尾已是换行时跳过），
        // 否则会粘成 R050R150 被固件整包丢弃。
        if !sb.isEmpty && sb.last != "\n" { sb.append("\n") }
    }
    return sb
}

/// 把某轴送到中位（5000 = 行程中点，归零归位）。
func buildAxisCenterCommand(_ ctx: CmdContext, _ axisId: String, _ durationMs: Int64) -> String {
    return buildAxisPosCommand(ctx, axisId, AXIS_VALUE_MAX / 2, durationMs)
}

/// 生成「本次真正需要下发」的轴指令（连续重采样，非边沿触发）：
/// sentTargets 记录每轴已下发到的目标时间点，同一目标点不会重复下发。
func buildAxisCommandsFromFunscript(_ ctx: CmdContext, _ script: FunscriptData, _ currentPositionMs: Int64) -> String {
    let routes = ctx.routes.filter { $0.value.enabled && ($0.value.mode == .follow || $0.value.mode == .reverse) }
    let scriptAxisIds = Set(script.axes.map { $0.id })
    var sb = ""
    // 循环重放：播放位置超过脚本末尾时从开头重播（后台自驱时钟会一直走，否则过末尾就停在一个动作上）
    let loopEndMs = script.axes.map { $0.actions.last?.at ?? 0 }.max() ?? 0
    let posMs = (loopEndMs > 0 && currentPositionMs > loopEndMs) ? (currentPositionMs % loopEndMs) : currentPositionMs
    for axis in script.axes {
        // 连续重采样：按当前时钟插值出确切位置，设备按 RESAMPLE_MS 缓动到该位置。
        let pos = interpPosAt(axis.actions, posMs)
        let cfg = ctx.axisParams[axis.id] ?? AxisParamConfig()
        let outValue = mapAxisPositionToOutput(pos, cfg)
        appendAxisCommand(&sb, axis.id, outValue, RESAMPLE_MS, cfg, ctx)

        // 旋转轴派生：把本轴位置同步到 R0/R1/R2（同样连续下发）
        for (routeTarget, route) in routes {
            if route.source != axis.id { continue }
            if scriptAxisIds.contains(routeTarget) { continue }
            let base: Int = (route.mode == .reverse) ? (AXIS_VALUE_MAX - outValue) : outValue
            let targetCfg = ctx.axisParams[routeTarget] ?? AxisParamConfig()
            let pct = clamp(base * 100 / AXIS_VALUE_MAX, 0, 100)
            let routed = scaleByAmplitude(mapAxisPositionToOutput(pct, targetCfg), route.amplitude)
            appendAxisCommand(&sb, routeTarget, routed, RESAMPLE_MS, targetCfg, ctx)
        }
    }
    return sb
}

/// 旋转指令（连续旋转 / 往复摆动），仅在播放态推进 elapsedMs。
func buildRotationCommands(_ ctx: CmdContext, _ elapsedMs: Int64, _ spinAngles: inout [String: Int], _ sweepPhases: inout [String: Float]) -> String {
    var sb = ""
    for target in ROTATION_AXES {
        guard let route = ctx.routes[target], route.enabled else { continue }
        if route.mode != .spin && route.mode != .sweep { continue }
        let rawAngle: Int
        switch route.mode {
        case .spin:
            let perMs = Double(route.speed) * Double(UNITS_PER_TURN) / 60000.0
            let delta = Int64(perMs * Double(elapsedMs)) * (route.reversed ? -1 : 1)
            let prev = Int64(spinAngles[target] ?? 0)
            let next = ((prev + delta) % Int64(UNITS_PER_TURN) + Int64(UNITS_PER_TURN)) % Int64(UNITS_PER_TURN)
            spinAngles[target] = Int(next)
            rawAngle = Int(next)
        case .sweep:
            var phase = (sweepPhases[target] ?? 0) + Float(elapsedMs) * Float(route.speed) / 60000.0
            phase = phase.truncatingRemainder(dividingBy: 1)
            if phase < 0 { phase += 1 }
            sweepPhases[target] = phase
            let tri: Float = (phase < 0.5) ? phase * 2 : 2 - phase * 2
            let p: Float = route.reversed ? (1 - tri) : tri
            let half = (Float(UNITS_PER_TURN) * Float(route.sweepRange) / 360) / 2
            let center = Float(AXIS_VALUE_MAX) / 2
            rawAngle = clamp(Int(center + (p - 0.5) * 2 * half), 0, AXIS_VALUE_MAX)
        default:
            continue
        }
        let cfg = ctx.axisParams[target] ?? AxisParamConfig()
        let pct = clamp(rawAngle * 100 / AXIS_VALUE_MAX, 0, 100)
        let outValue = scaleByAmplitude(mapAxisPositionToOutput(pct, cfg), route.amplitude)
        appendAxisCommand(&sb, target, outValue, elapsedMs, cfg, ctx)
    }
    return sb
}

/// 「独立冲刺」指令（v2.7.28）：完全不依赖脚本动作点，按真实时钟给指定轴生成一组
/// 满行程三角波往复（0 → 满行程 → 0 循环）。
///
/// @param elapsedMs 距上次推进的增量（ms），传累计值会让相位二次增长、越冲越快。
/// @param phaseStore 相位存储（key = 轴名），跨帧保持连续；调用方必须保证不被别处清空。
/// @param speedPerMin 每分钟往复次数（三角波一个完整来回算一次）。
/// @param amplitude 行程幅度（百分比 1-300），100 = 满行程。
func buildDashSweepCommand(_ ctx: CmdContext, _ axisId: String, _ elapsedMs: Int64, _ phaseStore: inout [String: Float], _ speedPerMin: Float, _ amplitude: Int) -> String {
    var phase = (phaseStore[axisId] ?? 0) + Float(elapsedMs) * speedPerMin / 60000.0
    if phase > 1 { phase = phase.truncatingRemainder(dividingBy: 1) }
    if phase < 0 { phase += 1 }
    phaseStore[axisId] = phase
    // 三角波：前半相位 0→1（升到满行程），后半相位 1→0（回落）
    let tri: Float = (phase < 0.5) ? phase * 2 : 2 - phase * 2
    let cfg = ctx.axisParams[axisId] ?? AxisParamConfig()
    let pct = clamp(Int(tri * 100), 0, 100)
    let outValue = scaleByAmplitude(mapAxisPositionToOutput(pct, cfg), amplitude)
    var sb = ""
    appendAxisCommand(&sb, axisId, clamp(outValue, 0, AXIS_VALUE_MAX), RESAMPLE_MS, cfg, ctx)
    return sb
}

/// 连接测试指令（按协议分别给 L0/R2 一组示例动作）。
func buildTestCommand(_ ctx: CmdContext) -> String {
    var sb = ""
    if ctx.effectiveProtocol == .tcode {
        // 先 L0=0，再 L0=9999，确保从任意位置都有大幅位移
        sb.append(buildAxisPosCommand(ctx, "L0", 0, 1000))
        sb.append(buildAxisPosCommand(ctx, "L0", AXIS_VALUE_MAX, 1000))
    } else {
        // 自定义协议：保留原样给每个轴一个中位示例
        for axis in AXIS_NAMES {
            sb.append(buildAxisPosCommand(ctx, axis, AXIS_VALUE_MAX / 2, 800))
        }
    }
    return sb
}
