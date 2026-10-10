import Foundation
import AVFoundation
import UIKit

// MARK: - 本机媒体索引（iOS 沙盒版媒体库）
//
// 为什么必须自己造一份：
//   前端首页走的是「新 API」：`GET /api/items` → 命中 `data.items != null` 就**不再回退**
//   到旧的 `/api/videos`。而 ApiStubs 里 `/api/items` 恒返回空数组，于是
//   「明明用选择器导入了视频，首页依旧显示『暂无影片 · 请在 App 中配置视频目录』」——
//   这是 iOS 版最容易被当成「功能坏了」的一处，实际是后端没接。
//
// 与安卓媒体库的边界（刻意划清，避免做成半个 scraping 系统）：
//   · 只做「沙盒内视频文件 → 条目」这一层，不做 NFO 刮削、演员库、类型库；
//   · 条目 id 持久化（Documents/MediaLibrary.json），重扫不会让收藏/播放次数丢失；
//   · 封面按需用 AVAssetImageGenerator 抽帧并落盘缓存，不预生成（导入几十个视频会卡死）。
//
// ⚠ key 口径：folderName / parts[0].name 一律是「Documents 相对路径」（如 Media/a.mp4），
//   与 /video/<key>（ApiVideo）和 MediaStore.relPath 完全一致；写成绝对路径会 404。

final class MediaIndex {

    static let shared = MediaIndex()

    /// 一条已入库视频。
    struct Entry: Codable {
        var id: Int
        var rel: String
        var favorite: Bool = false
        var playCount: Int = 0
        var title: String?
        var year: Int?
        var rating: Int?
        var mpaa: String?
        var genres: [String] = []
        var actors: [String] = []
        var studio: String = ""
        var director: String = ""
        var plot: String = ""
    }

    private struct Store: Codable {
        var nextId: Int = 1
        var entries: [Entry] = []
    }

    private let fm = FileManager.default
    private var store: Store
    private let lock = NSLock()

    private init() {
        store = (try? Self.load()) ?? Store()
    }

    // MARK: - 持久化

    private static var fileURL: URL? {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
            .appendingPathComponent("MediaLibrary.json")
    }

    private static func load() throws -> Store {
        guard let url = fileURL,
              let data = try? Data(contentsOf: url) else { return Store() }
        return try JSONDecoder().decode(Store.self, from: data)
    }

    func save() {
        guard let url = Self.fileURL, let data = try? JSONEncoder().encode(store) else { return }
        try? data.write(to: url)
    }

    // MARK: - 扫描

    /// 扫一遍沙盒媒体目录：新文件分配 id，已删除的条目剔除。
    /// 不在每次请求里扫（递归 + 排序有成本），由导入完成与「扫描」按钮触发。
    @discardableResult
    func rescan() -> Int {
        let root = MediaStore.shared.mediaRoot
        var found: [String] = []
        Self.collectVideos(in: root, out: &found)
        found = found.map { MediaStore.shared.relPath(of: URL(fileURLWithPath: $0)) }.sorted()

        lock.lock()
        var byRel: [String: Entry] = Dictionary(uniqueKeysWithValues: store.entries.map { ($0.rel, $0) })
        for rel in found where byRel[rel] == nil {
            let e = Entry(id: store.nextId, rel: rel)
            store.nextId += 1
            byRel[rel] = e
            store.entries.append(e)
        }
        let alive = Set(found)
        store.entries = store.entries.filter { alive.contains($0.rel) }
        let n = store.entries.count
        lock.unlock()
        save()
        Diagnostics.shared.log("MEDIA", "媒体索引扫描完成：\(n) 条")
        return n
    }

