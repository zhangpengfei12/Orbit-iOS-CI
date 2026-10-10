import Foundation
import Swifter

/// 媒体库端点（本机沙盒真实实现），覆盖 ApiStubs 里的空列表占位。
///
/// 必须注册在 ApiStubs **之后**：ApiRouter 里后注册的同名路径会覆盖前者。
/// 覆盖的动机不是"让它不 404"，而是 ApiStubs 的占位语义本身有害：
///   · `/api/items` 返回 `{items: []}` → 前端判定「新 API 可用」→ 不再回退旧接口
///     → 导入了视频也永远显示「暂无影片」；
///   · `/api/items/:id` 返回 `{ok:true, item:{}}` → 详情页 showDetail({}) → 标题空白、
///     currentDetailId 变 undefined，后续收藏/播放全部失灵。
enum ApiLibrary {

    static func register(into server: HttpServer) {

        // ── 首页 / 分类列表 ──
        // 先扫一遍再返回：导入后不扫的话新视频不会出现在索引里。
        // 扫描是「列目录 + 排序」，几十个文件耗时可忽略；真到几百个再改成增量。
        server.get["/api/items"] = { req in
            let q = queryParams(req)
            let page = max(1, Int(q["page"] ?? "") ?? 1)
            let size = max(1, min(200, Int(q["size"] ?? "") ?? 24))
            MediaIndex.shared.rescan()
            let (items, total) = MediaIndex.shared.items(page: page, size: size,
                                                         scope: q["scope"],
                                                         actor: q["actor"],
                                                         genre: q["genre"])
            return json(["ok": true, "items": items as [Any], "total": total])
        }

        // ── 单个条目详情 ──
        server.get["/api/items/:id"] = { req in
            guard let id = Self.itemId(req) else { return apiError("bad_id") }
            guard var d = MediaIndex.shared.item(id: id) else { return apiError("not_found") }
            d["ok"] = true
            return json(d)
        }

        // ── 封面：按需抽帧并缓存 ──
        server.get["/api/items/:id/poster"] = { req in
            guard let id = Self.itemId(req) else { return .notFound }
            guard let file = MediaIndex.shared.fileURL(id: id),
                  let data = PosterStore.shared.jpeg(id: id, fileURL: file) else { return .notFound }
            return .ok(.data(data, contentType: "image/jpeg"))
        }

        // ── 收藏：前端会先用 d.isFavorite 回写，再拿 d.item 刷新 ──
        server.post["/api/items/:id/favorite"] = { req in
            guard let id = Self.itemId(req) else { return apiError("bad_id") }
            let body = parseJSON(req) ?? [:]
            let on = (body["favorite"] as? Bool) ?? true
            guard let d = MediaIndex.shared.setFavorite(id: id, on: on) else { return apiError("not_found") }
            var out = d; out["ok"] = true
            return json(out)
        }

        // ── 播放计数（前端用 sendBeacon 打，失败也无所谓）──
        server.post["/api/items/:id/play"] = { req in
            if let id = Self.itemId(req) { MediaIndex.shared.bumpPlay(id: id) }
            return json(["ok": true])
        }

        // ── 元数据编辑：真落盘，否则改完刷新就没了 ──
        server.post["/api/items/:id/metadata"] = { req in
            guard let id = Self.itemId(req) else { return apiError("bad_id") }
            // ⚠ sendBeacon 发的 body 是 text/plain，request.body 仍可读，不强求 JSON
            guard var d = MediaIndex.shared.updateMetadata(id: id, parseJSON(req) ?? [:]) else {
                return apiError("not_found")
            }
            d["ok"] = true
            return json(d)
        }

        // ── 重新刮削 / 重新生成封面：iOS 没有刮削器，只清缓存让下次请求重新抽帧 ──
        server.post["/api/items/:id/regenerate-thumb"] = { req in
            guard let id = Self.itemId(req) else { return apiError("bad_id") }
            PosterStore.shared.invalidate(id: id)
            return json(["ok": true, "regenerated": true])
        }
        server.post["/api/items/:id/refresh-nfo"] = { req in
            guard let id = Self.itemId(req) else { return apiError("bad_id") }
            // 文件名即标题，没有 NFO 可刮；回一条明确说明而不是假装成功
            return json(["ok": true, "nfo": false,
                         "note": "iOS 版不做 NFO 刮削，标题取自文件名，可在详情页手动编辑"] as [String: Any])
        }

        // ── 旧接口 /api/videos：前端在 /api/items 拿不到 items 字段时会回退到这里 ──
        server.get["/api/videos"] = { _ in
            MediaIndex.shared.rescan()
            let (items, _) = MediaIndex.shared.items(page: 1, size: 1000, scope: nil,
                                                    actor: nil, genre: nil)
            let videos: [[String: Any]] = items.map { it in
                ["name": it["folderName"] as? String ?? "",
                 "displayName": it["title"] as? String ?? "",
                 "id": it["id"] ?? 0,
                 "isSmb": false,
                 "isFavorite": it["isFavorite"] ?? false]
            }
            return json(["ok": true, "videos": videos as [Any], "loading": false, "total": videos.count])
        }

        // ── 旧接口 /thumbnail/<视频相对路径> ──
        // 浏览列表与旧模式卡片都在用它（app.js 里 5 处）。不接的话视频墙全是空框。
        server.get["/thumbnail/:name"] = { req in
            let raw = req.params[":name"] ?? req.params["name"] ?? ""
            // Swifter 给的是已解码还是未解码不确定：两种都试一次，取能落到文件的那个
            let candidates = [raw, raw.removingPercentEncoding ?? raw]
            for c in candidates {
                guard !c.isEmpty, let file = MediaIndex.shared.fileURL(rel: c),
                      FileManager.default.fileExists(atPath: file.path),
                      let data = PosterStore.shared.jpeg(key: c, fileURL: file) else { continue }
                return .ok(.data(data, contentType: "image/jpeg"))
            }
            return .notFound
        }

        // 注：/api/refresh 保留在 ApiMedia（那里顺带重建索引），这里不再重复注册，
        //     免得后注册把它的响应结构改掉。
    }

    /// 从 Swifter 的 :id 段取条目 id。
    /// ⚠ 不能自己切 request.path——路径里可能带查询串（?v=缓存戳），切出来会带尾巴。
    private static func itemId(_ req: HttpRequest) -> Int? {
        if let s = req.params[":id"] { return Int(s) }
        // 兜底：Swifter 某些版本把具名参数放在 params["id"]（不带冒号）
        if let s = req.params["id"] { return Int(s) }
        return nil
    }
}
