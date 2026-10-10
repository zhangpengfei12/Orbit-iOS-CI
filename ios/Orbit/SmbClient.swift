import Foundation
import AMSMB2

// MARK: - SMB 客户端（AMSMB2 / libsmb2 封装）
//
// 对齐安卓 MediaRepository.kt + SmbClient.kt 的对外语义，但底层完全不同：
//   安卓 = jcifs-ng（纯 Java，SMB1/SMB2）
//   iOS  = AMSMB2（libsmb2 的 Swift 封装，SMB2/SMB3）
// 因此安卓那些「jcifs 专属坑」（DFS 多连 IPC$、空域填安卓主机名、需要强制签名）
// 在 iOS 侧不成立——libsmb2 走标准 NTLM 协商，域字段直接由 SMB2Manager(domain:) 传入。
//
// ⚠ 授权协议：AMSMB2 静态链接 libsmb2（LGPL v2.1），README 明确要求上架 App Store
//   必须**动态链接**。project.yml 里该依赖声明为 framework（动态 + embed & sign）。

/// 一次 SMB 访问所需的全部凭据。
struct SmbCreds {
    var host: String
    var share: String
    var user: String
    var pass: String
    var domain: String
    var anonymous: Bool

    /// 用于连接缓存的键：凭据或共享变了就必须重连。
    var cacheKey: String {
        "\(host.lowercased())|\(share)|\(user.lowercased())|\(domain.lowercased())|\(anonymous)|\(pass.count)"
    }
}

/// 目录条目（对应前端 /api/smb/browse 消费的 items[]）。
struct SmbEntry {
    var name: String
    var path: String
    var isDir: Bool
    var size: Int64
}

/// SMB 失败：既给一句能看懂的中文，也给一份可复制的 debug 明细。
/// 前端（app.js openSmbQuickBrowse）在 d.error 存在且有 d.debug 时会渲染调试块与复制按钮。
///
/// ⚠ 必须显式声明 Error：本类型用作 `Result<_, SmbFailure>` 的 Failure 槽位，
///   而 Result 的 Failure 有 `Failure: Error` 约束。漏了这层会让每个返回 Result 的
///   方法都报 "does not conform to protocol 'Error'"，且错误会级联到调用点
///   （表现为完全无关的 "Duration 不能 + Int" 之类怪错，别被误导）。
struct SmbFailure: Error {
    var message: String
    var debug: [String: Any]
}

enum SmbClient {

    /// 单次 SMB 操作的超时（秒）。
    /// 取 20s：局域网内正常连接 <2s；Windows 认证失败会立刻回错，
    /// 真正耗时的只有「主机不可达」这类要等 TCP 超时的场景。
    private static let timeoutSeconds: Double = 20

    // MARK: - 连接缓存

    /// 已连接的共享。AMSMB2 的 connectShare 会走完整 NTLM 协商，
    /// 每次列目录/读文件都重连会让目录浏览明显卡顿，故按凭据缓存。
    /// SMB2Manager 声明为 @unchecked Sendable，但缓存字典本身要加锁。
    private static var managers: [String: SMB2Manager] = [:]
    private static let lock = NSLock()

    private static func manager(for c: SmbCreds) throws -> SMB2Manager {
        let key = c.cacheKey
        lock.lock()
        if let m = managers[key] { lock.unlock(); return m }
        lock.unlock()

        // smb:// 前缀是 SMB2Manager.init 的硬性要求（scheme 不是 smb 会返回 nil）
        guard let url = URL(string: "smb://\(c.host)") else {
            throw SmbError.badHost(c.host)
        }
        // 匿名访问：libsmb2 仍需要一个用户名字面量，guest 是 SMB 约定的匿名账户
        let user = c.anonymous ? "guest" : c.user
        let cred = URLCredential(user: user, password: c.pass, persistence: .forSession)
        guard let m = SMB2Manager(url: url, domain: c.domain, credential: cred) else {
            throw SmbError.badHost(c.host)
        }

        // 共享名为空：说明这次调用只是为了列共享列表，不需要 tree connect。
        // 安卓侧也是这个语义（共享名留空 → 列出服务器上所有共享）。
        if !c.share.isEmpty {
            try sync {
                try await m.connectShare(name: c.share)
            }
        }

        lock.lock()
        managers[key] = m
        lock.unlock()
        return m
    }

    /// 凭据或共享变化时主动丢弃缓存连接（设置页改了 SMB 配置后必须调）。
    static func invalidate() {
        lock.lock()
        let all = Array(managers.values)
        managers.removeAll()
        lock.unlock()
        for m in all {
            try? sync { try await m.disconnectShare(gracefully: false) }
        }
    }

    // MARK: - 对外能力

