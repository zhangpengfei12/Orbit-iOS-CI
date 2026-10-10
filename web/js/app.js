(function() {
'use strict';

// ─── Helpers ────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }
function $$(sel, root) { return (root || document).querySelectorAll(sel); }

function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function readStorageJson(key, fallback) {
    try {
        var raw = localStorage.getItem(STORAGE_PREFIX + key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
        return fallback;
    }
}

function writeStorageJson(key, value) {
    try {
        localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    } catch (e) {}
}

var currentDetailId = null;
var currentDetailData = null;
var thumbnailRefreshToken = '';
var favoriteItems = {};
var deovrPollTimer = null;
var activeStreamHint = '';
var STORAGE_PREFIX = 'orbit.web.';
var scanPollingStarter = null;

// ─── 平台判定 ──────────────────────────────────────────────
// 这个项目原本是安卓工程，前端里有一批「只有安卓原生管线才撑得住」的功能，
// 典型的就是「AI 生成脚本」——要解码整段视频做运动分析，iOS 侧根本没有这段管线。
// 这类接口在 iOS 上只能返回未实现，如果前端照旧把面板摆成可用，
// 用户点下去就是「永远转圈 / 假进度」，比直接说不支持更让人困惑。
// 故这里判定平台，让前端主动把这类功能降级并说明替代路径。
function orbitPlatformSync() {
    try {
        if (window.Orbit && typeof window.Orbit.platform === 'function') {
            var p = window.Orbit.platform();
            if (typeof p === 'string' && p) return p;
        }
    } catch (e) {}
    return '';
}
var ORBIT_PLATFORM = orbitPlatformSync();

/** 是否 iOS：原生桥自报 ios，或 /api/status 自报 ios（浏览器里访问同样生效）。
 *  安卓没有 Orbit.platform()（桥的兜底调用返回 undefined），自然判定为非 iOS。 */
function orbitIsIOS() {
    return ORBIT_PLATFORM === 'ios' || window.__orbitPlatform === 'ios';
}

/** 所有「平台相关门面开关」统一入口；拿到 /api/status 后再调一次以覆盖异步场景。 */
function applyPlatformGates() {
    recApplyPlatformGate();
    vrbtApplyPlatformGate();
}

function itemPosterSrc(id) {
    var src = '/api/items/' + id + '/poster';
    return thumbnailRefreshToken ? src + '?v=' + encodeURIComponent(thumbnailRefreshToken) : src;
}

function actorThumbSrc(name) {
    var src = '/api/actor-thumb/' + encodeURIComponent(name || '');
    return thumbnailRefreshToken ? src + '?v=' + encodeURIComponent(thumbnailRefreshToken) : src;
}

function updateFavoriteButton() {
    var btn = $('btnFavorite');
    if (!btn) return;
    var isFavorite = currentDetailData
        ? !!currentDetailData.isFavorite
        : (currentDetailId != null && !!favoriteItems[currentDetailId]);
    btn.classList.toggle('is-favorite', isFavorite);
    btn.title = isFavorite ? '\u53d6\u6d88\u6536\u85cf' : '\u6536\u85cf';
}

function showHint(el) {
    el.classList.add('show');
    setTimeout(function() { el.classList.remove('show'); }, 2000);
}

function bindImageFallbacks(root) {
    $$('img[data-hide-on-error]', root).forEach(function(img) {
        if (img.dataset.fallbackBound === '1') return;
        img.dataset.fallbackBound = '1';
        img.addEventListener('load', function() {
            img.classList.remove('loading');
        });
        img.addEventListener('error', function() {
            img.style.display = 'none';
        });
        if (img.complete && img.naturalWidth > 0) {
            img.classList.remove('loading');
        }
    });
}

// ─── Browser Detection ──────────────────────────────────────

var browserType = (function() {
    var ua = navigator.userAgent;
    if (/DeoVR/i.test(ua)) return 'deovr';
    if (/PicoBrowser|\bPICO\b|\bPico\b|PICO\s*4|Pico\s*4/i.test(ua)) return 'pico';
    if (/OculusBrowser|Quest/i.test(ua)) return 'oculus';
    if (/Wolvic/i.test(ua)) return 'wolvic';
    // ⚠ iPad 必须先判：iPadOS 13+ 的 UA 伪装成 "Macintosh"（既无 iPad 也无 Mobile 字样），
    //   漏了这条 iPad 会被判成 desktop，分页条数与触摸向样式全部按桌面来。
    if (/iPad|iPhone|iPod/i.test(ua)) return 'mobile';
    if (/Android|Mobile/i.test(ua)) return 'mobile';
    if (/Edg|Chrome|CriOS|Firefox|FxiOS|Safari|Windows NT|Macintosh|Linux x86_64/i.test(ua)) return 'desktop';
    return 'deovr';
})();

function isVrBrowserType(type) {
    return type === 'deovr' || type === 'pico' || type === 'oculus' || type === 'wolvic';
}

function normalizeStreamHint(value) {
    var hint = String(value || '').toLowerCase();
    return hint === 'deovr' || hint === 'heresphere' || hint === 'browser' ? hint : '';
}

function streamHintFromConnectionStatus(d) {
    var hint = normalizeStreamHint(d && d.streamHint);
    if (hint) return hint;
    var mode = String((d && (d.mode || d.deovrConnectionMode)) || '').toUpperCase();
    if (mode === 'HERESPHERE') return 'heresphere';
    if (mode === 'DEOVR') return 'deovr';
    var status = String((d && (d.status || d.deovrConnectionStatus)) || '').toUpperCase();
    if (status !== 'CONNECTED') return 'browser';
    return 'browser';
}

function syncActiveStreamHint(d) {
    var hint = streamHintFromConnectionStatus(d);
    if (!hint || hint === activeStreamHint) return;
    activeStreamHint = hint;
    if (currentDetailData) {
        currentDetailData.streamHint = hint;
        refreshCurrentDetailPlayLinks();
    }
}

function effectiveStreamHint(detail) {
    return activeStreamHint || (detail && normalizeStreamHint(detail.streamHint)) || 'browser';
}

function isHereSpherePlaybackActive() {
    return effectiveStreamHint(currentDetailData) === 'heresphere';
}

document.body.classList.add('browser-' + browserType);
if (isVrBrowserType(browserType)) {
    document.body.classList.add('browser-vr');
}

// ─── Pagination Helpers ──────────────────────────────────────

function getRowsPerPage() {
    var w = window.innerWidth;
    // VR 头显浏览器：空间有限，保持紧凑
    if (isVrBrowserType(browserType)) {
        return w >= 1200 ? 5 : 4;
    }
    // 手机/平板浏览器
    if (browserType === 'mobile') {
        return w >= 900 ? 5 : 4;
    }
    // PC 桌面浏览器：大屏多显示
    if (w >= 1600) return 7;
    if (w >= 1200) return 6;
    if (w >= 900) return 5;
    return 4;
}

function getGridColumns(gridEl) {
    if (!gridEl) return 6; // fallback
    if (!gridEl.offsetParent) return 6;
    var template = getComputedStyle(gridEl).gridTemplateColumns;
    var columns = template.split(' ').filter(Boolean).length;
    return columns > 1 ? columns : 6;
}

function getItemsPerPage(gridEl) {
    return getGridColumns(gridEl) * getRowsPerPage();
}

function getTotalPages(totalItems, itemsPerPage) {
    return Math.max(1, Math.ceil(totalItems / itemsPerPage));
}

function getPageSlice(allItems, page, itemsPerPage) {
    var start = (page - 1) * itemsPerPage;
    return allItems.slice(start, start + itemsPerPage);
}

function clampPage(page, totalPages) {
    return Math.max(1, Math.min(page, totalPages));
}

function renderPaginationControls(containerId, currentPage, totalPages, onChangeCallback) {
    var container = $(containerId);
    if (!container) return;
    if (totalPages <= 1) {
        container.style.display = 'none';
        return;
    }
    container.style.display = '';
    var prevDisabled = currentPage <= 1 ? ' disabled' : '';
    var nextDisabled = currentPage >= totalPages ? ' disabled' : '';
    var isInline = container.classList.contains('pagination-inline');
    var btnClass = isInline ? 'pagination-icon-btn' : 'pagination-btn';

    var prevBtnHtml = isInline
        ? '<button class="' + btnClass + prevDisabled + '" data-page="prev"><img class="mi" src="/icons/arrow_back_128dp.png" alt="上一页"></button>'
        : '<button class="' + btnClass + prevDisabled + '" data-page="prev"><img class="mi" src="/icons/arrow_back_128dp.png" alt=""> 上一页</button>';

    var nextBtnHtml = isInline
        ? '<button class="' + btnClass + nextDisabled + '" data-page="next"><img class="mi" src="/icons/chevron_right_128dp.png" alt="下一页"></button>'
        : '<button class="' + btnClass + nextDisabled + '" data-page="next">下一页 <img class="mi" src="/icons/chevron_right_128dp.png" alt=""></button>';

    container.innerHTML =
        prevBtnHtml +
        '<span class="pagination-info">第 ' + currentPage + ' / ' + totalPages + ' 页</span>' +
        nextBtnHtml;

    var prevBtn = container.querySelector('[data-page="prev"]');
    var nextBtn = container.querySelector('[data-page="next"]');
    if (prevBtn && !prevBtn.classList.contains('disabled')) {
        prevBtn.addEventListener('click', function() {
            if (currentPage > 1) onChangeCallback(currentPage - 1);
        });
    }
    if (nextBtn && !nextBtn.classList.contains('disabled')) {
        nextBtn.addEventListener('click', function() {
            if (currentPage < totalPages) onChangeCallback(currentPage + 1);
        });
    }
}

// ─── Tab Switching ──────────────────────────────────────────

var tabInited = {};
var refreshSettingsOnShow = null;
// 设置页分区切换（原侧栏逻辑），initSettings() 里赋值。
// 侧栏已隐藏，仅保留其事件里的副作用（扫描状态恢复 / 分析轮询）。
var showSettingsPanel = null;
var viewStack = [];

function currentViewState() {
    var activePane = document.querySelector('.tab-pane.active');
    var tab = activePane ? activePane.id.replace(/^pane-/, '') : 'home';
    return {
        tab: tab,
        detailId: currentDetailId,
        actorName: currentActorDetail ? currentActorDetail.name : null,
        homeFilter: homeFilter ? { type: homeFilter.type, value: homeFilter.value } : null
    };
}

function pushCurrentView() {
    viewStack.push(currentViewState());
    if (viewStack.length > 20) viewStack.shift();
}

function restoreViewState(state) {
    if (!state) return false;
    if (state.tab === 'detail' && state.detailId != null) {
        showItemDetail(state.detailId, false);
        return true;
    }
    if (state.tab === 'actor-detail' && state.actorName) {
        showActorDetailByName(state.actorName, false, false);
        return true;
    }
    if (state.tab === 'home' && state.homeFilter) {
        if (state.homeFilter.type === 'actor') loadItemsByActor(state.homeFilter.value, false);
        else if (state.homeFilter.type === 'genre') searchByGenre(state.homeFilter.value, false);
        else activateTab('home');
        return true;
    }
    if (state.tab === 'home') {
        activateTab('home');
        if (!cachedVideos.length) loadHome();
        else renderHomePage();
        return true;
    }
    activateTab(state.tab || 'home');
    return true;
}

function navigateBack() {
    // 内嵌播放器正显示影片时，「返回」= 退出播放器回到首页，绝不能走 history.back()。
    // 原因：换片发生在 iframe 里，iframe 的会话历史与顶层是同一条 joint history，
    // history.back() 会被 iframe 吃掉、把播放器倒退到上一个视频，看上去就是退不出播放器。
    if (isLibPlayerActive()) { libExitInPage(); return; }
    if (viewStack.length > 0 && restoreViewState(viewStack.pop())) return;
    history.back();
}

function isAtHome() {
    if (isLibPlayerActive()) return false;
    var activePane = document.querySelector('.tab-pane.active');
    var tab = activePane ? activePane.id.replace(/^pane-/, '') : 'home';
    return tab === 'home';
}

/**
 * 原生右滑 / 返回键统一入口：返回 true 表示已在应用内消费（退出播放器或返回首页），
 * 原生不应再 finish；返回 false 表示已在首页，交由原生最小化。
 */
function handleBack() {
    if (isLibPlayerActive()) { libExitInPage(); return true; }
    if (viewStack.length > 0 && restoreViewState(viewStack.pop())) return true;
    // 只要浏览器历史还能后退（说明是从首页磁贴进来的二级页 / 库页），右滑 / 返回就 history.back()
    // 回首页磁贴，而不是最小化应用或停在库页。仅在「无任何历史可退」时才交给原生最小化。
    if (history.length > 1) { try { history.back(); } catch (e) {} return true; }
    if (!isAtHome()) { activateTab('home'); return true; }
    return false;
}

/** 内嵌播放器是否正显示着影片（「返回」据此判断该不该先退出播放器）。 */
function isLibPlayerActive() {
    var frame = $('libFrame');
    if (!frame || frame.style.display === 'none') return false;
    return !!libNowPlaying;
}

/** 退出内嵌播放器：收起播放卡、清掉片名，回到首页列表。 */
function libExitInPage() {
    // 内嵌播放器退出时同步通知原生层恢复竖屏，避免回到首页仍横屏
    try { if (window.OrbitPlayer) window.OrbitPlayer.setFullscreen(false); } catch (e) {}
    var frame = $('libFrame'), ph = $('libPlayerPh'), now = $('libNow');
    if (frame) {
        libFrameLoaded = false;
        libFrameBlanking = true;
        try {
            if (frame.contentWindow) frame.contentWindow.location.replace('about:blank');
            else frame.src = 'about:blank';
        } catch (e) { frame.src = 'about:blank'; }
        frame.style.display = 'none';
    }
    // 退出内嵌播放器：设备自动回中归位，避免停在最后运动位置造成「斜动」
    try { fetch('/api/osr/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(function(){}); } catch (e) {}
    libNowPlaying = '';
    libResetRatio();
    if (ph) ph.style.display = '';
    if (now) { now.textContent = ''; now.classList.remove('on'); now.style.display = 'none'; }
}

function activateTab(target) {
    // 「演员 / 收藏」导航入口已移除：历史状态恢复时退回首页，避免停留在无导航项的页面
    if (!document.querySelector('.tab-bar .tab-item[data-tab="' + target + '"]') &&
        (target === 'actors' || target === 'favorites')) {
        target = 'home';
    }
    $$('.tab-bar .tab-item').forEach(function(t) { t.classList.remove('active'); });
    $$('.tab-pane').forEach(function(p) { p.classList.remove('active'); });

    var tab = document.querySelector('.tab-bar .tab-item[data-tab="' + target + '"]');
    if (tab) tab.classList.add('active');

    var pane = $('pane-' + target);
    if (pane) pane.classList.add('active');

    // 详情页隐藏 tab 栏，其他页面显示
    var tabBar = document.querySelector('.tab-bar');
    if (tabBar) tabBar.style.display = (target === 'detail' || target === 'actor-detail' || target === 'btdevices') ? 'none' : '';

    // 顶栏已精简到只剩「返回」按钮，无需再同步任何图标高亮

    if (!tabInited[target]) {
        tabInited[target] = true;
        if (target === 'actors') initActors();
        if (target === 'favorites') initFavorites();
        if (target === 'folder') initFolder();
        if (target === 'category') initCategory();
        if (target === 'settings') initSettings();
    } else if (target === 'actors') {
        sortActorsForDisplay();
        renderActorsPage();
    } else if (target === 'favorites') {
        loadFavorites();
    }
    if (target === 'settings' && refreshSettingsOnShow) refreshSettingsOnShow();
    if (target !== 'detail' && target !== 'actor-detail' && target !== 'btdevices') savePersistentViewState(target);
}

$$('.tab-bar .tab-item[data-tab]').forEach(function(tab) {
    tab.addEventListener('click', function() {
        activateTab(tab.dataset.tab);
    });
});

// 顶栏只剩「返回」按钮（首页图标 / Logo / 搜索 / 设置齿轮已移除）
var btnNavBack = $('btnNavBack');
if (btnNavBack) btnNavBack.addEventListener('click', navigateBack);
var detailPoster = $('detailPoster');
if (detailPoster) detailPoster.addEventListener('click', playFromPoster);

// Sub-tabs
$$('.sub-tab[data-sub]').forEach(function(tab) {
    tab.addEventListener('click', function() {
        var target = tab.dataset.sub;
        $$('.sub-tab').forEach(function(t) { t.classList.remove('active'); });
        $$('.sub-pane').forEach(function(p) { p.classList.remove('active'); });
        tab.classList.add('active');
        var pane = $('sub-' + target);
        if (pane) pane.classList.add('active');
    });
});

// ─── Home Tab ───────────────────────────────────────────────

var homeRetryTimer = null;
var cachedItems = [];         // new API items; empty if old API is used
var cachedVideos = [];        // old format fallback
var currentCategory = 'all';
var homeCurrentPage = 1;
var homeTotalItems = 0;
var categoryCurrentPage = 1;
var useNewApi = false;
var homeApiPageDataCache = {};
var homeGridDomCache = {};
var currentHomeGridCacheKey = null;
var categoryDomCache = {};
var currentCategoryCacheKey = null;
var MAX_GRID_CACHE_PAGES = 6;
var persistedViewState = readStorageJson('viewState', null);
var homeRestoreState = persistedViewState || {};
var actorsList = [];
var actorsCurrentPage = 1;
var actorsLoaded = false;
var actorsDomCache = {};
var currentActorsCacheKey = null;
var actorClickCounts = readStorageJson('actorClicks', {});
var currentActorDetail = null;
var actorDetailItems = [];
var actorDetailCurrentPage = 1;
var actorEditPhotoData = '';
var editingLibraryId = 0;
var mediaLibraries = [];
var activeLibraryId = readStorageJson('activeLibraryId', 0) || 0;
var homeScope = 'all';
var homeSortMode = readStorageJson('homeSortMode', 'order') || 'order';
var favoriteCurrentPage = 1;
var favoriteTotalItems = 0;
var favoriteCachedItems = [];
var favoriteCachedVideos = [];
var favoriteApiPageDataCache = {};
var favoriteGridDomCache = {};
var currentFavoriteGridCacheKey = null;
var LIBRARY_PICKER_IDS = ['librarySelect', 'actorsLibrarySelect', 'favoritesLibrarySelect'];
var SORT_MODE_OPTIONS = [
    { id: 'order', label: '\u987a\u5e8f' },
    { id: 'random', label: '\u968f\u673a' },
    { id: 'rating', label: '\u8bc4\u5206' },
    { id: 'playCount', label: '\u8bbf\u95ee\u6b21\u6570' }
];
if (['order', 'random', 'rating', 'playCount'].indexOf(homeRestoreState.homeSortMode) >= 0) {
    homeSortMode = homeRestoreState.homeSortMode;
}

function clearGridCaches() {
    homeApiPageDataCache = {};
    homeGridDomCache = {};
    currentHomeGridCacheKey = null;
    favoriteApiPageDataCache = {};
    favoriteGridDomCache = {};
    currentFavoriteGridCacheKey = null;
    categoryDomCache = {};
    currentCategoryCacheKey = null;
    actorsDomCache = {};
    currentActorsCacheKey = null;
}

function libraryQueryParam() {
    return activeLibraryId ? ('&libraryId=' + encodeURIComponent(activeLibraryId)) : '';
}

function itemsListQueryParam(favoriteOnly) {
    var params = [];
    if (activeLibraryId) params.push('libraryId=' + encodeURIComponent(activeLibraryId));
    if (favoriteOnly || homeScope === 'favorite') params.push('favorite=1');
    if (homeSortMode) params.push('sort=' + encodeURIComponent(homeSortMode));
    return params.length ? '&' + params.join('&') : '';
}

function appendLibraryQuery(url) {
    return url + (activeLibraryId ? ((url.indexOf('?') >= 0 ? '&' : '?') + 'libraryId=' + encodeURIComponent(activeLibraryId)) : '');
}

function activeLibraryName() {
    for (var i = 0; i < mediaLibraries.length; i += 1) {
        if (String(mediaLibraries[i].id) === String(activeLibraryId)) return libraryDisplayName(mediaLibraries[i]);
    }
    return '全部媒体库';
}

function findLibraryById(id) {
    for (var i = 0; i < mediaLibraries.length; i += 1) {
        if (String(mediaLibraries[i].id) === String(id)) return mediaLibraries[i];
    }
    return null;
}

function rawLibraryPath(lib) {
    return (lib && (lib.path || lib.rootPath)) || '';
}

function safeDecodePath(value) {
    try {
        return decodeURIComponent(value);
    } catch (e) {
        return value;
    }
}

function formatSafLocalPath(rawPath) {
    var marker = '/tree/';
    var markerIndex = rawPath.indexOf(marker);
    if (markerIndex < 0) return safeDecodePath(rawPath);
    var documentId = rawPath.slice(markerIndex + marker.length).split(/[?#]/)[0];
    documentId = safeDecodePath(documentId);
    var volume = '';
    var relativePath = documentId;
    var colonIndex = documentId.indexOf(':');
    if (colonIndex >= 0) {
        volume = documentId.slice(0, colonIndex);
        relativePath = documentId.slice(colonIndex + 1);
    }
    relativePath = relativePath.replace(/^\/+/, '').replace(/\/+/g, '/');
    var prefix = volume && volume !== 'primary' ? ('本地 ' + volume) : '本地';
    return relativePath ? (prefix + ' / ' + relativePath) : (prefix + ' / 根目录');
}

function libraryDisplayPath(lib) {
    var rawPath = rawLibraryPath(lib);
    if (!rawPath) return '';
    if ((lib && lib.type === 'local') && rawPath.indexOf('content://') === 0) {
        return formatSafLocalPath(rawPath);
    }
    return safeDecodePath(rawPath);
}

function libraryDisplayName(lib) {
    if (lib && lib.name) return lib.name;
    var displayPath = libraryDisplayPath(lib);
    if (displayPath) {
        var cleanPath = displayPath.replace(/[\\\/]+$/, '');
        var parts = cleanPath.split(/[\\\/]/);
        var last = parts.length ? parts[parts.length - 1].trim() : '';
        if (last) return last;
    }
    return lib && lib.id ? ('媒体库 ' + lib.id) : '媒体库';
}

function syncLibrarySelects() {
    var value = String(activeLibraryId || 0);
    if (!mediaLibraries.some(function(lib) { return String(lib.id) === value; })) value = '0';
    var options = [{ id: '0', label: '全部媒体库' }].concat(mediaLibraries.map(function(lib) {
        return {
            id: String(lib.id),
            label: (lib.type === 'smb' ? 'SMB · ' : '本地 · ') + libraryDisplayName(lib)
        };
    }));
    var selected = options.find(function(opt) { return opt.id === value; }) || options[0];
    LIBRARY_PICKER_IDS.forEach(function(id) {
        var picker = $(id);
        if (!picker) return;
        if (picker.tagName === 'SELECT') {
            picker.innerHTML = options.map(function(opt) {
                return '<option value="' + escapeHtml(opt.id) + '">' + escapeHtml(opt.label) + '</option>';
            }).join('');
            picker.value = value;
            return;
        }
        var labelEl = picker.querySelector('[data-library-label]');
        var menuEl = picker.querySelector('[data-library-menu]');
        picker.dataset.value = value;
        if (labelEl) labelEl.textContent = selected.label;
        if (menuEl) {
            menuEl.innerHTML = options.map(function(opt) {
                var active = opt.id === value ? ' active' : '';
                return '<button class="library-picker-item' + active + '" type="button" data-library-value="' + escapeHtml(opt.id) + '">' + escapeHtml(opt.label) + '</button>';
            }).join('');
        }
    });
}

function closeLibraryPickers(exceptPicker) {
    LIBRARY_PICKER_IDS.forEach(function(id) {
        var picker = $(id);
        if (!picker || picker === exceptPicker || picker.tagName === 'SELECT') return;
        picker.classList.remove('is-open');
        var button = picker.querySelector('[data-library-label]');
        if (button) button.setAttribute('aria-expanded', 'false');
    });
}

function closeSortPickers(exceptPicker) {
    ['sortMode', 'favoritesSortMode'].forEach(function(id) {
        var picker = $(id);
        if (!picker || picker === exceptPicker || picker.tagName === 'SELECT') return;
        picker.classList.remove('is-open');
        var button = picker.querySelector('[data-sort-label]');
        if (button) button.setAttribute('aria-expanded', 'false');
    });
}

function bindLibrarySelects() {
    LIBRARY_PICKER_IDS.forEach(function(id) {
        var picker = $(id);
        if (!picker || picker.dataset.libraryBound === '1') return;
        picker.dataset.libraryBound = '1';
        if (picker.tagName === 'SELECT') {
            picker.addEventListener('change', function() {
                setActiveLibrary(picker.value, true);
            });
            return;
        }
        var button = picker.querySelector('[data-library-label]');
        var menu = picker.querySelector('[data-library-menu]');
        if (!button || !menu) return;
        button.addEventListener('click', function(e) {
            e.stopPropagation();
            var willOpen = !picker.classList.contains('is-open');
            closeSortPickers();
            closeLibraryPickers(willOpen ? picker : null);
            picker.classList.toggle('is-open', willOpen);
            button.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        });
        menu.addEventListener('click', function(e) {
            e.stopPropagation();
            var item = e.target.closest ? e.target.closest('[data-library-value]') : null;
            if (!item || !menu.contains(item)) return;
            closeLibraryPickers();
            setActiveLibrary(item.dataset.libraryValue, true);
        });
    });
    if (document.documentElement.dataset.libraryPickerBound !== '1') {
        document.documentElement.dataset.libraryPickerBound = '1';
        document.addEventListener('click', function() {
            closeLibraryPickers();
            closeSortPickers();
        });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                closeLibraryPickers();
                closeSortPickers();
            }
        });
    }
}

function setActiveLibrary(id, reload) {
    var nextId = parseInt(id || 0, 10) || 0;
    if (nextId === activeLibraryId && reload !== true) return;
    activeLibraryId = nextId;
    writeStorageJson('activeLibraryId', activeLibraryId);
    clearGridCaches();
    fetch('/api/libraries?active=' + encodeURIComponent(activeLibraryId)).catch(function() {});
    syncLibrarySelects();
    if (reload !== false) {
        homeCurrentPage = 1;
        favoriteCurrentPage = 1;
        actorsLoaded = false;
        actorsList = [];
        loadHome();
        if (isActiveTab('favorites')) loadFavorites();
        if (isActiveTab('actors')) loadActors();
        if (isActiveTab('category')) renderCategory();
        loadLibraryStats();
    }
}

function loadLibraries() {
    return fetch('/api/libraries')
        .then(function(r) { return r.json(); })
        .then(function(d) {
            mediaLibraries = d.libraries || [];
            if (d.activeLibraryId != null && !activeLibraryId) activeLibraryId = d.activeLibraryId || 0;
            if (activeLibraryId && !mediaLibraries.some(function(lib) { return String(lib.id) === String(activeLibraryId); })) {
                activeLibraryId = 0;
                writeStorageJson('activeLibraryId', activeLibraryId);
            }
            if (activeLibraryId) {
                fetch('/api/libraries?active=' + encodeURIComponent(activeLibraryId)).catch(function() {});
            }
            syncLibrarySelects();
            renderLibraryStats();
        })
        .catch(function() {});
}

function renderMediaLibraryList() {
    var el = $('mediaLibraryList');
    if (!el) return;
    var cards = mediaLibraries.map(function(lib) {
        var active = String(lib.id) === String(activeLibraryId || 0);
        var count = typeof lib.count === 'number' ? lib.count : 0;
        var typeLabel = lib.type === 'smb' ? 'SMB' : '本地';
        var title = libraryDisplayName(lib);
        var displayPath = libraryDisplayPath(lib);
        var cover = lib.coverUrl || (lib.coverPath ? ('/api/libraries/' + lib.id + '/cover') : '');
        return '<article class="media-library-card' + (active ? ' active' : '') + '" data-library-id="' + lib.id + '">' +
            '<button class="media-library-cover" type="button" data-library-id="' + lib.id + '">' +
                '<span class="media-library-cover-bg media-library-cover-' + escapeHtml(lib.type || 'local') + '"></span>' +
                (cover ? '<img class="media-library-cover-img" src="' + escapeHtml(cover) + '" alt="" data-hide-on-error>' : '') +
                '<span class="media-library-cover-title">' + escapeHtml(title) + '</span>' +
            '</button>' +
            '<div class="media-library-card-body">' +
                '<div class="media-library-card-main">' +
                    '<div class="media-library-card-title">' + escapeHtml(title) + '</div>' +
                    '<div class="media-library-card-type">' + typeLabel + ' 媒体库</div>' +
                    '<div class="media-library-card-path">' + escapeHtml(displayPath) + '</div>' +
                    '<div class="media-library-card-count">' + count + ' 个影片</div>' +
                '</div>' +
                '<button class="media-library-menu-btn" type="button" title="媒体库操作" data-library-menu="' + lib.id + '">' +
                    '<span class="media-library-menu-dots"></span>' +
                '</button>' +
                '<div class="media-library-card-menu" data-library-menu-panel="' + lib.id + '">' +
                    '<button type="button" data-library-action="edit" data-library-id="' + lib.id + '">编辑媒体库</button>' +
                    '<button type="button" data-library-action="quick-scan" data-library-id="' + lib.id + '">快速扫描</button>' +
                    '<button type="button" data-library-action="deep-scan" data-library-id="' + lib.id + '">深度扫描</button>' +
                    '<button type="button" data-library-action="delete" data-library-id="' + lib.id + '" class="menu-item-danger">删除媒体库</button>' +
                '</div>' +
            '</div>' +
        '</article>';
    });
    cards.push(
        '<button class="media-library-add-card" type="button" id="btnOpenSmbLibraryPanel">' +
            '<span class="media-library-add-visual"><span class="media-library-add-plus">+</span></span>' +
            '<span class="media-library-add-title">添加媒体库</span>' +
            '<span class="media-library-add-sub">配置类型、路径、名称和封面</span>' +
        '</button>'
    );
    el.innerHTML = cards.join('');
    bindImageFallbacks(el);
    $$('.media-library-cover[data-library-id]', el).forEach(function(row) {
        row.addEventListener('click', function() {
            setActiveLibrary(row.dataset.libraryId, true);
        });
    });
    $$('.media-library-menu-btn[data-library-menu]', el).forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var panel = el.querySelector('[data-library-menu-panel="' + btn.dataset.libraryMenu + '"]');
            var isOpen = panel && panel.classList.contains('open');
            closeMediaLibraryMenus();
            if (panel && !isOpen) panel.classList.add('open');
        });
    });
    $$('[data-library-action]', el).forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            closeMediaLibraryMenus();
            if (btn.dataset.libraryAction === 'edit') {
                openLibraryEditModal(findLibraryById(btn.dataset.libraryId));
            } else if (btn.dataset.libraryAction === 'quick-scan') {
                scanLibrary(btn.dataset.libraryId, false);
            } else if (btn.dataset.libraryAction === 'deep-scan') {
                scanLibrary(btn.dataset.libraryId, true);
            } else if (btn.dataset.libraryAction === 'delete') {
                deleteLibrary(btn.dataset.libraryId);
            } else {
                setActiveLibrary(btn.dataset.libraryId, true);
            }
        });
    });
    var addCard = $('btnOpenSmbLibraryPanel');
    if (addCard) addCard.addEventListener('click', function() {
        openLibraryEditModal(null);
    });
}

function closeMediaLibraryMenus() {
    $$('.media-library-card-menu.open').forEach(function(menu) {
        menu.classList.remove('open');
    });
}

function closeLibraryEditModal() {
    var modal = $('libraryEditModal');
    if (modal) modal.style.display = 'none';
    editingLibraryId = 0;
}

