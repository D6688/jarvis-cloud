/* ============================================================================
 * JARVIS 2.0 · 12-plugins.js
 * 插件系统：把「能力」做成可插拔单元，模型通过 ⟨tool:插件.动作 {参数}⟩ 调用
 *
 * 内置插件：
 *   memory   · 记忆（记住 / 回忆 / 清空）
 *   schedule · 日程（加入今日安排 / 查看安排）
 *   network  · 联网（搜索 / 抓网页 / 打开网址）
 *   system   · 本机权限（系统信息 / 应用 / 音量 / 文件 / 终端 / 截图 …，转发到本机权限桥）
 *   maps     · 地图（跳到全球城市全息）
 *
 * 扩展方式（两种）：
 *   1) 运行时注册：JV.plugins.add({ id, name, desc, tools:[{name,desc,args,run}], prompt });
 *   2) 放文件：jarvis/plugins/<id>.js，内容调用 JV.plugins.add(...)；
 *      页面启动时会尝试加载 jarvis/plugins/index.json 里列出的文件（单文件版无此目录，自动跳过）
 * ==========================================================================*/
(function () {
  'use strict';
  var JV = window.JV;
  if (!JV) return;
  var bus = JV.bus;
  var U = JV.util;

  var plugins = Object.create(null);
  var order = [];

  function enabledOf(id) {
    var s = JV.settings.plugins || {};
    return s[id] !== false;      // 默认开启
  }

  function add(def) {
    if (!def || !def.id) return false;
    var id = String(def.id);
    var old = plugins[id];
    plugins[id] = {
      id: id,
      name: def.name || id,
      desc: def.desc || '',
      icon: def.icon || '●',
      tools: (def.tools || []).map(function (t) {
        return { name: t.name, desc: t.desc || '', args: t.args || {}, run: t.run };
      }),
      prompt: def.prompt || '',
      builtin: !!def.builtin
    };
    if (!old) order.push(id);
    bus.emit('plugins:changed', { id: id, added: !old });
    return true;
  }

  function list() {
    return order.map(function (id) {
      var p = plugins[id];
      return { id: p.id, name: p.name, desc: p.desc, icon: p.icon, builtin: p.builtin,
               enabled: enabledOf(id), tools: p.tools.map(function (t) { return t.name; }) };
    });
  }

  function toggle(id, on) {
    if (!JV.settings.plugins) JV.settings.plugins = {};
    JV.settings.plugins[id] = !!on;
    JV.saveSettings();
    bus.emit('plugins:changed', { id: id, enabled: !!on });
  }

  function findTool(name) {
    for (var i = 0; i < order.length; i++) {
      var p = plugins[order[i]];
      if (!enabledOf(p.id)) continue;
      for (var j = 0; j < p.tools.length; j++) {
        if (p.tools[j].name === name) return { plugin: p, tool: p.tools[j] };
      }
    }
    return null;
  }

  function run(name, args) {
    var hit = findTool(name);
    if (hit) {
      try {
        var r = hit.tool.run(args || {}, { plugin: hit.plugin });
        return Promise.resolve(r).then(function (v) {
          if (v && typeof v === 'object' && 'ok' in v) return v;
          return { ok: true, result: String(v == null ? '' : v) };
        }).catch(function (e) {
          return { ok: false, result: '插件执行失败：' + ((e && e.message) || e) };
        });
      } catch (e) {
        return Promise.resolve({ ok: false, result: '插件执行失败：' + ((e && e.message) || e) });
      }
    }
    // 没注册 → 交给本机权限桥（system / network 工具都在那边）
    if (JV.tools && JV.tools.run) return JV.tools.run(name, args || {});
    return Promise.resolve({ ok: false, result: '没有这个工具：' + name });
  }

  function promptFragment() {
    var lines = [];
    order.forEach(function (id) {
      var p = plugins[id];
      if (!enabledOf(id)) return;
      if (!p.tools.length) return;
      p.tools.forEach(function (t) {
        lines.push('⟨tool:' + t.name + '⟩ ' + (t.desc || ''));
      });
      if (p.prompt) lines.push(p.prompt);
    });
    return lines.length ? ('已启用插件：\n' + lines.join('\n')) : '';
  }

  /* ------------------------------------------------------------ 内置插件 */
  add({
    id: 'memory', name: '记忆', icon: '◈', builtin: true,
    desc: '长期记忆与对话上下文',
    tools: [
      { name: 'memory.remember', desc: '记住一条信息：{text}', args: { text: 'string' },
        run: function (a) {
          var ok = JV.memory.remember(a.text);
          return { ok: ok, result: ok ? '已记住：' + a.text : '这条已经在记忆里了' };
        } },
      { name: 'memory.recall', desc: '回忆相关记忆：{query}', args: { query: 'string' },
        run: function (a) {
          var r = JV.memory.recall(a.query || '');
          return { ok: true, result: r.length ? r.map(function (x) { return '· ' + x.text; }).join('\n') : '没有找到相关记忆' };
        } },
      { name: 'memory.clear', desc: '清空记忆', args: {},
        run: function () { JV.memory.clear(); return { ok: true, result: '记忆已清空' }; } }
    ]
  });

  add({
    id: 'schedule', name: '日程', icon: '◷', builtin: true,
    desc: '今日安排（本地保存，显示在 HUD 右栏）',
    tools: [
      { name: 'agenda.add', desc: '加入今日安排：{title, time?}', args: { title: 'string', time: 'string?' },
        run: function (a) {
          if (!a.title) return { ok: false, result: '缺少安排内容' };
          JV.hud.addAgenda({ when: a.time || '今天', title: String(a.title).slice(0, 60), detail: a.time ? ('时间 ' + a.time) : '由 JARVIS 记录' });
          return { ok: true, result: '已加入今日安排：' + a.title };
        } },
      { name: 'agenda.list', desc: '查看今日安排', args: {},
        run: function () {
          var list = JV.hud.getAgenda();
          return { ok: true, result: list.length ? list.map(function (x) { return '· ' + x.when + ' ' + x.title; }).join('\n') : '今天还没有安排' };
        } }
    ]
  });

  add({
    id: 'network', name: '联网', icon: '◎', builtin: true,
    desc: '搜索、抓网页、打开网址（走本机权限桥，国内网络可用）',
    prompt: '联网插件的 web.search / web.fetch 走本机代理（Bing 搜索、网页正文抓取），可直接获取实时信息；关键事实请标明来源 URL。',
    tools: [
      { name: 'web.search', desc: '联网搜索：{q, n?}', args: { q: 'string', n: 'number?' },
        run: function (a) { return JV.tools.run('web.search', a); } },
      { name: 'web.fetch', desc: '抓取网页正文：{url}', args: { url: 'string' },
        run: function (a) { return JV.tools.run('web.fetch', a); } },
      { name: 'open.url', desc: '用浏览器打开网址：{url}', args: { url: 'string' },
        run: function (a) { return JV.tools.run('open.url', a); } }
    ]
  });

  add({
    id: 'system', name: '本机权限', icon: '⌘', builtin: true,
    desc: '系统信息 / 应用 / 音量 / 媒体 / 剪贴板 / 文件 / 截图 / 通知 / 终端',
    tools: [
      { name: 'system.info', desc: '系统信息', args: {}, run: function (a) { return JV.tools.run('system.info', a); } },
      { name: 'system.volume', desc: '音量：{action, level?}', args: {}, run: function (a) { return JV.tools.run('system.volume', a); } },
      { name: 'app.open', desc: '打开应用：{name}', args: {}, run: function (a) { return JV.tools.run('app.open', a); } },
      { name: 'app.quit', desc: '退出应用：{name}', args: {}, run: function (a) { return JV.tools.run('app.quit', a); } },
      { name: 'app.list', desc: '运行中的应用', args: {}, run: function (a) { return JV.tools.run('app.list', a); } },
      { name: 'media.control', desc: '媒体控制：{action}', args: {}, run: function (a) { return JV.tools.run('media.control', a); } },
      { name: 'clipboard.get', desc: '读剪贴板', args: {}, run: function (a) { return JV.tools.run('clipboard.get', a); } },
      { name: 'clipboard.set', desc: '写剪贴板：{text}', args: {}, run: function (a) { return JV.tools.run('clipboard.set', a); } },
      { name: 'screenshot', desc: '截图', args: {}, run: function (a) { return JV.tools.run('screenshot', a); } },
      { name: 'file.list', desc: '列目录：{path}', args: {}, run: function (a) { return JV.tools.run('file.list', a); } },
      { name: 'file.read', desc: '读文件：{path}', args: {}, run: function (a) { return JV.tools.run('file.read', a); } },
      { name: 'file.write', desc: '写文件：{path, content}', args: {}, run: function (a) { return JV.tools.run('file.write', a); } },
      { name: 'notify', desc: '系统通知：{title, message}', args: {}, run: function (a) { return JV.tools.run('notify', a); } },
      { name: 'system.lock', desc: '锁屏', args: {}, run: function (a) { return JV.tools.run('system.lock', a); } },
      { name: 'shell.run', desc: '执行命令：{cmd}', args: {}, run: function (a) { return JV.tools.run('shell.run', a); } }
    ]
  });

  add({
    id: 'maps', name: '地图', icon: '◍', builtin: true,
    desc: '全球城市全息（真实街道 + 全息楼群）',
    tools: [
      { name: 'map.city', desc: '打开某城市的全息地图：{city}', args: { city: 'string' },
        run: function (a) {
          var city = String(a.city || '').trim();
          if (!city) return { ok: false, result: '缺少城市名' };
          var ent = JV.show('globe');
          if (!ent) return { ok: false, result: '地图场景未加载' };
          ent.setMode('earth');
          setTimeout(function () {
            ent.focus(city).then(function (r) {
              bus.emit('map:focus', r);
            });
          }, 300);
          return { ok: true, result: '正在加载 ' + city + ' 的城市全息' };
        } }
    ]
  });

  /* ------------------------------------------- 外部插件目录（可选） */
  function loadExternalPlugins() {
    if (location.protocol === 'file:') return;
    var base = '';
    // 服务版：jarvis/plugins/；单文件在仓库根时也尝试 jarvis/plugins/
    var candidates = [ 'jarvis/plugins/index.json', 'plugins/index.json' ];
    (function tryNext(i) {
      if (i >= candidates.length) return;
      fetch(candidates[i], { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j) return tryNext(i + 1);
          var dir = candidates[i].replace(/index\.json$/, '');
          var files = Array.isArray(j) ? j : (j.files || []);
          files.forEach(function (f) {
            var s = document.createElement('script');
            s.src = dir + f;
            s.async = true;
            document.head.appendChild(s);
          });
          console.log('[plugins] 外部插件', files.length, '个');
        })
        .catch(function () { tryNext(i + 1); });
    })(0);
  }
  setTimeout(loadExternalPlugins, 1500);

  JV.plugins = {
    add: add, list: list, toggle: toggle, run: run, findTool: findTool,
    promptFragment: promptFragment, toolNames: function () {
      var names = [];
      order.forEach(function (id) {
        if (!enabledOf(id)) return;
        plugins[id].tools.forEach(function (t) { names.push(t.name); });
      });
      return names;
    }
  };

  // 插件清单变化 → 通知 agent 刷新 system prompt 片段
  bus.on('plugins:changed', function () {
    if (JV.agent && JV.agent.refreshPrompt) JV.agent.refreshPrompt();
  });
})();
