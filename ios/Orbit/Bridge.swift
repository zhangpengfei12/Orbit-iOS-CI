import Foundation

// MARK: - JS 桥：原生 <-> 网页 的纯逻辑连接层
//
// iOS 移植硬约束：原生→网页必须保持「window 挂全局函数 + 字符串 evaluateJavaScript」，
// 不能改成 WKScriptMessageHandler 那套 postMessage 机制——web/js 里的猴子补丁
// （touchpad.js 接管 __onGrantFolder、player.js 给 OrbitNav.handleBack 赋值）会失效。
// 因此：
//   1) JS→原生：注入脚本把 window.Orbit / window.OrbitPlayer / window.OrbitNav 挂成全局转发函数，
//      内部通过 window.webkit.messageHandlers.orbit.postMessage({kind,method,args}) 把调用送回原生。
//   2) 原生→JS：原生计算好后调 buildCallback 生成 "window.__onXxx && window.__onXxx(...)" 字符串，
//      再 webView.evaluateJavaScript 执行（与安卓 notifyJs 同构）。
//
// 本文件只放「纯逻辑」：JsCall 解析、JsArg 编码、buildCallback、方法名枚举、注入脚本生成。
// 真正的 WKWebView 装配在 WebBridge.swift（需 UIKit/WebKit，留待 M1 真机联调）。

/// 桥命名空间（对应安卓 addJavascriptInterface 的三个对象）。
enum BridgeNamespace: String {
    case orbit = "orbit"
    case player = "player"
    case nav = "nav"

    var globalName: String {
        switch self {
        case .orbit: return "Orbit"
        case .player: return "OrbitPlayer"
        case .nav: return "OrbitNav"
        }
    }
}

/// JS 调用参数（已解析成强类型）。
/// 注：不遵循 Equatable —— 含 `Any` 关联值（object/array）无法自动合成 `==`；
/// 等式测试在 Node 黄金测试里做，不依赖 Swift 的 Equatable。
enum JsArg {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case object([String: Any])
    case array([Any])
    case null

    var isNull: Bool { if case .null = self { return true }; return false }

    var asString: String? { if case .string(let s) = self { return s }; return nil }
    var asBool: Bool? { if case .bool(let b) = self { return b }; return nil }
    var asInt: Int? {
        if case .int(let i) = self { return i }
        if case .double(let d) = self { return Int(d) }
        return nil
    }
    var asDouble: Double? {
        if case .double(let d) = self { return d }
        if case .int(let i) = self { return Double(i) }
        return nil
    }
}

/// 一次 JS→原生调用（已从 postMessage 的 JSON 解析出来）。
struct JsCall {
    let namespace: BridgeNamespace
    let method: String
    let args: [JsArg]

    /// 从 messageHandlers 收到的 JSON 解析（{kind, method, args}）。
    static func parse(_ json: [String: Any]) -> JsCall? {
        guard let rawKind = json["kind"] as? String,
              let ns = BridgeNamespace(rawValue: rawKind),
              let method = json["method"] as? String else { return nil }
        let argsRaw = json["args"] as? [Any] ?? []
        let args = argsRaw.map { JsArg.fromAny($0) }
        return JsCall(namespace: ns, method: method, args: args)
    }
}

extension JsArg {
    /// 把任意 JSON 值转成强类型 JsArg。
    static func fromAny(_ v: Any) -> JsArg {
        if v is NSNull { return .null }
        if let b = v as? Bool { return .bool(b) }
        if let i = v as? Int { return .int(i) }
        if let i = v as? Int64 { return .int(Int(i)) }
        if let d = v as? Double { return .double(d) }
        if let f = v as? Float { return .double(Double(f)) }
        if let s = v as? String { return .string(s) }
        if let arr = v as? [Any] { return .array(arr) }
        if let dict = v as? [String: Any] { return .object(dict) }
        return .null
    }
}

// MARK: - 编码：原生→JS 的参数序列化

/// 把一个 JsArg 编码成 JS 字面量片段（与安卓 JSONObject.quote / 对象字面量同构）：
///   string → 带引号转义（JSON 字符串）
///   int/double → 原样数字
///   bool → true/false
///   object/array → JSON 文本（与安卓直接拼 JSONObject 字面量一致）
///   null → null
func encodeJsArg(_ a: JsArg) -> String {
    switch a {
    case .string(let s):
        // 与安卓 JSONObject.quote 等价：整体序列化为 JSON 数组再取中间引号串。
        let arr = [s] as [Any]
        if let data = try? JSONSerialization.data(withJSONObject: arr),
           let json = String(data: data, encoding: .utf8) {
            return String(json.dropFirst().dropLast())  // 去掉 [ ]
        }
        return "\"\""
    case .int(let i): return String(i)
    case .double(let d): return String(d)
    case .bool(let b): return b ? "true" : "false"
    case .object(let o):
        if let data = try? JSONSerialization.data(withJSONObject: o, options: []),
           let s = String(data: data, encoding: .utf8) { return s }
        return "{}"
    case .array(let a):
        if let data = try? JSONSerialization.data(withJSONObject: a, options: []),
           let s = String(data: data, encoding: .utf8) { return s }
        return "[]"
    case .null: return "null"
    }
}

