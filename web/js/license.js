/* Orbit 试用 / 卡密激活 —— 本页自足实现，样式内联，不依赖 app.css
 * 加载顺序：必须早于 app.js / player.js，这样守卫能在它们注册监听之前生效。
 *
 * 拦截策略（软拦截）：
 *   - state 为 idle / expired 时 st.blocked = true，此时文档级「捕获阶段」点击守卫
 *     会吃掉所有功能点击并弹出本面板；start-trial / activate 成功后自动放行。
 *   - 捕获阶段能拦住 libPlay() 这类「点击即发生」的动作（冒泡阶段等我们接手已经晚了），
 *     代价是顺带掐掉 app.js 里既有的 document 冒泡监听（点外面关下拉等），
 *     所以拦截成功后会补发一次合成点击把它们补回来。 */
(function () {
  'use strict';

  var WX_ID = 'yeee9991';
  var API = '/api/license/';

  var st = { state: 'idle', blocked: false, daysLeft: 0, expireAt: 0, machine: '', kind: 0 };
  var panel = null;
  var panelOpen = false;
  var guardOn = false;

  /* ---------------- 样式 ---------------- */
  function injectCss() {
    if (document.getElementById('licCss')) return;
    var c = document.createElement('style');
    c.id = 'licCss';
    c.textContent = [
      '.lic-mask{position:fixed;inset:0;z-index:99990;background:rgba(4,8,18,.72);',
      '  display:flex;align-items:center;justify-content:center;padding:16px;',
      '  backdrop-filter:blur(6px);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}',
      '.lic-card{width:min(420px,100%);max-height:88vh;overflow:auto;background:#121826cc;',
      '  border:1px solid rgba(255,255,255,.14);border-radius:18px;padding:20px 18px;color:#e8edf7;',
      '  position:relative;box-shadow:0 24px 60px rgba(0,0,0,.55)}',
      '.lic-card h3{margin:0 0 4px;font-size:19px;padding-right:32px}',
      '.lic-close{position:absolute;top:9px;right:11px;width:30px;height:30px;border:0;',
      '  background:transparent;color:#93a2bd;font-size:22px;line-height:1;cursor:pointer;opacity:.8}',
      '.lic-close:hover{opacity:1;color:#e8edf7}',
      '.lic-card .lic-sub{margin:0 0 14px;font-size:12.5px;color:#93a2bd;line-height:1.6}',
      '.lic-row{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.05);',
      '  border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:9px 11px;margin-bottom:9px}',
      '.lic-row .k{font-size:12px;color:#93a2bd;flex:0 0 auto}',
      '.lic-row .v{font-size:15px;font-weight:700;letter-spacing:.5px;flex:1 1 auto;',
      '  overflow-wrap:anywhere;font-family:ui-monospace,Consolas,monospace}',
      '.lic-row .copy{font-size:11.5px;color:#7fd7ff;border:1px solid rgba(127,215,255,.4);',
      '  background:transparent;border-radius:7px;padding:4px 9px;cursor:pointer;flex:0 0 auto}',
      '.lic-row .copy:active{background:rgba(127,215,255,.16)}',
      '.lic-qr{display:block;margin:2px auto 12px;width:150px;height:150px;background:#fff;',
      '  border-radius:10px;padding:6px;box-sizing:content-box}',
      '.lic-tip{font-size:11.5px;color:#8ea0bf;line-height:1.65;margin:10px 0 0}',
      '.lic-tip b{color:#ffcf70}',
      '.lic-code{width:100%;box-sizing:border-box;background:rgba(0,0,0,.32);',
      '  border:1px solid rgba(255,255,255,.16);border-radius:10px;color:#e8edf7;',
      '  padding:10px;font-size:12.5px;line-height:1.5;resize:vertical;',
      '  font-family:ui-monospace,Consolas,monospace;margin-bottom:9px}',
      '.lic-btns{display:flex;gap:9px}',
      '.lic-btn{flex:1;padding:11px;border-radius:11px;border:0;font-size:14.5px;',
      '  font-weight:700;cursor:pointer;background:#2f6bff;color:#fff}',
      '.lic-btn.ghost{background:rgba(255,255,255,.1);color:#dce6f7}',
      '.lic-btn:active{filter:brightness(.9)}',
      '.lic-msg{margin-top:10px;font-size:12.5px;min-height:17px;line-height:1.5}',
      '.lic-msg.ok{color:#5fe0a6}.lic-msg.err{color:#ff8a9b}',
      '.lic-footbar{position:fixed;left:0;right:0;bottom:0;z-index:99980;',
      '  background:#121826e6;border-top:1px solid rgba(255,255,255,.12);',
      '  color:#dce6f7;padding:9px 14px;display:flex;align-items:center;gap:10px;',
      '  font-size:12.5px;backdrop-filter:blur(8px)}',
      '.lic-footbar button{background:#2f6bff;border:0;color:#fff;border-radius:8px;',
      '  padding:6px 12px;font-size:12.5px;font-weight:700;cursor:pointer;flex:0 0 auto}',
      /* 试用中右上角小胶囊：只在 state=running 时出现，给用户一个天数感知 */
      '.lic-chip{position:fixed;top:8px;right:10px;z-index:99970;',
      '  background:rgba(18,24,38,.86);border:1px solid rgba(255,255,255,.14);',
      '  color:#dce6f7;border-radius:999px;padding:5px 12px;font-size:12px;',
      '  backdrop-filter:blur(6px);font-family:-apple-system,"PingFang SC",sans-serif}',
      '.lic-chip b{color:#5fe0a6}'
    ].join('\n');
    document.head.appendChild(c);
  }

  /* ---------------- 工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
    });
  }
  function copy(text, btn) {
    var done = function () {
      if (btn) { var o = btn.textContent; btn.textContent = '已复制'; setTimeout(function () { btn.textContent = o; }, 1200); }
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
      } else fallbackCopy(text, done);
    } catch (e) { fallbackCopy(text, done); }
  }
  function fallbackCopy(text, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta); done();
    } catch (e) { /* 复制失败不影响其余流程 */ }
  }

  /* ---------------- 卡密自检（不依赖服务端，抽出卡内绑定机器码做预比对）----------------
   * 卡密 payload 段是 Crockford Base32（24 字符 / 15 字节），机器码落在第 5~14 字节。
   * 与 LicenseCrypto.kt 的 decode 同构，仅用于「提前提示不匹配」，最终仍以服务端校验为准。 */
  function licB32Decode(s) {
    var A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    var fix = { 'I': '1', 'L': '1', 'O': '0', 'U': 'V' };
    s = (s || '').toUpperCase().replace(/[\s\-_]/g, '');
    var acc = 0, nbits = 0, out = [];
    for (var i = 0; i < s.length; i++) {
      var ch = fix[s[i]] || s[i];
      var v = A.indexOf(ch);
      if (v < 0) return null;
      acc = (acc << 5) | v; nbits += 5;
      if (nbits >= 8) { nbits -= 8; out.push((acc >> nbits) & 0xFF); }
    }
    return out;
  }
  function licSelfCheck(card) {
    try {
      var c = card.replace(/\s+/g, '');
      if (!/^ORB1-/i.test(c)) return null;
      var rest = c.slice(4).replace(/^-+/, '');
      var m = rest.match(/^([0-9A-HJKMNP-TV-Za-z]{24})-/);
      if (!m) return null;
      var bytes = licB32Decode(m[1]);
      if (!bytes || bytes.length < 15) return null;
      var machine = '';
      for (var i = 4; i < 14; i++) machine += String.fromCharCode(bytes[i]);
      return { machine: machine };
    } catch (e) { return null; }
  }

  /* ---------------- 面板 ---------------- */
  function buildPanel() {
    injectCss();
    var mask = document.createElement('div');
    mask.className = 'lic-mask';
    mask.id = 'licMask';
    mask.innerHTML =
      '<div class="lic-card">' +
      '<button class="lic-close" id="licClose" type="button" aria-label="关闭">×</button>' +
      '<h3 id="licTitle">' + (st.state === 'expired' ? '试用已结束' : '需要激活') + '</h3>' +
      '<p class="lic-sub" id="licSub"></p>' +
      '<div class="lic-row"><span class="k">机器码</span>' +
      '  <span class="v" id="licMachine">—</span>' +
      '  <button class="copy" id="licCopyMachine">复制</button></div>' +
      '<div class="lic-row"><span class="k">客服微信</span>' +
      '  <span class="v" id="licWx">' + esc(WX_ID) + '</span>' +
      '  <button class="copy" id="licCopyWx">复制</button></div>' +
      '<img class="lic-qr" id="licQr" src="/img/wx_qr.jpg" alt="客服微信二维码">' +
      '<textarea class="lic-code" id="licCode" rows="3" autocapitalize="off" autocorrect="off" ' +
      '  spellcheck="false" autocomplete="off" inputmode="text" ' +
      '  placeholder="把客服发来的完整卡密粘贴到这里（共 116 个字符），必须包含 ORB1- 前缀，勿改大小写"></textarea>' +
      '<div class="lic-btns">' +
      '  <button class="lic-btn" id="licActivate">激活</button>' +
      '  <button class="lic-btn ghost" id="licStart">开始试用</button>' +
      '</div>' +
      '<div class="lic-msg" id="licMsg"></div>' +
      '<p class="lic-tip" id="licTip"></p>' +
      '</div>';
    document.body.appendChild(mask);

    mask.addEventListener('click', function (e) { if (e.target === mask) { /* 点遮罩不关闭：必须走激活流程 */ } });
    document.getElementById('licCopyMachine').onclick = function () { copy(st.machine, this); };
    document.getElementById('licCopyWx').onclick = function () { copy(WX_ID, this); };
    document.getElementById('licActivate').onclick = doActivate;
    document.getElementById('licStart').onclick = doStartTrial;
    document.getElementById('licClose').onclick = hidePanel;
    var ta = document.getElementById('licCode');
    ta.addEventListener('paste', function (e) {
      // 粘贴时立刻清掉微信/记事本常带的换行与多余空格
      setTimeout(function () { ta.value = normalizeCard(ta.value); }, 0);
    });
    ta.addEventListener('input', function () {
      ta.value = normalizeCard(ta.value);
    });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doActivate();
    });
    panel = mask;
  }

  function paintPanel() {
    if (!panel) return;
    var sub = document.getElementById('licSub');
    var tip = document.getElementById('licTip');
    var startBtn = document.getElementById('licStart');
    if (st.state === 'idle') {
      sub.textContent = '本软件可先试用 15 天。点「开始试用」即开始计时，到期后需提供确认收货订单截图与机器码获取激活码。';
    } else if (st.state === 'expired') {
      sub.textContent = '试用已结束。请把「确认收货订单截图」和下面的机器码一起发给客服，获取激活码后继续。';
    } else {
      sub.textContent = '当前状态：' + (st.state === 'activated' ? '已激活，可正常使用。' : '试用中');
    }
    document.getElementById('licMachine').textContent = st.machine || '—';
    startBtn.style.display = st.state === 'idle' ? '' : 'none';
    tip.innerHTML = st.state === 'activated'
      ? '已激活，可正常使用。'
      : '<b>请勿在设置里清除本应用数据</b>：清除后机器码会变，已激活的卡密将失效。';
  }

  function showPanel(reason) {
    // 已激活 / 试用中：除非用户主动点「去激活」或到期，绝不自动弹窗
    if ((st.state === 'running' || st.state === 'activated') && reason !== 'force') return;
    // 二次保险：即使 blocked 字段因竞态/缓存异常为 true，只要状态是 running/activated 也不自动弹
    if (!st.blocked && reason !== 'force') return;
    if (!panel) buildPanel();
    paintPanel();
    if (reason && reason !== 'force') {
      var m = document.getElementById('licMsg');
      m.textContent = reason; m.className = 'lic-msg err';
    }
    panel.style.display = 'flex';
    panelOpen = true;
    enableGuard();
  }

  function hidePanel() {
    if (panel) panel.style.display = 'none';
    panelOpen = false;
  }

  function msg(text, ok) {
    var m = document.getElementById('licMsg');
    if (!m) return;
    m.textContent = text || '';
    m.className = 'lic-msg ' + (ok ? 'ok' : 'err');
  }

  /* ---------------- 守卫 ----------------
   * 用捕获阶段才能真正拦住 libPlay() 这类「点击即发生」的动作：
   * 冒泡阶段等我们接手时，元素自己的处理函数早就跑完了。
   * 代价是会顺带掐掉既有的「点外面关下拉」等 document 冒泡监听，
   * 所以拦截成功后补发一次合成点击把它们补回来。 */
  function onDocCapture(e) {
    // 试用中 / 已激活：任何情况下都不拦截功能点击
    if (st.state === 'running' || st.state === 'activated') return;
    if (!st.blocked) return;
    var t = e.target;
    if (!t || t.nodeType !== 1) {
      // 点的是 svg 内部的 <use>/<path>，往上找最近的 <a>
      t = (e.target && e.target.parentElement) || null;
    }
    var el = (t && t.closest) ? t.closest('[data-lic], .lic-mask, input, textarea, select, [contenteditable], a[href="#"]') : null;
    if (!el) return;
    var hit = (t.closest) ? t.closest('[data-lic]') : null;
    if (!hit || hit.closest('.lic-mask')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();
    // 补发合成点击，恢复「点外面关下拉」的既有行为
    setTimeout(function () {
      try { document.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: false })); } catch (err) { }
    }, 0);
    showPanel();
  }

  function enableGuard() {
    if (guardOn) return;
    document.addEventListener('click', onDocCapture, true);
    guardOn = true;
  }

  /* ---------------- 业务动作 ---------------- */
  function get(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.json(); });
  }
  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },   // 必须 JSON：服务端只对 json 预读 body
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }

  function doStartTrial() {
    var btn = document.getElementById('licStart');
    if (btn) { btn.disabled = true; btn.textContent = '开启中…'; }
    // 乐观更新：立即放行，避免用户还没等请求回来就点功能被守卫拦住。
    // 本地 HTTP 请求几乎不会失败；若真失败，也保留试用态并后台重试，
    // 而不是立刻回滚让用户感觉「点试用没反应」。
    var was = st;
    st = { state: 'running', blocked: false, daysLeft: 15, expireAt: Date.now() + 15 * 86400000, machine: was.machine, kind: 0 };
    hidePanel();
    removeFootBar();
    paintChip();
    console.log('[license] start-trial optimistic: running');
    get(API + 'start-trial').then(function (s) {
      console.log('[license] start-trial server ok', JSON.stringify(s));
      apply(s);
      msg('试用已开启，可用 15 天。', true);
    }).catch(function (e) {
      console.error('[license] start-trial server fail', e && e.message ? e.message : e);
      // 保留乐观态，让用户能继续用；3 秒后后台再同步一次
      paintChip();
      msg('试用已本地开启，正在同步状态…', true);
      setTimeout(function () {
        get(API + 'status').then(apply).catch(function () { });
      }, 3000);
    }).finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = '开始试用'; }
    });
  }

  function normalizeCard(s) {
    // 去掉所有空白（换行、空格、制表符），保留 '-' '_' 等卡密有效字符
    return String(s == null ? '' : s).replace(/\s+/g, '');
  }
  /* ---------------- 卡密预检（提交前先用公钥本地验签）----------------
   * 目的不是更安全（真正的判定仍在原生层），而是把笼统的「signature / 卡密无效」
   * 翻译成人能看懂的原因：长度不对、签名段字节数不对、字符被改（大小写 / 0-O / 1-I-l）。
   * 公钥本来就在 APK 里，放前端不增加任何泄露面。
   * crypto.subtle 只在安全上下文可用（http://127.0.0.1 算安全上下文）；
   * 拿不到就整体跳过预检，绝不影响正常激活。 */
  var PUB_SPKI_B64 =
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAExuVEOkY4RMcZNneycaDOidhUPKnhrXqKZ0G4OYfo9' +
    '0y70uptjPPkP4XwZnoLb5K0WhvwcyDwgx9lV2x+zXC5Lg==';
  var CARD_EXPECT_LEN = 116;   // ORB1(4) + '-' + payload(24) + '-' + 签名(86)

  function licB64Decode(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function licB64UrlDecode(s) {
    var t = String(s || '').replace(/[\s]/g, '');
    var pad = '';
    var m = t.length % 4;
    if (m) pad = new Array(5 - m).join('=');
    return licB64Decode(t.replace(/-/g, '+').replace(/_/g, '/') + pad);
  }

  function licPrecheck(card) {
    return new Promise(function (resolve) {
      var out = { ran: false, ok: false, reason: '' };
      var finish = function () { resolve(out); };
      try {
        if (!window.crypto || !crypto.subtle || typeof atob !== 'function') return finish();
        var c = String(card || '');
        if (c.length !== CARD_EXPECT_LEN) {
          out.ran = true;
          out.reason = '卡密共 ' + c.length + ' 个字符，完整卡密应为 ' + CARD_EXPECT_LEN +
            ' 个字符 —— 多半复制时被截断或首尾漏了';
          return finish();
        }
        var m = /^ORB1-([0-9A-HJKMNP-TV-Za-z]{24})-([A-Za-z0-9_-]+)$/.exec(c);
        if (!m) { out.ran = true; out.reason = '格式不对：应为 ORB1-<24 位>-<签名>'; return finish(); }
        var b32 = licB32Decode(m[1].toUpperCase());
        if (!b32 || b32.length < 15) { out.ran = true; out.reason = '卡面前段解析失败，请重新整段复制'; return finish(); }
        var payload = new Uint8Array(b32.slice(0, 15));
        var sig = licB64UrlDecode(m[2]);
        if (sig.length !== 64) {
          out.ran = true;
          out.reason = '签名段解出 ' + sig.length + ' 字节，应为 64 —— 卡密在复制时被改动过';
          return finish();
        }
        crypto.subtle.importKey('spki', licB64Decode(PUB_SPKI_B64),
          { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
          .then(function (key) {
            return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, payload);
          })
          .then(function (ok) {
            out.ran = true; out.ok = !!ok;
            if (!ok) out.reason = '签名校验未通过：卡面字符被改动过（注意大小写、0 与 O、1 与 I/l），请让客服重发并整段复制';
            finish();
          })
          .catch(function () { finish(); });
      } catch (e) { finish(); }
    });
  }

  function doActivate() {
    var code = normalizeCard(document.getElementById('licCode').value);
    if (!code) { msg('请先粘贴激活卡密。', false); return; }
    if (!/^ORB1-/i.test(code)) {
      msg('卡密缺少 ORB1- 前缀，请从开头完整复制（如：ORB1-XXXX-XXXX）。', false);
      return;
    }
    if (code.length < CARD_EXPECT_LEN) {
      msg('卡密长度不足：收到 ' + code.length + ' 字符，完整卡密应为 ' + CARD_EXPECT_LEN +
        ' 字符。请重新整段复制（不要手动输入）。', false);
      return;
    }
    if (code.length > CARD_EXPECT_LEN) {
      msg('卡密多出 ' + (code.length - CARD_EXPECT_LEN) + ' 个字符，可能把别的内容一起复制进来了，请只复制卡密本体。', false);
      return;
    }
    // 卡密自检：抽出卡内绑定的机器码，与本机对比，提前提示不匹配（不改大小写、不拦截提交）
    var sc = licSelfCheck(code);
    if (sc && sc.machine && sc.machine !== st.machine) {
      msg('提示：本卡绑定机器码 ' + sc.machine + '，与本机 ' + st.machine + ' 不一致，可能无法在本机激活。', false);
    }
    msg('正在激活…', true);
    licPrecheck(code).then(function (pc) {
      if (pc.ran && !pc.ok) {
        msg('卡密自检未通过：' + pc.reason + '。本机校验未执行，请让客服重发一张并整段复制。', false);
        return null;
      }
      return post(API + 'activate', { code: code }).then(function (r) {
        console.log('[license] activate response', JSON.stringify(r));
        if (r && r.ok) {
          msg(r.msg || '激活成功。', true);
          return get(API + 'status').then(function (s) { apply(s); }) || null;
        }
        var detail = (r && r.msg) ? r.msg : '激活失败。';
        if (r && r.code) detail += '（错误码：' + r.code + '）';
        if (r && r.recvLen && r.expectLen && r.recvLen !== r.expectLen) {
          detail += '｜本机收到 ' + r.recvLen + ' 字符，完整卡密应为 ' + r.expectLen + ' 字符，说明复制时被截断/多粘了内容';
        } else if (r && r.cardMachine) {
          detail += '｜卡内机器码 ' + r.cardMachine + '，本机 ' + (r.mine || st.machine || '—');
        }
        msg(detail, false);
      });
    }).catch(function (e) {
      console.error('[license] activate network error', e && e.message ? e.message : e);
      msg('网络异常，请重试。', false);
    });
  }

  function apply(s) {
    if (!s) return;
    var wasBlocked = st.blocked;
    st = s;
    if (st.blocked) {
      addFootBar();
      showPanel('force');
    } else {
      if (wasBlocked) removeFootBar();
      hidePanel();
    }
    paintChip();
    onChanged();
  }

  /* ---------------- 底部常驻条 + 右上角天数胶囊 ---------------- */
  function addFootBar() {
    if (document.getElementById('licFoot')) return;
    injectCss();
    var b = document.createElement('div');
    b.className = 'lic-footbar';
    b.id = 'licFoot';
    b.innerHTML = '<span id="licFootTxt">试用已结束 · 需激活</span>' +
      '<button id="licFootBtn">去激活</button>';
    document.body.appendChild(b);
    document.getElementById('licFootBtn').onclick = function () { showPanel('force'); };
  }
  function removeFootBar() {
    var b = document.getElementById('licFoot');
    if (b) b.parentNode.removeChild(b);
  }

  /** 脚本编辑（?manualrec=1）是整屏录制台：右上「试用中」胶囊会压住顶栏、底部常驻条会盖住波形条，两种 UI 一律不显示（授权态本身不变，点返回回到首页照常出现）。 */
  function trialUiSuppressed() {
    if (window.__orbitHideTrialChip) return true;
    var q = '';
    try { q = window.location.search || ''; } catch (e) { q = ''; }
    return q.indexOf('manualrec=1') >= 0;
  }
  function killTrialUi() {
    var c = document.getElementById('licChip');
    if (c && c.parentNode) c.parentNode.removeChild(c);
    removeFootBar();
  }

  /** 试用中显示剩余天数胶囊，其余状态隐藏。 */
  function paintChip() {
    // 脚本编辑页整屏录制：胶囊/底部条会挡住顶栏与波形条，直接从 DOM 抹掉
    if (trialUiSuppressed()) { killTrialUi(); return; }
    var el = document.getElementById('licChip');
    if (st.state !== 'running' || st.blocked) {
      if (el) el.parentNode.removeChild(el);
      removeFootBar();
      return;
    }
    if (!el) {
      injectCss();
      el = document.createElement('div');
      el.className = 'lic-chip';
      el.id = 'licChip';
      // 点试用胶囊 = 主动去激活（试用期间也随时可激活，同「去激活」入口）
      el.title = '点击去激活';
      el.style.cursor = 'pointer';
      el.addEventListener('click', function () { showPanel('force'); });
      document.body.appendChild(el);
    }
    el.innerHTML = '试用中 · 剩余 <b>' + Math.max(0, st.daysLeft | 0) + '</b> 天';
  }

  function onChanged() {
    var f = document.getElementById('licFootTxt');
    if (f) f.textContent = st.state === 'activated' ? '已激活'
      : (st.state === 'idle' ? '未开始试用' : '试用已结束 · 需激活');
  }

  /* ---------------- 生命周期 ---------------- */
  function refresh() {
    return get(API + 'status').then(function (s) { apply(s); }).catch(function () { });
  }

  window.__onLicenseExpired = function () {
    refresh();
    showPanel('试用已到期，请输入激活码。');
  };
  window.__onLicenseReady = function () {
    refresh();
  };

  function boot() {
    // 先静默取一次状态：blocked 时面板会自己弹出来（新用户一进来就提示），
    // 因此这里不能「先刷新再决定」，否则首屏会出现一帧的正常界面。
    refresh();
    setInterval(refresh, 30000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
    window.addEventListener('focus', refresh);
    // 深链 ?panel=license：手动打开激活面板
    try {
      if (/[?&]panel=license\b/.test(location.search)) setTimeout(function () { showPanel('force'); }, 300);
    } catch (e) { }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.licenseApi = {
    status: function () { return st; },
    refresh: refresh,
    show: function (why) { showPanel(why); },
    hide: function () { hidePanel(); }
  };
})();