    /// 列出服务器上的共享名（共享名留空时的浏览模式）。
    static func listShares(_ c: SmbCreds) -> Result<[SmbEntry], SmbFailure> {
        do {
            let m = try manager(for: c)
            let shares: [(name: String, comment: String)] = try sync {
                try await m.listShares(enumerateHidden: false)
            }
            // 隐藏共享（以 $ 结尾，如 C$ / IPC$ / ADMIN$）已经由 enumerateHidden=false 过滤，
            // 这里再兜一层：即便库返回了，也不该出现在用户的视频源列表里。
            let entries = shares
                .filter { !$0.name.hasSuffix("$") }
                .map { SmbEntry(name: $0.name, path: $0.name, isDir: true, size: 0) }
            return .success(entries)
        } catch {
            return .failure(describe(error, creds: c, op: "列出共享"))
        }
    }

    /// 列出共享下的目录/文件。
    /// - Parameter files: false = 只要目录（设置页选路径用）；true = 目录 + 视频文件（快捷浏览用）。
    static func listDirectory(_ c: SmbCreds, path: String, files: Bool) -> Result<[SmbEntry], SmbFailure> {
        do {
            let m = try manager(for: c)
            let raw: [[URLResourceKey: Any]] = try sync {
                try await m.contentsOfDirectory(atPath: normalize(path))
            }
            var out: [SmbEntry] = []
            for item in raw {
                guard let name = item[.nameKey] as? String else { continue }
                // 点目录必须跳过：否则面包屑会多出「.」层级且可能自引用
                if name == "." || name == ".." { continue }
                let full = item[.pathKey] as? String ?? join(path, name)
                let isDir = (item[.fileResourceTypeKey] as? URLFileResourceType) == .directory
                let size = (item[.fileSizeKey] as? NSNumber)?.int64Value ?? 0
                if isDir {
                    out.append(SmbEntry(name: name, path: relative(full), isDir: true, size: 0))
                } else if files && isVideo(name) {
                    out.append(SmbEntry(name: name, path: relative(full), isDir: false, size: size))
                }
            }
            out.sort { (a, b) in
                if a.isDir != b.isDir { return a.isDir }
                return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
            }
            return .success(out)
        } catch {
            return .failure(describe(error, creds: c, op: "列目录", path: path))
        }
    }

    /// 按字节区间读文件。播放器（AVPlayer）靠 Range 请求拖动进度，必须支持。
    static func read(_ c: SmbCreds, path: String, start: Int64, count: Int64) -> Result<Data, SmbFailure> {
        do {
            let m = try manager(for: c)
            let lower = UInt64(max(0, start))
            // AMSMB2 的 range 上界是「开区间」，读 count 字节应是 lower..<(lower+count)
            let upper = lower + UInt64(max(0, count))
            let data: Data = try sync {
                try await m.contents(atPath: normalize(path), range: lower ..< upper)
            }
            return .success(data)
        } catch {
            return .failure(describe(error, creds: c, op: "读文件", path: path))
        }
    }

    /// 取文件大小（播放器首帧要 Content-Length / Content-Range 的总长度）。
    static func sizeOf(_ c: SmbCreds, path: String) -> Result<Int64, SmbFailure> {
        do {
            let m = try manager(for: c)
            // 不写显式类型标注：AMSMB2 的 attributesOfItem 返回
            // [URLResourceKey: any Sendable]，交给推断即可，避免手写 Any 触发转换歧义
            let attrs = try sync {
                try await m.attributesOfItem(atPath: normalize(path))
            }
            let size = (attrs[.fileSizeKey] as? NSNumber)?.int64Value ?? 0
            return .success(size)
        } catch {
            return .failure(describe(error, creds: c, op: "取文件大小", path: path))
        }
    }

    // MARK: - async → sync 桥

    /// Swifter 的路由闭包是同步的（返回 HttpResponse），而 AMSMB2 全是 async。
    /// 这里用 semaphore 等待，且刻意放在**非主线程**执行：
    /// Swifter 的 handler 跑在它自己的 listener 线程上，阻塞它只影响这一个请求，
    /// 不会卡住 UI（主线程）也不会卡住 Swifter 的 accept 循环。
    private static func sync<T>(_ block: @escaping () async throws -> T) throws -> T {
        // ⚠ 结果必须用 class 装箱：Task.detached 的闭包是 @Sendable，
        //   直接捕获 `var box: Result<T, Error>?` 会因 T 未声明 Sendable（如
        //   [[URLResourceKey: Any]]）而报「capture of non-sendable type」。
        //   装箱成 @unchecked Sendable 的引用类型后，捕获的只是一个指针。
        let box = Box<T>()
        let sem = DispatchSemaphore(value: 0)
        // .utility 足够：SMB 操作本身耗在网络等待上，不吃 CPU
        Task.detached(priority: .utility) {
            do { box.value = .success(try await block()) }
            catch { box.value = .failure(error) }
            sem.signal()
        }
        // 超时后放弃等待：宁可让前端显示「连接失败」也不要把请求永久挂住
        if sem.wait(timeout: .now() + timeoutSeconds) == .timedOut {
            throw SmbError.timeout
        }
        guard let r = box.value else { throw SmbError.timeout }
        return try r.get()
    }