/// 生成 "window.<name> && window.<name>(arg1, arg2)"（对齐安卓 notifyJs 的
/// `window.__onXxx && window.__onXxx(...)`）。回调名（如 __onBtDeviceFound）由调用方传入。
func buildCallback(_ name: String, _ args: [JsArg]) -> String {
    let body = args.map { encodeJsArg($0) }.joined(separator: ", ")
    return "window.\(name) && window.\(name)(\(body))"
}

// MARK: - 方法名清单（文档 + 分发校验）

/// 全部原生方法名（含三个命名空间），与安卓 OrbitBridge / OrbitPlayerBridge 一一对应。
/// 真机联调时 WebBridge 据此分发到 Swift 实现。
enum OrbitMethod: String, CaseIterable {
    // Orbit
    case pickFolder, isDebug, pickVideo, pickVideoManualRec, grantRecordFolder
    case startTilt, stopTilt, hasTilt
    case requestBluetoothPermission, hasBluetoothPermission, openBluetoothSettings, openAppSettings
    case openSettings, startBluetoothScan, stopBluetoothScan
    case connectBluetooth, disconnectBluetooth
    case openDeviceConfig, openWeb, openExternal, openVideoExternal
    case backgroundStatus, checkAppUpdate, downloadAndInstallApk, requestIgnoreBattery
    // OrbitPlayer
    case available, load, loadUri, play, pause, seekMs, setRate, setVolume, setMuted, state, setMode, setFullscreen, release
    // OrbitNav（前端调用、原生实现的）
    case activateTab, openSettingsPanel
    // 注：OrbitNav.handleBack 是前端赋值、原生调用的，不在此枚举（分发时作为 unknown 透传）。
}

// MARK: - 注入脚本生成（保持前端猴子补丁有效）

/// 注入到 WKWebView 的 JS 源码：把三个全局对象挂成转发函数。
/// 用 Proxy + `in target` 优先逻辑：前端覆盖的属性（如 OrbitNav.handleBack）优先返回，
/// 其余未知方法转发给原生 message handler。任何真机执行问题都只影响联调，不影响本文件编译。
func bridgeInjectionScript() -> String {
    return """
    (function(){
      if (window.Orbit) return;  // 防重复注入

      // ⚠⚠ iOS 移植最容易踩的坑：Proxy 的兜底是「任何属性都返回一个函数」，
      //    于是前端 `typeof window.Orbit.xxx === 'function'` 这种存在性判断**恒为 true**。
      //    安卓有、iOS 根本没有的能力会因此走进原生分支干等（点「立即更新」按钮永远转圈、
      //    陀螺仪模式永远不出数据）。凡 iOS 不支持的方法必须显式返回 undefined，
      //    让前端走它自己的兜底或降级提示。
      var ORBIT_DEAD = {
        downloadAndInstallApk: 1,   // iOS 不能安装 APK（更新走 TestFlight / App Store）
        requestIgnoreBattery: 1,    // iOS 没有「电池优化白名单」这套机制
        openVideoExternal:  1       // 沙盒视频无法交给外部播放器，也没有系统 Intent
      };
      // OrbitPlayer 是安卓 ExoPlayer 的代理层。iOS 没有这一层，
      // 而 player.js 用 `typeof OrbitPlayer.load === 'function'` 判定「有原生内核」——
      // Proxy 兜底会让判定恒为 true，播放被整段导向空实现的 nativeProxy，
      // 结果是<video> 不加载、进度条不动、时间轴永远是 0（视频根本不播）。
      // 故 load / loadUri / available 必须返回 undefined，逼 player.js 走网页 <video>。
      var PLAYER_DEAD = { load: 1, loadUri: 1, available: 1 };

      function makeBridge(kind, dead){
        var target = {};
        // iOS 的 messageHandlers 桥无法同步返回值；前端对这几个方法要求同步 bool。
        // 固定语义：蓝牙权限检查恒 true（真实授权流程由原生回调 __onBluetoothPermission
        // 驱动，iOS 首次创建 CBCentralManager 自动弹授权框），isDebug 恒 false。
        // 不预定义的话 hasBluetoothPermission() 返回 undefined → 前端永远停在
        // 「需要蓝牙权限」分支，扫描根本发不起来。
        if (kind === 'orbit') {
          target.hasBluetoothPermission = function(){ return true; };
          target.isDebug = function(){ return false; };
          // iOS 没有「电池优化白名单 / 前台服务 / 唤醒锁」这套东西，后台由系统统一调度。
          // 必须预定义成同步返回字符串：Proxy 的兜底分支是「任何属性都返回函数，调用返回
          // undefined」，前端 JSON.parse(undefined) 会抛错，后台卡片就直接显示「读取失败」。
          target.backgroundStatus = function(){
            return JSON.stringify({platform:'ios', supported:false});
          };
        }
        return new Proxy(target, {
          get: function(t, prop){
            if (typeof prop !== 'string') return undefined;
            if (prop in t) return t[prop];          // 前端覆盖的函数（如 handleBack）
            if (dead && dead[prop]) return undefined;  // iOS 无此能力：让前端降级
            return function(){
              var args = Array.prototype.slice.call(arguments);
              try {
                window.webkit.messageHandlers.orbit.postMessage({kind: kind, method: prop, args: args});
              } catch(e) {}
              return undefined;
            };
          },
          set: function(t, prop, val){ t[prop] = val; return true; }
        });
      }
      window.Orbit = makeBridge('orbit', ORBIT_DEAD);
      window.OrbitPlayer = makeBridge('player', PLAYER_DEAD);
      window.OrbitNav = makeBridge('nav', null);
    })();
    """
}
