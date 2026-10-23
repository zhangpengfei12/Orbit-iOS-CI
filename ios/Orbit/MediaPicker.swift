import UIKit
import PhotosUI
import UniformTypeIdentifiers

// MARK: - iOS 视频选择器（相册 + 文件）
//
// 为什么不能直接复用安卓的「选文件夹」：
// 安卓有 SAF —— 授权一个系统文件夹后，服务端就能持续遍历并取流；
// iOS 没有这套机制（App 只能读自己沙盒），所以 iOS 的正解是
// **把视频拷进 App 沙盒再播**（MediaStore），入口只能是系统选择器。
//
// 这里提供两个来源，由用户自己挑：
//   · 相册视频：PHPickerViewController（系统托管，无需相册权限弹窗）
//   · 文件：UIDocumentPickerViewController（asCopy，含 iCloud / 其他 App 的文件）
//
// ⚠ 两者给的都是**临时文件 URL**（PHPicker 的会在回调结束后被系统清掉），
//   必须在回调里立刻拷走到自己的沙盒，不能拿着 URL 异步处理。
//
// ⚠ 相册路径的三个真实坑（2026-10-23 排查「相册视频导不进 App」时补齐）：
//   1) `PHPickerConfiguration(photoLibrary: .shared())` 会关联 PHPhotoLibrary，
//      未声明 NSPhotoLibraryUsageDescription 时可能被系统静默拦掉。改用无参 init。
//      （Info.plist 已补该描述串，双保险。）
//   2) 单个素材的 `loadFileRepresentation` 对 iCloud 未下载 / 特殊编码的视频会直接
//      报错且**不重试**，用户看到的就是「选完什么都没发生」。这里加 loadItem 兜底。
//   3) 回调可能长时间不返回（大视频下载中），group 永不 notify → 选择器卡在屏幕上。
//      这里加 45 秒超时收尾，并把失败原因用系统弹窗讲清楚。

final class MediaPicker: NSObject, UIDocumentPickerDelegate, PHPickerViewControllerDelegate {

    static let shared = MediaPicker()

    private var completion: (([URL]) -> Void)?
    private var wantsSingle = false

    /// 一次性收尾保护：正常回调 / 超时兜底 / 取消 三条路都可能走到 finish，
    /// 只让第一条生效（否则 completion 会被调两次、picker 被 dismiss 两次）。
    private let stateLock = NSLock()
    private var didComplete = false

    private override init() { super.init() }

    // MARK: - 入口

