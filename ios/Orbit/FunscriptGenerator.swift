import Foundation
import AVFoundation

// MARK: - iOS 本地脚本生成（对齐安卓 osr/ScriptRecorder.kt 的「无脚本自动生成」）
//
// 完整管线：解码本地视频 → 音频包络 + 画面运动幅度 → StrokeSynth 混合合成 →
// 写出与视频同名的 .funscript（落 App 沙盒媒体库，下次打开直接命中）。
//
// 仅对 App 沙盒（Documents/Media）内的**本地视频**生效；SMB 共享视频读不了 smb://，不支持。
// 前端 player.js 的自动生成状态机（ensureScriptLoaded → startAutoGenerate → pollGenStatus →
// applyGenDone）已经就绪，只等后端把 canGenerate 翻成 true 并补齐 gen 端点即可闭环。
//
// ⚠ 全部跑在后台串行队列，生成期间 App 在前台即可；带进度上报与取消。
// ⚠ 本机无法编译 iOS（Windows 无 Xcode），代码经 CI / 真机实测纠偏；AVFoundation 解码与
//   运动估计算法已尽量贴合安卓，运动质量可能仍需在真机上微调灵敏度。

private enum GenPhase {
    case running, done, failed, cancelled
}

private struct GenTask {
    let id: Int
    let videoRel: String
    var cancelled: Bool
    var percent: Int
    var phase: GenPhase
    var error: String?
    var duration: Double
    var points: [[String: Any]]?
    var outName: String?
}

// MARK: - 生成选项（对齐安卓 RecordOptions 里参与合成的那几个字段）

private struct RecordOptions {
    var fps: Int = 10
    var maxHz: Float = 4
    var sensitivity: Float = 1.8
    var smooth: Float = 0.25
    var minPos: Int = 5
    var maxPos: Int = 95
    var offsetMs: Int = 0
}

private struct GenAxis {
    let id: String
    let actions: [FunscriptAction]
}

// MARK: - 任务管理器（start / status / cancel）

final class FunscriptGenerator {

    static let shared = FunscriptGenerator()

    private let queue = DispatchQueue(label: "orbit.funscript.gen", qos: .userInitiated)
    private let lock = NSLock()
    private var task: GenTask?
    private var seq: Int = 0

    private init() {}

    // MARK: 对外

    /// 启动一次生成。已在跑且未取消 → 返回 already_running（busyId = 当前视频 key）。
    func start(videoRel: String) -> (ok: Bool, busyId: String?, error: String?) {
        lock.lock()
        if let t = task, t.phase == .running, !t.cancelled {
            lock.unlock()
            return (false, t.videoRel, nil)
        }
        seq += 1
        let t = GenTask(id: seq, videoRel: videoRel, cancelled: false, percent: 0,
                        phase: .running, error: nil, duration: 0, points: nil, outName: nil)
        task = t
        lock.unlock()
        Diagnostics.shared.log("GEN", "启动脚本生成：\(videoRel)")
        queue.async { [weak self] in self?.run(videoRel: videoRel, id: t.id) }
        return (true, nil, nil)
    }

    func status() -> [String: Any] {
        lock.lock(); let t = task; lock.unlock()
        guard let t = t else {
            return ["ok": false, "running": false, "phase": "idle"]
        }
        switch t.phase {
        case .done:
            return ["ok": true, "running": false, "phase": "done", "percent": 100,
                    "duration": t.duration, "points": t.points ?? [], "name": t.outName ?? ""]
        case .failed:
            return ["ok": false, "running": false, "phase": "failed",
                    "error": t.error ?? "生成失败"]
        case .cancelled:
            return ["ok": false, "running": false, "phase": "cancelled"]
        case .running:
            return ["ok": true, "running": true, "percent": t.percent, "phase": "running"]
        }
    }

    func cancel() {
        lock.lock()
        if var t = task, t.phase == .running { t.cancelled = true; task = t }
        lock.unlock()
    }

