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

    // MARK: - 配脚本（把一个外部 .funscript 挂到指定视频上）

    /// 把外部脚本按「视频同名」规则落到视频所在目录，供随播自动加载。
    ///
    /// 为什么需要这个：iOS 上视频在「相册」、脚本只能放「文件」，两边天生不同名
    /// （相册导出的是 IMG_1234.MOV 这类名字），就算都导进媒体库也配不上。
    /// 这里统一改名成 `<视频名>.funscript` / `<视频名>.<轴>.funscript`，
    /// 与 ApiOsr.localScripts 的「同目录 + 同名」判据对齐。
    ///
    /// - Parameters:
    ///   - videoRel: 视频的 Documents 相对路径（前端传的 videoName）
    ///   - scriptURLs: 用户从「文件」选中的脚本临时副本（可多轴一起选）
    /// - Returns: 落盘后的文件名列表（空 = 全部失败）
    func attachScripts(videoRel: String, scriptURLs: [URL]) -> [String] {
        guard let videoURL = resolve(videoRel) else { return [] }
        // 必须是媒体库内**真实存在**的文件：SMB 视频的 key 是共享内相对路径，
        // 沙盒里没有对应文件，这种情况前端会给「请放到共享同目录」的提示。
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: videoURL.path, isDirectory: &isDir), !isDir.boolValue else {
            Diagnostics.shared.log("MEDIA", "配脚本失败：本地找不到视频 \(videoRel)")
            return []
        }
        let dir = videoURL.deletingLastPathComponent()
        let base = videoURL.deletingPathExtension().lastPathComponent
        guard !base.isEmpty else { return [] }

        var saved: [String] = []
        for src in scriptURLs {
            let srcName = src.lastPathComponent
            let axis = Self.axisSuffix(ofScriptName: srcName)
            let dstName = axis.isEmpty ? "\(base).funscript" : "\(base).\(axis).funscript"
            let dst = dir.appendingPathComponent(dstName)
            do {
                // 脚本应当**覆盖**而不是去重：同名脚本重复挂载时用户期望的是替换。
                if fm.fileExists(atPath: dst.path) { try fm.removeItem(at: dst) }
                try fm.copyItem(at: src, to: dst)
                saved.append(dstName)
            } catch {
                Diagnostics.shared.log("MEDIA", "配脚本失败 \(srcName) → \(dstName)：\(error.localizedDescription)")
            }
        }
        if !saved.isEmpty {
            Diagnostics.shared.log("MEDIA", "已配脚本 \(saved.joined(separator: ", ")) → \(relPath(of: dir))")
        }
        return saved
    }

    /// 从脚本文件名里取轴后缀：`abc.L0.funscript` → `L0`，`abc.funscript` → 空。
    /// 规则与安卓 TouchpadSaver 的分轴命名一致（L0/L1/L2/R0/R1/R2）。
    private static func axisSuffix(ofScriptName name: String) -> String {
        let stem = (name as NSString).deletingPathExtension
        guard let dot = stem.lastIndex(of: ".") else { return "" }
        let tail = String(stem[stem.index(after: dot)...])
        guard tail.count == 2,
              let first = tail.first, first == "L" || first == "R",
              let last = tail.last, last.isNumber else { return "" }
        return tail
    }

    /// 同批导入的「视频 + 脚本」名字不一致时自动配对。
    ///
    /// 场景：用户从「文件」里一次多选 `我的片子.mp4` 和 `some-script.funscript`，
    /// 两个文件都进来了但名字不同名，永远配不上。这里在**本批恰好 1 个视频**时
    /// 直接把脚本改到该视频名下（多于 1 个视频则不改，避免张冠李戴）。
    ///
    /// - Returns: 被改名落地的脚本文件名（空 = 没做任何事）
    @discardableResult
    func pairLooseScripts(imported: [(name: String, rel: String, size: Int64)]) -> [String] {
        let videos = imported.filter { Self.videoExts.contains(ext(of: $0.name)) }
        guard videos.count == 1 else { return [] }
        guard let videoURL = resolve(videos[0].rel) else { return [] }
        let dir = videoURL.deletingLastPathComponent()
        let base = videoURL.deletingPathExtension().lastPathComponent
        guard !base.isEmpty else { return [] }

        var renamed: [String] = []
        for item in imported where Self.scriptExts.contains(ext(of: item.name)) {
            let srcName = item.name
            let stem = (srcName as NSString).deletingPathExtension
            // 已经同名的就别动（含分轴：base.L0 / base.R1）
            if stem == base || stem.hasPrefix(base + ".") { continue }
            guard let src = resolve(item.rel) else { continue }
            let axis = Self.axisSuffix(ofScriptName: srcName)
            let dstName = axis.isEmpty ? "\(base).funscript" : "\(base).\(axis).funscript"
            let dst = dir.appendingPathComponent(dstName)
            do {
                if fm.fileExists(atPath: dst.path) { try fm.removeItem(at: dst) }
                try fm.moveItem(at: src, to: dst)
                renamed.append(dstName)
            } catch {
                Diagnostics.shared.log("MEDIA", "自动配对失败 \(srcName) → \(dstName)：\(error.localizedDescription)")
            }
        }
        if !renamed.isEmpty {
            Diagnostics.shared.log("MEDIA", "同批导入自动配对：\(renamed.joined(separator: ", ")) → \(base)")
        }
        return renamed
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
