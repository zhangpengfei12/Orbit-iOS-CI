import Foundation
import Swifter

/// /video/<路径> 视频流。
///
/// 前端 player.js:177 用 `'/video/' + videoName.split('/').map(encodeURIComponent).join('/')`
/// 拼 src，所以这里的 path 是**逐段 encodeURIComponent** 过的，必须解码一次再定位文件。
///
/// 对齐安卓 WebServer.kt:1141-1167（handleVideo）：
///   - 支持 HTTP Range，返回 206 + Content-Range（AVPlayer 靠它拖动进度条）
///   - 取不到总长度时不写非法 Content-Range（安卓 v2.7.52 加固点）
///   - 单次响应封顶 8 MiB：`bytes=0-` 这种「到末尾」的请求若照办会把整部影片读进内存
enum ApiVideo {

    /// 单次响应最大字节数。8 MiB 对局域网 SMB 足够跑满带宽，又不会撑爆内存。
    private static let maxChunk: Int64 = 8 * 1024 * 1024

    // MARK: - 入口

    /// 由 OrbitServer 的 notFoundHandler 转发进来（Swifter 的路由按段精确匹配，
    /// 视频路径段数不固定，只能在前缀判断后手工分发）。
    static func handle(_ req: HttpRequest) -> HttpResponse? {
        let raw = req.path
        guard raw.hasPrefix("/video/") else { return nil }
        let encoded = String(raw.dropFirst("/video/".count))
        // 先剥查询串（?v= 之类），再解码路径本身
        let noQuery = encoded.components(separatedBy: "?").first ?? encoded
        let key = noQuery.removingPercentEncoding ?? noQuery
        guard !key.isEmpty else { return .notFound }

        // 本地优先：沙盒 Documents 下有同名文件就直接走本地读（后续媒体库接入即用这条）
        if let local = localFileURL(for: key) {
            return serveLocal(local, req: req)
        }
        // 其余一律按 SMB 共享内的相对路径处理，凭据取已保存设置
        // （安卓同语义：findLibForRawSmb 从 ConfigStore 读 SMB 配置）
        return serveSmb(path: key, req: req)
    }

    // MARK: - SMB 流

    private static func serveSmb(path: String, req: HttpRequest) -> HttpResponse {
        let saved = OrbitConfig.shared.dictionary(forKeyPath: "settings.smb")
        let host = (saved["host"] as? String) ?? ""
        let share = (saved["share"] as? String) ?? ""
        let anonymous = (saved["anonymous"] as? Bool)
            ?? ((saved["anonymous"] as? NSNumber)?.boolValue ?? false)
        guard !host.isEmpty else {
            Diagnostics.shared.log("VIDEO", "未配置 SMB 主机，无法播放 \(path)")
            return .notFound
        }
        let creds = SmbCreds(
            host: host,
            share: share,
            user: anonymous ? "guest" : ((saved["username"] as? String) ?? ""),
            pass: anonymous ? "" : ((saved["password"] as? String) ?? ""),
            domain: anonymous ? "" : ((saved["domain"] as? String) ?? ""),
            anonymous: anonymous
        )

        // 总长度：Content-Range 需要它，拿不到就无法声明区间
        guard case .success(let total) = SmbClient.sizeOf(creds, path: path), total > 0 else {
            Diagnostics.shared.log("VIDEO", "SMB 取不到文件大小：\(path)")
            return .notFound
        }

        let (start, end) = rangeFor(req.headers["range"] ?? req.headers["Range"], total: total)
        let count = end - start + 1
        switch SmbClient.read(creds, path: path, start: start, count: count) {
        case .success(let data):
            return partialResponse(data: data, start: start, total: total, key: path)
        case .failure(let f):
            Diagnostics.shared.log("VIDEO", "SMB 读失败：\(f.message)")
            return .notFound
        }
    }

    // MARK: - 本地流（沙盒内文件）

