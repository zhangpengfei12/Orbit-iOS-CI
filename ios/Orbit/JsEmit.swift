import Foundation

// MARK: - 原生 → JS 全局出口
//
// RootViewController 启动时把 webView 的 evaluateJavaScript 注入 sink；
// 服务器端点（Swifter 线程，无 webView 引用）回传前端也统一走这里。
// 回调形式保持与安卓 notifyJs 同构："window.__onXxx && window.__onXxx(...)"。
//
// ⚠ 本类型原先与蓝牙实现（BtLink.swift）同文件。移除蓝牙连接方式时若一并删掉，
//   会让 AppDelegate / NativePlayer / OsrLink / RootViewController / TiltSource 等
//   十余处报 "cannot find 'JsEmit' in scope"，CI 编译直接失败、IPA 无法上传。
//   故独立成文件，且**不要**再把它并入任何可能被整体删除的能力模块。
enum JsEmit {
    static var sink: ((String) -> Void)?
    static func js(_ js: String) {
        DispatchQueue.main.async {
            sink?(js)
        }
    }
}
