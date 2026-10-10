import Foundation

// MARK: - 本机媒体库（iOS 沙盒）
//
// 与安卓的根本差别：安卓走 SAF 授权系统文件夹后直接浏览外部存储；
// iOS 没有外设存储遍历权限，**必须把选来的视频拷进 App 沙盒**，再由 ApiVideo
// 按「Documents 相对路径」取流（/video/Media/xxx.mp4）。
//
// 因此这里的职责是三件事：
//   1) 维护媒体根目录 Documents/Media；
//   2) 把 Picker 给的临时 URL 拷进来（同名自动去重，不覆盖）；
//   3) 给 /api/browse/local 提供目录清单（只列目录 + 视频 + funscript）。
//
// ⚠ 路径口径：对外一律用「Documents 相对路径」，不带前导斜杠。
//   ApiVideo.localFileURL 会把 key 拼到 Documents 后取文件，
//   前端又把这个 path 当 key 去拼 /video/<path> —— 两边口径必须一致，
//   写成绝对路径会变成 Documents/var/mobile/... 而 404。

final class MediaStore {

    static let shared = MediaStore()

    /// 媒体根目录相对于 Documents 的路径。
    static let rootRel = "Media"

    private let fm = FileManager.default

    private init() {}

    // MARK: - 路径基元

    var documents: URL {
        fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    var mediaRoot: URL {
        documents.appendingPathComponent(Self.rootRel, isDirectory: true)
    }

    /// 建媒体根目录（不存在才建）。
    @discardableResult
    func ensureRoot() -> Bool {
        var isDir: ObjCBool = false
        let path = mediaRoot.path
        if fm.fileExists(atPath: path, isDirectory: &isDir) { return isDir.boolValue }
        do {
            try fm.createDirectory(atPath: path, withIntermediateDirectories: true)
            return true
        } catch {
            Diagnostics.shared.log("MEDIA", "创建媒体目录失败：\(error)")
            return false
        }
    }

    /// 把「Documents 相对路径或绝对路径」解析成沙盒内真实 URL。
    /// 绝对路径必须落在 Documents 内，否则 nil（挡掉 ../ 穿越与系统路径）。
    func resolve(_ relOrAbs: String) -> URL? {
        let trimmed = relOrAbs.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return mediaRoot }
        if trimmed.hasPrefix("/") {
            let docs = documents.standardizedFileURL.path
            let abs = URL(fileURLWithPath: trimmed).standardizedFileURL
            guard abs.path == docs || abs.path.hasPrefix(docs + "/") else { return nil }
            return abs
        }
        return documents.appendingPathComponent(trimmed).standardizedFileURL
    }

    /// 反向操作：URL → Documents 相对路径（给 /video/<key> 与浏览列表用）。
    func relPath(of url: URL) -> String {
        let prefix = documents.standardizedFileURL.path + "/"
        let p = url.standardizedFileURL.path
        return p.hasPrefix(prefix) ? String(p.dropFirst(prefix.count)) : p
    }

    // MARK: - 文件类别

    static let videoExts: Set<String> = ["mp4", "mov", "m4v", "mkv", "webm", "avi"]
    static let scriptExts: Set<String> = ["funscript"]

    private func ext(of name: String) -> String {
        (name as NSString).pathExtension.lowercased()
    }

    // MARK: - 导入

    /// 导入 Picker 给的临时文件到媒体根。
    /// - Returns: [(文件名, Documents 相对路径, 字节数)]
    func importFiles(_ urls: [URL]) -> [(name: String, rel: String, size: Int64)] {
        guard ensureRoot() else { return [] }
        var out: [(String, String, Int64)] = []
        for raw in urls {
            let src = raw.standardizedFileURL
            let name = uniqueName(for: src.lastPathComponent)
            let dst = mediaRoot.appendingPathComponent(name)
            do {
                if fm.fileExists(atPath: dst.path) { try fm.removeItem(at: dst) }
                try fm.copyItem(at: src, to: dst)
                var size: Int64 = 0
                if let n = (try? fm.attributesOfItem(atPath: dst.path)[.size]) as? NSNumber {
                    size = n.int64Value
                }
                if size <= 0 {
                    Diagnostics.shared.log("MEDIA", "导入后取到 0 字节：\(name)")
                }
                out.append((name, relPath(of: dst), size))
            } catch {
                Diagnostics.shared.log("MEDIA", "导入失败 \(src.lastPathComponent)：\(error)")
            }
        }
        if !out.isEmpty {
            Diagnostics.shared.log("MEDIA", "已导入 \(out.count) 个文件到 \(Self.rootRel)")
        }
        return out
    }

    /// 同名去重：已存在就加 " (2)"、" (3)"…… 不覆盖原文件。
    private func uniqueName(for preferred: String) -> String {
        let base = preferred.isEmpty ? "video.mp4" : preferred
        let dst = mediaRoot.appendingPathComponent(base)
        if !fm.fileExists(atPath: dst.path) { return base }
        let ns = base as NSString
        let stem = ns.deletingPathExtension
        let ext = ns.pathExtension
        for i in 2...999 {
            let cand = ext.isEmpty ? "\(stem) (\(i))" : "\(stem) (\(i)).\(ext)"
            if !fm.fileExists(atPath: mediaRoot.appendingPathComponent(cand).path) {
                return cand
            }
        }
        return "\(Date().timeIntervalSince1970)-\(base)"
    }

    // MARK: - 列目录

    /// 给 /api/browse/local 用：列出目录下的「子目录 + 视频 + funscript」。
    /// 其余杂项忽略 —— 前端把非目录项一律当视频渲染，塞进去会变成点不开的假条目。
    func listDirectory(_ relOrAbs: String) -> [[String: Any]] {
        guard let dir = resolve(relOrAbs),
              let names = try? fm.contentsOfDirectory(atPath: dir.path) else {
            return []
        }
        var dirs: [[String: Any]] = []
        var files: [[String: Any]] = []
        for name in names.sorted() {
            guard !name.hasPrefix(".") else { continue }
            let full = dir.appendingPathComponent(name)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: full.path, isDirectory: &isDir) else { continue }
            let rel = relPath(of: full)
            if isDir.boolValue {
                dirs.append(["name": name, "path": rel, "isDir": true])
                continue
            }
            let e = ext(of: name)
            if Self.videoExts.contains(e) || Self.scriptExts.contains(e) {
                files.append(["name": name, "path": rel, "isDir": false])
            }
        }
        return dirs + files
    }

    /// 当前已导入的视频数（空态提示用）。
    var importedCount: Int {
        guard let names = try? fm.contentsOfDirectory(atPath: mediaRoot.path) else { return 0 }
        return names.filter { Self.videoExts.contains(ext(of: $0)) }.count
    }
}
