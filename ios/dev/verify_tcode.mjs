// 黄金测试：镜像 ios/Orbit/FunScript.swift + TCode.swift 的纯逻辑算法，
// 对已知输入断言输出，确保移植数值正确。无 Mac 也能在任意装了 node 的机器上跑：
//   node ios/dev/verify_tcode.mjs
//
// 这不是生产代码（不在 XcodeGen 的 sources 里，不会进 iOS 包），
// 只是「安卓 OsrCore.kt 算法 → Swift 移植」之间的一层可本地运行的正确性校验。
// 改了 TCode/FunScript 后，改这里对应断言并 re-run，避免盲等 CI。

const AXIS_VALUE_MAX = 9999;
const UNITS_PER_TURN = 10000;
const RESAMPLE_MS = 40;
const AXIS_NAMES = ["L0", "L1", "L2", "R0", "R1", "R2"];
const ROTATION_AXES = ["R0", "R1", "R2"];
const AXIS_ALIASES = {
  stroke: "L0", linear: "L0", up: "L0", updown: "L0", main: "L0", default: "L0",
  surge: "L1", forward: "L1", in: "L1", out: "L1",
  sway: "L2", side: "L2", lateral: "L2", left: "L2", right: "L2",
  twist: "R0", rotate: "R0", rotation: "R0", yaw: "R0",
  roll: "R1", tilt: "R1", lean: "R1",
  pitch: "R2", nod: "R2",
  vib: "V0", vibrate: "V0", vibration: "V0", speed: "V0",
  valve: "V0", suck: "V0", air: "V0",
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const idiv = (a, b) => Math.trunc(a / b);

// ---- FunScript ----
function normalizeAxisId(raw) {
  const t = raw.trim();
  const upper = t.toUpperCase();
  if (AXIS_NAMES.includes(upper)) return upper;
  return AXIS_ALIASES[t.toLowerCase()] ?? upper;
}
function axisFromFilename(name) {
  const body = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
  const segs = body.split(/[._\- #]/);
  for (const seg of segs.slice().reverse()) {
    const i = AXIS_NAMES.findIndex((a) => a.toLowerCase() === seg.toLowerCase());
    if (i >= 0) return AXIS_NAMES[i];
  }
  for (const seg of segs.slice().reverse()) {
    if (AXIS_ALIASES[seg.toLowerCase()] != null) return AXIS_ALIASES[seg.toLowerCase()];
  }
  return null;
}
function containsAxisToken(raw) {
  const segs = raw.split(/[._\- #]/);
  for (const seg of segs) {
    if (!seg) continue;
    if (AXIS_NAMES.some((a) => a.toLowerCase() === seg.toLowerCase())) return true;
    if (AXIS_ALIASES[seg.toLowerCase()] != null) return true;
  }
  return false;
}
function findActionIndex(actions, timeMs) {
  let lo = 0, hi = actions.length - 1, result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (actions[mid].at >= timeMs) { result = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  return result;
}
function interpPosAt(actions, timeMs) {
  if (actions.length === 0) return 0;
  if (timeMs <= actions[0].at) return actions[0].pos;
  if (timeMs >= actions[actions.length - 1].at) return actions[actions.length - 1].pos;
  const idx = findActionIndex(actions, timeMs);
  if (idx <= 0) return actions[0].pos;
  const a = actions[idx - 1], b = actions[idx];
  const span = b.at - a.at;
  if (span <= 0) return b.pos;
  const frac = (timeMs - a.at) / span;
  return clamp(Math.trunc(a.pos + (b.pos - a.pos) * frac), 0, 100);
}

// ---- TCode ----
function scaleByAmplitude(value, amp) {
  if (amp === 100) return value;
  const center = AXIS_VALUE_MAX / 2;
  return clamp(Math.trunc(center + (value - center) * amp / 100), 0, AXIS_VALUE_MAX);
}
function mapAxisPositionToOutput(pos, cfg) {
  cfg = cfg || {};
  let v = idiv(clamp(Math.trunc(pos), 0, 100) * AXIS_VALUE_MAX, 100);
  if (cfg.reversed) v = 10000 - v;
  const span = Math.max((cfg.max ?? AXIS_VALUE_MAX) - (cfg.min ?? 0), 0);
  v = idiv(v * span, 10000) + (cfg.min ?? 0);
  if ((cfg.amplitude ?? 100) !== 100) {
    const center = Math.trunc(((cfg.min ?? 0) + (cfg.max ?? AXIS_VALUE_MAX)) / 2);
    v = center + idiv((v - center) * (cfg.amplitude ?? 100), 100);
  }
  return clamp(Math.trunc(v), 0, AXIS_VALUE_MAX);
}
function fmt4(n) { return String(n).padStart(4, "0"); }
function appendAxisCommand(sb, axisId, outValue, durationMs, cfg, ctx) {
  if (ctx.effectiveProtocol === "tcode") {
    if (ctx.useTcodeV2) {
      sb.s += axisId + fmt4(outValue);
      if (ctx.newline) sb.s += "\n";
    } else {
      sb.s += axisId + fmt4(outValue) + "I" + durationMs + ";";
      if (ctx.newline) sb.s += "\n";
    }
  } else {
    const span = Math.max((cfg.max ?? AXIS_VALUE_MAX) - (cfg.min ?? 0), 1);
    const pct = clamp(idiv((outValue - (cfg.min ?? 0)) * 100, span), 0, 100);
    sb.s += axisId + pct + "I" + durationMs;
  }
}
function mkCtx(over) {
  const c = Object.assign({ sendProtocol: "tcode", newline: false, tcodeVersion: "V3", axisParams: {}, routes: {} }, over || {});
  c.effectiveProtocol = c.sendProtocol === "custom" ? "custom" : "tcode";
  c.useTcodeV2 = /v2/i.test(c.tcodeVersion);
  return c;
}
function buildAxisPosCommand(ctx, axisId, pos, durationMs) {
  const sb = { s: "" };
  appendAxisCommand(sb, axisId, clamp(pos, 0, AXIS_VALUE_MAX), durationMs, {}, ctx);
  return sb.s;
}
function buildAxesPosCommand(ctx, entries, durationMs) {
  const sb = { s: "" };
  for (const [axisId, pos] of entries) {
    appendAxisCommand(sb, axisId, clamp(pos, 0, AXIS_VALUE_MAX), durationMs, {}, ctx);
    if (sb.s.length > 0 && sb.s[sb.s.length - 1] !== "\n") sb.s += "\n";
  }
  return sb.s;
}
function buildAxisCommandsFromFunscript(ctx, script, currentPositionMs) {
  const routes = Object.entries(ctx.routes).filter(([, r]) => r.enabled && (r.mode === "follow" || r.mode === "reverse"));
  const scriptAxisIds = new Set(script.axes.map((a) => a.id));
  const sb = { s: "" };
  const loopEndMs = Math.max(0, ...script.axes.map((a) => (a.actions[a.actions.length - 1]?.at ?? 0)));
  const posMs = (loopEndMs > 0 && currentPositionMs > loopEndMs) ? (currentPositionMs % loopEndMs) : currentPositionMs;
  for (const axis of script.axes) {
    const pos = interpPosAt(axis.actions, posMs);
    const cfg = ctx.axisParams[axis.id] || {};
    const outValue = mapAxisPositionToOutput(pos, cfg);
    appendAxisCommand(sb, axis.id, outValue, RESAMPLE_MS, cfg, ctx);
    for (const [routeTarget, route] of routes) {
      if (route.source !== axis.id) continue;
      if (scriptAxisIds.has(routeTarget)) continue;
      const base = route.mode === "reverse" ? (AXIS_VALUE_MAX - outValue) : outValue;
      const targetCfg = ctx.axisParams[routeTarget] || {};
      const pct = clamp(idiv(base * 100, AXIS_VALUE_MAX), 0, 100);
      const routed = scaleByAmplitude(mapAxisPositionToOutput(pct, targetCfg), route.amplitude);
      appendAxisCommand(sb, routeTarget, routed, RESAMPLE_MS, targetCfg, ctx);
    }
  }
  return sb.s;
}
function buildRotationCommands(ctx, elapsedMs, spinAngles, sweepPhases) {
  const sb = { s: "" };
  for (const target of ROTATION_AXES) {
    const route = ctx.routes[target];
    if (!route || !route.enabled) continue;
    if (route.mode !== "spin" && route.mode !== "sweep") continue;
    let rawAngle;
    if (route.mode === "spin") {
      const perMs = (route.speed * UNITS_PER_TURN) / 60000;
      const delta = idiv(perMs * elapsedMs, 1) * (route.reversed ? -1 : 1);
      const prev = spinAngles[target] || 0;
      const next = (((prev + delta) % UNITS_PER_TURN) + UNITS_PER_TURN) % UNITS_PER_TURN;
      spinAngles[target] = next;
      rawAngle = next;
    } else {
      let phase = (sweepPhases[target] || 0) + (elapsedMs * route.speed) / 60000;
      phase = phase - Math.floor(phase);
      if (phase < 0) phase += 1;
      sweepPhases[target] = phase;
      const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;
      const p = route.reversed ? 1 - tri : tri;
      const half = (UNITS_PER_TURN * route.sweepRange) / 360 / 2;
      const center = AXIS_VALUE_MAX / 2;
      rawAngle = clamp(Math.trunc(center + (p - 0.5) * 2 * half), 0, AXIS_VALUE_MAX);
    }
    const cfg = ctx.axisParams[target] || {};
    const pct = clamp(idiv(rawAngle * 100, AXIS_VALUE_MAX), 0, 100);
    const outValue = scaleByAmplitude(mapAxisPositionToOutput(pct, cfg), route.amplitude);
    appendAxisCommand(sb, target, outValue, elapsedMs, cfg, ctx);
  }
  return sb.s;
}
function buildDashSweepCommand(ctx, axisId, elapsedMs, phaseStore, speedPerMin, amplitude) {
  let phase = (phaseStore[axisId] || 0) + (elapsedMs * speedPerMin) / 60000;
  phase = phase - Math.floor(phase);
  if (phase < 0) phase += 1;
  phaseStore[axisId] = phase;
  const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;
  const cfg = ctx.axisParams[axisId] || {};
  const pct = clamp(Math.trunc(tri * 100), 0, 100);
  const outValue = scaleByAmplitude(mapAxisPositionToOutput(pct, cfg), amplitude);
  const sb = { s: "" };
  appendAxisCommand(sb, axisId, outValue, RESAMPLE_MS, cfg, ctx);
  return sb.s;
}

// ---- 断言 ----
let pass = 0, fail = 0;
function eq(actual, expected, label) {
  if (actual === expected) { pass++; }
  else { fail++; console.error(`FAIL ${label}: got ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`); }
}

// 位置映射
eq(mapAxisPositionToOutput(50, {}), 4998, "map(50) default");
eq(mapAxisPositionToOutput(50, { reversed: true }), 5000, "map(50) reversed");
eq(mapAxisPositionToOutput(100, {}), 9998, "map(100) default");
eq(mapAxisPositionToOutput(0, {}), 0, "map(0) default");
eq(mapAxisPositionToOutput(100, { min: 2000, max: 8000, amplitude: 100 }), 7999, "map(100) min/max clamp");

// 插值
const act = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }];
eq(interpPosAt(act, 500), 50, "interp mid");
eq(interpPosAt(act, 0), 0, "interp head");
eq(interpPosAt(act, 1000), 100, "interp tail");
eq(interpPosAt(act, 2000), 100, "interp beyond tail clamps");

// 幅度
eq(scaleByAmplitude(5000, 100), 5000, "amp 100 noop");
eq(scaleByAmplitude(5000, 50), 4999, "amp 50 center");

// T-Code v3 字符串
eq(buildAxisPosCommand(mkCtx({}), "L0", 0, 1000), "L00000I1000;", "posCmd L0=0 v3");
eq(buildAxisPosCommand(mkCtx({}), "L0", 9999, 1000), "L09999I1000;", "posCmd L0=9999 v3");
eq(buildAxisPosCommand(mkCtx({ tcodeVersion: "V2", newline: true }), "L0", 1234, 1000), "L01234\n", "posCmd v2 newline");
eq(buildAxesPosCommand(mkCtx({}), [["R0", 1234], ["R1", 5678]], 1000), "R01234I1000;\nR15678I1000;\n", "axesCmd multi");
eq(buildAxisPosCommand(mkCtx({ sendProtocol: "custom" }), "L0", 9999, 1000), "L0100I1000", "custom pct");

// 冲刺三角波：120 次/分，单轴 L0，amplitude 100
{
  const ctx = mkCtx({});
  const ph = {};
  const c1 = buildDashSweepCommand(ctx, "L0", 250, ph, 120, 100); // phase=0.5 → 峰值
  eq(c1, "L09998I40;", "dash half-period peak");
  const c2 = buildDashSweepCommand(ctx, "L0", 250, ph, 120, 100); // phase=0.0 → 回零
  eq(c2, "L00000I40;", "dash full-period zero");
}

// 旋转 SPIN：R0 60rpm，elapsedMs=250
{
  const ctx = mkCtx({ routes: { R0: { enabled: true, mode: "spin", speed: 60, amplitude: 100 } } });
  const spin = {}, sweep = {};
  const out = buildRotationCommands(ctx, 250, spin, sweep);
  // perMs=10, delta=2500, next=2500, pct=25, map(25)=2497
  eq(out, "R02498I250;", "spin R0 60rpm@250ms");
}

// 脚本 + 旋转派生（FOLLOW）
{
  const script = { durationSec: 1.0, axes: [{ id: "L0", actions: act }] };
  const ctx = mkCtx({ routes: { R1: { enabled: true, mode: "follow", source: "L0", amplitude: 100 } } });
  const out = buildAxisCommandsFromFunscript(ctx, script, 500);
  eq(out, "L04998I40;R14898I40;", "funscript L0 + derived R1");
}

// 轴识别
eq(normalizeAxisId("pitch"), "R2", "norm pitch");
eq(normalizeAxisId("L0"), "L0", "norm L0");
eq(normalizeAxisId("stroke"), "L0", "norm stroke");
eq(normalizeAxisId("twist"), "R0", "norm twist");
eq(normalizeAxisId("foo"), "FOO", "norm unknown");
eq(axisFromFilename("video.L0.funscript"), "L0", "file L0");
eq(axisFromFilename("video.twist.funscript"), "R0", "file twist");
eq(axisFromFilename("Ball Roll Workout.pitch.funscript"), "R2", "file pitch-last");
eq(axisFromFilename("video1.funscript"), null, "file no-token");
eq(containsAxisToken("Workout.pitch"), true, "token true");
eq(containsAxisToken("Workout 2"), false, "token false");

// 解析（iOS 端 parseFunscript 走 JSONSerialization；这里用 JSON.parse 镜像同一结构）
{
  const data = JSON.parse('{"actions":[{"at":0,"pos":0},{"at":1000,"pos":100}],"metadata":{"duration":1.0}}');
  const dur = (data.metadata && data.metadata.duration) || 0;
  eq(dur, 1.0, "parse duration");
  const acts = data.actions.map((o) => ({ at: o.at, pos: o.pos })).sort((a, b) => a.at - b.at);
  eq(interpPosAt(acts, 500), 50, "parse+interp");
}

console.log(`\nTCode/FunScript 黄金测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