    /// async 结果的线程安全容器（见 sync 里的说明）。
    private final class Box<T>: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: Result<T, Error>?
        var value: Result<T, Error>? {
            get { lock.lock(); defer { lock.unlock() }; return storage }
            set { lock.lock(); storage = newValue; lock.unlock() }
        }
    }

    // MARK: - 路径处理

    /// AMSMB2 期望的路径形态：目录带尾斜杠、文件不带；根目录用 "/"。
    private static func normalize(_ path: String) -> String {
        let t = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return t.isEmpty ? "/" : t
    }

    private static func join(_ dir: String, _ name: String) -> String {
        let d = normalize(dir)
        return d == "/" ? name : d + "/" + name
    }

    /// AMSMB2 的 .pathKey 可能带共享名前缀（"Share/folder/file"），
    /// 前端把它原样回填到下一次 browse 的 path 参数会越拼越长，故统一剥掉首段。
    private static func relative(_ full: String) -> String {
        var s = full.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if s.hasPrefix("\\") { s.removeFirst() }
        return s
    }

    private static func isVideo(_ name: String) -> Bool {
        let ext = (name as NSString).pathExtension.lowercased()
        return ["mp4", "m4v", "mov", "mkv", "webm", "avi", "ts", "m2ts", "wmv", "flv"].contains(ext)
    }

    // MARK: - 错误归因

    /// 把底层错误翻成人话，并附上排查用 debug。
    /// 对齐安卓 WebServer.kt 的 debug 契约：前端会把它 JSON 化展示 + 提供复制按钮。
    private static func describe(_ e: Error, creds c: SmbCreds, op: String, path: String = "") -> SmbFailure {
        let ns = e as NSError
        let raw = ns.localizedDescription
        // 自有错误要单独识别：e 的静态类型是 Error（existential），
        // 不能直接在 switch/if 里对 SmbError 的 case 做模式匹配，必须先做类型转换。
        let own = e as? SmbError
        let msg: String
        // libsmb2 把 NTSTATUS 塞进错误描述里，能识别就直接给出可操作的结论
        if raw.contains("STATUS_ACCESS_DENIED") || raw.contains("0xC0000022") {
            msg = "访问被拒绝（Windows 返回 ACCESS_DENIED）。账号密码本身已被接受，"
                + "是主机侧权限策略拒绝了连接：请确认该账户在共享权限与 NTFS 权限两处都已授权，"
                + "并在 Windows 的「高级共享设置」里开启「密码保护的共享」。"
        } else if raw.contains("STATUS_LOGON_FAILURE") || raw.contains("0xC000006D")
            || raw.contains("0xC000006A") || raw.contains("0xC0000064") {
            msg = "用户名或密码不正确（Windows 返回 LOGON_FAILURE）。请检查账号拼写，"
                + "以及是否需要在「域」里填 Windows 计算机名或 .（本机账户）。"
        } else if raw.contains("STATUS_BAD_NETWORK_NAME") || raw.contains("0xC00000CC") {
            msg = "共享名不存在。请检查共享名拼写；也可把共享名留空先列出服务器上所有共享。"
        } else if raw.contains("STATUS_OBJECT_NAME_NOT_FOUND") || raw.contains("0xC0000034") {
            msg = "路径不存在。请确认该目录在共享内确实存在。"
        } else if let o = own, case .timeout = o {
            msg = "连接超时（\(Int(timeoutSeconds)) 秒）。请确认 iPhone 与电脑在同一局域网，"
                + "且电脑防火墙没有拦截 SMB（445 端口）。"
        } else if let o = own, case .badHost = o {
            msg = "主机地址无效，请填写 IP 或主机名。"
        } else {
            msg = "\(op)失败：\(raw)"
        }

        var debug: [String: Any] = [
            "op": op,
            "url": "smb://\(c.host)/\(c.share)",
            "host": c.host,
            "share": c.share,
            "path": path,
            "anonymous": c.anonymous,
            "user": c.anonymous ? "guest" : c.user,
            // 只给长度、绝不给明文：调试信息是要能贴出去给别人看的
            "passLen": c.anonymous ? 0 : c.pass.count,
            "domain": c.domain,
            "error": raw,
            "errorDomain": ns.domain,
            "errorCode": ns.code
        ]
        // 凭据用尽时给一句明确的下一步，避免用户只会看到一句「失败」
        debug["hint"] = "先核对 passLen 是否等于真实密码长度（为 0 说明密码没传到）；"
            + "再看 error 里的 NTSTATUS。"
        return SmbFailure(message: msg, debug: debug)
    }
}

// MARK: - 自有错误

private enum SmbError: Error {
    case timeout
    case badHost(String)
}
