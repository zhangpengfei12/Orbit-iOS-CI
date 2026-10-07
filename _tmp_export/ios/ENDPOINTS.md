# Orbit 本地服务接口契约（iOS 移植基线）

> 本文件是 `WebServer.kt` 路由表的逐条清点，作为 iOS 侧 `OrbitServer.swift` 的实现与验收基线。
> 源码依据：`app/src/main/java/com/orbit/app/server/WebServer.kt`（v2.7.22）。
> **前端共 88 处 `fetch()`，全部是同源相对路径**——iOS 只要守住「8787 端口 + 相同路径 + 相同 JSON 字段名」三件事，前端零改动。

## 一、通用约定（必须照搬，否则前端静默失败）

| 约定 | 内容 |
|---|---|
| 监听地址/端口 | `127.0.0.1:8787`（`WebServer.kt:30`），iOS 需 `Info.plist` 加 `NSAllowsLocalNetworking` |
| 静态资源路由 | `/`→home.html、`/index` `/app`→index.html、`/player*`→player.html（`:859-861`） |
| POST 请求体 | **必须带 `Content-Type: application/json`**。服务端只对这类请求预读 body；用 FormData/multipart 会污染 keep-alive 连接，导致下一次请求被解析成非法报文（`:73-77`） |
| 错误响应 | 未知模块 `404 unknown_api`；方法不符 `405 method_not_allowed`；子命令不认识 `404 unknown_<模块>`。前端靠这些字符串分支，**不能改** |
| 试用拦截 | 被 `LicenseGate.blocked()` 拦截时，除 `license` 与 `status` 外一律 403 + `{"ok":false,"error":"license_blocked"}`（`:101-108`） |
| 视频流 | `GET /video/<key>` 必须支持 HTTP Range（206 + `Content-Range`），见 `:828-854` |

## 二、一级模块（19 个）

| 端点 | 方法 | 源码 | iOS 处置 |
|---|---|---|---|
| `/api/status` | GET | `:115` | 照搬 |
| `/api/progress` | POST | `:116` | 照搬 |
| `/api/libraries` | GET/POST | `:170-218` | 照搬逻辑，路径语义换 bookmark |
| `/api/libraries/<id>/cover` | GET | `:173-181` | 照搬 |
| `/api/items` | GET | `:220-231` | 照搬（分页/筛选参数名一致） |
| `/api/items/<id>` | GET | `:236` | 照搬 |
| `/api/items/<id>/poster` | GET（SVG） | `:240` | 照搬 |
| `/api/items/<id>/metadata` | POST | `:244` | 照搬 |
| `/api/items/<id>/favorite` | POST | `:248` | 照搬 |
| `/api/items/<id>/refresh-nfo` | POST | `:253` | 照搬 |
| `/api/items/<id>/regenerate-thumb` | POST | `:257` | 照搬（当前恒返回 ok） |
| `/api/items/<id>/play` | POST | `:258` | 照搬 |
| `/api/actors` | GET | `:264-268` | 照搬 |
| `/api/actors/<name>` | GET/POST | `:270-279` | 照搬 |
| `/api/browse` | GET | `:283-311` | **重写**：`root` 参数在 Android 是 SAF 树 URI，iOS 改为 bookmark id |
| `/api/smb/browse` | GET | `:314-324` | 重写（AMSMB2） |
| `/api/settings/local` | GET/POST | `:329-337` | 重写（iOS 无 `Environment.getExternalStorageDirectory`） |
| `/api/settings/smb` | GET/POST | `:338-367` | 照搬 |
| `/api/settings/axes` | GET/POST | `:368-377` | 照搬 |
| `/api/settings/analyze` | GET/POST | `:378-391` | 照搬 |
| `/api/scan/status` | GET | `:395` | 照搬 |
| `/api/scan/stop` | POST | `:396` | 照搬 |
| `/api/analyze/status` | GET | `:404` | 照搬 |
| `/api/analyze/{pause,resume,stop}` | POST | `:408` | 照搬 |
| `/api/deovr/{status,connect,disconnect,discover}` | GET/POST | `:413-431` | 照搬 |
| `/api/record/{status,probe,check,cancel,write,start,preview}` | POST | `:713-747` | 重写 70%（解码层换 AVAssetReader） |
| `/api/license/{machine,status,start-trial}` | GET | `:155-160` | 重写 machineCode（Keychain UUID） |
| `/api/license/activate` | POST | `:162-165` | 照搬验签，卡密需区分平台 |
| `/api/video/{codec,original-uri,codec-support}` | GET | `:807-827` | 重写（iOS 无 MediaCodec 清单 API） |
| `/api/refresh` | POST | `:130` | 照搬 |
| `/api/videos` | GET | `:133-141` | 照搬（旧版兜底） |
| `/api/upload/cover` | POST（multipart） | `:748` | 照搬 |
| `/api/actor-thumb/<name>` | GET（SVG） | `:143-146` | 照搬 |

## 三、`/api/osr/*`（24 个子命令，重点模块）

| 子命令 | 方法 | 源码 | iOS 处置 |
|---|---|---|---|
| `settings` | GET/POST | `:437` | 照搬 |
| `axes` | GET/POST | `:444` | 照搬 |
| `reset` | POST | `:461` | 照搬 |
| `status` | GET | `:469` | 照搬 |
| `request-usb` | POST | `:470` | **删除**（iOS 无 USB Host） |
| `usb-devices` | GET | `:471` | **删除** |
| `usb-scan` | POST | `:474` | **删除** |
| `bluetooth-devices` | GET | `:475` | 重写（CoreBluetooth 扫描缓存） |
| `bt-status` | GET | `:476` | 照搬 |
| `bt-disconnect` | POST | `:477` | 照搬 |
| `connect-test` | POST | `:480` | 重写（BLE + TCP） |
| `send` | POST | `:484` | 照搬（T-Code 编码在 OsrCore，可直接移植） |
| `tcode-version` | POST | `:507` | 照搬 |
| `single-axis-fill` | POST | `:513` | 照搬 |
| `playmode` | POST | `:535` | 照搬（stop/random/sine/freeplay） |
| `funscript` | POST | `:567` | 照搬 |
| `funscript-play` | POST | `:579` | 照搬 |
| `funscript-auto` | POST | `:635` | 照搬 |
| `touchpad-save` | POST | `:664` | 照搬 80%（写文件换 FileManager） |
| `touchpad-delete` | POST | `:668` | 照搬 |
| `funscripts` | POST | `:672` | 照搬 |
| `script` | POST | `:690` | 照搬 |
| `playback-time` | POST | `:694` | 照搬 |
| `sync` | POST | `:701` | 照搬 |

## 四、流媒体

| 端点 | 说明 | iOS 方案 |
|---|---|---|
| `GET /video/<key>` | 本地文件 / `content://` / SMB 三态统一开流，支持 Range | 沙盒与已导入文件走 `AVAssetResourceLoaderDelegate`（主路径）；SMB 保留 GCDWebServer 的 Range 端点（兜底） |

> Android 侧 `content://` 因编码问题要登记成 `u<N>` key（`WebServer.kt:33-46`）；iOS 不需要这层，改用 `bookmark:<sha1>` 前缀即可。

## 五、验收方式（M1）

1. 逐个端点比对本表，路径、方法、**JSON 字段名、错误字符串**四项全对齐。
2. 同一媒体库分别在 Android 与 iOS 上请求 `/api/items`、`/api/libraries`、`/api/actors`，对返回 JSON 做 diff。
3. 前端不改动一行即能正常跑通首页 + 媒体库 + 播放页，视为契约达标。