    // MARK: 状态写入（持锁）

    private func fail(id: Int, msg: String) {
        lock.lock()
        if var t = task, t.id == id { t.phase = .failed; t.error = msg; t.percent = 100; task = t }
        lock.unlock()
    }

    private func done(id: Int, outName: String, duration: Double, points: [[String: Any]]) {
        lock.lock()
        if var t = task, t.id == id {
            t.phase = .done; t.percent = 100; t.outName = outName; t.duration = duration; t.points = points; task = t
        }
        lock.unlock()
    }

    private func setPct(id: Int, _ pct: Int) {
        lock.lock()
        if var t = task, t.id == id { t.percent = min(99, max(t.percent, pct)); task = t }
        lock.unlock()
    }

    private func isCancelled(id: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return task?.id == id ? (task?.cancelled ?? false) : false
    }

    // MARK: 主流程

    private func run(videoRel: String, id: Int) {
        guard let videoURL = MediaStore.shared.resolve(videoRel) else {
            fail(id: id, msg: "找不到视频文件"); return
        }
        let result = generate(videoRel: videoRel, videoURL: videoURL, id: id)
        switch result {
        case .failure(let e):
            fail(id: id, msg: e.localizedDescription)
        case .success(let outName, let duration, let points):
            done(id: id, outName: outName, duration: duration, points: points)
        }
    }

    private func generate(videoRel: String, videoURL: URL, id: Int)
        -> Result<(outName: String, duration: Double, points: [[String: Any]]), Error> {
        let asset = AVAsset(url: videoURL)
        let durationSec = CMTimeGetSeconds(asset.duration)
        guard durationSec.isFinite, durationSec > 0 else {
            return .failure(NSError(domain: "Orbit", code: -1, userInfo: [NSLocalizedDescriptionKey: "读不到视频时长，可能不是有效视频文件"]))
        }
        // 生成上限：最长 30 分钟（长片没必要整段分析，且解码耗时随长度线性增长）。
        let limitMs = Int64(min(durationSec, 30 * 60) * 1000)
        let hopMs = 50
        let n = max(4, Int(limitMs) / hopMs)

        let hasAudio = !asset.tracks(withMediaType: .audio).isEmpty
        let hasVideo = !asset.tracks(withMediaType: .video).isEmpty
        guard hasAudio || hasVideo else {
            return .failure(NSError(domain: "Orbit", code: -2, userInfo: [NSLocalizedDescriptionKey: "该视频既无音轨也无画面"]))
        }

        // ① 音频包络
        setPct(id: id, 3)
        let audio: [Float]
        if hasAudio, let a = decodeAudio(asset: asset, limitMs: limitMs, hopMs: hopMs, n: n, id: id) {
            audio = a
        } else {
            audio = [Float](repeating: 0, count: n)
        }
        if isCancelled(id: id) {
            return .failure(NSError(domain: "Orbit", code: -3, userInfo: [NSLocalizedDescriptionKey: "已取消"]))
        }

        // ② 画面运动幅度（与上一帧的 luma 网格差）
        setPct(id: id, 40)
        let motion: [Float]
        if hasVideo, let m = decodeVideo(asset: asset, limitMs: limitMs, fps: 10, hopMs: hopMs, n: n, id: id) {
            motion = m
        } else {
            motion = [Float](repeating: 0, count: n)
        }
        if isCancelled(id: id) {
            return .failure(NSError(domain: "Orbit", code: -3, userInfo: [NSLocalizedDescriptionKey: "已取消"]))
        }

        let aN = hasAudio ? SignalAnalysis.robustNorm(audio) : [Float](repeating: 0, count: n)
        let mN = hasVideo ? SignalAnalysis.robustNorm(motion) : [Float](repeating: 0, count: n)
        let hasAudioSig = hasAudio && audio.contains(where: { $0 > 1e-4 })
        let hasMotionSig = hasVideo && (motion.max() ?? 0) > 1e-4
        guard hasAudioSig || hasMotionSig else {
            return .failure(NSError(domain: "Orbit", code: -4, userInfo: [NSLocalizedDescriptionKey: "该视频既无可用音轨也无画面运动，无法生成"]))
        }

        // ③ 合成
        setPct(id: id, 90)
        let opt = RecordOptions(smooth: 0.25, minPos: 5, maxPos: 95)
        let res = StrokeSynth.synthesize(audio: aN, motion: mN, hasAudio: hasAudioSig,
                                         hasMotion: hasMotionSig, n: n, hopMs: hopMs, opt: opt)
        guard !res.axes.isEmpty else {
            return .failure(NSError(domain: "Orbit", code: -5, userInfo: [NSLocalizedDescriptionKey: "未检测到有效笔触（可能全程静止）"]))
        }

        // ④ 落盘：<视频基名>.funscript 写到视频同目录
        let base = videoURL.deletingPathExtension().lastPathComponent
        let outName = base + ".funscript"
        let outURL = videoURL.deletingLastPathComponent().appendingPathComponent(outName)
        let note = "本地视频自动生成：音频能量驱动幅度，画面运动驱动时机"
        let text = StrokeSynth.buildFunscriptJson(durationMs: limitMs, axes: res.axes, note: note)
        if !text.isEmpty {
            do {
                try text.write(to: outURL, atomically: true, encoding: .utf8)
                Diagnostics.shared.log("GEN", "脚本已写出：\(outName)")
            } catch {
                Diagnostics.shared.log("GEN", "写脚本失败：\(error.localizedDescription)")
            }
        }

        // 兜底 points：前端 applyGenDone 读不回文件时直接注入（不经文件）
        let points: [[String: Any]] = res.axes.first(where: { $0.id == "L0" })?.actions.map {
            ["at": $0.at, "pos": $0.pos]
        } ?? []

        setPct(id: id, 96)
        return .success((outName, Double(limitMs) / 1000.0, points))
    }