function updateLibraryEditRootDisplay() {
    var typeEl = $('libraryEditType');
    var rootEl = $('libraryEditRootDisplay');
    var pathEl = $('libraryEditPath');
    var libType = typeEl ? typeEl.value : 'local';

    rootEl.textContent = '加载中...';
    rootEl.setAttribute('data-root-path', '');

    if (libType === 'local') {
        // Fetch local root path from server
        fetch('/api/settings/local')
            .then(function(r) { return r.json(); })
            .then(function(d) {
                if (d.rootPath) {
                    rootEl.textContent = '本地';
                    rootEl.setAttribute('data-root-path', d.rootPath);
                } else {
                    rootEl.textContent = '本地（未配置）';
                    rootEl.setAttribute('data-root-path', '');
                }
            })
            .catch(function() {
                rootEl.textContent = '本地（无法获取）';
                rootEl.setAttribute('data-root-path', '');
            });
    } else {
        // For SMB: fetch configured settings
        fetch('/api/settings/smb')
            .then(function(r) { return r.json(); })
            .then(function(d) {
                if (d.host) {
                    var share = d.share || '';
                    var smbRoot = 'smb://' + d.host + (share ? '/' + share : '');
                    rootEl.textContent = smbRoot;
                    rootEl.setAttribute('data-root-path', smbRoot);
                } else {
                    rootEl.textContent = 'SMB（未配置）';
                }
            })
            .catch(function() {
                rootEl.textContent = 'SMB（获取失败）';
            });
    }
    // Clear sub-path when type changes
    if (pathEl) pathEl.value = '';
}

function openLibraryEditModal(library) {
    editingLibraryId = library && library.id ? parseInt(library.id, 10) || 0 : 0;
    if ($('libraryEditTitle')) $('libraryEditTitle').textContent = editingLibraryId ? '编辑媒体库' : '添加媒体库';

    var libType = (library && library.type) || 'local';
    if ($('libraryEditType')) $('libraryEditType').value = libType;
    if ($('libraryEditName')) $('libraryEditName').value = (library && library.name) || '';
    if ($('libraryEditCover')) $('libraryEditCover').value = (library && library.coverPath) || '';
    if ($('libraryEditHint')) $('libraryEditHint').style.opacity = 0;

    // Determine root path display
    var rootEl = $('libraryEditRootDisplay');
    var rootPath = (library && (library.rootPath || library.path)) || '';
    var subPath = '';

    if (rootPath) {
        // Existing library: parse root path for display
        if ((library && library.type === 'local') && rootPath.indexOf('content://') === 0) {
            var display = formatSafLocalPath(rootPath);
            rootEl.textContent = display;
        } else {
            rootEl.textContent = safeDecodePath(rootPath);
        }
        rootEl.setAttribute('data-root-path', rootPath);
        // Try to extract sub-path if library.path differs from library.rootPath
        if (library && library.path && library.rootPath && library.path !== library.rootPath) {
            var rootBase = library.rootPath.replace(/\/+$/, '');
            var pathBase = library.path.replace(/\/+$/, '');
            if (pathBase.indexOf(rootBase) === 0) {
                subPath = pathBase.slice(rootBase.length).replace(/^\/+/, '');
            } else {
                subPath = library.path;
            }
        }
    } else {
        // New library: determine root based on type
        updateLibraryEditRootDisplay();
    }

    if ($('libraryEditPath')) $('libraryEditPath').value = subPath;

    var modal = $('libraryEditModal');
    if (modal) modal.style.display = '';
}

function saveLibraryEdit() {
    var savedLibraryId = editingLibraryId;
    var savedLibraryIdFromResponse = 0;
    var typeEl = $('libraryEditType');
    var pathEl = $('libraryEditPath');
    var nameEl = $('libraryEditName');
    var coverEl = $('libraryEditCover');
    var rootEl = $('libraryEditRootDisplay');
    var hint = $('libraryEditHint');

    var rootPath = (rootEl && rootEl.getAttribute('data-root-path')) || '';
    var subPath = pathEl ? pathEl.value.trim() : '';
    // Build full path: root + sub-path (if any)
    var fullPath = rootPath;
    if (subPath) {
        fullPath = rootPath.replace(/\/+$/, '') + '/' + subPath.replace(/^\/+/, '');
    }
    if (!rootPath) {
        if (hint) {
            hint.textContent = '无法确定根路径，请先选择媒体库类型';
            showHint(hint);
        }
        return;
    }

    fetch('/api/libraries', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
            id: editingLibraryId || undefined,
            type: typeEl ? typeEl.value : 'local',
            path: subPath,
            rootPath: fullPath,
            name: nameEl ? nameEl.value.trim() : '',
            coverPath: coverEl ? coverEl.value.trim() : ''
        })
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
        if (d.error) throw new Error(d.error);
        savedLibraryIdFromResponse = d.library && d.library.id ? parseInt(d.library.id, 10) || 0 : 0;
        if (hint) {
            hint.textContent = '已保存';
            showHint(hint);
        }
        closeLibraryEditModal();
        return loadLibraries();
    })
    .then(function() {
        var targetId = savedLibraryId || savedLibraryIdFromResponse;
        if (targetId) setActiveLibrary(targetId, true);
    })
    .catch(function(e) {
        if (hint) {
            hint.textContent = '保存失败: ' + (e.message || '未知错误');
            showHint(hint);
        }
    });
}

function scanLibrary(libraryId, deep) {
    var nextId = parseInt(libraryId || 0, 10) || 0;
    activeLibraryId = nextId;
    writeStorageJson('activeLibraryId', activeLibraryId);
    clearGridCaches();
    syncLibrarySelects();
    renderMediaLibraryList();
    return fetch('/api/libraries?active=' + encodeURIComponent(activeLibraryId))
        .catch(function() {})
        .then(function() {
            return fetch(deep ? '/api/refresh?deep=true' : '/api/refresh', { method: 'POST' });
        })
        .then(function() {
            if (typeof scanPollingStarter === 'function') {
                scanPollingStarter();
            } else {
                loadDashboard();
                loadLibraryStats();
            }
        })
        .catch(function() {});
}

function deleteLibrary(libraryId) {
    var id = parseInt(libraryId || 0, 10) || 0;
    if (id <= 0) return;
    var lib = findLibraryById(id);
    var libName = lib ? (lib.name || libraryDisplayName(lib)) : ('媒体库 ' + id);
    if (!confirm('确定要删除「' + libName + '」吗？\n\n该媒体库下的所有影片和扫描数据都将被移除。')) return;
    fetch('/api/libraries?id=' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (d.error) throw new Error(d.error);
            if (String(activeLibraryId) === String(id)) {
                activeLibraryId = 0;
                writeStorageJson('activeLibraryId', activeLibraryId);
            }
            return loadLibraries();
        })
        .then(function() {
            clearGridCaches();
            syncLibrarySelects();
            renderMediaLibraryList();
            if (isActiveTab('home')) renderHome();
            if (isActiveTab('favorites')) loadFavorites();
        })
        .catch(function(e) {
            alert('删除失败: ' + (e.message || '未知错误'));
        });
}

function savePersistentViewState(tabOverride) {
    var activePane = document.querySelector('.tab-pane.active');
    var tab = tabOverride || (activePane ? activePane.id.replace(/^pane-/, '') : 'home');
    writeStorageJson('viewState', {
        tab: tab,
        homePage: homeCurrentPage,
        homeScope: homeScope,
        homeSortMode: homeSortMode,
        homeFilter: homeFilter ? { type: homeFilter.type, value: homeFilter.value, page: homeCurrentPage } : null,
        favoritePage: favoriteCurrentPage,
        category: currentCategory,
        categoryPage: categoryCurrentPage,
        actorsPage: actorsCurrentPage
    });
}

function isActiveTab(tabName) {
    var pane = $('pane-' + tabName);
    return !!(pane && pane.classList.contains('active'));
}

function cacheChildren(cache, key, el) {
    if (!key || !el || !el.firstChild) return;
    var frag = document.createDocumentFragment();
    while (el.firstChild) frag.appendChild(el.firstChild);
    cache[key] = frag;
    trimCache(cache, MAX_GRID_CACHE_PAGES);
}

function restoreChildren(cache, key, el) {
    var frag = cache[key];
    if (!frag || !frag.firstChild) return false;
    el.textContent = '';
    el.appendChild(frag);
    delete cache[key];
    return true;
}

function trimCache(cache, maxEntries) {
    var keys = Object.keys(cache);
    while (keys.length > maxEntries) {
        delete cache[keys.shift()];
    }
}

function homeGridCacheKey() {
    return activeLibraryId + ':' + homeScope + ':' + homeSortMode + ':' + (useNewApi ? 'api' : 'legacy') + ':' + getApiPageSize() + ':' + homeCurrentPage + ':' + homeTotalItems + ':' + cachedVideos.length;
}

function categoryCacheKey() {
    var sourceKey = useNewApi ? ('api:' + homeScope + ':' + homeSortMode + ':' + homeCurrentPage + ':' + homeTotalItems) : 'legacy';
    return activeLibraryId + ':' + sourceKey + ':' + currentCategory + ':' + getItemsPerPage($('videoGrid')) + ':' + categoryCurrentPage + ':' + cachedVideos.length;
}

function favoriteGridCacheKey() {
    return activeLibraryId + ':' + homeSortMode + ':' + getItemsPerPage($('favoritesGrid')) + ':' + favoriteCurrentPage + ':' + favoriteTotalItems + ':' + favoriteCachedVideos.length;
}

function getApiPageSize() {
    return getItemsPerPage($('videoGrid'));
}

function displayNameOf(v) {
    return v.title || v.displayName || v.name || '';
}

function parseListField(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value !== 'string') return [String(value)];
    var text = value.trim();
    if (!text) return [];
    try {
        var parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed.filter(Boolean);
        if (parsed) return [String(parsed)];
    } catch (e) {
        // Some APIs return comma-separated text instead of a JSON array.
    }
    return text.split(/[,，]/).map(function(item) { return item.trim(); }).filter(Boolean);
}

function browserTypeLabel(type) {
    if (type === 'deovr') return 'DeoVR';
    if (type === 'pico') return 'PICO Browser';
    if (type === 'oculus') return 'Oculus Browser / Quest';
    if (type === 'wolvic') return 'Wolvic';
    if (type === 'mobile') return '移动浏览器';
    return '桌面浏览器';
}

function firstLetter(name) {
    var c = (name || '#').trim().charAt(0).toUpperCase();
    return /[A-Z0-9]/.test(c) ? c : '#';
}

var posterPlayUrl = null;

function setPosterAutoPlay(url) {
    var poster = $('detailPoster');
    if (!poster) return;
    posterPlayUrl = url;
    poster.classList.add('is-playable');
    poster.title = '点击播放';
}

function clearPosterAutoPlay() {
    var poster = $('detailPoster');
    posterPlayUrl = null;
    if (!poster) return;
    poster.classList.remove('is-playable');
    poster.removeAttribute('title');
}

function playFromPoster() {
    if (!posterPlayUrl) return;
    recordCurrentDetailPlay();
    window.open(posterPlayUrl, '_blank');
}

function buildPartPlayUrl(detail, part, streamHintOverride) {
    var streamKey = part.id ? ('part/' + part.id) : part.name;
    var encodedStreamKey = streamKey.split('/').map(encodeURIComponent).join('/');
    var host = window.location.host;
    var videoUrl = 'http://' + host + '/video/' + encodedStreamKey;
    var streamHint = streamHintOverride || effectiveStreamHint(detail);
    return buildPlayUrl(streamHint, videoUrl, streamKey, part.name || detail.title || detail.folderName);
}

function refreshCurrentDetailPlayLinks() {
    var detail = currentDetailData;
    if (!detail || !detail.parts || detail.parts.length === 0) return;
    var parts = detail.parts;
    var continueBtn = $('detailContinuePlay');
    if (continueBtn) {
        continueBtn.href = buildPartPlayUrl(detail, parts[0]);
    }
    var partsGrid = $('detailPartsGrid');
    var partsList = $('detailPartsList');
    if (partsGrid && partsList && parts.length > 1 && partsList.style.display !== 'none') {
        partsGrid.innerHTML = parts.map(function(part, i) {
            return renderPartCard(detail, part, i, { single: false });
        }).join('');
    }
}

function buildCurrentHereSpherePlayUrl() {
    var detail = currentDetailData;
    var parts = detail && detail.parts;
    var firstPart = parts && parts[0];
    if (!detail || !firstPart) return '';
    return buildPartPlayUrl(detail, firstPart, 'heresphere');
}

function buildCurrentHereSphereDownloadName() {
    var detail = currentDetailData;
    var parts = detail && detail.parts;
    var firstPart = parts && parts[0];
    return (firstPart && firstPart.name) || (detail && (detail.title || detail.folderName)) || 'orbit-video.mp4';
}

function renderPartCard(detail, part, index, options) {
    var playUrl = buildPartPlayUrl(detail, part);
    var durStr = part.durationMs ? Math.round(part.durationMs / 60000) + 'min' : '';
    var resStr = (part.videoWidth && part.videoHeight) ? part.videoWidth + '\u00d7' + part.videoHeight : '';
    var meta = [durStr, resStr].filter(Boolean).join(' / ');
    var fallbackName = options && options.single ? (detail.title || detail.folderName || '播放') : ('第' + (index + 1) + '集');
    return '<a class="part-card" href="' + playUrl + '" target="_blank">' +
        '<span class="part-card-num">' + (options && options.single ? '▶' : (index + 1)) + '</span>' +
        '<div class="part-card-info">' +
            '<div class="part-card-name">' + escapeHtml(part.name || fallbackName) + '</div>' +
            (meta ? '<div class="part-card-meta">' + meta + '</div>' : '') +
        '</div>' +
        '<span class="part-card-play">播放</span>' +
    '</a>';
}

// ── New API render ─────────────────────────────────────────

function renderMediaCard(v) {
    var displayName = displayNameOf(v);
    var src = (v.source === 'smb' || v.isSmb) ? 'SMB' : 'Local';
    var cls = (v.source === 'smb' || v.isSmb) ? 'smb' : 'local';
    var year = v.year ? ' <span class="card-year">' + escapeHtml(String(v.year)) + '</span>' : '';
    var id = v.id;
    var name = v.name || v.folderName || '';

    var thumbSrc;
    if (useNewApi && id != null) {
        thumbSrc = itemPosterSrc(id);
    } else {
        thumbSrc = '/thumbnail/' + encodeURIComponent(name);
    }

    return '<div class="card" data-letter="' + firstLetter(displayName) + '" data-video-name="' + escapeHtml(name) + '" data-item-id="' + (id || '') + '">' +
        '<div class="card-main"><div class="thumb">' +
            '<img class="loading" data-hide-on-error src="' + thumbSrc + '" loading="lazy" alt="">' +
            '<span class="source-badge ' + cls + '">' + src + '</span>' +
        '</div>' +
        '<div class="info">' +
            '<div class="name">' + escapeHtml(displayName) + year + '</div>' +
        '</div></div></div>';
}

// ── API load ────────────────────────────────────────────

function loadHome() {
    homeFilter = null;
    clearGridCaches();
    $('homeLoading').style.display = '';
    $('homeEmpty').style.display = 'none';
    var restorePage = homeRestoreState && !homeRestoreState.homeFilter ? parseInt(homeRestoreState.homePage || 1, 10) : 1;
    homeCurrentPage = Math.max(1, restorePage || 1);
    var toolbar = document.querySelector('#pane-home .library-toolbar');
    if (toolbar) {
        toolbar.querySelector('.section-title').textContent = '媒体库';
    }
    $('homePagination').style.display = '';
    $('homePaginationTop').style.display = '';
    fetchItemsPage(homeCurrentPage);
}

function fetchItemsPage(page) {
    var pageSize = getApiPageSize();
    var cacheKey = activeLibraryId + ':' + homeScope + ':' + homeSortMode + ':' + pageSize + ':' + page;
    if (homeApiPageDataCache[cacheKey]) {
        applyItemsPageData(homeApiPageDataCache[cacheKey]);
        return;
    }

    fetch('/api/items?page=' + page + '&size=' + pageSize + itemsListQueryParam())
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.items != null) {
                homeApiPageDataCache[cacheKey] = {
                    items: data.items.slice(),
                    total: data.total || 0
                };
                trimCache(homeApiPageDataCache, MAX_GRID_CACHE_PAGES);
                applyItemsPageData(homeApiPageDataCache[cacheKey]);
            } else {
                useNewApi = false;
                loadHomeLegacy();
            }
        })
        .catch(function() {
            useNewApi = false;
            loadHomeLegacy();
        });
}

function applyItemsPageData(data) {
    useNewApi = true;
    homeTotalItems = data.total || 0;
    cachedItems = data.items.slice();
    cachedItems.forEach(function(v) {
        if (v.id != null) favoriteItems[v.id] = !!v.isFavorite;
    });
    cachedVideos = cachedItems.map(function(v) { return {
        name: v.folderName,
        displayName: v.title || v.folderName,
        isSmb: v.source === 'smb',
        libraryId: v.libraryId || 0,
        sizeMB: 0,
        id: v.id,
        year: v.year,
        rating: v.rating,
        playCount: v.playCount || 0,
        isFavorite: !!v.isFavorite,
        hasPoster: v.hasPoster,
        itemType: v.itemType
    };});
    renderCategory();
    handleHomeData(cachedVideos.length);
}

// ─── Filter by actor/genre ──────────────────────────────────
var homeFilter = null; // {type: 'actor'|'genre', value: '...'}

function loadItemsByActor(actorName, pushHistory) {
    if (pushHistory !== false) pushCurrentView();
    homeFilter = {type: 'actor', value: actorName};
    homeCurrentPage = (pushHistory === false && homeRestoreState.homeFilter && homeRestoreState.homeFilter.type === 'actor' && homeRestoreState.homeFilter.value === actorName)
        ? Math.max(1, parseInt(homeRestoreState.homeFilter.page || homeRestoreState.homePage || 1, 10) || 1)
        : 1;
    clearGridCaches();
    activateTab('home');
    $('homeLoading').style.display = '';
    $('homeEmpty').style.display = 'none';
    fetch('/api/items?actor=' + encodeURIComponent(actorName) + '&size=200' + itemsListQueryParam())
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.items && data.items.length > 0) {
                handleFilteredItems(data.items, '演员: ' + actorName);
            } else {
                $('homeEmpty').style.display = '';
                $('homeEmpty').querySelector('.empty-text').textContent = '未找到演员相关影片';
                $('homeEmpty').querySelector('.empty-sub').textContent = '演员: ' + actorName;
                $('videoGrid').innerHTML = '';
            }
            $('homeLoading').style.display = 'none';
        })
        .catch(function() { $('homeLoading').style.display = 'none'; });
}

function searchByGenre(genreName, pushHistory) {
    if (pushHistory !== false) pushCurrentView();
    homeFilter = {type: 'genre', value: genreName};
    homeCurrentPage = (pushHistory === false && homeRestoreState.homeFilter && homeRestoreState.homeFilter.type === 'genre' && homeRestoreState.homeFilter.value === genreName)
        ? Math.max(1, parseInt(homeRestoreState.homeFilter.page || homeRestoreState.homePage || 1, 10) || 1)
        : 1;
    clearGridCaches();
    activateTab('home');
    $('homeLoading').style.display = '';
    $('homeEmpty').style.display = 'none';
    fetch('/api/items?genre=' + encodeURIComponent(genreName) + '&size=200' + itemsListQueryParam())
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.items && data.items.length > 0) {
                handleFilteredItems(data.items, '分类: ' + genreName);
            } else {
                $('homeEmpty').style.display = '';
                $('homeEmpty').querySelector('.empty-text').textContent = '未找到分类相关影片';
                $('homeEmpty').querySelector('.empty-sub').textContent = '分类: ' + genreName;
                $('videoGrid').innerHTML = '';
            }
            $('homeLoading').style.display = 'none';
        })
        .catch(function() { $('homeLoading').style.display = 'none'; });
}

