/* 脚本编辑入口（2026-09-30 改版）
 * ----------------------------------------------------------------
 * 用户在「设置 → 脚本编辑」面板内选视频，选完后直接跳转到完整播放器页
 * /player/?manualrec=1 进行录制。录制 UI（L0 滑块、波形、保存）由 player.html/js 提供。
 */
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    var resultBox = null;

    function showResult(text, isErr, holdMs) {
        if (!resultBox) return;
        resultBox.textContent = text;
        resultBox.className = 'osr-result' + (isErr ? ' err' : '');
        resultBox.style.display = '';
        clearTimeout(resultBox._t);
        resultBox._t = setTimeout(function () { resultBox.style.display = 'none'; }, holdMs || 5000);
    }

    // 自包含 base64url：不依赖 app.js 是否暴露 window.libB64Url
    function b64url(s) {
        try {
            var bin = unescape(encodeURIComponent(String(s)));
            return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        } catch (e) { return ''; }
    }

    // 脚本编辑面板自我激活：兼容深链接/磁贴进入时 showSettingsPanel 的 __mrPanelEnter 调用被错过的情况
    var mrActive = false;
    function syncActive() {
        try {
            var params = new URLSearchParams(location.search);
            var panel = params.get('panel');
            var activePanel = document.querySelector('.settings-panel.active');
            if (panel === 'manualrecord' || (activePanel && activePanel.id === 'panel-manualrecord')) {
                mrActive = true;
            }
        } catch (e) {}
    }
    syncActive();

    // 接管选片回调：只在脚本编辑面板活跃时拦截，否则转给 app.js 的生成面板。
    var _origPickVideo = window.__onPickVideo;
    var mrPickPending = false;   // 用户刚点过「选择视频」，标志 30s 内返回的回调必须归脚本编辑
    var mrPickTimer = null;      // 倒计时句柄：绝不能用 mrPickPending._t —— 布尔基元在 'use strict' 下挂属性会抛 TypeError，导致 pickVideo 永不调用
    function isManualRecContext() {
        if (mrPickPending) return true;
        try {
            var params = new URLSearchParams(location.search);
            if (params.get('panel') === 'manualrecord') return true;
            var activePanel = document.querySelector('.settings-panel.active');
            if (activePanel && activePanel.id === 'panel-manualrecord') return true;
        } catch (e) {}
        return false;
    }
    window.__onPickVideo = function (uri, name, size, writable) {
        // 兜底：回调触发时再确认一次，防止 mrActive 在选片期间被异常复位
        syncActive();
        if (!mrActive && !isManualRecContext()) {
            if (typeof _origPickVideo === 'function') _origPickVideo(uri, name, size, writable);
            return;
        }
        mrPickPending = false;
        if (!uri) { showResult('已取消选择', false); return; }
        var pickedName = $('mrPicked');
        var pickedNameB = $('mrPickedName');
        if (pickedName) pickedName.style.display = '';
        if (pickedNameB) pickedNameB.textContent = name || '已选视频';
        // 直接把原始 content:// URI 作为 player key 传给播放器（encodeURIComponent 已保证 URL 安全）。
        // ⚠ 不能用 base64url 包装：服务端 /video/<key> 的 resolveStreamKey 只认 content:// / smb:// /
        //   本机路径 / 库内 id 四种形态，b64 串不在其中 → 404 no_stream，播放器黑屏「选完没反应」。
        var src = '/player/?video=' + encodeURIComponent(uri) +
            '&title=' + encodeURIComponent(String(name || '')) +
            '&manualrec=1' +
            '&uri=' + encodeURIComponent(uri) +
            '&return=manualrecord';
        try { location.href = src; }
        catch (e) { showResult('打开播放器失败：' + ((e && e.message) || '未知错误'), true); }
    };

    window.__mrPanelEnter = function () { mrActive = true; };
    window.__mrPanelLeave = function () { mrActive = false; };

    function onClickPick() {
        mrPickPending = true;
        try { clearTimeout(mrPickTimer); } catch (e) {}
        mrPickTimer = setTimeout(function () { mrPickPending = false; }, 30000);
        // 优先用「脚本编辑专用」桥：选完视频由**原生**直接跳播放器页。
        // 原因：选择器是全屏 Activity，期间 MainActivity 可能被系统回收重建，回来时页面
        // JS 上下文（mrActive / URL 的 panel 参数）已丢失，回调会被 app.js 的版本接管，
        // 表现为「选完既不开播放器、也没有任何提示」。老版本 App 没有该桥方法时回落到原逻辑。
        if (window.Orbit && typeof window.Orbit.pickVideoManualRec === 'function') {
            window.Orbit.pickVideoManualRec();
        } else if (window.Orbit && typeof window.Orbit.pickVideo === 'function') {
            window.Orbit.pickVideo();
        } else {
            showResult('当前环境不支持系统文件选择器', true);
            mrPickPending = false;
        }
    }
    function bind() {
        resultBox = $('mrResult');
        // 事件委托（捕获阶段）：脚本编辑面板若被重绘替换了按钮节点，直绑监听器会随之失效、
        // 点击无反应；委托到 document 上可确保点击恒触发选片（面板重绘也不丢）。
        document.addEventListener('click', function (e) {
            var t = e.target;
            while (t && t !== document) {
                if (t.id === 'mrPickVideo') { onClickPick(); return; }
                t = t.parentNode;
            }
        }, true);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();
