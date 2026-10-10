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

final class MediaPicker: NSObject, UIDocumentPickerDelegate, PHPickerViewControllerDelegate {

    static let shared = MediaPicker()

    private var completion: (([URL]) -> Void)?
    private var wantsSingle = false

    private override init() { super.init() }

    // MARK: - 入口

    /// 弹出来源选择，并把用户选中的文件（已拷到临时转存位置）回调出去。
    /// - Parameter multiple: 是否允许多选（「添加视频到媒体库」= true，录制选片 = false）。
    func presentFromTop(multiple: Bool, completion: @escaping ([URL]) -> Void) {
        DispatchQueue.main.async {
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

    // MARK: - 文件（Files / iCloud / 其他 App）

    private func openDocumentPicker(multiple: Bool) {
        // .item = 全部文件类型：除了常见视频，也放行 .funscript（脚本随视频一起导入）。
        // 只写 .movie / .video 的话，mkv 与 funscript 会被系统置灰选不了。
        let vc = UIDocumentPickerViewController(forOpeningContentTypes: [.item, .movie], asCopy: true)
        vc.delegate = self
        vc.allowsMultipleSelection = multiple
        Self.topViewController()?.present(vc, animated: true)
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
        var cfg = PHPickerConfiguration(photoLibrary: .shared())
        cfg.filter = .videos
        cfg.selectionLimit = multiple ? 0 : 1
        let vc = PHPickerViewController(configuration: cfg)
        vc.delegate = self
        Self.topViewController()?.present(vc, animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        guard !results.isEmpty else {
            picker.dismiss(animated: true) { self.finish([]) }
            return
        }
        let wanted = wantsSingle ? Array(results.prefix(1)) : results
        var out: [URL] = []
        let lock = NSLock()
        let group = DispatchGroup()

        for item in wanted {
            // 优先用「符合 public.movie」的表示类型；取不到就退回 .movie —— 相册里的视频必然支持。
            let provider = item.itemProvider
            let type = provider.registeredTypeIdentifiers
                .first(where: { UTType($0)?.conforms(to: .movie) == true })
                ?? UTType.movie.identifier
            group.enter()
            provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                defer { group.leave() }
                guard let url = url else {
                    Diagnostics.shared.log("PICK", "相册视频导出失败：\(error?.localizedDescription ?? "nil")")
                    return
                }
                // 这个临时文件回调结束后即失效，必须当场拷走
                let tmp = FileManager.default.temporaryDirectory
                    .appendingPathComponent("\(UUID().uuidString)-\(url.lastPathComponent)")
                do {
                    try FileManager.default.copyItem(at: url, to: tmp)
                    lock.lock(); out.append(tmp); lock.unlock()
                } catch {
                    Diagnostics.shared.log("PICK", "相册视频转存失败：\(error.localizedDescription)")
                }
            }
        }

        group.notify(queue: .main) {
            picker.dismiss(animated: true) { self.finish(out) }
        }
    }

    // MARK: - 收尾

    private func finish(_ urls: [URL]) {
        let cb = completion
        completion = nil
        cb?(urls)
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