function handleFilteredItems(items, title) {
    useNewApi = true;
    var grid = $('videoGrid');
    cachedItems = items.slice();
    cachedItems.forEach(function(v) {
        if (v.id != null) favoriteItems[v.id] = !!v.isFavorite;
    });
    cachedVideos = cachedItems.map(function(v) { return {
        name: v.folderName,
        displayName: v.title || v.folderName,
        isSmb: v.source === 'smb',
        libraryId: v.libraryId || 0,
        sizeMB: 0,
        id: v.id,
        year: v.year,
        rating: v.rating,
        playCount: v.playCount || 0,
        isFavorite: !!v.isFavorite,
        hasPoster: v.hasPoster,
        itemType: v.itemType
    };});
    var itemsPerPage = getItemsPerPage(grid);
    var totalPages = getTotalPages(items.length, itemsPerPage);
    homeCurrentPage = clampPage(homeCurrentPage, totalPages);
    var pageItems = getPageSlice(items, homeCurrentPage, itemsPerPage);
    var frag = document.createDocumentFragment();
    var dummy = document.createElement('div');
    pageItems.forEach(function(item) {
        dummy.innerHTML = renderFilteredMediaCard(item);
        frag.appendChild(dummy.firstChild);
    });
    grid.textContent = '';
    grid.appendChild(frag);
    bindImageFallbacks(grid);
    // Title bar with clear button
    var toolbar = document.querySelector('#pane-home .library-toolbar');
    if (toolbar) {
        var sectionTitle = toolbar.querySelector('.section-title');
        var toolbarLeft = toolbar.querySelector('.toolbar-left');
        if (sectionTitle) sectionTitle.textContent = title;
        if (toolbarLeft) {
            toolbarLeft.textContent = '';
            var clearTitle = document.createElement('div');
            clearTitle.className = 'section-title';
            clearTitle.style.cursor = 'pointer';
            clearTitle.textContent = title + ' ';
            var clearText = document.createElement('span');
            clearText.style.fontSize = '12px';
            clearText.style.color = '#6b7c85';
            clearText.textContent = '× 清除';
            clearTitle.appendChild(clearText);
            clearTitle.addEventListener('click', clearFilter);
            toolbarLeft.appendChild(clearTitle);
        }
    }
    function onChange(newPage) {
        homeCurrentPage = newPage;
        savePersistentViewState('home');
        handleFilteredItems(items, title);
        $('videoGrid').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    renderPaginationControls('homePaginationTop', homeCurrentPage, totalPages, onChange);
    renderPaginationControls('homePagination', homeCurrentPage, totalPages, onChange);
    $('homeLoading').style.display = 'none';
    if (isActiveTab('home')) savePersistentViewState('home');
}

function clearFilter() {
    homeFilter = null;
    homeCurrentPage = 1;
    homeRestoreState = {};
    savePersistentViewState('home');
    loadHome();
}

function renderFilteredMediaCard(item) {
    var thumbSrc = item.id != null
        ? itemPosterSrc(item.id)
        : '/thumbnail/' + encodeURIComponent(item.folderName);
    var displayName = item.title || item.folderName;
    var year = item.year ? ' <span class="card-year">' + escapeHtml(String(item.year)) + '</span>' : '';
    var src = item.source === 'smb' ? 'SMB' : 'Local';
    var cls = item.source === 'smb' ? 'smb' : 'local';
    return '<div class="card" data-video-name="' + escapeHtml(item.folderName) + '" data-item-id="' + (item.id || '') + '">' +
        '<div class="card-main"><div class="thumb">' +
            '<img class="loading" data-hide-on-error src="' + thumbSrc + '" loading="lazy" alt="">' +
            '<span class="source-badge ' + cls + '">' + src + '</span>' +
        '</div>' +
        '<div class="info">' +
            '<div class="name">' + escapeHtml(displayName) + year + '</div>' +
        '</div></div></div>';
}

// ─── Actors Tab ──────────────────────────────────────────────

function actorDisplayName(actor) {
    return actor.displayName || actor.alias || actor.name || '';
}

function actorThumbUrl(name) {
    return actorThumbSrc(name);
}

function actorClickCount(name) {
    return actorClickCounts[name] || 0;
}

function incrementActorClick(name) {
    if (!name) return 0;
    actorClickCounts[name] = actorClickCount(name) + 1;
    writeStorageJson('actorClicks', actorClickCounts);
    actorsDomCache = {};
    currentActorsCacheKey = null;
    return actorClickCounts[name];
}

function sortActorsForDisplay() {
    actorsList.sort(function(a, b) {
        var clickDiff = actorClickCount(b.name) - actorClickCount(a.name);
        if (clickDiff !== 0) return clickDiff;
        var countDiff = (b.movieCount || 0) - (a.movieCount || 0);
        if (countDiff !== 0) return countDiff;
        return actorDisplayName(a).localeCompare(actorDisplayName(b));
    });
}

function actorInitial(name) {
    var text = (name || '').trim();
    return text ? text.charAt(0).toUpperCase() : '#';
}

function initActors() {
    actorsCurrentPage = Math.max(1, parseInt(homeRestoreState.actorsPage || 1, 10) || 1);
    loadActors();
}

function loadActors() {
    $('actorsLoading').style.display = '';
    $('actorsEmpty').style.display = 'none';
    fetch('/api/actors?withThumb=true' + libraryQueryParam())
        .then(function(r) { return r.json(); })
        .then(function(data) {
            actorsList = (data.actors || []).filter(function(actor) { return actor && actor.name; });
            sortActorsForDisplay();
            $('actorsLoading').style.display = 'none';
            renderActorsPage();
        })
        .catch(function() {
            $('actorsLoading').style.display = 'none';
            $('actorsEmpty').style.display = '';
        });
}

function actorsCacheKey() {
    return activeLibraryId + ':' + actorsCurrentPage + ':' + actorsList.length + ':' + getItemsPerPage($('actorsGrid'));
}

function renderActorCard(actor) {
    var name = actor.name || '';
    var displayName = actorDisplayName(actor);
    var aliasText = displayName !== name ? '<div class="actor-card-original">' + escapeHtml(name) + '</div>' : '';
    var meta = [];
    if (actor.movieCount) meta.push(actor.movieCount + ' 部影片');
    if (actorClickCount(name)) meta.push('点击 ' + actorClickCount(name));
    var countText = meta.length ? '<div class="actor-card-count">' + escapeHtml(meta.join(' / ')) + '</div>' : '';
    var thumb = actor.thumbUrl ? '<img class="loading" data-hide-on-error src="' + actor.thumbUrl + '" loading="lazy" alt="">' : '';
    return '<button class="actor-card" type="button" data-actor="' + escapeHtml(name) + '">' +
        '<span class="actor-card-avatar" data-initial="' + escapeHtml(actorInitial(displayName)) + '">' + thumb + '</span>' +
        '<span class="actor-card-body">' +
            '<span class="actor-card-name">' + escapeHtml(displayName) + '</span>' +
            aliasText +
            countText +
        '</span>' +
    '</button>';
}

function bindActorCards(root) {
    $$('.actor-card[data-actor]', root).forEach(function(card) {
        if (card.dataset.actorBound === '1') return;
        card.dataset.actorBound = '1';
        card.addEventListener('click', function() {
            showActorDetailByName(card.dataset.actor, true, true);
        });
    });
}

function renderActorsPage() {
    var grid = $('actorsGrid');
    var empty = $('actorsEmpty');
    if (!grid || !empty) return;
    if (actorsList.length === 0) {
        cacheChildren(actorsDomCache, currentActorsCacheKey, grid);
        currentActorsCacheKey = null;
        grid.innerHTML = '';
        empty.style.display = '';
        $('actorsPagination').style.display = 'none';
        $('actorsPaginationTop').style.display = 'none';
        return;
    }
    empty.style.display = 'none';
    var itemsPerPage = getItemsPerPage(grid);
    var totalPages = getTotalPages(actorsList.length, itemsPerPage);
    actorsCurrentPage = clampPage(actorsCurrentPage, totalPages);
    var pageActors = getPageSlice(actorsList, actorsCurrentPage, itemsPerPage);
    var cacheKey = actorsCacheKey();
    if (currentActorsCacheKey !== cacheKey) {
        cacheChildren(actorsDomCache, currentActorsCacheKey, grid);
        if (!restoreChildren(actorsDomCache, cacheKey, grid)) {
            grid.innerHTML = pageActors.map(renderActorCard).join('');
            bindImageFallbacks(grid);
        }
        bindActorCards(grid);
        currentActorsCacheKey = cacheKey;
    }
    function onChange(newPage) {
        actorsCurrentPage = newPage;
        savePersistentViewState('actors');
        renderActorsPage();
        $('actorsGrid').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    renderPaginationControls('actorsPaginationTop', actorsCurrentPage, totalPages, onChange);
    renderPaginationControls('actorsPagination', actorsCurrentPage, totalPages, onChange);
    if (isActiveTab('actors')) savePersistentViewState('actors');
}

function findActorInfo(name) {
    for (var i = 0; i < actorsList.length; i += 1) {
        if (actorsList[i].name === name) return actorsList[i];
    }
    return { name: name, displayName: name, alias: '', movieCount: 0, thumbUrl: actorThumbUrl(name) };
}

function showActorDetailByName(name, pushHistory, countClick) {
    if (!name) return;
    if (pushHistory !== false) pushCurrentView();
    if (countClick !== false) incrementActorClick(name);
    if (!actorsList.length) {
        fetch('/api/actors?withThumb=true' + libraryQueryParam())
            .then(function(r) { return r.json(); })
            .then(function(data) {
                actorsList = (data.actors || []).filter(function(actor) { return actor && actor.name; });
                sortActorsForDisplay();
                showActorDetail(findActorInfo(name));
            })
            .catch(function() {
                showActorDetail(findActorInfo(name));
            });
    } else {
        sortActorsForDisplay();
        showActorDetail(findActorInfo(name));
    }
}

function showActorDetail(actor) {
    currentActorDetail = actor;
    actorDetailCurrentPage = 1;
    activateTab('actor-detail');
    renderActorDetailHeader(actor);
    $('actorDetailLoading').style.display = '';
    $('actorDetailEmpty').style.display = 'none';
    $('actorDetailGrid').innerHTML = '';
    fetch('/api/items?actor=' + encodeURIComponent(actor.name) + '&size=200' + libraryQueryParam())
        .then(function(r) { return r.json(); })
        .then(function(data) {
            actorDetailItems = data.items || [];
            $('actorDetailLoading').style.display = 'none';
            renderActorDetailItems();
        })
        .catch(function() {
            actorDetailItems = [];
            $('actorDetailLoading').style.display = 'none';
            renderActorDetailItems();
        });
}

function renderActorDetailHeader(actor) {
    var displayName = actorDisplayName(actor);
    $('actorDetailName').textContent = displayName;
    $('actorDetailCount').textContent = (actor.movieCount || 0) + ' 部影片';
    $('actorDetailClicks').textContent = '点击 ' + actorClickCount(actor.name);
    $('actorDetailSubtitle').textContent = displayName;
    var original = $('actorDetailOriginal');
    var sep = $('actorDetailSep1');
    if (displayName !== actor.name) {
        original.textContent = actor.name;
        original.style.display = '';
        sep.style.display = '';
    } else {
        original.style.display = 'none';
        sep.style.display = 'none';
    }

    var avatar = $('actorDetailAvatar');
    avatar.dataset.initial = actorInitial(displayName);
    avatar.innerHTML = '<img class="loading" data-hide-on-error src="' + actorThumbUrl(actor.name) + '" alt="">';
    bindImageFallbacks(avatar);
}

function updateActorInList(updated) {
    if (!updated || !updated.name) return;
    var found = false;
    actorsList = actorsList.map(function(actor) {
        if (actor.name !== updated.name) return actor;
        found = true;
        return Object.assign({}, actor, updated, { thumbUrl: actorThumbUrl(updated.name) });
    });
    if (!found) actorsList.push(Object.assign({}, updated, { thumbUrl: actorThumbUrl(updated.name) }));
    sortActorsForDisplay();
    actorsDomCache = {};
    currentActorsCacheKey = null;
}

function openActorEditModal() {
    if (!currentActorDetail) return;
    actorEditPhotoData = '';
    var actor = currentActorDetail;
    var displayName = actor.displayName || '';
    $('actorEditName').value = actor.name || '';
    $('actorEditDisplayName').value = displayName && displayName !== actor.name ? displayName : '';
    $('actorEditAlias').value = actor.alias || '';
    var preview = $('actorEditPreview');
    preview.dataset.initial = actorInitial(actorDisplayName(actor));
    preview.innerHTML = '<img class="loading" data-hide-on-error src="' + actorThumbUrl(actor.name) + '" alt="">';
    bindImageFallbacks(preview);
    $('actorEditHint').classList.remove('show');
    $('actorEditModal').style.display = '';
}

function closeActorEditModal() {
    $('actorEditModal').style.display = 'none';
}

function pickActorPhoto() {
    var input = $('actorPhotoInput');
    if (input) input.click();
}

function handleActorPhotoSelected() {
    var input = $('actorPhotoInput');
    var file = input && input.files && input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function() {
        actorEditPhotoData = String(reader.result || '');
        var preview = $('actorEditPreview');
        preview.innerHTML = '<img src="' + actorEditPhotoData + '" alt="">';
    };
    reader.readAsDataURL(file);
}

function saveActorEdit() {
    if (!currentActorDetail) return;
    var name = currentActorDetail.name;
    var payload = {
        displayName: $('actorEditDisplayName').value.trim(),
        alias: $('actorEditAlias').value.trim()
    };
    if (actorEditPhotoData) payload.photoData = actorEditPhotoData;
    fetch('/api/actors/' + encodeURIComponent(name), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (d.error) {
                alert('保存失败: ' + d.error);
                return;
            }
            thumbnailRefreshToken = String(Date.now());
            var updated = Object.assign({}, currentActorDetail, d, { thumbUrl: actorThumbUrl(name) });
            currentActorDetail = updated;
            updateActorInList(updated);
            renderActorDetailHeader(updated);
            renderActorsPage();
            $('actorEditHint').textContent = '已保存';
            showHint($('actorEditHint'));
            closeActorEditModal();
        })
        .catch(function() {
            alert('保存失败');
        });
}

function renderActorDetailItems() {
    var grid = $('actorDetailGrid');
    var empty = $('actorDetailEmpty');
    if (!grid || !empty) return;
    if (!actorDetailItems.length) {
        grid.innerHTML = '';
        empty.style.display = '';
        $('actorDetailPagination').style.display = 'none';
        return;
    }
    empty.style.display = 'none';
    var itemsPerPage = getItemsPerPage(grid);
    var totalPages = getTotalPages(actorDetailItems.length, itemsPerPage);
    actorDetailCurrentPage = clampPage(actorDetailCurrentPage, totalPages);
    var pageItems = getPageSlice(actorDetailItems, actorDetailCurrentPage, itemsPerPage);
    grid.innerHTML = pageItems.map(renderFilteredMediaCard).join('');
    bindImageFallbacks(grid);
    renderPaginationControls('actorDetailPagination', actorDetailCurrentPage, totalPages, function(newPage) {
        actorDetailCurrentPage = newPage;
        renderActorDetailItems();
        $('actorDetailGrid').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
}

function loadHomeLegacy() {
    homeCurrentPage = 1;
    fetch(appendLibraryQuery('/api/videos'))
        .then(function(r) { return r.json(); })
        .then(function(data) {
            var videos = data.videos || [];
            var loading = data.loading;
            cachedVideos = videos.slice();
            cachedItems = [];
            renderCategory();
            if (videos.length === 0 && loading) {
                homeRetryTimer = setTimeout(loadHome, 1500);
                return;
            }
            handleHomeData(videos.length);
        })
        .catch(function(e) { console.error('loadHomeLegacy FAILED', e); $('homeLoading').textContent = '加载失败'; });
}

function handleHomeData(count) {
    $('homeLoading').style.display = 'none';
    if (count === 0) {
        var emptyText = $('homeEmpty').querySelector('.empty-text');
        var emptySub = $('homeEmpty').querySelector('.empty-sub');
        if (homeScope === 'favorite') {
            emptyText.textContent = '\u6682\u65e0\u6536\u85cf';
            emptySub.textContent = '\u5f53\u524d\u5a92\u4f53\u5e93\u8fd8\u6ca1\u6709\u6536\u85cf\u7684\u89c6\u9891';
        } else {
            emptyText.textContent = '\u6682\u65e0\u5f71\u7247';
            emptySub.textContent = '\u8bf7\u5728 App \u4e2d\u914d\u7f6e\u89c6\u9891\u76ee\u5f55';
        }
        $('homeEmpty').style.display = '';
        $('videoGrid').style.display = 'none';
        $('homePagination').style.display = 'none';
        $('homePaginationTop').style.display = 'none';
        return;
    }
    $('homeEmpty').style.display = 'none';
    $('videoGrid').style.display = '';
    renderHomePage();
}

function renderHomePage() {
    var grid = $('videoGrid');
    var list = cachedVideos;
    var totalPages, displayList;
    if (useNewApi) {
        // 服务端分页：cachedVideos 已是一页的数据，直接渲染
        totalPages = Math.max(1, Math.ceil(homeTotalItems / getApiPageSize()));
        homeCurrentPage = clampPage(homeCurrentPage, totalPages);
        displayList = list;
    } else {
        // 客户端分页（legacy）：从全量 list 中切片
        var ipp = getItemsPerPage(grid);
        totalPages = getTotalPages(list.length, ipp);
        homeCurrentPage = clampPage(homeCurrentPage, totalPages);
        displayList = getPageSlice(list, homeCurrentPage, ipp);
    }
    var cacheKey = homeGridCacheKey();
    if (currentHomeGridCacheKey !== cacheKey) {
        cacheChildren(homeGridDomCache, currentHomeGridCacheKey, grid);
        if (!restoreChildren(homeGridDomCache, cacheKey, grid)) {
            grid.innerHTML = displayList.map(renderMediaCard).join('');
            bindImageFallbacks(grid);
        }
        currentHomeGridCacheKey = cacheKey;
    }

    function onChange(newPage) {
        homeCurrentPage = newPage;
        savePersistentViewState('home');
        if (useNewApi) {
            $('homeLoading').style.display = '';
            fetchItemsPage(newPage);
        } else {
            renderHomePage();
        }
        $('videoGrid').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    renderPaginationControls('homePaginationTop', homeCurrentPage, totalPages, onChange);
    renderPaginationControls('homePagination', homeCurrentPage, totalPages, onChange);
    if (isActiveTab('home')) savePersistentViewState('home');
}

function initHomeControls() {
    var refreshBtn = $('btnRefreshLibrary');
    if (refreshBtn) refreshBtn.addEventListener('click', function() {
        clearGridCaches();
        loadHome();
    });
    bindSortControl('sortMode');
}

function syncSortControls() {
    ['sortMode', 'favoritesSortMode'].forEach(function(id) {
        var el = $(id);
        if (!el) return;
        if (el.tagName === 'SELECT') {
            el.value = homeSortMode;
            return;
        }
        var selected = SORT_MODE_OPTIONS.find(function(opt) { return opt.id === homeSortMode; }) || SORT_MODE_OPTIONS[0];
        var labelEl = el.querySelector('[data-sort-label]');
        var menuEl = el.querySelector('[data-sort-menu]');
        el.dataset.value = selected.id;
        if (labelEl) labelEl.textContent = selected.label;
        if (menuEl) {
            menuEl.innerHTML = SORT_MODE_OPTIONS.map(function(opt) {
                var active = opt.id === selected.id ? ' active' : '';
                return '<button class="library-picker-item' + active + '" type="button" data-sort-value="' + escapeHtml(opt.id) + '">' + escapeHtml(opt.label) + '</button>';
            }).join('');
        }
    });
}

function setSortMode(nextMode) {
    var normalized = SORT_MODE_OPTIONS.some(function(opt) { return opt.id === nextMode; }) ? nextMode : 'order';
    homeSortMode = normalized;
    writeStorageJson('homeSortMode', homeSortMode);
    syncSortControls();
    homeCurrentPage = 1;
    favoriteCurrentPage = 1;
    clearGridCaches();
    if (isActiveTab('home')) loadHome();
    if (isActiveTab('favorites')) loadFavorites();
}

function bindSortControl(id) {
    var sortEl = $(id);
    if (!sortEl || sortEl.dataset.sortBound === '1') return;
    sortEl.dataset.sortBound = '1';
    if (sortEl.tagName === 'SELECT') {
        sortEl.value = homeSortMode;
        sortEl.addEventListener('change', function() {
            setSortMode(sortEl.value || 'order');
        });
        return;
    }
    var button = sortEl.querySelector('[data-sort-label]');
    var menu = sortEl.querySelector('[data-sort-menu]');
    if (!button || !menu) return;
    syncSortControls();
    button.addEventListener('click', function(e) {
        e.stopPropagation();
        var willOpen = !sortEl.classList.contains('is-open');
        closeLibraryPickers();
        closeSortPickers(willOpen ? sortEl : null);
        sortEl.classList.toggle('is-open', willOpen);
        button.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
    menu.addEventListener('click', function(e) {
        e.stopPropagation();
        var item = e.target.closest ? e.target.closest('[data-sort-value]') : null;
        if (!item || !menu.contains(item)) return;
        closeSortPickers();
        setSortMode(item.dataset.sortValue || 'order');
    });
}

// ── Init home ───────────────────────────────────────────────

function initFavorites() {
    bindLibrarySelects();
    bindSortControl('favoritesSortMode');
    var refreshBtn = $('btnRefreshFavorites');
    if (refreshBtn && refreshBtn.dataset.bound !== '1') {
        refreshBtn.dataset.bound = '1';
        refreshBtn.addEventListener('click', function() {
            favoriteCurrentPage = 1;
            favoriteApiPageDataCache = {};
            favoriteGridDomCache = {};
            currentFavoriteGridCacheKey = null;
            loadFavorites();
        });
    }
    var restorePage = Math.max(1, parseInt((homeRestoreState && homeRestoreState.favoritePage) || 1, 10) || 1);
    favoriteCurrentPage = restorePage;
    loadFavorites();
}

function loadFavorites() {
    $('favoritesLoading').style.display = '';
    $('favoritesEmpty').style.display = 'none';
    $('favoritesEmpty').querySelector('.empty-text').textContent = '\u6682\u65e0\u6536\u85cf';
    $('favoritesEmpty').querySelector('.empty-sub').textContent = '\u5f53\u524d\u5a92\u4f53\u5e93\u8fd8\u6ca1\u6709\u6536\u85cf\u7684\u89c6\u9891';
    $('favoritesGrid').style.display = '';
    $('favoritesPagination').style.display = '';
    $('favoritesPaginationTop').style.display = '';
    fetchFavoriteItemsPage(favoriteCurrentPage);
}

function fetchFavoriteItemsPage(page) {
    var grid = $('favoritesGrid');
    var pageSize = getItemsPerPage(grid);
    var cacheKey = activeLibraryId + ':' + homeSortMode + ':' + pageSize + ':' + page;
    if (favoriteApiPageDataCache[cacheKey]) {
        applyFavoriteItemsPageData(favoriteApiPageDataCache[cacheKey]);
        return;
    }

    fetch('/api/items?page=' + page + '&size=' + pageSize + itemsListQueryParam(true))
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.items == null) throw new Error('Invalid favorite response');
            favoriteApiPageDataCache[cacheKey] = {
                items: data.items.slice(),
                total: data.total || 0
            };
            trimCache(favoriteApiPageDataCache, MAX_GRID_CACHE_PAGES);
            applyFavoriteItemsPageData(favoriteApiPageDataCache[cacheKey]);
        })
        .catch(function() {
            $('favoritesLoading').style.display = 'none';
            $('favoritesEmpty').style.display = '';
            $('favoritesEmpty').querySelector('.empty-text').textContent = '\u52a0\u8f7d\u5931\u8d25';
        });
}

function applyFavoriteItemsPageData(data) {
    favoriteTotalItems = data.total || 0;
    favoriteCachedItems = data.items.slice();
    favoriteCachedItems.forEach(function(v) {
        if (v.id != null) favoriteItems[v.id] = !!v.isFavorite;
    });
    favoriteCachedVideos = favoriteCachedItems.map(function(v) { return {
        name: v.folderName,
        displayName: v.title || v.folderName,
        isSmb: v.source === 'smb',
        libraryId: v.libraryId || 0,
        sizeMB: 0,
        id: v.id,
        year: v.year,
        rating: v.rating,
        playCount: v.playCount || 0,
        isFavorite: !!v.isFavorite,
        hasPoster: v.hasPoster,
        itemType: v.itemType
    };});
    renderFavoritesPage();
}

function renderFavoritesPage() {
    var grid = $('favoritesGrid');
    if (!grid) return;
    $('favoritesLoading').style.display = 'none';
    if (favoriteTotalItems === 0) {
        cacheChildren(favoriteGridDomCache, currentFavoriteGridCacheKey, grid);
        currentFavoriteGridCacheKey = null;
        grid.innerHTML = '';
        grid.style.display = 'none';
        $('favoritesEmpty').style.display = '';
        $('favoritesPagination').style.display = 'none';
        $('favoritesPaginationTop').style.display = 'none';
        return;
    }

    $('favoritesEmpty').style.display = 'none';
    grid.style.display = '';
    var totalPages = Math.max(1, Math.ceil(favoriteTotalItems / getItemsPerPage(grid)));
    favoriteCurrentPage = clampPage(favoriteCurrentPage, totalPages);
    var cacheKey = favoriteGridCacheKey();
    if (currentFavoriteGridCacheKey !== cacheKey) {
        cacheChildren(favoriteGridDomCache, currentFavoriteGridCacheKey, grid);
        if (!restoreChildren(favoriteGridDomCache, cacheKey, grid)) {
            grid.innerHTML = favoriteCachedVideos.map(renderMediaCard).join('');
            bindImageFallbacks(grid);
        }
        currentFavoriteGridCacheKey = cacheKey;
    }

    function onChange(newPage) {
        favoriteCurrentPage = newPage;
        savePersistentViewState('favorites');
        $('favoritesLoading').style.display = '';
        fetchFavoriteItemsPage(newPage);
        $('favoritesGrid').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    renderPaginationControls('favoritesPaginationTop', favoriteCurrentPage, totalPages, onChange);
    renderPaginationControls('favoritesPagination', favoriteCurrentPage, totalPages, onChange);
    if (isActiveTab('favorites')) savePersistentViewState('favorites');
}

function initInitialView() {
    initHomeControls();
    bindLibrarySelects();
    tabInited['home'] = true;
    initLibraryPage();
    var state = homeRestoreState || {};

    function start() {
        if (state.tab === 'home' && state.homeFilter) {
            if (state.homeFilter.type === 'actor') {
                loadItemsByActor(state.homeFilter.value, false);
                homeRestoreState = {};
                return;
            }
            if (state.homeFilter.type === 'genre') {
                searchByGenre(state.homeFilter.value, false);
                homeRestoreState = {};
                return;
            }
        }
        loadHome();
        if (state.tab && state.tab !== 'home' && state.tab !== 'detail' && state.tab !== 'settings') {
            setTimeout(function() {
                activateTab(state.tab);
                homeRestoreState = {};
            }, 0);
        } else {
            homeRestoreState = {};
        }
    }

    loadLibraries().then(start).catch(start);
}

initInitialView();

// ─── Card click → detail page ──────────────────────────────

$('videoGrid').addEventListener('click', function(e) {
    var card = e.target.closest('.card');
    if (!card) return;
    var itemId = card.dataset.itemId;
    if (itemId && useNewApi) {
        showItemDetail(parseInt(itemId));
    } else {
        var videoName = card.dataset.videoName;
        if (videoName) showVideoDetailLegacy(videoName);
    }
});

var favoritesGrid = $('favoritesGrid');
if (favoritesGrid) favoritesGrid.addEventListener('click', function(e) {
    var card = e.target.closest('.card');
    if (!card) return;
    var itemId = card.dataset.itemId;
    if (itemId) showItemDetail(parseInt(itemId, 10));
});

var actorDetailGrid = $('actorDetailGrid');
if (actorDetailGrid) actorDetailGrid.addEventListener('click', function(e) {
    var card = e.target.closest('.card');
    if (!card) return;
    var itemId = card.dataset.itemId;
    if (itemId) showItemDetail(parseInt(itemId));
});

// ── New detail (with parts) ─────────────────────────────────

function showItemDetail(id, pushHistory) {
    fetch('/api/items/' + id)
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (d.error) return;
            if (pushHistory !== false) pushCurrentView();
            showDetail(d);
        })
        .catch(function(e) {
            console.error('Failed to load item detail', e);
        });
}

function showDetail(d) {
    currentDetailId = d.id;
    currentDetailData = d;
    if (d.id != null) favoriteItems[d.id] = !!d.isFavorite;
    activateTab('detail');

    $('detailTitle').textContent = d.title || d.folderName;
    var firstPart = d.parts && d.parts[0];
    var thumb = $('detailThumb');
    if (d.id != null) {
        thumb.style.display = '';
        thumb.src = itemPosterSrc(d.id);
    } else if (firstPart && firstPart.name) {
        thumb.style.display = '';
        thumb.src = '/thumbnail/' + encodeURIComponent(firstPart.name);
    } else {
        thumb.style.display = 'none';
    }
    $('detailSource').textContent = d.source === 'smb' ? 'SMB' : 'Local';

    // Year
    if (d.year) { $('detailYear').textContent = d.year; $('detailYear').style.display = ''; }
    else $('detailYear').style.display = 'none';

    // MPAA
    if (d.mpaa) { $('detailMpaa').textContent = d.mpaa; $('detailMpaa').style.display = ''; }
    else $('detailMpaa').style.display = 'none';

    // Duration & Resolution from first part
    if (firstPart && firstPart.durationMs) {
        var mins = Math.round(firstPart.durationMs / 60000);
        $('detailDuration').textContent = mins + 'min';
        $('detailDuration').style.display = '';
    } else { $('detailDuration').style.display = 'none'; }

    if (firstPart && firstPart.videoWidth && firstPart.videoHeight) {
        $('detailResolution').textContent = firstPart.videoWidth + '\u00d7' + firstPart.videoHeight;
        $('detailResolution').style.display = '';
    } else { $('detailResolution').style.display = 'none'; }

    if (firstPart && firstPart.bitrateBps) {
        $('detailBitrate').textContent = Math.round(firstPart.bitrateBps / 1000000) + 'Mbps';
        $('detailBitrate').style.display = '';
    } else { $('detailBitrate').style.display = 'none'; }

    // Genres (clickable)
    var showGenres = false;
    var genresArr = parseListField(d.genres);
    if (genresArr.length > 0) {
        $('detailGenres').innerHTML = genresArr.map(function(g) {
            return '<a class="genre-tag" href="#" data-genre="' + escapeHtml(g) + '">' + escapeHtml(g) + '</a>';
        }).join('');
        showGenres = true;
        $('detailGenresWrap').style.display = showGenres ? '' : 'none';
        $$('.genre-tag[data-genre]').forEach(function(el) {
            el.addEventListener('click', function(e) { e.preventDefault(); searchByGenre(el.dataset.genre); });
        });
    } else { $('detailGenresWrap').style.display = 'none'; }

    // Actors (clickable)
    var showActors = false;
    var actorsArr = parseListField(d.actors);
    if (actorsArr.length > 0) {
        $('detailActorList').innerHTML = actorsArr.map(function(a) {
            return '<a class="actor-tag" href="#" data-actor="' + escapeHtml(a) + '">' +
                '<span class="actor-tag-avatar" data-initial="' + escapeHtml(actorInitial(a)) + '">' +
                    '<img class="loading" data-hide-on-error src="' + actorThumbSrc(a) + '" loading="lazy" alt="">' +
                '</span>' +
                '<span class="actor-tag-name">' + escapeHtml(a) + '</span>' +
            '</a>';
        }).join('');
        bindImageFallbacks($('detailActorList'));
        showActors = true;
        $('detailActors').style.display = showActors ? '' : 'none';
        $$('.actor-tag[data-actor]').forEach(function(el) {
            el.addEventListener('click', function(e) {
                e.preventDefault();
                showActorDetailByName(el.dataset.actor, true, true);
            });
        });
    } else { $('detailActors').style.display = 'none'; }
    $('detailTaxonomy').classList.toggle('is-empty', !(showGenres || showActors));

    // Plot
    if (d.plot) {
        $('detailPlot').textContent = d.plot;
        $('detailIntro').style.display = '';
    } else {
        $('detailPlot').textContent = '';
        $('detailIntro').style.display = 'none';
    }

    // Extra meta
    if (d.studio) { $('detailStudio').textContent = d.studio; $('detailStudioRow').style.display = ''; }
    else $('detailStudioRow').style.display = 'none';
    if (d.director) { $('detailDirector').textContent = d.director; $('detailDirectorRow').style.display = ''; }
    else $('detailDirectorRow').style.display = 'none';
    if (d.tagline) { $('detailTagline').textContent = '"' + d.tagline + '"'; $('detailTaglineRow').style.display = ''; }
    else $('detailTaglineRow').style.display = 'none';
    $('detailMetaExtra').style.display = (d.studio || d.director || d.tagline) ? '' : 'none';

    // Parts list: single movies use the main play button; multi-part items show episodes.
    var parts = d.parts || [];
    if (parts.length > 0) {
        var continueBtn = $('detailContinuePlay');
        if (continueBtn) {
            continueBtn.href = buildPartPlayUrl(d, parts[0]);
            $('detailContinueLabel').textContent = parts.length > 1 ? '继续播放' : '播放';
            continueBtn.style.display = '';
        }
        if (parts.length > 1) {
            $('detailPartsList').style.display = '';
            $('detailPartsTitle').textContent = '选集';
            $('detailPartsGrid').innerHTML = parts.map(function(part, i) {
                return renderPartCard(d, part, i, { single: false });
            }).join('');
        } else {
            $('detailPartsList').style.display = 'none';
            $('detailPartsGrid').innerHTML = '';
        }
        clearPosterAutoPlay();
    } else {
        $('detailPartsList').style.display = 'none';
        $('detailPartsGrid').innerHTML = '';
        if ($('detailContinuePlay')) $('detailContinuePlay').style.display = 'none';
        clearPosterAutoPlay();
    }

    // Actions toolbar
    var showRefresh = d.actions && d.actions.refreshNfo;
    var showRegen = d.actions && d.actions.regenerateCover;
    $('btnRefreshNfo').style.display = showRefresh ? '' : 'none';
    $('btnRegenThumb').style.display = showRegen ? '' : 'none';
    $('btnPlayHereSphere').style.display = parts.length > 0 ? '' : 'none';
    $('detailToolbar').style.display = '';
    $('btnMoreActions').style.display = '';
    updateFavoriteButton();
}

function splitMetadataInput(value) {
    return String(value || '')
        .split(/[\n,，]+/)
        .map(function(item) { return item.trim(); })
        .filter(Boolean);
}

function openItemMetadataModal() {
    if (!currentDetailData || currentDetailId == null) return;
    var d = currentDetailData;
    $('itemEditTitle').value = d.title || d.folderName || '';
    $('itemEditYear').value = d.year || '';
    if ($('itemEditRating')) $('itemEditRating').value = d.rating != null ? d.rating : '';
    $('itemEditGenres').value = parseListField(d.genres).join('\n');
    $('itemEditActors').value = parseListField(d.actors).join('\n');
    $('itemEditStudio').value = d.studio || '';
    $('itemEditDirector').value = d.director || '';
    $('itemEditPlot').value = d.plot || '';
    $('itemEditHint').classList.remove('show');
    $('itemEditModal').style.display = '';
}

function closeItemMetadataModal() {
    $('itemEditModal').style.display = 'none';
}

function saveItemMetadata() {
    if (currentDetailId == null) return;
    var payload = {
        title: $('itemEditTitle').value.trim(),
        year: $('itemEditYear').value.trim(),
        rating: $('itemEditRating') ? $('itemEditRating').value.trim() : '',
        genres: splitMetadataInput($('itemEditGenres').value),
        actors: splitMetadataInput($('itemEditActors').value),
        studio: $('itemEditStudio').value.trim(),
        director: $('itemEditDirector').value.trim(),
        plot: $('itemEditPlot').value.trim()
    };
    fetch('/api/items/' + currentDetailId + '/metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (d.error) {
                alert('保存失败: ' + d.error);
                return;
            }
            if (d.item) showDetail(d.item);
            clearGridCaches();
            cachedVideos = [];
            cachedItems = [];
            actorsList = [];
            actorDetailItems = [];
            closeItemMetadataModal();
            if (d.nfoWritten === false) {
                alert('数据库已保存，但 NFO 同步失败: ' + (d.nfoError || '未知错误'));
            }
        })
        .catch(function() {
            alert('保存失败');
        });
}

function applyFavoriteState(id, isFavorite, item) {
    favoriteItems[id] = !!isFavorite;
    if (currentDetailId === id) {
        if (item) {
            currentDetailData = item;
        } else if (currentDetailData) {
            currentDetailData.isFavorite = !!isFavorite;
        }
    }
    cachedItems.forEach(function(v) {
        if (String(v.id) === String(id)) v.isFavorite = !!isFavorite;
    });
    cachedVideos.forEach(function(v) {
        if (String(v.id) === String(id)) v.isFavorite = !!isFavorite;
    });
    clearGridCaches();
    updateFavoriteButton();
}

function toggleCurrentFavorite() {
    if (currentDetailId == null) return;
    var id = currentDetailId;
    var before = currentDetailData ? !!currentDetailData.isFavorite : !!favoriteItems[id];
    var next = !before;
    applyFavoriteState(id, next);
    fetch('/api/items/' + id + '/favorite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite: next })
    })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (d.error) throw new Error(d.error);
            applyFavoriteState(id, !!d.isFavorite, d.item || null);
        })
        .catch(function() {
            applyFavoriteState(id, before);
            alert('\u6536\u85cf\u72b6\u6001\u4fdd\u5b58\u5931\u8d25');
        });
}

function buildPlayUrl(streamHint, videoUrl, streamKey, title) {
    if (streamHint === 'deovr') return 'deovr://' + videoUrl + '.json';
    if (streamHint === 'heresphere') return videoUrl + '?download=1';
    return '/player/?video=' + encodeURIComponent(streamKey) + '&title=' + encodeURIComponent(title);
}

function recordItemPlay(id) {
    if (id == null) return;
    var url = '/api/items/' + encodeURIComponent(id) + '/play';
    if (navigator.sendBeacon) {
        try {
            navigator.sendBeacon(url, new Blob([], { type: 'text/plain' }));
            return;
        } catch (e) {}
    }
    fetch(url, { method: 'POST', keepalive: true }).catch(function() {});
}

function recordCurrentDetailPlay() {
    if (currentDetailId != null) {
        recordItemPlay(currentDetailId);
        if (currentDetailData) {
            currentDetailData.playCount = (currentDetailData.playCount || 0) + 1;
        }
    }
}

function openHereSphereVideo(url, downloadName) {
    var link = document.createElement('a');
    link.href = url;
    link.download = downloadName || 'orbit-video.mp4';
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// ── Old detail (legacy videos) ──────────────────────────────

function showVideoDetailLegacy(videoName) {
    var v = cachedVideos.find(function(item) { return item.name === videoName; });
    if (!v) return;
    pushCurrentView();
    var videoUrl = window.location.origin + '/video/' + encodeURIComponent(v.name);
    var displayName = displayNameOf(v);
    var src = v.isSmb ? 'SMB' : 'Local';

    activateTab('detail');

    $('detailTitle').textContent = displayName;
    $('detailThumb').style.display = '';
    $('detailThumb').src = '/thumbnail/' + encodeURIComponent(v.name);
    $('detailSource').textContent = src;
    $('detailYear').style.display = 'none';
    $('detailTaxonomy').classList.add('is-empty');
    $('detailGenresWrap').style.display = 'none';
    $('detailActors').style.display = 'none';
    $('detailPlot').textContent = '';
    $('detailIntro').style.display = 'none';
    $('detailToolbar').style.display = 'none';
    $('detailStudioRow').style.display = 'none';
    $('detailDirectorRow').style.display = 'none';
    $('detailTaglineRow').style.display = 'none';
    $('detailMetaExtra').style.display = 'none';

    var legacyPlayUrl = '/player/?video=' + encodeURIComponent(v.name) + '&title=' + encodeURIComponent(displayName);
    if ($('detailContinuePlay')) {
        $('detailContinuePlay').href = legacyPlayUrl;
        $('detailContinueLabel').textContent = '播放';
        $('detailContinuePlay').style.display = '';
    }
    $('detailPartsList').style.display = 'none';
    $('detailPartsGrid').innerHTML = '';
    clearPosterAutoPlay();
}

// ─── Folder Tab ─────────────────────────────────────────────

function initFolder() {
    // 本机：优先落在「设置 → 媒体库」里配置（或 SAF 授权）的目录；未配置时落在手机存储根。
    // 面包屑的「手机存储」始终指回手机存储根，因此点它不再是「停在原地」
    //（旧实现里根级路径就是配置目录本身，点下去看起来没反应）。
    browseLocalDefault();
    browsePath('smb', '');
}

// 打开「文件夹 → 本地」的默认位置：已配置/已授权的目录，未配置则手机存储根
function browseLocalDefault() {
    fetch('/api/settings/local')
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var rp = (d && d.rootPath) ? String(d.rootPath) : '';
            browsePath('local', rp);
        })
        .catch(function() { browsePath('local', ''); });
}

// 「文件夹 → 本地」为空时的引导。
// 安卓端根目录常因未授权而不可读，只显示「空文件夹」会让人误以为功能坏了。
// 注意：引导块是「本地」专属节点。SMB 面板为空时也会走到这里，
// 必须直接返回，否则会把当地的引导一起清掉（曾因此导致引导不显示）。
function renderLocalEmptyGuide(type, emptyEl) {
    if (type !== 'local') return;
    var sub = $('localEmptySub');
    if (!sub) return;

    sub.innerHTML = '<div class="empty-guide-text">' +
        '安卓系统默认不允许应用直接读取手机存储，未授权的目录会显示为空。' +
        '请授权视频所在文件夹，授权后即可在此浏览并播放。</div>';

    var row = document.createElement('div');
    row.className = 'empty-guide-actions';

    var btnPick = document.createElement('button');
    btnPick.className = 'tool-btn media-scan-all';
    btnPick.type = 'button';
    btnPick.textContent = '选择视频文件夹';
    btnPick.addEventListener('click', function() {
        if (window.Orbit && typeof window.Orbit.pickFolder === 'function') {
            window.Orbit.pickFolder();
        } else {
            location.href = '/index.html?panel=library';
        }
    });
    row.appendChild(btnPick);

    var btnSet = document.createElement('button');
    btnSet.className = 'tool-btn';
    btnSet.type = 'button';
    btnSet.textContent = '打开设置';
    btnSet.addEventListener('click', function() {
        location.href = '/index.html?panel=library';
    });
    row.appendChild(btnSet);

    sub.appendChild(row);
}

