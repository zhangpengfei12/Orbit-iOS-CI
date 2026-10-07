import Foundation

// MARK: - 播放器状态快照（纯逻辑）
//
// 对齐安卓 NativePlayer.state() 的 JSON 结构：
// {"type","posMs","durMs","playing","buffering","ready","w","h","rate","vol","muted","err"}
// iOS 原生播放器（AVPlayer，M1）发布同样的快照给 /api 与 JS 桥 state()。

struct PlayerSnapshot: Equatable {
    var type: String = "idle"
    var posMs: Int64 = 0
    var durMs: Int64 = 0
    var playing = false
    var buffering = false
    var ready = false
    var w = 0
    var h = 0
    var rate: Double = 1
    var vol: Double = 1
    var muted = false
    var err = ""

    init() {}

    init?(json: [String: Any]) {
        self.init()
        if let t = json["type"] as? String { type = t }
        posMs = (json["posMs"] as? NSNumber)?.int64Value ?? 0
        durMs = (json["durMs"] as? NSNumber)?.int64Value ?? 0
        playing = (json["playing"] as? NSNumber)?.boolValue ?? false
        buffering = (json["buffering"] as? NSNumber)?.boolValue ?? false
        ready = (json["ready"] as? NSNumber)?.boolValue ?? false
        w = (json["w"] as? NSNumber)?.intValue ?? 0
        h = (json["h"] as? NSNumber)?.intValue ?? 0
        rate = (json["rate"] as? NSNumber)?.doubleValue ?? 1
        vol = (json["vol"] as? NSNumber)?.doubleValue ?? 1
        muted = (json["muted"] as? NSNumber)?.boolValue ?? false
        err = (json["err"] as? String) ?? ""
    }

    func toDictionary() -> [String: Any] {
        return [
            "type": type,
            "posMs": NSNumber(value: posMs),
            "durMs": NSNumber(value: durMs),
            "playing": playing,
            "buffering": buffering,
            "ready": ready,
            "w": w,
            "h": h,
            "rate": NSNumber(value: rate),
            "vol": NSNumber(value: vol),
            "muted": muted,
            "err": err
        ]
    }

    func toJsonString() -> String {
        if let data = try? JSONSerialization.data(withJSONObject: toDictionary()),
           let s = String(data: data, encoding: .utf8) { return s }
        return "{}"
    }
}