    private static func serveLocal(_ url: URL, req: HttpRequest) -> HttpResponse {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let total = (attrs?[.size] as? NSNumber)?.int64Value ?? 0
        guard total > 0 else { return .notFound }
        let (start, end) = rangeFor(req.headers["range"] ?? req.headers["Range"], total: total)
        guard let fh = try? FileHandle(forReadingFrom: url) else { return .notFound }
        defer { try? fh.close() }
        fh.seek(toFileOffset: UInt64(start))
        let data = fh.readData(ofLength: Int(end - start + 1))
        return partialResponse(data: data, start: start, total: total, key: url.lastPathComponent)
    }

    private static func localFileURL(for key: String) -> URL? {
        // 只接受 Documents 下的相对路径，挡掉 ../ 穿越
        let rel = key.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !rel.isEmpty, !rel.components(separatedBy: "/").contains("..") else { return nil }
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        guard let dir = docs else { return nil }
        let full = dir.appendingPathComponent(rel)
        return FileManager.default.fileExists(atPath: full.path) ? full : nil
    }

    // MARK: - Range 计算

    /// 解析 `bytes=start-end`，产出**实际要返回**的区间。
    /// 越界/非法一律收敛（对齐安卓：s > e 或 e >= total 时整段重置），
    /// 并对「到末尾」的请求做 8 MiB 封顶。
    private static func rangeFor(_ header: String?, total: Int64) -> (Int64, Int64) {
        var start: Int64 = 0
        var end: Int64 = total - 1
        if let h = header, let m = h.range(of: "bytes=") {
            let spec = String(h[m.upperBound...]).components(separatedBy: "-")
            let s = Int64(spec.first?.trimmingCharacters(in: .whitespaces) ?? "") ?? 0
            // "bytes=0-" 的第二段是空串 → e 取末尾；"bytes=-500" 的语义是最后 500 字节，
            // 播放器极少用，这里按「从 0 开始」简化处理也不会更错（后续有需要再补）
            let e = (spec.count > 1 ? Int64(spec[1].trimmingCharacters(in: .whitespaces)) : nil) ?? (total - 1)
            if s <= e, e < total {
                start = s
                end = e
            }
        }
        if end - start + 1 > maxChunk { end = start + maxChunk - 1 }
        if end > total - 1 { end = total - 1 }
        if start > end { start = 0; end = max(0, total - 1) }
        return (start, end)
    }

    // MARK: - 响应组装

    /// 206 + Content-Range。
    ///
    /// ⚠ 必须用 .raw：Swifter 的 .ok 只能给 200。而 .raw 的代价是
    ///   content().length == -1 → Swifter 不写 Content-Length、不写 keep-alive、
    ///   且响应完关闭连接。所以这里**手写全部头部**并把 Connection 显式写成 close，
    ///   让声明与实际行为一致（否则客户端按 keep-alive 复用连接却拿到 EOF）。
    ///   视频流是 AVPlayer 独立发起的请求，靠连接关闭判断 body 结束是标准 HTTP/1.1 语义，
    ///   不会触发主文档那类「等不到 body 边界」的问题。
    private static func partialResponse(data: Data, start: Int64, total: Int64, key: String) -> HttpResponse {
        let end = start + Int64(data.count) - 1
        let mime = mimeFor(key)
        let headers: [String: String] = [
            "Content-Type": mime,
            "Content-Length": "\(data.count)",
            "Content-Range": "bytes \(start)-\(end)/\(total)",
            "Accept-Ranges": "bytes",
            "Connection": "close"
        ]
        return .raw(206, "Partial Content", headers, { writer in
            try writer.write(data)
        })
    }

    private static func mimeFor(_ key: String) -> String {
        switch (key as NSString).pathExtension.lowercased() {
        case "mp4", "m4v": return "video/mp4"
        case "mov": return "video/quicktime"
        case "m3u8": return "application/vnd.apple.mpegurl"
        default: return "video/mp4"
        }
    }
}