function browsePath(type, path) {
    var prefix = type === 'local' ? 'local' : 'smb';
    var filesEl = $(prefix + 'Files');
    var emptyEl = $(prefix + 'Empty');
    var loadEl = $(prefix + 'Loading');
    var bcEl = $(prefix + 'Breadcrumb');
    var pathEl = $(prefix + 'Path');
    var rootLabel = type === 'local' ? '手机存储' : '共享根';

    filesEl.innerHTML = '';
    emptyEl.style.display = 'none';
    loadEl.style.display = '';
    if (pathEl) pathEl.textContent = '正在读取…';
    // 重新进入目录时先撤掉上一次的授权引导，避免有内容了还挂着提示
    if (type === 'local') {
        var guide = $('localEmptySub');
        if (guide) guide.innerHTML = '';
    }

    fetch('/api/browse/' + type + '?path=' + encodeURIComponent(path))
        .then(function(r) { return r.json(); })
        .then(function(data) {
            loadEl.style.display = 'none';

            if (data.error) {
                emptyEl.querySelector('.empty-text').textContent = data.error;
                renderLocalEmptyGuide(type, emptyEl);
                emptyEl.style.display = '';
                bcEl.innerHTML = '';
                if (pathEl) pathEl.textContent = '当前路径：' + (path || rootLabel);
                return;
            }

            var curPath = (data.path === undefined || data.path === null) ? path : data.path;
            var absPath = data.absPath || curPath || '';
            var rootPath = data.rootPath || '';
            if (pathEl) {
                pathEl.innerHTML = absPath
                    ? '<span class="dir-path-label">当前路径：</span>' + escapeHtml(absPath)
                    : '';
            }

            // 面包屑：根级＝手机存储根（可点回整机存储）；SAF 授权树单独给一个层级
            var safRoot = (rootPath.indexOf('content://') === 0) ? rootPath
                : ((curPath && String(curPath).indexOf('content://') === 0) ? curPath : '');
            renderBreadcrumb(bcEl, curPath, function(nextPath) {
                browsePath(type, nextPath);
            }, rootLabel, { rootPrefix: rootPath, safRoot: safRoot });

            var items = data.items || [];
            if (items.length === 0) {
                emptyEl.querySelector('.empty-text').textContent = '空文件夹';
                renderLocalEmptyGuide(type, emptyEl);
                emptyEl.style.display = '';
                return;
            }

            emptyEl.style.display = 'none';

            filesEl.innerHTML = items.map(function(item) {
                // 后端已给出条目自身路径（本机为绝对路径），优先采用
                var itemPath = item.path ? item.path : (path ? path + '/' + item.name : item.name);
                if (item.isDir) {
                    return '<div class="file-item" data-browse="' + type + '" data-path="' + escapeHtml(itemPath) + '">' +
                        '<div class="file-icon folder-cover"><img class="mi" src="/icons/folder.png" alt=""></div>' +
                        '<div class="file-name">' + escapeHtml(item.name) + '</div>' +
                    '</div>';
                } else {
                    // 播放键优先用条目 id（base64url 的 ref）：本机绝对路径与 SAF（content://）
                    // 都能被后端还原；直接给 SAF 的相对路径后端定位不到文件。
                    var videoKey = item.id ? String(item.id) : itemPath;
                    var href = '/player/' + encodeURIComponent(videoKey);
                    return '<a class="file-item" href="' + href + '">' +
                        '<div class="file-icon"><img data-hide-on-error src="/thumbnail/' + encodeURIComponent(videoKey) + '" alt=""></div>' +
                        '<div class="file-name">' + escapeHtml(item.name) + '</div>' +
                        (item.sizeMB > 0 ? '<div class="file-size">' + item.sizeMB + ' MB</div>' : '') +
                    '</a>';
                }
            }).join('');
            bindImageFallbacks(filesEl);

            // Attach click handlers for directories
            $$('.file-item[data-browse]', filesEl).forEach(function(el) {
                el.addEventListener('click', function() {
                    browsePath(el.dataset.browse, el.dataset.path);
                });
            });
        })
        .catch(function(e) {
            loadEl.style.display = 'none';
            emptyEl.querySelector('.empty-text').textContent = '加载失败';
            emptyEl.style.display = '';
            if (pathEl) pathEl.textContent = '';
        });
}

// 面包屑：根级标签可点回根目录（本机＝手机存储根，SMB＝共享根）。
// opts.rootPrefix：把绝对路径裁成相对层级（/storage/emulated/0/DCIM → DCIM）
// opts.safRoot：    SAF 授权树（content://）自身作为一个可点层级
function renderBreadcrumb(el, path, onNavigate, rootLabel, opts) {
    opts = opts || {};
    var rootPrefix = opts.rootPrefix || '';
    var hasPrefix = !!rootPrefix && String(path || '').indexOf(rootPrefix) === 0;
    el.textContent = '';

    function addCrumb(label, targetPath) {
        var a = document.createElement('a');
        a.dataset.bcPath = targetPath;
        a.textContent = label;
        a.addEventListener('click', function() {
            onNavigate(a.dataset.bcPath);
        });
        el.appendChild(a);
    }

    function addSep() {
        var sep = document.createElement('span');
        sep.className = 'bc-sep';
        sep.textContent = ' / ';
        el.appendChild(sep);
    }

    addCrumb(rootLabel || '根目录', '');

    if (opts.safRoot) {
        addSep();
        addCrumb('已授权目录', opts.safRoot);
    }

    var rel = String(path || '');
    if (hasPrefix) rel = rel.slice(rootPrefix.length);
    var parts = rel.split('/').filter(function(p) { return p; });
    var cumulative = hasPrefix ? rootPrefix.replace(/\/+$/, '') : '';
    parts.forEach(function(part) {
        addSep();
        cumulative = cumulative ? (cumulative + '/' + part) : part;
        addCrumb(part, cumulative);
    });
}

// ─── Settings Tab ───────────────────────────────────────────

function initCategory() {
    if (homeRestoreState.category) {
        currentCategory = homeRestoreState.category;
        categoryCurrentPage = Math.max(1, parseInt(homeRestoreState.categoryPage || 1, 10) || 1);
        $$('.category-tabs .sub-tab[data-category]').forEach(function(tab) {
            tab.classList.toggle('active', (tab.dataset.category || 'all') === currentCategory);
        });
    }
    $$('.category-tabs .sub-tab[data-category]').forEach(function(tab) {
        tab.addEventListener('click', function() {
            $$('.category-tabs .sub-tab').forEach(function(t) { t.classList.remove('active'); });
            tab.classList.add('active');
            currentCategory = tab.dataset.category || 'all';
            categoryCurrentPage = 1;
            savePersistentViewState('category');
            renderCategory();
        });
    });
    if (cachedVideos.length === 0) loadHome();
    renderCategory();
}

function renderCategory() {
    var target = $('categoryGroups');
    var empty = $('categoryEmpty');
    if (!target || !empty) return;

    var videos = cachedVideos.filter(function(v) {
        if (currentCategory === 'local') return !v.isSmb;
        if (currentCategory === 'smb') return v.isSmb;
        return true;
    }).sort(function(a, b) {
        return displayNameOf(a).localeCompare(displayNameOf(b));
    });

    if (videos.length === 0) {
        cacheChildren(categoryDomCache, currentCategoryCacheKey, target);
        currentCategoryCacheKey = null;
        target.innerHTML = '';
        empty.style.display = '';
        $('categoryPagination').style.display = 'none';
        return;
    }
    empty.style.display = 'none';

    // Paginate before grouping
    var itemsPerPage = getItemsPerPage($('videoGrid'));
    var totalPages = getTotalPages(videos.length, itemsPerPage);
    categoryCurrentPage = clampPage(categoryCurrentPage, totalPages);
    var pageVideos = getPageSlice(videos, categoryCurrentPage, itemsPerPage);

    var groups = {};
    pageVideos.forEach(function(v) {
        var key = firstLetter(displayNameOf(v));
        if (!groups[key]) groups[key] = [];
        groups[key].push(v);
    });

    var keys = Object.keys(groups).sort();
    var cacheKey = categoryCacheKey();
    if (currentCategoryCacheKey !== cacheKey) {
        cacheChildren(categoryDomCache, currentCategoryCacheKey, target);
        if (!restoreChildren(categoryDomCache, cacheKey, target)) {
            target.innerHTML = keys.map(function(key) {
                return '<section class="category-group" id="cat-' + key + '">' +
                    '<div class="category-title">' + key + '</div>' +
                    '<div class="grid">' + groups[key].map(renderMediaCard).join('') + '</div>' +
                '</section>';
            }).join('') +
            '<nav class="alpha-rail">' + keys.map(function(key) {
                return '<a href="#cat-' + key + '">' + key + '</a>';
            }).join('') + '</nav>';
            bindImageFallbacks(target);
        }
        currentCategoryCacheKey = cacheKey;
    }

    // Pagination controls
    renderPaginationControls('categoryPagination', categoryCurrentPage, totalPages, function(newPage) {
        categoryCurrentPage = newPage;
        savePersistentViewState('category');
        renderCategory();
        $('categoryGroups').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    if (isActiveTab('category')) savePersistentViewState('category');
}

// ─── 本机视频目录（安卓端文件目录授权） ───────────────────────
//
// 背景：安卓 11 及以上默认开启分区存储，应用无法直接遍历手机存储。
// 之前只有 MainActivity 里的 SAF 文件夹选择器桥（Orbit.pickFolder），
// 前端从未调用它，本机根目录又默认指向应用私有目录
// （getExternalFilesDir/Movies，用户放不进文件也看不见），
// 于是「文件夹 → 本地」永远是空的，表现为「识别不了安卓的文件目录」。
// 这里把桥接到设置页，并把选择结果写入 /api/settings/local。

function showLocalRootHint(msg, isError) {
    var el = $('localRootHint');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? '#EF4444' : '#4ADE80';
    el.style.opacity = 1;
    if (el._hintTimer) clearTimeout(el._hintTimer);
    el._hintTimer = setTimeout(function() { el.style.opacity = 0; }, 2600);
}

function renderLocalRoot(rootPath) {
    var disp = $('localRootDisplay');
    if (disp) {
        disp.textContent = rootPath ? formatSafLocalPath(rootPath) : '未配置（请点「选择文件夹」）';
        disp.setAttribute('data-root-path', rootPath || '');
    }
    var manual = $('localRootManual');
    if (manual && rootPath && rootPath.indexOf('content://') !== 0) manual.value = rootPath;
}

function loadLocalRoot() {
    fetch('/api/settings/local')
        .then(function(r) { return r.json(); })
        .then(function(d) { renderLocalRoot((d && d.rootPath) || ''); })
        .catch(function() {
            var disp = $('localRootDisplay');
            if (disp) disp.textContent = '读取失败';
        });
}

function saveLocalRoot(path) {
    return fetch('/api/settings/local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootPath: path })
    })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            renderLocalRoot((d && d.rootPath) || path);
            showLocalRootHint('目录已保存', false);
            clearGridCaches();
            return d;
        })
        .catch(function() {
            showLocalRootHint('保存失败', true);
        });
}

// 安卓端 SAF 选择器回调（MainActivity.onActivityResult → evaluateJavascript）
window.__onFolderPicked = function(uri) {
    if (!uri) return;
    var mode = window.__folderPickMode;
    window.__folderPickMode = null;
    if (mode === 'script') {
        if (typeof window.loadScriptFolder === 'function') window.loadScriptFolder(String(uri));
        return;
    }
    saveLocalRoot(String(uri)).then(function() {
        if (tabInited['folder']) browsePath('local', String(uri));
        // 视频库页也要跟着换根，并把浏览栈重置（新目录 = 新的浏览根）
        try { libStack = []; libLoadFolder(String(uri), null); } catch (e) {}
        // 选完文件夹后顺手重新扫描媒体库，让首页/媒体库也同步出现该目录下的视频
        // （参考 DoroPlayer：选完即自动加载，无需用户再手动刷新）
        fetch('/api/refresh', { method: 'POST' })
            .then(function() { if (typeof loadHome === 'function') { try { loadHome(); } catch (e) {} } })
            .catch(function() {});
    });
};

// 媒体权限授予结果回调（MainActivity.onRequestPermissionsResult → evaluateJavascript）
window.__onMediaPermission = function(granted) {
    if (tabInited['settings']) loadLocalRoot();
    if (granted && tabInited['folder']) browseLocalDefault();
};

function initSettings() {
    loadSmbSettings();
    loadDashboard();
    loadLibraryStats();
    loadAxesSettings();

    bindLibrarySelects();

    $('btnSaveSmb').addEventListener('click', saveSmb);
    var cbSmbAnonymous = $('smbAnonymous');
    if (cbSmbAnonymous) cbSmbAnonymous.addEventListener('change', toggleSmbCredentials);
    var btnAddSmbLibrary = $('btnAddSmbLibrary');
    if (btnAddSmbLibrary) btnAddSmbLibrary.addEventListener('click', function() {
        openLibraryEditModal({
            type: 'smb',
            path: buildSmbLibraryRoot(),
            name: $('smbLibraryName') ? $('smbLibraryName').value.trim() : ''
        });
    });

    // VR 蓝牙时间桥（与下方 DeoVR Wi-Fi 面板并存，两种链路二选一）
    initVrBt();

    // DeoVR 连接面板
    var btnDeovrConnect = $('btnDeovrConnect');
    var btnHereSphereConnect = $('btnHereSphereConnect');
    var btnDeovrDisconnect = $('btnDeovrDisconnect');
    var btnDeovrDiscover = $('btnDeovrDiscover');
    var deovrHost = $('deovrHost');
    if (btnDeovrConnect) btnDeovrConnect.addEventListener('click', function() {
        var host = deovrHost ? deovrHost.value.trim() : '';
        if (!host) { alert('请输入 DeoVR IP 地址'); return; }
        updateDeovrPanelUI({ status: 'CONNECTING', mode: 'DEOVR' });
        fetch('/api/deovr/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: host, mode: 'deovr' })
        }).then(function(r) { return r.json(); })
          .then(function(d) {
              updateDeovrPanelUI(d);
              pollDeovrStatus();
          })
          .catch(function() { updateDeovrPanelUI({ status: 'ERROR', host: host }); });
    });
    if (btnHereSphereConnect) btnHereSphereConnect.addEventListener('click', function() {
        var host = deovrHost ? deovrHost.value.trim() : '';
        if (!host) { alert('请输入播放器 IP 地址'); return; }
        updateDeovrPanelUI({ status: 'CONNECTING', mode: 'HERESPHERE' });
        fetch('/api/deovr/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: host, mode: 'heresphere' })
        }).then(function(r) { return r.json(); })
          .then(function(d) {
              updateDeovrPanelUI(d);
              pollDeovrStatus();
          })
          .catch(function() { updateDeovrPanelUI({ status: 'ERROR', host: host, mode: 'HERESPHERE' }); });
    });
    if (btnDeovrDisconnect) btnDeovrDisconnect.addEventListener('click', function() {
        fetch('/api/deovr/disconnect', { method: 'POST' })
            .then(function() { updateDeovrPanelUI({ status: 'STOPPED', host: '127.0.0.1' }); })
            .catch(function() {});
    });
    if (btnDeovrDiscover) btnDeovrDiscover.addEventListener('click', function() {
        if (btnDeovrDiscover.disabled) return;
        btnDeovrDiscover.disabled = true;
        btnDeovrDiscover.classList.add('is-loading');
        updateDeovrPanelUI({ status: 'CONNECTING', mode: 'DEOVR' });
        fetch('/api/deovr/discover', { method: 'POST' })
            .then(function(r) { return r.json(); })
            .then(function(d) {
                btnDeovrDiscover.disabled = false;
                btnDeovrDiscover.classList.remove('is-loading');
                if (d.found && d.ip) {
                    if (deovrHost) deovrHost.value = d.ip;
                    updateDeovrPanelUI({ status: 'CONNECTING', host: d.ip, mode: 'DEOVR' });
                    // Auto-connect after discovery
                    fetch('/api/deovr/connect', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ host: d.ip, mode: 'deovr' })
                    }).then(function(r2) { return r2.json(); })
                      .then(function(d2) {
                          updateDeovrPanelUI(d2);
                          pollDeovrStatus();
                      })
                      .catch(function() { updateDeovrPanelUI({ status: 'ERROR', host: d.ip }); });
                } else {
                    updateDeovrPanelUI({ status: 'STOPPED' });
                    alert('未发现 DeoVR 设备');
                }
            })
            .catch(function() {
                btnDeovrDiscover.disabled = false;
                btnDeovrDiscover.classList.remove('is-loading');
                updateDeovrPanelUI({ status: 'ERROR' });
            });
    });
    $('btnSaveAxes').addEventListener('click', saveAxes);
    var btnCloseLibraryEdit = $('btnCloseLibraryEdit');
    if (btnCloseLibraryEdit) btnCloseLibraryEdit.addEventListener('click', closeLibraryEditModal);
    var btnSaveLibraryEdit = $('btnSaveLibraryEdit');
    if (btnSaveLibraryEdit) btnSaveLibraryEdit.addEventListener('click', saveLibraryEdit);
    var libraryEditModal = $('libraryEditModal');
    if (libraryEditModal) libraryEditModal.addEventListener('click', function(e) {
        if (e.target === libraryEditModal) closeLibraryEditModal();
    });
    $('btnBrowseSmb').addEventListener('click', openSmbBrowser);
    $('btnCloseBrowse').addEventListener('click', closeSmbBrowser);
    $('btnSelectDir').addEventListener('click', selectSmbDir);
    $('smbBrowseModal').addEventListener('click', function(e) {
        if (e.target === $('smbBrowseModal')) closeSmbBrowser();
    });

    // Library edit path browser
    var btnBrowseLibraryPath = $('btnBrowseLibraryPath');
    if (btnBrowseLibraryPath) btnBrowseLibraryPath.addEventListener('click', openPathBrowser);
    var btnClosePathBrowse = $('btnClosePathBrowse');
    if (btnClosePathBrowse) btnClosePathBrowse.addEventListener('click', closePathBrowser);
    var btnSelectPath = $('btnSelectPath');
    if (btnSelectPath) btnSelectPath.addEventListener('click', selectBrowsedPath);
    var pathBrowseModal = $('pathBrowseModal');
    if (pathBrowseModal) pathBrowseModal.addEventListener('click', function(e) {
        if (e.target === pathBrowseModal) closePathBrowser();
    });

    // Library edit: type change updates root display
    var libraryEditType = $('libraryEditType');
    if (libraryEditType) libraryEditType.addEventListener('change', function() {
        if (!editingLibraryId) updateLibraryEditRootDisplay();
    });

    // Library edit: cover upload
    var btnUploadLibraryCover = $('btnUploadLibraryCover');
    var libraryCoverFileInput = $('libraryCoverFileInput');
    if (btnUploadLibraryCover && libraryCoverFileInput) {
        btnUploadLibraryCover.addEventListener('click', function() {
            libraryCoverFileInput.click();
        });
        libraryCoverFileInput.addEventListener('change', function() {
            var file = this.files && this.files[0];
            if (!file) return;
            var formData = new FormData();
            formData.append('file', file);
            var btn = btnUploadLibraryCover;
            var originalText = btn.textContent;
            btn.textContent = '...';
            btn.disabled = true;
            fetch('/api/upload/cover', { method: 'POST', body: formData })
                .then(function(r) { return r.json(); })
                .then(function(d) {
                    if (d && d.path) {
                        var coverEl = $('libraryEditCover');
                        if (coverEl) coverEl.value = d.path;
                    } else if (d && d.implemented === false) {
                        // 占位实现会返回 ok:true 但没有 path，
                        // 不提示的话用户以为封面上传成功了。
                        libToast((d.note || '封面上传') + '（未实现）');
                    }
                })
                .catch(function() {})
                .then(function() {
                    btn.textContent = originalText;
                    btn.disabled = false;
                });
        });
    }

    // Sidebar navigation（侧栏已由 CSS 隐藏，事件保留：深链仍会程序化点击它）
    $$('.sidebar-item[data-panel]').forEach(function(item) {
        item.addEventListener('click', function() {
            if (showSettingsPanel) showSettingsPanel(item.dataset.panel);
        });
    });

    // Media library scan buttons
    var scanPollTimer = null;
    var scanPollCount = 0;
    var scanWaitTicks = 0;
    var scanHideTimer = null;
    var libScanAll = $('btnLibScanAll');
    if (libScanAll) libScanAll.addEventListener('click', function() {
        scanLibrary(0, false);
    });

    // Dashboard stop button
    var dashStop = $('btnScanStop');
    if (dashStop) dashStop.addEventListener('click', function() {
        fetch('/api/scan/stop', { method: 'POST' });
    });

    // ── 脚本生成（混合流 → 视频同目录的 .funscript） ─────────────
    // 原生实现 osr/ScriptRecorder.kt：画面运动（块匹配矢量）给「何时动 / 往哪动」，
    // 音频低频能量给「使多大劲」，中间做笔触分段建模。分析很重（要解整段音视频），
    // 所以 start 只投递任务立刻返回，进度一律靠轮询 status；预览只分析前 30 秒用于调参。
    var REC_POLL_MS = 800;
    var recVideoUri = null;    // 已选视频的原始 URI（或绝对路径）
    var recWritable = false;   // 视频同目录是否已拿到写授权
    var recFallback = false;   // true = 没有同目录写权限，脚本将落到应用私有目录
    var recPick = null;        // { id, name }
    var recPollTimer = null;
    var recJobActive = false;  // 已知有任务在跑（用于辨认「从运行变为结束」那一刻）
    var recJobKind = '';       // 'generate' | 'preview'：收尾 toast 要分开，预览别报「脚本已生成」
    var recJobStart = 0;       // 本任务开始时刻，用来显示「已用 1 分 23 秒」
    var recJobStarted = false; // 后端确认「任务已投递 / 已在跑」后才置真 —— 收尾判定的前提
    var recPollGen = 0;        // 任务代次：换任务就 +1，用来丢弃上一代的迟到 status 响应
    var recGrantUri = '';      // v2.7.16：本次目录授权树（临时写权限也认），改存到视频同目录要用
    var recCanRewrite = false; // 已生成过脚本、缓存还在 —— 授权后可直接改存，不必重跑分析
    var REC_START_LABEL = '开始生成';

    function recHint(text, ok) {
        var el = $('recFolderHint');
        if (!el) return;
        el.textContent = text || '';
        el.style.color = ok ? '#22c55e' : '#f0a63a';
        el.classList.add('show');
    }

    function recFmtDur(sec) {
        var s = Math.max(0, Math.round(Number(sec) || 0));
        var m = Math.floor(s / 60);
        return (m > 0 ? m + ' 分 ' : '') + (s % 60) + ' 秒';
    }

    function recFmtSize(b) {
        var n = Number(b) || 0;
        if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
        if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
        if (n >= 1024) return Math.round(n / 1024) + ' KB';
        return n > 0 ? n + ' B' : '';
    }

    function recShowProgress(on) {
        var w = $('recProgressWrap');
        if (w) w.style.display = on ? '' : 'none';
        if (!on) recSetBar(0, '');
    }

    function recSetBar(pct, msg) {
        var p = Math.max(0, Math.min(100, Number(pct) || 0));
        var fill = $('recBarFill');
        if (fill) fill.style.width = p + '%';
        var pe = $('recPercent');
        if (pe) pe.textContent = Math.round(p) + '%';
        var me = $('recMsg');
        if (me && msg != null) me.textContent = msg;
    }

    function recStats(html) {
        var el = $('recStats');
        if (el) el.innerHTML = html || '';
    }

    function recSetBusy(busy, msg) {
        recJobActive = !!busy;
        var s = $('recStart'), c = $('recCancel');
        var f = $('recPickVideo');
        if (s) {
            s.disabled = !!busy; s.style.opacity = busy ? '.5' : '';
            // 待机时把按钮文字还原（跑起来时会被 recStartLabel 改成百分比）
            if (!busy) s.textContent = REC_START_LABEL;
        }
        if (f) { f.disabled = !!busy; f.style.opacity = busy ? '.5' : ''; }
        if (c) c.style.display = busy ? '' : 'none';
        if (busy && msg != null) recHint(msg, true);
    }

    /** 「开始生成」按钮兼作进度显示 —— 面板很长，用户的眼睛通常还停在这个按钮上。 */
    function recStartLabel(pct) {
        var s = $('recStart');
        if (!s) return;
        var p = Math.max(0, Math.min(100, Number(pct) || 0));
        s.textContent = '\u751f\u6210\u4e2d ' + Math.round(p) + '%';
    }

    /** 进度块可能落在屏幕外（面板很长），点完生成主动把它带到眼前。 */
    function recScrollToProgress() {
        var w = $('recProgressWrap');
        if (!w || !w.scrollIntoView) return;
        try { w.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
        catch (e) { try { w.scrollIntoView(); } catch (e2) { } }
    }

    /** 长视频要跑好几分钟，只给百分比会让人怀疑卡死了 —— 补一个「已用」。 */
    function recElapsedTick() {
        var el = $('recElapsed');
        if (!el) return;
        if (!recJobStart) { el.textContent = ''; return; }
        var s = Math.max(0, Math.floor((Date.now() - recJobStart) / 1000));
        el.textContent = '\u5df2\u7528 ' + (s >= 60 ? (Math.floor(s / 60) + ' \u5206 ' + (s % 60) + ' \u79d2') : (s + ' \u79d2'));
    }

    function recJobBegin(kind) {
        recJobKind = kind;
        recJobStart = Date.now();
        // 新任务 = 新代次：上一代还在飞的 status 响应到了也一律丢掉，
        // 否则「刚开始那一刻的旧响应（running=false）」会被当成「任务已结束」。
        recPollGen++;
        recJobStarted = false;
        recElapsedTick();
    }

    function recJobEnd() {
        recJobKind = '';
        recJobStart = 0;
        recJobStarted = false;
        recPollGen++;
        recElapsedTick();
    }

    /** 收尾失败的展示文案。
     后端的 message 本来就是一整句（"生成失败：音轨解码失败" / "已取消"），
     这里再补一层前缀就成了「生成失败：生成失败：…」（真机实测过），
     所以只在文案本身没带前缀时才补。 */
    function recErrPlain(d) {
        if (d && d.error === 'cancelled') return '已取消';
        var m = String((d && (d.message || d.error)) || '未知错误');
        return m.indexOf('生成失败') === 0 ? m : '生成失败：' + m;
    }

    /** 面板内展示用（要过 HTML 转义）；toast 走 recErrPlain（textContent，不需要转义）。 */
    function recErrText(d) {
        return escapeHtml(recErrPlain(d));
    }

    function recReadOptions() {
        function val(id, def) {
            var el = $(id);
            var v = el ? parseInt(el.value, 10) : NaN;
            return isNaN(v) ? def : v;
        }
        return {
            fps: val('recFps', 10),
            maxHz: val('recMaxHz', 40) / 10,
            sensitivity: val('recSens', 180) / 100,
            smooth: val('recSmooth', 25) / 100,
            offsetMs: val('recOffset', 0),
            maxSeconds: val('recMaxMin', 0) * 60,
            multiAxis: !!($('recMulti') && $('recMulti').checked)
        };
    }

    function recPost(url, body) {
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        }).then(function (r) { return r.json(); });
    }

    /* ---- 选择视频：只读这一个文件；同目录写权限单独判定 ---- */
    // 注意：/api/record/* 的 id 一律传 base64url（与视频库一致），后端 decodeIdLocal 还原。
    function recSetPick(uri, name) {
        recVideoUri = uri;
        recPick = { id: libB64Url(uri), name: name || '所选视频' };
        var box = $('recPicked');
        if (box) box.style.display = '';
        var nm = $('recPickedName');
        if (nm) nm.textContent = recPick.name;
        var meta = $('recPickedMeta');
        if (meta) meta.textContent = '读取视频信息…';
        var warn = $('recPickedWarn');
        if (warn) warn.textContent = '';
        var grantRow0 = $('recGrantRow');
        if (grantRow0) grantRow0.style.display = 'none';
        recStats('');
        recCanRewrite = false;
        // 换了一个视频 = 上一轮的进度与结果都不再适用，先清干净
        recShowProgress(false);
        recJobEnd();
        recHint('已选视频，正在确认保存位置…', true);
        recProbe();
        recCheck();
    }

    /** 时长 / 分辨率 / 有无音轨：决定音频支路能不能用。 */
    function recProbe() {
        var meta = $('recPickedMeta');
        recPost('/api/record/probe', { id: recPick.id }).then(function (d) {
            if (!meta) return;
            meta.textContent = (d && d.ok)
                ? recFmtDur(d.duration) + ' \u00B7 ' + d.width + '\u00D7' + d.height +
                  (d.hasAudio ? ' \u00B7 有音轨' : ' \u00B7 无音轨') + (d.hasVideo ? '' : ' \u00B7 无画面')
                : ((d && d.error) || '读取视频信息失败');
        }).catch(function () { if (meta) meta.textContent = '读取视频信息失败'; });
    }

    /** 同目录能不能写：不能写就自动弹出文件夹授权，不再依赖手动按钮。 */
    function recCheck() {
        recPost('/api/record/check', { id: recPick.id }).then(function (d) {
            recWritable = !!(d && d.writable);
            var warn = $('recPickedWarn');
            if (recWritable) {
                recHint('已选视频 · 脚本会写在同一个文件夹', true);
                if (warn) warn.textContent = '';
                if (recCanRewrite && recGrantUri) recRewrite();   // v2.7.16：补了授权把现成脚本搬过去
                return;
            }
            // 2.6.63：同目录没写权限不再拦路 —— 脚本会落到应用私有目录，
            // 播放端按视频名自动匹配，效果与写在视频旁边一致。
            // 于是「选视频 → 点开始生成」两步走完，不必再授权一次文件夹。
            recWritable = true;
            recFallback = true;
            if (warn) warn.textContent = ((d && d.reason) || '视频所在目录还没有写入授权') +
                '，脚本会保存到应用目录，播放时自动匹配。';
            var grantRow = $('recGrantRow');
            if (grantRow) grantRow.style.display = '';
            recHint('已选视频 \u00B7 可以直接开始生成', true);
        }).catch(function () {
            // 连自检都没跑通时同样给出口：最坏情况写应用私有目录，依然能生成。
            recWritable = true;
            recFallback = true;
            recHint('已选视频 \u00B7 可以直接开始生成', true);
        });
    }

    function recStart() {
        if (!recPick) { recHint('请先选一个视频', false); libToast('请先选一个视频'); return; }
        // iOS 没有视频逐帧分析管线，/api/record/* 全是未实现：
        // 不拦住的话会一直轮询 status 干等（按钮被禁用时依然可能被程序化触发）。
        if (orbitIsIOS()) { recHint('iOS 版暂不支持自动生成脚本', false); libToast('iOS 版暂不支持自动生成脚本'); return; }
        recShowProgress(true);
        recSetBar(1, '投递任务…');
        recJobBegin('generate');
        recScrollToProgress();
        libToast('开始生成脚本…');
        // ⚠️ 不要在这里先轮询一次：此刻任务还没投递，status 返回的是「未在运行」，
        // 一旦落进收尾分支就会立刻报「生成失败：未知错误」（浏览器回归抓到过）。
        // 立刻可见的反馈交给上一行的 recSetBar(1, '投递任务…')。
        recPost('/api/record/start', { id: recPick.id, options: recReadOptions() })
            .then(function (d) {
                if (!d || !d.ok) {
                    recStopPolling();
                    recShowProgress(false);
                    recSetBusy(false);
                    recJobEnd();
                    var m = ((d && d.error) === 'already_running') ? '已有任务在跑' : ((d && d.error) || '未知错误');
                    recStats('启动失败：' + m);
                    libToast('生成未能启动：' + m);
                    return;
                }
                recSetBusy(true, '生成中…');
                // 投递已确认：从这一刻起，status 里的 running=false 才代表「任务结束」
                recJobStarted = true;
                recStartPolling();
            })
            .catch(function (e) {
                recStopPolling();
                recShowProgress(false);
                recSetBusy(false);
                recJobEnd();
                recStats('启动失败：' + ((e && e.message) || '请求出错'));
                libToast('生成未能启动');
            });
    }

    /** v2.7.16：把最近一次生成的脚本改存到视频同目录（不重跑分析）。 */
    function recRewrite() {
        if (!recCanRewrite || !recGrantUri || !recPick) return;
        recHint('正在改存到视频同目录…', true);
        recPost('/api/record/write', { id: recPick.id, grantUri: recGrantUri })
            .then(function (d) {
                if (d && d.ok) {
                    var warn = $('recPickedWarn'); if (warn) warn.textContent = '';
                    recHint('已改存到视频同目录，回「视频库」打开这个视频会自动加载', true);
                    libToast('脚本已改存到视频同目录');
                } else {
                    recHint('改存失败：' + ((d && d.error) || '未知错误') + '（可再点一次「开始生成」）', false);
                }
            })
            .catch(function () { recHint('改存失败：网络错误', false); });
    }

    function recCancel() {
        recPost('/api/record/cancel', {}).then(function () { recSetBar(0, '正在取消…'); }).catch(function () {});
    }

    function recPollTick() {
        var gen = recPollGen;
        recElapsedTick();
        fetch('/api/record/status', { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (!d) return;
                if (gen !== recPollGen) return;   // 上一代的迟到响应，直接丢
                if (d.message || d.percent != null) recSetBar(d.percent, d.message || d.phase || '');
                if (d.running) {
                    recJobStarted = true;
                    recShowProgress(true);
                    recSetBusy(true, recJobKind === 'preview' ? '预览中…' : '生成中…');
                    recStartLabel(d.percent);
                    return;
                }
                // 两个前提缺一不可：确实有任务在跑（recJobActive），
                // 且它真的开始过（recJobStarted）—— 否则「还没开始」会被误判成「已经结束」。
                if (!recJobActive || !recJobStarted) return;
                // 已无独立「预览」阶段：生成任务的统一收尾在下方，
                // 轮询只负责刷进度，不会在这里发「已生成」的假 toast。
                if (recJobKind === 'preview') return;
                // 由「运行中」变为「结束」：收尾一次
                recSetBusy(false);
                recStopPolling();
                recShowProgress(false);
                recJobEnd();
                if (d.ok) {
                    // v2.7.16：后端如实回 fallback=true 表示脚本落到了应用私有目录，
                    // 文案就要跟着变（过去一律说「已写在视频同目录」，用户去文件管理器找不到）。
                    var fb = !!(d && d.fallback);
                    recCanRewrite = true;
                    recStats('已生成 <b>' + escapeHtml(d.out || '') + '</b> · ' + d.actions + ' 个动作 · 轴 ' +
                        ((d.axes || []).join(' / ') || 'L0') + ' · ' + recFmtDur(d.duration) +
                        (fb ? '\n未拿到视频所在文件夹的写授权，脚本暂存应用目录（播放时会自动匹配）；点「授权保存到视频旁」可改存到视频同目录，不用重新生成。': '\n脚本已写在视频同目录，回「视频库」打开这个视频即会自动加载并跟随。') +
                        '<div class="rec-actions"><button class="tool-btn" id="recGoLib" type="button">去视频库</button></div>');
                    libToast(fb ? '脚本已生成（暂存应用目录）' : ('脚本已生成：' + (d.out || '') + '（' + (d.actions || 0) + ' 个动作）'));
                    if (fb) { var gr2 = $('recGrantRow'); if (gr2) gr2.style.display = ''; }
                    var go = $('recGoLib');
                    if (go) go.addEventListener('click', function () {
                        if (window.OrbitNav && typeof window.OrbitNav.activateTab === 'function') window.OrbitNav.activateTab('home');
                    });
                } else {
                    recStats(recErrText(d));
                    libToast(recErrPlain(d));
                }
            })
            .catch(function () { /* 轮询失败静默，下一轮再试 */ });
    }

    function recStartPolling() {
        if (recPollTimer) return;
        recPollTimer = setInterval(recPollTick, REC_POLL_MS);
    }

    function recStopPolling() {
        if (recPollTimer) { clearInterval(recPollTimer); recPollTimer = null; }
    }

    /** 进入本面板时：把可能还在跑的任务重新接管回来（用户中途切走了页面）。 */
    function recOnShow() {
        fetch('/api/record/status', { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d && d.running) {
                    recShowProgress(true);
                    recSetBusy(true, d.message || '生成中…');
                    // 接管「切走页面时还在跑」的任务：当成 generate，跑完同样要给 toast
                    if (!recJobKind) recJobBegin('generate');
                    recJobStarted = true;
                    recStartLabel(d.percent);
                    recStartPolling();
                }
            })
            .catch(function () {});
    }

    /** 原生桥回调：选完视频文件（uri / 文件名 / 字节数 / 原生侧「同目录已有写授权」的预判）。 */
    window.__onPickVideo = function (uri, name, size, writable) {
        if (!uri) { recHint('已取消选择', false); return; }
        var n = String(name || '');
        var sz = recFmtSize(size);
        if (sz) n = n ? (n + ' \u00B7 ' + sz) : sz;
        recSetPick(uri, n);
        // 2.6.63：不再在这里预告「还要授权」—— 没有同目录写权限也能生成，
        // 脚本会落到应用私有目录。保存位置由 recCheck 最终告知。
        recHint('已选视频，正在确认保存位置…', true);
    };

    /** 原生桥回调：目录授权结果（contains=false = 这个目录罩不住所选视频）。 */
    window.__onGrantFolder = function (uri, writable, contains) {
        if (!uri) { recHint('已取消授权', false); return; }
        recGrantUri = String(uri);   // v2.7.16：临时写权限也留着，改存时直接用
        if (!contains) {
            var warn = $('recPickedWarn');
            if (warn) warn.textContent = '授权目录和视频不在同一个存储提供方，生成时会继续尝试写入；失败则自动保存到应用目录，播放时一样可以匹配。';
            recHint('授权可能不匹配，继续尝试…', true);
        } else {
            recHint('已授权，正在确认…', true);
        }
        recCheck();
    };

    (function initRecordPanel() {
        var pick = $('recPickVideo');
        if (pick) pick.addEventListener('click', function () {
            if (window.Orbit && typeof window.Orbit.pickVideo === 'function') {
                window.Orbit.pickVideo();
            } else {
                recHint('当前环境不支持系统文件选择器', false);
            }
        });
        var gb = $('recGrantBtn');
        if (gb) gb.addEventListener('click', function () {
            if (window.Orbit && typeof window.Orbit.grantRecordFolder === 'function') {
                recHint('已打开文件夹授权，选中视频所在目录即可（拿到写权限后' +
                    (recCanRewrite ? '会把现成的脚本改存过去' : '生成即写入视频同目录') + '）', true);
                window.Orbit.grantRecordFolder();
            } else {
                recHint('当前环境不支持文件夹授权', false);
            }
        });
        var st = $('recStart');
        if (st) st.addEventListener('click', recStart);
        var cx = $('recCancel');
        if (cx) cx.addEventListener('click', recCancel);

        // 滑块数值回显（与自动模式面板同样的 .axis-ctrl-row 形态）
        function bindRange(id, labelId, fmt) {
            var el = $(id), lab = $(labelId);
            if (!el || !lab) return;
            function sync() { lab.textContent = fmt(el.value); }
            el.addEventListener('input', sync);
            sync();
        }
        bindRange('recFps', 'recFpsVal', function (v) { return v + ' \u5e27/\u79d2'; });
        bindRange('recMaxHz', 'recMaxHzVal', function (v) { return (v / 10).toFixed(1) + ' Hz'; });
        bindRange('recSens', 'recSensVal', function (v) { return (v / 100).toFixed(1) + '\u00D7'; });
        bindRange('recSmooth', 'recSmoothVal', function (v) { return v + '%'; });
        bindRange('recOffset', 'recOffsetVal', function (v) { return v + ' ms'; });
        recApplyPlatformGate();
    })();

    /** iOS 降级：整条「视频 → 脚本」的逐帧分析管线在 iOS 上不存在（/api/record/* 均未实现），
        把面板摆成可用只会让人点下去干等。这里直接禁用并给出替代路径：
        导入现成的 .funscript（与视频同名一起导入媒体库即可）。 */
    function recApplyPlatformGate() {
        if (!orbitIsIOS()) return;
        var pick = $('recPickVideo'), st = $('recStart'), gb = $('recGrantBtn');
        [pick, st, gb].forEach(function (btn) {
            if (!btn) return;
            btn.disabled = true;
            btn.style.opacity = '0.45';
            btn.style.cursor = 'not-allowed';
        });
        recHint('iOS 版暂不支持自动生成脚本', false);
        var note = $('recIosNote');
        if (note) note.style.display = '';
    }

    // ── Analyze panel ──────────────────────────────────────
    var analyzePollTimer = null;
    function startAnalyzePolling() {
        loadAnalyzeStatus();
        if (analyzePollTimer) clearInterval(analyzePollTimer);
        analyzePollTimer = setInterval(loadAnalyzeStatus, 2000);
    }
    var btnAnalyzePause = $('btnAnalyzePause');
    var btnAnalyzeResume = $('btnAnalyzeResume');
    var btnAnalyzeStop = $('btnAnalyzeStop');
    if (btnAnalyzePause) btnAnalyzePause.addEventListener('click', function() {
        fetch('/api/analyze/pause', { method: 'POST' }).then(function() { loadAnalyzeStatus(); });
    });
    if (btnAnalyzeResume) btnAnalyzeResume.addEventListener('click', function() {
        fetch('/api/analyze/resume', { method: 'POST' }).then(function() { loadAnalyzeStatus(); });
    });
    if (btnAnalyzeStop) btnAnalyzeStop.addEventListener('click', function() {
        fetch('/api/analyze/stop', { method: 'POST' }).then(function() { loadAnalyzeStatus(); });
    });

    // Scan progress polling
    function renderScanStatus(d) {
        var bar = $('scanProgressBar');
        var fill = $('scanProgressFill');
        var pathEl = $('scanProgressPath');
        var statsEl = $('scanProgressStats');
        var statusText = $('scanStatusText');
        var stopBtn = $('btnScanStop');
        var isScanning = !!(d && d.isScanning);

        if (scanHideTimer) {
            clearTimeout(scanHideTimer);
            scanHideTimer = null;
        }

        if (isScanning) {
            scanPollCount++;
            if (bar) bar.style.display = '';
            if (statusText) {
                statusText.style.display = '';
                statusText.textContent = '扫描 ' + ((d && d.source) || '') + '...';
            }
            if (stopBtn) stopBtn.style.display = '';
            if (fill) {
                var currentWidth = parseFloat(fill.style.width) || 0;
                var nextWidth = Math.min(95, Math.max(currentWidth, 5 + scanPollCount * 3));
                fill.style.width = nextWidth + '%';
            }
            if (pathEl) pathEl.textContent = (d && d.currentPath) || '--';
            if (statsEl) statsEl.textContent = '找到: ' + ((d && d.found) || 0) + ' | NFO: ' + ((d && d.nfoCount) || 0);
            return;
        }

        if (scanPollTimer) {
            clearInterval(scanPollTimer);
            scanPollTimer = null;
        }
        if (stopBtn) stopBtn.style.display = 'none';
        if (pathEl) pathEl.textContent = (d && d.currentPath) || '--';
        if (statsEl) statsEl.textContent = '找到: ' + ((d && d.found) || 0) + ' | NFO: ' + ((d && d.nfoCount) || 0);
        if (bar && bar.style.display !== 'none') {
            if (fill) fill.style.width = '100%';
            if (statusText) {
                statusText.style.display = '';
                statusText.textContent = '扫描完成';
            }
            scanHideTimer = setTimeout(function() {
                if ($('scanProgressBar')) $('scanProgressBar').style.display = 'none';
                if ($('scanStatusText')) $('scanStatusText').style.display = 'none';
            }, 3000);
        } else if (statusText) {
            statusText.style.display = 'none';
        }
    }

    function pollScanStatus() {
        fetch('/api/scan/status').then(function(r){return r.json();}).then(function(d) {
            var wasPolling = !!scanPollTimer;
            if (wasPolling && !d.isScanning && scanWaitTicks > 0) {
                scanWaitTicks--;
                return;
            }
            renderScanStatus(d);
            if (!d.isScanning && wasPolling) {
                loadHome();
                loadLibraryStats();
            }
        }).catch(function() {
            if (scanPollTimer) {
                clearInterval(scanPollTimer);
                scanPollTimer = null;
            }
            var stopBtn = $('btnScanStop');
            if (stopBtn) stopBtn.style.display = 'none';
        });
    }

    function startScanPolling() {
        scanPollCount = 0;
        scanWaitTicks = 3;
        var fill = $('scanProgressFill');
        if (fill) fill.style.width = '0%';
        if (scanPollTimer) clearInterval(scanPollTimer);
        renderScanStatus({ isScanning: true, source: '', currentPath: '--', found: 0, nfoCount: 0 });
        pollScanStatus();
        scanPollTimer = setInterval(pollScanStatus, 1000);
    }
    scanPollingStarter = startScanPolling;

    function resumeScanStatus() {
        fetch('/api/scan/status').then(function(r){return r.json();}).then(function(d) {
            if (d.isScanning) {
                if (!scanPollTimer) startScanPolling();
            } else {
                renderScanStatus(d);
            }
        }).catch(function() {});
    }

    refreshSettingsOnShow = function() {
        loadDashboard();
        loadLibraryStats();
        resumeScanStatus();
        var activePanel = document.querySelector('.settings-panel.active');
        if (activePanel && activePanel.id === 'panel-analyze') startAnalyzePolling();
    };

    // 切换设置分区。原来写在侧栏的点击事件里，现在提出来供深链复用。
    showSettingsPanel = function(name) {
        if (!name) return;
        $$('.sidebar-item').forEach(function(i) { i.classList.remove('active'); });
        $$('.settings-panel').forEach(function(p) { p.classList.remove('active'); });
        var it = document.querySelector('.sidebar-item[data-panel="' + name + '"]');
        if (it) it.classList.add('active');
        var panel = $('panel-' + name);
        if (panel) panel.classList.add('active');
        if (name === 'library') resumeScanStatus();
        if (name === 'analyze') startAnalyzePolling();
        if (name === 'record') recOnShow();
        if (name === 'ver') verRender();
        if (name === 'osr') bgRefresh();
        // 触板页离开/进入要通知触板模块：陀螺仪模式下传感器必须随页面停起，
        // 否则切走了还在按手机姿态下发指令（用户会发现设备自己在动）。
        try {
            if (name === 'touchpad') {
                if (window.__tpPanelEnter) window.__tpPanelEnter();
            } else if (window.__tpPanelLeave) {
                window.__tpPanelLeave();
            }
        } catch (e) { }
        // 脚本编辑页同理：进入通知面板启动（含陀螺仪活动登记），离开通知面板停止录制、停传感器、清空播放器。
        try {
            if (name === 'manualrecord') {
                if (window.__mrPanelEnter) window.__mrPanelEnter();
            } else if (window.__mrPanelLeave) {
                window.__mrPanelLeave();
            }
        } catch (e) { }
    };

    // ── 本机视频目录 ─────────────────────────────────────────
    var btnPickLocalFolder = $('btnPickLocalFolder');
    if (btnPickLocalFolder) btnPickLocalFolder.addEventListener('click', function() {
        if (window.Orbit && typeof window.Orbit.pickFolder === 'function') {
            window.Orbit.pickFolder();
        } else {
            showLocalRootHint('当前环境不支持系统文件夹选择器，请手动输入绝对路径', true);
        }
    });
    var btnSaveLocalRoot = $('btnSaveLocalRoot');
    if (btnSaveLocalRoot) btnSaveLocalRoot.addEventListener('click', function() {
        var el = $('localRootManual');
        var p = el ? el.value.trim() : '';
        if (!p) { showLocalRootHint('请输入目录路径', true); return; }
        saveLocalRoot(p);
    });

    resumeScanStatus();
    loadLocalRoot();
}