    /// 弹出来源选择，并把用户选中的文件（已拷到临时转存位置）回调出去。
    /// - Parameter multiple: 是否允许多选（「添加视频到媒体库」= true，录制选片 = false）。
    func presentFromTop(multiple: Bool, completion: @escaping ([URL]) -> Void) {
        DispatchQueue.main.async {
            self.stateLock.lock()
            self.didComplete = false
            self.stateLock.unlock()
            self.completion = completion
            self.wantsSingle = !multiple
            guard let top = Self.topViewController() else {
                Diagnostics.shared.log("PICK", "拿不到顶层控制器，选择器无法弹出")
                self.finish([])
                return
            }
            let sheet = UIAlertController(
                title: "添加视频",
                message: "iOS 不支持直接浏览系统文件夹，请从相册或「文件」里选择视频。\n选中后会导入到 App 媒体库再播放（mp4 / mov 可直接播，mkv / avi 等需先转码）。",
                preferredStyle: .actionSheet)
            sheet.addAction(UIAlertAction(title: "从相册选视频", style: .default) { [weak self] _ in
                self?.openPhotoPicker(multiple: multiple)
            })
            sheet.addAction(UIAlertAction(title: "从「文件」选", style: .default) { [weak self] _ in
                self?.openDocumentPicker(multiple: multiple)
            })
            sheet.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in
                self?.finish([])
            })
            // iPad 必须给落点：否则 actionSheet 直接崩溃
            if let pc = sheet.popoverPresentationController {
                pc.sourceView = top.view
                pc.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
                pc.permittedArrowDirections = []
            }
            top.present(sheet, animated: true)
        }
    }

    // MARK: - 配脚本（只挑 .funscript）
    //
    // 场景：视频从「相册」导入，脚本只能存在「文件」App 里，两边名字对不上，
    // 一起导入也配不成对。这里单独开一条只认脚本的选择通道，选中后由
    // MediaStore.attachScripts 按视频名改名落到同目录。

    func presentScriptPicker(completion: @escaping ([URL]) -> Void) {
        DispatchQueue.main.async {
            self.stateLock.lock()
            self.didComplete = false
            self.stateLock.unlock()
            self.completion = completion
            self.wantsSingle = false        // 多轴脚本（L0/R0/R1）允许一次选全
            guard let top = Self.topViewController() else {
                Diagnostics.shared.log("PICK", "拿不到顶层控制器，「配脚本」选择器无法弹出")
                self.finish([])
                return
            }
            let vc = UIDocumentPickerViewController(forOpeningContentTypes: Self.scriptContentTypes(), asCopy: true)
            vc.delegate = self
            vc.allowsMultipleSelection = true
            top.present(vc, animated: true)
        }
    }

    /// 脚本选择器放行的类型。
    /// - `app.orbit.funscript`：本 App 在 Info.plist 里声明的导入类型（conforms public.json）；
    /// - `.json`：不少工具导出的脚本直接用 .json 后缀，一并放行，落地时统一改名成 .funscript；
    /// - 兜底 `.item`：万一自定义 UTI 没注册成功（旧包），至少不会给用户一个全灰的空列表。
    private static func scriptContentTypes() -> [UTType] {
        var types: [UTType] = []
        if let t = UTType("app.orbit.funscript") {
            types.append(t)
        } else if let t = UTType(filenameExtension: "funscript") {
            types.append(t)
        }
        if let j = UTType(filenameExtension: "json"), !types.contains(j) {
            types.append(j)
        }
        return types.isEmpty ? [.item] : types
    }

    // MARK: - 文件（Files / iCloud / 其他 App）

    private func openDocumentPicker(multiple: Bool) {
        // ⚠ actionSheet 的按钮回调里立刻 present 另一个控制器，UIKit 常因
        //   「presentation is in progress」把这次弹出丢掉（表现：点了没反应）。
        //   延后一拍等 actionSheet 收完再弹。
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            // .item = 全部文件类型：除了常见视频，也放行 .funscript（脚本随视频一起导入）。
            // 只写 .movie / .video 的话，mkv 与 funscript 会被系统置灰选不了。
            let vc = UIDocumentPickerViewController(forOpeningContentTypes: [.item, .movie], asCopy: true)
            vc.delegate = self
            vc.allowsMultipleSelection = multiple
            Self.topViewController()?.present(vc, animated: true)
        }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        // asCopy=true 时这些 URL 是系统拷好的副本（位于临时目录）。
        // 它们的生命周期不归我们管，因此统一交给 MediaStore 再拷进 App 沙盒。
        let picked = wantsSingle ? Array(urls.prefix(1)) : urls
        finish(picked)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finish([])
    }

    // MARK: - 相册视频

    private func openPhotoPicker(multiple: Bool) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            guard let top = Self.topViewController() else { return }
            // 无参 init 是 PHPicker 唯一「完全零权限」的路径（不关联 PHPhotoLibrary）。
            // 传 photoLibrary: .shared() 会走相册关联逻辑，没声明权限描述时可能被拦。
            var cfg = PHPickerConfiguration()
            cfg.filter = .videos
            cfg.selectionLimit = multiple ? 0 : 1
            let vc = PHPickerViewController(configuration: cfg)
            vc.delegate = self
            top.present(vc, animated: true)
        }
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        guard !results.isEmpty else {
            picker.dismiss(animated: true) { self.finish([]) }
            return
        }
        let wanted = wantsSingle ? Array(results.prefix(1)) : results
        // 用引用类型收集结果：completion 会在不同线程回调，直接捕获 var 在
        // Swift 6 严格并发检查下会编译失败（reference to captured var）。
        let result = PickResult()
        let outLock = NSLock()
        let group = DispatchGroup()

        for item in wanted {
            // 相册素材常注册多种表示（public.mpeg-4 / com.apple.quicktime-movie ...）。
            // 优先挑「符合 public.movie」的那个；挑不到就用 .movie 兜底。
            let provider = item.itemProvider
            let type = provider.registeredTypeIdentifiers
                .first(where: { UTType($0)?.conforms(to: .movie) == true })
                ?? UTType.movie.identifier
            Diagnostics.shared.log("PICK", "相册素材类型 [\(provider.registeredTypeIdentifiers.joined(separator: ", "))] → 选用 \(type)")

            group.enter()
            Self.exportToTemp(provider: provider, type: type) { tmp, err in
                defer { group.leave() }
                if let tmp = tmp {
                    outLock.lock(); result.urls.append(tmp); outLock.unlock()
                } else {
                    let msg = err ?? "无法读取相册素材"
                    outLock.lock(); if result.error == nil { result.error = msg }; outLock.unlock()
                    Diagnostics.shared.log("PICK", "相册视频导出失败：\(msg)")
                }
            }
        }

        // 兜底 ①：45 秒还没全部回来就收摊。
        // iCloud 大视频的 loadFileRepresentation 可能长时间不回调，不能让选择器永远停在屏幕上。
        let timer = DispatchWorkItem {
            outLock.lock(); let snapshot = result.urls; outLock.unlock()
            Diagnostics.shared.log("PICK", "相册导出超时（45s）：已收 \(snapshot.count)/\(wanted.count) 个")
            picker.dismiss(animated: true) { self.finish(snapshot) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 45, execute: timer)

        // 兜底 ②：全部回调完成 → 正常收尾（取消定时器，避免重复 dismiss）。
        group.notify(queue: .main) {
            timer.cancel()
            outLock.lock()
            let urls = result.urls
            let err = result.error
            outLock.unlock()
            picker.dismiss(animated: true) {
                self.finish(urls)
                if urls.isEmpty, let err = err {
                    Self.alert("相册视频导入失败", Self.friendlyPhotoError(err))
                }
            }
        }
    }

    /// 跨线程收集相册导出结果（引用类型，避免并发闭包捕获 var）。
    private final class PickResult {
        var urls: [URL] = []
        var error: String?
    }

    // MARK: - 相册素材导出（两级兜底）

    /// 把 PHPicker 的 item provider 导成临时文件。
    /// - 首选 `loadFileRepresentation`：直接给文件 URL，最省内存。
    /// - 兜底 `loadItem`：部分 HEVC / iCloud 素材第一条路直接报错，第二条路仍能拿到 URL 或 Data。
    private static func exportToTemp(provider: NSItemProvider, type: String,
                                     completion: @escaping (URL?, String?) -> Void) {
        provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
            if let url = url, let tmp = copyToTemp(url) {
                completion(tmp, nil)
                return
            }
            let first = error?.localizedDescription
            Diagnostics.shared.log("PICK", "loadFileRepresentation 失败（\(first ?? "nil")），改用 loadItem 兜底")

            provider.loadItem(forTypeIdentifier: type, options: nil) { item, err in
                if let u = (item as? URL) ?? (item as? NSURL).map({ $0 as URL }),
                   let tmp = copyToTemp(u) {
                    completion(tmp, nil)
                    return
                }
                if let data = item as? Data, !data.isEmpty {
                    let tmp = FileManager.default.temporaryDirectory
                        .appendingPathComponent("picked-\(UUID().uuidString).mov")
                    if (try? data.write(to: tmp)) != nil {
                        completion(tmp, nil)
                        return
                    }
                }
                completion(nil, err?.localizedDescription ?? first ?? "无法读取该视频")
            }
        }
    }

    private static func copyToTemp(_ src: URL) -> URL? {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(UUID().uuidString)-\(src.lastPathComponent)")
        do {
            try FileManager.default.copyItem(at: src, to: tmp)
            return tmp
        } catch {
            Diagnostics.shared.log("PICK", "转存临时文件失败：\(error.localizedDescription)")
            return nil
        }
    }

    /// 把系统错误翻成用户能照做的中文提示。
    private static func friendlyPhotoError(_ raw: String) -> String {
        "读取该视频失败：\(raw)\n\n常见原因：视频还在 iCloud 里没下载到本机，或编码比较特殊。\n可以先用「照片」App 打开这个视频播放几秒（触发下载），或者改用「从文件选」。"
    }

    // MARK: - 收尾

    private func finish(_ urls: [URL]) {
        stateLock.lock()
        if didComplete {
            stateLock.unlock()
            return
        }
        didComplete = true
        let cb = completion
        completion = nil
        stateLock.unlock()
        cb?(urls)
    }

    /// 弹系统提示。放在 dismiss 之后一点，避免「已有控制器正在 dismiss」时弹不出来。
    static func alert(_ title: String, _ message: String) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            guard let top = topViewController() else { return }
            let a = UIAlertController(title: title, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "知道了", style: .default))
            top.present(a, animated: true)
        }
    }

    /// 顶层可见控制器（含 presented 链）。
    static func topViewController() -> UIViewController? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
        let window = windows.first(where: { $0.isKeyWindow }) ?? windows.first
        var top = window?.rootViewController
        while let presented = top?.presentedViewController {
            top = presented
        }
        return top
    }
}