    // MARK: - 音频解码：PCM → 每 hop 窗口 RMS 包络

    private func decodeAudio(asset: AVAsset, limitMs: Int64, hopMs: Int, n: Int, id: Int) -> [Float]? {
        guard let track = asset.tracks(withMediaType: .audio).first else { return nil }
        guard let reader = try? AVAssetReader(asset: asset) else { return nil }
        let sampleRate: Double = 44100
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false
        ])
        guard reader.canAdd(output) else { return nil }
        reader.add(output)
        guard reader.startReading() else { return nil }

        let hopSamples = max(1, Int(sampleRate * Double(hopMs) / 1000.0))
        var out = [Float](repeating: 0, count: n)
        var sum: Double = 0
        var cnt: Int = 0
        var hop: Int = 0

        while reader.status == .reading, hop < n {
            if isCancelled(id: id) { reader.cancelReading(); return nil }
            guard let sample = output.copyNextSampleBuffer() else { break }
            if let blockBuffer = CMSampleBufferGetDataBuffer(sample) {
                let length = CMBlockBufferGetDataLength(blockBuffer)
                if length > 0 {
                    var data = Data(count: length)
                    data.withUnsafeMutableBytes { raw in
                        guard let base = raw.baseAddress else { return }
                        _ = CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: length, destination: base)
                        let typed = raw.bindMemory(to: Int16.self)
                        for i in 0..<typed.count {
                            let v = Double(typed[i]) / 32768.0
                            sum += v * v
                            cnt += 1
                            if cnt >= hopSamples {
                                out[hop] = Float(sqrt(sum / Double(cnt)))
                                hop += 1; sum = 0; cnt = 0
                                if hop >= n { break }
                            }
                        }
                    }
                }
            }
        }
        return out
    }

    // MARK: - 视频解码：逐帧 luma 网格差 → 运动幅度（对齐安卓的 mags）

    private func decodeVideo(asset: AVAsset, limitMs: Int64, fps: Int, hopMs: Int, n: Int, id: Int) -> [Float]? {
        guard asset.tracks(withMediaType: .video).first != nil else { return nil }
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero

        let GW = 32, GH = 18
        let maxFrames = 6000
        var stepMs = 1000.0 / Double(max(2, min(20, fps)))
        // 长视频自动降采样，保证帧数有界（resampleToHop 仍会插值回 20Hz 网格）
        if Double(limitMs) / stepMs > Double(maxFrames) {
            stepMs = Double(limitMs) / Double(maxFrames)
        }

        var magTimes: [Int64] = []
        var mags: [Float] = []
        var prev: [Float]? = nil
        var t = 0.0
        while t <= Double(limitMs) {
            if isCancelled(id: id) { return nil }
            let cmt = CMTime(seconds: t / 1000.0, preferredTimescale: 1000)
            var actual = CMTime.zero
            guard let cg = try? generator.copyCGImage(at: cmt, actualTime: &actual) else {
                t += stepMs; continue
            }
            let grid = lumaGrid(cg, gw: GW, gh: GH)
            if let p = prev {
                var s: Float = 0
                for k in 0..<GW * GH { s += abs(grid[k] - p[k]) }
                mags.append(s / Float(GW * GH) / 255.0)
                magTimes.append(Int64(CMTimeGetSeconds(actual) * 1000))
            }
            prev = grid
            let idx = magTimes.count
            if idx % 20 == 0 {
                let pct = 40 + min(45, Int(Double(idx) / max(1.0, Double(limitMs) / stepMs) * 45.0))
                setPct(id: id, pct)
            }
            t += stepMs
        }
        guard mags.count >= 4 else { return nil }
        return resampleToHop(times: magTimes, vals: mags, hopMs: hopMs, n: n)
    }

    /// 把 CGImage 缩到 GW×GH 灰度网格，返回每格亮度 0–255。
    private func lumaGrid(_ cg: CGImage, gw: Int, gh: Int) -> [Float] {
        guard let context = CGContext(data: nil, width: gw, height: gh, bitsPerComponent: 8,
                                      bytesPerRow: gw, space: CGColorSpaceCreateDeviceGray(),
                                      bitmapInfo: CGImageAlphaInfo.none.rawValue) else {
            return [Float](repeating: 0, count: gw * gh)
        }
        context.draw(cg, in: CGRect(x: 0, y: 0, width: gw, height: gh))
        guard let data = context.data else { return [Float](repeating: 0, count: gw * gh) }
        let ptr = data.bindMemory(to: UInt8.self, capacity: gw * gh)
        var out = [Float](repeating: 0, count: gw * gh)
        for i in 0..<gw * gh { out[i] = Float(ptr[i]) }
        return out
    }

    /// 把 (time, value) 采样点线性插值到等间隔 50ms hop 网格。
    private func resampleToHop(times: [Int64], vals: [Float], hopMs: Int, n: Int) -> [Float] {
        var out = [Float](repeating: 0, count: n)
        let cnt = vals.count
        guard cnt > 0 else { return out }
        var j = 0
        for i in 0..<n {
            let t = Int64(i) * Int64(hopMs)
            while j + 1 < cnt && times[j + 1] <= t { j += 1 }
            if j + 1 < cnt {
                let t0 = Double(times[j]), t1 = Double(times[j + 1])
                let f = t1 > t0 ? Float((Double(t) - t0) / (t1 - t0)) : 0
                out[i] = vals[j] + (vals[j + 1] - vals[j]) * min(1, max(0, f))
            } else {
                out[i] = vals[cnt - 1]
            }
        }
        return out
    }
}