function loadDashboard() {
    fetch('/api/status')
        .then(function(r) { return r.json(); })
        .then(function(d) {
            // 平台标识：iOS 把一批安卓专属管线的功能降级（见 applyPlatformGates）
            if (d && d.platform) {
                window.__orbitPlatform = String(d.platform);
                applyPlatformGates();
            }
            // 顶部运行信息块（版本/视频数量/播放状态/时间源/浏览器识别/UA）已按需求移除，
            // 这里只保留「时间源提示同步」与下方 DeoVR 连接面板。
            syncActiveStreamHint(d);
            // DeoVR 连接面板
            loadDeovrPanel(d);
        })
        .catch(function() {});

    // Also fetch dedicated DeoVR status
    fetch('/api/deovr/status')
        .then(function(r) { return r.json(); })
        .then(function(d) { updateDeovrPanelUI(d); })
        .catch(function() {});
}

function loadDeovrPanel(d) {
    updateDeovrPanelUI({
        status: d.deovrConnectionStatus,
        host: '',
        mode: d.deovrConnectionMode,
        streamHint: d.streamHint
    });
}

function pollDeovrStatus() {
    if (deovrPollTimer) {
        clearInterval(deovrPollTimer);
        deovrPollTimer = null;
    }
    var attempts = 0;
    deovrPollTimer = setInterval(function() {
        attempts += 1;
        fetch('/api/deovr/status')
            .then(function(r) { return r.json(); })
            .then(function(d) {
                updateDeovrPanelUI(d);
                // 连着就一直轮询：头显每秒推一帧，进度要持续刷新才能看得见「同步中」。
                // 断开 / 出错 / 试了 30 次仍没连上才收（原来一见 CONNECTED 就停，
                // 真实化后状态是 PLAYING/PAUSED，照旧规则反而不会停，也不会刷新）。
                var stillConnected = (d.connected === true);
                if (!stillConnected && (d.status === 'ERROR' || d.status === 'STOPPED' || attempts >= 30)) {
                    clearInterval(deovrPollTimer);
                    deovrPollTimer = null;
                }
            })
            .catch(function() {
                if (attempts >= 3) {
                    clearInterval(deovrPollTimer);
                    deovrPollTimer = null;
                    updateDeovrPanelUI({ status: 'ERROR' });
                }
            });
    }, 1000);
}

/* ══════════════ VR 蓝牙时间桥 ══════════════
   DeoVR / HereSphere 只有 Wi-Fi 接口，官方没有蓝牙通道；安卓蓝牙网络共享（PAN）
   又要系统级权限。所以蓝牙链路的做法是：头显上也装 Orbit，用本机回环 127.0.0.1
   连同机的 DeoVR 取时间轴，再通过 BLE / SPP 广播；手机端扫描连接后驱动设备。
   两条链路（Wi-Fi / 蓝牙）拿到时间轴后走的是同一套脚本同步逻辑。 */
var vrbtPollTimer = null;
var vrbtScanTimer = null;

function initVrBt() {
    var roleEl = $('vrbtRole');
    var btnScan = $('btnVrbtScan');
    var btnStart = $('btnVrbtStart');
    var btnStop = $('btnVrbtDisconnect');
    if (roleEl) roleEl.addEventListener('change', vrbtSyncRoleUI);
    if (btnScan) btnScan.addEventListener('click', vrbtScan);
    if (btnStart) btnStart.addEventListener('click', vrbtStart);
    if (btnStop) btnStop.addEventListener('click', vrbtDisconnect);
    vrbtSyncRoleUI();
    vrbtRefreshStatus();
    vrbtApplyPlatformGate();
}

/** iOS 降级：VR 蓝牙时间桥（头显端广播时间轴、手机端接收）iOS 端还没实现，
    点「扫描设备」会始终找不到设备（后端只能返回空列表），
    容易让人以为是头显没开广播。直接禁用并指向 DeoVR Wi-Fi 联动。 */
function vrbtApplyPlatformGate() {
    if (!orbitIsIOS()) return;
    ['btnVrbtScan', 'btnVrbtStart', 'btnVrbtDisconnect'].forEach(function (id) {
        var btn = $(id);
        if (!btn) return;
        btn.disabled = true;
        btn.style.opacity = '0.45';
        btn.style.cursor = 'not-allowed';
    });
    var hint = $('vrbtScanHint');
    if (hint) hint.textContent = 'iOS 版暂未实现 VR 蓝牙时间桥';
    var note = $('vrbtIosNote');
    if (note) note.style.display = '';
}

function vrbtSyncRoleUI() {
    var role = $('vrbtRole') ? $('vrbtRole').value : 'sink';
    var srcRow = $('vrbtSourceRow');
    var sinkRow = $('vrbtSinkRow');
    if (srcRow) srcRow.style.display = (role === 'source') ? '' : 'none';
    if (sinkRow) sinkRow.style.display = (role === 'sink') ? '' : 'none';
}

/** 安卓 12+ 扫描/连接蓝牙要运行时权限，没有就先向系统要一次。 */
function vrbtEnsurePermission() {
    try {
        if (typeof window.Orbit === 'undefined') return true;
        if (typeof window.Orbit.hasBluetoothPermission !== 'function') return true;
        if (window.Orbit.hasBluetoothPermission()) return true;
        if (typeof window.Orbit.requestBluetoothPermission === 'function') {
            window.Orbit.requestBluetoothPermission();
        }
        return false;
    } catch (e) { return true; }
}

function vrbtScan() {
    var hint = $('vrbtScanHint');
    var list = $('vrbtDevList');
    if (orbitIsIOS()) { if (hint) hint.textContent = 'iOS 版暂未实现 VR 蓝牙时间桥'; return; }
    if (!vrbtEnsurePermission()) {
        if (hint) hint.textContent = '正在申请蓝牙权限，授权后请重试';
        return;
    }
    if (hint) hint.textContent = '扫描中…';
    if (list) list.innerHTML = '';
    if (vrbtScanTimer) { clearInterval(vrbtScanTimer); vrbtScanTimer = null; }
    fetch('/api/vrbt/scan', { method: 'POST' })
        .then(function () {
            var tries = 0;
            vrbtScanTimer = setInterval(function () {
                tries += 1;
                fetch('/api/vrbt/scan')
                    .then(function (r) { return r.json(); })
                    .then(function (d) {
                        if (d.scanning) {
                            if (tries >= 20) {
                                clearInterval(vrbtScanTimer); vrbtScanTimer = null;
                                if (hint) hint.textContent = '扫描超时';
                            }
                            return;
                        }
                        clearInterval(vrbtScanTimer); vrbtScanTimer = null;
                        vrbtRenderDevices(d.items || []);
                        if (hint) {
                            hint.textContent = (d.items && d.items.length)
                                ? ('找到 ' + d.items.length + ' 个设备，点它连接') : '未找到设备';
                        }
                    })
                    .catch(function () {
                        clearInterval(vrbtScanTimer); vrbtScanTimer = null;
                        if (hint) hint.textContent = '扫描失败';
                    });
            }, 1000);
        })
        .catch(function () { if (hint) hint.textContent = '扫描失败'; });
}

function vrbtRenderDevices(items) {
    var list = $('vrbtDevList');
    if (!list) return;
    if (!items.length) {
        list.innerHTML = '<div class="vrbt-empty">未扫描到设备。请确认对端已开启广播'
            + '（头显端 Orbit 本页角色选「广播时间轴」并点开始）、两端蓝牙都已打开。</div>';
        return;
    }
    list.innerHTML = '';
    items.forEach(function (it) {
        var row = document.createElement('div');
        row.className = 'vrbt-dev';
        var main = document.createElement('div');
        main.className = 'vrbt-dev-main';
        var nm = document.createElement('div');
        nm.className = 'vrbt-dev-name';
        nm.textContent = it.name || it.address;
        var ad = document.createElement('div');
        ad.className = 'vrbt-dev-addr';
        ad.textContent = it.address + (it.bonded ? ' · 已配对' : '');
        main.appendChild(nm);
        main.appendChild(ad);
        var tag = document.createElement('span');
        tag.className = 'vrbt-dev-tag' + (it.isOrbit ? '' : ' vrbt-dev-tag--bonded');
        tag.textContent = it.isOrbit ? 'Orbit' : (it.bonded ? '已配对' : '未知');
        row.appendChild(main);
        row.appendChild(tag);
        row.addEventListener('click', function () { vrbtConnect('sink', it.address); });
        list.appendChild(row);
    });
}

function vrbtStart() {
    var role = $('vrbtRole') ? $('vrbtRole').value : 'sink';
    if (orbitIsIOS()) {
        var h0 = $('vrbtScanHint');
        if (h0) h0.textContent = 'iOS 版暂未实现 VR 蓝牙时间桥，请用 DeoVR Wi-Fi 联动';
        return;
    }
    if (role === 'source') { vrbtConnect('source', ''); return; }
    var hint = $('vrbtScanHint');
    if (hint) hint.textContent = '请先点「扫描设备」，然后在列表里点头显';
}

function vrbtConnect(role, address) {
    if (!vrbtEnsurePermission()) {
        var s = $('dashVrbtStatus');
        if (s) { s.textContent = '正在申请蓝牙权限，授权后请重试'; s.style.color = '#ffd479'; }
        return;
    }
    var body = { role: role };
    if (role === 'source') {
        body.host = ($('vrbtSourceHost') && $('vrbtSourceHost').value.trim()) || '127.0.0.1';
    } else {
        body.address = address;
        body.kind = 'auto';
    }
    fetch('/api/vrbt/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })
        .then(function (r) { return r.json(); })
        .then(function (d) { vrbtRenderStatus(d); vrbtStartPoll(); })
        .catch(function () {
            var el = $('dashVrbtStatus');
            if (el) { el.textContent = '连接失败'; el.style.color = '#ff6b6b'; }
        });
}

function vrbtDisconnect() {
    fetch('/api/vrbt/disconnect', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (d) { vrbtRenderStatus(d); vrbtStopPoll(); })
        .catch(function () { });
}

function vrbtStartPoll() { if (!vrbtPollTimer) vrbtPollTimer = setInterval(vrbtRefreshStatus, 1000); }
function vrbtStopPoll() { if (vrbtPollTimer) { clearInterval(vrbtPollTimer); vrbtPollTimer = null; } }

function vrbtRefreshStatus() {
    fetch('/api/vrbt/status')
        .then(function (r) { return r.json(); })
        .then(function (d) { vrbtRenderStatus(d); })
        .catch(function () { });
}

function vrbtRenderStatus(d) {
    if (!d) return;
    var st = $('dashVrbtStatus');
    var peer = $('dashVrbtPeer');
    var tr = $('dashVrbtTransport');
    var txt = '--', color = '#dce8ee';
    if (d.role === 'SINK') {
        if (d.transport) { txt = '已连接'; color = '#22C55E'; }
        else if (d.error) { txt = d.error; color = '#ff6b6b'; }
        else { txt = '未连接'; }
    } else if (d.role === 'SOURCE') {
        if (d.error) { txt = d.error; color = '#ff6b6b'; }
        else if (d.connected) { txt = '广播中 · 已取到时间轴'; color = '#22C55E'; }
        else { txt = '广播中 · 等待本机 DeoVR…'; color = '#ffd479'; }
    } else {
        txt = '未启用';
    }
    if (st) { st.textContent = txt; st.style.color = color; }
    if (peer) peer.textContent = d.peer || '--';
    if (tr) {
        tr.textContent = (d.transport === 'ble') ? '低功耗蓝牙 BLE'
            : (d.transport === 'spp') ? '蓝牙串口 SPP' : '--';
    }
}

function updateDeovrPanelUI(d) {
    syncActiveStreamHint(d);
    var statusEl = $('dashDeovrStatus');
    var hostEl = $('deovrHost');
    var connectBtn = $('btnDeovrConnect');
    var hereSphereBtn = $('btnHereSphereConnect');
    var disconnectBtn = $('btnDeovrDisconnect');
    if (!statusEl) return;

    var status = d.status || 'STOPPED';
    var mode = String(d.mode || d.deovrConnectionMode || '').toUpperCase();
    var modeLabel = mode === 'HERESPHERE' ? 'HereSphere' : (mode === 'DEOVR' ? 'DeoVR' : '播放器');
    if (d.host && hostEl && !hostEl.disabled) {
        hostEl.value = d.host;
    }
    switch (status) {
        // 2026-10-08：后端真实化后连上就回 PLAYING / PAUSED（不再是笼统的 CONNECTED）。
        // 这两个状态都算「已连接」，必须和 CONNECTED 走同一套 UI，否则会掉进 default 显示「未连接」。
        case 'PLAYING':
        case 'PAUSED':
        case 'CONNECTED':
            var liveNow = (status === 'PLAYING');
            statusEl.textContent = (liveNow ? '同步中 · 播放 ' : '已连接 · 暂停 ')
                + modeLabel + (d.host ? ' (' + d.host + ')' : '');
            statusEl.style.color = liveNow ? '#22C55E' : '#FFA500';
            if (connectBtn) { connectBtn.style.display = 'none'; }
            if (hereSphereBtn) { hereSphereBtn.style.display = 'none'; }
            if (disconnectBtn) { disconnectBtn.style.display = ''; }
            if (hostEl) { if (d.host) hostEl.value = d.host; hostEl.disabled = true; }
            break;
        case 'CONNECTING':
            statusEl.textContent = '连接中...';
            statusEl.style.color = '#FFA500';
            statusEl.textContent = '连接 ' + modeLabel + ' 中...';
            if (connectBtn) { connectBtn.style.display = 'none'; }
            if (hereSphereBtn) { hereSphereBtn.style.display = 'none'; }
            if (disconnectBtn) { disconnectBtn.style.display = ''; }
            if (hostEl) { if (d.host) hostEl.value = d.host; hostEl.disabled = false; }
            break;
        case 'ERROR':
            statusEl.textContent = '连接失败';
            statusEl.style.color = '#EF4444';
            statusEl.textContent = modeLabel + ' 连接失败';
            if (connectBtn) { connectBtn.style.display = ''; }
            if (hereSphereBtn) { hereSphereBtn.style.display = ''; }
            if (disconnectBtn) { disconnectBtn.style.display = 'none'; }
            if (hostEl) hostEl.disabled = false;
            break;
        default:
            statusEl.textContent = '未连接';
            statusEl.style.color = '#8F8F8F';
            statusEl.textContent = '未连接';
            if (connectBtn) { connectBtn.style.display = ''; }
            if (hereSphereBtn) { hereSphereBtn.style.display = ''; }
            if (disconnectBtn) { disconnectBtn.style.display = 'none'; }
            if (hostEl) hostEl.disabled = false;
            break;
    }

    // 影片 / 进度 / 脚本：真实化之后这三行才有意义——用户对不对得上片子、
    // 脚本到底有没有匹配上，全靠它们看出来（之前后端是占位，永远是空的）。
    var titleEl = $('dashDeovrTitle');
    var timeEl = $('dashDeovrTime');
    var scriptEl = $('dashDeovrScript');
    var hasVideo = !!d.title;
    if (titleEl) titleEl.textContent = d.title || '--';
    if (timeEl) timeEl.textContent = fmtVrClock(d.currentTime, d.duration);
    if (scriptEl) {
        if (d.scriptLoaded) {
            scriptEl.textContent = d.scriptName || '已加载';
            scriptEl.style.color = '#22C55E';
        } else if (hasVideo) {
            scriptEl.textContent = '未找到同名脚本';
            scriptEl.style.color = '#EF4444';
        } else {
            scriptEl.textContent = '--';
            scriptEl.style.color = '';
        }
    }
}

/** VR 进度显示：「当前 / 总时长」，超过 1 小时补上小时位。 */
function fmtVrClock(cur, dur) {
    var c = Number(cur || 0), t = Number(dur || 0);
    if (c <= 0 && t <= 0) return '--';
    function hms(s) {
        var v = Math.max(0, Math.floor(s));
        var h = Math.floor(v / 3600), m = Math.floor((v % 3600) / 60), sec = v % 60;
        var mm = h > 0 ? ('0' + m).slice(-2) : String(m);
        return (h > 0 ? h + ':' : '') + mm + ':' + ('0' + sec).slice(-2);
    }
    return t > 0 ? (hms(c) + ' / ' + hms(t)) : hms(c);
}

function loadAnalyzeStatus() {
    fetch('/api/settings/analyze')
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var autoEl = $('analyzeAutoToggle');
            if (autoEl) autoEl.textContent = d.autoAnalyze ? '开启' : '关闭';
            var toggleBtn = $('btnAnalyzeToggle');
            if (toggleBtn) {
                toggleBtn.textContent = d.autoAnalyze ? '关闭自动分析' : '开启自动分析';
                toggleBtn.onclick = function() {
                    fetch('/api/settings/analyze', {
                        method: 'POST',
                        body: JSON.stringify({ autoAnalyze: !d.autoAnalyze })
                    }).then(function() { loadAnalyzeStatus(); });
                };
            }
        })
        .catch(function() {});
    fetch('/api/analyze/status')
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var statusEl = $('analyzeStatus');
            var progressEl = $('analyzeProgress');
            var currentEl = $('analyzeCurrent');
            var durEl = $('analyzeDurationDone');
            var covEl = $('analyzeCoverDone');
            if (statusEl) statusEl.textContent = d.running ? (d.paused ? '已暂停' : '运行中') : '空闲';
            if (progressEl) progressEl.textContent = d.total > 0 ? d.checked + ' / ' + d.total : '--';
            if (currentEl) currentEl.textContent = d.current || '--';
            if (durEl) durEl.textContent = d.durationFilled;
            if (covEl) covEl.textContent = d.coversGenerated;

            var pauseBtn = $('btnAnalyzePause');
            var resumeBtn = $('btnAnalyzeResume');
            var stopBtn = $('btnAnalyzeStop');
            if (d.running && !d.paused) {
                if (pauseBtn) pauseBtn.style.display = '';
                if (resumeBtn) resumeBtn.style.display = 'none';
                if (stopBtn) stopBtn.style.display = '';
            } else if (d.running && d.paused) {
                if (pauseBtn) pauseBtn.style.display = 'none';
                if (resumeBtn) resumeBtn.style.display = '';
                if (stopBtn) stopBtn.style.display = '';
            } else {
                if (pauseBtn) pauseBtn.style.display = 'none';
                if (resumeBtn) resumeBtn.style.display = 'none';
                if (stopBtn) stopBtn.style.display = 'none';
            }
        })
        .catch(function() {});
}

