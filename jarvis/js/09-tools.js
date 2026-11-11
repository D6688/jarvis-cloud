/* ============================================================================
 * JARVIS 2.0 · 09-tools.js
 * 本机权限桥客户端：系统信息 / 应用 / 音量 / 媒体 / 剪贴板 / 截图 / 文件 /
 * 通知 / 锁屏 / 终端命令 / 联网抓取
 *
 * 依赖：JV（00-core.js）；后端：jarvis/server/system_bridge.mjs（127.0.0.1:8824）
 * 生产约定：
 *   - 模型在回复末尾输出 ⟨tool:工具名 {"参数":"值"}⟩，由 08-boot 解析并执行
 *   - 所有调用受 JV.settings.grants 控制（界面可关）
 * ==========================================================================*/
(function () {
  'use strict';
  var JV = window.JV;
  var U = JV.util;
  var bus = JV.bus;

  var CLOUD = window.JV_CLOUD || { base: '', token: '' };
  var BASE = CLOUD.base || 'http://127.0.0.1:8824';
  function cloudMode() { return !!CLOUD.base; }

  // 工具 → 权限分类
  var CATEGORY = {
    'system.info': 'system', 'system.volume': 'system', 'system.lock': 'system', 'system.sleep': 'system',
    'app.list': 'system', 'app.open': 'system', 'app.quit': 'system', 'media.control': 'system',
    'clipboard.get': 'system', 'clipboard.set': 'system', 'notify': 'system', 'screenshot': 'system',
    'file.list': 'files', 'file.read': 'files', 'file.write': 'files',
    'shell.run': 'shell',
    'web.fetch': 'network', 'open.url': 'network'
  };

  var TOOL_DOC = [
    'system.info() 系统信息（时间/电池/内存/磁盘/负载）',
    'system.volume(action=set|get|mute|unmute, level=0-100) 音量',
    'app.open(name) / app.quit(name) / app.list() 应用',
    'media.control(action=play|pause|next|prev) 媒体播放',
    'clipboard.get() / clipboard.set(text) 剪贴板',
    'screenshot() 全屏截图到桌面',
    'file.list(path) / file.read(path) / file.write(path, content) 文件',
    'notify(title, message) 系统通知',
    'system.lock() 锁屏 / system.sleep() 显示器休眠',
    'shell.run(cmd) 执行终端命令',
    'web.fetch(url) 联网抓取网页正文 / open.url(url) 浏览器打开'
  ].join('\n');

  var tools = {
    available: false,
    health: null,
    error: '',
    calls: []          // 最近的调用记录（HUD 可展示）
  };

  function grantOf(name) { return CATEGORY[name] || 'system'; }

  function granted(name) {
    var g = JV.settings.grants || {};
    var cat = grantOf(name);
    return g[cat] !== false;
  }

  function probe(timeoutMs) {
    return new Promise(function (resolve) {
      if (location.protocol === 'https:') { tools.available = false; tools.error = 'https 页面不能连本机权限桥'; resolve(false); return; }
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 1200);
      var healthUrl = cloudMode() ? (CLOUD.base + '/api/health') : (BASE + '/health');
      fetch(healthUrl, { signal: ctrl.signal, cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          clearTimeout(timer);
          tools.available = !!(j && j.ok);
          tools.health = j || null;
          tools.error = '';
          bus.emit('tools:status', { available: tools.available, health: tools.health });
          resolve(tools.available);
        })
        .catch(function (e) {
          clearTimeout(timer);
          tools.available = false;
          tools.error = e && e.name === 'AbortError' ? '超时' : (e && e.message) || '不可达';
          bus.emit('tools:status', { available: false, error: tools.error });
          resolve(false);
        });
    });
  }

  function run(name, args) {
    if (!name) return Promise.resolve({ ok: false, error: '缺少工具名' });
    // 云端模式：只保留「联网/地图」类工具，本机控制工具明确报不可用
    if (cloudMode()) {
      var CLOUD_TOOLS = {
        'web.search': function (a) {
          return fetch(CLOUD.base + '/api/search?q=' + encodeURIComponent(a.q || '') + '&n=' + (a.n || 5), { headers: CLOUD.headers() })
            .then(function (r) { return r.json(); })
            .then(function (j) {
              if (!j.ok) return { ok: false, result: '搜索失败' };
              return { ok: true, result: '引擎：' + j.engine + '\n' + j.results.map(function (x, i) {
                return (i + 1) + '. ' + x.title + '\n   ' + x.url + (x.snippet ? '\n   ' + x.snippet : '');
              }).join('\n') };
            });
        },
        'web.fetch': function (a) {
          return fetch(CLOUD.base + '/api/fetch?url=' + encodeURIComponent(a.url || ''), { headers: CLOUD.headers() })
            .then(function (r) { return r.json(); })
            .then(function (j) { return j.ok ? { ok: true, result: j.text } : { ok: false, result: j.error || '抓取失败' }; });
        },
        'open.url': function (a) { window.open(a.url, '_blank'); return Promise.resolve({ ok: true, result: '已在浏览器打开 ' + a.url }); },
        'map.city': function (a) {
          if (!JV.globe) return Promise.resolve({ ok: false, result: '地图场景未加载' });
          return JV.globe.focus(a.city).then(function (r) { return { ok: !!r.ok, result: r.ok ? ('已加载 ' + a.city + ' 的真实城市') : '城市数据不可用' }; });
        }
      };
      if (CLOUD_TOOLS[name]) return Promise.resolve(CLOUD_TOOLS[name](args || {}));
      return Promise.resolve({ ok: false, result: '云端模式不支持本机工具：' + name + '（手机/眼镜上没有本机权限桥）' });
    }
    if (!granted(name)) {
      return Promise.resolve({ ok: false, error: '权限未开启：' + grantOf(name) + '（可在设置里打开）' });
    }
    var payload = { name: name, args: args || {} };
    tools.calls.push({ name: name, args: payload.args, at: Date.now(), status: 'running' });
    bus.emit('tool:start', payload);
    return fetch(BASE + '/api/tool', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); }).then(function (j) {
      var ok = !!(j && j.ok);
      var result = (j && (j.result || j.error)) || '（无返回）';
      tools.calls[tools.calls.length - 1].status = ok ? 'ok' : 'fail';
      tools.calls[tools.calls.length - 1].result = String(result).slice(0, 400);
      bus.emit('tool:done', { name: name, ok: ok, result: String(result) });
      return { ok: ok, result: String(result), raw: j };
    }).catch(function (e) {
      tools.calls[tools.calls.length - 1].status = 'fail';
      bus.emit('tool:done', { name: name, ok: false, result: '本机权限桥不可达：' + ((e && e.message) || e) });
      return { ok: false, result: '本机权限桥不可达（请先启动 启动Jarvis.command）：' + ((e && e.message) || e) };
    });
  }

  /* ------------------------------------------------ 解析模型输出里的工具调用
   * 支持：⟨tool:system.info⟩ 、⟨tool:system.volume {"action":"set","level":30}⟩、
   *       <tool:...> 以及「⟨工具：xxx⟩」这种中文写法
   */
  function parse(text) {
    if (!text) return null;
    var t = String(text);
    var re = /[⟨<]\s*(?:tool|工具)\s*[:：]\s*([a-zA-Z_.]+)\s*(\{[\s\S]*?\})?\s*[⟩>]/;
    var m = t.match(re);
    if (!m) return null;
    var args = {};
    if (m[2]) {
      try { args = JSON.parse(m[2]); }
      catch (e) {
        try { args = JSON.parse(m[2].replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":').replace(/'/g, '"')); }
        catch (e2) { args = {}; }
      }
    }
    return { name: m[1], args: args, cleaned: t.replace(re, '').trim() };
  }

  function promptFragment() {
    return [
      '可用本机工具（一次只调用一个，格式：⟨tool:工具名 {"参数":"值"}⟩）：',
      TOOL_DOC,
      '规则：调用工具时，回答正文仍用「中文｜English」双行，并在末尾附工具标记；不要编造执行结果，等工具返回后再汇报。'
    ].join('\n');
  }

  JV.tools = {
    endpoint: BASE,
    probe: probe,
    run: run,
    parse: parse,
    promptFragment: promptFragment,
    status: function () { return tools; },
    isAvailable: function () { return tools.available; },
    grantOf: grantOf,
    granted: granted,
    doc: TOOL_DOC
  };

  // 启动后 1s 探测一次
  setTimeout(function () { probe(); }, 1000);
})();
