(function() {
    'use strict';

    // Extract video key from URL: /player/xxx.mp4 or /player/?video=part%2F123
    var params = new URLSearchParams(window.location.search);
    var pathParts = window.location.pathname.replace('/player/', '');
    var videoName = params.get('video') || decodeURIComponent(pathParts);
    var displayTitle = params.get('title') || videoName;

    // 视频库把「视频所在目录」直接传过来：fsroot = base64url 的 SAF 树 URI，fsrel = 相对目录。
    // 有它后端就能直接列该目录下的脚本，不必从视频 URI 反推父目录（那是最不稳的一环）。
    var fsRoot = params.get('fsroot') || '';
    var fsRel = params.get('fsrel') || '';

    // 内嵌模式：被视频库页的播放器卡以 iframe 引入（/player/?video=..&embed=1）。
    // 此时隐去本页自己的顶栏（返回键是 <a href="/">，在 iframe 里点会跳到首页），
    // 并且不自动播放 —— 由用户点播放键开始，避免一加载就出声。
    var IS_EMBED = !!params.get('embed');
    if (IS_EMBED) document.body.classList.add('embed');
    // 脚本编辑模式：被「脚本编辑」面板跳转进来，需禁用脚本自动随播（用户自己在控制设备，
    // 否则自动同步会和手动指令抢同一条串口，两边都不到位）。
    var IS_MANUALREC = !!params.get('manualrec');
    if (IS_MANUALREC) document.body.classList.add('manualrec');
    // 保存脚本时需要原始视频 URI（content:// 或文件路径），从 url 参数原样带回。
    var MANUALREC_URI = params.get('uri') || '';
    var MANUALREC_RETURN = params.get('return') || 'manualrecord';

    // 独立播放器页（脚本编辑经整页跳转进入，不加载 app.js）没有 window.OrbitNav，
    // 原生左边缘右滑 / 返回键会找不到 handleBack 而直接关掉 App。这里补一个，
    // 让右滑 / 返回键回到 App 首页，而不是把应用最小化或卡在播放器页。
    if (!IS_EMBED) {
        window.OrbitNav = window.OrbitNav || {};
        window.OrbitNav.handleBack = function () {
            // 独立播放器页（脚本编辑整页）右滑/返回键回到首页磁贴（home.html），
            // 而不是 index.html 的库/播放器首页。
            try { location.href = '/home.html'; } catch (e) {}
            return true;
        };
    }


    // VR 盒子模式：视频库页（首页「VR盒子」磁贴）以 ?vrbox=1 引入。
    // 播放器据此开放「VR 播放模式」选择（FLAT / 分屏 / 180° / 360° 等），
    // 并把内嵌模式下被 CSS 隐藏的 VR 按钮放出来 —— 盒子模式下它才是主入口。
    var IS_VRBOX = !!params.get('vrbox');
    if (IS_VRBOX) document.body.classList.add('vrbox');

    // Set page title and header
    document.title = displayTitle + ' - Orbit';
    document.getElementById('videoTitle').textContent = displayTitle;

    // Elements
    var videoEl = document.getElementById('video');

    /* ===== 播放内核：原生播放器（App 里的 ExoPlayer）或 WebView <video> =====
       原生模式下画面由 Activity 底层的 SurfaceView 出，<video> 不加载（否则双份解码、双份 IO）。
       这里用一个「与 <video> 接口同形」的代理顶替 V：
         属性读 → 原生状态快照；属性写 → 转成对应控制调用；事件 → 由原生推送分发。
       这样下面几千行播放逻辑（进度条 / 倍速 / 音量 / 全屏 / 后台保活）一行都不用改。
       VR 分屏必须拿真实 <video> 元素做 WebGL 纹理，所以进 VR 时把 V 切回 videoEl。 */
    var NATIVE_OK = !!(window.OrbitPlayer && typeof window.OrbitPlayer.load === 'function');
    // 内嵌（视频库卡片的 iframe）本期保持 WebView 行为不变
    var useNative = NATIVE_OK && !IS_EMBED;
    var npState = { posMs: 0, durMs: 0, playing: false, ready: false, buffering: false, w: 0, h: 0, rate: 1, vol: 1, muted: false, err: '' };
    var npListeners = {};
    var npSrc = '', npAutoplay = false;

    function npApply(s) {
        s = s || {};
        npState.posMs = s.posMs || 0;
        npState.durMs = s.durMs || 0;
        npState.playing = !!s.playing;
        npState.ready = !!s.ready;
        npState.buffering = !!s.buffering;
        npState.w = s.w || 0;
        npState.h = s.h || 0;
        if (typeof s.rate === 'number') npState.rate = s.rate;
        if (typeof s.vol === 'number') npState.vol = s.vol;
        npState.muted = !!s.muted;
        npState.err = s.err || '';
    }
    function npPull() {
        try { npApply(JSON.parse(window.OrbitPlayer.state() || '{}')); } catch (e) { }
    }
    function npFire(type) {
        var list = npListeners[type];
        if (!list) return;
        for (var i = 0; i < list.length; i++) { try { list[i]({ type: type }); } catch (e) { } }
    }
    /** 原生 → 网页的事件推送（MainActivity 经 evaluateJavascript 调用）。 */
    window.__orbitPlayerEvent = function (json) {
        var s = json;
        if (typeof s === 'string') { try { s = JSON.parse(s); } catch (e) { s = {}; } }
        npApply(s);
        // 原生事件名 → <video> 事件名
        switch (s && s.type) {
            case 'ready':
            case 'canplay': npFire('loadedmetadata'); npFire('canplay'); break;
            case 'error': npFire('error'); break;
            case 'seeked': npFire('seeked'); break;
            case 'ended': npFire('ended'); break;
            case 'play': npFire('play'); break;
            case 'pause': npFire('pause'); break;
            case 'ratechange': npFire('ratechange'); break;
            case 'volumechange': npFire('volumechange'); break;
            default: break;
        }
    };

    var nativeProxy = {};
    Object.defineProperties(nativeProxy, {
        paused: { get: function () { npPull(); return !npState.playing; } },
        ended: { get: function () { return false; } },
        duration: { get: function () { npPull(); return npState.durMs / 1000; } },
        readyState: { get: function () { npPull(); return npState.ready ? 4 : 0; } },
        currentTime: {
            get: function () { npPull(); return npState.posMs / 1000; },
            set: function (v) {
                try { window.OrbitPlayer.seekMs(Math.round((+v || 0) * 1000)); } catch (e) { }
                npFire('seeked');
            }
        },
        volume: {
            get: function () { return npState.vol; },
            set: function (v) {
                try { window.OrbitPlayer.setVolume(+v); } catch (e) { }
                npState.vol = +v; npFire('volumechange');
            }
        },
        muted: {
            get: function () { return npState.muted; },
            set: function (b) {
                try { window.OrbitPlayer.setMuted(!!b); } catch (e) { }
                npState.muted = !!b; npFire('volumechange');
            }
        },
        playbackRate: {
            get: function () { return npState.rate; },
            set: function (r) {
                try { window.OrbitPlayer.setRate(+r); } catch (e) { }
                npState.rate = +r; npFire('ratechange');
            }
        },
        videoWidth: { get: function () { npPull(); return npState.w; } },
        videoHeight: { get: function () { npPull(); return npState.h; } },
        error: { get: function () { return npState.err ? { code: 4, message: npState.err } : null; } },
        src: { get: function () { return npSrc; }, set: function (v) { npSrc = v; } },
        autoplay: { get: function () { return npAutoplay; }, set: function (v) { npAutoplay = !!v; } }
    });
    nativeProxy.play = function () {
        try { window.OrbitPlayer.play(); } catch (e) { }
        npState.playing = true; npFire('play');
    };
    nativeProxy.pause = function () {
        try { window.OrbitPlayer.pause(); } catch (e) { }
        npState.playing = false; npFire('pause');
    };
    nativeProxy.load = function () { };
    nativeProxy.addEventListener = function (t, f) { (npListeners[t] = npListeners[t] || []).push(f); };
    nativeProxy.removeEventListener = function (t, f) {
        var a = npListeners[t] || [], i = a.indexOf(f);
        if (i >= 0) a.splice(i, 1);
    };

    /** 内核切换：VR（真 <video>）↔ 原生。两端复用同一套 handler 列表。 */
    function useWebKernel() {
        if (!useNative || V === videoEl) return;
        var pos = 0;
        try { pos = V.currentTime || 0; } catch (e) { }
        try { window.OrbitPlayer.setMode('web'); } catch (e) { }
        V = videoEl;
        Object.keys(npListeners).forEach(function (t) {
            npListeners[t].forEach(function (f) { try { videoEl.addEventListener(t, f); } catch (e) { } });
        });
        try {
            if (!videoEl.getAttribute('src')) {
                videoEl.src = '/video/' + videoName.split('/').map(encodeURIComponent).join('/');
            }
            videoEl.currentTime = pos;
            var p = videoEl.play();
            if (p && p.catch) p.catch(function () { });
        } catch (e) { }
    }
    function useNativeKernel() {
        if (!useNative || V === nativeProxy) return;
        var pos = 0;
        try { pos = videoEl.currentTime || 0; } catch (e) { }
        // 必须释放 <video>：否则 WebView 在后台继续解码，和原生播放器双份 IO
        try { videoEl.pause(); videoEl.removeAttribute('src'); videoEl.load(); } catch (e) { }
        V = nativeProxy;
        try {
            window.OrbitPlayer.setMode('native');
            window.OrbitPlayer.seekMs(Math.round(pos * 1000));
            window.OrbitPlayer.play();
        } catch (e) { }
    }

    var V = useNative ? nativeProxy : videoEl;
    // 原生没有 timeupdate：250ms 拉一次快照喂给 UI（与后端 /api/progress 的节奏一致）
    if (useNative) {
        setInterval(function () { npPull(); npFire('timeupdate'); }, 250);
    }
    var playBtn = document.getElementById('playBtn');
    var iconPlay = document.getElementById('iconPlay');
    var iconPause = document.getElementById('iconPause');
    var progressWrap = document.getElementById('progressWrap');
    var progressFill = document.getElementById('progressFill');
    var tooltip = document.getElementById('tooltip');
    var curTime = document.getElementById('curTime');
    var durTime = document.getElementById('durTime');
    var syncDot = document.getElementById('syncDot');
    var syncText = document.getElementById('syncText');
    var syncAxes = document.getElementById('syncAxes');
    var osrDebug = document.getElementById('osrDebug');
    var osrDebugToggle = document.getElementById('osrDebugToggle');
    var osrDebugBody = document.getElementById('osrDebugBody');
    var osrDbgLink = document.getElementById('osrDbgLink');
    var osrDbgTarget = document.getElementById('osrDbgTarget');
    var osrDbgCmd = document.getElementById('osrDbgCmd');
    var osrDbgRaw = document.getElementById('osrDbgRaw');
    var osrDbgErr = document.getElementById('osrDbgErr');
    var osrDbgPos = document.getElementById('osrDbgPos');
    var osrDbgVersion = document.getElementById('osrDbgVersion');
    var osrDbgVersionStatus = document.getElementById('osrDbgVersionStatus');
    var osrDbgHasScript = document.getElementById('osrDbgHasScript');
    var osrDbgDur = document.getElementById('osrDbgDur');
    var osrDbgClock = document.getElementById('osrDbgClock');
    var osrDbgCurMs = document.getElementById('osrDbgCurMs');
    var osrDebugTest = document.getElementById('osrDebugTest');
    var osrDbgResult = document.getElementById('osrDbgResult');
    // release 版隐藏设备诊断等调试面板：仅 debug 版展示。
    function isDebugBuild() {
        try {
            var b = (window.OrbitPlayer && window.OrbitPlayer.isDebug) ? window.OrbitPlayer
                  : (window.Orbit && window.Orbit.isDebug) ? window.Orbit : null;
            if (!b) return false;
            return !!b.isDebug();
        } catch (e) { return false; }
    }
    if (!isDebugBuild()) {
        if (osrDebug) osrDebug.style.display = 'none';
        Array.prototype.forEach.call(document.querySelectorAll('.debug-only'), function (el) { el.style.display = 'none'; });
    }
    var volSlider = document.getElementById('volSlider');
    var volBtn = document.getElementById('volBtn');
    var fsBtn = document.getElementById('fsBtn');
    var rateBtn = document.getElementById('rateBtn');
    var topbar = document.getElementById('topbar');
    // 「一键冲刺」按钮（顶栏，靠「返回」右边）
    var dashBtn = document.getElementById('dashBtn');
    var controls = document.getElementById('controls');
    // 顶部时间胶囊（curTime / durTime 两个 span 的父容器 id 就叫 ptime）
    var ptime = document.getElementById('ptime');
    // 「更多」面板：窄屏时收纳音量 / 播放模式 / 倍速 / VR 播放模式
    var moreBtn = document.getElementById('moreBtn');
    var moreSheet = document.getElementById('moreSheet');
    var moreVolWrap = document.getElementById('moreVolWrap');
    var moreModeBtn = document.getElementById('moreModeBtn');
    var moreRateBtn = document.getElementById('moreRateBtn');
    var moreVrBtn = document.getElementById('moreVrBtn');

    var syncInterval = null;
    var isSending = false;
    var hideTimer = null;
    var isDraggingProgress = false;
    var isSeekingProgress = false;
    var pendingSeekTime = 0;
    var seekFallbackTimer = null;
    var latestLoadedAxes = [];
    var AXIS_ORDER = ['L0', 'L1', 'L2', 'R0', 'R1', 'R2'];

    // HEVC/H.265 等不兼容编码提示层
    var codecBlock = document.getElementById('codecBlock');
    var codecInfo = document.getElementById('codecInfo');
    var codecOpenBtn = document.getElementById('codecOpenBtn');
    var codecBackBtn = document.getElementById('codecBackBtn');
    var codecRetestBtn = document.getElementById('codecRetestBtn');
    var codecCap = document.getElementById('codecCap');
    var codecChecked = false;
    var originalUri = '';

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
        });
    }
    function yn(on) { return on ? '<span class="yes">支持</span>' : '<span class="no">不支持</span>'; }

    /**
     * 设备解码能力探测报告。
     * 目的：搞清楚 HEVC 卡在哪一环 —— 是芯片/系统没有解码器，还是 WebView 不认 hvc1。
     * 探测结果直接决定「要不要上原生播放器(Media3/ExoPlayer)」，所以放在提示层里展示。
     */
    function loadCodecSupport() {
        if (!codecCap) return Promise.resolve(null);
        return fetch('/api/video/codec-support', { cache: 'no-store' })
            .then(function(r) { return r.json().catch(function() { return null }); })
            .then(function(d) {
                if (!d) return null;
                var webViewHevc = d.webViewHevc || '';
                var hevcText = webViewHevc
                    ? '<b>' + (webViewHevc === 'probably' ? 'probably' : 'maybe') + '</b>'
                    : '<span class="no">不认</span>';
                var rows = [
                    ['Android', (d.androidApi || '?') + ' / ' + (d.androidRelease || '')],
                    ['WebView', d.webViewVersion || '未定义'],
                    ['系统 HEVC 解码器', yn(d.hasSystemHevc)],
                    ['系统 H.264 解码器', yn(d.hasSystemH264)],
                    ['WebView 认 hvc1', hevcText],
                    ['判定', esc(d.verdict || '')]
                ];
                var html = rows.map(function(r) {
                    return '<div class="codec-cap-row"><span>' + esc(r[0]) + '</span><b>' + r[1] + '</b></div>';
                }).join('');
                html += '<div class="codec-cap-hint">' + esc(d.advice || '') + '</div>';
                codecCap.innerHTML = html;
                codecCap.style.display = 'block';
                return d;
            })
            .catch(function() { return null; });
    }

    function showCodecBlock(info) {
        if (!codecBlock || !codecInfo) return;
        codecInfo.textContent = info || '当前视频编码格式不受内置播放器支持。';
        codecBlock.style.display = 'flex';
        // 原生播放器由 ExoPlayer 自行解码，WebView 认不认 hvc1 不再决定能否播放，
        // 因此诊断表只在纯 WebView 模式下展示。
        if (!useNative) loadCodecSupport();
    }
    function hideCodecBlock() {
        if (codecBlock) codecBlock.style.display = 'none';
    }
    // 「返回」：先按浏览器历史退（从视频库/详情页点进来的那条），
    // 没有历史（直接打开播放页）就明确回首页，避免点了没反应或退到上一个视频。
    function goPlayerBack() {
        var hadHistory = false;
        try { hadHistory = history.length > 1; } catch (e) { }
        if (hadHistory) { history.back(); return; }
        location.href = '/';
    }
    if (codecBackBtn) codecBackBtn.onclick = function() { goPlayerBack(); };
    if (codecRetestBtn) codecRetestBtn.onclick = function() { loadCodecSupport(); };
    if (codecOpenBtn) {
        codecOpenBtn.onclick = function() {
            if (!originalUri && window.Orbit && window.Orbit.openVideoExternal) {
                // 尝试用原始 key（content:// 或本机路径）直接打开
                window.Orbit.openVideoExternal(videoName);
                return;
            }
            if (originalUri && window.Orbit && window.Orbit.openVideoExternal) {
                window.Orbit.openVideoExternal(originalUri);
            } else {
                alert('当前环境不支持调用系统播放器');
            }
        };
    }

    // 探测视频编码：HEVC/H.265 等 WebView 不支持时提前提示，而不是黑屏。
    function checkVideoCodec() {
        if (codecChecked) return;
        codecChecked = true;
        // 原生模式下编码能力由 ExoPlayer + 系统 MediaCodec 决定，不再按 WebView 的 canPlayType 预判，
        // 否则 HEVC 会被后端硬编码的 playable=false 误拦截。
        if (useNative) return;
        fetch('/api/video/codec?key=' + encodeURIComponent(videoName), { cache: 'no-store' })
            .then(function(r) { return r.json().catch(function() { return null }); })
            .then(function(d) {
                if (!d) return;
                if (d.playable === false) {
                    // 内嵌播放卡（视频库 iframe）无法承载全局 SurfaceView，遇到 WebView 不支持的编码
                    // 直接跳到独立播放页走原生 ExoPlayer，而不是在这里提示不支持。
                    if (IS_EMBED && NATIVE_OK) {
                        try {
                            var q = '/player/?video=' + encodeURIComponent(videoName) +
                                '&title=' + encodeURIComponent(displayTitle);
                            if (IS_VRBOX) q += '&vrbox=1';
                            if (fsRoot) q += '&fsroot=' + encodeURIComponent(fsRoot);
                            if (fsRel) q += '&fsrel=' + encodeURIComponent(fsRel);
                            top.location.href = q;
                            return;
                        } catch (e) {}
                    }
                    showCodecBlock(d.reason || '检测到不兼容的视频编码格式（' + (d.codec || 'unknown') + '）。');
                    // 同时把原始 URI 准备好，供系统播放器打开
                    fetch('/api/video/original-uri?key=' + encodeURIComponent(videoName), { cache: 'no-store' })
                        .then(function(r2) { return r2.json().catch(function() { return null }); })
                        .then(function(d2) { if (d2 && d2.ok) originalUri = d2.uri || ''; })
                        .catch(function() {});
                }
            })
            .catch(function() {});
    }

    // Set video source
    if (useNative) {
        // 原生模式：URL 拼装与 percent 编码都在 App 侧做，<video> 完全不参与
        document.documentElement.classList.add('native-mode');
        document.body.classList.add('native-mode');
        try {
            // 脚本编辑：把原始 URI 经 JavascriptInterface 直接交给原生登记，
            // 不走 /video/<path> 的编解码往返——content:// 的 docId 自带 %3A/%2F，
            // 经「pctEncode + nanohttpd 解码 + handleVideo 再解码」会被拆成真实路径分隔符，
            // getDocumentId 只剩第一段 → 取流 404 → 播放器黑屏（「选完视频没打开」）。
            if (IS_MANUALREC && MANUALREC_URI && window.OrbitPlayer &&
                typeof window.OrbitPlayer.loadUri === 'function') {
                window.OrbitPlayer.loadUri(MANUALREC_URI, !IS_EMBED);
            } else {
                window.OrbitPlayer.load(videoName, !IS_EMBED);
            }
        } catch (e) { }
    } else {
        V.src = '/video/' + videoName.split('/').map(encodeURIComponent).join('/');
        V.autoplay = !IS_EMBED;
        // 加载后立刻探测编码，不等到 error（部分 WebView 对 HEVC 不会触发 error，只会永远黑屏）
        checkVideoCodec();
    }

    /* ===== OSR 硬件同步（funscript → 设备轴） =====
       视频库点开视频后，播放时自动加载「与该视频同名」的脚本组：
       ① <video>.funscript 主脚本 + <video>.<轴>.funscript 兄弟脚本一并加载；
       ② 多视频同目录时，只加载当前视频对应那一组，不会串到别的视频脚本上；
       ③ 没有匹配脚本时宁可不跑，也不整目录兜底。
       加载成功后自动打开同步，播放进度心跳由后端按系统时钟自驱设备（切后台仍有效）。 */
    var osrSyncEnabled = false;
    var osrScriptLoaded = false;
    var osrScriptNames = [];
    var osrScriptTries = 0;
    // 切后台保活相关：WebView 在 App 进入后台时可能把 <video> 静默暂停（系统行为，
    // 不是用户点的暂停）。若照直上报 playing=false，后端播放时钟会被冻结 → 设备停摆。
    // bgKeepPlaying 记录「切后台那一刻是否在播」，据此在后台期间维持播放态。
    var bgKeepPlaying = false;