function loadLibraryStats() {
    return loadLibraries();
}

function renderLibraryStats() {
    renderMediaLibraryList();
}

// SMB
function toggleSmbCredentials() {
    var cb = $('smbAnonymous');
    if (!cb) return;
    var anon = cb.checked;
    $('smbUser').disabled = anon;
    $('smbPass').disabled = anon;
    if (anon) {
        $('smbUser').value = '';
        $('smbPass').value = '';
    }
}

function loadSmbSettings() {
    fetch('/api/settings/smb')
        .then(function(r){return r.json();})
        .then(function(d) {
            $('smbHost').value = d.host || '';
            $('smbShare').value = d.share || '';
            $('smbUser').value = d.username || '';
            $('smbPass').value = '';
            $('smbPass').placeholder = d.hasPassword ? '已设置（留空保持不变）' : '可选';
            $('smbAnonymous').checked = !!d.anonymous;
            toggleSmbCredentials();
        });
}

function saveSmb() {
    fetch('/api/settings/smb', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
            host: $('smbHost').value,
            share: $('smbShare').value,
            username: $('smbAnonymous').checked ? '' : $('smbUser').value,
            password: $('smbAnonymous').checked ? '' : $('smbPass').value,
            anonymous: $('smbAnonymous').checked
        })
    }).then(function() {
        var hint = $('smbHint');
        if (hint) hint.textContent = '已保存，请在仪表盘手动扫描';
        showHint(hint);
        loadDashboard();
        if (tabInited['folder']) browsePath('smb', '');
    });
}

function buildSmbLibraryRoot() {
    var host = ($('smbHost') ? $('smbHost').value : '').trim().replace(/^smb:\/\//i, '').replace(/\/+$/, '');
    var share = ($('smbShare') ? $('smbShare').value : '').trim().replace(/^\/+|\/+$/g, '');
    if (!host || !share) return '';
    return 'smb://' + host + '/' + share + '/';
}

function addSmbLibrary() {
    var rootPath = buildSmbLibraryRoot();
    var hint = $('smbHint');
    if (!rootPath) {
        if (hint) {
            hint.textContent = '请先填写主机和访问目录';
            showHint(hint);
        }
        return;
    }
    var segments = rootPath.replace(/\/+$/, '').split('/');
    var inputName = $('smbLibraryName') ? $('smbLibraryName').value.trim() : '';
    var name = inputName || segments[segments.length - 1] || 'SMB 媒体库';
    fetch('/api/libraries', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
            type: 'smb',
            rootPath: rootPath,
            name: name
        })
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
        if (d.error) throw new Error(d.error);
        if (hint) {
            hint.textContent = '已添加为媒体库，请在仪表盘扫描';
            showHint(hint);
        }
        return loadLibraries();
    })
    .then(function() {
        if (mediaLibraries.length) {
            var added = mediaLibraries.filter(function(lib) {
                return (lib.rootPath || '').replace(/\/+$/, '') === rootPath.replace(/\/+$/, '');
            }).pop();
            if (added) setActiveLibrary(added.id, true);
        }
    })
    .catch(function(e) {
        if (hint) {
            hint.textContent = '添加失败: ' + (e.message || '未知错误');
            showHint(hint);
        }
    });
}

// ─── SMB Directory Picker ──────────────────────────────────

var smbBrowsePath = '';
var smbBrowseRequestId = 0;

function openSmbBrowser() {
    var host = $('smbHost').value.trim();
    if (!host) {
        $('smbHost').focus();
        return;
    }
    smbBrowsePath = '';
    $('smbBrowseModal').style.display = '';
    $('btnSelectDir').disabled = true;
    loadSmbDir('');
}

function closeSmbBrowser() {
    smbBrowseRequestId++;
    $('smbBrowseModal').style.display = 'none';
}

function loadSmbDir(path) {
    var requestId = ++smbBrowseRequestId;
    var listEl = $('smbModalList');
    var pathEl = $('smbModalPath');
    var bcEl = $('smbModalBreadcrumb');
    var btnSelect = $('btnSelectDir');

    listEl.innerHTML = '<div class="spinner">加载中...</div>';
    pathEl.textContent = path ? '/' + path : '/ (根目录)';
    btnSelect.disabled = true;

    renderBreadcrumb(bcEl, path, function(nextPath) {
        loadSmbDir(nextPath);
    });

    var host = $('smbHost').value.trim();
    var user = $('smbUser').value;
    var pass = $('smbPass').value;
    var url = '/api/smb/browse?host=' + encodeURIComponent(host) +
        '&username=' + encodeURIComponent(user) +
        '&password=' + encodeURIComponent(pass) +
        '&path=' + encodeURIComponent(path);

    fetch(url)
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (requestId !== smbBrowseRequestId) return;
            if (d.error) {
                listEl.innerHTML = '<div class="modal-error">' + escapeHtml(d.error) + '</div>';
                return;
            }
            // Only commit path on successful load
            smbBrowsePath = path;
            btnSelect.disabled = false;
            var items = d.items || [];
            if (items.length === 0) {
                listEl.innerHTML = '<div class="modal-empty">此目录下无子文件夹</div>';
                return;
            }
            listEl.innerHTML = items.map(function(item) {
                var itemPath = path ? path + '/' + item.name : item.name;
                return '<div class="dir-item" data-dir-path="' + escapeHtml(itemPath) + '">' +
                    '<img class="dir-item-icon" src="/icons/folder.png" alt="">' +
                    '<span class="dir-item-name">' + escapeHtml(item.name) + '</span>' +
                    '<img class="dir-item-arrow" src="/icons/chevron_right_128dp.png" alt=">">' +
                '</div>';
            }).join('');
            $$('.dir-item', listEl).forEach(function(el) {
                el.addEventListener('click', function() {
                    loadSmbDir(el.dataset.dirPath);
                });
            });
        })
        .catch(function(e) {
            if (requestId !== smbBrowseRequestId) return;
            listEl.innerHTML = '<div class="modal-error">连接失败</div>';
        });
}

function selectSmbDir() {
    if ($('btnSelectDir').disabled) return;
    $('smbShare').value = smbBrowsePath;
    closeSmbBrowser();
}

// ─── SMB 快捷浏览（播放器「选择文件夹」旁的 SMB 网络按钮）──────────
// 流程：点「SMB 网络」→ 配置弹窗（IP / 共享名 / 用户 / 密码 / 匿名）
//       → 连接后浏览共享目录 → 点视频直接在内嵌播放器播放（同名 .funscript 自动加载）。
var smbqCreds = { host: '', share: '', user: '', pass: '', domain: '', anonymous: false };
var smbqPath = '';
var smbqRequestId = 0;
var smbqItemsCache = [];   // 当前 SMB 目录条目（含视频），供播放列表与渲染复用

function initSmbQuick() {
    var b;
    b = $('libBtnSmb');                 if (b) b.addEventListener('click', openSmbQuickConfig);
    b = $('btnSmbQuickConfigClose');    if (b) b.addEventListener('click', closeSmbQuickConfig);
    b = $('btnSmbQuickConfigCancel');   if (b) b.addEventListener('click', closeSmbQuickConfig);
    b = $('btnSmbQuickConnect');        if (b) b.addEventListener('click', connectSmbQuick);
    b = $('btnSmbQuickBrowseClose');    if (b) b.addEventListener('click', closeSmbQuickBrowse);
    b = $('smbqAnonymous');             if (b) b.addEventListener('change', smbqToggleCred);
}

function smbqToggleCred() {
    var anon = $('smbqAnonymous') && $('smbqAnonymous').checked;
    var creds = document.querySelectorAll('.smbq-cred');
    creds.forEach(function(el){ el.style.display = anon ? 'none' : ''; });
    if ($('smbqUser')) $('smbqUser').disabled = anon;
    if ($('smbqPass')) $('smbqPass').disabled = anon;
}

function openSmbQuickConfig() {
    fetch('/api/settings/smb')
        .then(function(r){ return r.json(); })
        .then(function(d){
            if ($('smbqHost')) $('smbqHost').value = d.host || '';
            if ($('smbqShare')) $('smbqShare').value = d.share || '';
            if ($('smbqUser')) $('smbqUser').value = d.username || '';
            if ($('smbqDomain')) $('smbqDomain').value = d.domain || '';
            if ($('smbqAnonymous')) $('smbqAnonymous').checked = !!d.anonymous;
            if ($('smbqPass')) { $('smbqPass').value = ''; $('smbqPass').placeholder = d.hasPassword ? '已设置（留空保持不变）' : '可选'; }
            smbqToggleCred();
        })
        .catch(function(){});
    var err = $('smbqError'); if (err) err.style.display = 'none';
    var m = $('smbQuickConfigModal');
    if (m) m.style.display = 'flex';   // 显式 flex：不依赖 CSS 回退，且弹窗已移到 body 顶层（曾嵌在隐藏的 #panel-smb 内导致点击无反应）
}

function closeSmbQuickConfig() { $('smbQuickConfigModal').style.display = 'none'; }

function connectSmbQuick() {
    var host = ($('smbqHost') ? $('smbqHost').value : '').trim();
    if (!host) {
        var err = $('smbqError');
        if (err) { err.textContent = '请填写主机地址（IP）'; err.style.display = ''; }
        if ($('smbqHost')) $('smbqHost').focus();
        return;
    }
    var share = ($('smbqShare') ? $('smbqShare').value : '').trim();
    var anonymous = $('smbqAnonymous') ? $('smbqAnonymous').checked : false;
    var user = anonymous ? '' : (($('smbqUser') ? $('smbqUser').value : '').trim());
    var pass = anonymous ? '' : (($('smbqPass') ? $('smbqPass').value : '').trim());
    var domain = anonymous ? '' : (($('smbqDomain') ? $('smbqDomain').value : '').trim());
    smbqCreds = { host: host, share: share, user: user, pass: pass, domain: domain, anonymous: anonymous };
    // 持久化到 SMB 设置：既供下次预填，也供同名脚本加载（findLibForRawSmb 兜底读取）
    fetch('/api/settings/smb', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: host, share: share, username: user, password: pass, domain: domain, anonymous: anonymous })
    }).catch(function(){});
    closeSmbQuickConfig();
    openSmbQuickBrowse('');
}

function closeSmbQuickBrowse() {
    smbqRequestId++;
    $('smbQuickBrowseModal').style.display = 'none';
    smbqItemsCache = [];
}

function openSmbQuickBrowse(path) {
    smbqPath = path;
    smbqRequestId++;
    var rid = smbqRequestId;
    var bm = $('smbQuickBrowseModal');
    if (bm) bm.style.display = 'flex';   // 显式 flex：不依赖 CSS 回退
    var listEl = $('smbqList');
    listEl.innerHTML = '<div class="spinner">连接中...</div>';
    var pathEl = $('smbqPath');
    if (pathEl) pathEl.textContent = path ? '/' + path : '/ (根目录)';
    renderBreadcrumb($('smbqBreadcrumb'), path, function(nextPath){ openSmbQuickBrowse(nextPath); }, smbqCreds.share || smbqCreds.host);
    var c = smbqCreds;
    var url = '/api/smb/browse?host=' + encodeURIComponent(c.host) +
        '&share=' + encodeURIComponent(c.share) +
        '&username=' + encodeURIComponent(c.user) +
        '&password=' + encodeURIComponent(c.pass) +
        '&anonymous=' + (c.anonymous ? '1' : '0') +
        '&domain=' + encodeURIComponent(c.domain) +
        '&files=1' +
        '&path=' + encodeURIComponent(path);
    fetch(url)
        .then(function(r){ return r.json(); })
        .then(function(d){
            if (rid !== smbqRequestId) return;
            if (d.error) {
                var errHtml = '<div class="modal-error">' + escapeHtml(d.error) + '</div>';
                if (d.debug) {
                    errHtml += '<div class="smbq-debug" style="margin-top:10px;padding:10px;background:rgba(0,0,0,0.3);border-radius:6px;font-family:monospace;font-size:12px;white-space:pre-wrap;word-break:break-all;color:#aaa;max-height:240px;overflow:auto;user-select:text;-webkit-user-select:text;">' +
                        escapeHtml(JSON.stringify(d.debug, null, 2)) + '</div>' +
                        '<button class="smbq-copy-debug" style="margin-top:8px;padding:6px 12px;background:#5a3d8a;border:none;border-radius:4px;color:#fff;font-size:12px;">复制调试信息</button>' +
                        '<div style="margin-top:6px;font-size:11px;color:#888;">若按钮无效，可直接长按上方文字手动复制</div>';
                }
                listEl.innerHTML = errHtml;
                if (d.debug) {
                    var copyBtn = listEl.querySelector('.smbq-copy-debug');
                    if (copyBtn) copyBtn.addEventListener('click', function(){
                        var text = JSON.stringify(d.debug, null, 2);
                        function reset(label){ setTimeout(function(){ copyBtn.textContent = label || '复制调试信息'; }, 1600); }
                        function done(){ copyBtn.textContent = '已复制 ✓'; reset('复制调试信息'); }
                        function fail(){ copyBtn.textContent = '复制失败，请长按上方文字'; reset('复制调试信息'); }
                        function fallback(){
                            try {
                                var ta = document.createElement('textarea');
                                ta.value = text;
                                ta.setAttribute('readonly', '');
                                ta.style.position = 'fixed';
                                ta.style.top = '-1000px';
                                ta.style.left = '-1000px';
                                document.body.appendChild(ta);
                                ta.focus();
                                ta.select();
                                if (ta.setSelectionRange) ta.setSelectionRange(0, text.length);
                                var ok = document.execCommand && document.execCommand('copy');
                                document.body.removeChild(ta);
                                if (ok) done(); else fail();
                            } catch(e) { fail(); }
                        }
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                            navigator.clipboard.writeText(text).then(done).catch(function(){ fallback(); });
                        } else {
                            fallback();
                        }
                    });
                }
                return;
            }
            var items = (d.items || []);
            smbqItemsCache = items;
            if (items.length === 0) {
                // 后端会给出 emptyHint：区分「共享名/路径不对」与「真没有视频文件」，
                // 不再一律显示「此目录下没有内容」——那句会把连接失败也糊成「没内容」。
                listEl.innerHTML = '<div class="modal-empty">' + escapeHtml(d.emptyHint || '此目录下没有内容') + '</div>';
                return;
            }
            listEl.innerHTML = items.map(function(item){
                var safeName = escapeHtml(item.name);
                if (item.isDir) {
                    return '<div class="dir-item" data-dir-path="' + escapeHtml(item.path) + '">' +
                        '<img class="dir-item-icon" src="/icons/folder.png" alt="">' +
                        '<span class="dir-item-name">' + safeName + '</span>' +
                        '<img class="dir-item-arrow" src="/icons/chevron_right_128dp.png" alt=">">' +
                    '</div>';
                }
                return '<div class="smbq-file" data-file-path="' + escapeHtml(item.path) + '" data-file-name="' + safeName + '">' +
                    '<img class="dir-item-icon" src="/icons/video_library_128dp.png" alt="">' +
                    '<span class="dir-item-name">' + safeName + '</span>' +
                    '<span class="smbq-play">▶ 播放</span>' +
                '</div>';
            }).join('');
            $$('.dir-item', listEl).forEach(function(el){
                el.addEventListener('click', function(){
                    // 共享名留空时列出的是「共享列表」，此时每个 dir-item 其实是一个共享名；
                    // 旧逻辑把它当 path 拼在空 share 后面，会生成 smb://host/Share/ 这种错误 URL，
                    // Windows 会报「登录失败或拒绝访问」。这里把第一段路径提升为 share。
                    if (!smbqCreds.share) {
                        smbqCreds.share = el.dataset.dirPath;
                        openSmbQuickBrowse('');
                    } else {
                        openSmbQuickBrowse(el.dataset.dirPath);
                    }
                });
            });
            $$('.smbq-file', listEl).forEach(function(el){
                el.addEventListener('click', function(){
                    playSmbQuickVideo({ path: el.dataset.filePath, name: el.dataset.fileName });
                });
            });
        })
        .catch(function(){
            if (rid !== smbqRequestId) return;
            listEl.innerHTML = '<div class="modal-error">连接失败，请检查地址、共享名与账号</div>';
        });
}

function playSmbQuickVideo(item) {
    // 用当前 SMB 目录的视频列表作为播放列表（顺序/随机挑下一部）
    libSmbQuickItems = smbqItemsCache.filter(function(it){ return it && !it.isDir; });
    closeSmbQuickBrowse();
    libPlay(item);
}

// ─── Library Edit Path Browser ─────────────────────────────

var pathBrowseRequestId = 0;
var pathBrowseCurrentPath = '';
var pathBrowseRootLabel = '根目录';
var pathBrowseRootInfo = '';

function openPathBrowser() {
    pathBrowseCurrentPath = '';
    pathBrowseRequestId++;
    $('pathBrowseModal').style.display = '';
    $('btnSelectPath').disabled = true;
    var typeEl = $('libraryEditType');
    var browseType = typeEl ? typeEl.value : 'local';
    var rootDisplay = $('libraryEditRootDisplay');

    // Root info bar: show the user-friendly display text (e.g. "smb://192.168.1.100/movies", "本地")
    pathBrowseRootInfo = rootDisplay ? (rootDisplay.textContent || '根目录') : '根目录';

    // Breadcrumb root label: short label (e.g. "movies", "本地")
    if (browseType === 'local') {
        pathBrowseRootLabel = '本地';
    } else {
        // Extract share name from last segment of SMB path
        var infoText = pathBrowseRootInfo.replace(/\/+$/, '');
        var segments = infoText.split('/');
        pathBrowseRootLabel = segments[segments.length - 1] || 'SMB';
    }

    if ($('pathBrowseTitle')) $('pathBrowseTitle').textContent = browseType === 'smb' ? '选择 SMB 目录' : '选择本地目录';
    updateBrowseRootInfo();
    loadBrowseDir(browseType, '');
}

function updateBrowseRootInfo() {
    var infoEl = $('pathBrowseRootInfo');
    var labelEl = $('pathBrowseRootLabel');
    if (infoEl) infoEl.style.display = '';
    if (labelEl) labelEl.textContent = pathBrowseRootInfo;
}

function closePathBrowser() {
    pathBrowseRequestId++;
    $('pathBrowseModal').style.display = 'none';
}

function loadBrowseDir(type, path) {
    var requestId = ++pathBrowseRequestId;
    var listEl = $('pathBrowseList');
    var dispEl = $('pathBrowseDisplay');
    var bcEl = $('pathBrowseBreadcrumb');
    var btnSelect = $('btnSelectPath');

    listEl.innerHTML = '<div class="spinner">加载中...</div>';
    dispEl.textContent = path ? path : (pathBrowseRootLabel + ' /');
    btnSelect.disabled = true;

    renderBreadcrumb(bcEl, path, function(nextPath) {
        loadBrowseDir(type, nextPath);
    }, pathBrowseRootLabel);

    if (type === 'smb') {
        // For SMB, use the configured SMB settings
        fetch('/api/browse/smb?path=' + encodeURIComponent(path))
            .then(function(r) { return r.json(); })
            .then(function(d) {
                if (requestId !== pathBrowseRequestId) return;
                if (d.error) {
                    listEl.innerHTML = '<div class="modal-error">' + escapeHtml(d.error) + '</div>';
                    return;
                }
                pathBrowseCurrentPath = d.path || path;
                btnSelect.disabled = false;
                renderBrowseDirs(listEl, d.items, type, d.path || path);
            })
            .catch(function(e) {
                if (requestId !== pathBrowseRequestId) return;
                listEl.innerHTML = '<div class="modal-error">SMB 连接失败，请先在 SMB 网络共享中配置连接</div>';
            });
    } else {
        // Local browse
        fetch('/api/browse/local?path=' + encodeURIComponent(path))
            .then(function(r) { return r.json(); })
            .then(function(d) {
                if (requestId !== pathBrowseRequestId) return;
                if (d.error) {
                    listEl.innerHTML = '<div class="modal-error">' + escapeHtml(d.error) + '</div>';
                    return;
                }
                pathBrowseCurrentPath = d.path || path;
                btnSelect.disabled = false;
                renderBrowseDirs(listEl, d.items, type, d.path || path);
            })
            .catch(function(e) {
                if (requestId !== pathBrowseRequestId) return;
                listEl.innerHTML = '<div class="modal-error">浏览失败</div>';
            });
    }
}

function renderBrowseDirs(listEl, items, type, currentPath) {
    var dirs = (items || []).filter(function(item) { return item.isDir; });
    if (dirs.length === 0) {
        listEl.innerHTML = '<div class="modal-empty">此目录下无子文件夹</div>';
        return;
    }
    listEl.innerHTML = dirs.map(function(item) {
        // 后端给出的条目路径优先（本机是绝对路径，SMB 是共享内相对路径）
        var itemPath = item.path ? item.path : (currentPath ? currentPath + '/' + item.name : item.name);
        return '<div class="dir-item" data-dir-path="' + escapeHtml(itemPath) + '">' +
            '<img class="dir-item-icon" src="/icons/folder.png" alt="">' +
            '<span class="dir-item-name">' + escapeHtml(item.name) + '</span>' +
            '<img class="dir-item-arrow" src="/icons/chevron_right_128dp.png" alt="&gt;">' +
        '</div>';
    }).join('');
    $$('.dir-item', listEl).forEach(function(el) {
        el.addEventListener('click', function() {
            loadBrowseDir(type, el.dataset.dirPath);
        });
    });
}

function selectBrowsedPath() {
    if ($('btnSelectPath').disabled) return;
    var pathEl = $('libraryEditPath');
    if (pathEl) pathEl.value = pathBrowseCurrentPath;
    closePathBrowser();
}

// ─── Axes Settings ─────────────────────────────────────────

var AXIS_NAMES = {
    L0: '上下 (Stroke)', L1: '前后 (Surge)', L2: '左右 (Sway)',
    R0: '旋转 (Twist)', R1: '俯仰 (Roll)',  R2: '翻滚 (Pitch)'
};
var AXIS_ORDER = ['L0', 'L1', 'L2', 'R0', 'R1', 'R2'];
var axisData = {};

function loadAxesSettings() {
    fetch('/api/settings/axes')
        .then(function(r) { return r.json(); })
        .then(function(d) {
            axisData = d.axes || {};
            renderAxesUI();
        })
        .catch(function() {
            $('axisContainer').innerHTML = '<div style="color:#666">加载失败</div>';
        });
}

function renderAxesUI() {
    var container = $('axisContainer');
    if (!container) return;

    // Tabs + panels
    var html = '<div class="axis-tabs">';
    AXIS_ORDER.forEach(function(axis, i) {
        html += '<div class="axis-tab' + (i === 0 ? ' active' : '') + '" data-axis="' + axis + '">' + axis + '</div>';
    });
    html += '</div>';

    AXIS_ORDER.forEach(function(axis, i) {
        var cfg = axisData[axis] || { reversed: false, min: 0, max: 9999, scale: 1.0 };
        var scalePct = Math.round((cfg.scale || 1.0) * 100);
        html += '<div class="axis-detail' + (i === 0 ? ' active' : '') + '" id="axisDetail-' + axis + '">';
        html += '<div class="axis-detail-title">' + AXIS_NAMES[axis] + '</div>';

        // Reverse toggle
        html += '<div class="axis-ctrl-row">' +
            '<span class="axis-ctrl-label">反转</span>' +
            '<div class="toggle' + (cfg.reversed ? ' on' : '') + '" id="axisRev-' + axis + '"></div>' +
            '</div>';

        // Min slider
        html += '<div class="axis-ctrl-row">' +
            '<span class="axis-ctrl-label">最小值</span>' +
            '<input type="range" class="axis-slider" id="axisMin-' + axis + '" min="0" max="9999" value="' + cfg.min + '">' +
            '<span class="axis-ctrl-value" id="axisMinVal-' + axis + '">' + cfg.min + '</span>' +
            '</div>';

        // Max slider
        html += '<div class="axis-ctrl-row">' +
            '<span class="axis-ctrl-label">最大值</span>' +
            '<input type="range" class="axis-slider" id="axisMax-' + axis + '" min="0" max="9999" value="' + cfg.max + '">' +
            '<span class="axis-ctrl-value" id="axisMaxVal-' + axis + '">' + cfg.max + '</span>' +
            '</div>';

        // Scale slider
        html += '<div class="axis-ctrl-row">' +
            '<span class="axis-ctrl-label">振幅</span>' +
            '<input type="range" class="axis-slider" id="axisScale-' + axis + '" min="0" max="200" step="5" value="' + scalePct + '">' +
            '<span class="axis-ctrl-value" id="axisScaleVal-' + axis + '">' + scalePct + '%</span>' +
            '</div>';

        html += '</div>';
    });

    container.innerHTML = html;

    // Bind tab switching
    $$('.axis-tab', container).forEach(function(tab) {
        tab.addEventListener('click', function() {
            $$('.axis-tab', container).forEach(function(t) { t.classList.remove('active'); });
            $$('.axis-detail', container).forEach(function(p) { p.classList.remove('active'); });
            tab.classList.add('active');
            var detail = $('axisDetail-' + tab.dataset.axis);
            if (detail) detail.classList.add('active');
        });
    });

    // Bind toggles
    AXIS_ORDER.forEach(function(axis) {
        var toggle = $('axisRev-' + axis);
        if (toggle) toggle.addEventListener('click', function() {
            toggle.classList.toggle('on');
        });

        // Bind sliders
        ['Min', 'Max', 'Scale'].forEach(function(prop) {
            var slider = $('axis' + prop + '-' + axis);
            var valEl = $('axis' + prop + 'Val-' + axis);
            if (slider && valEl) {
                slider.addEventListener('input', function() {
                    valEl.textContent = prop === 'Scale' ? slider.value + '%' : slider.value;
                });
            }
        });
    });
}

function saveAxes() {
    var configs = {};
    AXIS_ORDER.forEach(function(axis) {
        var revEl = $('axisRev-' + axis);
        var minEl = $('axisMin-' + axis);
        var maxEl = $('axisMax-' + axis);
        var scaleEl = $('axisScale-' + axis);
        configs[axis] = {
            reversed: revEl ? revEl.classList.contains('on') : false,
            min: minEl ? parseInt(minEl.value) : 0,
            max: maxEl ? parseInt(maxEl.value) : 9999,
            scale: scaleEl ? parseInt(scaleEl.value) / 100.0 : 1.0
        };
    });

    fetch('/api/settings/axes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ axes: configs })
    }).then(function() {
        showHint($('axesHint'));
    });
}

// ─── Detail Actions ──────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {
    bindImageFallbacks(document);
    var btnRefreshNfo = $('btnRefreshNfo');
    var btnRegenThumb = $('btnRegenThumb');
    var btnEditItemMetadata = $('btnEditItemMetadata');
    var btnPlayHereSphere = $('btnPlayHereSphere');
    var btnFavorite = $('btnFavorite');
    if (btnRefreshNfo) {
        btnRefreshNfo.addEventListener('click', function() {
            if (!currentDetailId) return;
            fetch('/api/items/' + currentDetailId + '/refresh-nfo', { method: 'POST' })
                .then(function(r) { return r.json(); })
                .then(function(d) {
                    thumbnailRefreshToken = String(Date.now());
                    if (d && d.item) {
                        showDetail(d.item);
                        clearGridCaches();
                        alert('NFO 已刷新');
                    } else if (d && d.error) {
                        alert('NFO 刷新失败: ' + d.error);
                    } else {
                        showItemDetail(currentDetailId, false);
                        alert('NFO 已刷新');
                    }
                })
                .catch(function() { alert('NFO 刷新失败'); });
        });
    }
    if (btnRegenThumb) {
        btnRegenThumb.addEventListener('click', function() {
            if (!currentDetailId) return;
            fetch('/api/items/' + currentDetailId + '/regenerate-thumb', { method: 'POST' })
                .then(function() {
                    thumbnailRefreshToken = String(Date.now());
                    var thumb = $('detailThumb');
                    if (thumb) {
                        thumb.style.display = '';
                        thumb.src = itemPosterSrc(currentDetailId);
                    }
                    clearGridCaches();
                    alert('封面重新生成已触发');
                });
        });
    }
    if (btnEditItemMetadata) {
        btnEditItemMetadata.addEventListener('click', function(e) {
            e.stopPropagation();
            if (moreMenu) moreMenu.style.display = 'none';
            openItemMetadataModal();
        });
    }
    if (btnPlayHereSphere) {
        btnPlayHereSphere.addEventListener('click', function(e) {
            e.stopPropagation();
            if (moreMenu) moreMenu.style.display = 'none';
            var url = buildCurrentHereSpherePlayUrl();
            if (!url) {
                alert('没有可播放的视频');
                return;
            }
            recordCurrentDetailPlay();
            openHereSphereVideo(url, buildCurrentHereSphereDownloadName());
        });
    }
    var detailContinuePlay = $('detailContinuePlay');
    if (detailContinuePlay) {
        detailContinuePlay.addEventListener('click', function(e) {
            var href = detailContinuePlay.href;
            if (!href) return;
            recordCurrentDetailPlay();
            if (!isHereSpherePlaybackActive()) return;
            e.preventDefault();
            openHereSphereVideo(href, buildCurrentHereSphereDownloadName());
        });
    }
    var detailPartsGrid = $('detailPartsGrid');
    if (detailPartsGrid) {
        detailPartsGrid.addEventListener('click', function(e) {
            var card = e.target.closest('.part-card');
            if (!card) return;
            recordCurrentDetailPlay();
            if (!isHereSpherePlaybackActive()) return;
            e.preventDefault();
            var nameEl = card.querySelector('.part-card-name');
            var downloadName = nameEl ? nameEl.textContent.trim() : buildCurrentHereSphereDownloadName();
            openHereSphereVideo(card.href, downloadName);
        });
    }
    if (btnFavorite) {
        btnFavorite.addEventListener('click', function() {
            toggleCurrentFavorite();
        });
    }
    // More actions dropdown
    var btnMore = $('btnMoreActions');
    var moreMenu = $('detailMoreMenu');
    document.addEventListener('click', closeMediaLibraryMenus);
    if (btnMore && moreMenu) {
        btnMore.addEventListener('click', function(e) {
            e.stopPropagation();
            moreMenu.style.display = moreMenu.style.display === 'none' ? '' : 'none';
        });
        document.addEventListener('click', function() {
            moreMenu.style.display = 'none';
        });
    }

    var btnEditActor = $('btnEditActor');
    var btnActorMore = $('btnActorMoreActions');
    var actorMoreMenu = $('actorMoreMenu');
    var btnCloseActorEdit = $('btnCloseActorEdit');
    var btnActorPhotoPick = $('btnActorPhotoPick');
    var actorPhotoInput = $('actorPhotoInput');
    var btnSaveActorEdit = $('btnSaveActorEdit');
    var actorEditModal = $('actorEditModal');
    var btnCloseItemEdit = $('btnCloseItemEdit');
    var btnSaveItemEdit = $('btnSaveItemEdit');
    var itemEditModal = $('itemEditModal');
    if (btnActorMore && actorMoreMenu) {
        btnActorMore.addEventListener('click', function(e) {
            e.stopPropagation();
            actorMoreMenu.style.display = actorMoreMenu.style.display === 'none' ? '' : 'none';
        });
        document.addEventListener('click', function() {
            actorMoreMenu.style.display = 'none';
        });
    }
    if (btnEditActor) btnEditActor.addEventListener('click', function(e) {
        e.stopPropagation();
        if (actorMoreMenu) actorMoreMenu.style.display = 'none';
        openActorEditModal();
    });
    if (btnCloseActorEdit) btnCloseActorEdit.addEventListener('click', closeActorEditModal);
    if (btnActorPhotoPick) btnActorPhotoPick.addEventListener('click', pickActorPhoto);
    if (actorPhotoInput) actorPhotoInput.addEventListener('change', handleActorPhotoSelected);
    if (btnSaveActorEdit) btnSaveActorEdit.addEventListener('click', saveActorEdit);
    if (actorEditModal) actorEditModal.addEventListener('click', function(e) {
        if (e.target === actorEditModal) closeActorEditModal();
    });
    if (btnCloseItemEdit) btnCloseItemEdit.addEventListener('click', closeItemMetadataModal);
    if (btnSaveItemEdit) btnSaveItemEdit.addEventListener('click', saveItemMetadata);
    if (itemEditModal) itemEditModal.addEventListener('click', function(e) {
        if (e.target === itemEditModal) closeItemMetadataModal();
    });
});

