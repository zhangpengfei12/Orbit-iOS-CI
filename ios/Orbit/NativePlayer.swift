import AVKit
import AVFoundation
import UIKit

// MARK: - iOS 原生播放器（AVPlayerViewController）
//
// 为什么需要它：WKWebView 的 <video> 在 iOS 上对 HEVC/H.265 支持不完整
// （WebView 认 hvc1 不认 hev1 封装变体，用户实测播放页直接报「不支持」），
// 且 iOS 15+ 内联播放策略多变。系统 AVPlayerViewController 走硬件解码，
// H.264 / HEVC / ProRes 全格式通吃，还自带全屏手势、画中画、音轨/字幕选择。
//
// 入口：前端 player.js「用系统播放器打开」按钮，或 WebView 播放失败时自动转
//   → window.Orbit.openVideoExternal(key) → OsrLink.handle → NativePlayer.shared.play(key)
//
// 数据源：App 内置 Swifter 服务器的 /video/<key>（ApiVideo：沙盒本地优先、SMB 兜底，
// 已支持 HTTP Range 206 —— AVPlayer 拖动进度条与 seek 全靠它）。
// 端口与安卓对齐（8787），同源相对路径前端 88 处 fetch 都靠它。

final class NativePlayer: NSObject {
    static let shared = NativePlayer()

    private var player: AVPlayer?
    private var playerVC: AVPlayerViewController?
    private var observers: [NSObjectProtocol] = []
    private var notified = false   // 失败事件可能从多个通知进来，只报一次

    private override init() {
        super.init()
    }

    /// 播放媒体库中的一个视频。key 是前端 videoName（相对媒体根或 SMB 共享的路径）。
    /// 已在使用时先停掉上一首，避免播放器叠播。
    func play(key: String) {
        DispatchQueue.main.async {
            let trimmed = key.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard !trimmed.isEmpty else {
                Diagnostics.shared.log("PLAY", "原生播放：key 为空，忽略")
                return
            }
            self.stop()

            // 与前端 player.js:177 同一拼法：逐段 encodeURIComponent。
            // ApiVideo.handle 里会 removingPercentEncoding 还原，两边必须成对。
            let enc = trimmed.components(separatedBy: "/")
                .map { $0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? $0 }
                .joined(separator: "/")
            let urlStr = "http://127.0.0.1:\(OrbitServer.port)/video/\(enc)"
            guard let url = URL(string: urlStr) else {
                Diagnostics.shared.log("PLAY", "原生播放：URL 非法 \(urlStr)")
                self.emitError("播放地址无效")
                return
            }

            // 先探一次可达性（本地 127.0.0.1 服务，毫秒级）：
            // 404 = 本地没这文件且 SMB 未连/没这路径。AVPlayer 对这类失败的描述是
            // 「操作无法完成」这种废话，提前探测能把明确原因回给前端错误块。
            var probe = URLRequest(url: url)
            probe.setValue("bytes=0-0", forHTTPHeaderField: "Range")
            URLSession.shared.dataTask(with: probe) { [weak self] _, resp, err in
                DispatchQueue.main.async {
                    let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                    guard code == 200 || code == 206 else {
                        let reason: String
                        switch code {
                        case 404: reason = "视频不存在（本地未导入，或 SMB 共享未连接 / 路径不存在）"
                        case 0:   reason = err?.localizedDescription ?? "取流失败"
                        default:  reason = "服务器返回 \(code)"
                        }
                        Diagnostics.shared.log("PLAY", "原生播放探测失败 [\(code)]：\(reason)")
                        self?.emitError(reason)
                        return
                    }
                    self?.presentPlayer(url: url)
                }
            }.resume()
        }
    }

    /// 关闭播放器（不一定是播放结束：用户点了完成按钮 / 交互上滑）
    func stop() {
        for obs in observers { NotificationCenter.default.removeObserver(obs) }
        observers.removeAll()
        player?.pause()
        player = nil
        if let vc = playerVC, vc.presentingViewController != nil {
            vc.dismiss(animated: true)
        }
        playerVC = nil
    }

    // MARK: - 内部

    private func presentPlayer(url: URL) {
        guard let top = MediaPicker.topViewController() else {
            Diagnostics.shared.log("PLAY", "原生播放：拿不到顶层控制器")
            emitError("无法打开播放器界面")
            return
        }

        let item = AVPlayerItem(url: url)
        let player = AVPlayer(playerItem: item)
        let vc = AVPlayerViewController()
        vc.player = player
        vc.allowsPictureInPicturePlayback = true
        self.player = player
        self.playerVC = vc
        self.notified = false

        // 播放结束：dismiss 并通知前端（用于刷新播放计数等）
        observers.append(NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main)
        { [weak self] _ in
            self?.dismissAndNotify()
        })
        // 播放失败（取流中断等）：把原因带给前端。与 NewErrorLogEntry 可能双触发，
        // 由 notified 去重。
        observers.append(NotificationCenter.default.addObserver(
            forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main)
        { [weak self] note in
            let msg = (note.userInfo?["error"] as? Error)?.localizedDescription ?? "播放中断"
            Diagnostics.shared.log("PLAY", "原生播放失败：\(msg)")
            self?.dismissAndNotify(error: msg)
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: .AVPlayerItemNewErrorLogEntry, object: item, queue: .main)
        { _ in
            if let ev = item.accessLog().events.last {
                Diagnostics.shared.log("PLAY", "原生播放错误日志：\(ev.errorComment ?? "无备注")")
            }
        })

        Diagnostics.shared.log("PLAY", "原生播放器打开：\(url.lastPathComponent)")
        top.present(vc, animated: true) {
            player.play()
        }
    }

    private func dismissAndNotify(error: String? = nil) {
        guard !notified else { return }
        notified = true
        stop()
        if let error {
            emitError(error)
        } else {
            JsEmit.js(buildCallback("__onNativePlayerEnded", [.string("")]))
        }
    }

    private func emitError(_ msg: String) {
        JsEmit.js(buildCallback("__onNativePlayerError", [.string(msg)]))
    }
}
