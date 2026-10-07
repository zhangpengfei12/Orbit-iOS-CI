/* 首页仪表板：顶栏 OSR 状态 + 磁贴交互 */
(function () {
    'use strict';

    function $(id) { return document.getElementById(id); }

    /* ---------- 首页「设备」磁贴副标题：实时状态 ---------- */
    var dot = $('hmDot');
    var stateEl = $('hmDevState');
    var timer = null;

    function apply(status) {
        if (!status) return;
        var mode = status.motionMode || 'idle';
        var running = mode !== 'idle';
        // 链路状态一律用后端 linkState，前端不自行推断：
        //   disabled     未启用硬件输出（开关关了）
        //   connected    有真实证据（蓝牙 SPP 已连 / TCP socket 已建 / USB 设备在位 / UDP 近 30s 发送成功）
        //   idle         UDP 无回执且还没发过指令 —— 不能谎报「已连接」
        //   disconnected 明确断开
        // ⚠️ 绝不能用 enabled（启用硬件输出开关，**默认常开**）判断连接：
        //    开关开着 ≠ 设备在线上，用它判连接会让「一进 app 就显示已连接」（真机踩过两次）。
        var linkState = status.linkState || 'disconnected';
        var connected = (linkState === 'connected');

        if (dot) dot.className = 'hm-dot' + (connected ? ' on' : '');
        if (!stateEl) return;
        if (linkState === 'disabled') stateEl.textContent = '离线';
        else if (status.lastSendError) stateEl.textContent = '发送失败';
        // 运行中只显示 3 字短文案：圆点已经表示「已连接」，而把连接态与运行态
        // 拼成 8 个字符的长串，在窄屏磁贴（360dp 下 .hm-s 仅 ~83px）会被 ellipsis 截断。
        else if (connected) stateEl.textContent = running ? '运行中' : '已连接';
        else if (linkState === 'idle') stateEl.textContent = '待机';
        else stateEl.textContent = '未连接';
    }

    function refresh() {
        fetch('/api/osr/status', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) { apply(d); })
            .catch(function () { /* 后端未就绪时保留默认「设备离线」 */ });
    }

    function startPolling() {
        if (timer) return;
        refresh();
        timer = setInterval(refresh, 4000);
    }

    function stopPolling() {
        if (timer) { clearInterval(timer); timer = null; }
    }

    startPolling();
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) stopPolling(); else startPolling();
    });

    /* ---------- 轻提示 ---------- */
    var toast = $('hmToast');
    var toastTimer = null;

    function showToast(text) {
        if (!toast) return;
        toast.textContent = text;
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 2200);
    }

    /* ---------- 首页「设备状态」磁贴：打开设备自带的配置页 ----------
       AP 配网默认 192.168.4.1；配网后做设备校准则填设备拿到的静态 IP。 */
    var devCfgBtn = $('hmDevCfgBtn');
    if (devCfgBtn) {
        devCfgBtn.addEventListener('click', function () {
            if (window.Orbit && typeof window.Orbit.openDeviceConfig === 'function') {
                window.Orbit.openDeviceConfig('192.168.4.1');
            } else {
                showToast('请在 App 内打开设备配置页（192.168.4.1）');
            }
        });
    }

    var soonBtns = document.querySelectorAll('.hm-tile[data-soon]');
    Array.prototype.forEach.call(soonBtns, function (btn) {
        btn.addEventListener('click', function () {
            showToast('「' + btn.dataset.soon + '」暂未实现');
        });
    });

    /* 帮助已搬到独立页面（?panel=help），首页「帮助」磁贴直接跳页，不再需要浮层逻辑 */

    /* ---------- 版本号（记录文本已移到独立页面 ?panel=ver） ----------
       记录数据仍来自 /js/changelog.js（唯一真值源），但只在这里渲染「磁贴副标题 + 页脚」
       两个版本号；完整更新记录由 index.html 的「版本信息」页读同一个文件渲染，
       两处不会各自漂移。 */
    var TAG_LABEL = { add: '新增', opt: '优化', fix: '修复' };

    function esc(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function renderVersionLog() {
        var data = window.ORBIT_CHANGELOG;
        if (!data || !data.entries) return;

        var cur = data.current || '';
        if (cur) {
            var tv = $('hmVerText');
            if (tv) tv.textContent = 'v' + cur;
            var fv = $('hmFootVer');
            if (fv) fv.textContent = 'v' + cur;
        }

    }

    // 首屏就把两个版本号填好
    renderVersionLog();

    /* ---------- 返回首页时刷新一次状态 ---------- */
    window.addEventListener('pageshow', function (e) {
        if (e.persisted) startPolling();
    });
})();