// ─── 视频库页（#pane-home 新版式） ────────────────────────────
// 版式：顶部播放器 → 「未选择视频」状态条 → 连接设备 / 选择文件夹 / 轴设置
//       → 视频列表（当前所选文件夹） → 底部设备状态。
// 「文件夹」能力已并入本页，但**不复用 browsePath()**：它硬绑
// #localFiles/#localBreadcrumb/#localEmpty 等节点，会和 #pane-folder 互相干扰。

// VR 盒子模式：首页「VR盒子」磁贴以 /index.html?vrbox=1 进入。
// 本页（视频库）的结构与列表逻辑**完全复用**，唯一的差别是播放器带上 vrbox=1 ——
// 播放器据此开放「VR 播放模式」（FLAT / 分屏 / 180° / 360°）并在内嵌下放开 VR 按钮。
// 注意：这里必须是**函数声明**（会提升），不能用 `var xxx = ...` —— initInitialView()
// 在文件前部就执行了（1975 行），那时后置的 var 赋值还没发生，取到的是 undefined，
// 徽标就永远不显示（2026-09-18 真机路径实测踩到）。
function isVrBoxMode() {
    try { return new URLSearchParams(location.search).get('vrbox') === '1'; }
    catch (e) { return /[?&]vrbox=1(?:&|$)/.test(location.search); }
}

var libStack = [];        // 浏览历史 [{label, path}]，用于面包屑与「上级」
var libSafRoot = null;   // 视频库的 SAF 授权树 URI（选完文件夹后确定）
var libVideosOnly = true;        // 恒为 true：列表只显示视频文件（切换按钮已移除）
var libItemsCache = [];          // 最近一次拉取的条目（含文件夹），过滤渲染复用
var libLastDebug = '';           // 后端诊断串（空列表时显示）
var libLastError = '';
var libDevTimer = null;

// 轻提示（本页自足实现，不依赖 app.css 的 .save-hint）
function libToast(msg) {
    var el = $('libToast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'libToast';
        el.style.cssText = 'position:fixed;left:50%;bottom:62px;transform:translateX(-50%);' +
            'max-width:86%;padding:9px 16px;border-radius:6px;background:rgba(20,28,36,.96);' +
            'border:1px solid rgba(47,183,232,.35);color:#dce8ee;font-size:13px;z-index:200;' +
            'text-align:center;opacity:0;transition:opacity .2s;pointer-events:none;';
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el.__hideTimer);
    el.__hideTimer = setTimeout(function() { el.style.opacity = '0'; }, 2200);
}

// 播放键：优先条目 id（base64url 编码的 ref，本机绝对路径与 SAF 内容都能被后端还原），
// 次选 path。直接给 SAF 的相对路径后端定位不到文件。
function libPlayKey(item) {
    if (item && item.id) return String(item.id);
    return String((item && item.path) || '');
}

// ─── 旋转补偿 / 俯卧补偿两个独立开关（「OSR 轴设置」页） ──────────
// 数据源 settings.osr.rotationFillMode / proneFillMode（OsrManager 的同步循环消费）。
// 保存必须走专用端点 /api/osr/single-axis-fill：/api/osr/settings 是全量覆盖，
// 前端少带一个字段就会被 fromJson 冲回默认值（轴参数当初就踩过这个坑）。
var rotationFillMode = 'off';
var proneFillMode = 'off';
var rotationFillAmp = 85;            // 旋转补偿幅度（%）：满摆角 180°
var proneFillAmp = 80;               // 俯卧补偿幅度（%）：满摆角 180°（对齐 Doro Player 的俯卧摆幅）

function paintCompMode(which) {
    var seg = $(which === 'rotation' ? 'rotationFillSeg' : 'proneFillSeg');
    if (!seg) return;
    var mode = (which === 'rotation') ? rotationFillMode : proneFillMode;
    seg.querySelectorAll('.ax-seg-btn').forEach(function(b) {
        b.classList.toggle('on', b.getAttribute('data-mode') === mode);
    });
}

function setCompFill(which, mode, amp) {
    var rotationMode = (which === 'rotation') ? mode : rotationFillMode;
    var proneMode = (which === 'prone') ? mode : proneFillMode;
    var rotationAmp = (which === 'rotation' && typeof amp === 'number') ? amp : rotationFillAmp;
    var proneAmp = (which === 'prone' && typeof amp === 'number') ? amp : proneFillAmp;
    fetch('/api/osr/single-axis-fill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            rotationMode: rotationMode, proneMode: proneMode,
            rotationAmp: rotationAmp, proneAmp: proneAmp
        })
    })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (!d || d.ok === false) {
                libToast((which === 'rotation' ? '旋转补偿' : '俯卧补偿') + '保存失败');
                return;
            }
            rotationFillMode = (d.rotationFillMode === 'follow' || d.rotationFillMode === 'sweep') ? d.rotationFillMode : 'off';
            proneFillMode = (d.proneFillMode === 'follow' || d.proneFillMode === 'sweep') ? d.proneFillMode : 'off';
            rotationFillAmp = numOr(d.rotationFillAmp, rotationFillAmp, 20, 150);
            proneFillAmp = numOr(d.proneFillAmp, proneFillAmp, 20, 150);
            paintCompMode('rotation');
            paintCompMode('prone');
            paintCompAmp('rotation');
            paintCompAmp('prone');
            var label = { off: '已关闭', follow: '跟随L0动', sweep: '循环自动' }[mode] || mode;
            if (typeof amp === 'number') {
                libToast((which === 'rotation' ? '旋转补偿' : '俯卧补偿') + '幅度 ' + amp + '%');
            } else {
                libToast((which === 'rotation' ? '旋转补偿' : '俯卧补偿') + label);
            }
        })
        .catch(function() { libToast('补偿设置保存失败：网络错误'); });
}

/** 幅度滑块 / 数字框 → 后端并即时重绘（拖动用 change 触发，滑动过程不刷请求）。 */
function setCompAmp(which, val) {
    var v = numOr(val, which === 'rotation' ? rotationFillAmp : proneFillAmp, 20, 150);
    var mode = (which === 'rotation') ? rotationFillMode : proneFillMode;
    setCompFill(which, mode, v);
}

/** 把幅度画到滑块与数字框上。 */
function paintCompAmp(which) {
    var v = (which === 'rotation') ? rotationFillAmp : proneFillAmp;
    var rg = $(which === 'rotation' ? 'rotationFillAmp' : 'proneFillAmp');
    var nm = $(which === 'rotation' ? 'rotationFillAmpVal' : 'proneFillAmpVal');
    if (rg && parseInt(rg.value, 10) !== v) rg.value = v;
    if (nm && parseInt(nm.value, 10) !== v) nm.value = v;
}

/**
 * 「恢复默认值」专用：一次请求把旋转/俯卧补偿一起设成 off + 默认幅度。
 * 不能分两次调 setCompFill —— 它每次都会把两个模式一起回传，后一次会覆盖前一次的结果。
 */
function resetCompFillDefaults() {
    fetch('/api/osr/single-axis-fill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rotationMode: 'off', proneMode: 'off', rotationAmp: 85, proneAmp: 80 })
    })
        .then(function (r) { return r.json(); })
        .then(function (d) {
            if (!d || d.ok === false) { libToast('补偿恢复默认失败'); return; }
            rotationFillMode = (d.rotationFillMode === 'follow' || d.rotationFillMode === 'sweep') ? d.rotationFillMode : 'off';
            proneFillMode = (d.proneFillMode === 'follow' || d.proneFillMode === 'sweep') ? d.proneFillMode : 'off';
            rotationFillAmp = numOr(d.rotationFillAmp, rotationFillAmp, 20, 150);
            proneFillAmp = numOr(d.proneFillAmp, proneFillAmp, 20, 150);
            paintCompMode('rotation');
            paintCompMode('prone');
            paintCompAmp('rotation');
            paintCompAmp('prone');
        })
        .catch(function () { libToast('补偿恢复默认失败：网络错误'); });
}

function numOr(v, fallback, lo, hi) {
    var n = parseInt(v, 10);
    if (isNaN(n)) n = fallback;
    if (n < lo) n = lo;
    if (n > hi) n = hi;
    return n;
}

function bindCompSeg(which) {
    var seg = $(which === 'rotation' ? 'rotationFillSeg' : 'proneFillSeg');
    if (!seg || seg.dataset.bound === '1') return;
    seg.dataset.bound = '1';
    seg.querySelectorAll('.ax-seg-btn').forEach(function(b) {
        b.addEventListener('click', function() {
            var mode = b.getAttribute('data-mode');
            var cur = (which === 'rotation') ? rotationFillMode : proneFillMode;
            if (mode !== cur) setCompFill(which, mode);
        });
    });
}

function initCompFill() {
    bindCompSeg('rotation');
    bindCompSeg('prone');
    ['rotation', 'prone'].forEach(function(which) {
        var rg = $(which === 'rotation' ? 'rotationFillAmp' : 'proneFillAmp');
        var nm = $(which === 'rotation' ? 'rotationFillAmpVal' : 'proneFillAmpVal');
        if (rg && !rg.dataset.bound) {
            rg.dataset.bound = '1';
            rg.addEventListener('change', function() { setCompAmp(which, rg.value); });
        }
        if (nm && !nm.dataset.bound) {
            nm.dataset.bound = '1';
            nm.addEventListener('change', function() { setCompAmp(which, nm.value); });
        }
    });
    fetch('/api/osr/settings')
        .then(function(r) { return r.json(); })
        .then(function(s) {
            rotationFillMode = (s && (s.rotationFillMode === 'follow' || s.rotationFillMode === 'sweep')) ? s.rotationFillMode : 'off';
            proneFillMode = (s && (s.proneFillMode === 'follow' || s.proneFillMode === 'sweep')) ? s.proneFillMode : 'off';
            rotationFillAmp = numOr(s && s.rotationFillAmp, rotationFillAmp, 20, 150);
            proneFillAmp = numOr(s && s.proneFillAmp, proneFillAmp, 20, 150);
            paintCompMode('rotation');
            paintCompMode('prone');
            paintCompAmp('rotation');
            paintCompAmp('prone');
        })
        .catch(function() {
            paintCompMode('rotation');
            paintCompMode('prone');
        });
}

function initLibraryPage() {
    // VR 盒子模式：亮出模式徽标；页面其余部分与视频库一字不差
    if (isVrBoxMode()) {
        var badge = $('libVrMode');
        if (badge) badge.style.display = 'flex';
    }
    var b = $('libBtnConnect'); if (b) b.addEventListener('click', libOpenConnect);
    b = $('libBtnFolder'); if (b) b.addEventListener('click', libOpenFolder);
    b = $('libBtnAxis'); if (b) b.addEventListener('click', libOpenAxis);
    b = $('libBtnClear'); if (b) b.addEventListener('click', libClearAll);
    initSmbQuick();
    // 设置页「OSR 轴设置」面板里的入口按钮：与上面「轴设置」共用同一个弹窗
    b = $('btnOpenAxisModal');
    if (b && b.dataset.bound !== '1') { b.dataset.bound = '1'; b.addEventListener('click', libOpenAxis); }
    initCompFill();
    // iframe 文档就绪后标记「已就绪」，后续换片才能走 location.replace 不留历史。
    // blanking = 去空白（退出播放器 / 一键清除）的那一次 load，不能再当成「已就绪」。
    var frameEl = $('libFrame');
    if (frameEl && !frameEl.dataset.historyBound) {
        frameEl.dataset.historyBound = '1';
        frameEl.addEventListener('load', function() {
            if (libFrameBlanking) { libFrameBlanking = false; libFrameLoaded = false; return; }
            libFrameLoaded = true;
        });
    }

    fetch('/api/settings/local')
        .then(function(r) { return r.json(); })
        .then(function(d) { libLoadFolder((d && d.rootPath) ? String(d.rootPath) : '', null); })
        .catch(function() { libLoadFolder('', null); });

    startLibDevPolling();
}

// 「连接设备」→ 设置页的「OSR 设备」面板（蓝牙 / WiFi / USB 连接、扫描、连接测试都在那里）
function libOpenConnect() {
    activateTab('settings');
    if (window.OrbitNav && typeof window.OrbitNav.openSettingsPanel === 'function') {
        window.OrbitNav.openSettingsPanel('osr');
    } else {
        location.href = '/index.html?panel=osr';
    }
}

// 「选择文件夹」→ 原生 SAF 选择器；结果经 window.__onFolderPicked 回来
function libOpenFolder() {
    if (window.Orbit && typeof window.Orbit.pickFolder === 'function') {
        window.Orbit.pickFolder();
        return;
    }
    // 桌面 / 浏览器回归环境没有原生桥：降级到仍然可用的「文件夹」页，且不报错
    libToast('当前环境不支持系统文件夹选择器，已切到「文件夹」页');
    activateTab('folder');
}

// 树 URI → base64url（后端用 decodeId 还原）。content:// 树 URI 内含 %3A/%2F，
// 直接塞进 query 会因转义往返被解成真实分隔符，导致后端 docId 被截断。
function libB64Url(s) {
    try {
        var bin = unescape(encodeURIComponent(String(s)));
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch (e) { return ''; }
}
// 挂到 window，供 manual_record.js（独立脚本，不在本 IIFE 作用域内）使用：
// 脚本编辑选片后用它与 WebServer 的 decodeId 完全一致的 base64url 编码视频 URI，
// 否则会回退到 encodeURIComponent 而解码不出 content://，导致播放器选完视频却加载不出画面。
window.libB64Url = libB64Url;

function libRootLabel(rootPath) {
    var rp = String(rootPath || '');
    if (rp.indexOf('content://') === 0) return '已授权目录';
    if (!rp) return '手机存储';
    var seg = rp.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    return seg || rp;
}

// path 为空串 = 手机存储根 / 已授权目录根
// enteredLabel 非 null 时表示「进入了一个子目录」，压入浏览栈
function libLoadFolder(path, enteredLabel) {
    libSmbQuickItems = [];   // 回到本地浏览，SMB 快捷列表不再作为播放列表
    var cur = String(path || '');
    if (libStack.length === 0) {
        libStack = [{ label: libRootLabel(cur), path: cur }];
    } else if (enteredLabel !== null && enteredLabel !== undefined) {
        libStack.push({ label: String(enteredLabel), path: cur });
    }
    renderLibCrumb();
    libFetchFolder(cur);
}

// 面包屑跳转 / 「上级」：只改栈顶，不压栈
function libGotoTop() {
    if (!libStack.length) return;
    renderLibCrumb();
    libFetchFolder(libStack[libStack.length - 1].path);
}

function libFetchFolder(path) {
    var list = $('libList'), empty = $('libEmpty'), loading = $('libLoading');
    if (!list) return;
    if (loading) loading.style.display = '';
    if (empty) { empty.textContent = '该文件夹下没有视频'; empty.style.display = 'none'; }

    var cur = String(path || '');
    if (cur.indexOf('content://') === 0) libSafRoot = cur;   // 新选的文件夹 = 新的 SAF 根
    var url = '/api/browse/local?path=' + encodeURIComponent(cur);
    if (libSafRoot) {
        var rel = (cur.indexOf('content://') === 0) ? '' : cur.replace(/^\/+/, '');
        var b64 = libB64Url(libSafRoot);
        if (b64) url = '/api/browse/local?root=' + encodeURIComponent(b64) + '&rel=' + encodeURIComponent(rel);
    }

    fetch(url)
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (loading) loading.style.display = 'none';
            libItemsCache = (d && d.items) ? d.items : [];
            libLastDebug = (d && d.debug) ? String(d.debug) : '';
            libLastError = (d && d.error) ? String(d.error) : '';
            renderLibList();
        })
        .catch(function() {
            if (loading) loading.style.display = 'none';
            list.innerHTML = '';
            if (empty) { empty.textContent = '目录读取失败'; empty.style.display = ''; }
        });
}

// 列表渲染：默认「只看视频」——只列视频文件，不再让一屏文件夹把视频挤没。
// 若该目录一个视频都没有但有子文件夹，则退回显示子文件夹（否则用户既看不到视频
// 又没法继续往下翻，等于死路），并给出提示。
function renderLibList() {
    var list = $('libList'), empty = $('libEmpty');
    if (!list) return;
    list.innerHTML = '';
    var all = libItemsCache || [];
    var videos = all.filter(function(it) { return it && !it.isDir; });
    var dirs = all.filter(function(it) { return it && it.isDir; });
    var shown = libVideosOnly ? videos : all;
    var note = '';
    if (libVideosOnly && !videos.length && dirs.length) {
        shown = dirs;
        note = '该目录没有视频，已显示子文件夹';
    }
    shown.forEach(function(it) { var el = libBuildItem(it); if (el) list.appendChild(el); });
    if (!empty) return;
    if (libLastError) {
        empty.textContent = libLastError + (libLastDebug ? (' · ' + libLastDebug) : '');
        empty.style.display = '';
        return;
    }
    if (shown.length) {
        if (note) { empty.textContent = note; empty.style.display = ''; }
        else empty.style.display = 'none';
        return;
    }
    empty.textContent = '该文件夹下没有视频文件'
        + (dirs.length ? ('（另有 ' + dirs.length + ' 个子文件夹）') : '')
        + (libLastDebug ? (' · ' + libLastDebug) : '');
    empty.style.display = '';
}

// 注：「只看视频 / 含文件夹」切换按钮已按需求移除，libVideosOnly 恒为 true。
//     列表只显示视频；若该目录无视频但有子文件夹，renderLibList 会自动回退显示子文件夹。

// 一键清除：停止播放 + 清空已加载列表与浏览栈 + 解除已选文件夹授权。
// 只清「本页已加载」的内容，不动媒体库索引/收藏/元数据（那些删了不可恢复）。
function libClearAll() {
    var n = (libItemsCache || []).length;
    // 收播放器走与「返回」同一套（location.replace(about:blank) + 复位标记），两处逻辑不再分叉
    libExitInPage();
    var frame = $('libFrame'), ph = $('libPlayerPh'), now = $('libNow');
    if (frame) frame.style.display = 'none';
    if (ph) ph.style.display = '';
    if (now) { now.textContent = ''; now.classList.remove('on'); now.style.display = 'none'; }
    libItemsCache = []; libLastDebug = ''; libLastError = '';
    libStack = []; libSafRoot = null;
    if (typeof clearGridCaches === 'function') { try { clearGridCaches(); } catch (e) {} }
    var list = $('libList'); if (list) list.innerHTML = '';
    renderLibCrumb();
    var empty = $('libEmpty');
    if (empty) { empty.textContent = '已清除所有已加载文件，请重新「选择文件夹」'; empty.style.display = ''; }
    fetch('/api/settings/local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootPath: '' })
    }).catch(function() {});
    libToast(n ? ('已清除 ' + n + ' 个已加载文件') : '已清除所有已加载文件');
}

function renderLibCrumb() {
    var el = $('libCrumb');
    if (!el) return;
    el.innerHTML = '';

    if (libStack.length > 1) {
        var up = document.createElement('a');
        up.textContent = '\u2190 \u4e0a\u7ea7';
        up.addEventListener('click', function() {
            libStack.pop();
            libGotoTop();
        });
        el.appendChild(up);
        var sep0 = document.createElement('span');
        sep0.className = 'lib-crumb-sep';
        sep0.textContent = '\u00b7';
        el.appendChild(sep0);
    }

    libStack.forEach(function(c, i) {
        if (i > 0) {
            var sep = document.createElement('span');
            sep.className = 'lib-crumb-sep';
            sep.textContent = '/';
            el.appendChild(sep);
        }
        if (i === libStack.length - 1) {
            var cur = document.createElement('span');
            cur.textContent = c.label;
            el.appendChild(cur);
            return;
        }
        var a = document.createElement('a');
        a.textContent = c.label;
        a.addEventListener('click', function() {
            libStack = libStack.slice(0, i + 1);
            libGotoTop();
        });
        el.appendChild(a);
    });
}

function libBuildItem(item) {
    var row = document.createElement('div');
    row.className = 'lib-item';
    var name = escapeHtml(item.name);
    // funscript 脚本随同名视频自动加载，不列为可播视频项，避免误触进播放器
    if (/\.funscript$/i.test(item.name || '')) return null;
    if (item.isDir) {
        row.innerHTML = '<span class="lib-thumb-ico">DIR</span>' +
            '<span class="lib-item-body"><span class="lib-item-name">' + name + '</span></span>' +
            '<span class="lib-item-tag">\u6587\u4ef6\u5939</span>';
        row.addEventListener('click', function() { libLoadFolder(item.path, item.name); });
    } else {
        row.innerHTML = '<img class="lib-thumb" data-hide-on-error alt="" src="/thumbnail/' +
                encodeURIComponent(libPlayKey(item)) + '">' +
            '<span class="lib-item-body"><span class="lib-item-name">' + name + '</span></span>' +
            '<span class="lib-item-tag">\u89c6\u9891\u6587\u4ef6</span>';
        row.addEventListener('click', function() { libPlay(item); });
    }
    return row;
}

// 在上方播放器里播放：内嵌 /player 页（embed=1）——进度 / 音量 / 静音与 OSR 脚本同步全部现成
// 视频随播脚本：把「视频所在目录」一并告诉播放器。
// 后端据此直接列该目录下的全部 .funscript —— 比「从视频 URI 反推父目录」可靠得多：
// 反推要拼 getTreeDocumentId + 父 docId 再查 provider，各 ROM 行为不一致，
// 真机上就表现为「明明同目录有脚本却加载不到」。
function libScriptFolderQuery() {
    if (!libSafRoot) return '';
    var b64 = libB64Url(libSafRoot);
    if (!b64) return '';
    var top = libStack.length ? libStack[libStack.length - 1] : null;
    var rel = top ? String(top.path || '') : '';
    if (rel.indexOf('content://') === 0) rel = '';   // 栈顶就是授权根
    rel = rel.replace(/^\/+/, '');
    return '&fsroot=' + encodeURIComponent(b64) + '&fsrel=' + encodeURIComponent(rel);
}

// 换片的历史控制：直接给 iframe 的 src 赋值会在「顶层」历史里留一条记录，
// 连看几部之后点「后退」就退到上一个视频，而不是上一个页面。
// 因此第一帧（打开播放器）用 src —— 这条历史是用户期望的，退出播放器要能回到列表；
// 之后每次换片一律走 contentWindow.location.replace，不再各占一格历史。
var libFrameLoaded = false;
var libFrameBlanking = false;        // 本次 load 属于「退出播放器去空白」那一次
var libNowPlaying = '';              // 播放卡里当前显示的片名（空 = 没在播）
var libPlayMode = 'order';           // 播放器上报的播放模式：loop / order / shuffle
var libSmbQuickItems = [];           // SMB 快捷浏览当前目录的视频列表（供「顺序/随机」挑下一部）；为空则用本地列表

/** 把当前目录的视频列表送给内嵌播放器，供「顺序 / 随机」播放挑下一部。 */
function libPushPlaylist() {
    var frame = $('libFrame');
    if (!frame || !frame.contentWindow) return;
    var source = (libSmbQuickItems && libSmbQuickItems.length) ? libSmbQuickItems : (libItemsCache || []);
    var vids = source.filter(function (it) { return it && !it.isDir; });
    var list = vids.map(function (it) {
        return { key: libPlayKey(it), title: String((it && it.name) || '') };
    });
    try { frame.contentWindow.postMessage({ __orbitPlaylist: list }, '*'); } catch (e) {}
}

/** 播放器播完一部后请求换片（顺序 / 随机模式下由 iframe 发来）。 */
function libPlayByKey(key, title) {
    var source = (libSmbQuickItems && libSmbQuickItems.length) ? libSmbQuickItems : (libItemsCache || []);
    var vids = source.filter(function (it) { return it && !it.isDir; });
    for (var i = 0; i < vids.length; i++) {
        if (libPlayKey(vids[i]) === String(key)) { libPlay(vids[i]); return; }
    }
    // 列表里已经没有它（例如目录刷新过）：按 key 直接起播
    libPlay({ id: String(key), name: String(title || '') });
}

function libPlay(item) {
    /* 试用拦截：内嵌播放器是独立 document，点击不冒泡到父页，
     * 文档级守卫管不到它，只能在这里做函数级拦截。 */
    try {
        if (window.licenseApi && window.licenseApi.status().blocked) {
            window.licenseApi.show('请先开始试用或输入激活卡密。');
            return;
        }
    } catch (e) { }
    var frame = $('libFrame'), ph = $('libPlayerPh'), now = $('libNow');
    if (!frame) return;
    var key = libPlayKey(item);
    var title = String(item.name || '');
    var src = '/player/?video=' + encodeURIComponent(key) +
        '&title=' + encodeURIComponent(title) + '&embed=1' +
        (isVrBoxMode() ? '&vrbox=1' : '') + libScriptFolderQuery() +
        '&mode=' + encodeURIComponent(libPlayMode || 'order') +
        '&_v=20260927e';
    // 换片历史：iframe 文档已就绪就走 location.replace（换文档、不占历史条目）；
    // 第一次用 src —— 这条历史正是期望的：从播放器退回时正好停在「没装影片」的播放卡上。
    if (libFrameLoaded && frame.contentWindow) {
        try { frame.contentWindow.location.replace(src); }
        catch (e) { frame.src = src; libFrameLoaded = false; }
    } else {
        frame.src = src;
    }
    frame.style.display = '';
    libNowPlaying = title;
    // 播放器起来之后把列表送过去（顺序 / 随机播放要用）；延迟是等 iframe 文档就绪
    setTimeout(libPushPlaylist, 900);
    if (ph) ph.style.display = 'none';
    if (now) { now.textContent = title; now.classList.add('on'); now.style.display = ''; }
    // 换片：比例复位并重新轮询（不同片源比例不同）
    libRatioDone = 0;
    var card0 = $('libPlayer');
    if (card0) { card0.style.aspectRatio = '16 / 9'; card0.style.maxHeight = ''; }
    libWatchRatio();
}

// ─── 底部「设备状态」：与首页「设备」磁贴同语义 ────────────────
// 播放器（iframe）回传视频真实宽高比 → 播放卡按比例自适应。
// 固定 16:9 卡片遇到 4:3 / 竖屏视频，画面会被裁掉一部分，这正是「尺寸不对」。
// ─── 播放卡宽高比自适应（两条通道，任一送达即可）────────────────
// 卡片与 iframe 实测都是满宽的，「右边还有空间」其实是 **信箱边**：
// aspect-ratio 停在默认 16/9 时，竖屏/4:3 片源经 object-fit:contain 会左右留黑边。
// 所以必须把卡片比例设成视频真实比例。
//
// 通道一（快）：播放器 postMessage 回传 {__orbitVideo,w,h}
// 通道二（兜底）：同源直读 —— iframe 与父页同源于 127.0.0.1:8787，
//   父级可直接取 frame.contentDocument 里的 <video> 读 videoWidth/videoHeight。
//   这条不依赖消息通道与触发时机，postMessage 因任何原因丢失时仍能兜住。
var libRatioTimer = null;
var libRatioDone = 0;      // 已应用的比例签名（w*100000+h），用于去重

function applyVideoRatio(w, h) {
    var card = $('libPlayer');
    w = Number(w) || 0; h = Number(h) || 0;
    if (!card || w <= 0 || h <= 0) return false;
    var sig = w * 100000 + h;
    if (sig === libRatioDone) return true;
    // 不再设 maxHeight：它会把高度夹断而宽度仍为 100%，
    // 盒子比例被破坏，video(object-fit:contain) 便左右留黑边。
    // 现在盒子比例严格等于视频比例，画面完整铺满、不裁、不留边。
    card.style.aspectRatio = w + ' / ' + h;
    card.style.maxHeight = '';
    libRatioDone = sig;
    return true;
}

window.addEventListener('message', function(e) {
    var d = e.data;
    // 播放器播完一部后请求换片（顺序 / 随机模式）
    if (d && d.__orbitPlay) { libPlayByKey(d.__orbitPlay, d.title); return; }
    // 播放器同步当前播放模式，换片时沿用
    if (d && d.__orbitPlayMode) { libPlayMode = String(d.__orbitPlayMode); return; }
    if (!d || !d.__orbitVideo) return;
    if (applyVideoRatio(d.w, d.h) && libRatioTimer) {
        clearInterval(libRatioTimer); libRatioTimer = null;   // 已拿到，停止轮询
    }
});

// 通道二：轮询直读 iframe 内的 <video>（同源，可读）。
// 播放器侧的上报可能因 videoWidth 当时为 0 / 消息时序而丢失，这里补上。
function libWatchRatio() {
    if (libRatioTimer) { clearInterval(libRatioTimer); libRatioTimer = null; }
    var tries = 0;
    libRatioTimer = setInterval(function() {
        if (++tries > 24) {                     // 约 12s 后放弃，避免过度轮询
            clearInterval(libRatioTimer); libRatioTimer = null; return;
        }
        var frame = $('libFrame');
        if (!frame) return;
        try {
            var doc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
            var v = doc && doc.getElementById ? doc.getElementById('video') : null;
            if (v && v.videoWidth && v.videoHeight) {
                if (applyVideoRatio(v.videoWidth, v.videoHeight)) {
                    clearInterval(libRatioTimer); libRatioTimer = null;
                }
            }
        } catch (e) { /* 未就绪：下次再试 */ }
    }, 500);
}

function libResetRatio() {
    if (libRatioTimer) { clearInterval(libRatioTimer); libRatioTimer = null; }
    libRatioDone = 0;
    var card = $('libPlayer');
    if (card) { card.style.aspectRatio = '16 / 9'; card.style.maxHeight = ''; }
}