// MARK: - StrokeSynth（对齐安卓 ScriptRecorder.kt 的纯逻辑合成，零依赖）

private enum StrokeSynth {

    static let DEFAULT_HOP_MS = 50
    static let REST_THRESHOLD: Float = 0.10
    static let MOTION_FLOOR: Float = 0.004

    /// 混合流笔触合成：返回若干轴（默认仅 L0，multiAxis 留作扩展）。
    static func synthesize(audio aN: [Float], motion mN: [Float], hasAudio: Bool, hasMotion: Bool,
                           n: Int, hopMs: Int, opt: RecordOptions)
        -> (axes: [GenAxis], strokes: Int, hz: Float) {
        if n < 4 { return ([], 0, 0) }
        let minGap = max(1, Int(round(Float(1000) / opt.maxHz / Float(hopMs))))

        // ① 强度（力度）：音频低频能量为主、画面运动幅度为辅（自适应权重）
        let drive = (0..<n).map { i -> Float in
            let v: Float
            switch (hasAudio, hasMotion) {
            case (true, true):
                let da = SignalAnalysis.dynRange(aN)
                let dm = SignalAnalysis.dynRange(mN)
                let wAudio = min(0.76, max(0.40, 0.58 + 0.44 * (da - dm)))
                v = wAudio * aN[i] + (1 - wAudio) * mN[i]
            case (true, false): v = aN[i]
            case (false, true): v = mN[i]
            default: v = 0
            }
            return min(1, max(0, v * opt.sensitivity))
        }

        // ② 起始点（时机）：音频 novelty 为主，运动 novelty 补齐
        var bounds: [Int] = [0]
        let audioNov = SignalAnalysis.novelty(aN, win: max(1, 250 / hopMs))
        for p in SignalAnalysis.pickPeaks(audioNov, thr: SignalAnalysis.threshold(audioNov, 0.30), minGap: minGap)
            where p > 0 { bounds.append(p) }
        if hasMotion {
            let visNov = SignalAnalysis.novelty(mN, win: max(1, 350 / hopMs))
            let visGap = max(minGap, Int(round(Float(1000) / (opt.maxHz * 0.55) / Float(hopMs))))
            for p in SignalAnalysis.pickPeaks(visNov, thr: SignalAnalysis.threshold(visNov, 0.34), minGap: visGap) {
                if p > 0 && !bounds.contains(where: { abs($0 - p) < minGap }) { bounds.append(p) }
            }
        }
        bounds.sort()

        // ③ 每段笔触的原始幅度
        let segCount = bounds.count
        var amp = [Float](repeating: 0, count: segCount)
        for k in 0..<segCount {
            let s = bounds[k]
            let e = segEnd(bounds, k, n)
            if e <= s { continue }
            var avg: Float = 0, peak: Float = 0
            for i in s..<e { avg += drive[i]; if drive[i] > peak { peak = drive[i] } }
            avg /= Float(e - s)
            amp[k] = min(1, max(0, 0.45 * avg + 0.55 * peak))
        }

        // ④ 后处理：平滑（EMA）→ 收敛到 p95
        let alpha = min(1, max(0.12, 1 - opt.smooth * 0.85))
        var ema = amp[0]
        for k in 0..<segCount { ema += (amp[k] - ema) * alpha; amp[k] = ema }
        let cap = max(0.05, SignalAnalysis.percentile(amp, 0.95) * 1.15)
        for k in 0..<segCount { amp[k] = min(cap, max(0, amp[k])) }

        // ⑤ 合成 L0（含 FunscriptPost 后处理）
        let mid = Float((opt.minPos + opt.maxPos) / 2)
        let span = Float(opt.maxPos - opt.minPos)
        let l0raw = buildAxis(bounds: bounds, amp: amp, n: n, hopMs: hopMs, mid: mid, span: span, opt: opt)
        let l0 = FunscriptPost.run(l0raw, opt: ScriptPostOptions(smooth: opt.smooth, minPos: opt.minPos, maxPos: opt.maxPos))
        var axes: [GenAxis] = []
        if isUsable(l0) { axes.append(GenAxis(id: "L0", actions: l0)) }
        if axes.isEmpty { return ([], 0, 0) }

        let strokes = axes[0].actions.count
        let durSec = Float(n) * Float(hopMs) / 1000.0
        let hz = durSec > 0 ? Float(strokes) / durSec : 0
        return (axes, strokes, hz)
    }

