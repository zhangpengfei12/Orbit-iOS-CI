import UIKit

/// 诊断页：摇一摇打开，展示版本、web 资源、本地服务状态与日志，可一键分享文本。
final class DiagnosticsViewController: UIViewController {

    private let textView = UITextView()

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "诊断"
        view.backgroundColor = .black

        textView.backgroundColor = .black
        textView.textColor = UIColor(red: 0.7, green: 1.0, blue: 0.7, alpha: 1.0)
        textView.font = UIFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        textView.isEditable = false
        textView.alwaysBounceVertical = true
        textView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(textView)
        NSLayoutConstraint.activate([
            textView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            textView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            textView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            textView.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])

        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "清空日志",
                                                           style: .plain,
                                                           target: self,
                                                           action: #selector(clearLog))
        navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .action,
                                                            target: self,
                                                            action: #selector(share))
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        textView.text = buildReport()
    }

    @objc private func clearLog() {
        Diagnostics.shared.clear()
        textView.text = buildReport()
    }

    @objc private func share() {
        let text = buildReport()
        let activity = UIActivityViewController(activityItems: [text], applicationActivities: nil)
        activity.popoverPresentationController?.barButtonItem = navigationItem.rightBarButtonItem
        present(activity, animated: true)
    }

    private func buildReport() -> String {
        var out: [String] = []
        out.append("===== Orbit iOS 诊断 =====")
        out.append("生成时间: \(Date())")

        // 版本：iOS 版本线与 changelog 的 current 可能对不上，两个都列出来方便核对
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        out.append("")
        out.append("--- 版本 ---")
        out.append("App 版本: \(short) (build \(build))   ← iOS 独立版本线")
        out.append("Bundle ID: \(Bundle.main.bundleIdentifier ?? "?")")
        out.append("系统: \(UIDevice.current.systemName) \(UIDevice.current.systemVersion)")
        out.append("机型: \(UIDevice.current.model)")
        #if targetEnvironment(simulator)
        out.append("运行环境: 模拟器")
        #else
        out.append("运行环境: 真机")
        #endif

        out.append("")
        out.append("--- web 资源（安卓与 iOS 共用同一份）---")
        if let root = Bundle.main.resourceURL?.appendingPathComponent("web") {
            out.append("路径: \(root.path)")
            let fm = FileManager.default
            let wanted = ["home.html", "index.html", "player.html", "js/app.js", "css/app.css"]
            for name in wanted {
                let exists = fm.fileExists(atPath: root.appendingPathComponent(name).path)
                out.append("  \(exists ? "✓" : "✗") \(name)")
            }
            let top = (try? fm.contentsOfDirectory(atPath: root.path)) ?? []
            out.append("顶层条目: \(top.joined(separator: ", "))")
        } else {
            out.append("✗ 未找到 web 资源目录")
        }

        out.append("")
        out.append("--- 本地服务 ---")
        out.append(OrbitServer.shared.diagnosticsInfo())

        out.append("")
        out.append("--- 日志 ---")
        let log = Diagnostics.shared.snapshot()
        out.append(log.isEmpty ? "(空)" : log)

        return out.joined(separator: "\n")
    }
}
