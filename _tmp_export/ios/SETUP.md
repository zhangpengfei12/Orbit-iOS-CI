# TestFlight 上架准备清单

> 场景：**只上 TestFlight，不上架 App Store**。

## 一、结论：你问的三项，一项都不能少

TestFlight 是 App Store Connect 的一部分。上传给 TestFlight 的构建物，与正式上架是**同一份 ipa、同一套签名**——都是「Apple Distribution 证书 + App Store 分发描述文件」。区别**只在最后一步操作**：上传完不去点「提交审核」，而是开测试组让人装。

| 项 | 只上 TestFlight 要不要 | 说明 |
|---|---|---|
| Apple Developer Program 会员（¥688/年） | **要** | 免费 Apple ID 没有 TestFlight 资格。这是硬门槛 |
| App ID `com.niuniu.orbit` | **要** | 必须在 Developer Portal 注册，并勾选用到的 Capability |
| Apple Distribution 证书（导出 p12） | **要** | 不能用 Development 证书，TestFlight 只收 distribution 签名 |
| App Store 分发描述文件 | **要** | 必须是 Distribution → **App Store** 类型，不是 Ad Hoc、不是 Development |
| App Store Connect API Key（.p8） | **要**（CI 自动化用） | 上传环节的身份凭证 |

## 二、相比正式上架，能省掉什么

| 正式上架要做 | 只上 TestFlight |
|---|---|
| App Store 截图（各尺寸）、描述、关键词、宣发文本 | **省**（外部测试也不需要） |
| 提交 App Store 审核并排队等待（通常 1–7 天） | **省**（本仓库 CI 只上传，不含提交步骤） |
| 定价与销售范围设置 | **省** |
| 完整的年龄分级问卷 | 外部测试仍需简版；内部测试不需要 |
| 隐私政策 URL、App 类别 | **仍要填**（创建 App 记录时的必填项） |
| 出口合规（加密）申报 | **仍要填**，且每个构建都要点一次 |

## 三、内部测试 vs 外部测试（强烈建议先走内部）

| | 内部测试 | 外部测试 |
|---|---|---|
| 审核 | **免 Beta 审核**，上传即可装 | 需 Beta App Review，通常 1–2 天 |
| 人数 | 最多 **100**（必须是 App Store Connect 团队成员） | 最多 **10000**（邮件/链接邀请） |
| 适合 | 你自己 + 核心几个信任用户，**联调阶段** | 稳定后放量 |

**建议路径**：M0–M2 阶段全程走内部测试（上传即可装，不卡审核）；到 M4 稳定后再开外部测试组。
⚠️ 每个 TestFlight 构建**有效期 90 天**，过期后测试者打开会提示已过期，需要重新上传新构建。

## 四、你需要提供的东西 → 对应 GitHub Secrets

| # | 你要给我的 | GitHub Secret 名 | 备注 |
|---|---|---|---|
| 1 | 发布证书 `.p12`（base64） | `IOS_CERT_P12_BASE64` | Apple Distribution 证书，含私钥 |
| 2 | p12 导出密码 | `IOS_CERT_PASSWORD` | 可以简单 |
| 3 | App Store 分发描述文件（base64） | `IOS_PROVISION_PROFILE_BASE64` | `.mobileprovision` |
| 4 | 描述文件的**名称** | `IOS_PROFILE_NAME` | Developer Portal 里显示的名字，写进 ExportOptions |
| 5 | 临时钥匙串密码 | `IOS_KEYCHAIN_PASSWORD` | 随便起一个，如 `orbit-ci-2026` |
| 6 | 团队 ID | `IOS_TEAM_ID` | Developer Portal 右上角，10 位 |
| 7 | API Key ID | `ASC_API_KEY_ID` | 如 `AB12CD34EF` |
| 8 | Issuer ID | `ASC_API_ISSUER_ID` | App Store Connect → 用户与访问 → 密钥页顶部 |
| 9 | API Key `.p8`（base64） | `ASC_API_KEY_P8_BASE64` | **只能下载一次，务必存好** |

## 五、怎么生成（照着做）

### 1）Apple Distribution 证书 → p12

1. 登录 [developer.apple.com](https://developer.apple.com) → Certificates → `+` → 选 **Apple Distribution** → 上传 CSR（钥匙串访问里「从证书颁发机构请求证书」生成）。
2. 下载 `.cer`，双击导入 Mac 钥匙串。
3. 钥匙串里找到该证书，右键 **导出** → 格式 `.p12` → 设密码 → 得到 `Certificates.p12`。

> 如果你手上没有 Mac：也可以用 openssl 从 `.cer` + 私钥合成 p12，或找一台能用的机器代生成一次即可（证书有效期 1 年）。

### 2）App Store 分发描述文件

Profiles → `+` → **Distribution → App Store** → 选 App ID `com.niuniu.orbit` → 选上面那张证书 → 命名（记下这个名字，就是 `IOS_PROFILE_NAME`）→ 下载 `orbit.mobileprovision`。

### 3）App Store Connect API Key

App Store Connect → 用户与访问 → 密钥 → App Store Connect API → `+` → 角色选 **App Manager**（够用）→ 下载 `.p8`，记下 Key ID 和 Issuer ID。

### 4）转 base64（Windows 上执行）

```bash
# 证书
python -c "import base64,sys;print(base64.b64encode(open('Certificates.p12','rb').read()).decode())"
# 描述文件
python -c "import base64,sys;print(base64.b64encode(open('orbit.mobileprovision','rb').read()).decode())"
# API Key
python -c "import base64,sys;print(base64.b64encode(open('AuthKey_XXXXXXXX.p8','rb').read()).decode())"
```

把输出整段粘进 GitHub Secrets（注意别带换行）。

## 六、App Store Connect 里要做的几步（一次性）

1. **新建 App**：平台 iOS、Bundle ID `com.niuniu.orbit`、SKU 自定（如 `ORBIT-IOS-2026`）、名称 `Orbit`。
2. **App 信息**：填类别 + **隐私政策 URL**（必填，随便一个能打开的页面即可）。
3. **TestFlight 标签页** → 建内部测试组，把自己加进去。
4. **每个构建上传后**：该构建右侧点「管理」→ 回答**出口合规**问题，否则状态一直是 `Missing Compliance`，测试者装不了。

### 出口合规这块要留意

App 自己实现了 **ECDSA P-256 验签**（卡密），属于使用了加密。合规问卷会问「是否使用专有加密」。如实填写原则：
- 若只用系统/标准算法实现 → 通常可勾选「使用豁免加密」；
- 若被判定为专有加密 → 需要 ERN 授权号，出口申报会麻烦一些。

建议先按「仅使用标准/豁免加密」填写并自查；如被要求补充说明，再据实处理。这块我不替你判断，填错了是账号层面的风险。

## 七、CI 安全性确认

`.github/workflows/ios.yml` 用的是 `xcrun altool --upload-app`，这一步**只上传构建，绝不提交 App Store 审核**。审核提交只能在 App Store Connect 网页手动点，或额外调用提交接口——我们没有那一步。所以「只上 TestFlight」这个诉求，现成的工作流已经满足，不用改。

## 八、时间线（从零到第一台真机装上）

| 步骤 | 耗时 |
|---|---|
| 注册/续费开发者账号 | 即时～1 天（首次可能更久） |
| 生成证书 + 描述文件 + API Key | 约 30 分钟 |
| 填 9 个 Secrets | 约 10 分钟 |
| 首次 CI 跑通（含 xcodegen + 编译 + 上传） | 20–40 分钟 |
| 内部测试组开始安装 | **上传后立即可装**（免审核） |