    /// 一段一个动作：每段只发「起点」位置，相邻段按极性交替取高/低端（等价三角波往返）。
    static func buildAxis(bounds: [Int], amp: [Float], n: Int, hopMs: Int, mid: Float, span: Float, opt: RecordOptions) -> [FunscriptAction] {
        var out: [FunscriptAction] = []
        var phase = 1
        var lastPos = Int(mid.rounded())
        for k in 0..<bounds.count {
            let t = Int64(bounds[k]) * Int64(hopMs)
            let a = amp[k]
            let pos: Int
            if a < REST_THRESHOLD {
                pos = Int(mid.rounded()); phase = 1
            } else {
                let half = (span / 2) * (0.22 + 0.78 * a)
                let hi = Int((mid + half).rounded())
                let lo = Int((mid - half).rounded())
                pos = phase > 0 ? hi : lo
                phase = -phase
            }
            if let last = out.last, last.pos == pos { continue }
            out.append(FunscriptAction(at: Int64(t), pos: pos))
            lastPos = pos
        }
        if out.isEmpty { return out }
        // 末尾补一个动作把最后一段撑到片尾（太短不补，避免片尾假笔触）
        let endT = Int64(n - 1) * Int64(hopMs)
        if endT - out.last!.at >= 300 { out.append(FunscriptAction(at: endT, pos: lastPos)) }
        return sanitize(out, opt: opt)
    }

