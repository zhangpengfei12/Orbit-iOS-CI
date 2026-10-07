/* ===== 手控触板（?panel=touchpad）=====
 * 2D 触板：圆点在触板内自由拖动，
 *   上下 → L0 升降；左右 → R0+R1 同步摆动（两臂同向动才产生整装左右倾斜，参考 rubjoy 实机效果）；
 *   画圈 → L0+R0+R1 组合动作。
 * 实时驱动 POST /api/osr/send（多轴合并成一次请求、节流 ~320ms 且串行不重叠，只发有变化的轴）；
 * 录制采样 {at, x, y}，保存 POST /api/osr/touchpad-save 生成多轴 funscript：
 *   <名称>.funscript（L0）+ <名称>.R0.funscript / <名称>.R1.funscript（左右）。
 * 保存目录走 Orbit.grantRecordFolder()（SAF 树授权），结果经 window.__onGrantFolder 回传。
 */
(function () {
    'use strict';

    function $(id) { return document.getElementById(id); }

    /* ---------- 状态 ---------- */
    var pad, knob, posVal, posLR, recBtn, recTime, recDot, recTxt;
    var saveBox, nameInput, pickBtn, folderHint, saveBtn, discardBtn, saveHint;

    var curX = 50;              // 左右位置 0-100（左=0，右=100，中=50）
    var curY = 50;              // 升降位置 0-100（顶=100，底=0）
    var sending = false;        // 是否有一发正在串口上（USB 单次 ~300ms，未落地前不许叠新请求）
    var needSend = false;
    var lastSentL0 = null;      // 上次成功/已发送值，用于只发变化轴
    var lastSentLR = null;
    var lastErrKey = null;

    // 录制
    var recording = false;
    var recActions = [];        // [{at, x, y}]
    var recStartTs = 0;
    var recTimer = null;
    var lastRecX = null, lastRecY = null;
    var pendingSave = false;    // touchpad 正在等待目录授权回调
    // 已保存脚本列表（页面底部「已保存脚本」）：保存成功后落在这里，点「运行」即播放。
    // 条目 {name, paths[], durationMs, at}；paths 为后端返回的落盘绝对路径。
    var LIST_KEY = 'tpRecList';
    var recList = [];
    var runningIdx = -1;        // 正在播放的条目下标，-1 表示没有
    var listEl, listHint;
    var visRAF = 0;            // 播放时驱动圆点动画的 rAF 句柄
    var visActions = null;     // 当前正在回放的录制动作时间轴
    var visStartMs = 0;

    /* ---------- 通用请求（与 osr.js 同款容错） ---------- */
    function readResponse(r) {
        return r.text().then(function (txt) {
            var obj = null;
            try { obj = JSON.parse(txt); } catch (e) { obj = null; }
            if (obj && typeof obj === 'object') {
                if (obj.httpStatus == null) obj.httpStatus = r.status;
                return obj;
            }
            return { error: 'bad_response', httpStatus: r.status };
        });
    }
    function post(path, body) {
        return fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        }).then(readResponse)
          .catch(function (e) { return { error: 'network', detail: '请求失败：' + ((e && e.message) || '网络错误') }; });
    }
    function showResult(text, isErr, holdMs) {
        var panel = $('panel-touchpad');
        if (!panel) return;
        var boxes = panel.querySelectorAll('.osr-result');
        Array.prototype.forEach.call(boxes, function (box) {
            box.textContent = text;
            box.className = 'osr-result' + (isErr ? ' err' : '');
            box.style.display = '';
            clearTimeout(box._t);
            box._t = setTimeout(function () { box.style.display = 'none'; }, holdMs || 4000);
        });
    }

    /* ---------- 触板拖拽（2D） ---------- */
    function clamp(v) { return Math.max(0, Math.min(100, v)); }
    function setKnob(x, y) {
        // 先更新坐标：即使面板不可见（脚本编辑面板复用触板驱动、但触板面板本身隐藏）也要更新，
        // 否则录制读到的位置永远是初值。圆点摆位才需要可见尺寸，下面再守卫。
        curX = clamp(x);
        curY = clamp(y);
        if (!pad || !knob) return;
        var w = pad.clientWidth - 56;            // knob 直径 56
        var h = pad.clientHeight - 56;
        // 面板还不可见时 clientWidth 为 0，此时绝不能算坐标摆圆点 —— 会得出
        // 「几乎贴左上角」的像素值并覆盖 CSS 里的居中默认值，圆点就再也不回中心了。
        // 只跳过摆位，坐标已在上面更新（由 ResizeObserver 在尺寸就绪后重摆）。
        if (w < 1 || h < 1) return;
        knob.style.left = (curX / 100 * w + 28) + 'px';
        knob.style.top = ((100 - curY) / 100 * h + 28) + 'px';
        if (posVal) posVal.textContent = Math.round(curY) + '%';
        if (posLR) posLR.textContent = Math.round(curX) + '%';
    }
    function posFromEvent(ev) {
        var rect = pad.getBoundingClientRect();
        var cx = ev.clientX - rect.left - 28;    // 减 knob 半径，以圆心计
        var cy = ev.clientY - rect.top - 28;
        var w = rect.width - 56;
        var h = rect.height - 56;
        if (w < 1) w = 1;
        if (h < 1) h = 1;
        return { x: clamp(cx / w * 100), y: clamp((1 - cy / h) * 100) };
    }
    /**
     * 单轴发送（一次只开一次串口，仍会与触板上一发竞争）。
     * 已不再参与触板拖拽路径 —— 触板统一走 sendAxes() 把本次变化的轴合并成一发。
     * 仅保留作为「单轴对照实验」的后手：怀疑「多轴合并」本身有问题时，
     * 用它证明同一根轴单发能正常动，从而把问题定位到合并/并发而不是设备本身。
     */
    function sendAxis(axis, pct) {
        // send 接口的 pos 范围 0-9999（TCode），funscript 0-100
        var pos = Math.round(pct * 99.99);
        return post('/api/osr/send', { axis: axis, pos: pos, durationMs: 120 }).then(function (r) {
            if (r && r.ok === false && r.error !== 'network') {
                var key = axis + ':' + r.error;
                if (lastErrKey !== key) {
                    lastErrKey = key;
                    showResult('驱动失败（' + axis + '）：' + (r.detail || r.error), true);
                }
                return false;
            }
            return true;
        });
    }
    /**
     * 多轴一次下发。R0+R1 拼成一条 T-Code，只开一次 USB 串口，避免并发/重试放大失败。
     * list: [{axis, pct}]
     * 返回 {ok, failedAxis}
     */
    function sendAxes(list) {
        var entries = list.map(function (item) {
            return { axis: item.axis, pos: Math.round(item.pct * 99.99) };
        });
        var failedAxis = list.map(function (item) { return item.axis; }).join('+');
        return post('/api/osr/send', { axes: entries, durationMs: 120 }).then(function (r) {
            if (r && r.ok === false && r.error !== 'network') {
                var key = 'multi:' + failedAxis + ':' + r.error;
                if (lastErrKey !== key) {
                    lastErrKey = key;
                    showResult('驱动失败（' + failedAxis + '）：' + (r.detail || r.error), true);
                }
                return { ok: false, failedAxis: failedAxis };
            }
            return { ok: true };
        });
    }
    /**
     * 重置「已发送游标」。
     * 为什么必须有：脚本播放期间是脚本在驱设备，前端游标却仍停在脚本开始前的数值。
     * 脚本一停，用户把触板拖到某个位置，sendPos 会先跟旧游标比一下 —— 数值相同就直接跳过，
     * 设备于是纹丝不动（现场表现就是「停止后再滑触板，设备运行不正确」）。
     * 置 null 后下一次必定全轴下发，真实位置立刻对齐。
     */
    function resetSentCursor() {
        lastSentL0 = null;
        lastSentLR = null;
    }

    function sendPos() {
        // 左右 → R0+R1 同值（实机两臂同步动才是整装左右摆）；上下 → L0
        var l0 = Math.round(curY);
        var lr = Math.round(curX);
        var axes = [];
        // R0 必须排首行：部分固件（实机见过）只解析同包首行，斜向拖动时若把 L0 放前面，
        // R0/R1 会全部落在第二行以后而完全不动 —— 触板主要诉求是左右摆动，让 R1 丢也保留 R0。
        if (lr !== lastSentLR) {
            axes.push({ axis: 'R0', pct: lr });
            axes.push({ axis: 'R1', pct: lr });
        }
        if (l0 !== lastSentL0) axes.push({ axis: 'L0', pct: l0 });
        if (!axes.length) return [];
        // 一次性把本次所有变化轴发出去（L0 / R0 / R1），只开一次 USB 串口。
        // 游标无条件推进：发送失败也要推进，否则下一次只会原样重试同一条指令，反而更难成功。
        return [sendAxes(axes).then(function () {
            lastSentL0 = l0;
            lastSentLR = lr;
        })];
    }
    /**
     * 驱动节流。USB 串口单次 open→write→close 约 300ms，而 nanohttpd 是单线程，
     * 上一发没落地就发下一发会被排队后超时 —— 这正是 R0 报「串口写入异常」的放大器。
     * 所以这里改成「串行泵」：同一时刻只有一发在飞，落地后才补发积压，且间隔约 320ms。
     */
    function kickSend() {
        needSend = true;
        if (sending) return;      // 在飞的那发结束后会自动补发
        pumpSend();
    }
    function pumpSend() {
        if (!needSend) return;
        needSend = false;
        sending = true;
        Promise.all(sendPos()).catch(function () {}).then(function () {
            sending = false;
            if (needSend) pumpSend();
        });
    }

    function bindPad() {
        var dragging = false;
        var lastTapTs = 0;
        pad.addEventListener('pointerdown', function (ev) {
            // 陀螺仪模式：设备到哪一级完全由手机动作决定，触板必须彻底失效。
            // 只锁输入、不改发送路径 —— 姿态数据仍照常走 setKnob/kickSend，
            // 圆点照样动、录制照样采，只是手指点不动它。
            if (tpMode === 'tiltA' || tpMode === 'tiltB') return;
            // 脚本正在跑时禁止拖动：脚本每 40ms 下发一次，手动指令会和它抢同一条串口，
            // 落谁算谁的，结果两边都不到位。先停止脚本再手动。
            if (runningIdx >= 0) {
                showResult('脚本正在运行中，先点列表里的「■ 停止」再手动控制', false, 3000);
                return;
            }
            ev.preventDefault();
            dragging = true;
            pad.classList.add('tp-dragging');
            try { pad.setPointerCapture(ev.pointerId); } catch (e) { }
            var now = Date.now();
            if (now - lastTapTs < 300) {              // 双击回中
                setKnob(50, 50); kickSend();
                lastTapTs = 0;
            } else {
                lastTapTs = now;
                var p = posFromEvent(ev);
                setKnob(p.x, p.y); kickSend();
            }
        });
        pad.addEventListener('pointermove', function (ev) {
            if (!dragging) return;
            ev.preventDefault();
            var p = posFromEvent(ev);
            setKnob(p.x, p.y); kickSend();
        });
        function up() {
            dragging = false;
            pad.classList.remove('tp-dragging');
            // 松手：设备保持在当前位置（send 的 durationMs 已把目标送到）
        }
        pad.addEventListener('pointerup', up);
        pad.addEventListener('pointercancel', up);
    }

    /* ---------- 录制 ---------- */
    function fmtDur(ms) {
        var s = Math.floor(ms / 1000);
        var m = Math.floor(s / 60);
        return (m < 10 ? '0' : '') + m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
    }
    function startRec() {
        if (recording) return;
        // 先停掉视频随播 / 自动模式，避免脚本时钟抢着发指令
        post('/api/osr/playmode', { mode: 'stop' });
        recording = true;
        recActions = [];
        recStartTs = Date.now();
        lastRecX = Math.round(curX);
        lastRecY = Math.round(curY);
        recActions.push({ at: 0, x: lastRecX, y: lastRecY });
        pad.classList.add('tp-recording');
        if (recBtn) recBtn.textContent = '■ 停止录制';
        if (recBtn) recBtn.style.background = 'rgba(239,68,68,.15)';
        if (recBtn) recBtn.style.color = '#EF4444';
        if (recDot) recDot.style.display = '';
        if (recTxt) recTxt.textContent = '录制中';
        recTimer = setInterval(function () {
            var at = Date.now() - recStartTs;
            if (recTime) recTime.textContent = fmtDur(at);
            var x = Math.round(curX), y = Math.round(curY);
            if (x !== lastRecX || y !== lastRecY) {
                recActions.push({ at: at, x: x, y: y });
                lastRecX = x; lastRecY = y;
            }
        }, 100);
    }
    function stopRec() {
        if (!recording) return;
        recording = false;
        clearInterval(recTimer); recTimer = null;
        pad.classList.remove('tp-recording');
        if (recBtn) recBtn.textContent = '● 开始录制';
        if (recBtn) { recBtn.style.background = ''; recBtn.style.color = ''; }
        if (recDot) recDot.style.display = 'none';
        if (recTxt) recTxt.textContent = '';
        if (recActions.length < 2) {
            showResult('本次录制没有足够的动作（拖动圆点才会记录），已丢弃', true);
            return;
        }
        openSaveBox();
    }
    function openSaveBox() {
        if (!saveBox) return;
        saveBox.style.display = '';
        var d = new Date();
        function z(n) { return (n < 10 ? '0' : '') + n; }
        var def = '手控_' + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '_' + z(d.getHours()) + z(d.getMinutes());
        if (nameInput && !nameInput.value.trim()) nameInput.value = def;
        // 回显上次保存目录
        var saved = '';
        try { saved = localStorage.getItem('tpFolderUri') || ''; } catch (e) { }
        updateFolderHint(saved);
        if (saveHint) { saveHint.textContent = ''; }
        saveBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    function updateFolderHint(uri) {
        if (!folderHint) return;
        if (!uri) { folderHint.textContent = '未选择（不选则保存到本地媒体库 Patterns/）'; return; }
        var label = uri;
        try {
            var m = /tree\/(.+)$/.exec(uri);
            if (m) label = decodeURIComponent(m[1]);
        } catch (e) { }
        folderHint.textContent = '已选：' + label;
    }

    /* ---------- 目录授权（接管 __onGrantFolder，等待时优先给触板，其余转给原回调） ---------- */
    function takeoverGrant() {
        if (!window.__onGrantFolder_tp_orig) {
            window.__onGrantFolder_tp_orig = window.__onGrantFolder || null;
        }
        window.__onGrantFolder = function (uri, writable, contains) {
            if (pendingSave) {
                pendingSave = false;
                if (!uri) { showResult('已取消目录选择', true); return; }
                if (!writable) { showResult('该目录未授予写权限，请重新选择并点「使用此文件夹」', true); return; }
                try { localStorage.setItem('tpFolderUri', uri); } catch (e) { }
                updateFolderHint(uri);
                showResult('已选择保存目录', false);
                return;
            }
            if (window.__onGrantFolder_tp_orig) window.__onGrantFolder_tp_orig(uri, writable, contains);
        };
    }

    /* ---------- 已保存脚本列表 ---------- */
    function listPersist() {
        try { localStorage.setItem(LIST_KEY, JSON.stringify(recList)); } catch (e) { }
    }
    function loadList() {
        try {
            var raw = localStorage.getItem(LIST_KEY);
            var arr = raw ? JSON.parse(raw) : [];
            recList = Object.prototype.toString.call(arr) === '[object Array]' ? arr : [];
        } catch (e) { recList = []; }
    }
    function fmtListDur(ms) {
        var s = Math.max(0, Math.round((ms || 0) / 1000));
        var m = Math.floor(s / 60);
        var r = s % 60;
        return (m > 0 ? m + '分' : '') + r + '秒';
    }
    function renderList() {
        if (!listEl) return;
        // 空列表也保留区块：否则用户不知道有「已保存脚本」这回事，等想用时找不回来。
        if (!recList.length) {
            // 必须清空：只改提示文案的话，删掉最后一条时那一行会留在页面上，
            // 用户看到的就是「点了删除没反应」。
            listEl.innerHTML = '';
            if (listHint) listHint.textContent = '还没有保存过脚本';
            return;
        }
        if (listHint) listHint.textContent = '共 ' + recList.length + ' 条，点「运行」直接播放';
        var html = '';
        recList.forEach(function (e, i) {
            var run = (i === runningIdx);
            html += '<div class="tp-script-row' + (run ? ' tp-script-running' : '') + '">' +
                '<span class="tp-script-name" title="' + (e.name || '') + '">' + (e.name || '未命名') + '</span>' +
                '<span class="tp-script-meta">' + fmtListDur(e.durationMs) +
                ' · ' + (e.paths ? e.paths.length : 0) + '轴文件</span>' +
                '<button class="tool-btn tp-script-run" data-act="run" data-i="' + i + '" type="button">' +
                (run ? '■ 停止' : '▶ 运行') + '</button>' +
                '<button class="tool-btn tp-script-del" data-act="del" data-i="' + i + '" type="button">删除</button>' +
                '</div>';
        });
        listEl.innerHTML = html;
    }
    /** 按录制时间轴回放：只驱动圆点动画（setKnob，不发送），让触板和录制时看起来一致。 */
    function interpAt(actions, t) {
        if (t <= actions[0].at) return { x: actions[0].x, y: actions[0].y };
        var last = actions[actions.length - 1];
        if (t >= last.at) return { x: last.x, y: last.y };
        for (var i = 1; i < actions.length; i++) {
            if (t <= actions[i].at) {
                var p0 = actions[i - 1], p1 = actions[i];
                var f = (t - p0.at) / ((p1.at - p0.at) || 1);
                return { x: p0.x + (p1.x - p0.x) * f, y: p0.y + (p1.y - p0.y) * f };
            }
        }
        return { x: last.x, y: last.y };
    }
    function stopVisualReplay() {
        if (visRAF) { cancelAnimationFrame(visRAF); visRAF = 0; }
    }
    function startVisualReplay(actions) {
        stopVisualReplay();
        visActions = actions.slice().sort(function (a, b) { return a.at - b.at; });
        visStartMs = Date.now();
        var first = visActions[0];
        setKnob(first.x, first.y);
        var step = function () {
            if (runningIdx < 0) return;
            var t = Date.now() - visStartMs;
            var pos = interpAt(visActions, t);
            setKnob(pos.x, pos.y);
            if (t < visActions[visActions.length - 1].at) visRAF = requestAnimationFrame(step);
            else visRAF = 0;
        };
        visRAF = requestAnimationFrame(step);
    }
    function stopPlayback() {
        runningIdx = -1;
        stopVisualReplay();
        renderList();
        // 停止后必须重置发送游标与触板坐标：脚本把设备带到的位置前端并不知道，
        // 不重置的话下一次拖拽会被「和上次一样」的判断挡掉，设备不动。
        resetSentCursor();
        return post('/api/osr/script', { action: 'stop' }).catch(function () { });
    }
    /** 点击列表条目：没有在跑就加载并播放，正在跑就停下。 */
    function toggleRun(i) {
        var e = recList[i];
        if (!e) return;
        if (i === runningIdx) { stopPlayback(); return; }
        var paths = (e.paths || []).map(function (p) { return { path: p }; });
        post('/api/osr/funscript-play', { files: paths }).then(function (r) {
            if (r && r.ok) {
                runningIdx = i;
                renderList();
                // 原生侧按 funscript 驱设备；这里按录制时间轴驱动圆点动画，和录制时一致。
                if (e.actions && e.actions.length) startVisualReplay(e.actions);
                showResult('正在运行：' + (e.name || '') + '（' + fmtListDur(e.durationMs) + '）', false, 4000);
            } else {
                var msg = (r && (r.detail || r.error)) || '未知错误';
                showResult('运行失败：' + msg, true, 6000);
                runningIdx = -1;
                renderList();
            }
        });
    }
    function delEntry(i) {
        var e = recList[i];
        if (!e) return;
        var wasRunning = (runningIdx === i);
        recList.splice(i, 1);
        if (wasRunning) runningIdx = -1;
        listPersist();
        renderList();
        var left = (e.paths || []).filter(function (p) { return typeof p === 'string' && p; });
        if (wasRunning) {
            resetSentCursor();
            post('/api/osr/script', { action: 'stop' }).catch(function () { });
        }
        showResult('已删除：' + (e.name || '未命名'), false, 3000);
        // 磁盘上的脚本一并清掉：只从列表删、文件还留着，等于「假删除」，
        // 下次打开又冒出来。best effort —— 删不掉也要让列表先走，并如实告知。
        if (left.length) {
            var files = left.map(function (p) { return { path: p }; });
            post('/api/osr/touchpad-delete', { files: files }).then(function (r) {
                if (!(r && r.ok && r.removed > 0)) {
                    showResult('已从列表删除，但文件没清掉：' +
                        ((r && (r.error || r.detail)) || '未知原因'), true, 6000);
                }
            }).catch(function () { });
        }
    }
    function bindList() {
        if (!listEl) return;
        listEl.addEventListener('click', function (ev) {
            var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-act]') : null;
            if (!btn) return;
            var i = parseInt(btn.getAttribute('data-i'), 10);
            if (isNaN(i)) return;
            if (btn.getAttribute('data-act') === 'run') toggleRun(i); else delEntry(i);
        });
    }

    /* ---------- 保存 ---------- */
    function doSave() {
        if (!recActions.length) { showResult('没有可保存的录制内容', true); return; }
        var name = (nameInput && nameInput.value.trim()) || '';
        if (!name) { showResult('请输入脚本名称', true); return; }
        var folderUri = '';
        try { folderUri = localStorage.getItem('tpFolderUri') || ''; } catch (e) { }
        if (saveBtn) saveBtn.disabled = true;
        if (saveHint) saveHint.textContent = '保存中…';
        post('/api/osr/touchpad-save', { folderUri: folderUri, name: name, actions: recActions })
            .then(function (r) {
                if (saveBtn) saveBtn.disabled = false;
                if (r && r.ok) {
                    var where = (r.path || '').length > 60 ? ('…' + r.path.slice(-60)) : r.path;
                    showResult('已保存 ' + r.name + '（' + r.count + ' 个动作，' + fmtDur(r.durationMs || 0) + '）', false, 6000);
                    if (saveHint) saveHint.textContent = '保存成功：' + where;
                    // 保存即入列表：用户下一步往往就是「点它跑起来」，顺手排到最前。
                    var paths = [];
                    if (r.files && r.files.length) {
                        for (var k = 0; k < r.files.length; k++) paths.push(r.files[k]);
                    } else if (r.path) paths.push(r.path);
                    recList.unshift({
                        name: r.name || name,
                        paths: paths,
                        durationMs: r.durationMs || 0,
                        at: Date.now(),
                        actions: recActions.slice()
                    });
                    if (recList.length > 20) recList.length = 20;
                    listPersist();
                    renderList();
                    recActions = [];
                    if (saveBox) saveBox.style.display = 'none';
                    if (recTime) recTime.textContent = '';
                } else {
                    var msg = (r && (r.error || r.detail)) || '未知错误';
                    showResult('保存失败：' + msg, true, 6000);
                    if (saveHint) saveHint.textContent = '';
                    if (r && r.error === 'no_actions') openSaveBox();
                }
            });
    }
    function discard() {
        recActions = [];
        if (saveBox) saveBox.style.display = 'none';
        if (recTime) recTime.textContent = '';
        showResult('已丢弃本次录制', false);
    }

    /* ---------- 模式：手动 / 陀螺仪A / 陀螺仪B ---------- */
    // 两种陀螺仪都复用同一套原生姿态桥 window.__onOrbitTilt(x, y, shake)，只是前端对上下轴的解读不同：
    //   · 陀螺仪A（2.6.63 原版）：左右倾角 = R0+R1 摆动，前后倾角 = L0 升降，都是「角度直接映射」，
    //     等于把手机当触板用——翻一下手机设备就动一下，方向用户已确认正确别再动。
    //   · 陀螺仪B（2.6.66 改版）：左右倾角 = R0+R1 摆动；上下 = 摇一摇（竖直甩动的冲量按 dt 积分）。
    //     摇动峰值被保住，停手即停、位置不回弹。
    //   · 两种陀螺仪模式下触板拖拽一律失效（手指坐标和姿态会互相打架）：bindPad 早退 +
    //     给 pad 挂 .tp-tilt-locked（CSS pointer-events:none），双保险。只锁输入、不改发送路径。
    // 发送路径与手动完全一致（同样走 kickSend 串行泵）。数据源优先原生桥（约 33Hz），
    // 拿不到时退回 Web 的 deviceorientation（无线性加速度，陀螺仪B 上下轴保持不动）。
    var tpMode = 'manual';                 // manual | tiltA | tiltB
    var tiltBaseX = 0;                     // 「归中」那一刻的左右倾角，之后都按相对它偏移
    var tiltBaseY = 0;                     // 「归中」那一刻的前后倾角（仅陀螺仪A 用）
    var tiltLastX = 0;                     // 最近一次收到的原始左右倾角（归中时取它当基准）
    var tiltLastY = 0;                     // 最近一次收到的原始前后倾角
    var tiltPosY = 50;                     // 摇一摇 的上下轴由竖直摇动积分累积
    var tiltPosX = 50;                     // 摇一摇 的左右轴由水平横摇积分累积
    var tiltLastTs = 0;                    // 上一次收到姿态的时间，用来算积分步长 dt
    var tiltSens = 2.0;                    // 灵敏度：偏离基准多少度走满半程（默认 ±25° 走满），陀螺仪模式左右/前后共用
    var tiltShake = 1.0;                   // 摇一摇 的摇动幅度倍数（同时影响左右横摇与上下摇动）
    var tiltLive = false;                  // 是否收到过姿态数据
    var tiltHintTs = 0;
    var SHAKE_GAIN = 55;                   // 摇动冲量 → 行程百分比（再乘 tiltShake）；加大后摇一次可接近满行程
    var SHAKE_DEAD = 0.5;                  // m/s² 死区：手抖、走路摆动不该驱动设备
    var modeBtns = [], tiltBox, tiltHint, tiltSensEl, tiltSensVal, tiltCalibBtn,
        tiltShakeEl, tiltShakeVal, tiltShakeRow;

    function setMode(m) {
        if (m !== 'tiltA' && m !== 'tiltB') m = 'manual';
        tpMode = m;
        var isTilt = (m === 'tiltA' || m === 'tiltB');
        for (var i = 0; i < modeBtns.length; i++) {
            modeBtns[i].classList.toggle('ob-btn--primary',
                modeBtns[i].getAttribute('data-mode') === tpMode);
        }
        if (tiltBox) tiltBox.style.display = isTilt ? '' : 'none';
        // 两种陀螺仪模式都挂锁（CSS 里 pointer-events:none，触板彻底不吃手指）；
        // 手动模式摘掉，否则整块触板会一直点不动。
        if (pad) pad.classList.toggle('tp-tilt-locked', isTilt);
        // 摇动幅度滑块只在摇一摇模式时出现；陀螺仪模式是角度映射，没有这个参数。
        if (tiltShakeRow) tiltShakeRow.style.display = (m === 'tiltB') ? '' : 'none';
        if (isTilt) {
            tiltLive = false;
            tiltPosY = 50;      // 每次进摇一摇模式都从中间起手，免得带着上次的行程
            tiltPosX = 50;
            tiltLastTs = 0;
            startTiltSource();
            if (tiltHint) tiltHint.textContent = (m === 'tiltA')
                ? '等待姿态数据…　左右横摇 = R0+R1 摆动，前后翻转 = L0 升降'
                : '等待姿态数据…　左右横摇 = R0+R1 摆动，上下摇 = L0 升降';
        } else {
            stopTiltSource();
        }
    }

    function startTiltSource() {
        if (window.Orbit && typeof window.Orbit.startTilt === 'function') {
            window.Orbit.startTilt();
            return;
        }
        window.addEventListener('deviceorientation', onWebOrient, true);
    }
    function stopTiltSource() {
        if (window.Orbit && typeof window.Orbit.stopTilt === 'function') window.Orbit.stopTilt();
        window.removeEventListener('deviceorientation', onWebOrient, true);
    }
    /** Web 姿态事件兜底：beta=前后、gamma=左右，按屏幕旋转换轴。 */
    function onWebOrient(ev) {
        if (ev.beta == null && ev.gamma == null) return;
        var roll = ev.gamma || 0, pitch = ev.beta || 0;
        var ang = (window.screen && window.screen.orientation && window.screen.orientation.angle) || 0;
        var x = roll, y = pitch;
        if (ang === 90) { x = -pitch; y = roll; }
        else if (ang === 180) { x = -roll; y = -pitch; }
        else if (ang === 270) { x = pitch; y = -roll; }
        pushTilt(x, y, 0);      // Web 姿态事件没有线性加速度，上下轴保持不动
    }
    /** 原生传感器桥回调：x=左右倾角（右倾为正，度）、y=前后倾角（上抬为正，度）、shake=竖直摇动强度（m/s²）、shakeX=水平横摇强度（m/s²，右为正）。
     *  只转发给「活动面板」：window.__activeTiltSink==='tp' 时由触板驱动。
     *  脚本编辑面板复用触板驱动（进入时调用 registerActive 把 sink 置为 'tp'），
     *  两面板互斥、不会同时抢着驱动设备。 */
    window.__onOrbitTilt = function (x, y, shake, shakeX) {
        if (window.__activeTiltSink === 'tp') pushTilt(x, y, shake, shakeX);
    };

    function pushTilt(x, y, shake, shakeX) {
        if (tpMode !== 'tiltA' && tpMode !== 'tiltB') return;
        tiltLive = true;
        tiltLastX = x;
        tiltLastY = y;
        var now = Date.now();
        var dt = tiltLastTs ? (now - tiltLastTs) / 1000 : 0;
        tiltLastTs = now;
        var yPos, xPos;
        if (tpMode === 'tiltA') {
            // 陀螺仪：上下 = 前后倾角（角度直接映射），和左右一样用灵敏度。
            yPos = 50 + (y - tiltBaseY) * tiltSens;
            xPos = 50 + (x - tiltBaseX) * tiltSens;
        } else {
            // 摇一摇：左右 = 水平横摇积分，上下 = 竖直摇动积分。
            // 把摇动强度按帧长积分成行程，别只看瞬时值 ——
            // 摇动是往复的，瞬时正负交替会互相抵消，只有积分出来才对应「摇得多走得远」。
            if (dt > 0 && dt < 0.2) {
                var gain = SHAKE_GAIN * tiltShake;
                var rawSy = (typeof shake === 'number' ? shake : 0);
                var rawSx = (typeof shakeX === 'number' ? shakeX : 0);
                // 死区必须在 gain 放大前判断：gain=55 会把 0.01 的微小 DC 漂移也积成 0.55，
                // 导致不摇时慢慢偏到单侧；只有 raw 明显超过死区才积分。
                if (Math.abs(rawSy) > SHAKE_DEAD) {
                    tiltPosY = clamp(tiltPosY + rawSy * gain * dt);
                }
                if (Math.abs(rawSx) > SHAKE_DEAD) {
                    tiltPosX = clamp(tiltPosX + rawSx * gain * dt);
                }
            }
            yPos = tiltPosY;
            xPos = tiltPosX;
        }
        setKnob(xPos, yPos);
        kickSend();
        if (tiltHint && now - tiltHintTs > 200) {
            tiltHintTs = now;
            var sv = (typeof shake === 'number' && shake) ? shake.toFixed(1) : '0.0';
            var sxv = (typeof shakeX === 'number' && shakeX) ? shakeX.toFixed(1) : '0.0';
            tiltHint.textContent = (tpMode === 'tiltA')
                ? '左右倾角 ' + x.toFixed(0) + '°　→　R0+R1 摆动 ' + Math.round(curX) +
                    '%　｜　前后倾角 ' + y.toFixed(0) + '°　→　L0 升降 ' + Math.round(curY) + '%'
                : '左右横摇 ' + sxv + ' m/s²　→　R0+R1 摆动 ' + Math.round(curX) +
                    '%　｜　上下摇 ' + sv + ' m/s²　→　L0 升降 ' + Math.round(curY) + '%';
        }
    }

    function tiltCalibrate() {
        tiltBaseX = tiltLastX;
        tiltBaseY = tiltLastY;
        tiltPosY = 50;
        tiltPosX = 50;
        tiltLastTs = 0;
        if (tiltHint) tiltHint.textContent = '已归中（左右/前后以当前姿势为准，上下回到 50%）';
        setKnob(50, 50);
        resetSentCursor();
        kickSend();
    }

    function bindMode() {
        modeBtns = [];
        // 只绑「手控触板」面板内的模式按钮，避免误绑「脚本编辑」面板的同名按钮（它也复用 tp-mode-btn 样式）
        var scope = document.getElementById('panel-touchpad') || document;
        var btns = scope.querySelectorAll('.tp-mode-btn');
        for (var i = 0; i < btns.length; i++) {
            (function (b) {
                modeBtns.push(b);
                b.addEventListener('click', function () {
                    setMode(b.getAttribute('data-mode'));
                });
            })(btns[i]);
        }
        if (tiltCalibBtn) tiltCalibBtn.addEventListener('click', tiltCalibrate);
        if (tiltSensEl) {
            var sync = function () {
                tiltSens = parseFloat(tiltSensEl.value) || 2.0;
                if (tiltSensVal) tiltSensVal.textContent = tiltSens.toFixed(1) + '×（±' +
                    Math.round(50 / tiltSens) + '° 走满）';
            };
            tiltSensEl.addEventListener('input', sync);
            sync();
        }
        // 摇动幅度同时放大左右横摇与上下摇动，摇一次可接近满行程
        if (tiltShakeEl) {
            var syncShake = function () {
                tiltShake = parseFloat(tiltShakeEl.value) || 1.0;
                if (tiltShakeVal) tiltShakeVal.textContent = tiltShake.toFixed(1) + '×（摇一次约走 ' +
                    Math.round(SHAKE_GAIN * tiltShake * 0.45) + '%）';
            };
            tiltShakeEl.addEventListener('input', syncShake);
            syncShake();
        }
    }

    /* ---------- 初始化 ---------- */
    function init() {
        pad = $('tpPad'); knob = $('tpKnob');
        posVal = $('tpPosVal'); posLR = $('tpPosLR');
        recBtn = $('tpRecBtn'); recTime = $('tpRecTime');
        recDot = $('tpRecDot'); recTxt = $('tpRecTxt');
        saveBox = $('tpSaveBox'); nameInput = $('tpName');
        pickBtn = $('tpPickFolder'); folderHint = $('tpFolderHint');
        saveBtn = $('tpSaveBtn'); discardBtn = $('tpDiscardBtn'); saveHint = $('tpSaveHint');
        listEl = $('tpRecList'); listHint = $('tpRecListHint');
        tiltBox = $('tpTiltBox'); tiltHint = $('tpTiltHint');
        tiltSensEl = $('tpTiltSens'); tiltSensVal = $('tpTiltSensVal');
        tiltShakeEl = $('tpTiltShake'); tiltShakeVal = $('tpTiltShakeVal');
        tiltShakeRow = $('tpTiltShakeRow');
        tiltCalibBtn = $('tpTiltCalib');
        if (!pad) return;

        // 先把状态置中（只更新数值显示），坐标等 pad 有真实尺寸后再定位。
        curX = 50; curY = 50;
        if (posVal) posVal.textContent = '50%';
        if (posLR) posLR.textContent = '50%';
        bindPad();
        bindMode();
        setKnob(50, 50);          // 布局已就绪时立刻定位；尺寸为 0 会被守卫跳过
        loadList();
        renderList();
        bindList();
        // pad 尺寸从 0 变为真实值（首次布局 / 切到触板页 / 横竖屏）时重算一次，
        // 保证圆点落在中心而不是卡在左上角。
        var relayout = function () { setKnob(curX, curY); };
        if (typeof ResizeObserver === 'function') {
            try { new ResizeObserver(relayout).observe(pad); } catch (e) { }
        } else {
            window.addEventListener('resize', relayout);
        }

        if (recBtn) recBtn.addEventListener('click', function () {
            if (recording) stopRec(); else startRec();
        });
        if (pickBtn) pickBtn.addEventListener('click', function () {
            if (window.Orbit && typeof window.Orbit.grantRecordFolder === 'function') {
                pendingSave = true;
                takeoverGrant();
                window.Orbit.grantRecordFolder();
            } else {
                showResult('当前环境不支持目录选择（需在 App 内使用）', true);
            }
        });
        if (saveBtn) saveBtn.addEventListener('click', doSave);
        if (discardBtn) discardBtn.addEventListener('click', discard);

        // 离开触板页要停掉传感器：否则后台还在持续按姿态下发指令，
        // 用户会发现「我只是翻了个身，设备自己在动」。
        // 面板进入/离开时登记为「活动陀螺仪面板」：进来占坑、出去让位，避免和脚本编辑面板互抢姿态。
        window.__tpPanelLeave = function () { unregisterActive(); post('/api/osr/reset').catch(function(){}); };
        window.__tpPanelEnter = function () { registerActive(); };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    /* 暴露触板驱动能力给其它面板（脚本编辑复用同一套设备驱动，单一来源）。
       行为完全不变，仅新增导出；陀螺仪通过 registerActive/unregisterActive 登记活动面板，
       与脚本编辑面板的姿态转发互不干扰。 */
    function registerActive() {
        window.__activeTiltSink = 'tp';
        if (tpMode === 'tiltA' || tpMode === 'tiltB') startTiltSource();
    }
    function unregisterActive() {
        if (window.__activeTiltSink === 'tp') window.__activeTiltSink = null;
        if (tpMode === 'tiltA' || tpMode === 'tiltB') stopTiltSource();
    }
    window.OrbitTouchpad = {
        setKnob: setKnob,
        kickSend: kickSend,
        sendAxes: sendAxes,
        getPos: function () { return { x: curX, y: curY }; },
        setMode: setMode,
        startTiltSource: startTiltSource,
        stopTiltSource: stopTiltSource,
        resetSentCursor: resetSentCursor,
        _pushTilt: pushTilt,
        registerActive: registerActive,
        unregisterActive: unregisterActive,
        // 供「脚本编辑」面板复用同一套陀螺仪参数调节（原只在触板面板内可调）
        setTiltSens: function (v) { var n = parseFloat(v); tiltSens = (isNaN(n) ? 2.0 : Math.max(0.5, Math.min(4, n))); },
        setTiltShake: function (v) { var n = parseFloat(v); tiltShake = (isNaN(n) ? 1.0 : Math.max(0.2, Math.min(3, n))); },
        tiltCalibrate: tiltCalibrate
    };
})();
