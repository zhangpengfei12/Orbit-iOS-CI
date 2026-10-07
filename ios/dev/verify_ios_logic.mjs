// iOS 纯逻辑模块黄金测试（Node 端独立镜像同一算法，交叉验证数值正确）。
// 不进 iOS 包，仅本地 `node ios/dev/verify_ios_logic.mjs` 运行。

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`✗ ${label}\n   期望 ${e}\n   实际 ${a}`); }
}
function ok(cond, label) { if (cond) pass++; else { fail++; console.log(`✗ ${label}`); } }

// ---- 共享：轴识别（镜像 FunScript.swift） ----
const AXIS_NAMES = ["L0", "L1", "L2", "R0", "R1", "R2"];
const AXIS_ALIASES = {
  stroke: "L0", linear: "L0", up: "L0", updown: "L0", main: "L0", default: "L0",
  surge: "L1", forward: "L1", in: "L1", out: "L1",
  sway: "L2", side: "L2", lateral: "L2", left: "L2", right: "L2",
  twist: "R0", rotate: "R0", rotation: "R0", yaw: "R0",
  roll: "R1", tilt: "R1", lean: "R1",
  pitch: "R2", nod: "R2",
  vib: "V0", vibrate: "V0", vibration: "V0", speed: "V0", valve: "V0", suck: "V0", air: "V0"
};
function substringBeforeLast(s, delim) { const i = s.lastIndexOf(delim); return i >= 0 ? s.slice(0, i) : s; }
function axisFromFilename(name) {
  const body = substringBeforeLast(name, ".");
  const segs = body.split(/[._\- #]/);
  const rev = [...segs].reverse();
  for (const seg of rev) if (AXIS_NAMES.includes(seg.toUpperCase())) return seg.toUpperCase();
  for (const seg of rev) { const h = AXIS_ALIASES[seg.toLowerCase()]; if (h) return h; }
  return null;
}

// ---- 1. Bridge：encodeJsArg + buildCallback（镜像 Bridge.swift） ----
function encodeJsArg(a) {
  if (a === null) return "null";
  if (typeof a === "boolean") return a ? "true" : "false";
  if (typeof a === "number") return String(a);
  if (typeof a === "string") return JSON.stringify([a]).slice(1, -1);
  return JSON.stringify(a); // object/array
}
function buildCallback(name, args) {
  const body = args.map(encodeJsArg).join(", ");
  return `window.${name} && window.${name}(${body})`;
}
eq(encodeJsArg("a\"b"), '"a\\"b"', "encode string 转义双引号");
eq(encodeJsArg(true), "true", "encode bool");
eq(encodeJsArg(5), "5", "encode int");
eq(encodeJsArg({ a: 1 }), '{"a":1}', "encode object");
{
  const cb = buildCallback("__onBtDeviceFound", [{ name: "Dev", address: "AA:BB", kind: "ble", paired: true, rssi: null }]);
  ok(cb.startsWith("window.__onBtDeviceFound && window.__onBtDeviceFound("), "buildCallback 前缀");
  ok(cb.includes('"name":"Dev"') && cb.includes('"address":"AA:BB"'), "buildCallback 对象字面量");
}

// ---- 2. UpdateChecker：isNewer / resolveApkUrl / parseUpdateManifest ----
function isNewer(latest, current) {
  const a = latest.split(".").map(x => parseInt(x.replace(/\D/g, "")) || 0);
  const b = current.split(".").map(x => parseInt(x.replace(/\D/g, "")) || 0);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) { const x = i < a.length ? a[i] : 0, y = i < b.length ? b[i] : 0; if (x !== y) return x > y; }
  return false;
}
function resolveApkUrl(base, path) {
  const p = (path || "").trim();
  if (p.toLowerCase().startsWith("http")) return p;
  const b = (base || "").trim().replace(/\/+$/, "");
  if (!p) return b;
  return b + "/" + p.replace(/^\/+/, "");
}
function parseUpdateManifest(j) {
  const vn = (j.versionName || "").trim();
  if (!vn) return null;
  return { versionName: vn, apkPath: (j.apkPath || "").trim(), notes: j.notes || "" };
}
ok(isNewer("2.7.31", "2.7.30") === true, "isNewer 大版本新");
ok(isNewer("2.7.30", "2.7.31") === false, "isNewer 旧");
ok(isNewer("1.0.1", "1.0.0") === true, "isNewer 补丁新");
ok(isNewer("2.7.31", "2.7.31") === false, "isNewer 相等");
ok(isNewer("10.0.0", "9.9.9") === true, "isNewer 段内整数比较");
eq(resolveApkUrl("https://x.com/", "build/out.apk"), "https://x.com/build/out.apk", "resolveApkUrl 相对");
eq(resolveApkUrl("https://x.com", "https://y.com/a.apk"), "https://y.com/a.apk", "resolveApkUrl 绝对");
eq(resolveApkUrl("https://x.com", ""), "https://x.com", "resolveApkUrl 空 path");
eq(parseUpdateManifest({ versionName: "2.7.32", apkPath: "apk/o.apk", notes: "n" }),
   { versionName: "2.7.32", apkPath: "apk/o.apk", notes: "n" }, "parseUpdateManifest");

// ---- 3. MediaLibrary：buildMediaLibrary（镜像，无 token 回退 L0，分隔符边界） ----
function buildMediaLibrary(files) {
  const videoExts = ["mp4", "mov", "m4v", "mkv", "webm", "avi"];
  const videos = [], scripts = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    if (lower.endsWith(".funscript")) scripts.push([f, substringBeforeLast(f, ".")]);
    else { const ext = videoExts.find(e => lower.endsWith("." + e)); if (ext) videos.push([substringBeforeLast(f, "."), f]); }
  }
  const result = [];
  for (const [base, vfile] of videos) {
    const fs = {};
    for (const [sf, sbody] of scripts) {
      const axis = axisFromFilename(sf) || "";
      let rest = sbody;
      if (axis) {
        const ci = axis.toLowerCase();
        rest = rest.split("." + ci).join("").split("_" + ci).join("").split("-" + ci).join("");
      }
      const matched = rest === base || rest.startsWith(base + ".") || rest.endsWith("." + base)
        || rest.startsWith(base + "_") || rest.endsWith("_" + base);
      if (matched) fs[axisFromFilename(sf) || "L0"] = sf;
    }
    result.push({ videoBaseName: base, videoFileName: vfile, funscripts: fs });
  }
  return result;
}
{
  const lib = buildMediaLibrary(["Movie.mp4", "Movie.funscript", "Movie.pitch.funscript", "Other.mp4"]);
  const movie = lib.find(e => e.videoBaseName === "Movie");
  eq(movie.funscripts, { L0: "Movie.funscript", R2: "Movie.pitch.funscript" }, "媒体库 配对 L0+R2");
  const other = lib.find(e => e.videoBaseName === "Other");
  eq(other.funscripts, {}, "媒体库 无脚本视频");
}
{
  const lib = buildMediaLibrary(["Clip A.mp4", "Clip A.funscript", "Clip A.roll.funscript"]);
  const e = lib[0];
  eq(e.funscripts, { L0: "Clip A.funscript", R1: "Clip A.roll.funscript" }, "媒体库 空格基名 + R1");
}
{
  // Movie2.funscript 不应误配 Movie.mp4
  const lib = buildMediaLibrary(["Movie.mp4", "Movie2.funscript"]);
  const e = lib.find(x => x.videoBaseName === "Movie");
  eq(e.funscripts, {}, "媒体库 边界防误配");
}