    /// 时间偏移（设备延迟补偿）+ 单调化 + 夹取。
    static func sanitize(_ actions: [FunscriptAction], opt: RecordOptions) -> [FunscriptAction] {
        let sorted = actions.sorted { $0.at < $1.at }
        var out: [FunscriptAction] = []
        for a in sorted {
            let t = a.at + Int64(opt.offsetMs)
            if let last = out.last, t <= last.at { continue }
            out.append(FunscriptAction(at: max(0, t), pos: min(opt.maxPos, max(opt.minPos, a.pos))))
        }
        return out
    }

    static func segEnd(_ bounds: [Int], _ k: Int, _ n: Int) -> Int {
        min(k + 1 < bounds.count ? bounds[k + 1] : n, n)
    }

    /// 一根轴值不值得写进脚本：至少两个动作点且位置要有变化。
    static func isUsable(_ a: [FunscriptAction]) -> Bool {
        guard a.count >= 2 else { return false }
        let positions = a.map { $0.pos }
        return (positions.max()! - positions.min()!) > 0
    }

    /// 生成 funscript JSON（对齐安卓 StrokeSynth.buildFunscriptJson）。
    static func buildFunscriptJson(durationMs: Int64, axes: [GenAxis], note: String) -> String {
        var root: [String: Any] = [:]
        root["version"] = "1.1"
        root["inverted"] = false
        root["range"] = 100
        var meta: [String: Any] = [:]
        meta["generator"] = "Orbit ScriptRecorder"
        meta["duration"] = round(Double(durationMs) / 1000.0 * 100) / 100.0
        meta["notes"] = note
        meta["axes"] = axes.map { $0.id }
        root["metadata"] = meta
        let primary = axes.first(where: { $0.id == "L0" }) ?? axes[0]
        root["actions"] = primary.actions.map { ["at": $0.at, "pos": $0.pos] }
        if axes.count > 1 {
            root["axes"] = axes.map { (["id": $0.id, "actions": $0.actions.map { ["at": $0.at, "pos": $0.pos] }]) }
        }
        guard JSONSerialization.isValidJSONObject(root),
              let data = try? JSONSerialization.data(withJSONObject: root),
              let str = String(data: data, encoding: .utf8) else { return "" }
        return str
    }
}
