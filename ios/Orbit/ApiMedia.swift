import Foundation
import Swifter

// MARK: - 本机媒体浏览（覆盖 ApiStubs 里的空占位）
//
// 安卓这条路是 SAF：授权 content:// 根后由 DocumentFile 遍历外部存储；
// iOS 没有对应机制，改为浏览 **应用沙盒 Documents/Media**（由 MediaPicker 导入而来），
// 对外口径统一是「Documents 相对路径」—— 前端拿 item.path 去拼 /video/<path>，
// ApiVideo 也按同一口径定位文件，两边对不上就会取流 404。
enum ApiMedia {

    static func register(into server: HttpServer) {
        // GET /api/browse/local?path=<Documents 相对路径>
        server.get["/api/browse/local"] = { req in
            let q = queryParams(req)
            let asked = (q["path"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let rel = normalize(asked)
            guard let dir = MediaStore.shared.resolve(rel) else {
                return browseFailure(rel, reason: "路径不在 App 媒体范围内")
            }
            var isDir: ObjCBool = false
            let exists = FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir)
            if exists && !isDir.boolValue {
                // 有人在设置页手填了视频文件路径：列它所在目录，比报「读不到」有用得多
                let parentRel = MediaStore.shared.relPath(of: dir.deletingLastPathComponent())
                return browse(parentRel.isEmpty ? MediaStore.rootRel : parentRel)
            }
            guard exists else {
                // 目录不存在（多半还没导入过视频）：如实告诉用户该去点「选择视频」
                Diagnostics.shared.log("BROWSE", "目录不存在：\(rel)")
                return .ok(.json([
                    "ok": true,
                    "path": rel,
                    "items": [] as [Any],
                    "error": "目录不存在或还没导入视频",
                    "debug": "去「本机媒体」里点「选择视频」把视频导入 App（iOS 不能像安卓那样直接浏览系统文件夹）"
                ] as [String: Any]))
            }
            return browse(rel)
        }

        // POST /api/refresh：覆盖 ApiSystem 的恒 0 占位，回报真实已导入数
        server.post["/api/refresh"] = { _ in
            // 顺带重建媒体索引：首页走 /api/items，导入完不刷新的话新视频不会进首页
            let n = MediaIndex.shared.rescan()
            Diagnostics.shared.log("REFRESH", "请求刷新媒体库（本机 \(n) 个视频）")
            return json(["ok": true, "scanned": n])
        }
    }

    // MARK: - 内部

    /// 空 / 越界的输入一律收敛到媒体根 MediaStore.rootRel。
    private static func normalize(_ path: String) -> String {
        if path.isEmpty { return MediaStore.rootRel }
        var trimmed = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if trimmed.isEmpty { return MediaStore.rootRel }
        // 挡目录穿越：含 .. 段就退回媒体根
        if trimmed.components(separatedBy: "/").contains("..") { return MediaStore.rootRel }
        // 绝对路径：限制在 Documents 内，换算回相对路径
        if trimmed.hasPrefix("/") {
            guard let url = MediaStore.shared.resolve(trimmed) else { return MediaStore.rootRel }
            return MediaStore.shared.relPath(of: url)
        }
        if trimmed == "." { return MediaStore.rootRel }
        return trimmed
    }

    private static func browse(_ rel: String) -> HttpResponse {
        let reload = rel.isEmpty ? MediaStore.rootRel : rel
        guard let dir = MediaStore.shared.resolve(reload) else {
            return browseFailure(reload, reason: "路径不在 App 媒体范围内")
        }
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else {
            return browseFailure(reload, reason: "目录读取失败")
        }
        let items = MediaStore.shared.listDirectory(reload)
        // items 里已经过滤掉非视频/脚本，但杂项文件可能不少 —— 记一笔方便排查
        let hidden = names.count - items.count
        if hidden > 0 {
            Diagnostics.shared.log("BROWSE", "\(reload)：忽略 \(hidden) 个非视频文件")
        }
        return json(["ok": true, "path": reload, "items": items as [Any]])
    }

    private static func browseFailure(_ rel: String, reason: String) -> HttpResponse {
        Diagnostics.shared.log("BROWSE", "\(reason)：\(rel)")
        return json([
            "ok": true,
            "path": rel,
            "items": [] as [Any],
            "error": reason,
            "debug": rel
        ] as [String: Any])
    }
}
