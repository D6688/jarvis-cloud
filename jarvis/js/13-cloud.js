/* ============================================================================
 * JARVIS 2.0 · 13-cloud.js
 * 云端模式：把本机 4 个服务替换成一台云服务器（静态页面 + 全部 API）
 *
 * 用法：
 *   https://your-domain/?cloud=https://your-domain      （页面与 API 同源，可省略 = 自动识别）
 *   https://your-domain/?cloud=https://api.xxx&asr=wss://asr.xxx&token=xxx
 *
 * 识别规则：
 *   1) URL 参数 cloud= 优先
 *   2) localStorage jarvis2.cloud
 *   3) 如果页面不是 127.0.0.1/localhost 且同源有 /api/health → 自动进入云端模式
 * ==========================================================================*/
(function () {
  'use strict';
  var qs = new URLSearchParams(location.search);
  function ls(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function save(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {} }

  var base = (qs.get('cloud') || ls('jarvis2.cloud') || '').replace(/\/+$/, '');
  var asr = qs.get('asr') || ls('jarvis2.asr') || '';
  var token = qs.get('token') || ls('jarvis2.token') || '';
  if (qs.get('cloud')) save('jarvis2.cloud', base);
  if (qs.get('asr')) save('jarvis2.asr', asr);
  if (qs.get('token')) save('jarvis2.token', token);

  var isLocalPage = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
  window.JV_CLOUD = {
    base: base,
    asrWs: asr,
    token: token,
    mode: base ? 'cloud' : (isLocalPage ? 'local' : 'probing'),
    isCloud: function () { return !!this.base; },
    setBase: function (b, t) {
      this.base = String(b || '').replace(/\/+$/, '');
      if (t) { this.token = t; save('jarvis2.token', t); }
      save('jarvis2.cloud', this.base);
      this.mode = this.base ? 'cloud' : 'local';
      location.reload();
    },
    headers: function () {
      var h = { 'content-type': 'application/json' };
      if (this.token) h.authorization = 'Bearer ' + this.token;
      return h;
    }
  };

  // 非本机、且未显式配置 → 探测同源 /api/health，命中即云端模式
  if (!base && !isLocalPage) {
    fetch('/api/health', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok && j.service === 'jarvis-cloud') {
        window.JV_CLOUD.base = location.origin;
        window.JV_CLOUD.mode = 'cloud';
        if (j.asrWs && !asr) window.JV_CLOUD.asrWs = j.asrWs;
        console.log('[cloud] 同源云服务已就绪', j);
      }
    }).catch(function () {});
  }
})();
