/* ============================================================================
 * JARVIS 2.0 · 11-memory.js
 * 上下文记忆：短期对话 + 长期记忆（事实），本地持久化，自动压缩
 *
 * 用法（模型/语音都可用）：
 *   「记住：我的项目在 ~/Downloads/产品结构Three.js」→ 写入长期记忆
 *   「我们刚才说到哪」→ 回忆最近对话
 *   「清空记忆」→ 清空
 * ==========================================================================*/
(function () {
  'use strict';
  var JV = window.JV;
  if (!JV) return;
  var bus = JV.bus;
  var U = JV.util;
  var KEY = 'jarvis2.memory.v1';

  var mem = { turns: [], facts: [], updatedAt: 0, summarizedTurns: 0 };

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      mem.turns = Array.isArray(d.turns) ? d.turns.slice(-60) : [];
      mem.facts = Array.isArray(d.facts) ? d.facts.slice(-80) : [];
      mem.summarizedTurns = d.summarizedTurns || 0;
      mem.updatedAt = d.updatedAt || 0;
    } catch (e) {}
  }
  function save() {
    mem.updatedAt = Date.now();
    try {
      localStorage.setItem(KEY, JSON.stringify({
        turns: mem.turns.slice(-40), facts: mem.facts.slice(-60),
        summarizedTurns: mem.summarizedTurns, updatedAt: mem.updatedAt
      }));
    } catch (e) {}
    bus.emit('memory:changed', { turns: mem.turns.length, facts: mem.facts.length });
  }

  function addTurn(role, text) {
    if (!text) return;
    mem.turns.push({ role: role, text: String(text).slice(0, 800), t: Date.now() });
    if (mem.turns.length > 60) mem.turns = mem.turns.slice(-40);
    save();
    maybeSummarize();
  }

  function remember(text, tag) {
    var t = String(text || '').trim();
    if (!t) return false;
    if (mem.facts.some(function (f) { return f.text === t; })) return false;
    mem.facts.push({ text: t.slice(0, 400), tag: tag || 'general', t: Date.now() });
    save();
    return true;
  }

  function forget(idx) {
    if (idx == null) { mem.facts = []; save(); return; }
    mem.facts.splice(idx, 1); save();
  }

  function recall(q) {
    var query = String(q || '').toLowerCase();
    var skip = /^(记住|记一下|清空|清除|忘掉|我们刚才|你还记得|记得什么|聊到哪)/;
    var pool = mem.facts.concat(mem.turns.filter(function (x) {
      return x.role === 'user' && !skip.test(x.text);
    }).map(function (x) { return { text: x.text, t: x.t }; }));
    if (!query) return pool.slice(-6);
    return pool.filter(function (f) { return f.text.toLowerCase().indexOf(query) >= 0; }).slice(-6);
  }

  // 给模型的上下文片段（system 里追加）
  function context(opts) {
    opts = opts || {};
    if (JV.settings.memoryEnabled === false) return '';
    var turns = opts.turns || 6, factsN = opts.facts || 8;
    var recent = mem.turns.slice(-turns).map(function (t) {
      return (t.role === 'user' ? '先生：' : 'JARVIS：') + t.text;
    });
    var facts = mem.facts.slice(-factsN).map(function (f) { return '· ' + f.text; });
    var parts = [];
    if (facts.length) parts.push('【长期记忆】\n' + facts.join('\n'));
    if (recent.length) parts.push('【最近对话（越靠后越新）】\n' + recent.join('\n'));
    if (!parts.length) return '';
    return parts.join('\n\n') + '\n（以上是你的记忆，回答时保持连贯；不要逐条复述记忆本身。）';
  }

  // 自动压缩：对话超过阈值时，用模型把最近内容压成 3 条事实
  var summarizing = false;
  function maybeSummarize() {
    if (JV.settings.memoryEnabled === false) return;
    if (summarizing) return;
    if (mem.turns.length < 18) return;
    if (mem.turns.length - mem.summarizedTurns < 12) return;
    var ag = JV.agent;
    if (!ag || !ag.send) return;
    summarizing = true;
    var chunk = mem.turns.slice(-20).map(function (t) { return (t.role === 'user' ? '先生：' : 'JARVIS：') + t.text; }).join('\n');
    ag.send('把下面这段对话压缩成最多 3 条「长期记忆」要点（每条 ≤40 字，只输出要点，用｜分隔中文｜English）：\n' + chunk)
      .then(function (r) {
        var txt = (r && (r.text || r.raw)) || '';
        txt.split(/[；;。\n]/).map(function (x) { return x.replace(/^[\s•·\-\d.、]+/, '').trim(); })
          .filter(function (x) { return x && x.length > 4 && x.length < 80; })
          .slice(0, 3).forEach(function (x) { remember(x, 'auto'); });
        mem.summarizedTurns = mem.turns.length;
        save();
      })
      .catch(function () {})
      .then(function () { summarizing = false; });
  }

  function clear() {
    mem.turns = []; mem.facts = []; mem.summarizedTurns = 0; save();
  }

  function exportJSON() { return JSON.stringify(mem, null, 2); }

  /* ------------------------------------------------ 语音/文本里的记忆指令 */
  function handleCommand(text) {
    var t = String(text || '');
    var m = t.match(/^(?:记住|记一下|帮我记住)[:：,，\s]*(.+)$/);
    if (m && m[1]) {
      remember(m[1]);
      return { handled: true, intent: 'chat', reply: '记住了，先生：' + m[1].slice(0, 60), replyEn: 'Noted, sir: ' + m[1].slice(0, 80) };
    }
    if (/(清空|清除|忘掉)(一下)?(所有)?记忆/.test(t)) {
      clear();
      return { handled: true, intent: 'chat', reply: '记忆已清空，先生。', replyEn: 'Memory cleared, sir.' };
    }
    if (/(你还记得|记得什么|我们刚才|刚才说到|聊到哪)/.test(t)) {
      var f = recall('').slice(-4);
      var txt = f.length ? f.map(function (x) { return '· ' + x.text; }).join('；') : '还没有记录，先生。';
      return { handled: true, intent: 'chat', reply: '我记得这些：' + txt.slice(0, 160), replyEn: 'From memory, sir: ' + txt.slice(0, 200) };
    }
    return null;
  }

  load();

  JV.memory = {
    addTurn: addTurn,
    remember: remember,
    forget: forget,
    recall: recall,
    context: context,
    clear: clear,
    handleCommand: handleCommand,
    exportJSON: exportJSON,
    stats: function () { return { turns: mem.turns.length, facts: mem.facts.length, updatedAt: mem.updatedAt }; },
    facts: function () { return mem.facts.slice(-20); }
  };

  // 对话自动入档（boot 只负责业务，不重复记录）
  bus.on('ui:send', function (p) { if (p && p.text) addTurn('user', p.text); });
  bus.on('agent:reply', function (p) {
    if (p && !p.streaming && p.text) addTurn('jarvis', p.text);
  });
})();