function refreshLibDev() {
    var txt = $('libDevText');
    if (!txt) return;
    var dot = $('libDot');
    function paint(state, on, err) {
        txt.textContent = '\u8bbe\u5907\u72b6\u6001\uff1a' + state;
        if (dot) {
            dot.classList.toggle('on', !!on);
            dot.classList.toggle('err', !!err);
        }
    }
    fetch('/api/osr/status')
        .then(function(r) { return r.json(); })
        .then(function(s) {
            if (!s) { paint('\u672a\u68c0\u6d4b'); return; }
            // 链路状态一律用后端 linkState，前端不自行推断：
            //   disabled 未启用输出 / connected 已连 / idle UDP 无回执且未曾发送 / disconnected 未连
            // 两个曾经的错法（都踩过）：
            //   ① 用 enabled（启用硬件输出，默认常开）当已连接 → 开局就谎报「已连接」
            //   ② 用 tcpConnected 判 WiFi —— UDP 是无连接协议，它恒为 false，
            //      会把其实能发出去的链路误报成「未连接」（反方向的错）
            var ls = s.linkState || 'disconnected';
            if (ls === 'disabled') { paint('\u672a\u542f\u7528\u8f93\u51fa', false, false); return; }
            if (s.lastSendError) { paint('\u53d1\u9001\u5931\u8d25', false, true); return; }
            if (ls === 'connected') { paint('\u5df2\u8fde\u63a5', true, false); return; }
            if (ls === 'idle') { paint('\u5f85\u673a\uff08UDP \u65e0\u56de\u6267\uff09', false, false); return; }
            paint('\u672a\u8fde\u63a5', false, false);
        })
        .catch(function() { paint('\u672a\u68c0\u6d4b'); });
}

function startLibDevPolling() {
    if (libDevTimer) return;
    refreshLibDev();
    libDevTimer = setInterval(function() {
        var pane = $('pane-home');
        if (pane && pane.classList.contains('active')) refreshLibDev();
    }, 4000);
}

// ─── 轴参数设置弹窗 ──────────────────────────────────────────
// 数据源：settings.osr.axisParams —— OSR 指令生成真正读取的那份（OsrCore 消费）。
// 保存走 POST /api/osr/axes（服务端只合并 axisParams）。绝不发 /api/osr/settings：
// 那是全量覆盖，会把 connectionType / ip / port / btAddress / serialDevice 等冲成默认值。

var AXIS_LIST = ['L0', 'L1', 'L2', 'R0', 'R1', 'R2'];
// 轴的中文简称（弹窗副标题与轴选择器第二行用；弹窗内空间有限，只取括号前的部分）
var AXIS_SHORT = { L0: '上下', L1: '前后', L2: '左右', R0: '旋转', R1: '俯仰', R2: '翻滚' };
var AXIS_VALUE_MAX = 9999;   // 与后端 AXIS_VALUE_MAX 对齐
var AXIS_AMP_MAX = 300;      // 与后端 AXIS_AMPLITUDE_MAX 对齐
var AXIS_STEP = 1;    // 防交叉的最小间隔；同时也是滑块的 step（必须为 1，否则 9999 会被吸附成 9990）
var axisDraft = null;
var axisCur = 'L0';

function axisDefault() {
    return { reversed: false, min: 0, max: AXIS_VALUE_MAX, amplitude: 100 };
}

function axisNorm(raw) {
    var d = axisDefault();
    if (!raw || typeof raw !== 'object') return d;
    var min = parseInt(raw.min, 10); if (isNaN(min)) min = d.min;
    var max = parseInt(raw.max, 10); if (isNaN(max)) max = d.max;
    var amp = parseInt(raw.amplitude, 10); if (isNaN(amp)) amp = d.amplitude;
    min = Math.max(0, Math.min(AXIS_VALUE_MAX, min));
    max = Math.max(0, Math.min(AXIS_VALUE_MAX, max));
    if (min > max) { var t = min; min = max; max = t; }
    amp = Math.max(0, Math.min(AXIS_AMP_MAX, amp));
    return { reversed: !!raw.reversed, min: min, max: max, amplitude: amp };
}

// 反转开关的状态文字（正转 / 反转）——toggle 本体只有 .on 类，文字要自己同步
function axisPaintRev(on) {
    var el = $('axisRevText');
    if (!el) return;
    el.textContent = on ? '反转' : '正转';
    el.classList.toggle('on', !!on);
}

// 写数值输入框：值相同就不动，否则用户打字到一半会被改写、光标乱跳
function axisSetNum(el, v) {
    if (!el || el.value === '') return;   // 用户清空中，不插手
    if (parseInt(el.value, 10) !== v) el.value = v;
}

function openAxisModal() {
    fetch('/api/osr/axes')
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var src = (d && d.axisParams) ? d.axisParams : {};
            axisDraft = {};
            AXIS_LIST.forEach(function(a) { axisDraft[a] = axisNorm(src[a]); });
            axisCur = 'L0';
            renderAxisModal();
            var m = $('axisModal');
            if (m) m.style.display = 'flex';
        })
        .catch(function() { libToast('轴参数读取失败'); });
}

// 把当前轴在界面上的值写回草稿（切轴 / 保存前必须调用，否则切页会丢改动）
function axisStash() {
    if (!axisDraft) return;
    var cur = axisDraft[axisCur] || axisDefault();
    var rev = $('axisModalRev'), mn = $('axisRangeMin'), mx = $('axisRangeMax'), amp = $('axisAmp');
    if (rev) cur.reversed = rev.classList.contains('on');
    if (mn) cur.min = parseInt(mn.value, 10);
    if (mx) cur.max = parseInt(mx.value, 10);
    if (amp) cur.amplitude = parseInt(amp.value, 10);
    axisDraft[axisCur] = axisNorm(cur);
}

function renderAxisModal() {
    var cur = (axisDraft && axisDraft[axisCur]) ? axisDraft[axisCur] : axisDefault();
    $$('#axisModalTabs .axis-tab').forEach(function(t) {
        t.classList.toggle('active', t.dataset.axis === axisCur);
    });
    var sub = $('axisModalSub');
    if (sub) sub.textContent = axisCur + ' · ' + (AXIS_SHORT[axisCur] || '');
    var rev = $('axisModalRev');
    if (rev) {
        rev.classList.toggle('on', !!cur.reversed);
        rev.setAttribute('aria-checked', cur.reversed ? 'true' : 'false');
    }
    axisPaintRev(!!cur.reversed);
    var mn = $('axisRangeMin'), mx = $('axisRangeMax'), amp = $('axisAmp');
    if (mn) mn.value = cur.min;
    if (mx) mx.value = cur.max;
    if (amp) amp.value = cur.amplitude;
    axisSyncRange();
}

// 刷新区间徽标、高亮段、数值输入框与幅度已选段（双滑块没有原生「已选区间」样式，需自己算）
function axisSyncRange() {
    var mn = $('axisRangeMin'), mx = $('axisRangeMax');
    if (!mn || !mx) return;
    var lo = parseInt(mn.value, 10), hi = parseInt(mx.value, 10);
    var label = $('axisRangeLabel');
    if (label) label.textContent = lo + ' – ' + hi;   // 区间徽标（en dash）
    var fill = $('axisRangeFill');
    if (fill) {
        var a = (lo / AXIS_VALUE_MAX) * 100;
        var b = (hi / AXIS_VALUE_MAX) * 100;
        fill.style.left = a + '%';
        fill.style.width = Math.max(0, b - a) + '%';
    }
    axisSetNum($('axisRangeMinNum'), lo);
    axisSetNum($('axisRangeMaxNum'), hi);
    var amp = $('axisAmp');
    if (amp) {
        var av = parseInt(amp.value, 10);
        axisSetNum($('axisAmpVal'), av);
        // 幅度已选段渐变：--p 交给 CSS 的 background-size 消费
        amp.style.setProperty('--p', ((av / AXIS_AMP_MAX) * 100) + '%');
    }
}

// 「恢复默认值」必须真的把服务端数据改回默认：以前只把内存草稿刷一遍，
// 用户点完再按「取消/×」关掉弹窗就什么都没变，看着像「按钮没反应」。
// 现在：① 6 个轴回到 axisDefault()；② 旋转/俯卧补偿回到 off + 默认幅度；③ 两条都立即落库。
function resetAxisModal() {
    if (!axisDraft) return;
    if (!confirm('确定要把六个轴的参数与旋转/俯卧补偿全部恢复默认，并立即保存吗？')) return;
    var btn = $('axisModalReset');
    if (btn) btn.disabled = true;
    AXIS_LIST.forEach(function (a) { axisDraft[a] = axisDefault(); });
    axisCur = 'L0';
    renderAxisModal();
    fetch('/api/osr/axes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ axes: axisDraft })
    })
        .then(function (r) { return r.json(); })
        .then(function (d) {
            if (!d || d.ok === false) {
                if (btn) btn.disabled = false;
                libToast('恢复默认失败：' + ((d && (d.message || d.error)) || '未知原因'));
                return;
            }
            resetCompFillDefaults();
            if (btn) btn.disabled = false;
            libToast('已恢复默认参数并保存');
        })
        .catch(function () {
            if (btn) btn.disabled = false;
            libToast('恢复默认失败：网络错误');
        });
}

function closeAxisModal() {
    var m = $('axisModal');
    if (m) m.style.display = 'none';
    axisDraft = null;
}

function saveAxisModal() {
    var btn = $('axisModalSave');
    if (!axisDraft) { closeAxisModal(); return; }
    axisStash();
    if (btn) btn.disabled = true;
    fetch('/api/osr/axes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ axes: axisDraft })
    })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (btn) btn.disabled = false;
            if (d && d.ok === false) {
                libToast('保存失败：' + (d.message || d.error || '未知原因'));
                return;
            }
            closeAxisModal();
            libToast('轴参数已保存');
        })
        .catch(function() {
            if (btn) btn.disabled = false;
            libToast('保存失败：网络错误');
        });
}

function libOpenAxis() {
    bindAxisModal();
    // 每次打开弹窗都刷新一次开关态：其它入口（设置页）或上一次会话可能刚改过它。
    initCompFill();
    openAxisModal();
}

function bindAxisModal() {
    var m = $('axisModal');
    if (!m || m.dataset.bound === '1') return;
    m.dataset.bound = '1';

    var c = $('axisModalClose'); if (c) c.addEventListener('click', closeAxisModal);
    var x = $('axisModalCancel'); if (x) x.addEventListener('click', closeAxisModal);
    var s = $('axisModalSave'); if (s) s.addEventListener('click', saveAxisModal);
    var r = $('axisModalReset'); if (r) r.addEventListener('click', resetAxisModal);
    // 点遮罩关闭（丢弃草稿）
    m.addEventListener('click', function(e) { if (e.target === m) closeAxisModal(); });

    // 轴标签页：切页前先把当前轴改动写回草稿，否则切页丢改动
    var tabs = $('axisModalTabs');
    if (tabs) tabs.addEventListener('click', function(e) {
        var t = e.target.closest('.axis-tab');
        if (!t) return;
        var ax = t.dataset.axis;
        if (!ax || ax === axisCur) return;
        axisStash();
        axisCur = ax;
        renderAxisModal();
    });

    var rev = $('axisModalRev');
    if (rev) rev.addEventListener('click', function() {
        rev.classList.toggle('on');
        var on = rev.classList.contains('on');
        rev.setAttribute('aria-checked', on ? 'true' : 'false');
        axisPaintRev(on);
    });

    // 双滑块：保持 min < max（不交叉）+ 实时刷新数值、徽标与高亮段
    var mn = $('axisRangeMin'), mx = $('axisRangeMax'), amp = $('axisAmp');
    if (mn) mn.addEventListener('input', function() { axisApplyRange(true); });
    if (mx) mx.addEventListener('input', function() { axisApplyRange(false); });
    if (amp) amp.addEventListener('input', axisSyncRange);

    // 数值输入框：输入即写回滑块。滑块是唯一真值源，避免两处状态各说各话
    bindAxisNum($('axisRangeMinNum'), 'axisRangeMin', AXIS_VALUE_MAX, true);
    bindAxisNum($('axisRangeMaxNum'), 'axisRangeMax', AXIS_VALUE_MAX, false);
    bindAxisNum($('axisAmpVal'), 'axisAmp', AXIS_AMP_MAX, null);
}

// 双滑块防交叉：拖 min 时压低上限，拖 max 时抬高下限
function axisApplyRange(srcIsMin) {
    var mn = $('axisRangeMin'), mx = $('axisRangeMax');
    if (!mn || !mx) return;
    var lo = parseInt(mn.value, 10), hi = parseInt(mx.value, 10);
    if (srcIsMin) { if (lo > hi - AXIS_STEP) mn.value = hi - AXIS_STEP; }
    else { if (hi < lo + AXIS_STEP) mx.value = lo + AXIS_STEP; }
    axisSyncRange();
}

// 数值框 → 滑块单向写回；isMin 为 null 表示单值控件（幅度）
function bindAxisNum(numEl, rangeId, max, isMin) {
    if (!numEl) return;
    numEl.addEventListener('input', function() {
        var src = $(rangeId);
        if (!src) return;
        var v = parseInt(numEl.value, 10);
        if (isNaN(v)) return;      // 清空后正要重输，别抢着填值
        if (v < 0) v = 0;
        if (v > max) v = max;
        src.value = v;
        if (isMin === null) axisSyncRange(); else axisApplyRange(isMin);
    });
    // 失焦：把空值 / 非法值还原成滑块当前值，不留一个骗人的空框
    numEl.addEventListener('blur', function() {
        var src = $(rangeId);
        if (!src) return;
        if (numEl.value === '' || isNaN(parseInt(numEl.value, 10))) numEl.value = parseInt(src.value, 10);
        else axisSyncRange();
    });
}

// ─── 首页仪表板深链接：?tab=xxx / ?panel=yyy ─────────────────
// 首页磁贴通过 /index.html?panel=osr 这类地址跳进来，这里负责切到对应页面与面板。
(function initDeepLink() {
    var qs;
    try { qs = new URLSearchParams(location.search); } catch (e) { return; }
    var panel = qs.get('panel');
    var tab = qs.get('tab') || (panel ? 'settings' : null);
    if (!tab && !panel) return;

    var MIN_TICKS = 4;   // 至少等 200ms，让 initInitialView 的视图恢复先跑完
    var MAX_TICKS = 40;  // 最多等 2s，超时也强制切换
    var ticks = 0;
    var timer = setInterval(function() {
        ticks++;
        if (ticks < MIN_TICKS) return;

        var loading = $('homeLoading');
        var grid = $('videoGrid');
        var empty = $('homeEmpty');
        var stillLoading = !!loading && loading.style.display !== 'none' &&
            !(grid && grid.children.length > 0) &&
            !(empty && empty.style.display !== 'none');
        if (stillLoading && ticks < MAX_TICKS) return;

        clearInterval(timer);

        // 幂等：已切到目标 tab/panel 就不重复操作（保留查询串，WebView 重建后仍能恢复）
        var curPane = document.querySelector('.tab-pane.active');
        var curTab = curPane ? curPane.id.replace(/^pane-/, '') : null;
        if (curTab !== tab) activateTab(tab);

        if (tab === 'settings' && !panel) {
            // 首页「设置」磁贴：侧栏已移除，这里把全部分区摊开成一张完整设置页
            var pane = $('pane-settings');
            if (pane) pane.classList.add('settings-all');
            if (showSettingsPanel) {
                // 自动分析分区此时可见，需要启动它的状态轮询；
                // 随后把「活动分区」还给控制台，保持与默认状态一致
                var curSettingsPanel = document.querySelector('.settings-panel.active');
                if (!curSettingsPanel || curSettingsPanel.id !== 'panel-analyze') showSettingsPanel('analyze');
                if (!curSettingsPanel || curSettingsPanel.id !== 'panel-dashboard') showSettingsPanel('dashboard');
            }
        } else if (panel) {
            var targetSettingsPanel = document.querySelector('.settings-panel.active');
            if (!targetSettingsPanel || targetSettingsPanel.id !== 'panel-' + panel) {
                if (showSettingsPanel) {
                    showSettingsPanel(panel);
                } else {
                    var item = document.querySelector('.sidebar-item[data-panel="' + panel + '"]');
                    if (item) item.click();
                }
            }
        }
    }, 50);
})();

// ─── 暴露最小导航 API 给同页其它脚本 ───────────────────────────
// osr.js 需要从「OSR 设备」面板跳到全屏「蓝牙设备」页并返回，
// 而 app.js 整体在 IIFE 内，内部函数默认不可见，这里显式挂到 window。
window.OrbitNav = {
    activateTab: activateTab,
    navigateBack: navigateBack,
    handleBack: handleBack,
    pushCurrentView: pushCurrentView,
    isActive: isActiveTab,
    // 设置页「分区」切换：showSettingsPanel 是 initSettings() 里才赋值的 var，
    // 这里用转发函数，保证调用时取到的是当时的最新实现。
    openSettingsPanel: function(panelName) {
        if (typeof showSettingsPanel === 'function') showSettingsPanel(panelName);
    }
};

/* ─────────────────────────────────────────────────────────────
   版本信息页（2026-09-19 第十一轮：由首页页内浮层改为独立页面 ?panel=ver）

   数据仍然只有一份真值源：/js/changelog.js 的 window.ORBIT_CHANGELOG。
   首页磁贴副标题、首页页脚版本号由 home.js 读它渲染；完整更新记录在这里渲染。
   升版本时仍然只改「changelog.js 的 current + 新条目」与 build.gradle.kts 两处。
   ───────────────────────────────────────────────────────────── */
var VER_TAG_LABEL = { add: '新增', opt: '优化', fix: '修复' };

function verEsc(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function verRender() {
    var body = $('verBody');
    if (!body) return;
    var data = window.ORBIT_CHANGELOG;
    if (!data || !data.entries) {
        body.innerHTML = '<p class="hm-ver-top">更新记录未加载（changelog.js 缺失）。</p>';
        return;
    }
    var cur = data.current || '';
    var html = '<p class="hm-ver-top">当前版本 <b>v' + verEsc(cur) + '</b>'
        + (data.updated ? '（' + verEsc(data.updated) + ' 更新）' : '')
        + '，下面是每个版本的新增、优化与修复记录，最新的排在最前。</p>';

    data.entries.forEach(function (e) {
        var isCur = (e.v === cur);
        html += '<div class="hm-ver-item' + (isCur ? ' cur' : '') + '">';
        html += '<div class="hm-ver-head"><span class="hm-ver-v">v' + verEsc(e.v) + '</span>';
        if (e.date) html += '<span class="hm-ver-date">' + verEsc(e.date) + '</span>';
        if (isCur) html += '<span class="hm-ver-cur">当前</span>';
        html += '</div><ul class="hm-ver-ul">';
        (e.items || []).forEach(function (it) {
            var kind = VER_TAG_LABEL[it.t] ? it.t : 'add';
            html += '<li><span class="hm-ver-tag t-' + kind + '">' + VER_TAG_LABEL[kind] + '</span>'
                + '<span class="hm-ver-txt">' + verEsc(it.s || it.d) + '</span></li>';
        });
        html += '</ul></div>';
    });
    body.innerHTML = html;
    verBindUpdate();
}

/* ─────────────────────────────────────────────────────────────
   原生前后台信号（App 的 onStart / onStop 直接调 window.__orbitBg）

   为什么不让页面自己看 document.hidden：Android WebView 的页面可见性依赖视图层级
   把 window 可见性变化派发下去，不同 ROM / WebView 版本上的时机与结果并不一致。
   判错的后果很重 —— 视频被系统静默暂停时页面会照常上报「已暂停」，
   后端播放时钟被冻住，切后台设备就停。原生自己最清楚，直接给信号最可靠。

   顶层页面只负责转发：真正维护播放时钟的是内嵌播放器 iframe（原生只能对主框架求值）。
   ───────────────────────────────────────────────────────────── */
/* ─────────────────────────────────────────────────────────────
   在线更新（2026-09-29：版本页「检查更新 / 立即更新」）
   原生桥 Orbit.checkAppUpdate() 查更新（主源腾讯云 CloudBase 静态托管，失败自动降级 GitHub Releases），
   Orbit.downloadAndInstallApk(url) 下载并安装；
   结果经 window.__onUpdateChecked / __onUpdateProgress / __onUpdateError 回传。
   ───────────────────────────────────────────────────────────── */
var verCheckBound = false;
var verUpdateUrl = '';
function verBindUpdate() {
    var btn = $('verCheckBtn');
    if (btn && !verCheckBound) {
        verCheckBound = true;
        btn.addEventListener('click', function () {
            var st = $('verUpdateStatus');
            // 如果当前按钮是「立即更新」，统一走下载逻辑
            if (btn.textContent === '立即更新' && verUpdateUrl) {
                btn.disabled = true;
                if (st) st.innerHTML = '<span class="ver-update-hint">开始下载更新包…</span>';
                if (window.Orbit && typeof window.Orbit.downloadAndInstallApk === 'function') {
                    try { window.Orbit.downloadAndInstallApk(verUpdateUrl); } catch (e) {}
                }
                return;
            }
            if (st) st.innerHTML = '<span class="ver-update-hint">正在检查更新…</span>';
            btn.disabled = true;
            if (window.Orbit && typeof window.Orbit.checkAppUpdate === 'function') {
                try { window.Orbit.checkAppUpdate(); } catch (e) {}
            }
            setTimeout(function () { btn.disabled = false; }, 1500);
        });
    }
    // 每次进入版本页自动查一次
    if (window.Orbit && typeof window.Orbit.checkAppUpdate === 'function') {
        try { window.Orbit.checkAppUpdate(); } catch (e) {}
    }
}
window.__onUpdateChecked = function (res) {
    var st = $('verUpdateStatus');
    var btn = $('verCheckBtn');
    if (!st) return;
    if (btn) {
        btn.disabled = false;
        btn.textContent = '检查更新';
    }
    verUpdateUrl = '';
    if (!res || res.error) {
        var err = (res && res.error) ? String(res.error) : '未知错误';
        // GitHub 仓库还没发布过任何 Release 时，/releases/latest 返回 404 —— 这是正常状态，不算故障
        // 404 = 更新服务器上还没有任何版本（新环境刚建好时是正常的），不是故障
        if (err.indexOf('404') >= 0) {
            st.innerHTML = '<span class="ver-update-hint">更新服务器还没有发布过在线更新版本（404）。发布后这里即可一键检查并更新。</span>';
        } else {
            st.innerHTML = '<span class="ver-update-err">暂时无法连接更新服务器，请检查网络后重试（' + verEsc(err) + '）</span>';
        }
        return;
    }
    if (!res.available) {
        // note：iOS 侧用来说明「更新走 TestFlight / App Store」，安卓不会带这个字段。
        st.innerHTML = '<span class="ver-update-ok">已是最新版本（v' + verEsc(res.current || '') + '）'
            + (res.note ? '　' + verEsc(res.note) : '') + '</span>';
        return;
    }
    verUpdateUrl = res.url;
    st.innerHTML = '<span class="ver-update-new">发现新版本 v' + verEsc(res.latest) + '，可在线更新到最新版</span>';
    if (btn) {
        btn.textContent = '立即更新';
        btn.disabled = false;
    }
};
window.__onUpdateProgress = function (p) {
    var st = $('verUpdateStatus');
    var btn = $('verCheckBtn');
    if (btn) btn.disabled = true;
    if (!st) return;
    if (p.phase === 'downloading') {
        var pct = p.percent || 0;
        st.innerHTML = '<span class="ver-update-hint">正在下载更新包… ' + pct + '%</span>'
            + '<div class="ver-update-bar"><div class="ver-update-bar-fill" style="width:' + pct + '%"></div></div>';
    } else if (p.phase === 'installing') {
        st.innerHTML = '<span class="ver-update-hint">下载完成，正在调起安装…</span>';
    }
};
window.__onUpdateError = function (e) {
    var st = $('verUpdateStatus');
    var btn = $('verCheckBtn');
    if (st) st.innerHTML = '<span class="ver-update-err">更新失败：' + verEsc(e ? e.message : '未知错误') + '</span>';
    if (btn) { btn.disabled = false; btn.textContent = '检查更新'; }
    verUpdateUrl = '';
};

window.__orbitBg = function (bg) {
    var f = $('libFrame');
    if (!f) return;
    try {
        if (f.contentWindow && typeof f.contentWindow.__orbitBg === 'function') {
            f.contentWindow.__orbitBg(!!bg);
        }
    } catch (e) { }
    try {
        if (f.contentWindow) f.contentWindow.postMessage({ __orbitBg: !!bg }, '*');
    } catch (e) { }
};

/* ─────────────────────────────────────────────────────────────
   设备页「后台运行」卡片

   三层保活里，代码能解决两层（原生时钟自驱、前台服务 + 唤醒锁），
   第三层「系统放行」必须用户在设置里点一下 —— 所以这里把真实状态摊开：
   电池优化是否豁免 / 前台服务是否在跑 / 唤醒锁是否持有，
   并按厂商给出对应的设置路径（各家入口完全不一样）。
   ───────────────────────────────────────────────────────────── */
var BG_ROM_HINT = [
    { re: /xiaomi|redmi|^mi /i, s: '小米 / 红米：设置 → 应用设置 → 应用管理 → Orbit → 省电策略选「无限制」，并打开「自启动」。' },
    { re: /huawei|honor/i, s: '华为 / 荣耀：设置 → 应用 → 应用启动管理 → Orbit，关掉「自动管理」，允许自启动 / 关联启动 / 后台活动。' },
    { re: /oppo|realme|oneplus/i, s: 'OPPO / realme：设置 → 电池 → 应用耗电管理 → Orbit，允许「完全后台行为」。' },
    { re: /vivo|iqoo/i, s: 'vivo / iQOO：设置 → 电池 → 后台高耗电 → 允许 Orbit；再到 i 管家 → 自启动里放开。' }
];

function bgSetVal(id, text, kind) {
    var el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'dash-value' + (kind ? ' ' + kind : '');
}

/** 毫秒 → 「3 分 12 秒」。给「上次后台驻留 / 后台驱动时长」两行用。 */
function bgFmtDur(ms) {
    if (!(ms > 0)) return '--';
    if (ms < 1000) return '不到 1 秒';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + ' 秒';
    var m = Math.floor(s / 60), r = s % 60;
    return r ? (m + ' 分 ' + r + ' 秒') : (m + ' 分');
}

/** 毫秒 → 「刚刚 / 12 秒前 / 3 分钟前」。-1 表示本次启动后还没发出过指令。 */
function bgFmtAgo(ms) {
    if (ms == null || ms < 0) return '还没发过';
    if (ms < 1500) return '刚刚';
    if (ms < 60000) return Math.round(ms / 1000) + ' 秒前';
    return Math.round(ms / 60000) + ' 分钟前';
}

function bgRefresh() {
    var state = $('bgState'), desc = $('bgDesc'), btn = $('bgAllowBtn');
    if (!state) return;
    var bridge = window.Orbit;
    if (!bridge || typeof bridge.backgroundStatus !== 'function') {
        // 浏览器里跑（没有原生桥）：如实说明，不显示一堆看起来像故障的「--」
        state.textContent = '仅 App 内可用';
        state.className = 'bg-card-state';
        if (desc) desc.textContent = '当前不在 App 内运行，后台保活状态无法读取。';
        if (btn) btn.style.display = 'none';
        ['bgBattery', 'bgService', 'bgLocks', 'bgStay', 'bgDrive', 'bgLastSent'].forEach(function (id) {
            bgSetVal(id, '--');
        });
        return;
    }
    var s = null;
    try { s = JSON.parse(bridge.backgroundStatus()); } catch (e) { s = null; }
    if (!s) {
        state.textContent = '读取失败';
        state.className = 'bg-card-state';
        return;
    }
    // iOS 没有「电池优化白名单 / 前台服务 / 唤醒锁」这套机制，后台由系统统一调度。
    // 直接复用安卓那几行会全显示成 '--'，看起来像故障 —— 这里给 iOS 专属文案。
    if (s.platform === 'ios') {
        state.textContent = 'iOS 后台由系统管理';
        state.className = 'bg-card-state ok';
        ['bgBattery', 'bgService', 'bgLocks', 'bgStay', 'bgDrive', 'bgLastSent'].forEach(function (id) {
            bgSetVal(id, '--');
        });
        if (desc) desc.textContent = 'iOS 由系统统一调度后台：应用到后台会被挂起，'
            + '建议随播时保持 Orbit 在前台（或开启音频后台模式）。';
        if (btn) btn.style.display = 'none';
        return;
    }
    bgSetVal('bgBattery', s.ignoringBattery ? '已允许' : '未允许', s.ignoringBattery ? 'good' : 'bad');
    bgSetVal('bgService', s.serviceRunning ? '运行中' : '未运行', s.serviceRunning ? 'good' : '');
    bgSetVal('bgLocks', s.locksHeld ? '已持有' : '未持有', s.locksHeld ? 'good' : '');

    // 「上次后台」体检：驱动时长≈驻留时长说明保活真的顶住了；
    // 只驱动了开头一小段 —— 进程在后台被系统冻住了，这是 ROM 层的限制，不是网页误报暂停。
    var span = Number(s.bgSpanMs || 0), drive = Number(s.bgDriveMs || 0);
    var frozen = span > 20000 && drive < span * 0.7;
    if (span > 0) {
        bgSetVal('bgStay', bgFmtDur(span));
        bgSetVal('bgDrive', bgFmtDur(drive) + (frozen ? ' · 中断' : ' · 持续'), frozen ? 'bad' : 'good');
    } else {
        bgSetVal('bgStay', '--');
        bgSetVal('bgDrive', '--');
    }
    var ago = Number(s.lastSentAgoMs);
    bgSetVal('bgLastSent', bgFmtAgo(ago), (ago >= 0 && ago < 5000) ? 'good' : '');

    if (s.ignoringBattery) {
        state.textContent = '已允许';
        state.className = 'bg-card-state ok';
    } else {
        state.textContent = '未允许';
        state.className = 'bg-card-state';
    }
    if (btn) btn.style.display = s.ignoringBattery ? 'none' : '';

    if (desc) {
        var hint = '';
        var manu = String(s.manufacturer || '');
        for (var i = 0; i < BG_ROM_HINT.length; i++) {
            if (BG_ROM_HINT[i].re.test(manu)) { hint = ' ' + BG_ROM_HINT[i].s; break; }
        }
        desc.textContent = (s.ignoringBattery
            ? '系统已允许本应用在后台运行，切后台或锁屏后设备会继续跟随。'
            : '系统还没放行：点下面的按钮把 Orbit 加入电池优化白名单。'
              + '若按钮没弹出对话框，通常是机型不支持一步到位，会跳到设置列表，手动选择「不优化 / 无限制」即可。')
            + hint
            + (frozen ? ' 注意「后台驱动时长」显示「中断」：说明进程在后台被系统冻住了，' +
                '必须按上面的机型路径放开后台限制，否则切后台一段时间后设备仍会停。' : '');
    }
}

function bgInit() {
    var btn = $('bgAllowBtn');
    if (btn) {
        btn.addEventListener('click', function () {
            var bridge = window.Orbit;
            if (!bridge || typeof bridge.requestIgnoreBattery !== 'function') {
                // 注意用 $('bgDesc') 现取：desc 是 bgRefresh 里的局部变量，在这里引用会抛 ReferenceError
                var d = $('bgDesc');
                if (d) d.textContent = '当前环境不支持该操作，请到系统设置 → 电池里手动允许 Orbit 后台运行。';
                return;
            }
            try { bridge.requestIgnoreBattery(); } catch (e) { }
            // 系统弹窗关掉之后回到本页：靠 focus 事件刷新即可，这里再补一次定时兜底
            setTimeout(bgRefresh, 2000);
        });
    }
    // 原生拿到结果后的回调
    window.__onBgPerm = function () { bgRefresh(); };
    // 从系统设置返回 App：重新读一次真实状态
    window.addEventListener('focus', function () { bgRefresh(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) bgRefresh(); });
    // 「后台驱动时长 / 最近发送」是持续变化的实测值，卡片可见时每 4 秒刷一次
    // （卡片不可见就完全不做事，避免白跑 JS 桥）。
    setInterval(function () {
        var card = $('bgCard');
        if (card && card.offsetParent !== null) bgRefresh();
    }, 4000);
    bgRefresh();
}

bgInit();
})();
