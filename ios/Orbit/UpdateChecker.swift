import Foundation

// MARK: - 在线更新检查（纯逻辑）
//
// 对齐安卓 MainActivity.checkAppUpdate / isNewer / fetchFromCloudBase：
// 主源 CloudBase latest.json（versionName/apkPath/notes），语义化版本比较。
// 真正的 HTTP 拉取（URLSession）留待真机；本文件只做版本比较与 manifest 解析。

struct UpdateManifest {
    let versionName: String
    let apkPath: String
    let notes: String
}

/// 解析 CloudBase latest.json（{versionName, apkPath, notes}）。
func parseUpdateManifest(_ json: [String: Any]) -> UpdateManifest? {
    guard let vn = (json["versionName"] as? String)?.trimmingCharacters(in: .whitespaces),
          !vn.isEmpty else { return nil }
    let path = (json["apkPath"] as? String) ?? ""
    let notes = (json["notes"] as? String) ?? ""
    return UpdateManifest(versionName: vn,
                          apkPath: path.trimmingCharacters(in: .whitespaces),
                          notes: notes)
}

/// apkPath 可能是相对路径（补 base）或完整 http(s) URL（原样返回）。
func resolveApkUrl(_ base: String, _ path: String) -> String {
    let p = path.trimmingCharacters(in: .whitespaces)
    if p.lowercased().hasPrefix("http") { return p }
    let b = base.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    if p.isEmpty { return b }
    return b + "/" + p.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
}

/// 语义化版本比较：latest 是否比 current 新（按 . 分段比较整数）。对齐安卓 isNewer。
func isNewer(_ latest: String, _ current: String) -> Bool {
    let a = latest.split(separator: ".").map { Int($0.filter { $0.isNumber }) ?? 0 }
    let b = current.split(separator: ".").map { Int($0.filter { $0.isNumber }) ?? 0 }
    let n = max(a.count, b.count)
    for i in 0..<n {
        let x = i < a.count ? a[i] : 0
        let y = i < b.count ? b[i] : 0
        if x != y { return x > y }
    }
    return false
}
