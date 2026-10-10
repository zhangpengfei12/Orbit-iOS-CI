import Foundation
import Swifter

/// SMB 浏览端点：/api/smb/browse（显式凭据）与 /api/browse/smb（用已保存设置）。
///
/// 契约对齐安卓 WebServer.kt:316-339 —— 前端 app.js 的 openSmbQuickBrowse() 消费：
///   成功：{ ok, items:[{name,path,isDir,size}], emptyHint? }
///   失败：{ ok:false, error:"人话", debug:{...} }  ← 前端只判 d.error，调试块可复制
///
/// ⚠ 密码「不丢失」规则（安卓 v2.7.47 修的是同一个坑）：快捷浏览弹窗每次打开都会
///   清空密码框（placeholder 提示「留空保持不变」），用户若没重输，前端传来的是空串。
///   此时**必须回退到已保存的密码**，否则「空密码覆盖已存密码」会表现成莫名其妙的
///   拒绝访问。domain 同理。
enum ApiSmb {

    static func register(into server: HttpServer) {
        server.get["/api/smb/browse"] = { req in
            handleBrowse(req, preferSaved: false)
        }
        server.get["/api/browse/smb"] = { req in
            handleBrowse(req, preferSaved: true)
        }
    }

    // MARK: - 浏览

    private static func handleBrowse(_ req: HttpRequest, preferSaved: Bool) -> HttpResponse {
        let q = queryParams(req)
        let saved = OrbitConfig.shared.dictionary(forKeyPath: "settings.smb")

        // preferSaved=true 的 /api/browse/smb 完全以已保存设置为准（设置页选路径场景）
        func pick(_ key: String) -> String {
            let explicit = q[key] ?? ""
            if preferSaved { return str(saved[key]) }
            // 显式调用时：传了就用传的；没传（或空串）就回落到已保存值
            return explicit.isEmpty ? str(saved[key]) : explicit
        }

        let host = pick("host").trimmingCharacters(in: .whitespaces)
        guard !host.isEmpty else {
            return apiError("请先填写 SMB 主机地址（IP 或计算机名）")
        }

        let anonymous: Bool = {
            if let v = q["anonymous"] { return v == "1" || v.lowercased() == "true" }
            return bool(saved["anonymous"])
        }()

        var creds = SmbCreds(
            host: host,
            share: pick("share").trimmingCharacters(in: .whitespaces),
            user: anonymous ? "" : pick("username"),
            pass: anonymous ? "" : pick("password"),
            domain: anonymous ? "" : pick("domain"),
            anonymous: anonymous
        )

        // 匿名访问：libsmb2 侧统一用 guest 账户，用户名字段不应参与
        if anonymous { creds.user = "guest"; creds.pass = "" }

        let path = q["path"] ?? ""
        let wantFiles = (q["files"] == "1")

        // 共享名留空 = 列出服务器上所有共享（前端会把点中的共享名提升为 share 重进）
        if creds.share.isEmpty {
            switch SmbClient.listShares(creds) {
            case .success(let entries):
                return json(okItems(entries, wantFiles: false))
            case .failure(let f):
                return failureResponse(f)
            }
        }

        switch SmbClient.listDirectory(creds, path: path, files: wantFiles) {
        case .success(let entries):
            return json(okItems(entries, wantFiles: wantFiles))
        case .failure(let f):
            return failureResponse(f)
        }
    }

    // MARK: - 响应组装

    private static func okItems(_ entries: [SmbEntry], wantFiles: Bool) -> [String: Any] {
        let items: [[String: Any]] = entries.map { e in
            ["name": e.name, "path": e.path, "isDir": e.isDir, "size": e.size] as [String: Any]
        }
        var out: [String: Any] = ["ok": true, "items": items]
        if items.isEmpty {
            // 对齐安卓：空结果必须区分语义，不能一律「此目录下没有内容」——
            // 那句会把「共享名写错」也糊成「没内容」，用户根本排查不下去。
            out["emptyHint"] = wantFiles
                ? "此目录下没有视频文件（若共享名或路径不对，也会显示为空）"
                : "此目录下没有子文件夹"
        }
        return out
    }

    private static func failureResponse(_ f: SmbFailure) -> HttpResponse {
        Diagnostics.shared.log("SMB", "失败：\(f.message)")
        return json(["ok": false, "error": f.message, "debug": f.debug] as [String: Any])
    }

    // MARK: - 取值辅助（OrbitConfig 出来的是 NSNumber / String 混合）

    private static func str(_ v: Any?) -> String { (v as? String) ?? "" }

    private static func bool(_ v: Any?) -> Bool {
        if let b = v as? Bool { return b }
        if let n = v as? NSNumber { return n.boolValue }
        return false
    }
}
