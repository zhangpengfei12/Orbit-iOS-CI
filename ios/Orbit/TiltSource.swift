import Foundation
import CoreMotion
import UIKit

// MARK: - 触板「陀螺仪 / 摇一摇」模式的姿态源（iOS 原生）
//
// 为什么不能沿用网页的 deviceorientation 兜底：
//   iOS 13+ 起 DeviceOrientationEvent 必须经 `requestPermission()` 用户手势授权，
//   而 WKWebView 里前端（touchpad.js）从未调用它 —— 结果就是事件永不触发，
//   触板切成「陀螺仪」模式后永远停在「等待姿态数据…」。
//   同时 startTilt 在桥上被 Proxy 兜底成"永远存在"，前端那条兜底分支根本进不去。
//   所以 iOS 必须由 CoreMotion 直接喂数据。
//
// 回调约定（对齐安卓 OrbitBridge 的 __onOrbitTilt）：
//   x = 左右倾角（右倾为正，度）  y = 前后倾角（上抬为正，度）
//   shake = 竖直摇动强度（m/s²）  shakeX = 水平横摇强度（m/s²，右为正）
// 前端只把它转发给 __activeTiltSink === 'tp' 的活动面板，不会同时驱动两块面板。

final class TiltSource {

    static let shared = TiltSource()

    private let manager = CMMotionManager()
    private let queue = OperationQueue()
    private var running = false

    private init() {
        queue.name = "orbit.tilt"
        queue.maxConcurrentOperationCount = 1
    }

    /// 设备是否真的有姿态硬件（前端 hasTilt 的语义）。
    var isAvailable: Bool { manager.isDeviceMotionAvailable }

    /// 采样频率：60Hz 足够喂 UI，再高只是白耗电（前端自己还有 200ms 的提示节流）。
    private static let hz: Double = 60

    func start() {
        guard manager.isDeviceMotionAvailable else {
            Diagnostics.shared.log("TILT", "设备不支持 DeviceMotion，姿态模式无数据")
            return
        }
        if running { return }
        running = true
        manager.deviceMotionUpdateInterval = 1.0 / TiltSource.hz
        // 参考系：x 轴指向磁北会让手机在屋子里走两步就漂；用「起始姿态对齐」更稳。
        manager.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: queue) { [weak self] motion, err in
            guard let self, self.running else { return }
            if let err {
                Diagnostics.shared.log("TILT", "姿态更新出错：\(err)")
                return
            }
            guard let m = motion else { return }
            let x = m.attitude.roll * 180.0 / .pi    // 左右
            let y = m.attitude.pitch * 180.0 / .pi   // 前后
            // 线性加速度（已扣除重力）。摇一摇模式要的是「沿世界竖直 / 水平」的分量，
            // 直接拿设备轴会在手机斜着拿时串味：这里用 gravity 反推世界竖直方向再投影。
            let g = m.gravity
            let ua = m.userAcceleration
            let shake = -(ua.x * g.x + ua.y * g.y + ua.z * g.z)   // 沿世界"上"方向
            let shakeX = ua.x                                      // 设备左右轴（横摇近似）
            TiltSource.emit(x, y, shake, shakeX)
        }
        Diagnostics.shared.log("TILT", "姿态源已启动")
    }

    func stop() {
        guard running else { return }
        running = false
        manager.stopDeviceMotionUpdates()
        Diagnostics.shared.log("TILT", "姿态源已停止")
    }

    /// 回传前端。必须在主线程（evaluateJavaScript 只能在主线程跑）。
    private static func emit(_ x: Double, _ y: Double, _ shake: Double, _ shakeX: Double) {
        let js = buildCallback("__onOrbitTilt", [.double(x), .double(y),
                                                 .double(shake), .double(shakeX)])
        if Thread.isMainThread {
            JsEmit.js(js)
        } else {
            DispatchQueue.main.async { JsEmit.js(js) }
        }
    }
}