// ---- 4. CommandQueue：chunkCommandsForMtu + 队列 ----
function chunkCommandsForMtu(cmd, mtu) {
  const m = Math.max(mtu, 1);
  const lines = cmd.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  const result = []; let cur = "";
  for (const line of lines) {
    const cand = cur ? cur + "\n" + line : line;
    if (cand.length > m) {
      if (cur) { result.push(cur); cur = ""; }
      if (line.length > m) { let rest = line; while (rest) { result.push(rest.slice(0, m)); rest = rest.slice(m); } }
      else cur = line;
    } else cur = cand;
  }
  if (cur) result.push(cur);
  return result;
}
{
  const chunks = chunkCommandsForMtu("L09999\nR01234\n", 10);
  eq(chunks, ["L09999", "R01234"], "MTU 分行不越界");
}
{
  const chunks = chunkCommandsForMtu("L0123456789ABC", 10);
  eq(chunks, ["L012345678", "9ABC"], "MTU 单行硬切");
}
// 队列行为
class CommandQueue {
  constructor(mtu = 20) { this.mtu = Math.max(mtu, 1); this.pending = []; this.seq = 0; }
  enqueue(cmd) { for (const line of cmd.split("\n")) { const t = line.trim(); if (t) this.pending.push(t); } }
  takeNextChunk() {
    if (!this.pending.length) return null;
    let built = "";
    while (this.pending.length) {
      const line = this.pending[0];
      const cand = built ? built + "\n" + line : line;
      if (cand.length > this.mtu) {
        if (!built) { const prefix = line.slice(0, this.mtu), rest = line.slice(this.mtu); this.pending[0] = rest; built = prefix; }
        break;
      }
      built = cand; this.pending.shift();
    }
    this.seq++; return { text: built, seq: this.seq };
  }
}
{
  const q = new CommandQueue(10);
  q.enqueue("L09999\nR01234\n");
  eq(q.takeNextChunk().text, "L09999", "队列 取出首包");
  eq(q.takeNextChunk().text, "R01234", "队列 取出次包");
  eq(q.takeNextChunk(), null, "队列 空返回 null");
}

// ---- 5. PlayerState：字典往返 ----
function playerSnapshotToDict(s) {
  return { type: s.type, posMs: s.posMs, durMs: s.durMs, playing: s.playing, buffering: s.buffering,
    ready: s.ready, w: s.w, h: s.h, rate: s.rate, vol: s.vol, muted: s.muted, err: s.err };
}
function playerSnapshotFromDict(d) {
  return { type: d.type || "idle", posMs: d.posMs || 0, durMs: d.durMs || 0, playing: !!d.playing,
    buffering: !!d.buffering, ready: !!d.ready, w: d.w || 0, h: d.h || 0, rate: d.rate ?? 1,
    vol: d.vol ?? 1, muted: !!d.muted, err: d.err || "" };
}
{
  const s = { type: "playing", posMs: 1000, durMs: 5000, playing: true, buffering: false, ready: true,
    w: 1920, h: 1080, rate: 1.5, vol: 0.8, muted: false, err: "" };
  const back = playerSnapshotFromDict(playerSnapshotToDict(s));
  eq(back, s, "播放快照 字典往返");
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exit(1);
