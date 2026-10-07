# Orbit iOS CI

Orbit（DPlayer）**iOS 端的持续集成镜像仓库**。

## 为什么是公开仓库

GitHub 对公开仓库的 Actions 资源不限量免费；私有仓库每月只有 2,000 分钟额度，
而 macOS runner 按 **10 倍**计费，几轮 iOS 归档就把额度烧光了（表现为 job 5 秒秒失败、
拿不到 runner）。所以把 iOS 这一侧单独镜像到公开仓库来跑 CI。

## 包含什么

- `ios/` —— iOS 原生工程（Swift，XcodeGen 生成 `Orbit.xcodeproj`）
- `web/` —— 安卓与 iOS 共用的前端资产；APK 内嵌的就是这份（唯一真源在私有主仓库）
- `.github/workflows/ios.yml` —— CI：前端回归 → 编译验证 → 归档导出 → 上传 TestFlight

## 不包含什么

安卓主工程 `app/`、微信支付后端、发卡/加解密工具、签名密钥与所有密钥材料
都**留在私有主仓库**，这里没有，也不会有。

## 同步方式

内容由私有主仓库的 `ios` 分支单向同步而来，请勿在这里直接改代码（会被下次同步覆盖）。

## 流水线说明

- `web-regression`：JS 语法全量校验（node --check）
- `compile-check`：Xcode 26.3 编译（关闭签名，不依赖证书）
- `archive-upload`：手动签名 + App Store 分发 profile 归档导出；
  需手动触发并选择 upload 才会上传 TestFlight

Apple 要求所有 iOS App 必须用 **iOS 26 SDK（Xcode 26+）** 构建，故固定 Xcode 26.3。
