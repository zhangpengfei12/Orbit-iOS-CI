import Foundation
import Swifter

/// 系统类端点：status / progress / refresh / license/*。
/// 全部为纯逻辑，不依赖硬件与真机，CI 可验证编译且行为可自测。
enum ApiSystem {

    static func register(into server: HttpServer) {

        // GET /api/status —— 首页/关于页读版本与授权状态
        server.get["/api/status"] = { _ in
            let cfg = OrbitConfig.shared
            let info = Bundle.main.infoDictionary
            return json([
                "ok": true,
                "version": (info?["CFBundleShortVersionString"] as? String) ?? "1.0.0",
                "build": (info?["CFBundleVersion"] as? String) ?? "0",
                "brand": cfg.string(forKeyPath: "brand", default: "Orbit"),
                "platform": "ios",
                "license": License.status()
            ])
        }

        // POST /api/progress —— 扫描/分析进度上报（安卓用于回显进度条）
        server.post["/api/progress"] = { _ in
            Diagnostics.shared.log("PROGRESS", "收到进度上报")
            return json(["ok": true])
        }

        // POST /api/refresh —— 刷新媒体库
        server.post["/api/refresh"] = { _ in
            Diagnostics.shared.log("REFRESH", "请求刷新媒体库")
            return json(["ok": true, "scanned": 0])
        }

        // GET /api/license/machine —— 取本机机器码（诊断/激活页用）
        server.get["/api/license/machine"] = { _ in
            return json(["ok": true, "machine": License.machineCode()])
        }

        // GET /api/license/status —— 授权状态
        server.get["/api/license/status"] = { _ in
            return json(License.status())
        }

        // GET /api/license/start-trial —— 开启试用
        server.get["/api/license/start-trial"] = { _ in
            let now = Int(Date().timeIntervalSince1970)
            let deadline = now + 3 * 86400
            OrbitConfig.shared.set([
                "startedAt": now,
                "deadline": deadline,
                "began": true
            ], forKeyPath: "trial")
            return json([
                "ok": true,
                "startedAt": now,
                "deadline": deadline
            ])
        }

        // POST /api/license/activate —— 用卡密激活
        server.post["/api/license/activate"] = { req in
            guard let body = parseJSON(req),
                  let card = body["card"] as? String else {
                return apiError("missing_card")
            }
            let t = License.activate(card)
            if t.ok {
                return json([
                    "ok": true,
                    "state": "activated",
                    "expireAt": t.expireAt,
                    "kind": t.kind
                ])
            }
            return apiError(t.code)
        }
    }
}
