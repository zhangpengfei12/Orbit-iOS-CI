import Foundation

/// 配置存储：对齐安卓 ConfigStore.kt 的 orbit_config.json 结构与默认值。
///
/// iOS 用 App 沙盒 Documents 下的同名文件，字段名、默认值保持一致，
/// 方便将来安卓/iOS 配置互导，也便于 license_check.py 的断言逻辑复用。
///
/// ⚠ 与安卓差异：安卓用 `getExternalFilesDir`，iOS 沙盒没有「外部存储」概念，
///   用 `.documentDirectory` 等价承载；路径语义在 iOS 侧由 bookmark 接管（M1）。
final class OrbitConfig {

    static let shared = OrbitConfig()

    private let file: URL
    private var cfg: [String: Any]
    private let lock = NSLock()

    init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        file = docs.appendingPathComponent("orbit_config.json")
        if let data = try? Data(contentsOf: file),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            cfg = obj
        } else {
            cfg = Self.defaultConfig()
            save()
        }
        ensureStructure()
    }

    // MARK: - 嵌套路径读写（"." 分隔）

    func object(forKeyPath path: String) -> Any? {
        let parts = path.split(separator: ".").map(String.init)
        var cur: Any = cfg
        for p in parts {
            guard let d = cur as? [String: Any], let nxt = d[p] else { return nil }
            cur = nxt
        }
        return cur
    }

    func set(_ value: Any, forKeyPath path: String) {
        lock.lock(); defer { lock.unlock() }
        let parts = path.split(separator: ".").map(String.init)
        set(value, at: parts, in: &cfg)
        save()
    }

    func dictionary(forKeyPath path: String) -> [String: Any] {
        return object(forKeyPath: path) as? [String: Any] ?? [:]
    }

    func string(forKeyPath path: String, default def: String = "") -> String {
        return object(forKeyPath: path) as? String ?? def
    }

    func int(forKeyPath path: String, default def: Int = 0) -> Int {
        return object(forKeyPath: path) as? Int ?? def
    }

    func bool(forKeyPath path: String, default def: Bool = false) -> Bool {
        return object(forKeyPath: path) as? Bool ?? def
    }

    // MARK: - 保存

    func save() {
        lock.lock(); defer { lock.unlock() }
        do {
            let data = try JSONSerialization.data(withJSONObject: cfg, options: [.prettyPrinted])
            try data.write(to: file)
        } catch {
            Diagnostics.shared.log("CONFIG", "写入失败: \(error)")
        }
    }

    // MARK: - 内部结构

    private func set(_ value: Any, at parts: [String], in dict: inout [String: Any]) {
        guard let first = parts.first else { return }
        if parts.count == 1 {
            dict[first] = value
        } else {
            var sub = dict[first] as? [String: Any] ?? [:]
            set(value, at: Array(parts.dropFirst()), in: &sub)
            dict[first] = sub
        }
    }

    private func ensureStructure() {
        // 补齐缺失的顶层键，避免旧配置缺字段导致前端取数崩溃
        for (k, v) in Self.defaultConfig() {
            if cfg[k] == nil { cfg[k] = v }
        }
        let settingsKeys: [String: Any] = [
            "local": ["rootPath": ""],
            "smb": ["host": "", "share": "", "username": "", "password": "", "anonymous": false],
            "axes": Self.defaultAxes(),
            "analyze": ["autoAnalyze": false],
            "osr": Self.defaultOsr()
        ]
        var s = (cfg["settings"] as? [String: Any]) ?? [:]
        for (k, v) in settingsKeys where s[k] == nil {
            s[k] = v
        }
        cfg["settings"] = s

        // license / trial 子键补齐
        var lic = (cfg["license"] as? [String: Any]) ?? [:]
        for (k, v) in Self.defaultLicense() where lic[k] == nil { lic[k] = v }
        cfg["license"] = lic
        var trial = (cfg["trial"] as? [String: Any]) ?? [:]
        for (k, v) in Self.defaultTrial() where trial[k] == nil { trial[k] = v }
        cfg["trial"] = trial
    }

    private static func defaultAxes() -> [String: Any] {
        var a: [String: Any] = [:]
        for k in ["L0", "L1", "L2", "R0", "R1", "R2"] {
            a[k] = ["reversed": false, "min": 0, "max": 9999, "scale": 1.0]
        }
        return a
    }

    private static func defaultOsr() -> [String: Any] {
        var ap: [String: Any] = [:]
        for k in ["L0", "L1", "L2", "R0", "R1", "R2"] {
            ap[k] = ["reversed": false, "min": 0, "max": 9999, "amplitude": 100]
        }
        return [
            "enabled": true,
            "connectionType": "TCP",
            "ip": "192.168.1.88",
            "port": 8000,
            "serialDevice": "1a86:7523",
            "baudRate": 115200,
            "btAddress": "",
            "protocol": "AUTO",
            "tcodeNewline": true,
            "prefix": "",
            "suffix": "",
            "axisParams": ap,
            "axisRoutes": [:] as [String: Any],
            "syncEnabled": true
        ]
    }

    private static func defaultLicense() -> [String: Any] {
        return ["state": "idle", "kind": 0, "cardSeq": 0, "expireAt": 0,
                "machine": "", "activatedAt": 0, "lastActivatedMachine": ""]
    }

    private static func defaultTrial() -> [String: Any] {
        return ["startedAt": 0, "deadline": 0, "lastSeenWallMs": 0, "began": false]
    }

    static func defaultConfig() -> [String: Any] {
        return [
            "version": "1.0.0",
            "brand": "Orbit",
            "libraries": [] as [Any],
            "activeLibraryId": 0,
            "favorites": [:] as [String: Any],
            "actorOverrides": [:] as [String: Any],
            "license": defaultLicense(),
            "trial": defaultTrial(),
            "settings": [
                "local": ["rootPath": ""],
                "smb": ["host": "", "share": "", "username": "", "password": "", "anonymous": false],
                "axes": defaultAxes(),
                "analyze": ["autoAnalyze": false],
                "osr": defaultOsr()
            ]
        ]
    }
}