    private static func collectVideos(in dir: URL, out: inout [String]) {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return }
        for n in names {
            guard !n.hasPrefix(".") else { continue }
            let full = dir.appendingPathComponent(n)
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: full.path, isDirectory: &isDir) else { continue }
            if isDir.boolValue {
                collectVideos(in: full, out: &out)
            } else if MediaStore.videoExts.contains((n as NSString).pathExtension.lowercased()) {
                out.append(full.path)
            }
        }
    }

    // MARK: - 查询

    private func entry(id: Int) -> Entry? {
        lock.lock(); defer { lock.unlock() }
        return store.entries.first { $0.id == id }
    }

    /// 分页条目（对齐 /api/items 的 {items, total}）。
    /// scope=favorite 时只回收藏；actor / genre 走标题与元数据里的列表。
    func items(page: Int, size: Int, scope: String?, actor: String?, genre: String?) -> ([[String: Any]], Int) {
        lock.lock()
        let all = store.entries
        lock.unlock()
        var list = all
        if scope == "favorite" { list = list.filter { $0.favorite } }
        if let a = actor, !a.isEmpty {
            list = list.filter { $0.actors.contains { $0.compare(a, options: .caseInsensitive) == .orderedSame } }
        }
        if let g = genre, !g.isEmpty {
            list = list.filter { $0.genres.contains { $0.compare(g, options: .caseInsensitive) == .orderedSame } }
        }
        list.sort { Self.displayName($0).localizedStandardCompare(Self.displayName($1)) == .orderedAscending }
        let total = list.count
        let start = max(0, (page - 1) * size)
        let end = min(total, start + size)
        let slice = (start < end) ? Array(list[start..<end]) : []
        return (slice.map { Self.dict($0) }, total)
    }

    func item(id: Int) -> [String: Any]? {
        guard let e = entry(id: id) else { return nil }
        var d = Self.dict(e)
        // 详情页要显示时长与分辨率，只在打开单个条目时读（逐个读会把首页拖垮）
        if let url = MediaStore.shared.resolve(e.rel) {
            let asset = AVURLAsset(url: url)
            let secs = CMTimeGetSeconds(asset.duration)
            if secs.isFinite && secs > 0 { d["durationMs"] = Int64(secs * 1000) }
            if let track = asset.tracks(withMediaType: .video).first {
                let size = track.naturalSize.applying(track.preferredTransform)
                d["videoWidth"] = Int(abs(size.width))
                d["videoHeight"] = Int(abs(size.height))
                d["bitrateBps"] = Int(track.estimatedDataRate)
            }
        }
        return d
    }

    func setFavorite(id: Int, on: Bool) -> [String: Any]? {
        lock.lock()
        guard let i = store.entries.firstIndex(where: { $0.id == id }) else { lock.unlock(); return nil }
        store.entries[i].favorite = on
        let e = store.entries[i]
        lock.unlock()
        save()
        return Self.dict(e)
    }

    func bumpPlay(id: Int) {
        lock.lock()
        guard let i = store.entries.firstIndex(where: { $0.id == id }) else { lock.unlock(); return }
        store.entries[i].playCount += 1
        lock.unlock()
        save()
    }

    /// 保存详情页编辑的元数据（标题/年份/评分/类型/演员等）。
    func updateMetadata(id: Int, _ body: [String: Any]) -> [String: Any]? {
        lock.lock()
        guard let i = store.entries.firstIndex(where: { $0.id == id }) else { lock.unlock(); return nil }
        if let v = body["title"] as? String { store.entries[i].title = v }
        if let v = body["year"] as? Int { store.entries[i].year = v }
        if let v = body["rating"] as? Int { store.entries[i].rating = v }
        if let v = body["mpaa"] as? String { store.entries[i].mpaa = v }
        if let v = body["studio"] as? String { store.entries[i].studio = v }
        if let v = body["director"] as? String { store.entries[i].director = v }
        if let v = body["plot"] as? String { store.entries[i].plot = v }
        if let v = body["genres"] as? [String] { store.entries[i].genres = v }
        if let v = body["actors"] as? [String] { store.entries[i].actors = v }
        let e = store.entries[i]
        lock.unlock()
        save()
        return Self.dict(e)
    }

    /// 解析出真实文件 URL（封面抽帧与播放都用）。
    func fileURL(id: Int) -> URL? {
        guard let e = entry(id: id) else { return nil }
        return MediaStore.shared.resolve(e.rel)
    }

    func fileURL(rel: String) -> URL? { MediaStore.shared.resolve(rel) }

    // MARK: - 字典组装

    private static func displayName(_ e: Entry) -> String {
        if let t = e.title, !t.isEmpty { return t }
        return (e.rel as NSString).lastPathComponent
    }

    private static func dict(_ e: Entry) -> [String: Any] {
        let name = (e.rel as NSString).lastPathComponent
        let stem = (name as NSString).deletingPathExtension
        var d: [String: Any] = [
            "id": e.id,
            // ⚠ folderName 在前端就是「视频 key」：卡片 data-video-name → /player/?video=…
            //   → /video/<key>。必须给 Documents 相对路径，给文件名会 404。
            "folderName": e.rel,
            "title": displayName(e),
            "source": "local",
            "libraryId": 1,
            "itemType": "video",
            "isFavorite": e.favorite,
            "playCount": e.playCount,
            "hasPoster": PosterStore.shared.has(id: e.id),
            "path": e.rel,
            "genres": e.genres,
            "actors": e.actors,
            "studio": e.studio,
            "director": e.director,
            "plot": e.plot,
            // streamKey = part.name（无 part.id 时），所以 name 必须是可播放的 key
            "parts": [["name": e.rel, "path": e.rel, "title": stem]]
        ]
        if let y = e.year { d["year"] = y }
        if let r = e.rating { d["rating"] = r }
        if let m = e.mpaa, !m.isEmpty { d["mpaa"] = m }
        return d
    }
}

