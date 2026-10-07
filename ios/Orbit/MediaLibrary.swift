import Foundation

// MARK: - 媒体库：视频 + funscript 配对（纯逻辑）
//
// 对齐安卓「实机命名 <标题> <基名>.mp4 + <基名>.funscript(L0) + <基名>.<轴>.funscript」。
// 这里只做「给定一个文件清单，配对出每条视频与其各轴脚本」的纯算法，
// 真正的文件系统枚举（Document Picker / 沙盒遍历）留待 M1 真机联调。

/// 单条媒体条目：一个视频 + 它配对到的各轴 funscript（axis → 文件名）。
struct MediaEntry {
    let videoBaseName: String     // 去扩展名
    let videoFileName: String
    let funscripts: [String: String]  // axis("L0".."R2") -> funscript 文件名
}

/// 扫描文件清单，配对出媒体库。
/// - Parameter files: 目录/选择集里的全部文件名（含扩展名）。
/// - Returns: 每条视频一个 MediaEntry；无脚本的视频也会列出（funscripts 为空）。
func buildMediaLibrary(_ files: [String]) -> [MediaEntry] {
    let videoExts = ["mp4", "mov", "m4v", "mkv", "webm", "avi"]
    var videos: [(base: String, file: String)] = []
    var scripts: [(fileName: String, body: String)] = []

    for f in files {
        let lower = f.lowercased()
        if lower.hasSuffix(".funscript") {
            scripts.append((f, f.substringBeforeLast(".")))   // 去 .funscript
        } else if let ext = videoExts.first(where: { lower.hasSuffix("." + $0) }) {
            let base = f.substringBeforeLast(".")
            videos.append((base, f))
        }
    }

    var result: [MediaEntry] = []
    for (base, vfile) in videos {
        var scriptsForVideo: [String: String] = [:]
        for (sf, sbody) in scripts {
            // 去掉轴 token 后得到「视频基名候选」，再与当前视频基名比对。
            let axis = axisFromFilename(sf) ?? ""
            var rest = sbody
            if !axis.isEmpty {
                let ci = String.CompareOptions.caseInsensitive
                rest = rest
                    .replacingOccurrences(of: "." + axis, with: "", options: ci)
                    .replacingOccurrences(of: "_" + axis, with: "", options: ci)
                    .replacingOccurrences(of: "-" + axis, with: "", options: ci)
            }
            let matched = rest == base
                || rest.hasPrefix(base + ".")
                || rest.hasSuffix("." + base)
                || rest.hasPrefix(base + "_")
                || rest.hasSuffix("_" + base)
            if matched {
                // 无轴 token 的 <基名>.funscript 回退为 L0（对齐安卓：默认主 Stroke 轴）。
                let ax = axisFromFilename(sf) ?? "L0"
                scriptsForVideo[ax] = sf
            }
        }
        result.append(MediaEntry(videoBaseName: base, videoFileName: vfile, funscripts: scriptsForVideo))
    }
    return result
}

/// 取某视频条目里指定轴的 funscript 文件名（找不到返回 nil）。
func funscriptForAxis(_ entry: MediaEntry, _ axis: String) -> String? {
    return entry.funscripts[axis]
}
