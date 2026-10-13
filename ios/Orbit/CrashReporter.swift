import Foundation
import UIKit

/// 轻量崩溃自报器。
///
/// 用途：真机启动崩溃、又拿不到 .ips 时，把崩溃调用栈写进沙盒，
/// 下一次启动弹窗展示，便于直接定位「崩在哪个原生函数」。
///
/// 原理：
/// - NSSetUncaughtExceptionHandler 兜 NSException / Swift 未捕获异常
/// - signal() 兜 SIGABRT/SIGSEGV/SIGBUS/SIGILL/SIGTRAP/SIGFPE
/// - 写盘后恢复默认处理并重新触发信号，让系统照常生成标准崩溃报告（双保险）
///
/// ⚠ handler 必须是**文件作用域的顶层自由函数**：iOS 26 SDK 的 NSSetUncaughtExceptionHandler /
///   signal 要求 @convention(c)，既不接受内联闭包（即便未捕获也被视为捕获上下文），
///   也不接受「类型方法引用」（被判定为带上下文的方法而非裸函数）。

// MARK: - 顶层自由函数（@convention(c) 可用）

private func crashReportSave(kind: String, title: String, frames: String) {
    CrashReporter.saveReport(kind: kind, title: title, frames: frames)
}

private func handleUncaughtException(_ exception: NSException) {
    let frames = exception.callStackSymbols.joined(separator: "\n")
    crashReportSave(kind: "NSException",
                    title: "\(exception.name.rawValue): \(exception.reason ?? "-")",
                    frames: frames)
}

private func handleCrashSignal(_ sig: Int32) {
    var addrs = [UnsafeMutableRawPointer?](repeating: nil, count: 80)
    let count = backtrace(&addrs, Int32(addrs.count))
    let frames: String
    if let syms = backtrace_symbols(&addrs, count) {
        var lines: [String] = []
        for i in 0..<Int(count) {
            if let c = syms[i] { lines.append(String(cString: c)) }
        }
        frames = lines.joined(separator: "\n")
    } else {
        frames = "(backtrace_symbols 不可用)"
    }
    crashReportSave(kind: "SIGNAL", title: "收到信号 \(sig)", frames: frames)
    // 恢复默认处理并重新触发，保留系统崩溃报告
    signal(sig, SIG_DFL)
    raise(sig)
}

// MARK: - 自报器主体

enum CrashReporter {

    private static let crashFile: URL = {
        (FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory()))
            .appendingPathComponent(".orbit_crash.txt")
    }()

    static func install() {
        NSSetUncaughtExceptionHandler(handleUncaughtException)
        for sig in [SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGTRAP, SIGFPE] {
            signal(sig, handleCrashSignal)
        }
    }

    /// 内部：把崩溃信息写盘（供顶层自由函数调用）。
    static func saveReport(kind: String, title: String, frames: String) {
        let now = DateFormatter.localizedString(from: Date(), dateStyle: .medium, timeStyle: .medium)
        let text = """
        Orbit 崩溃自报
        时间: \(now)
        类型: \(kind)
        原因: \(title)

        调用栈:
        \(frames)
        """
        try? text.write(to: crashFile, atomically: true, encoding: .utf8)
    }

    /// 上一次运行是否崩溃过；返回崩溃文本（用于启动弹窗）。
    static func pendingCrashText() -> String? {
        guard FileManager.default.fileExists(atPath: crashFile.path) else { return nil }
        return try? String(contentsOf: crashFile, encoding: .utf8)
    }

    /// 弹窗展示上次崩溃调用栈；复制则清掉文件（避免每次启动都弹），稍后保留。
    static func present(on window: UIWindow, text: String) {
        let alert = UIAlertController(title: "上一版本崩溃自报", message: text, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "复制并关闭", style: .default) { _ in
            UIPasteboard.general.string = text
            try? FileManager.default.removeItem(at: crashFile)
        })
        alert.addAction(UIAlertAction(title: "稍后", style: .cancel) { _ in })
        window.rootViewController?.present(alert, animated: true)
    }
}