// MARK: - 封面缓存

/// 用 AVAssetImageGenerator 抽一帧当封面，落成 JPEG 缓存。
/// 不预生成：导入一批视频时逐个解码会把界面卡住，只在前端真的请求封面时才抽。
final class PosterStore {

    static let shared = PosterStore()

    private let fm = FileManager.default

    private var dir: URL? {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Cache/Posters", isDirectory: true)
    }

    private func url(id: Int) -> URL? { dir?.appendingPathComponent("\(id).jpg") }

    func has(id: Int) -> Bool {
        guard let u = url(id: id) else { return false }
        return fm.fileExists(atPath: u.path)
    }

    /// 已有缓存直接读；没有则抽帧（取视频 10% 处，避开片头黑帧）。
    /// - Returns: JPEG 数据，失败返回 nil（前端 data-hide-on-error 会把破图隐掉，不会留占位方块）。
    func jpeg(id: Int, fileURL: URL) -> Data? { jpeg(key: "\(id)", fileURL: fileURL) }

    /// 按字符串 key 取封面：给旧接口 `/thumbnail/<视频相对路径>` 用（那里拿不到条目 id）。
    func jpeg(key: String, fileURL: URL) -> Data? {
        let safe = key.replacingOccurrences(of: "/", with: "_")
        guard let out = dir?.appendingPathComponent("k_\(safe).jpg") else { return nil }
        return cachedOrGenerate(out, fileURL)
    }

    private func cachedOrGenerate(_ out: URL, _ fileURL: URL) -> Data? {
        if let d = try? Data(contentsOf: out), !d.isEmpty { return d }
        try? fm.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
        let asset = AVURLAsset(url: fileURL)
        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        gen.maximumSize = CGSize(width: 480, height: 720)
        let secs = CMTimeGetSeconds(asset.duration)
        let at = CMTimeMakeWithSeconds(secs.isFinite && secs > 1 ? secs * 0.1 : 0, preferredTimescale: 600)
        guard let cg = try? gen.copyCGImage(at: at, actualTime: nil) else { return nil }
        guard let data = UIImage(cgImage: cg).jpegData(compressionQuality: 0.72) else { return nil }
        try? data.write(to: out)
        return data
    }

    func invalidate(id: Int) {
        guard let u = url(id: id) else { return }
        try? fm.removeItem(at: u)
    }
}
