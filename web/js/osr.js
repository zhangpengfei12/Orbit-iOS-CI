/* ===== OSR 硬件控制面板 =====
 * 功能移植自 DoroPlayer（连接层/指令/运动算法），后端 API 见 WebServer.handleOsr。
 * 对应参考网页：mosa（运动测试台 + 随机/正弦自动模式）与 Ayva Stroker Lite（自由演奏）。
 * 蓝牙连接对齐「OSR设备脚本播放器」：点「蓝牙」进入全屏设备页 → 扫描 → 手动选设备连接。
 */
(function () {
    'use strict';

    function $(id) { return document.getElementById(id); }

    var AXIS_ORDER = ['L0', 'L1', 'L2', 'R0', 'R1', 'R2'];
    var AXIS_LABEL = {
        L0: '上下', L1: '前后', L2: '左右',
        R0: '旋转', R1: '俯仰', R2: '翻滚'
    };
    var AXIS_VALUE_MAX = 9999;
    var CENTER = Math.round(AXIS_VALUE_MAX / 2);

    var settings = {};
    var activeMode = 'freeplay';
    var playing = false;
    // 脚本播放：开始/暂停合一按钮的当前态。始终以后端 status.clockPlaying 为准，
    // 本地只在点击瞬间做乐观切换，避免界面与真实播放态脱节。
    var scriptPlaying = false;
    var pollTimer = null;
    var hintTimer = null;
    var lastStatus = null;
    var currentMethod = 'wifi';   // 'bt' | 'wifi' | 'usb'
    var wifiProto = 'UDP';        // 仅 UDP（TCP 选项已移除，2026-09-18）
    var usbDevices = [];
    var lastUsbScan = null;       // 最近一次 /api/osr/usb-scan 的原始响应，用于 OTG 提示

    /* ---------- 蓝牙状态 ---------- */
    var btSelected = '';          // 已选中的设备地址（保存进设置）
    var btKind = 'ble';           // 'ble' | 'classic'
    var btName = '';              // 已选中的设备名
    var btDevMap = {};            // 扫描到的设备，key = kind + ':' + address
    var btScanning = false;
    var btConnectingAddr = null;  // 正在连接的地址
    var btConnectingKind = null;
    var btConnectedAddr = null;   // 当前已连接地址（来自原生回调/状态查询）
    var btConnectedKind = null;

    /** 已提示过的发送失败原因，避免自动模式轮询时反复弹同一条。 */
    var lastShownSendError = null;

    var BT_ICON = '<svg class="bt-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M7 7l10 10-5 5V2l5 5L7 17"/></svg>';

    /* ---------- 通用请求 ---------- */
    // 注意：解析失败时必须保留 HTTP 状态与原响应文本，否则后端（或代理链路）
    // 返回非 JSON 时前端只会拿到空对象，提示就变成「连接失败：」后面什么都没有。
    function readResponse(r) {
        return r.text().then(function (txt) {
            var obj = null;
            try { obj = JSON.parse(txt); } catch (e) { obj = null; }
            if (obj && typeof obj === 'object') {
                if (obj.httpStatus == null) obj.httpStatus = r.status;
                return obj;
            }
            return { error: 'bad_response', httpStatus: r.status, raw: (txt || '').slice(0, 160) };
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
    function get(path) {
        return fetch(path).then(readResponse)
            .catch(function (e) { return { error: 'network', detail: '请求失败：' + ((e && e.message) || '网络错误') }; });
    }

    /** 从响应里取一句人话的原因；任何情况下都不返回空串。 */
    function apiReason(r) {
        if (!r) return '无响应';
        var s = r.detail || r.message || '';
        if (!s && r.error && r.error !== 'network' && r.error !== 'bad_response') s = String(r.error);
        if (!s && r.ok === false) s = '后端未给出具体原因';
        if (!s) {
            s = r.error === 'network' ? '请求未能送达应用服务（连接中断）' : '响应格式异常';
            if (r.httpStatus) s += '，HTTP ' + r.httpStatus;
            if (r.raw) s += '：' + r.raw;
        }
        return s;
    }

    function showHint(el, text) {
        if (!el) return;
        el.textContent = text || '已保存';
        el.classList.add('show');
        clearTimeout(hintTimer);
        hintTimer = setTimeout(function () { el.classList.remove('show'); }, 1600);
    }

    function showResult(text, isErr, holdMs) {
        // 设备页与测试机器页各有一个结果提示框，两处同步更新，
        // 否则在测试页点「开始」时提示会写到另一个未显示的面板里。
        var boxes = document.querySelectorAll('.osr-result');
        if (!boxes.length) return;
        Array.prototype.forEach.call(boxes, function (box) {
            box.textContent = text;
            box.className = 'osr-result' + (isErr ? ' err' : '');
            box.style.display = '';
            clearTimeout(box._t);
            box._t = setTimeout(function () { box.style.display = 'none'; }, holdMs || 4000);
        });
    }

    /* ---------- 构建动态 DOM ---------- */
    function buildViz() {
        var wrap = $('osrViz');
        if (!wrap) return;
        var html = '';
        AXIS_ORDER.forEach(function (a) {
            html += '<div class="osr-viz-row">' +
                '<span class="osr-viz-name" title="' + a + ' ' + AXIS_LABEL[a] + '">' + a + '</span>' +
                '<span class="osr-viz-track"><span class="osr-viz-center"></span>' +
                '<span class="osr-viz-fill" id="osrVizFill' + a + '" style="left:0;width:50%"></span></span>' +
                '<span class="osr-viz-val" id="osrVizVal' + a + '">' + CENTER + '</span>' +
                '</div>';
        });
        wrap.innerHTML = html;
    }

    function buildManual() {
        var wrap = $('osrManualAxes');
        if (!wrap) return;
        var html = '';
        AXIS_ORDER.forEach(function (a) {
            html += '<div class="axis-ctrl-row">' +
                '<span class="axis-ctrl-label">' + a + ' ' + AXIS_LABEL[a] + '</span>' +
                '<input type="range" class="axis-slider" id="osrMan' + a + '" min="0" max="' + AXIS_VALUE_MAX + '" value="' + CENTER + '">' +
                '<span class="axis-ctrl-value" id="osrManVal' + a + '">' + CENTER + '</span>' +
                '</div>';
        });
        wrap.innerHTML = html;

        AXIS_ORDER.forEach(function (a) {
            var sl = $('osrMan' + a);
            if (!sl) return;
            // input：拖动过程中持续触发，此前这里只改数字、不发指令，
            // 结果就是「拖的时候设备不动，松手才跳一下」。现在即时下发（走串行泵节流）。
            sl.addEventListener('input', function () {
                var v = $('osrManVal' + a);
                if (v) v.textContent = sl.value;
                dragSend(a, parseInt(sl.value, 10) || 0, 120);
            });
            // change：部分浏览器在拖动结束前不会补发最后一个 input，
            // 这里兜底再发一次当前值（值没变时是无害的重发）。
            sl.addEventListener('change', function () {
                dragSend(a, parseInt(sl.value, 10) || 0, 600);
            });
        });
    }

    /* ---------- 蓝牙开机自动重连 ----------
       上次用蓝牙连过的设备地址随设置一起持久化了，所以打开 App 就能直接接上，
       不必每次进设备页点一遍。只在每次启动后尝试一次；
       失败（蓝牙没开 / 设备不在身边 / 没授权）一律静默 —— 用户主动点连接时才提示。 */
    var btAutoTried = false;
    var btAutoConnecting = false;
    function scheduleBtAutoConnect() {
        if (btAutoTried) return;
        if (currentMethod !== 'bt' || !btSelected) return;
        if (typeof window.Orbit === 'undefined'
            || typeof window.Orbit.connectBluetooth !== 'function') return;
        btAutoTried = true;
        get('/api/osr/bt-status').then(function (r) {
            if (r && r.connected) return;          // 已经连着，不用再连
            // 等首屏渲染与权限流程先走完再发起，避免与页面初始化抢主线程
            setTimeout(function () {
                btAutoConnecting = true;
                try { window.Orbit.connectBluetooth(btSelected, btKind, btName); }
                catch (e) { btAutoConnecting = false; }
            }, 1200);
        });
    }

    /* ---------- 设置读写 ---------- */
    function fillForm(s) {
        settings = s || {};
        if ($('osrConnType')) $('osrConnType').value = s.connectionType || 'UDP';
        if ($('osrProtocol')) $('osrProtocol').value = s.protocol || 'AUTO';
        if ($('osrIp')) $('osrIp').value = s.ip || '192.168.1.88';
        if ($('osrPort')) $('osrPort').value = s.port || 8000;
        if ($('osrSerialDevice')) $('osrSerialDevice').value = s.serialDevice || '1a86:7523';
        if ($('osrBaud')) $('osrBaud').value = s.baudRate || 115200;
        // 播放同步已改为全局默认开启（2026-09-18 移除「影片同步」开关），不再有对应控件
        // 蓝牙已选设备
        btSelected = s.btAddress || '';
        btKind = s.btKind || 'ble';
        btName = s.btName || '';
        // WiFi 仅保留 UDP（TCP 选项已移除，2026-09-18）：固定为 UDP
        wifiProto = 'UDP';
        applyMethod(methodFromConnectionType(s.connectionType));
        updateBtPickedCard();
        refreshBtStatus();
        scheduleBtAutoConnect();
    }

    function collectForm() {
        return {
            // 硬件输出固定开启：页面已移除该开关（2026-09-17）
            enabled: true,
            connectionType: (currentMethod === 'usb') ? 'Serial'
                : (currentMethod === 'bt') ? 'BluetoothSerial'
                : 'UDP',
            protocol: $('osrProtocol') ? $('osrProtocol').value : 'AUTO',
            ip: $('osrIp') ? $('osrIp').value.trim() : '192.168.1.88',
            port: parseInt($('osrPort') && $('osrPort').value, 10) || 8000,
            serialDevice: $('osrSerialDevice') ? $('osrSerialDevice').value.trim() : '',
            baudRate: parseInt($('osrBaud') && $('osrBaud').value, 10) || 115200,
            btAddress: btSelected,
            btKind: btKind,
            btName: btName,
            prefix: '',
            suffix: '',
            // TCode 末尾换行固定开启：页面已移除该开关（2026-09-17）
            tcodeNewline: true,
            // 全局默认同步：保存设置时始终写 true，否则「设备页保存」会把同步冲成关闭
            syncEnabled: true,
            // 轴参数与路由由「OSR 轴设置」面板维护，原样保留避免覆盖
            axisParams: settings.axisParams || {},
            axisRoutes: settings.axisRoutes || {},
            // 旋转补偿 / 俯卧补偿：同样由「OSR 轴设置」面板维护，原样回传避免被冲回默认
            rotationFillMode: (settings.rotationFillMode === 'follow' || settings.rotationFillMode === 'sweep') ? settings.rotationFillMode : 'off',
            proneFillMode: (settings.proneFillMode === 'follow' || settings.proneFillMode === 'sweep') ? settings.proneFillMode : 'off',
            rotationFillAmp: (typeof settings.rotationFillAmp === 'number') ? settings.rotationFillAmp : 85,
            proneFillAmp: (typeof settings.proneFillAmp === 'number') ? settings.proneFillAmp : 80
        };
    }

    /* ---------- 设备自带 WiFi 配置页（全屏 WebView） ----------
       设备 AP 模式下会起一个网页配置中心（默认 192.168.4.1）。
       真正的加载由原生 DeviceWebActivity 完成，这里只负责把地址交出去。 */
    function openDeviceConfig() {
        var addr = '192.168.4.1';
        if (window.Orbit && typeof window.Orbit.openDeviceConfig === 'function') {
            try { window.Orbit.openDeviceConfig(addr); return; } catch (e) { }
        }
        // 浏览器（非 App）环境：没有原生桥，给出降级提示而不是静默失败
        var box = $('osrResult');
        if (box) {
            box.style.display = '';
            box.textContent = '请在 App 内打开设备配置页：http://' + addr;
        }
    }

    /* ---------- 自动页「网页操作」：在系统浏览器（优先 Edge，其次 Chrome）打开 Ayva Stroker Lite ---------- */
    var WEB_APP_URL = 'https://www.ayva-stroker-lite.io/';
    function openWebApp() {
        // 网页操作需要连接设备的 Web Serial / Web Bluetooth，而应用内 WebView 不支持这些 API，
        // 因此直接在系统浏览器中打开（原生侧按 Edge → Chrome → 系统默认的顺序挑），
        // 才能正常连接设备并复用已授权的「附近设备」权限。
        if (window.Orbit && typeof window.Orbit.openExternal === 'function') {
            try { window.Orbit.openExternal(WEB_APP_URL); return; } catch (e) { }
        }
        // 旧包没有 openExternal 桥时的回退：仍走应用内 WebView（连接设备按钮可能无效，但页面可看）。
        if (window.Orbit && typeof window.Orbit.openWeb === 'function') {
            try { window.Orbit.openWeb(WEB_APP_URL); return; } catch (e) { }
        }
        var box = $('osrResult');
        if (box) { box.style.display = ''; box.textContent = '请在 App 内打开：' + WEB_APP_URL; }
    }

    /* ---------- 连接方式：先选方式，再按方式输入参数 ---------- */
    function methodFromConnectionType(t) {
        // ⚠ iOS 版没有 USB / 串口卡片（页面里只留了 bt 与 wifi 两张），
        //   若旧配置里存着 'Serial' 直接沿用会走到 usb 分支：两张卡片全被隐藏、
        //   参数区一片空白，看起来像「设置页坏了」。这里统一收敛回 WiFi。
        if (t === 'BluetoothSerial') return 'bt';
        return 'wifi'; // UDP
    }

    function syncConnectionType() {
        var ct = (currentMethod === 'usb') ? 'Serial'
            : (currentMethod === 'bt') ? 'BluetoothSerial'
            : 'UDP';
        var sel = $('osrConnType');
        if (sel) sel.value = ct;
    }

    function applyMethod(method) {
        currentMethod = method;
        var cards = document.querySelectorAll('#connMethods .conn-method');
        Array.prototype.forEach.call(cards, function (c) {
            c.classList.toggle('active', c.getAttribute('data-method') === method);
        });
        if ($('connBt')) $('connBt').style.display = (method === 'bt') ? '' : 'none';
        if ($('connWifi')) $('connWifi').style.display = (method === 'wifi') ? '' : 'none';
        if ($('connUsb')) $('connUsb').style.display = (method === 'usb') ? '' : 'none';
        syncConnectionType();
        if (method === 'usb') loadUsbDevices();
        if (method === 'bt') updateBtPickedCard();
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function renderUsbList() {
        var box = $('usbDeviceList');
        if (!box) return;
        if (!usbDevices.length) {
            var tip = lastUsbScan && lastUsbScan.otgTip ?
                '<div style="margin-top:8px;color:#ffcc80;font-size:12px">' +
                '手机支持 OTG，但系统没有枚举到 USB 设备。' +
                '部分机型需要在系统设置中手动打开「OTG」或「USB 连接」开关。' +
                '</div>' +
                '<button type="button" class="tool-btn" style="margin-top:10px" id="usbOpenOtg">去系统设置检查 OTG</button>' : '';
            box.innerHTML = '<div class="device-empty">未检测到任何 USB 设备。请用 USB 线连接设备后点「检测 USB 设备」。' + tip + '</div>';
            var btn = $('usbOpenOtg');
            if (btn) btn.onclick = function () {
                if (window.Orbit && window.Orbit.openSettings) window.Orbit.openSettings('android.settings.SETTINGS');
                else showResult('无法调起系统设置，请手动进入设置 → 其他网络与连接 → OTG 打开开关', true, 6000);
            };
            return;
        }
        var selectedId = ($('osrSerialDevice') && $('osrSerialDevice').value.trim()) || '';

        // 列表里只有一个设备且尚未选中时，自动选中并保存，避免用户只点了检测就点连接测试
        if (usbDevices.length === 1 && !selectedId) {
            selectedId = usbDevices[0].id;
            if ($('osrSerialDevice')) $('osrSerialDevice').value = selectedId;
            saveSettings(true);
        }

        var html = '';
        usbDevices.forEach(function (d) {
            var active = (selectedId === d.id) ? ' active' : '';
            var badge = '';
            if (!d.hasPermission) badge = '<span class="di-badge">未授权，点「检测 USB 设备」申请权限</span>';
            else if (d.serial === false) badge = '<span class="di-badge">无串口驱动，可能无法通信</span>';
            html += '<div class="device-item' + active + '" data-id="' + d.id + '">' +
                '<span class="di-name">' + escapeHtml(d.name) + '</span>' +
                '<span class="di-sub">VID:PID ' + escapeHtml(d.id) + '</span>' + badge + '</div>';
        });
        box.innerHTML = html;
        Array.prototype.forEach.call(box.querySelectorAll('.device-item'), function (it) {
            it.addEventListener('click', function () {
                var id = it.getAttribute('data-id');
                if ($('osrSerialDevice')) $('osrSerialDevice').value = id;
                Array.prototype.forEach.call(box.querySelectorAll('.device-item'), function (x) { x.classList.remove('active'); });
                it.classList.add('active');
                saveSettings(true);
                showResult('已选择 USB 设备：' + id);
            });
        });
    }

    function loadUsbDevices() {
        get('/api/osr/usb-devices').then(function (r) {
            lastUsbScan = r || null;
            usbDevices = (r && r.devices && Array.isArray(r.devices)) ? r.devices : [];
            renderUsbList();
        });
    }

    /* 检测 USB 设备：请求系统权限并刷新列表（点击即申请权限）。
       权限弹窗由系统异步弹出，用户点允许后 hasPermission 才会变 true，
       因此扫描后延时再拉取一次以反映最新授权状态。 */
    function scanUsbDevices() {
        showResult('正在检测 USB 设备并申请权限…');
        post('/api/osr/usb-scan', {}).then(function (r) {
            lastUsbScan = r || null;
            usbDevices = (r && r.devices && Array.isArray(r.devices)) ? r.devices : [];
            renderUsbList();
            if (!usbDevices.length) {
                // 空列表归因：手机不支持主机模式 / 系统层就没枚举到设备 / 枚举出错
                var why;
                if (r && r.usbHost === false) {
                    why = '此手机不支持 USB 主机（OTG）模式，无法 USB 直连串口，请改用 WiFi 或蓝牙方式连接设备。';
                } else if (r && r.error) {
                    why = 'USB 枚举出错：' + r.error;
                } else if (r && r.rawCount === 0) {
                    why = '手机在系统层没有枚举到任何 USB 设备（不是应用过滤掉了），请依次检查：' +
                        '① 换一根确认能传数据的 USB 线——纯充电线没有数据芯线，插上系统不会有任何反应；' +
                        '② 部分机型需要在系统设置中打开「OTG」开关，可点击下方「去系统设置检查 OTG」按钮；' +
                        '③ 拿一个 U 盘插手机，若文件管理里也认不出，说明手机 OTG/主机模式有问题；' +
                        '④ 确认设备已开机，且它的 USB 口是「串口/从机」模式——若该口只供电或只作主机用，手机侧永远枚举不到。';
                } else {
                    why = '未检测到可用的 USB 串口设备。';
                }
                showResult('未检测到 USB 设备。' + why, true);
            } else {
                showResult('检测到 ' + usbDevices.length + ' 个 USB 设备，请在系统弹窗中允许权限');
                // 权限授予是异步的，延时刷新以反映最新授权状态
                setTimeout(loadUsbDevices, 1500);
                setTimeout(loadUsbDevices, 4000);
            }
        }).catch(function () {
            showResult('USB 检测失败', true);
        });
    }

    /* =======================================================================
     *  蓝牙：全屏设备页（扫描 → 选设备 → 连接）
     * ===================================================================== */

    function btKey(d) { return (d.kind || 'ble') + ':' + d.address; }

    function rssiBarsHtml(rssi) {
        var lvl = Math.max(0, Math.min(5, Math.round((rssi + 100) / 14)));
        var h = '';
        for (var i = 1; i <= 5; i++) h += '<span class="rssi-bar' + (i <= lvl ? ' on' : '') + '"></span>';
        return '<span class="rssi-bars">' + h + '</span>';
    }

    function btDevItemHtml(d) {
        var connected = (btConnectedAddr === d.address && (btConnectedKind || 'ble') === (d.kind || 'ble'));
        var connecting = (btConnectingAddr === d.address && (btConnectingKind || 'ble') === (d.kind || 'ble'));
        var cls = 'bt-dev-item';
        if (connected) cls += ' connected';
        if (connecting) cls += ' connecting';
        if (d.paired) cls += ' paired';

        var name = d.name ? escapeHtml(d.name) : 'Unknown';
        var sub = d.kind === 'classic' ? '经典蓝牙' : 'BLE';

        var right;
        if (connecting) right = '<span class="bt-dev-state">连接中…</span>';
        else if (connected) right = '<span class="bt-dev-state ok">已连接</span>';
        else {
            right = '<span class="bt-dev-right">';
            if (typeof d.rssi === 'number') right += rssiBarsHtml(d.rssi);
            if (d.kind === 'classic') right += '<span class="bt-tag">Classic</span>';
            else if (typeof d.rssi === 'number') right += '<span class="bt-rssi">' + d.rssi + '</span>';
            right += '</span>';
        }

        return '<div class="' + cls + '" data-addr="' + escapeHtml(d.address) + '"' +
            ' data-kind="' + escapeHtml(d.kind || 'ble') + '"' +
            ' data-name="' + escapeHtml(d.name || '') + '">' +
            '<span class="bt-dev-ico">' + BT_ICON + '</span>' +
            '<span class="bt-dev-main"><span class="bt-dev-name">' + name + '</span>' +
            '<span class="bt-dev-sub">' + sub + (d.paired ? ' · 已配对' : '') + '</span></span>' +
            right + '</div>';
    }

    function renderBtDevList() {
        var box = $('btDevList');
        if (!box) return;
        var all = Object.keys(btDevMap).map(function (k) { return btDevMap[k]; });
        if (!all.length) {
            box.innerHTML = '<div class="device-empty">' +
                (btScanning ? '正在扫描附近的蓝牙设备…' : '未发现蓝牙设备，点右上角重新扫描。') + '</div>';
            return;
        }
        all.sort(function (a, b) {
            var an = a.name ? 0 : 1, bn = b.name ? 0 : 1;
            if (an !== bn) return an - bn;                       // 有名字的排前面
            var ar = (typeof a.rssi === 'number') ? a.rssi : -999;
            var br = (typeof b.rssi === 'number') ? b.rssi : -999;
            return br - ar;                                      // 信号强的排前面
        });
        var html = '';
        all.forEach(function (d) { html += btDevItemHtml(d); });
        box.innerHTML = html;
        Array.prototype.forEach.call(box.querySelectorAll('.bt-dev-item'), function (it) {
            it.addEventListener('click', function () {
                if (it.classList.contains('connecting')) return;
                connectBtDevice(it.getAttribute('data-addr'), it.getAttribute('data-kind'), it.getAttribute('data-name'));
            });
        });
    }

    function setBtDevStatus(text) {
        if ($('btDevStatus')) $('btDevStatus').textContent = text || '';
    }

    /** 统一显隐「授权蓝牙权限 / 去系统设置」两个按钮。 */
    function setBtPermHint(show) {
        var d = show ? '' : 'none';
        if ($('btDevPerm')) $('btDevPerm').style.display = d;
        if ($('btDevAppSettings')) $('btDevAppSettings').style.display = d;
    }

    /** app.js 暴露的最小导航 API（app.js 在 IIFE 内，需经 window.OrbitNav 调用）。 */
    function navApi() { return window.OrbitNav || {}; }

    /** 当前是否停留在全屏「蓝牙设备」页。 */
    function isBtDevicesOpen() {
        var pane = $('pane-btdevices');
        return !!(pane && pane.classList.contains('active'));
    }

    /** 进入全屏蓝牙设备页并开始扫描。 */
    function openBtDevices() {
        btDevMap = {};
        btConnectingAddr = null;
        btConnectingKind = null;
        renderBtDevList();
        var nav = navApi();
        if (typeof nav.pushCurrentView === 'function') { try { nav.pushCurrentView(); } catch (e) { } }
        if (typeof nav.activateTab === 'function') nav.activateTab('btdevices');
        startBtScan();
    }

    /** 退出全屏设备页，回到设置。 */
    function closeBtDevices() {
        stopBtScan();
        var nav = navApi();
        if (typeof nav.navigateBack === 'function') nav.navigateBack();
        else if (typeof nav.activateTab === 'function') nav.activateTab('settings');
        updateBtPickedCard();
    }

    function startBtScan() {
        btDevMap = {};
        if (!window.Orbit || typeof window.Orbit.startBluetoothScan !== 'function') {
            btScanning = false;
            setBtDevStatus('当前环境不支持蓝牙扫描（请在 App 内使用）');
            renderBtDevList();
            return;
        }
        // 权限前置检查：Android 12+ 缺 BLUETOOTH_SCAN/CONNECT 时，
        // 原生连「读蓝牙开关」都会抛异常，所以必须先拿到权限再谈扫描。
        var hasPerm = true;
        if (typeof window.Orbit.hasBluetoothPermission === 'function') {
            try { hasPerm = !!window.Orbit.hasBluetoothPermission(); } catch (e) { hasPerm = true; }
        }
        if (!hasPerm) {
            btScanning = false;
            setBtPermHint(true);
            setBtDevStatus('需要蓝牙权限，正在申请…请在系统弹窗中点「允许」。');
            renderBtDevList();
            if (typeof window.Orbit.requestBluetoothPermission === 'function') {
                try { window.Orbit.requestBluetoothPermission(); } catch (e) {
                    setBtDevStatus('申请蓝牙权限失败：' + e.message);
                }
            }
            return;
        }
        btScanning = true;
        setBtPermHint(false);
        renderBtDevList();
        setBtDevStatus('正在扫描附近的蓝牙设备…');
        try {
            if (typeof window.Orbit.stopBluetoothScan === 'function') window.Orbit.stopBluetoothScan();
            window.Orbit.startBluetoothScan();
        } catch (e) {
            btScanning = false;
            setBtDevStatus('启动扫描失败：' + e.message);
            renderBtDevList();
        }
    }

    function stopBtScan() {
        btScanning = false;
        if (window.Orbit && typeof window.Orbit.stopBluetoothScan === 'function') {
            try { window.Orbit.stopBluetoothScan(); } catch (e) { }
        }
    }

    function connectBtDevice(address, kind, name) {
        if (!address) return;
        if (!window.Orbit || typeof window.Orbit.connectBluetooth !== 'function') {
            setBtDevStatus('当前环境不支持蓝牙连接（请在 App 内使用）');
            return;
        }
        // 没有权限时原生连接必然抛 SecurityException，这里先补授权
        var hasPerm = true;
        if (typeof window.Orbit.hasBluetoothPermission === 'function') {
            try { hasPerm = !!window.Orbit.hasBluetoothPermission(); } catch (e) { hasPerm = true; }
        }
        if (!hasPerm) {
            setBtPermHint(true);
            setBtDevStatus('需要蓝牙权限，正在申请…请在系统弹窗中点「允许」。');
            if (typeof window.Orbit.requestBluetoothPermission === 'function') {
                try { window.Orbit.requestBluetoothPermission(); } catch (e) { }
            }
            return;
        }
        btConnectingAddr = address;
        btConnectingKind = kind || 'ble';
        renderBtDevList();
        setBtDevStatus('正在连接 ' + (name || address) + ' …');
        // 必须先停扫描：经典发现/BLE 扫描进行中会干扰 RFCOMM 建连与后续收发，
        // 这是「显示已连接却发不出指令」的常见诱因。
        try { stopBtScan(); } catch (e) { }
        try {
            window.Orbit.connectBluetooth(address, btConnectingKind, name || '');
        } catch (e) {
            btConnectingAddr = null; btConnectingKind = null;
            renderBtDevList();
            setBtDevStatus('发起连接失败：' + e.message);
        }
    }

    /** 设置页里「已选设备」卡片刷新。 */
    function updateBtPickedCard() {
        var dev = $('btPickedDev'), empty = $('btPickedEmpty');
        var isConnected = !!btConnectedAddr;
        if (btSelected) {
            if (empty) empty.style.display = 'none';
            if (dev) dev.style.display = '';
            if ($('btPickedName')) $('btPickedName').textContent = btName || btSelected;
            if ($('btPickedMeta')) {
                $('btPickedMeta').textContent = (btKind === 'classic' ? '经典蓝牙 SPP' : 'BLE 串口') +
                    ' · ' + btSelected + (isConnected ? ' · 已连接' : '');
            }
            if ($('btDisconnect')) $('btDisconnect').style.display = isConnected ? '' : 'none';
        } else {
            if (empty) empty.style.display = '';
            if (dev) dev.style.display = 'none';
            if ($('btDisconnect')) $('btDisconnect').style.display = 'none';
        }
    }

    function refreshBtStatus() {
        get('/api/osr/bt-status').then(function (r) {
            if (!r || r.error) return;
            if (r.connected) { btConnectedAddr = r.address; btConnectedKind = r.kind || 'ble'; }
            else { btConnectedAddr = null; btConnectedKind = null; }
            updateBtPickedCard();
            if ($('btDevList')) renderBtDevList();
        });
    }

    function saveSettings(silent) {
        return post('/api/osr/settings', collectForm()).then(function (r) {
            if (r && !r.error) {
                settings = r;
                if (!silent) showHint($('osrHint'), '已保存');
            } else if (!silent) {
                showResult('保存失败：' + apiReason(r), true);
            }
            return r;
        });
    }

    /* ---------- 动作 ---------- */
    /**
     * 上一次报错的去重键：拖动滑块时同一个故障会被反复上报，
     * 每条都弹一次提示会刷屏，所以同一原因只提示一次。
     */
    var lastAxisErrKey = '';

    function sendAxis(axis, pos, durationMs) {
        return post('/api/osr/send', {
            axis: axis,
            pos: pos,
            durationMs: durationMs || 600
        }).then(function (r) {
            if (r && r.ok === false) {
                var key = axis + ':' + (r.error || '') + ':' + (r.detail || '');
                // 网络类错误（请求根本没到后端）与真实驱动失败区分对待：
                // 前者在拖动结束前可能被反复触发，静默即可。
                if (r.error === 'network') return false;
                if (key !== lastAxisErrKey) {
                    lastAxisErrKey = key;
                    showResult(axis + ' → ' + apiReason(r), true);
                }
                return false;
            }
            return true;
        });
    }

    /* ---------- 拖动发送节流 ----------
       手动模式滑块此前只在 change（松手）时发送，拖动全程不动、松手才跳一下。
       这里补上「拖动中即时下发」，并沿用触板的串行泵：同一时刻只有一发在飞，
       落地后才补发积压的最新值。原因是后端 nanohttpd 单线程、USB 串口写入本身也慢，
       任由 input 事件每个都发会把请求排队压死，反而更卡。 */
    var dragState = { sending: false, need: false, axis: null, pos: 0 };

    function dragSend(axis, pos, durationMs) {
        dragState.axis = axis;
        dragState.pos = pos;
        dragState.need = true;
        if (dragState.sending) return;   // 在飞的那发结束后会自动补发（取最新值）
        pumpDrag(durationMs || 120);
    }

    function pumpDrag(durationMs) {
        if (!dragState.need || !dragState.axis) return;
        var axis = dragState.axis;
        var pos = dragState.pos;
        dragState.need = false;
        dragState.sending = true;
        sendAxis(axis, pos, durationMs).catch(function () { }).then(function () {
            dragState.sending = false;
            if (dragState.need) pumpDrag(durationMs);
        });
    }

    function modePayload(action) {
        return {
            mode: 'freeplay', action: action,
            speed: parseFloat($('osrSimSpeed').value),
            intensity: (parseInt($('osrSimIntensity').value, 10)) / 100,
            duration: parseFloat($('osrSimDuration').value),
            autoSwitch: $('osrSimAutoSwitch').checked,
            selectedIndex: parseInt($('osrSimPattern').value, 10)
        };
    }

    function startMode() {
        if (playing) {
            post('/api/osr/playmode', modePayload('update'));
            showResult('已更新运行参数');
            return;
        }
        // 蓝牙方式下先确认设备已连接，否则点了不会有任何反应
        if (currentMethod === 'bt' && !btConnectedAddr) {
            showResult('蓝牙设备尚未连接，请先点「蓝牙」选择设备并连接', true);
            return;
        }
        // 硬件输出已固定开启（页面不再提供开关），开始前确保设置已下发
        saveSettings(true).then(function (r) {
            if (!r || r.error) { showResult('设置保存失败，已取消启动：' + apiReason(r), true); return; }
            post('/api/osr/playmode', modePayload('start')).then(function (res) {
                if (res && res.ok === false) {
                    showResult('启动失败：' + apiReason(res), true);
                    return;
                }
                playing = true;
                lastShownSendError = null;
                showResult('已开始 · ' + modeLabel(activeMode));
                setTimeout(refreshStatus, 500);
            });
        });
    }

    function stopMode() {
        post('/api/osr/playmode', { mode: 'stop' }).then(function () {
            playing = false;
            showResult('已停止');
            refreshStatus();
        });
    }

    function modeLabel(m) {
        return '自由演奏';
    }

    /* ---------- 状态轮询 ---------- */
    function refreshStatus() {
        return get('/api/osr/status').then(function (s) {
            if (!s || s.error) return;
            lastStatus = s;
            var lp = s.livePositions || {};
            AXIS_ORDER.forEach(function (a) {
                var v = typeof lp[a] === 'number' ? lp[a] : CENTER;
                var pct = Math.max(0, Math.min(100, v / AXIS_VALUE_MAX * 100));
                var fill = $('osrVizFill' + a);
                var val = $('osrVizVal' + a);
                if (fill) { fill.style.left = '0%'; fill.style.width = pct.toFixed(1) + '%'; }
                if (val) val.textContent = v;
            });
            var st = $('osrMotionState');
            if (st) {
                var mm = s.motionMode || 'idle';
                // 链路判定统一用后端 linkState（前端不再自行推断；disabled / disconnected 明确提示，
                // connected 与 UDP 的 idle 都算「能发」，此时的运行态由运动模式决定 ——
                // UDP 是无连接协议，静止时没有连接可言，把它显示成「未连接」同样是谎报）。
                var ls = s.linkState || '';
                if (ls === 'disabled') {
                    st.textContent = '未启用硬件输出';
                } else if (ls === 'disconnected') {
                    st.textContent = (s.connectionType === 'BluetoothSerial') ? '蓝牙未连接' : '设备未连接';
                } else {
                    st.textContent = mm === 'idle' ? (s.syncEnabled ? '同步中' : '空闲')
                        : '自由演奏';
                }
            }
            var pn = $('osrPatternName');
            if (pn) pn.textContent = s.currentPattern || modeLabel(s.motionMode);
            var hs = $('osrHasScript');
            if (hs) hs.textContent = s.hasScript ? '是' : '否';
            var dur = $('osrScriptDuration');
            if (dur) dur.textContent = s.hasScript ? (Math.round(s.scriptDurationSec || 0) + ' 秒') : '--';
            // 指令没送达时把真实原因显示出来（自动模式运行中同样可见），避免「点了没反应」
            var sendErr = s.lastSendError || '';
            if (sendErr) {
                if (sendErr !== lastShownSendError) {
                    lastShownSendError = sendErr;
                    showResult('指令未送达：' + sendErr, true);
                }
            } else {
                lastShownSendError = null;
            }
            playing = (s.motionMode && s.motionMode !== 'idle');
            // 脚本播放态以后端为准：clockPlaying=true 说明播放时钟在走（play 已生效）
            var cp = !!s.clockPlaying;
            if (cp !== scriptPlaying) { scriptPlaying = cp; paintScriptToggle(); }
        });
    }

    /* 开始/暂停合一按钮的外观：默认 ▶ 开始，播放中 ⏸ 暂停（样式见 osr.css 的 .is-playing）。 */
    function paintScriptToggle() {
        var b = $('osrScriptToggle');
        if (!b) return;
        b.classList.toggle('is-playing', !!scriptPlaying);
        b.setAttribute('data-role', scriptPlaying ? 'pause' : 'play');
        b.title = scriptPlaying ? '暂停' : '开始';
        b.setAttribute('aria-label', scriptPlaying ? '暂停' : '开始');
    }

    function shouldPoll() {
        // 设备页显示实时轴位置，测试机器页显示运行状态，脚本播放页要同步开始/暂停按钮态
        var ids = ['panel-osr', 'panel-manual', 'panel-auto', 'panel-script'];
        return ids.some(function (id) {
            var p = $(id);
            return !!(p && p.classList.contains('active'));
        });
    }

    function startPolling() {
        if (pollTimer) return;
        pollTimer = setInterval(function () {
            if (shouldPoll()) refreshStatus();
        }, 700);
    }

    /* ---------- 事件绑定 ---------- */
    function bindRange(id, valId, fmt) {
        var el = $(id), v = $(valId);
        if (!el || !v) return;
        var render = function () { v.textContent = fmt(el.value); };
        render();
        el.addEventListener('input', render);
        el.addEventListener('change', function () {
            render();
            if (playing) post('/api/osr/playmode', modePayload('update'));
        });
    }

    function init() {
        // 面板已按「脚本播放 / OSR 设备 / 测试机器」拆开，任一存在即可初始化
        if (!$('panel-script') && !$('panel-osr') && !$('panel-manual') && !$('panel-auto')) return;

        buildViz();
        buildManual();


        // 速度单位改为「次/分」，动作时长改为整数秒（见 index.html 自动模式面板）
        bindRange('osrSimSpeed', 'osrSimSpeedVal', function (v) { return v + ' 次/分'; });
        bindRange('osrSimIntensity', 'osrSimIntensityVal', function (v) { return v + '%'; });
        bindRange('osrSimDuration', 'osrSimDurationVal', function (v) { return Math.round(parseFloat(v) || 0) + ' 秒'; });
        // 「自动切换动作」不勾选时锁定当前动作，「动作时长」不再生效 -> 置灰，
        // 否则用户拖了半天没变化，会误以为参数没生效。
        var durEl = $('osrSimDuration'), swEl = $('osrSimAutoSwitch');
        function syncDurEnabled() { if (durEl) durEl.disabled = !(swEl && swEl.checked); }
        if (swEl) swEl.addEventListener('change', function () {
            syncDurEnabled();
            if (playing) post('/api/osr/playmode', modePayload('update'));
        });
        syncDurEnabled();
        // 还原默认：三个参数 + 动作类型 + 自动切换一起拨回默认值；运行中立刻生效。
        // 默认值与 index.html 的 value 保持一致（60 次/分 / 80% / 8 秒 / 随机全场）。
        if ($('osrSimReset')) $('osrSimReset').addEventListener('click', function () {
            var defs = [['osrSimSpeed', 60], ['osrSimIntensity', 80], ['osrSimDuration', 8]];
            defs.forEach(function (d) {
                var el = $(d[0]);
                if (!el) return;
                el.value = d[1];
                el.dispatchEvent(new Event('input'));
            });
            var pt = $('osrSimPattern');
            // 7 = 「随机全场」（v2.7.23 起动作库只剩 7 个，波浪/环绕/螺旋已下线，别再写死 10）
            if (pt) { pt.value = 7; pt.dispatchEvent(new Event('change')); }
            if (swEl && !swEl.checked) { swEl.checked = true; swEl.dispatchEvent(new Event('change')); }
            syncDurEnabled();
            if (playing) post('/api/osr/playmode', modePayload('update'));
            showResult('已还原默认：60 次/分 · 80% · 8 秒 · 随机全场');
        });

        // 连接方式：先选方式（蓝牙 / WiFi / USB）。选「蓝牙」→ 跳转全屏设备页
        var methodCards = document.querySelectorAll('#connMethods .conn-method');
        Array.prototype.forEach.call(methodCards, function (c) {
            c.addEventListener('click', function () {
                var m = c.getAttribute('data-method');
                applyMethod(m);
                saveSettings(true);
                if (m === 'bt') openBtDevices();
            });
        });


        // 设置页：蓝牙已选设备卡片
        if ($('btReselect')) $('btReselect').addEventListener('click', function () {
            applyMethod('bt');
            saveSettings(true);
            openBtDevices();
        });
        if ($('btDisconnect')) $('btDisconnect').addEventListener('click', function () {
            if (window.Orbit && typeof window.Orbit.disconnectBluetooth === 'function') {
                try { window.Orbit.disconnectBluetooth(); } catch (e) { }
            }
            btConnectedAddr = null; btConnectedKind = null;
            updateBtPickedCard();
            showResult('已断开蓝牙');
        });

        // 全屏设备页
        if ($('btDevBack')) $('btDevBack').addEventListener('click', closeBtDevices);
        if ($('btDevScan')) $('btDevScan').addEventListener('click', startBtScan);
        if ($('btDevEnable')) $('btDevEnable').addEventListener('click', function () {
            if (window.Orbit && typeof window.Orbit.openBluetoothSettings === 'function') {
                window.Orbit.openBluetoothSettings();
            }
        });
        if ($('btDevPerm')) $('btDevPerm').addEventListener('click', function () {
            if (window.Orbit && typeof window.Orbit.requestBluetoothPermission === 'function') {
                window.Orbit.requestBluetoothPermission();
            } else {
                showResult('当前环境不支持蓝牙授权', true);
            }
        });
        if ($('btDevAppSettings')) $('btDevAppSettings').addEventListener('click', function () {
            if (window.Orbit && typeof window.Orbit.openAppSettings === 'function') {
                window.Orbit.openAppSettings();
            } else {
                showResult('请到系统设置 → 应用 → Orbit → 权限 中开启蓝牙权限', true);
            }
        });

        if ($('usbScan')) $('usbScan').addEventListener('click', scanUsbDevices);

        // ---- 原生蓝牙回调（MainActivity / BtLink → evaluateJavascript）----
        window.__onBluetoothPermission = function (granted) {
            if (granted) {
                setBtPermHint(false);
                showResult('蓝牙权限已授予，正在扫描…');
                if (isBtDevicesOpen()) startBtScan();
            } else {
                btScanning = false;
                setBtPermHint(true);
                setBtDevStatus('蓝牙权限被拒绝。请点「授权蓝牙权限」重新申请，或到系统设置里手动开启。');
                renderBtDevList();
                showResult('蓝牙权限被拒绝', true);
            }
        };
        // 原生发现权限缺失、已拉起系统授权弹窗
        window.__onBtNeedPermission = function () {
            btScanning = false;
            setBtPermHint(true);
            setBtDevStatus('需要蓝牙权限，已弹出授权请求，请点「允许」后自动开始扫描。');
            renderBtDevList();
        };
        window.__onBtScanStart = function () {
            btScanning = true;
            setBtDevStatus('正在扫描附近的蓝牙设备…');
            renderBtDevList();
        };
        window.__onBtDeviceFound = function (dev) {
            if (typeof dev === 'string') {
                // 兼容早期「字符串载荷」的原生桥
                try { dev = JSON.parse(dev); } catch (e) { return; }
            }
            if (!dev || !dev.address) return;
            var key = btKey(dev);
            var old = btDevMap[key];
            if (!old) {
                btDevMap[key] = { name: dev.name || '', address: dev.address, rssi: (typeof dev.rssi === 'number' ? dev.rssi : null), kind: dev.kind || 'ble', paired: !!dev.paired };
            } else {
                if (dev.name) old.name = dev.name;
                if (typeof dev.rssi === 'number') old.rssi = dev.rssi;
                old.paired = old.paired || !!dev.paired;
            }
            renderBtDevList();
        };
        window.__onBtScanFinished = function () {
            btScanning = false;
            var n = Object.keys(btDevMap).length;
            setBtDevStatus(n ? ('扫描完成，共发现 ' + n + ' 台设备') : '扫描完成，附近未发现蓝牙设备');
            renderBtDevList();
        };
        window.__onBtScanError = function (msg) {
            btScanning = false;
            renderBtDevList();
            var m = String(msg == null ? '' : msg);
            var lower = m.toLowerCase();
            if (m === 'bluetooth_off') {
                if ($('btDevEnable')) $('btDevEnable').style.display = '';
                setBtDevStatus('蓝牙开关未开启，请先开启蓝牙。');
            } else if (m === 'permission_denied' || lower.indexOf('permission') >= 0 ||
                       lower.indexOf('securityexception') >= 0) {
                setBtPermHint(true);
                if (m === 'permission_denied') {
                    setBtDevStatus('蓝牙权限被拒绝，请点「授权蓝牙权限」允许后重试。');
                } else {
                    setBtDevStatus('蓝牙权限缺失：' + m + '（请点「授权蓝牙权限」）');
                }
            } else if (lower.indexOf('scan_failed') >= 0) {
                setBtDevStatus('扫描失败：' + m + '（可能缺少权限，请点「授权蓝牙权限」）');
                setBtPermHint(true);
            } else {
                setBtDevStatus('蓝牙扫描失败：' + m);
            }
        };
        window.__onBtConnecting = function (addr, kind, name) {
            btConnectingAddr = addr; btConnectingKind = kind || 'ble';
            renderBtDevList();
            setBtDevStatus('正在连接 ' + (name || addr) + ' …');
        };
        window.__onBtConnected = function (addr, kind, name) {
            btAutoConnecting = false;
            btConnectingAddr = null; btConnectingKind = null;
            btConnectedAddr = addr; btConnectedKind = kind || 'ble';
            btSelected = addr;
            btKind = kind || 'ble';
            btName = name || '';
            renderBtDevList();
            updateBtPickedCard();
            // 硬件输出已固定开启（页面不再提供开关），连接成功后直接可下发指令。
            lastShownSendError = null;
            // 连接成功能提示：开机蓝牙自动重连、手动点连接都会走这里，
            // 用户此时可能停在任意页面，所以不用面板里的 showResult，直接全局轻提示。
            try {
                if (typeof libToast === 'function')
                    libToast('设备已连接' + (name ? '（' + name + '）' : ''));
            } catch (e) { }
            saveSettings(true).then(function () {
                refreshStatus();
                showResult('已连接 ' + (name || addr));
            });
            setTimeout(function () { closeBtDevices(); }, 600);
        };
        window.__onBtDisconnected = function () {
            btConnectedAddr = null; btConnectedKind = null;
            btConnectingAddr = null; btConnectingKind = null;
            renderBtDevList();
            updateBtPickedCard();
        };
        window.__onBtError = function (msg) {
            btConnectingAddr = null; btConnectingKind = null;
            renderBtDevList();
            // 开机自动重连失败（蓝牙没开 / 设备不在身边）不提示：用户没主动发起，弹错是打扰
            if (btAutoConnecting) { btAutoConnecting = false; return; }
            setBtDevStatus('连接失败：' + msg);
            showResult('蓝牙连接失败：' + msg, true);
        };
        window.__onBtData = function () { /* 设备回包，暂不处理 */ };

        // 原生收到 USB 设备接入广播后回调：刷新列表让用户能看到新设备
        window.__onUsbAttached = function () {
            showResult('检测到 USB 设备插入，刷新列表…');
            loadUsbDevices();
            setTimeout(loadUsbDevices, 1500);
        };

        if ($('osrSaveSettings')) $('osrSaveSettings').addEventListener('click', function () { saveSettings(); });

        if ($('osrOpenConfig')) $('osrOpenConfig').addEventListener('click', function () {
            openDeviceConfig();
        });
        // 自动页「网页操作」：App 内 WebView 打开 Ayva Stroker Lite
        if ($('osrOpenWebApp')) $('osrOpenWebApp').addEventListener('click', function () {
            openWebApp();
        });
        if ($('osrConnTest')) $('osrConnTest').addEventListener('click', function () {
            saveSettings(true).then(function () {
                post('/api/osr/connect-test', {}).then(function (r) {
                    // 成功后后端还会补发一段多方位可见动作，提示里要说清楚「设备会动一下」，
                    // 否则用户仍会怀疑「点了没反应 = 没连上」。
                    var ok = r && r.ok;
                    var reason = ok ? '' : apiReason(r);
                    var msg;
                    if (ok) {
                        msg = '连接成功：指令已送达，设备应出现明显动作';
                    } else if ((reason || '').indexOf('未选择串口设备') >= 0 ||
                               ($('osrSerialDevice') && !$('osrSerialDevice').value.trim())) {
                        msg = '连接失败：请先点击上方 USB 设备列表中的设备项选中它，再点连接测试';
                    } else {
                        msg = '连接失败：' + reason;
                    }
                    showResult(msg, !ok);
                });
            });
        });


        if ($('osrCenterAll')) $('osrCenterAll').addEventListener('click', function () {
            AXIS_ORDER.forEach(function (a) {
                var sl = $('osrMan' + a);
                if (sl) sl.value = CENTER;
                var v = $('osrManVal' + a);
                if (v) v.textContent = CENTER;
                sendAxis(a, CENTER);
            });
            showResult('已发送全部回中位');
        });

        // 运行中改动「冲程类型 / 动作类型 / 自动切换动作」要立即下发。
        // 后端各模式的运动循环每轮都会重读这些参数（OsrManager.runRandomLoop /
        // runSimulationLoop），所以 update 即刻生效；不补这个监听就只能
        // 「停止 → 开始」才会带上新选择。
        function pushLiveUpdate() {
            if (playing) post('/api/osr/playmode', modePayload('update'));
        }
        // 「自动切换动作」只对「随机全场」有意义。勾着它的时候，间隔一到就把当前动作换掉，
        // 动作类型变化即时上报后端（自动切换复选框已隐藏并默认勾选）。
        ['osrSimPattern'].forEach(function (id) {
            if (!$(id)) return;
            $(id).addEventListener('change', pushLiveUpdate);
        });

        // 模式切换（沿用原版 .sub-tabs/.sub-tab 与 .axis-detail 分页）
        var tabs = document.querySelectorAll('#osrModeTabs .sub-tab');
        Array.prototype.forEach.call(tabs, function (t) {
            t.addEventListener('click', function () {
                var changed = (t.dataset.mode !== activeMode);
                Array.prototype.forEach.call(tabs, function (x) { x.classList.remove('active'); });
                t.classList.add('active');
                activeMode = t.dataset.mode;
                Array.prototype.forEach.call(document.querySelectorAll('#panel-auto .axis-detail'), function (p) {
                    p.classList.remove('active');
                });
                var pane = $('osrMode-' + activeMode);
                if (pane) pane.classList.add('active');
                // 运行中换模式（随机冲程 ↔ 正弦波 ↔ 自由演奏）要立即生效。
                // 三种模式在后端是各自独立的协程，'update' 只改同模式参数，
                // 所以这里自动「停 → 按新模式起」，不必手动停止再开始。
                if (changed && playing) {
                    post('/api/osr/playmode', { mode: 'stop' }).then(function () {
                        playing = false;
                        startMode();
                    });
                }
            });
        });

        if ($('osrPlay')) $('osrPlay').addEventListener('click', startMode);
        if ($('osrStop')) $('osrStop').addEventListener('click', stopMode);

        // 脚本播放：选文件夹（SAF）→ 加载并合并目录下所有 .funscript 一起运行
        if ($('osrPickScriptFolder')) $('osrPickScriptFolder').addEventListener('click', function () {
            window.__folderPickMode = 'script';
            if (window.Orbit && typeof window.Orbit.pickFolder === 'function') window.Orbit.pickFolder();
            else showResult('当前环境不支持文件夹选择', true);
        });
        function loadScriptFolder(uri) {
            post('/api/osr/funscripts', { folder: uri }).then(function (r) {
                if (!r) { showResult('加载失败', true); return; }
                if (r.ok) {
                    renderScriptList(r.names || []);
                    showHint($('osrScriptHint'), '已加载 ' + (r.count || 0) + ' 个');
                    showResult('已加载 ' + (r.count || 0) + ' 个脚本');
                    refreshStatus();
                } else if (r.error === 'no_funscript') {
                    renderScriptList([]);
                    showResult('该文件夹没有 .funscript 文件', true);
                } else {
                    showResult('加载失败：' + (r.error || '未知'), true);
                }
            }).catch(function () { showResult('加载失败', true); });
        }
        function renderScriptList(names) {
            var box = $('osrScriptList');
            if (!box) return;
            box.innerHTML = '';
            (names || []).forEach(function (n) {
                var chip = document.createElement('span');
                chip.className = 'script-chip';
                chip.textContent = n;
                box.appendChild(chip);
            });
        }
        window.loadScriptFolder = loadScriptFolder;

        /* 开始 / 暂停 合一（2026-09-19 按需求）：同一个按钮按当前播放态决定发 play 还是 pause。
           按钮外观由 paintScriptToggle() 统一刷新，状态以 refreshStatus() 读到的
           status.clockPlaying 为准（后端 play 会同时置同步与播放时钟）。 */
        function scriptAction(action) {
            return post('/api/osr/script', { action: action }).then(function (r) {
                if (!r || !r.ok) { showResult('操作失败', true); return; }
                var map = { play: '脚本运行中', pause: '脚本已暂停', stop: '空闲' };
                var st = $('osrMotionState');
                if (st) st.textContent = map[action] || '空闲';
                showResult(action === 'play' ? '开始播放脚本' : (action === 'pause' ? '已暂停' : '已停止'));
                refreshStatus();
            }).catch(function () { showResult('操作失败', true); });
        }
        if ($('osrScriptToggle')) $('osrScriptToggle').addEventListener('click', function () {
            scriptPlaying = !scriptPlaying;   // 乐观切换：先给出反馈，随后由 refreshStatus 以后端为准纠正
            paintScriptToggle();
            scriptAction(scriptPlaying ? 'play' : 'pause').then(function () { refreshStatus(); });
        });
        if ($('osrScriptStop')) $('osrScriptStop').addEventListener('click', function () {
            scriptPlaying = false;
            paintScriptToggle();
            scriptAction('stop');
        });
        paintScriptToggle();

        /* 反转：把六个轴的 reversed 置成同一状态（方向取反）。
           走 /api/osr/axes —— 轴参数专用入口，与「OSR 轴设置」共用同一份 axisParams，
           不会把连接方式 / IP / 端口等其余设置冲掉。 */
        var osrReverseOn = false;
        function paintReverseBtn() {
            var b = $('osrScriptReverse');
            if (!b) return;
            if (osrReverseOn) b.classList.add('is-on'); else b.classList.remove('is-on');
            b.setAttribute('aria-pressed', osrReverseOn ? 'true' : 'false');
            b.title = osrReverseOn ? '反转方向：已开启' : '反转方向';
        }
        function refreshReverseState() {
            return get('/api/osr/axes').then(function (r) {
                var ap = (r && r.axisParams) || {};
                var all = true;
                AXIS_ORDER.forEach(function (a) {
                    var c = ap[a];
                    if (!c || !c.reversed) all = false;
                });
                osrReverseOn = all;
                paintReverseBtn();
            }).catch(function () { });
        }
        function setReverse(on) {
            var axes = {};
            AXIS_ORDER.forEach(function (a) { axes[a] = { reversed: on }; });
            post('/api/osr/axes', { axes: axes }).then(function (r) {
                if (!r) { showResult('反转设置失败', true); return; }
                osrReverseOn = on;
                paintReverseBtn();
                showResult(on ? '已开启反转：各轴方向取反' : '已关闭反转：恢复原方向');
                refreshStatus();
            }).catch(function () { showResult('反转设置失败', true); });
        }
        if ($('osrScriptReverse')) $('osrScriptReverse').addEventListener('click', function () {
            setReverse(!osrReverseOn);
        });
        paintReverseBtn();
        refreshReverseState();

        /* 设备复位：停止所有运动，并让六个轴回到行程中点（5000）。
           脚本跑飞、位置残留、换片时的一键归位。
           后端 ok=true 表示本地已复位（停运动 / 清游标 / 轴位置归中一定成功），
           delivered=false 只说明「归中指令没送达设备」（未连接 / 未启用硬件输出），
           这时如实说明即可，不能整体报成「复位失败」误导用户。 */
        if ($('osrDeviceReset')) $('osrDeviceReset').addEventListener('click', function () {
            post('/api/osr/reset', {}).then(function (r) {
                if (r && r.ok) {
                    var st = $('osrMotionState');
                    if (st) st.textContent = '空闲';
                    if (r.delivered === false) {
                        // 本地已复位，只是指令没送出去 —— 带上后端给的真实原因（未启用硬件输出 / 未连接）
                        showResult('已复位：运动已停止、各轴回到中位；但归中指令未送达（'
                            + (r.detail || '设备未连接') + '）', true, 6000);
                    } else {
                        showResult('设备已复位：运动已停止，各轴回到中位');
                    }
                    refreshStatus();
                } else {
                    showResult('复位失败：' + apiReason(r), true);
                }
            }).catch(function (e) {
                showResult('复位失败：' + ((e && e.message) || '网络错误'), true);
            });
        });

        // 面板打开时刷新一次设置与状态（设备页 / 测试机器页各有一个入口）
        var navItems = document.querySelectorAll('.sidebar-item[data-panel="osr"], '
            + '.sidebar-item[data-panel="manual"], .sidebar-item[data-panel="auto"]');
        Array.prototype.forEach.call(navItems, function (navItem) {
            navItem.addEventListener('click', function () {
                get('/api/osr/settings').then(fillForm);
                refreshStatus();
                refreshReverseState();   // 反转态与「OSR 轴设置」共用 axisParams，切面板时重新读一次
            });
        });

        get('/api/osr/settings').then(fillForm);
        refreshStatus();
        startPolling();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