// 原生（App 的 onStart / onStop）直接告知的前后台状态。
// document.hidden 在 WebView 里并不可靠（见 app.js 里的说明），原生信号才是准的。
var nativeBg = false;
function isBg() { return nativeBg || document.hidden; }
    var lastBgResumeMs = 0;
    // 保留最后一次响应，失败时把 source/tried 原样显示出来，
    // 否则真机上只看到「未加载脚本」，无从判断卡在哪一级。
    var osrScriptInfo = null;
    // 注意：这里刻意不做「同步只自动开一次」的锁 ——
    // 旧实现用 osrSyncAutoTried 一次置位就不再重试，首屏那次探测若失败，
    // 之后每次点播放都不会再开同步，用户看到的就是「脚本没跑」。

    /* ===== 无脚本自动生成（v2.7.32）=====
       视频没有对应 .funscript 时，自动用「AI生成脚本」那套本地算法（真解码音视频）
       生成一份，生成完立刻按脚本跟随，并落盘——下次打开直接命中，不用再算一遍。
       genState 取值：'' 未触发 / 'starting' 已投递 / 'running' 生成中 /
                     'done' 已生成待重载 / 'busy' 生成器被别人占用 /
                     'fail' 失败 / 'skip' 本机不可生成（SMB 等）。
       ⚠ 去重是刚需：<video> 的 play 事件每次暂停恢复都会重跑 startScriptSync()，
       loadOsrStatus() 还每 3 秒探一次，没有 genKeyFor 这道闸就会重复投递整段解码任务。 */
    var genState = '';
    var genKeyFor = '';         // 已发起生成所针对的视频 key
    var genId = '';             // 后端回的真实地址（可直接喂给生成器）
    var genTimer = null;        // 轮询句柄
    var genMsg = '';            // 覆盖到同步胶囊上的文案
    var genLastPoints = null;   // 兜底内存注入用的 L0 动作点
    var genLastDuration = 0;    // 兜底注入时补进 metadata.duration

    function postJson(url, body) {
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(function(r) { return r.json().catch(function() { return null; }); })
          .catch(function() { return null; });
    }

    // 事件驱动：play/pause/seek 时把播放状态上报后端，由后端按系统时钟自驱 OSR 设备
    // 播放态判定：切到后台且原本在播时，即使视频被系统静默暂停，也仍视为「在播」，
    // 这样后端播放时钟不会因为一次系统暂停而被冻结（设备才能继续跟随）。
    function isPlaybackGoing() {
        if (!V) return false;
        if (!V.paused) return true;
        return isBg() && bgKeepPlaying;
    }

    // 系统把视频静默暂停后尝试恢复播放（做节流，避免 pause→play→pause 抖动时反复重试）。
    function resumeFromBackgroundPause() {
        var now = Date.now();
        if (now - lastBgResumeMs < 1500) return;
        lastBgResumeMs = now;
        try {
            var p = V.play();
            if (p && p.catch) p.catch(function() {});
        } catch (e) { }
    }

    function reportPlayState() {
        // 原生模式下时钟由 App 直读播放器位置（50ms 刷新），网页上报反而会把时钟锚回旧值，直接跳过。
        if (useNative) return;
        // 不再以 osrSyncEnabled 为门槛：播放时时钟必须持续推进，否则脚本只会采样到固定时刻→设备不动。
        if (!V) return;
        postJson('/api/osr/playback-time', { playing: isPlaybackGoing(), timeMs: Math.round(V.currentTime * 1000) });
    }

    // 加载视频所在文件夹的脚本（幂等；失败最多重试 4 次，播放时会重置计数再试）
    function ensureScriptLoaded() {
        // 手录模式：用户自己在控制设备，绝不能加载/随播视频脚本，否则会和手动指令抢同一条串口。
        if (IS_MANUALREC) return Promise.resolve(false);
        // ★ 闸门：进入自动生成流程后锁住探活。play 事件与 3 秒轮询都会反复调到这里，
        // 不短路的话会重复投递解码任务，还会把 osrScriptTries 迅速啃到 4 而彻底不再重试。
        // 生成完成后由 applyGenDone() 主动解锁重来一次。
        if (genState === 'starting' || genState === 'running' || genState === 'done') {
            return Promise.resolve(false);
        }
        // 已判定「这条路走不通」：别再发无谓请求，直接把上次的结论显示在胶囊上。
        if (genState === 'busy' || genState === 'fail' || genState === 'skip') {
            updateSyncChip();
            return Promise.resolve(false);
        }
        if (osrScriptLoaded || !videoName) return Promise.resolve(osrScriptLoaded);
        if (osrScriptTries >= 4) return Promise.resolve(false);
        osrScriptTries++;
        return postJson('/api/osr/funscript-auto', { key: videoName, root: fsRoot, rel: fsRel })
            .then(function(j) {
            osrScriptInfo = j || null;
            // 未激活时 handleApi 会拦下整个 /api/osr/*，连 source 都拿不到，
            // 前端必须能给得出人话，否则胶囊上只剩一个 'no_resp'。
            if (j && j.code === 'license_blocked') {
                genState = 'skip';
                genMsg = '未激活，脚本跟随不可用';
                osrScriptLoaded = false;
                updateSyncChip();
                return false;
            }
            osrScriptLoaded = !!(j && j.ok);
            if (j && j.names && j.names.length) osrScriptNames = j.names;
            if (!osrScriptLoaded && j) {
                genId = j.genId || '';
                if (j.canGenerate && genId) {
                    startAutoGenerate();
                } else {
                    genState = 'skip';
                    genMsg = genSkipText(j.genReason || '');
                }
            }
            updateSyncChip();
            return osrScriptLoaded;
        });
    }

    // 不可自动生成时给一句说得清原因的文案，别只显示「未加载脚本」
    function genSkipText(reason) {
        if (reason === 'smb') return 'SMB 视频不支持自动生成（生成器读不了 smb://，请用本地或 SAF 目录）';
        if (reason === 'no_key') return '路径未解析出视频，无法自动生成';
        if (reason === 'unresolved') return '视频地址未解析成功，无法自动生成';
        return '该视频不支持自动生成';
    }

    // ① 投递生成任务：每部片子只投一次
    function startAutoGenerate() {
        if (IS_MANUALREC) return;                       // 手录模式双重保险
        if (genState === 'starting' || genState === 'running' || genState === 'done') return;
        if (genKeyFor === videoName &&
            (genState === 'busy' || genState === 'fail' || genState === 'skip')) return;
        genState = 'starting';
        genKeyFor = videoName;
        genMsg = '正在准备生成脚本…';
        updateSyncChip();
        postJson('/api/osr/funscript-gen/start', { id: genId }).then(function(j) {
            if (j && j.ok) { enterRunning(); return; }
            if (!j) { genState = 'fail'; genMsg = '生成脚本失败（服务未响应）'; updateSyncChip(); return; }
            if (j.code === 'license_blocked') {
                genState = 'skip'; genMsg = '未激活，脚本跟随不可用'; updateSyncChip(); return;
            }
            if (j.error === 'already_running') {
                // id 对得上 = 同一部片子（页面重载 / 重复进入），接管它的进度即可；
                // 对不上 = 「AI生成脚本」页正在跑，是用户手动点的，绝不能抢、也不能取消。
                if (j.busyId && j.busyId === genId) { enterRunning(); return; }
                genState = 'busy';
                genMsg = '生成器忙（AI生成脚本正在运行），本次不自动跟脚本';
                updateSyncChip();
                return;
            }
            genState = 'fail';
            genMsg = '生成脚本失败（' + (j.error || '未知原因') + '）';
            updateSyncChip();
        });
    }

    function enterRunning() {
        genState = 'running';
        if (genTimer) { clearTimeout(genTimer); genTimer = null; }
        pollGenStatus();                                // 立刻拉一次，别让用户干等第一个间隔
    }

    // ② 轮询进度：600ms 一次（生成可达数分钟，太密浪费、太疏看着卡）
    function pollGenStatus() {
        if (genState !== 'running') return;
        postJson('/api/osr/funscript-gen/status', {}).then(function(st) {
            if (genState !== 'running') return;         // 期间视频已被切走 → 停手
            if (!st) { genTimer = setTimeout(pollGenStatus, 1500); return; }
            if (st.running) {
                genMsg = '正在生成脚本 ' + Math.max(0, Math.min(100, st.percent | 0)) + '%';
                updateSyncChip();
                genTimer = setTimeout(pollGenStatus, 600);
                return;
            }
            var phase = st.phase || '';
            if (st.ok && phase === 'done') {
                genLastDuration = st.duration || 0;
                if (!st.points) {                       // 轻量 status 没带点，兜底注入前先补一次
                    postJson('/api/osr/funscript-gen/status', { full: 1 }).then(function(f) {
                        if (f) genLastPoints = f.points || null;
                        applyGenDone();
                    });
                } else { genLastPoints = st.points; applyGenDone(); }
                return;
            }
            if (phase === 'cancelled') { genState = ''; genKeyFor = ''; updateSyncChip(); return; }
            genState = 'fail';
            genMsg = '生成脚本失败（' + (st.error || st.message || '未知原因') + '）';
            updateSyncChip();
        });
    }

    // ③ 生成完成：主路径——清掉本地缓存让 funscript-auto 重新读回刚落盘的脚本 → play
    function applyGenDone() {
        genState = 'done';
        genMsg = '脚本已生成，正在加载…';
        updateSyncChip();
        osrScriptLoaded = false;      // ★ 不置 false，ensureScriptLoaded 会被缓存短路
        osrScriptTries = 0;           // ★ 生成期间它早就被啃到 4 了
        osrScriptInfo = null;
        osrScriptNames = [];
        postJson('/api/osr/funscript-auto', { key: videoName, root: fsRoot, rel: fsRel })
            .then(function(j) {
            osrScriptInfo = j || null;
            osrScriptLoaded = !!(j && j.ok);
            if (j && j.names && j.names.length) osrScriptNames = j.names;
            if (osrScriptLoaded) {
                genState = ''; genKeyFor = ''; genMsg = '';
                osrScriptTries = 0;
                // 生成花了几分钟，这段时间用户很可能已经暂停了；
                // 暂停态下不该把时钟开起来（否则画面停着、设备还在动）。
                if (V && V.paused && !isPlaybackGoing()) { updateSyncChip(); return null; }
                return postJson('/api/osr/script', { action: 'play' }).then(function(r) {
                    if (r && r.ok) osrSyncEnabled = true;
                    return r;
                });
            }
            return injectGenFallback();                 // ④ 文件读不回来时的兜底
        }).then(function() { updateSyncChip(); reportPlayState(); });
    }

    // ④ 兜底：把 status.points 组装成 funscript 文本直接塞进 OsrManager（不经文件）
    function injectGenFallback() {
        var pts = genLastPoints;
        if (!pts || !pts.length) {
            genState = 'fail';
            genMsg = '脚本已生成但读不回来，请重进一次';
            return Promise.resolve(false);
        }
        // ⚠ 只放根 actions（= L0）。塞进 axes[] 会让 parseFunscriptText 解析出两份 L0。
        var text = JSON.stringify({
            version: '1.1', inverted: false, range: 100,
            metadata: { generator: 'Orbit ScriptRecorder', duration: genLastDuration },
            actions: pts
        });
        return postJson('/api/osr/funscript', { text: text }).then(function(r) {
            if (!(r && r.ok)) { genState = 'fail'; genMsg = '脚本加载失败'; return false; }
            osrScriptLoaded = true;
            osrScriptTries = 0;
            genState = ''; genKeyFor = ''; genMsg = '';
            if (V && V.paused && !isPlaybackGoing()) { updateSyncChip(); return true; }
            return postJson('/api/osr/script', { action: 'play' }).then(function(p) {
                if (p && p.ok) osrSyncEnabled = true;
                return true;
            });
        });
    }

    // 有脚本时把「同步」打开：否则后端不会把轴指令发给设备，表现就是「脚本没跑」
    function ensureSyncOn() {
        // 手录模式：不开同步，避免脚本时钟驱动设备与手动控制打架
        if (IS_MANUALREC) return Promise.resolve(false);
        if (osrSyncEnabled) return Promise.resolve(true);
        return postJson('/api/osr/sync', { enabled: true }).then(function(r) {
            osrSyncEnabled = !!(r && r.ok);
            return osrSyncEnabled;
        });
    }

    // 视频开始播放：确保脚本已加载 → 开启同步 → 上报播放状态
    function startScriptSync() {
        osrScriptTries = 0;
        ensureScriptLoaded().then(function(ok) {
            if (!ok) { reportPlayState(); return null; }
            // 走「脚本播放」同款可靠路径：setSync + 时钟置 playing（这才是驱动设备的开关）。
            // 若 play 未被接受（理论上脚本已加载不该发生），再退回 /api/osr/sync 兜底。
            return postJson('/api/osr/script', { action: 'play' }).then(function(j) {
                if (j && j.ok) { osrSyncEnabled = true; return j; }
                return postJson('/api/osr/sync', { enabled: true }).then(function(r) {
                    if (r && r.ok) osrSyncEnabled = true; return r;
                });
            });
        }).then(function() { reportPlayState(); });
    }

    // 脚本编辑模式需要读取播放进度（毫秒）作为录制轨迹的「视频时间轴」锚点。
    // 同源 iframe（/player/ 与 index 同由本机 nanohttpd 提供）可直接读，无需 postMessage。
    window.__playerGetTimeMs = function () {
        try { return Math.round((V && V.currentTime || 0) * 1000); } catch (e) { return 0; }
    };

    function safeDecode(s) {
        if (s == null) return '';
        try { return decodeURIComponent(String(s)); } catch (e) { return String(s); }
    }

    function updateSyncChip() {
        if (!syncText) return;
        // ★ 生成态优先：loadOsrStatus() 每 3 秒轮询会重绘胶囊，不抢先返回的话
        //   刚画上去的「正在生成脚本 42%」立刻被下面的「未加载脚本(...)」冲掉，
        //   表现就是进度闪一下就没了。
        if (genState === 'starting' || genState === 'running' || genState === 'done') {
            setSyncStatus('wait', genMsg || '正在生成脚本…', []);
            return;
        }
        if (genState === 'busy' || genState === 'fail' || genState === 'skip') {
            setSyncStatus('warn', genMsg || '无法自动跟脚本', []);
            return;
        }
        if (!osrScriptLoaded) {
            // 把后端给的原因显示出来：哪一级落空、各级查到几条，一眼可判
            var info = osrScriptInfo || {};
            var why = info.source || 'no_resp';
            var txt = '未加载脚本(' + why;
            if (info.tried && info.tried.length) {
                try { txt += ' · ' + Array.prototype.join.call(info.tried, ','); } catch (e) { }
            }
            // 加载失败时补全「视频名 vs 目录里现有脚本主基名」，否则只能看到「未加载脚本」，无从下手
            if (typeof info.videoBase === 'string' && info.videoBase) txt += ' · 视频=' + safeDecode(info.videoBase);
            if (info.folderRoots && info.folderRoots.length) {
                try { txt += ' · 目录=' + Array.prototype.join.call(info.folderRoots, ' | '); } catch (e) { }
            }
            if (!info.videoBase) txt += ' · 路径未解析出视频名';
            txt += ')';
            setSyncStatus('warn', txt, []);
            return;
        }
        var n = osrScriptNames.length;
        setSyncStatus(V.paused ? 'wait' : 'ok', n > 1 ? ('脚本×' + n + ' 已加载') : '脚本已加载', latestLoadedAxes);
    }

    function loadOsrStatus() {
        return fetch('/api/osr/status').then(function(r) { return r.json(); }).then(function(s) {
            if (s && typeof s.syncEnabled === 'boolean') osrSyncEnabled = osrScriptLoaded || s.syncEnabled;
            renderOsrDebug(s);
            return ensureScriptLoaded();
        }).catch(function() {});
    }

    function renderOsrDebug(s) {
        if (!s) return;
        var type = s.connectionType || '-';
        var state = s.linkState || '-';
        var target;
        if (!s.enabled) {
            target = '未启用硬件输出';
        } else if (type === 'Serial') {
            target = 'Serial ' + (s.serialDevice || '-') + ' @' + (s.baudRate || '-') + 'bps';
        } else if (type === 'BluetoothSerial') {
            target = 'BT ' + (s.btAddress || '-');
        } else {
            target = type + ' ' + (s.ip || '-') + ':' + (s.port || '-');
        }
        if (osrDbgLink) osrDbgLink.textContent = state + ' (' + type + ')';
        if (osrDbgTarget) osrDbgTarget.textContent = target;
        if (osrDbgCmd) osrDbgCmd.textContent = (s.lastSentPayload || '-') + (s.lastSentAtMs ? ' @' + fmtMsAgo(Date.now() - s.lastSentAtMs) : '');
        if (osrDbgRaw) osrDbgRaw.textContent = s.lastSentPayloadRaw || '-';
        if (osrDbgErr) osrDbgErr.textContent = s.lastSendError || '无';
        if (osrDbgVersion && s.tcodeVersion) {
            osrDbgVersion.value = s.tcodeVersion;
            if (osrDbgVersionStatus) osrDbgVersionStatus.textContent = '';
        }
        if (osrDbgPos && s.livePositions) {
            var parts = [];
            AXIS_ORDER.forEach(function(axis) {
                var v = s.livePositions[axis];
                parts.push(axis + ':' + (typeof v === 'number' ? v : '-'));
            });
            osrDbgPos.textContent = parts.join(' ');
        }
        if (osrDbgHasScript) osrDbgHasScript.textContent = (s.hasScript ? '已加载' : '无') + (s.scriptDurationSec ? (' (' + s.scriptDurationSec.toFixed(1) + 's)') : '');
        if (osrDbgDur) osrDbgDur.textContent = (s.scriptDurationSec ? (s.scriptDurationSec.toFixed(1) + 's') : '-');
        if (osrDbgClock) osrDbgClock.textContent = (s.clockPlaying ? '播放中 ▶' : '未推进/暂停 ⏸');
        if (osrDbgCurMs) osrDbgCurMs.textContent = (typeof s.currentMs === 'number' ? (s.currentMs / 1000).toFixed(1) + 's' : '-');
    }
    function fmtMsAgo(ms) {
        if (ms < 1000) return '刚刚';
        if (ms < 60000) return Math.floor(ms / 1000) + '秒前';
        return Math.floor(ms / 60000) + '分钟前';
    }

    function testOsrDevice() {
        if (!osrDebugTest) return;
        osrDebugTest.disabled = true;
        osrDbgResult.textContent = '发送中…';
        fetch('/api/osr/connect-test', { method: 'POST' }).then(function(r) { return r.json(); }).then(function(j) {
            osrDbgResult.textContent = (j && j.ok ? '成功' : '失败') + ': ' + ((j && j.detail) || '-');
        }).catch(function(e) {
            osrDbgResult.textContent = '请求异常: ' + (e && e.message ? e.message : 'unknown');
        }).then(function() {
            setTimeout(function() { osrDebugTest.disabled = false; }, 1200);
        });
    }
    // 首屏先探一次脚本（不等播放），让用户选中视频后就能看到轴指示灯亮起
    loadOsrStatus().then(function() { if (osrScriptLoaded) ensureSyncOn(); });
    setInterval(loadOsrStatus, 3000);

    function fmt(s) {
        var h = Math.floor(s / 3600);
        var m = Math.floor((s % 3600) / 60);
        var sec = Math.floor(s % 60);
        if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
        return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    }

    function normalizeAxes(value) {
        if (!Array.isArray(value)) return [];
        return value.map(function(axis) {
            return String(axis || '').toUpperCase();
        }).filter(function(axis) {
            return AXIS_ORDER.indexOf(axis) >= 0;
        });
    }

    function renderAxisStatus(axes) {
        if (!syncAxes) return;
        var loaded = {};
        axes.forEach(function(axis) { loaded[axis] = true; });
        syncAxes.innerHTML = AXIS_ORDER.map(function(axis) {
            return '<span class="axis-chip ' + (loaded[axis] ? 'loaded' : 'missing') + '">' + axis + '</span>';
        }).join('');
    }

    function setSyncStatus(dotClass, text, axes) {
        syncDot.className = 'sync-dot ' + dotClass;
        syncText.textContent = text;
        renderAxisStatus(axes || latestLoadedAxes);
    }

    function applyServerSyncStatus(data) {
        // 生成态优先：自动生成脚本期间只显示「正在生成脚本 xx%」进度文案，
        // 不让服务端的「轴同步中」把胶囊抢走（否则进度与同步文案交替闪）。
        if (genState === 'starting' || genState === 'running' || genState === 'done'
            || genState === 'busy' || genState === 'fail' || genState === 'skip') {
            updateSyncChip();
            return;
        }
        var axes = normalizeAxes(data && data.loadedAxes);
        latestLoadedAxes = axes;
        if (axes.length > 0) {
            setSyncStatus(V.paused ? 'wait' : 'ok', V.paused ? '脚本已加载' : '轴同步中', axes);
        } else if (data && data.currentVideoName) {
            setSyncStatus('warn', '未加载脚本', axes);
        } else {
            setSyncStatus('wait', '等待同步', axes);
        }
    }

    renderAxisStatus(latestLoadedAxes);

    function updateUI() {
        if (!V.duration) return;
        if (isDraggingProgress || isSeekingProgress) return;
        progressFill.style.width = (V.currentTime / V.duration * 100) + '%';
        curTime.textContent = fmt(V.currentTime);
        durTime.textContent = fmt(V.duration);
    }

    function setPlaying(p) {
        iconPlay.style.display = p ? 'none' : '';
        iconPause.style.display = p ? '' : 'none';
    }

    function durationReady() {
        return Number.isFinite(V.duration) && V.duration > 0;
    }

    function progressInfo(e) {
        var r = progressWrap.getBoundingClientRect();
        var x = Math.min(Math.max(e.clientX - r.left, 0), r.width);
        var p = r.width > 0 ? x / r.width : 0;
        return { rect: r, x: x, percent: p, time: p * V.duration };
    }

    function currentThumbX() {
        var r = progressWrap.getBoundingClientRect();
        if (!durationReady()) return 0;
        return V.currentTime / V.duration * r.width;
    }

    function isOnCurrentThumb(e) {
        return Math.abs(progressInfo(e).x - currentThumbX()) <= 18;
    }

    function previewProgress(e) {
        if (!durationReady()) return;
        var info = progressInfo(e);
        pendingSeekTime = info.time;
        progressFill.style.width = (info.percent * 100) + '%';
        curTime.textContent = fmt(pendingSeekTime);
        durTime.textContent = fmt(V.duration);
    }

    function seekToPending() {
        if (!durationReady()) return;
        isDraggingProgress = false;
        isSeekingProgress = true;
        V.currentTime = pendingSeekTime;
        clearTimeout(seekFallbackTimer);
        seekFallbackTimer = setTimeout(function() {
            isSeekingProgress = false;
            updateUI();
            sendProgress();
        }, 8000);
    }

    function updateTooltip(e) {
        if (!durationReady()) return;
        var info = progressInfo(e);
        tooltip.textContent = fmt(info.time);
        tooltip.style.left = Math.min(Math.max(info.x, 20), info.rect.width - 20) + 'px';
    }

    function tryAutoplay() {
        var playPromise = V.play();
        if (playPromise && playPromise.catch) {
            playPromise.catch(function() {
                setPlaying(false);
                showUI();
            });
        }
    }

    async function sendProgress() {
        if (isSending) return;
        // 切后台 + 视频被系统停住：画面时刻不再前进，继续每 250ms 上报 
        // 会把后端播放时钟一次次锚回同一时刻（设备反而停摆）。
        // 此时直接不上报，让后端按系统时钟自由推进，回前台时再重新锚定。
        if (isBg() && bgKeepPlaying && V && V.paused) return;
        isSending = true;
        try {
            var r = await fetch('/api/progress', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    videoName: displayTitle,
                    streamKey: videoName,
                    currentTime: V.currentTime,
                    isPlaying: isPlaybackGoing()
                })
            });
            if (!r.ok) {
                setSyncStatus('fail', '同步失败');
                return;
            }
            var data = await r.json().catch(function() { return null; });
            if (data) {
                applyServerSyncStatus(data);
            } else {
                setSyncStatus('wait', '状态未知');
            }
        } catch (e) {
            setSyncStatus('fail', '连接断开');
        } finally {
            isSending = false;
        }
    }

    // Show/hide controls
    // uiVisible = 控制条当前是否在显示。视频区域采用「两段式点击」：
    // ① 控制条隐藏时点一下 → 只唤出控制条（倍速 / 全屏等），不改变播放状态；
    // ② 控制条已在显示时再点 → 才是暂停 / 继续播放。
    var uiVisible = true;
    var videoTapRevealsOnly = false;
    function setUiVisible(v) {
        uiVisible = v;
        // v2.7.24：淡出时只降「返回 / 标题 / 画面控制条」，冲刺按钮必须常驻 ——
        // 它是驱动开关，跟着顶栏一起消失会让用户以为按钮根本不存在。
        // 顶栏容器本身保持 opacity:1（只撤掉背景渐变），改由 .ui-dim 精准淡出其余元素。
        if (v) { topbar.classList.remove('ui-dim'); } else { topbar.classList.add('ui-dim'); }
        controls.style.opacity = v ? '1' : '0';
        if (ptime) ptime.style.opacity = v ? '1' : '0';
    }
    function showUI() {
        setUiVisible(true);
        clearTimeout(hideTimer);
        hideTimer = setTimeout(function() { if (!V.paused) setUiVisible(false); }, 3000);
    }
    document.addEventListener('pointermove', showUI);
    document.addEventListener('pointerdown', showUI);

    /* ─── 按钮行放不下 → 折叠为紧凑模式（body.pl-compact） ───
       用实测而不是写死断点：把每个按钮的固有宽度加总（.spacer 是 flex:1，会吸收剩余
       空间，不计入），一旦超过按钮行的可用宽度就切紧凑。竖屏手机和内嵌视频卡都会命中。
       紧凑模式下音量 / 播放模式 / VR 播放模式从主行收起，改由「更多」面板承载。 */
    var btnRow = document.querySelector('.btn-row');
    function rowOverflow() {
        if (!btnRow) return false;
        var cs = window.getComputedStyle ? getComputedStyle(btnRow) : null;
        var gap = cs ? (parseFloat(cs.columnGap || cs.gap || '0') || 0) : 0;
        var want = 0, n = 0;
        for (var i = 0; i < btnRow.children.length; i++) {
            var el = btnRow.children[i];
            if (el.classList && el.classList.contains('spacer')) continue;
            want += el.offsetWidth;
            n++;
        }
        want += gap * Math.max(n - 1, 0);
        return want > btnRow.clientWidth + 1;
    }
    function applyCompact() {
        if (!btnRow) return;
        /* 测量必须包含「更多」按钮的真实宽度：它默认 display:none（inline style 临时打开），
           否则「已经紧凑」时按钮变少、测得「放得下」又退回全量 → 反复抖动。
           临时显示 → 量完还原， Lessons:测量的是「所有按钮都在」的宽度，与当前状态无关。 */
        var probe = false;
        if (moreBtn) { moreBtn.style.display = 'flex'; probe = true; }
        var full = rowOverflow();
        if (probe && moreBtn) moreBtn.style.display = '';
        if (full && moreSheet && moreSheet.classList.contains('on')) closeMore();
        document.body.classList.toggle('pl-compact', full);
    }
    window.addEventListener('resize', applyCompact);
    window.addEventListener('orientationchange', applyCompact);

    // Play/pause
    playBtn.onclick = function() { V.paused ? V.play() : V.pause(); };
    V.addEventListener('play', function() {
        setPlaying(true);
        if (!syncInterval) syncInterval = setInterval(sendProgress, 250);
        sendProgress();
        // 播放即确保「视频所在文件夹的脚本」已加载并同步（不能只靠 3s 轮询，
        // 否则点开视频立刻播放时，脚本还没加载完，用户看到的就是「没同步运行」）
        // 脚本编辑模式跳过自动随播：不加载视频同目录脚本、不开同步，留给用户手动控制设备
        if (!IS_MANUALREC) startScriptSync();
        showUI();
    });
    V.addEventListener('pause', function() {
        // 切后台被系统静默暂停：这不是用户操作，绝不能让设备跟着停。
        // ⚠️ 这里**不能**再要求 bgKeepPlaying 已经就位：系统暂停视频往往发生在原生前后台
        // 信号到达页面之前，那一刻 bgKeepPlaying 还是 false，这次 pause 就会被误判成
        // 「用户点了暂停」，照直上报 playing=false —— 后端播放时钟一冻，设备就停了。
        // 这正是「切后台设备就停」的根因之一。只要确定「不在前台」就一律按系统暂停处理：
        // 自己接管播放态 + 尝试恢复播放 + **不上报** playing=false。
        if (isBg()) {
            bgKeepPlaying = true;
            startBgWatchdog();
            resumeFromBackgroundPause();
            return;
        }
        setPlaying(false);
        if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
        sendProgress();
        reportPlayState();
        showUI();
    });
    /* ---------- 后台保活 ----------
       两个来源：原生信号（准，优先级高）与 visibilitychange（浏览器里兜底）。
       两者都汇到 setBackground()，避免两套逻辑各改一半、状态对不上。 */
    var bgActive = false;
    var bgWatchdog = null;

    // 后台上报用的看门狗：视频若被系统静默暂停就持续尝试恢复，并周期性把「仍在播放」
    // 告给后端。⚠️ 只在**确实在播**时上报 —— 拿一个停住的画面时刻去锚定时钟，
    // 会把后端播放时钟一次次拽回同一时刻（设备反而停摆）。
    function startBgWatchdog() {
        if (bgWatchdog) return;
        bgWatchdog = setInterval(function() {
            if (!bgKeepPlaying) { stopBgWatchdog(); return; }
            if (V && V.paused) resumeFromBackgroundPause();
            else reportPlayState();
        }, 3000);
    }

    function stopBgWatchdog() {
        if (bgWatchdog) { clearInterval(bgWatchdog); bgWatchdog = null; }
    }

    /**
     * 回前台时把视频对齐到后端的原生播放时钟。
     *
     * 后台期间视频可能被系统静默暂停，而后端时钟是按系统时间自驱的（这正是设备不停的原因），
     * 于是画面会落后于设备。差距超过 2 秒就 seek 到时钟位置，否则「切回来画面对不上」。
     */
    function realignToNativeClock() {
        // 原生模式下画面与设备本来就是同一个时钟，回前台无需校正（校正反而会让画面跳一下）
        if (useNative) return;
        fetch('/api/osr/status', { cache: 'no-store' })
            .then(function(r) { return r.ok ? r.json() : null; })
            .then(function(d) {
                if (!d || !d.clockPlaying) return;
                var ms = Number(d.currentMs || 0);
                if (!ms) return;
                var gap = ms - V.currentTime * 1000;
                if (gap > 2000) { try { V.currentTime = ms / 1000; } catch (e) { } }
            })
            .catch(function() { });
    }

    function setBackground(bg) {
        if (bg === bgActive) return;
        bgActive = bg;
        if (bg) {
            bgKeepPlaying = !V.paused;
            if (bgKeepPlaying) startBgWatchdog();
            return;
        }
        stopBgWatchdog();
        var keep = bgKeepPlaying;
        bgKeepPlaying = false;
        if (keep && V.paused) resumeFromBackgroundPause();
        realignToNativeClock();
        setPlaying(!V.paused);
        sendProgress();
        reportPlayState();
        showUI();
    }

    // 原生直接调用（App 的 onStart / onStop）
    window.__orbitBg = function(bg) { setBackground(!!bg); };
    // 内嵌播放时：主框架收到原生信号后转发过来
    window.addEventListener('message', function(e) {
        var d = e.data;
        if (d && typeof d.__orbitBg === 'boolean') setBackground(d.__orbitBg);
        // 视频库页把当前目录的视频列表送过来，供顺序 / 随机播放使用
        if (d && Array.isArray(d.__orbitPlaylist)) setPlayList(d.__orbitPlaylist);
    });
    // 浏览器 / 没有原生信号时兜底
    document.addEventListener('visibilitychange', function() {
        setBackground(document.hidden);
    });

    V.addEventListener('timeupdate', updateUI);
    V.addEventListener('seeked', function() {
        clearTimeout(seekFallbackTimer);
        isDraggingProgress = false;
        isSeekingProgress = false;
        updateUI();
        sendProgress();
        reportPlayState();
    });
    V.addEventListener('loadedmetadata', function() {
        durTime.textContent = fmt(V.duration);
        sendProgress();
        notifyVideoRatio();
        loadOsrStatus().then(function() { reportPlayState(); });
        tryAutoplay();
    });
    V.addEventListener('error', function() {
        // 播放错误时如果不是已知编码问题，再补一次探测给出明确提示
        if (codecBlock && codecBlock.style.display !== 'none') return;
        var err = V.error;
        var code = err ? err.code : 0;
        var msg = '视频加载失败' + (code ? ' (错误码 ' + code + ')' : '') + '。';
        // 原生模式下：错误就是 ExoPlayer 真实解码/IO 失败，直接给通用兜底提示，
        // 不再用 WebView 的编码探测（会误把 HEVC 判为不支持）。
        if (useNative) {
            showCodecBlock(msg + '请尝试用系统播放器打开，或检查文件是否损坏。');
            fetch('/api/video/original-uri?key=' + encodeURIComponent(videoName), { cache: 'no-store' })
                .then(function(r) { return r.json().catch(function() { return null }); })
                .then(function(d) { if (d && d.ok) originalUri = d.uri || ''; })
                .catch(function() {});
            return;
        }
        checkVideoCodec();
        // 探测是异步的，如果 800ms 后还没显示提示，给一个通用兜底
        setTimeout(function() {
            if (codecBlock && codecBlock.style.display === 'none') {
                showCodecBlock(msg + '请尝试用系统播放器打开，或检查文件是否损坏。');
                fetch('/api/video/original-uri?key=' + encodeURIComponent(videoName), { cache: 'no-store' })
                    .then(function(r) { return r.json().catch(function() { return null }); })
                    .then(function(d) { if (d && d.ok) originalUri = d.uri || ''; })
                    .catch(function() {});
            }
        }, 800);
    });
    V.addEventListener('canplay', function() {
        if (V.paused) tryAutoplay();
        notifyVideoRatio();          // 再上报一次：loadedmetadata 时 videoWidth 可能还是 0
    }, { once: true });
    // 视口变化（转屏等）也重新上报，父级操作卡才会重算宽高比
    window.addEventListener('resize', notifyVideoRatio);
    // 视频区域点击（两段式）：
    // pointerdown 在 V 上先于 document 的 showUI 冒泡触发，因此这里读到的是「点击前」的可见性。
    // ⚠️ 绑在 videoEl（真实元素）上：原生模式下 V 是代理、没有 DOM 事件，
    //    而 <video> 只是 opacity:0（保留布局与点击区），手势照旧。
    videoEl.addEventListener('pointerdown', function() { videoTapRevealsOnly = !uiVisible; });
    videoEl.addEventListener('click', function() {
        if (videoTapRevealsOnly) { videoTapRevealsOnly = false; showUI(); return; }
        V.paused ? V.play() : V.pause();
    });

    // Progress seek
    progressWrap.addEventListener('pointerdown', function(e) {
        if (!durationReady()) return;
        previewProgress(e);
        updateTooltip(e);
        if (isOnCurrentThumb(e)) {
            isDraggingProgress = true;
            progressWrap.setPointerCapture(e.pointerId);
            e.preventDefault();
        } else {
            seekToPending();
        }
        showUI();
    });
    progressWrap.addEventListener('pointermove', function(e) {
        updateTooltip(e);
        if (isDraggingProgress) previewProgress(e);
    });
    progressWrap.addEventListener('pointerup', function(e) {
        if (!isDraggingProgress) return;
        previewProgress(e);
        seekToPending();
        showUI();
    });
    progressWrap.addEventListener('pointercancel', function() {
        isDraggingProgress = false;
        if (!isSeekingProgress) updateUI();
    });

    // Volume
    // 滑块搬到「更多」面板里（同一个节点，oninput 绑在节点上，搬家不影响）
    if (moreVolWrap && volSlider) moreVolWrap.appendChild(volSlider);
    volSlider.oninput = function() { V.volume = volSlider.value; V.muted = false; };
    function toggleMute() {
        V.muted = !V.muted; volSlider.value = V.muted ? 0 : V.volume;
    }
    volBtn.onclick = function() {
        // 紧凑模式下主行已经没有滑块了，喇叭按钮改当「更多」入口，静音照样能在面板里调
        if (document.body.classList.contains('pl-compact')) { toggleMore(); return; }
        toggleMute();
    };

    /* ===== 快进 / 快退 15 秒 =====
       两种播放内核都只需写 currentTime：WebView 模式是真实 <video>，
       原生模式由代理转成 OrbitPlayer.seekMs（见上方 currentTime 的 setter）。
       目标时间夹在 [0, duration-0.3] 内，避免负数或正好落在片尾触发 ended。 */
    var SEEK_STEP = 15;
    function seekBy(deltaSec) {
        var cur = 0, dur = 0;
        try { cur = V.currentTime || 0; } catch (e) { cur = 0; }
        try { dur = V.duration || 0; } catch (e) { dur = 0; }
        if (!dur || !isFinite(dur)) dur = 0;
        var t = cur + deltaSec;
        if (t < 0) t = 0;
        if (dur > 0 && t > dur - 0.3) t = Math.max(0, dur - 0.3);
        try { V.currentTime = t; } catch (e) { }
        updateUI();
        sendProgress();
        reportPlayState();
    }
    var back15Btn = document.getElementById('back15Btn');
    var fwd15Btn = document.getElementById('fwd15Btn');
    if (back15Btn) back15Btn.onclick = function () { seekBy(-SEEK_STEP); showUI(); };
    if (fwd15Btn) fwd15Btn.onclick = function () { seekBy(SEEK_STEP); showUI(); };

    /* ===== 播放模式：循环 / 顺序 / 随机 =====
       列表由视频库页（父框架）用 postMessage 传进来；独立播放页没有列表，
       顺序与随机无从下手，因此默认并锁定为「循环」。 */
    var PLAY_MODES = [
        { id: 'loop', label: '循环' },
        { id: 'order', label: '顺序' },
        { id: 'shuffle', label: '随机' }
    ];
    var modeParam = params.get('mode');
    var playMode = (modeParam === 'loop' || modeParam === 'order' || modeParam === 'shuffle')
        ? modeParam : (IS_EMBED ? 'order' : 'loop');
    var playList = [];                       // [{key, title}]
    var playModeBtn = document.getElementById('playModeBtn');

    function modeById(id) {
        for (var i = 0; i < PLAY_MODES.length; i++) if (PLAY_MODES[i].id === id) return PLAY_MODES[i];
        return PLAY_MODES[0];
    }
    function paintPlayMode() {
        var m = modeById(playMode);
        // 同步给父页：内嵌播放时换片由父页发起，URL 里的 mode 要沿用当前选择
        try {
            if (IS_EMBED && window.parent) window.parent.postMessage({ __orbitPlayMode: playMode }, '*');
        } catch (e) { }
        var tip = '播放模式：' + m.label +
            (playList.length ? '（共 ' + playList.length + ' 个）' : '（当前没有播放列表）');
        if (playModeBtn) { playModeBtn.textContent = m.label; playModeBtn.title = tip; }
        if (moreModeBtn) { moreModeBtn.textContent = m.label; moreModeBtn.title = tip; }
    }
    // 主行按钮与「更多」面板按钮共用这一个动作（文案由 paintPlayMode 统一刷新）
    function cyclePlayMode() {
        var next = modeById(playMode);
        for (var i = 0; i < PLAY_MODES.length; i++) {
            if (PLAY_MODES[i].id === playMode) { next = PLAY_MODES[(i + 1) % PLAY_MODES.length]; break; }
        }
        // 没有列表时不给选顺序 / 随机，直接回到循环
        if (!playList.length && next.id !== 'loop') next = PLAY_MODES[0];
        playMode = next.id;
        paintPlayMode();
        showUI();
    }
    function setPlayList(list) {
        if (!Array.isArray(list)) return;
        playList = list.filter(function (it) { return it && it.key; });
        if (!playList.length && playMode !== 'loop') playMode = 'loop';
        paintPlayMode();
    }
    if (playModeBtn) playModeBtn.onclick = cyclePlayMode;
    if (moreModeBtn) moreModeBtn.onclick = function () { cyclePlayMode(); closeMore(); };

    /** 按当前模式算出下一个要播什么；返回 null 表示播完即停。 */
    function nextPlayItem() {
        if (playMode === 'loop') return { key: videoName, title: displayTitle, same: true };
        if (!playList.length) return { key: videoName, title: displayTitle, same: true };
        var idx = -1;
        for (var i = 0; i < playList.length; i++) if (playList[i].key === videoName) { idx = i; break; }
        if (idx < 0) return playList[0];
        if (playMode === 'shuffle') {
            if (playList.length <= 1) return { key: videoName, title: displayTitle, same: true };
            var j = idx;
            while (j === idx) j = Math.floor(Math.random() * playList.length);
            return playList[j];
        }
        // 顺序播放到最后一个就停：不再绕回第一个，避免整目录无限循环
        if (idx >= playList.length - 1) return null;
        return playList[idx + 1];
    }

    function playItem(item) {
        if (!item) return;
        if (item.same) { try { V.currentTime = 0; V.play(); } catch (e) { } return; }
        // 内嵌模式：请父页面换片 —— 列表与目录上下文都在父页，URL 由它拼才完整
        if (IS_EMBED && window.parent) {
            try { window.parent.postMessage({ __orbitPlay: item.key, title: item.title || '' }, '*'); return; } catch (e) {}
        }
        // 独立播放页：原地换片。用 replace 而不是 href —— 换片不该堆历史，
        // 否则「后退」会退到上一个视频而不是上一个页面。
        var q = '/player/?video=' + encodeURIComponent(item.key) +
            '&title=' + encodeURIComponent(item.title || item.key) +
            (IS_VRBOX ? '&vrbox=1' : '') +
            (fsRoot ? '&fsroot=' + encodeURIComponent(fsRoot) : '') +
            (fsRel ? '&fsrel=' + encodeURIComponent(fsRel) : '') +
            '&mode=' + encodeURIComponent(playMode);
        location.replace(q);
    }
    paintPlayMode();

    V.addEventListener('ended', function () {
        var n = nextPlayItem();
        if (!n) { updateUI(); reportPlayState(); return; }
        playItem(n);
    });

    // 把视频真实宽高比告诉外层页面（视频库），让播放卡按比例自适应，
    // 避免固定 16:9 的卡片把 4:3 / 竖屏画面裁掉或挤成一条。
    function notifyVideoRatio() {
        if (!IS_EMBED || !window.parent || !V.videoWidth || !V.videoHeight) return;
        try { window.parent.postMessage({ __orbitVideo: true, w: V.videoWidth, h: V.videoHeight }, '*'); } catch (e) {}
    }

    /* ===== 全屏 =====
       请求整个 #container（含控制条）全屏，而不是只把 <video> 放大：
       Android WebView 不会自己处理 HTML5 全屏，必须由原生的
       WebChromeClient.onShowCustomView 接管，否则 requestFullscreen 静默失败。 */
    function fsElement() {
        return document.fullscreenElement || document.webkitFullscreenElement || null;
    }
    function requestFs(el) {
        var fn = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen;
        if (!fn) {
            // ⚠ iOS（iPhone）的 WKWebView 不支持任意元素的 requestFullscreen，
            //   安卓这条路走的是原生 OrbitPlayer.setFullscreen（横屏 + 隐藏系统栏），
            //   iOS 没有那一层 → 原样照搬的话「全屏」按钮就是个死按钮。
            //   退路：<video> 元素支持 webkitEnterFullscreen，进的是系统播放器全屏，
            //   播放与脚本同步都不中断。iPad 支持元素全屏，不会走到这里。
            var v = document.querySelector('video');
            if (v && typeof v.webkitEnterFullscreen === 'function') {
                try { v.webkitEnterFullscreen(); } catch (e) {}
                return;
            }
            if (syncText) syncText.textContent = '当前环境不支持全屏';
            return;
        }
        try {
            var pr = fn.call(el);
            if (pr && pr.catch) pr.catch(function() {});
        } catch (e) {}
    }
    function exitFs() {
        var fn = document.exitFullscreen || document.webkitExitFullscreen || document.webkitCancelFullScreen;
        if (!fn) return;
        try {
            var pr = fn.call(document);
            if (pr && pr.catch) pr.catch(function() {});
        } catch (e) {}
    }
    function syncFsIcon() {
        if (fsBtn) fsBtn.title = fsElement() ? '退出全屏' : '全屏';
    }
    // 原生模式走 App 的全屏（横屏 + 隐藏系统栏）：
    // 不能走 HTML requestFullscreen —— 那条路会进 WebChromeClient.onShowCustomView，
    // 主 WebView 被置 GONE，底层的原生视频层就裸露出来了。
    var fsNative = false;
    fsBtn.onclick = function() {
        if (useNative && window.OrbitPlayer) {
            fsNative = !fsNative;
            try { window.OrbitPlayer.setFullscreen(fsNative); } catch (e) {}
            if (fsBtn) fsBtn.title = fsNative ? '退出全屏' : '全屏';
            showUI();
            return;
        }
        if (fsElement()) exitFs();
        else requestFs(document.getElementById('container') || document.documentElement);
        syncFsIcon();
        showUI();
    };
    // v2.7.29：HTML5 全屏（WebChromeClient.onShowCustomView 那条路）退出后同样点亮 UI，原因同上。
    document.addEventListener('fullscreenchange', function() { syncFsIcon(); showUI(); });
    document.addEventListener('webkitfullscreenchange', function() { syncFsIcon(); showUI(); });
    // App 侧按返回键退出原生全屏时会回调这里，同步 UI 状态并恢复竖屏。
    window.__onNativeFullscreenExit = function() {
        fsNative = false;
        if (fsBtn) fsBtn.title = '全屏';
        /* v2.7.29：退出原生全屏（横屏 → 竖屏）立刻把顶栏 / 控制条点亮并清掉 3s 自动淡出定时器。
           以前只改回 fsNative 与按钮 title，UI 仍停在淡出态 —— 而淡出态的顶栏整条 pointer-events:none，
           手指按在「← 返回」上其实是穿透到画面（只唤出一次控制条），体感就是「返回按钮点不到、不灵敏」。
           横屏那一段没碰屏幕，退出时必然还挂着淡出态，所以只有这条路径最容易复现。 */
        showUI();
    };

    // OSR 诊断面板交互
    if (osrDebugToggle && osrDebugBody) {
        osrDebugToggle.onclick = function() {
            var open = osrDebugBody.style.display === 'none';
            osrDebugBody.style.display = open ? 'block' : 'none';
            osrDebugToggle.textContent = (open ? '▾ ' : '▸ ') + '设备诊断';
            if (open) loadOsrStatus();
        };
    }
    if (osrDebugTest) osrDebugTest.onclick = testOsrDevice;
    if (osrDbgVersion) {
        osrDbgVersion.onchange = function() {
            if (!osrDbgVersionStatus) return;
            osrDbgVersionStatus.textContent = '保存中…';
            fetch('/api/osr/tcode-version', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ version: osrDbgVersion.value })
            }).then(function(r) { return r.json(); }).then(function(j) {
                osrDbgVersionStatus.textContent = (j && j.ok) ? '已保存' : ('失败: ' + ((j && j.detail) || '-'));
                loadOsrStatus();
            }).catch(function(e) {
                osrDbgVersionStatus.textContent = '请求异常';
            });
        };
    }

    /* ===== 倍速 ===== */
    var RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
    var rateIndex = 2;
    function rateLabel(r) {
        return (Math.abs(r - Math.round(r)) < 1e-6 ? String(Math.round(r)) : String(r)) + '×';
    }
    function applyRate() {
        var r = RATES[rateIndex];
        try { V.playbackRate = r; } catch (e) {}
        if (rateBtn) rateBtn.textContent = rateLabel(r);
        if (moreRateBtn) moreRateBtn.textContent = rateLabel(r);
        try { localStorage.setItem('orbit.web.playerRate', String(r)); } catch (e) {}
    }
    function cycleRate() {
        rateIndex = (rateIndex + 1) % RATES.length;
        applyRate();
        showUI();
    }
    /* ===== 一键冲刺（v2.7.28 起为「独立冲刺」，v2.7.31 起为三档循环）=====
       旧版只是把脚本的采样时钟乘个倍率（/api/osr/l0-boost）：脚本某段没动作点、
       或压根没加载到 Funscript，L0 就没有目标可插值，设备直接停在原地 —— 冲刺形同虚设。
       新版「独立冲刺」：L0 完全不读脚本，改由后端按**真实时钟**做满行程往复（三角波），
       脚本停不停、视频有没有片源，设备都一直全速动作。
       冲刺只让 L0 与旋转 / 俯卧补偿动，脚本里的其它轴（L1/L2/R0/R1/R2）保持不动。
       三档循环：点一下 = 档位 1（120 次/分）→ 档位 2（150）→ 档位 3（180）→ 再点一下关闭。
       退出播放页后端 deviceReset 也会收掉，进页面时 GET 回读真实状态校正按钮态。
       注意别和「倍速」混淆：倍速改的是视频播放速度（画面 + 时钟都快），冲刺只动设备、画面照常。 */
    var DASH_LEVELS = [120, 150, 180];  // 冲刺档位速度（次/分）：下标 0/1/2 = 档位 1/2/3
    var DASH_AMP = 100;                 // 独立冲刺行程幅度（%，100 = 满行程）
    var dashLevel = -1;                 // 当前档位：-1 = 关闭，0/1/2 = 档位 1/2/3
    // 冲刺档位切换的短提示：toast() 只活在脚本编辑（manualrec）那个作用域里，播放页直接调会 ReferenceError，
    // 所以在播放页自己做一个一次性提示条，别把切换反馈也弄丢。
    function dashTip(text) {
        var el = document.getElementById('dashTip');
        if (!el) {
            el = document.createElement('div');
            el.id = 'dashTip';
            el.style.cssText = 'position:fixed;top:86px;left:50%;transform:translateX(-50%);z-index:70;'
                + 'background:rgba(15,23,42,.95);border:1px solid rgba(240,160,32,.5);color:#f2e2c0;'
                + 'padding:9px 16px;border-radius:12px;font-size:14px;max-width:min(320px,80vw);'
                + 'text-align:center;display:none';
            document.body.appendChild(el);
        }
        el.textContent = text;
        el.style.display = 'block';
        clearTimeout(dashTip._t);
        dashTip._t = setTimeout(function () { el.style.display = 'none'; }, 1600);
    }
    var dashOn = false;
    // 提示文案跟着档位走；档位未知（后端回读速度不在三档内）时至少不会显示成「已开但没档」
    function setDashUi(on, level) {
        if (typeof level === 'number' && level >= 0) dashLevel = level;
        dashOn = !!on;
        if (dashOn && dashLevel < 0) dashLevel = 0;
        if (!dashBtn) return;
        dashBtn.classList.toggle('active', dashOn);
        dashBtn.textContent = dashOn ? '冲刺 L' + (dashLevel + 1) : '冲刺';
        dashBtn.setAttribute('aria-pressed', dashOn ? 'true' : 'false');
        dashBtn.title = dashOn
            ? '档位 ' + (dashLevel + 1) + ' · ' + DASH_LEVELS[dashLevel] + ' 次/分（再点切到档位 ' + (dashLevel + 2) + '）'
            : '一键冲刺：点一下进档位 1（120 次/分），再点档位 2 / 3，第 4 下关闭';
    }
    function applyDash(on, level, speed) {
        setDashUi(on, level);
        // 独立冲刺：后端打开一条不依赖脚本的驱动，L0 按真实时钟满行程往复
        postJson('/api/osr/dash-mode', { on: !!on, speed: speed || 0, amp: DASH_AMP }).catch(function() {});
    }
    // 四态循环：档位 1(120) → 档位 2(150) → 档位 3(180) → 关闭
    if (dashBtn) dashBtn.onclick = function() {
        dashLevel = (dashLevel + 1) % 4;
        var on = dashLevel < DASH_LEVELS.length;
        var DASH_SPEED = on ? DASH_LEVELS[dashLevel] : 0;  // 关闭时不改后端速度，收掉驱动即可
        applyDash(on, dashLevel, DASH_SPEED);
        dashTip(on ? '冲刺 档位 ' + (dashLevel + 1) + ' · ' + DASH_SPEED + ' 次/分' : '冲刺已关闭');
    };
    // 进页面先把后端真实状态读回来（换片 / 刷新 / 上一页复位之后按钮态要跟设备一致）
    (function initDash() {
        if (!dashBtn) return;
        fetch('/api/osr/dash-mode').then(function(r) { return r.json(); }).then(function(j) {
            // 用后端回读的速度反推档位：-1 表示不在三档内（如旧版遗留的 100 次/分），按关闭态显示
            setDashUi(!!(j && j.ok) && !!j.on, DASH_LEVELS.indexOf(Math.round(j.speed)));
        }).catch(function() {});
    })();
    (function initRate() {
        var saved = NaN;
        try { saved = parseFloat(localStorage.getItem('orbit.web.playerRate')); } catch (e) {}
        var i = RATES.indexOf(saved);
        rateIndex = i >= 0 ? i : 2;
        applyRate();
    })();
    if (rateBtn) rateBtn.onclick = cycleRate;
    if (moreRateBtn) moreRateBtn.onclick = function () { cycleRate(); closeMore(); };
    V.addEventListener('ratechange', function() {
        var i = RATES.indexOf(V.playbackRate);
        if (i >= 0 && i !== rateIndex) {
            rateIndex = i;
            if (rateBtn) rateBtn.textContent = rateLabel(V.playbackRate);
            if (moreRateBtn) moreRateBtn.textContent = rateLabel(V.playbackRate);
        }
    });

    /* ===== 手机盒子 VR 模式（陀螺仪 + WebGL 全景球/平面 + 桶形畸变，Cardboard 类眼镜盒） =====
       进入后把视频作为纹理贴到 WebGL：360 全景贴球面 / 普通视频贴正前方影院平面，
       由陀螺仪（或手指拖动）驱动视角，左右眼分屏 + 桶形畸变补偿 Cardboard 镜片，塞进盒子体验沉浸。 */
    var vrBtn = document.getElementById('vrBtn');
    var vrCanvas = document.getElementById('vrCanvas');
    var vrToolbar = document.getElementById('vrToolbar');
    var vrModeBtn = document.getElementById('vrModeBtn');
    var vrCamBtn = document.getElementById('vrCamBtn');
    var vrDistBtn = document.getElementById('vrDistBtn');
    var vrExitBtn = document.getElementById('vrExitBtn');
    var vrGuide = document.getElementById('vrGuide');

    var vrActive = false;
    var vrGL = null, vrProgram = null, vrTex = null;
    var vrUniforms = {};
    var vrRenderId = 0;
    var vrUiTimer = null;

    /* VR 播放模式表：投影（平面 / 半球 / 全景球）× 片源（单目 / 左右分屏）。
         proj   → shader 的 uProj：0=360° 全景球、1=FLAT 平面、2=180° 半球
         stereo → shader 的 uStereo：0=单目（整张图左右眼相同）、1=左右分屏（左半→左眼、右半→右眼）
         fov    → 单眼视场系数：平面略放大更「贴脸」，全景球略收避免边缘拉伸感
         short  → 控制栏那个窄按钮上显示的短标签（label 太长会在窄行里被截断）；
                  模式浮层与 VR 工具栏空间较大，仍用完整 label。 */
    var VR_MODES = [
      { id: 'flat',   label: 'FLAT',     short: 'FLAT',     proj: 1, stereo: 0, fov: 1.35, desc: '普通视频，平面观看' },
      { id: 'sbs',    label: '分屏',      short: '2D',       proj: 1, stereo: 1, fov: 1.35, desc: '左右分屏片源，平面观看' },
      { id: '180',    label: '180°',     short: '180°',     proj: 2, stereo: 0, fov: 1.00, desc: '半球全景（VR180）' },
      { id: '360',    label: '360°',     short: '360°',     proj: 0, stereo: 0, fov: 0.95, desc: '全景球（等距柱状）' },
      { id: '180sbs', label: '180°分屏',  short: '180·3D',   proj: 2, stereo: 1, fov: 1.00, desc: 'VR180 左右分屏片源' },
      { id: '360sbs', label: '360°分屏',  short: '360·3D',   proj: 0, stereo: 1, fov: 0.95, desc: '3D 全景球，左右分屏片源' }
    ];
    var VR_MODE_KEY = 'orbit.web.vrMode';
    // VR 盒子模式默认 FLAT（点开普通视频直接能看）；独立播放页保持原来的 360° 球面。
    // 用户选过一次后记进 localStorage，之后一律沿用。
    var vrModeIndex = 0;
    (function pickVrMode() {
      var want = null;
      try { want = localStorage.getItem(VR_MODE_KEY); } catch (e) {}
      if (!want) want = IS_VRBOX ? 'flat' : '360';
      for (var i = 0; i < VR_MODES.length; i++) {
        if (VR_MODES[i].id === want) { vrModeIndex = i; return; }
      }
    })();
    function curVrMode() { return VR_MODES[vrModeIndex]; }

    var vrCam = 'gyro';             // 'gyro'=陀螺仪；'touch'=手指拖动
    var vrDistPresets = [ [0.0,0.0], [0.12,0.06], [0.22,0.14] ]; // 无 / 弱 / 中
    var vrDistIndex = 2;
    var vrDist = vrDistPresets[vrDistIndex];
    var vrGyroReady = false;
    var vrTouchYaw = 0, vrTouchPitch = 0;
    var vrTouching = false, vrTouchX = 0, vrTouchY = 0;
    var vrRotMat = [1,0,0, 0,1,0, 0,0,1]; // 列主序 3x3

    /* ---- 四元数数学（列主序 mat3） ---- */
    function qAxisAngle(ax,ay,az,ang){ var h=ang/2,s=Math.sin(h); return [ax*s,ay*s,az*s,Math.cos(h)]; }
    function qMul(a,b){ return [
      a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],
      a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],
      a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],
      a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]
    ]; }
    function qToMat3(q){
      var x=q[0],y=q[1],z=q[2],w=q[3];
      return [
        1-2*(y*y+z*z), 2*(x*y+z*w),   2*(x*z-y*w),   // 列0
        2*(x*y-z*w),   1-2*(x*x+z*z), 2*(y*z+x*w),   // 列1
        2*(x*z+y*w),   2*(y*z-x*w),   1-2*(x*x+y*y)  // 列2
      ];
    }
    // deviceorientation(alpha/beta/gamma 弧度) → 相机旋转（参考 three.js DeviceOrientationControls）
    // 横屏修复：beta/gamma 始终以「设备竖屏」为参考坐标系。进入 VR 后屏幕锁定横屏
    // （screen.orientation.angle=90/270），若仍按竖屏映射，用户左右摆头会变成俯仰、上下点头变成
    // 横滚——表现就是「横屏时陀螺仪不行」。修复：按当前屏幕角度把物理 beta/gamma 换算回等效
    // 竖屏的 beta/gamma，再走标准四元数公式（末尾不再绕 Z 轴旋转，重映射已等价处理屏幕方向）。
    function gyroToMat3(alpha,beta,gamma){
      var angle = ((screen.orientation && screen.orientation.angle) ? screen.orientation.angle : (window.orientation||0));
      var ab = beta, ag = gamma;
      if (angle === 90)        { ab =  gamma; ag = -beta; }   // 横屏（顺时针）。若实测左右/上下反了，对调 ab/ag 或改负号
      else if (angle === 270 || angle === -90) { ab = -gamma; ag =  beta; }
      else if (angle === 180)  { ab = -beta;  ag = -gamma; }
      var qy = qAxisAngle(0,1,0, alpha);
      var qx = qAxisAngle(1,0,0, ab);
      var qz = qAxisAngle(0,0,1, -ag);
      var q = qMul(qMul(qy,qx), qz);                  // euler YXZ
      var q1 = qAxisAngle(1,0,0, -Math.PI/2);         // 屏幕坐标系 → 相机坐标系
      q = qMul(q1, q);
      return qToMat3(q);
    }
    function onDeviceOrientation(e){
      if (e.alpha===null || e.beta===null || e.gamma===null) return;
      vrGyroReady = true;
      vrRotMat = gyroToMat3(e.alpha*Math.PI/180, e.beta*Math.PI/180, e.gamma*Math.PI/180);
    }

    /* ---- WebGL 初始化 ---- */
    function compileShader(gl,type,src){
      var s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s);
      if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){ console.error('VR shader:',gl.getShaderInfoLog(s)); return null; }
      return s;
    }
    function initGL(){
      if(!vrCanvas) return false;
      var gl = vrCanvas.getContext('webgl') || vrCanvas.getContext('experimental-webgl');
      if(!gl) return false;
      var vsSrc = 'attribute vec2 aPos;void main(){gl_Position=vec4(aPos,0.0,1.0);}';
      var fsSrc = [
        'precision highp float;',
        'uniform sampler2D uTex;',
        'uniform vec2 uRes;',
        'uniform int uEye;',
        'uniform mat3 uRot;',
        'uniform float uFov;',
        'uniform float uAspect;',
        'uniform int uProj;',
        'uniform int uStereo;',
        'uniform vec2 uDist;',
        '#define PI 3.14159265359',
        'vec2 barrel(vec2 p){float r2=dot(p,p);float f=1.0+uDist.x*r2+uDist.y*r2*r2;return p*f;}',
        'void main(){',
        ' float halfW=uRes.x*0.5;',
        ' vec2 ndc;',
        ' if(uEye==0){ndc.x=gl_FragCoord.x/halfW*2.0-1.0;}',
        ' else{ndc.x=(gl_FragCoord.x-halfW)/halfW*2.0-1.0;}',
        ' ndc.y=(gl_FragCoord.y/uRes.y)*2.0-1.0;',
        ' vec2 d=barrel(ndc);',
        ' float t=tan(uFov);',
        ' vec3 rayEye=normalize(vec3(d.x*uAspect*t, d.y*t, -1.0));',
        ' vec3 dir=normalize(uRot*rayEye);',
        ' vec2 uv;',
        ' if(uProj==1){',
        // 平面（FLAT / 分屏）：贴到正前方一块矩形幕布上
        '   if(dir.z>=0.0){gl_FragColor=vec4(0.0,0.0,0.0,1.0);return;}',
        '   float k=1.0/(-dir.z);',
        '   float px=dir.x*k; float py=dir.y*k;',
        '   float halfH=t; float halfWp=t*uAspect;',
        '   uv=vec2(0.5+px/(2.0*halfWp), 0.5+py/(2.0*halfH));',
        ' } else {',
        '   float lon=atan(dir.x,-dir.z);',
        '   float lat=acos(clamp(dir.y,-1.0,1.0));',
        '   if(uProj==2){',
        // 180° 半球：方位角只覆盖前方 ±90°（整幅宽度对应 180°），后半球留黑
        '     if(dir.z>=0.0){gl_FragColor=vec4(0.0,0.0,0.0,1.0);return;}',
        '     uv=vec2(lon/PI+0.5, 1.0-lat/PI);',
        '   } else {',
        // 360° 全景球：方位角覆盖整圈
        '     uv=vec2(lon/(2.0*PI)+0.5, 1.0-lat/PI);',
        '   }',
        ' }',
        // 左右分屏：左半张→左眼、右半张→右眼（单目时整张图双眼相同）
        ' if(uStereo==1){uv.x=uv.x*0.5+(uEye==1?0.5:0.0);}',
        ' if(uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0){gl_FragColor=vec4(0.0,0.0,0.0,1.0);return;}',
        ' gl_FragColor=texture2D(uTex,uv);',
        '}'
      ].join('\n');
      var vs=compileShader(gl,gl.VERTEX_SHADER,vsSrc);
      var fs=compileShader(gl,gl.FRAGMENT_SHADER,fsSrc);
      if(!vs||!fs) return false;
      var p=gl.createProgram(); gl.attachShader(p,vs); gl.attachShader(p,fs); gl.linkProgram(p);
      if(!gl.getProgramParameter(p,gl.LINK_STATUS)){ console.error('VR link:',gl.getProgramInfoLog(p)); return false; }
      vrProgram=p; vrGL=gl;
      var buf=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,buf);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]),gl.STATIC_DRAW);
      var loc=gl.getAttribLocation(p,'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
      vrTex=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,vrTex);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
      vrUniforms={
        uTex:gl.getUniformLocation(p,'uTex'),
        uRes:gl.getUniformLocation(p,'uRes'),
        uEye:gl.getUniformLocation(p,'uEye'),
        uRot:gl.getUniformLocation(p,'uRot'),
        uFov:gl.getUniformLocation(p,'uFov'),
        uAspect:gl.getUniformLocation(p,'uAspect'),
        uProj:gl.getUniformLocation(p,'uProj'),
        uStereo:gl.getUniformLocation(p,'uStereo'),
        uDist:gl.getUniformLocation(p,'uDist')
      };
      gl.useProgram(p);
      gl.uniform1i(vrUniforms.uTex,0);
      return true;
    }

    function vrResize(){
      if(!vrGL) return;
      var dpr=Math.min(window.devicePixelRatio||1,2);
      var w=vrCanvas.clientWidth||window.innerWidth;
      var h=vrCanvas.clientHeight||window.innerHeight;
      vrCanvas.width=Math.max(2,Math.floor(w*dpr));
      vrCanvas.height=Math.max(2,Math.floor(h*dpr));
    }

    function vrRender(){
      if(!vrActive||!vrGL) return;
      var gl=vrGL;
      vrResize();
      gl.viewport(0,0,vrCanvas.width,vrCanvas.height);
      if(V.readyState>=2){
        try{ gl.bindTexture(gl.TEXTURE_2D,vrTex); gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,V); }catch(e){}
      }
      var cam = (vrCam==='gyro') ? vrRotMat
        : qToMat3(qMul(qAxisAngle(0,1,0,vrTouchYaw), qAxisAngle(1,0,0,vrTouchPitch)));
      var halfW=vrCanvas.width*0.5, halfH=vrCanvas.height;
      var aspect=halfW/halfH;
      var vm=curVrMode();
      var fov=Math.PI/4*0.95*vm.fov; // 基准单眼约 85°，按模式微调
      gl.uniformMatrix3fv(vrUniforms.uRot,false,cam);
      gl.uniform2f(vrUniforms.uRes,vrCanvas.width,vrCanvas.height);
      gl.uniform1f(vrUniforms.uFov,fov);
      gl.uniform1f(vrUniforms.uAspect,aspect);
      gl.uniform1i(vrUniforms.uProj, vm.proj);
      gl.uniform1i(vrUniforms.uStereo, vm.stereo);
      gl.uniform2f(vrUniforms.uDist,vrDist[0],vrDist[1]);
      // 左眼
      gl.viewport(0,0,halfW,halfH);
      gl.uniform1i(vrUniforms.uEye,0);
      gl.drawArrays(gl.TRIANGLES,0,6);
      // 右眼
      gl.viewport(halfW,0,halfW,halfH);
      gl.uniform1i(vrUniforms.uEye,1);
      gl.drawArrays(gl.TRIANGLES,0,6);
      vrRenderId=requestAnimationFrame(vrRender);
    }

    function vrShowUI(){
      if(!vrActive||!vrToolbar) return;
      vrToolbar.style.opacity='1';
      clearTimeout(vrUiTimer);
      vrUiTimer=setTimeout(function(){ vrToolbar.style.opacity='0'; },3500);
    }

    function enterVR(){
      if(vrActive) return;
      // 切回真实 <video>：WebGL 的 texImage2D 必须拿元素本身做纹理，代理对象不行
      useWebKernel();
      if(!initGL()){ alert('当前 WebView 不支持 WebGL，无法进入 VR 模式'); return; }
      vrActive=true;
      document.body.classList.add('vr-mode');
      vrResize();
      // 横屏 + 全屏（必须在用户手势内触发，失败静默降级）
      try{ if(screen.orientation&&screen.orientation.lock) screen.orientation.lock('landscape').catch(function(){}); }catch(e){}
      var fsTarget=document.getElementById('container')||document.documentElement;
      if(fsTarget.requestFullscreen) fsTarget.requestFullscreen().catch(function(){});
      // 陀螺仪权限（iOS 13+ 需用户手势触发；Android 一般直接可用）
      try{
        if(typeof DeviceOrientationEvent!=='undefined' && typeof DeviceOrientationEvent.requestPermission==='function'){
          DeviceOrientationEvent.requestPermission().then(function(state){
            if(state==='granted'){ window.addEventListener('deviceorientation',onDeviceOrientation,true); }
            else { vrCam='touch'; if(vrCamBtn) vrCamBtn.textContent='触摸'; }
          }).catch(function(){ vrCam='touch'; if(vrCamBtn) vrCamBtn.textContent='触摸'; });
        } else {
          window.addEventListener('deviceorientation',onDeviceOrientation,true);
        }
      }catch(e){ window.addEventListener('deviceorientation',onDeviceOrientation,true); }
      vrCanvas.addEventListener('touchstart',onVrTouchStart,true);
      vrCanvas.addEventListener('touchmove',onVrTouchMove,true);
      vrRender();
      vrShowUI();
    }

    function exitVR(){
      if(!vrActive) return;
      vrActive=false;
      cancelAnimationFrame(vrRenderId);
      document.body.classList.remove('vr-mode');
      window.removeEventListener('deviceorientation',onDeviceOrientation,true);
      vrCanvas.removeEventListener('touchstart',onVrTouchStart,true);
      vrCanvas.removeEventListener('touchmove',onVrTouchMove,true);
      if(document.fullscreenElement) document.exitFullscreen().catch(function(){});
      if(vrToolbar) vrToolbar.style.opacity='0';
      // 交回原生播放器：从 VR 退出的时刻继续播，并释放 <video> 避免双份解码
      useNativeKernel();
    }

    function onVrTouchStart(e){ if(!vrActive) return; vrTouching=true; var t=e.touches[0]; vrTouchX=t.clientX; vrTouchY=t.clientY; }
    function onVrTouchMove(e){
      if(!vrActive||!vrTouching) return;
      var t=e.touches[0];
      var dx=t.clientX-vrTouchX, dy=t.clientY-vrTouchY;
      vrTouchX=t.clientX; vrTouchY=t.clientY;
      vrTouchYaw -= dx*0.005;
      vrTouchPitch -= dy*0.005;
      if(vrTouchPitch>1.4) vrTouchPitch=1.4; if(vrTouchPitch<-1.4) vrTouchPitch=-1.4;
      if(vrCam!=='touch'){ vrCam='touch'; if(vrCamBtn) vrCamBtn.textContent='触摸'; }
      e.preventDefault();
    }

    /* ---- VR 播放模式选择（FLAT / 分屏 / 180° / 360° 等） ---- */
    var vrProjBtn = document.getElementById('vrProjBtn');
    var vrProjSheet = document.getElementById('vrProjSheet');
    var vrProjList = document.getElementById('vrProjList');

    function paintVrMode() {
      var m = curVrMode();
      // 窄按钮用短标签（FLAT / 180° / 360·3D），并把完整模式与说明放进 title
      if (vrProjBtn) {
        vrProjBtn.textContent = m.short || m.label;
        vrProjBtn.title = 'VR 播放模式：' + m.label + '（' + m.desc + '）';
      }
      if (moreVrBtn) {
        moreVrBtn.textContent = m.short || m.label;
        moreVrBtn.title = 'VR 播放模式：' + m.label + '（' + m.desc + '）';
      }
      if (vrModeBtn) {
        vrModeBtn.textContent = m.label;
        vrModeBtn.title = '选择 VR 播放模式（当前：' + m.label + '）';
      }
      if (vrProjList) {
        var items = vrProjList.querySelectorAll('.vr-proj-item');
        for (var i = 0; i < items.length; i++) {
          items[i].classList.toggle('on', Number(items[i].dataset.i) === vrModeIndex);
        }
      }
    }

    function buildVrProjList() {
      if (!vrProjList || vrProjList.dataset.built === '1') return;
      vrProjList.dataset.built = '1';
      VR_MODES.forEach(function(m, i) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'vr-proj-item';
        b.dataset.i = String(i);
        b.innerHTML = '<span class="vr-proj-name">' + m.label + '</span>' +
                      '<span class="vr-proj-desc">' + m.desc + '</span>';
        b.addEventListener('click', function() {
          vrModeIndex = i;
          try { localStorage.setItem(VR_MODE_KEY, m.id); } catch (e) {}
          paintVrMode();
          closeVrProjSheet();
          vrShowUI();
        });
        vrProjList.appendChild(b);
      });
      paintVrMode();
    }

    function openVrProjSheet() {
      buildVrProjList();
      if (vrProjSheet) vrProjSheet.classList.add('on');
      vrShowUI();
    }
    function closeVrProjSheet() {
      if (vrProjSheet) vrProjSheet.classList.remove('on');
    }

    /* ───「更多」面板（紧凑模式下收纳音量 / 播放模式 / 倍速 / VR 播放模式） ───
       与控制栏一起淡入淡出：面板本身在 #controls 内部，控制栏隐藏时它跟着隐藏。 */
    function moreOpen() { return !!(moreSheet && moreSheet.classList.contains('on')); }
    function openMore() {
      if (!moreSheet) return;
      closeVrProjSheet();                 // 两个浮层互斥，叠着会互相挡住
      moreSheet.classList.add('on');
      showUI();
    }
    function closeMore() { if (moreSheet) moreSheet.classList.remove('on'); }
    function toggleMore() { if (moreOpen()) closeMore(); else openMore(); }
    if (moreBtn) moreBtn.onclick = function () { toggleMore(); };
    if (moreSheet) {
      moreSheet.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      document.addEventListener('pointerdown', function (e) {
        if (!moreOpen()) return;
        if (moreSheet.contains(e.target)) return;
        if (moreBtn && e.target === moreBtn) return;      // 按钮自己会切，别在这关掉
        closeMore();
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && moreOpen()) closeMore();
    });
    applyCompact();                        // 首次测量按钮行是否放得下

    if(vrBtn) vrBtn.onclick=enterVR;
    if(vrExitBtn) vrExitBtn.onclick=exitVR;
    if(vrProjBtn) vrProjBtn.onclick=openVrProjSheet;
    if(moreVrBtn) moreVrBtn.onclick=function(){ closeMore(); openVrProjSheet(); };
    // VR 沉浸时的工具栏按钮：同一个浮层（沉浸时控制栏是隐藏的）
    if(vrModeBtn) vrModeBtn.onclick=openVrProjSheet;
    if(vrProjSheet) vrProjSheet.addEventListener('click', function(e){
      if(e.target && e.target.dataset && e.target.dataset.vrclose !== undefined) closeVrProjSheet();
    });
    buildVrProjList();
    if(vrCamBtn) vrCamBtn.onclick=function(){
      if(vrCam==='gyro' && vrGyroReady){ vrCam='touch'; vrCamBtn.textContent='触摸'; }
      else if(vrCam==='touch'){ vrCam='gyro'; vrCamBtn.textContent='陀螺仪'; }
      else { vrCamBtn.textContent = vrGyroReady?'陀螺仪':'无陀螺'; }
      vrShowUI();
    };
    if(vrDistBtn) vrDistBtn.onclick=function(){
      vrDistIndex=(vrDistIndex+1)%vrDistPresets.length;
      vrDist=vrDistPresets[vrDistIndex];
      vrDistBtn.textContent='畸变·'+['无','弱','中'][vrDistIndex];
      vrShowUI();
    };
    // VR 模式下轻点屏幕唤出工具栏
    document.addEventListener('pointerdown', function(){ if(vrActive) vrShowUI(); });
    // 系统手势退出全屏时，同步退出 VR 模式
    document.addEventListener('fullscreenchange', function(){
        if(vrActive && !document.fullscreenElement) exitVR();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', function(e) {
        if (e.code === 'Space' || e.key === 'k') { e.preventDefault(); V.paused ? V.play() : V.pause(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); seekBy(-SEEK_STEP); }
        if (e.key === 'ArrowRight') { e.preventDefault(); seekBy(SEEK_STEP); }
        if (e.key === 'ArrowUp') { e.preventDefault(); V.volume = Math.min(1, V.volume + .1); volSlider.value = V.volume; }
        if (e.key === 'ArrowDown') { e.preventDefault(); V.volume = Math.max(0, V.volume - .1); volSlider.value = V.volume; }
        if (e.key === 'f') { fsBtn.click(); }
        // 紧凑模式下 volBtn 已经变成「更多」入口，m 键仍要能静音（不能走 volBtn.click）
        if (e.key === 'm') { toggleMute(); }
    });

    /* ===== 脚本编辑模式（?manualrec=1） =====
       在完整播放器页上直接录制 L0 轨迹：右侧滑块控制、左下角波形预览、
       录制前可调倍速与范围，保存后跳转回脚本编辑面板。 */
    if (IS_MANUALREC) {
        (function initManualRecord() {
            var mrOverlay = document.getElementById('mrOverlay');
            var mrBack = document.getElementById('mrBack');
            var mrRecToggle = document.getElementById('mrRecToggle');
            var mrSlider = document.getElementById('mrSlider');
            var mrSliderVal = document.getElementById('mrSliderVal');
            var mrSliderFill = document.getElementById('mrSliderFill');
            var mrWave = document.getElementById('mrWave');
            var mrRecDot = document.getElementById('mrRecDot');
            var mrRecTime = document.getElementById('mrRecTime');
            var mrRecInfo = document.querySelector('.mr-recinfo');
            var mrHint = document.getElementById('mrHint');
            // mrSettings 弹窗已删除（设置平铺到顶栏），保留占位避免历史引用报错
            var mrSave = document.getElementById('mrSave');
            var mrToast = document.getElementById('mrToast');
            if (!mrOverlay) return;

            var waveCtx = mrWave ? mrWave.getContext('2d') : null;

            var recording = false;
            var actions = [];
            var curL0 = 50;
            var lastSentL0 = null;
            var sendTimer = null;
            var recTimer = null;
            var recStartAt = 0;
            var selectedRate = 1;
            var selectedRange = 'full';
            var videoUri = MANUALREC_URI;
            var videoNameBase = String(displayTitle || '脚本编辑').replace(/\.[^.]+$/, '');

            function clamp(v) { return Math.max(0, Math.min(100, v)); }
            function fmtDur(ms) {
                var s = Math.floor(ms / 1000);
                var m = Math.floor(s / 60);
                return (m < 10 ? '0' : '') + m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
            }

            function post(path, body) {
                return fetch(path, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body || {})
                }).then(function(r) { return r.json().catch(function() { return null; }); })
                  .catch(function() { return null; });
            }

            function toast(text, isErr, holdMs) {
                if (!mrToast) return;
                mrToast.textContent = text;
                mrToast.className = 'mr-toast' + (isErr ? ' err' : '');
                mrToast.style.display = 'block';
                clearTimeout(mrToast._t);
                mrToast._t = setTimeout(function() { mrToast.style.display = 'none'; }, holdMs || 4000);
            }

            function setL0(pct, sendNow) {
                curL0 = clamp(pct);
                if (mrSliderVal) mrSliderVal.textContent = Math.round(curL0) + '%';
                if (mrSliderFill) mrSliderFill.style.height = curL0 + '%';
                if (mrSlider) mrSlider.style.setProperty('--mr-thumb', String(curL0) + '%');
                scheduleSendL0(sendNow);
                if (recording) drawWave();
            }

            function scheduleSendL0(now) {
                if (curL0 === lastSentL0) return;
                if (now) { flushL0(); return; }
                if (sendTimer) return;
                sendTimer = setTimeout(function() { sendTimer = null; flushL0(); }, 80);
            }
            function flushL0() {
                if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
                if (curL0 === lastSentL0) return;
                var pos = Math.round(curL0 * 99.99);
                var lr = Math.round(50 * 99.99);
                post('/api/osr/send', {
                    axes: [{ axis: 'R0', pos: lr }, { axis: 'R1', pos: lr }, { axis: 'L0', pos: pos }],
                    durationMs: 120
                });
                lastSentL0 = curL0;
            }

            function bindSlider() {
                if (!mrSlider) return;
                var dragging = false;
                function updateFromClientY(clientY) {
                    var rect = mrSlider.getBoundingClientRect();
                    var pad = 18;
                    var h = rect.height - pad * 2;
                    if (h < 1) h = 1;
                    var y = clientY - rect.top - pad;
                    setL0(100 - clamp(y / h * 100), false);
                }
                mrSlider.addEventListener('pointerdown', function(ev) {
                    dragging = true;
                    try { mrSlider.setPointerCapture(ev.pointerId); } catch (e) {}
                    updateFromClientY(ev.clientY);
                });
                mrSlider.addEventListener('pointermove', function(ev) {
                    if (!dragging) return;
                    updateFromClientY(ev.clientY);
                });
                var up = function() {
                    if (!dragging) return;
                    dragging = false;
                    flushL0();
                };
                mrSlider.addEventListener('pointerup', up);
                mrSlider.addEventListener('pointercancel', up);
            }

            function sampleAt(t) {
                if (actions.length === 0) return curL0;
                if (t <= actions[0].at) return actions[0].y;
                if (t >= actions[actions.length - 1].at) return actions[actions.length - 1].y;
                for (var i = 1; i < actions.length; i++) {
                    if (t <= actions[i].at) {
                        var p0 = actions[i - 1], p1 = actions[i];
                        var r = (t - p0.at) / (p1.at - p0.at);
                        return p0.y + (p1.y - p0.y) * r;
                    }
                }
                return actions[actions.length - 1].y;
            }

            function drawWave() {
                if (!waveCtx || !mrWave) return;
                // 波形按底部条实测宽度重算画布（横竖屏切换后不能再拉伸变形）
                var cw = Math.max(80, Math.round(mrWave.clientWidth || 0) || mrWave.width);
                var ch = Math.max(32, Math.round(mrWave.clientHeight || 0) || mrWave.height);
                var dpr = Math.min(2, window.devicePixelRatio || 1);
                var pw = Math.round(cw * dpr), ph = Math.round(ch * dpr);
                if (mrWave.width !== pw || mrWave.height !== ph) { mrWave.width = pw; mrWave.height = ph; }
                waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
                var w = cw, h = ch;
                waveCtx.clearRect(0, 0, w, h);
                if (actions.length < 1) return;
                var start = actions[0].at;
                var end = recording ? Math.max(actions[actions.length - 1].at, getTimeMs() - recStartAt) : actions[actions.length - 1].at;
                var dur = end - start;
                if (dur < 200) dur = 200;
                waveCtx.strokeStyle = '#f87171';
                waveCtx.lineWidth = 2;
                waveCtx.lineCap = 'round';
                waveCtx.lineJoin = 'round';
                waveCtx.beginPath();
                for (var i = 0; i <= w; i += 2) {
                    var t = start + (i / w) * dur;
                    var yy = h - (sampleAt(t) / 100) * h;
                    if (i === 0) waveCtx.moveTo(i, yy);
                    else waveCtx.lineTo(i, yy);
                }
                waveCtx.stroke();
            }

            function getTimeMs() {
                try { return Math.round((V && V.currentTime || 0) * 1000); } catch (e) { return 0; }
            }

            var mrResume = false;   // 保存弹窗点「取消」后继续录制：不清空已有轨迹，接着采样
            var saveRetryPending = false;   // 保存因缺写授权被拒（needGrant），授权回来后自动重存一次
            var mrFolderUri = '';          // 已选/刚授权的保存目录（SAF 树 URI），保存时一并带上
            function mrReadFolderUri() {
                try { return mrFolderUri || localStorage.getItem('tpFolderUri') || ''; }
                catch (e) { return mrFolderUri; }
            }
            function startRecording() {
                if (recording) return;
                if (!mrResume) actions = [{ at: 0, x: 50, y: Math.round(curL0) }];
                mrResume = false;
                recording = true;
                recStartAt = getTimeMs();
                if (mrRecToggle) { mrRecToggle.textContent = '■ 停止'; mrRecToggle.classList.add('recording'); }
                if (mrRecDot) mrRecDot.style.display = '';
                if (mrRecInfo) mrRecInfo.classList.add('recording');
                if (mrHint) mrHint.style.display = 'none';
                // 关闭同步、停止脚本/自动模式，避免和手动指令抢串口
                post('/api/osr/sync', { enabled: false });
                post('/api/osr/playmode', { mode: 'stop' });
                // 应用录制设置
                try {
                    if (selectedRange === 'full') V.currentTime = 0;
                    V.playbackRate = selectedRate;
                    V.play();
                } catch (e) {}
                recTimer = setInterval(function() {
                    var at = getTimeMs() - recStartAt;
                    if (at < 0) at = 0;
                    if (mrRecTime) mrRecTime.textContent = fmtDur(at);
                    var y = Math.round(curL0);
                    if (actions.length === 0 || actions[actions.length - 1].y !== y) {
                        actions.push({ at: at, x: 50, y: y });
                    }
                    drawWave();
                    // 到片尾自动停
                    try {
                        if (V.ended || (V.duration && V.currentTime >= V.duration - 0.05)) stopRecording();
                    } catch (e) {}
                }, 100);
            }

            function stopRecording() {
                if (!recording) return;
                recording = false;
                if (recTimer) { clearInterval(recTimer); recTimer = null; }
                if (mrRecToggle) { mrRecToggle.textContent = '● 录制'; mrRecToggle.classList.remove('recording'); }
                if (mrRecDot) mrRecDot.style.display = 'none';
                if (mrRecInfo) mrRecInfo.classList.remove('recording');
                try { V.pause(); } catch (e) {}
                if (actions.length < 2) {
                    actions = [];
                    toast('录制时长太短，已丢弃', true);
                    if (mrHint) mrHint.style.display = '';
                    return;
                }
                openSaveBox();
            }

            function openSaveBox() {
                if (!mrSave) return;
                var d = new Date();
                function z(n) { return (n < 10 ? '0' : '') + n; }
                var def = videoNameBase + '_' + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '_' + z(d.getHours()) + z(d.getMinutes());
                var el = document.getElementById('mrSaveName');
                if (el) el.value = def;
                var hint = document.getElementById('mrSaveHint');
                if (hint) {
                    var saved = mrReadFolderUri();
                    hint.textContent = videoUri ? '优先保存到视频所在文件夹；无写授权时改存' +
                        (saved ? '到你已选的目录' : '到应用私有目录') + '（与视频同名即可随播自动加载）'
                        : '将保存到应用私有目录';
                }
                mrSave.style.display = 'flex';
            }

            function doSave() {
                var el = document.getElementById('mrSaveName');
                var name = el ? el.value.trim() : '';
                if (!name) { toast('请输入脚本名称', true); return; }
                if (actions.length < 2) { toast('没有可保存的轨迹', true); return; }
                var btn = document.getElementById('mrDoSave');
                if (btn) btn.disabled = true;
                post('/api/osr/touchpad-save', {
                    name: name,
                    videoUri: videoUri,
                    folderUri: mrReadFolderUri(),
                    grantUri: mrFolderUri,
                    actions: actions
                }).then(function(d) {
                    if (btn) btn.disabled = false;
                    if (d && d.ok) {
                        if (d.note) toast(d.note + '；与视频同名即可随播自动加载', true, 7000);
                        else toast('已保存到视频所在文件夹，' + (d.count || actions.length) + ' 个采样点', false, 4000);
                        if (mrSave) mrSave.style.display = 'none';
                        actions = [];
                        drawWave();
                    } else if (d && d.needGrant) {
                        // 视频所在文件夹还没有可写树授权：发起系统目录选择（已预定位到视频所在目录），
                        // 用户点「使用此文件夹」后原生回调 __onGrantFolder，自动重存一次。
                        saveRetryPending = true;
                        toast('需要一次写授权：即将弹出文件夹窗口，直接点「使用此文件夹」即可', false, 6000);
                        if (window.Orbit && typeof window.Orbit.grantRecordFolder === 'function') {
                            window.Orbit.grantRecordFolder();
                        } else {
                            saveRetryPending = false;
                            toast('当前环境无法发起授权', true, 5000);
                        }
                    } else {
                        toast('保存失败：' + ((d && d.detail) || d.error || '未知错误'), true, 5000);
                    }
                }).catch(function() {
                    if (btn) btn.disabled = false;
                    toast('保存失败：网络错误', true, 5000);
                });
            }

            function discardRecording() {
                actions = [];
                if (mrSave) mrSave.style.display = 'none';
                toast('已丢弃本次录制', false, 3000);
                drawWave();
            }

            // 录制设置弹窗已取消：倍速 / 范围平铺在顶栏，点击即时生效
            function selectPill(group, val, cb) {
                if (!group) return;
                var btns = group.querySelectorAll('.mr-pill');
                for (var i = 0; i < btns.length; i++) {
                    var b = btns[i];
                    var match = b.getAttribute('data-rate') === val || b.getAttribute('data-range') === val;
                    b.classList.toggle('active', match);
                }
                if (cb) cb(val);
            }

            if (mrRecToggle) mrRecToggle.addEventListener('click', function() {
                // 设置已平铺到顶栏：录制按钮直接开始 / 停止，不再经过设置弹窗
                if (recording) stopRecording(); else startRecording();
            });
            if (mrBack) mrBack.addEventListener('click', function() {
                try { location.href = '/?panel=' + encodeURIComponent(MANUALREC_RETURN); } catch (e) {}
            });
            var mrSpeeds = document.getElementById('mrSpeeds');
            var mrRanges = document.getElementById('mrRanges');
            if (mrSpeeds) {
                mrSpeeds.addEventListener('click', function(e) {
                    var b = e.target.closest('.mr-pill'); if (!b) return;
                    // 倍速点击立即应用到播放，不必等「开始录制」
                    selectPill(mrSpeeds, b.getAttribute('data-rate'), function(v) {
                        selectedRate = parseFloat(v);
                        try { V.playbackRate = selectedRate; } catch (e2) {}
                    });
                });
            }
            if (mrRanges) {
                mrRanges.addEventListener('click', function(e) {
                    var b = e.target.closest('.mr-pill'); if (!b) return;
                    selectPill(mrRanges, b.getAttribute('data-range'), function(v) { selectedRange = v; });
                });
            }
            var mrDiscard = document.getElementById('mrDiscard');
            var mrDoSave = document.getElementById('mrDoSave');
            if (mrDiscard) mrDiscard.addEventListener('click', discardRecording);
            if (mrDoSave) mrDoSave.addEventListener('click', doSave);
            // 保存弹窗「取消」：关弹窗、保留已录轨迹并立即接着录
            var mrCancelSave = document.getElementById('mrCancelSave');
            if (mrCancelSave) mrCancelSave.addEventListener('click', function() {
                if (mrSave) mrSave.style.display = 'none';
                if (actions && actions.length > 1) { mrResume = true; startRecording(); }
            });
            // 目录授权回来后自动重存一次（needGrant 流程）。
            // v2.7.16：不少 ROM 会把「持久化」的写授权拿掉、只给本次会话的临时写权限，
            // 此时 writable=false 也就是「未持久化」，但此刻照样能写 —— 那就照样存到这个目录，
            // 不再一句「授权未获得写权限」把用户打发回应用目录。
            window.__onGrantFolder = function(uri, writable) {
                if (!saveRetryPending) return;
                saveRetryPending = false;
                mrFolderUri = uri ? String(uri) : '';
                if (!mrFolderUri) {
                    toast('没有选到目录，仍改存到应用目录', true, 5000);
                    doSave();
                    return;
                }
                toast(writable ? '授权成功，正在保存…' : '目录已就绪（临时写权限），正在保存…', false, 4000);
                doSave();
            };

            // 离开页面前回中、停止同步、恢复竖屏
            function cleanupManualRec() {
                try { if (window.OrbitPlayer && window.OrbitPlayer.setFullscreen) window.OrbitPlayer.setFullscreen(false); } catch (e) {}
                try { post('/api/osr/sync', { enabled: false }); } catch (e) {}
                try { post('/api/osr/playmode', { mode: 'stop' }); } catch (e) {}
                try { post('/api/osr/reset'); } catch (e) {}
                if (recTimer) { clearInterval(recTimer); recTimer = null; }
            }
            window.addEventListener('beforeunload', cleanupManualRec);
            window.addEventListener('pagehide', cleanupManualRec);

            // 初始化
            // 脚本编辑页始终走「横屏全屏」（隐藏系统栏）。视频由原生播放器信箱式保比例渲染：
            //   · 横屏视频 → 铺满全屏；
            //   · 竖屏视频 → 按原视频比例居中显示（两侧留黑边），不铺满、不旋转成竖屏全屏（v2.7.37 修正）。
            mrOverlay.style.display = '';
            try { if (window.OrbitPlayer && window.OrbitPlayer.setFullscreen) window.OrbitPlayer.setFullscreen(true); } catch (e) {}
            window.addEventListener('resize', drawWave);
            bindSlider();
            setL0(50, true);
            drawWave();
            // 加载失败要看得见：否则用户只看到黑屏，无从判断卡在哪一级（取流 404 / 编码不支持 / 权限）。
            var mrHintEl = document.getElementById('mrHint');
            var mrFailed = false;
            function mrFail(msg) {
                mrFailed = true;
                if (mrHintEl) {
                    mrHintEl.textContent = '视频加载失败：' + msg;
                    mrHintEl.style.color = '#ff6b6b';
                    mrHintEl.style.display = '';
                }
            }
            try {
                V.addEventListener('error', function () {
                    var e = V && V.error;
                    mrFail((e && e.message) || '该视频无法解码或路径不可读');
                });
            } catch (e) {}
            // 兜底：8 秒内既没 ready 也没进度，多半是取流被拒（docId 解析失败 / 无读权限）。
            setTimeout(function () {
                if (mrFailed) return;
                var t = 0, ok = false;
                try { t = V.currentTime || 0; } catch (e) {}
                try { ok = !!(window.OrbitPlayer && JSON.parse(window.OrbitPlayer.state() || '{}').ready); } catch (e2) {}
                if (!ok && t === 0) mrFail('视频源未就绪（可能是文件权限或路径解析失败）');
            }, 8000);
        })();
    }

    function cleanupSync() {
        if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
        // 原生播放器挂在 Application 上，离开播放页必须显式收掉，否则视频层会残留在别的页面上
        if (useNative) { try { window.OrbitPlayer.release(); } catch (e) { } }
        // 离开播放页把「一键冲刺」收回去：倍率存在后端设置里，留着会连累别的页面
        applyDash(false);
        // 生成任务是全局单例 ScriptRecorder，页面销毁了它还在跑：
        // ① 白耗几分钟 CPU 与电量；② 用户立刻打开下一部视频时，那边的 start 会被
        // already_running 怼回来。所以离开播放页必须把「自己的」任务收掉 ——
        // 带 id 是为了不误杀「AI生成脚本」页用户手动发起的生成。
        if (genTimer) { clearTimeout(genTimer); genTimer = null; }
        if ((genState === 'starting' || genState === 'running') && genId) {
            try {
                // keepalive：beforeunload 阶段的普通 fetch 可能被浏览器丢弃
                fetch('/api/osr/funscript-gen/cancel', {
                    method: 'POST', keepalive: true,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: genId })
                }).catch(function () { });
            } catch (e) { }
        }
        genState = ''; genKeyFor = ''; genId = ''; genLastPoints = null;
        // 页面真正卸载：通知后端停止播放时钟（OSR 设备停止驱动）
        fetch('/api/osr/playback-time', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playing: false, timeMs: Math.round(V.currentTime * 1000) })
        }).catch(function() {});
    }
    window.addEventListener('beforeunload', cleanupSync);
    window.addEventListener('pagehide', cleanupSync);
    // 切后台不再停 OSR 驱动：设备同步已由后端按系统时钟自驱，与页面可见性无关
})();
