/* ============================================================================
 * JARVIS 2.0 · 07-agent.js
 * 大模型桥 + 本地意图路由（离线兜底：绝不抛错、绝不卡住、绝不白屏）
 *
 * 对外（CONTRACT.md 第 5 节）：
 *   JV.agent = {
 *     configure({enabled, endpoint, model, key, temperature, systemPrompt, timeoutMs}),
 *     send(text, {stream:true}),   // Promise<{text, textEn, intent, args, local, fallback,...}> 永远 resolve
 *     localRoute(text),            // 纯规则：{intent, args, reply, replyEn}
 *     status(),                    // 'offline' | 'proxy' | 'llm'
 *     probe(),                     // Promise<{ok, via, model, provider, hasKey}>，供设置面板"测试连接"
 *     cancel(),                    // 中断当前请求（await 立即返回）
 *     systemPrompt, facts, devices, _internal
 *   }
 *
 * 事件（CONTRACT 2.2）：
 *   agent:reply  {text, textEn, streaming, done, intent, local, fallback, reason}
 *   agent:intent {intent, args, text, source}
 *   agent:status {status, llm, model, provider, enabled, hasKey, endpoint}   // boot 读 p.status
 *   agent:tool   {name, status, detail}   // 仅本地任务型输入时演示性发出
 *
 * 说明（与 Lead 的 08-boot.js 对齐）：
 *   - boot 的流式字幕读 p.text 后自行 splitBilingual，所以流式包的 text 为「中文｜English」整串；
 *     最终 send() 返回的 text 是纯中文、textEn 是英文，boot 用 splitBilingual(r.text) 会得到 zh，
 *     再回落到 r.textEn 作为第二行。
 *   - 本地兜底时不要把结果标成 offline:true，否则 boot 会改用自己那份较简略的文案。
 *
 * 依赖：00-core.js（JV.bus / JV.settings / JV.state / JV.util）。
 * 同时可在 Node 里 require：`module.exports` 暴露纯函数，供 server/selftest.mjs 做 DOM-free 冒烟。
 * ==========================================================================*/
(function () {
  'use strict';

  /* ------------------------------------------------------------ 运行环境 */
  var root = (typeof window !== 'undefined' && window) ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this);
  var JV = root.JV || (root.JV = {});
  var hasWindow = (typeof window !== 'undefined' && !!window);

  // bus 兜底（单独 require 时也能跑）
  var bus = JV.bus;
  if (!bus) {
    bus = JV.bus = {
      on: function () {}, off: function () {}, emit: function () {}
    };
  }

  // settings.llm 兜底并补默认值（不覆盖用户存档）
  var settings = JV.settings || (JV.settings = {});
  if (!settings.llm || typeof settings.llm !== 'object') settings.llm = {};
  var LLM = settings.llm;
  if (typeof LLM.enabled !== 'boolean') LLM.enabled = false;
  if (typeof LLM.endpoint !== 'string') LLM.endpoint = '';
  if (typeof LLM.model !== 'string') LLM.model = '';
  if (typeof LLM.key !== 'string') LLM.key = '';
  if (typeof LLM.temperature !== 'number') LLM.temperature = 0.4;
  if (typeof LLM.timeoutMs !== 'number') LLM.timeoutMs = 12000;

  var state = JV.state || (JV.state = {});
  if (!state.llm) state.llm = 'offline';

  var util = JV.util || {};

  var PROBE_TIMEOUT = 2000;      // 启动探活：2s 超时
  var DEFAULT_TIMEOUT = 12000;   // 对话：12s 超时（settings.llm.timeoutMs 可覆盖，测试用）
  var SAFETY_TIMEOUT = 20000;    // 安全网：无论发生什么，20s 内一定 resolve

  /* ------------------------------------------------------------ 内置事实 */
  // 基准数据：15°C 阴、湿度 64%（已按需求移除「去大唐不夜城」的路程/时间信息）
  var KNOWLEDGE = {
    city: '上海',
    temp: 15,
    cond: '阴',
    condEn: 'overcast',
    humidity: 64,
    high: 20,
    low: 10,
    forecast: [
      { day: 'today', label: '今天', low: 10, high: 20, temp: '10°/20°', cond: '阴' },
      { day: 'tomorrow', label: '明天', low: 9, high: 19, temp: '9°/19°', cond: '多云转阴' },
      { day: 'dayAfter', label: '后天', low: 8, high: 19, temp: '8°/19°', cond: '阴' }
    ],
    travel: { place: '大唐不夜城', placeEn: 'Datang City that Never Sleeps' },
    // 九台可控设备：电视 3（2 台离线）+ 净化器 2 + 晾衣架 + 风扇 + 音箱 + 台灯
    devices: [
      { id: 'tv', name: '电视', nameEn: 'television', count: 3, offline: 2 },
      { id: 'purifier', name: '空气净化器', nameEn: 'air purifier', count: 2, offline: 0 },
      { id: 'rack', name: '晾衣架', nameEn: 'drying rack', count: 1, offline: 0 },
      { id: 'fan', name: '风扇', nameEn: 'fan', count: 1, offline: 0 },
      { id: 'speaker', name: '音箱', nameEn: 'speaker', count: 1, offline: 0 },
      { id: 'lamp', name: '台灯', nameEn: 'desk lamp', count: 1, offline: 0 }
    ],
    deviceCount: 9,
    agenda: {
      today: [
        { time: '21:30', label: '今日任务复盘' },
        { time: '22:30', label: '阅读与学习' }
      ],
      tomorrow: [
        { time: '10:00', label: '产品评审' },
        { time: '15:00', label: '动效走查' },
        { time: '20:00', label: '自由时间' }
      ]
    },
    summary: { builds: 3, verifies: 2, failed: 0, done: 0, total: 0 }
  };

  var INTENTS = ['weather', 'city', 'globe', 'device', 'time', 'schedule', 'summary', 'warp', 'off', 'orb', 'chat'];

  /* --------------------------------------------------------- systemPrompt */
  // 常量导出：JV.agent.systemPrompt（也挂在 agent.SYSTEM_PROMPT）
  var SYSTEM_PROMPT = [
    '你是 JARVIS 2.0，一位英式管家口吻的全息 AI 助理，正在为「先生」操作全息 HUD。',
    '回答规则：',
    '1. 永远称呼用户为「先生」；语气克制、礼貌，可在英文里带一点英式幽默；中文不超过 2 句。',
    '2. 必须双语：先输出中文，再输出英文，中间用全角竖线「｜」分隔，格式严格为：中文｜English。英文要口语、自然，不要逐字翻译。',
    '3. 需要触发界面动效时，在回答末尾追加一个意图标记，只能出现一次，且不要解释它：⟨intent:city|device|warp|off|orb⟩ 之一。',
    '   city=展示城市立体视图；globe=展示全球城市全息（地球/任意城市的真实街道全息）；device=设备控制；warp=光速穿梭；off=关机待机；orb=回到主界面。',
    '   当先生想看某个真实城市或地球时，用 globe。',
    '4. 内置事实：现在 15°C 阴、湿度 64%；「大唐不夜城」只有立体城市视图，不要提供路程、距离、耗时、到达时间；',
    '   可控设备共九台：三台电视（其中两台离线）、两台空气净化器、晾衣架、风扇、音箱、台灯。不要编造与这些冲突的数字。',
    '5. 不提供医疗、法律、金融建议；不确定时坦率说明并给出下一步。不要输出 Markdown、不要编号列表、不要表情符号。',
    '6. 本机权限已接入，你可以真的操作这台 Mac。需要操作时在回答末尾追加工具调用标记（只调用一个）：',
    '   ⟨tool:system.info {}⟩ 系统信息；⟨tool:system.volume {"action":"set","level":40}⟩ 音量；',
    '   ⟨tool:app.open {"name":"Safari"}⟩ 打开应用；⟨tool:app.quit {"name":"Notes"}⟩ 退出应用；⟨tool:app.list {}⟩ 运行中的应用；',
    '   ⟨tool:media.control {"action":"play"}⟩ 播放/暂停；⟨tool:clipboard.get {}⟩ 读剪贴板；⟨tool:clipboard.set {"text":"…"}⟩ 写剪贴板；',
    '   ⟨tool:screenshot {}⟩ 截图；⟨tool:file.list {"path":"~/Desktop"}⟩ 列目录；⟨tool:file.read {"path":"…"}⟩ 读文件；',
    '   ⟨tool:file.write {"path":"…","content":"…"}⟩ 写文件；⟨tool:notify {"title":"…","message":"…"}⟩ 通知；',
    '   ⟨tool:system.lock {}⟩ 锁屏；⟨tool:shell.run {"cmd":"…"}⟩ 执行命令；⟨tool:web.fetch {"url":"https://…"}⟩ 抓网页；⟨tool:open.url {"url":"https://…"}⟩ 打开网址。',
    '   调用工具的回合不要编造结果；工具返回后你会收到结果，再用双语汇报。',
    '   触发规则：先生问到「电脑/电池/内存/磁盘/系统/时间」「打开或退出某个 App」「音量/静音/播放」「剪贴板/复制」「截图」「文件/目录/读写」「通知」「锁屏/睡眠」「执行命令/终端」「联网/查网页/打开网址」时，必须真的调用对应工具，不要只口头答应。',
    '   回答顺序：先用一句双语说明你要做什么，再附 ⟨tool:…⟩ 标记。'
  ].join('\n');

  /* ================================================================ 工具 */
  function now() { return Date.now(); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function hasChinese(s) { return /[\u4e00-\u9fa5]/.test(String(s || '')); }

  // 双行拆分：优先用 core 的实现，Node 单测时用内置等价实现
  function splitBilingual(text) {
    if (util && typeof util.splitBilingual === 'function') {
      try {
        var r = util.splitBilingual(text);
        if (r && (r.zh !== undefined || r.en !== undefined)) return { zh: r.zh || '', en: r.en || '' };
      } catch (e) { /* 忽略，走内置实现 */ }
    }
    return splitBilingualFallback(text);
  }

  function splitBilingualFallback(text) {
    var t = String(text == null ? '' : text).trim();
    if (!t) return { zh: '', en: '' };
    var parts = t.split(/\s*[｜|]\s*/);
    if (parts.length >= 2) return { zh: parts[0].trim(), en: parts.slice(1).join(' ').trim() };
    var lines = t.split(/\n+/).filter(function (x) { return !!x.trim(); });
    if (lines.length >= 2) {
      var zh = [], en = [];
      lines.forEach(function (l) { if (hasChinese(l)) zh.push(l); else en.push(l); });
      if (zh.length && en.length) return { zh: zh.join(' '), en: en.join(' ') };
    }
    return hasChinese(t) ? { zh: t, en: '' } : { zh: '', en: t };
  }

  /* -------------------------------------------------- SSE 解析（纯函数） */
  // 输入缓冲区，返回完整行的 data 负载 + 未完成的残余行。
  // 支持 `data: xxx` / `data:xxx` / 注释行 `:` / 空行分隔；非 JSON 负载原样返回，由上层决定忽略。
  function consumeSSE(buffer) {
    var payloads = [];
    var raw = String(buffer == null ? '' : buffer);
    var lines = raw.split(/\r?\n/);
    var rest = lines.pop(); // 末行可能被切成两半，留到下一块
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      if (line.charAt(0) === ':') continue;       // SSE 注释 / 心跳
      var m = /^data:\s?(.*)$/.exec(line);
      if (m) payloads.push(m[1]);
    }
    return { payloads: payloads, rest: rest };
  }

  function safeJSON(s) {
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  function errorMessageOf(obj) {
    if (!obj || typeof obj !== 'object') return '';
    if (obj.ok === false) return String(obj.error || obj.message || '代理回落本地');
    if (obj.error) {
      if (typeof obj.error === 'string') return obj.error;
      return String(obj.error.message || obj.error.type || '上游模型返回错误');
    }
    if (obj.type === 'error' && obj.message) return String(obj.message);
    return '';
  }

  function deltaTextOf(obj) {
    if (!obj || typeof obj !== 'object') return '';
    if (obj.choices && obj.choices.length) {
      var c = obj.choices[0] || {};
      if (c.delta && typeof c.delta.content === 'string') return c.delta.content;
      if (c.message && typeof c.message.content === 'string') return c.message.content;
      if (typeof c.text === 'string') return c.text;
    }
    if (obj.delta && typeof obj.delta.text === 'string') return obj.delta.text;  // Anthropic
    if (obj.type === 'content_block_delta' && obj.delta && typeof obj.delta.text === 'string') return obj.delta.text;
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.text === 'string') return obj.text;
    return '';
  }

  /* -------------------------------------------------- 意图标记解析（纯函数） */
  var INTENT_RE = /[⟨<〔\[【［﹝〘]\s*intent\s*[:：]?\s*([a-z]+(?:\s*\|\s*[a-z]+)*)\s*[⟩>〕\]】］﹞〙]/gi;

  function extractIntent(text) {
    var t = String(text || '');
    INTENT_RE.lastIndex = 0;
    var m = INTENT_RE.exec(t);
    if (!m) return null;
    var first = String(m[1] || '').split('|')[0].trim().toLowerCase();
    return INTENTS.indexOf(first) >= 0 ? first : null;
  }

  function stripIntentMarkers(text) {
    return String(text == null ? '' : text)
      .replace(INTENT_RE, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\s+([。，！？；：])/g, '$1')
      .trim();
  }

  /* -------------------------------------------------- endpoint 归一化（纯函数） */
  // 允许：''（同源 /api/chat）/ '/api/chat' / 'http://host:8799' / 'http://host:8799/api/chat'
  //       / 完整 OpenAI 兼容 'https://api.deepseek.com/v1/chat/completions'
  function resolveChatUrl(endpoint) {
    var e = String(endpoint == null ? '' : endpoint).trim();
    if (!e) return '/api/chat';
    if (e.charAt(0) === '/') return e.replace(/\/+$/, '') || '/api/chat';
    e = e.replace(/\/+$/, '');
    if (/\/api\/chat$/i.test(e)) return e;
    if (/\/chat\/completions$/i.test(e)) return e;
    if (/\/messages$/i.test(e)) return e;
    if (/\/api$/i.test(e)) return e + '/chat';
    if (/\/v1$/i.test(e)) return e + '/chat/completions';
    return e + '/api/chat';
  }

  function resolveHealthUrl(endpoint) {
    var c = resolveChatUrl(endpoint);
    if (c.charAt(0) === '/') {
      return c.replace(/\/chat(\/completions)?$/i, '/health').replace(/\/messages$/i, '/health');
    }
    try {
      var u = new URL(c);
      return u.origin + '/api/health';
    } catch (e) {
      return '/api/health';
    }
  }

  // 只有"像本地代理"的地址才探活；完整厂商 URL 直连时不探 /api/health
  function looksLikeProxy(endpoint) {
    var e = String(endpoint == null ? '' : endpoint).trim();
    if (!e) return true;
    if (e.charAt(0) === '/') return true;
    try {
      var u = new URL(e);
      return /\/api(\/|$)/i.test(u.pathname) || u.pathname === '/' || u.pathname === '';
    } catch (err) {
      return false;
    }
  }

  function requestTimeout() {
    var t = Number(LLM.timeoutMs);
    if (!isFinite(t) || t <= 0) t = DEFAULT_TIMEOUT;
    return Math.max(200, Math.min(30000, t));
  }

  function makeAbort() {
    try { return (typeof AbortController === 'function') ? new AbortController() : null; } catch (e) { return null; }
  }

  function normalizeText(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s) return '';
    s = s.replace(/^(hey[\s,，]*jarvis|hi[\s,，]*jarvis|jarvis|贾维斯|嗨[\s,，]*贾维斯|你好[\s,，]*贾维斯)[\s,，。.!！?？:：]*/i, '');
    return s.replace(/\s+/g, ' ').trim();
  }

  /* ============================================================ 本地意图路由 */
  var RE = {
    off: /(晚安|好梦|good\s*night|关机|关闭系统|关掉系统|shut\s*down|shutdown|power\s*off|待机|去睡|睡觉)/i,
    warp: /(穿梭|光速|跃迁|warp|超空间|穿越|带我飞|进入未来)/i,
    orb: /(回主界面|回主页|主界面|返回主界面|退出城市|退出场景|退出沙盘|切换回来|回到球|回去|返回|back\s*to\s*main|main\s*interface)/i,
    city: /(大唐不夜城|不夜城|导航|堵车|堵不堵|路线|开车去|自驾|去.{0,8}(城|街|广场|景区)|距离.{0,6}(公里|km)|datang|navigation|traffic)/i,
    weather: /(天气|气温|温度|下雨|下雪|雨伞|带伞|晴天|阴天|多云|湿度|多少度|几度|冷不冷|热不热|降温|weather|forecast|temperature|rain|humidity|°c|℃)/i,
    schedule: /(安排|日程|议程|会议|待办|计划|行程|schedule|agenda|calendar|meeting)/i,
    time: /(几点|什么时间|现在时间|当前时间|时刻|报时|what\s*time|the\s*time|clock)/i,
    device: /(设备|电视|净化器|空气净化|晾衣架|烘干架|烘干衣|风扇|电扇|音箱|音响|台灯|灯|打开|开启|关掉|关闭|关上|turn\s*(?:on|off)|switch|device)/i,
    summary: /(总结|汇总|进展|日报|周报|复盘|完成了什么|工作汇报|summary|report|progress|recap)/i,
    task: /(claude\s*code|codex|修复|修一下|修个|修好|bug|bag|部署|安装|构建|代码|build|deploy|fix)/i,
    identity: /(你是谁|你叫什么|介绍一下你自己|who\s+are\s+you|your\s+name)/i,
    thanks: /(谢谢|多谢|感谢|thank)/i,
    ability: /(能做什么|会什么|能帮我做什么|可以做什么|有什么功能|what\s+can\s+you\s+do|capabilities)/i,
    greeting: /(你好|您好|嗨|hello|hi\b|hey\b|早上好|晚上好|morning|evening)/i
  };

  var DEVICE_DEFS = [
    { id: 'rack', zh: '晾衣架', en: 'drying rack', re: /(晾衣架|烘干架|烘干衣架|晾衣|drying\s*rack)/i },
    { id: 'tv', zh: '电视', en: 'television', re: /(电视|电视|tv\b|television)/i },
    { id: 'purifier', zh: '空气净化器', en: 'air purifier', re: /(空气净化器|净化器|空净|purifier)/i },
    { id: 'fan', zh: '风扇', en: 'fan', re: /(风扇|电扇|吹风|\bfan\b)/i },
    { id: 'speaker', zh: '音箱', en: 'speaker', re: /(音箱|音响|speaker)/i },
    { id: 'lamp', zh: '台灯', en: 'desk lamp', re: /(台灯|\blamp\b|灯光|亮灯)/i }
  ];

  function phrase(re) { return re; }

  function findDevice(t) {
    for (var i = 0; i < DEVICE_DEFS.length; i++) {
      if (DEVICE_DEFS[i].re.test(t)) return DEVICE_DEFS[i];
    }
    return null;
  }

  // 只有明确的祈使动作才算开/关；"电视开着吗"这类询问走状态
  function detectAction(t) {
    var isOff = /(关掉|关闭|关上|关一下|关了|熄灭|停止|turn\s*off|switch\s*off|power\s*off)/i.test(t);
    var isOn = /(打开|开启|开一下|开了|亮起|点亮|启动|turn\s*on|switch\s*on)/i.test(t);
    if (isOff && !isOn) return 'off';
    if (isOn && !isOff) return 'on';
    if (isOff && isOn) return 'off';
    return null;
  }

  function routeWeather(t) {
    var when = 'today';
    if (/(明天|明儿|tomorrow)/i.test(t)) when = 'tomorrow';
    else if (/(后天|未来|接下来|这周|本周|三天|day\s*after)/i.test(t)) when = 'future';
    var wantsHumidity = /(湿度|潮湿|humidity)/i.test(t);
    var wantsRain = /(下雨|雨伞|带伞|rain|umbrella)/i.test(t);
    var args = {
      when: when,
      temp: KNOWLEDGE.temp,
      high: KNOWLEDGE.high,
      low: KNOWLEDGE.low,
      cond: KNOWLEDGE.cond,
      humidity: KNOWLEDGE.humidity,
      forecast: KNOWLEDGE.forecast
    };
    if (when === 'tomorrow') {
      return {
        intent: 'weather',
        args: args,
        reply: '先生，明天 9°C 到 19°C，多云转阴，早晚记得添件外套。',
        replyEn: 'Tomorrow runs nine to nineteen degrees, sir — overcast, so a jacket at night is wise.'
      };
    }
    if (when === 'future') {
      return {
        intent: 'weather',
        args: args,
        reply: '先生，未来三天 8°C 到 20°C，以阴天为主，湿度稳定在 64%。',
        replyEn: 'The next three days stay between eight and twenty degrees, sir, mostly overcast.'
      };
    }
    if (wantsHumidity) {
      return {
        intent: 'weather',
        args: args,
        reply: '先生，现在湿度 64%，气温 15°C，阴天。',
        replyEn: 'Humidity is sixty-four percent, sir, at fifteen degrees and overcast.'
      };
    }
    if (wantsRain) {
      return {
        intent: 'weather',
        args: args,
        reply: '先生，今天 15°C、阴天，暂时没有雨，带把伞更稳妥。',
        replyEn: 'Fifteen degrees and overcast, sir, with no rain yet — a compact umbrella would be prudent.'
      };
    }
    return {
      intent: 'weather',
      args: args,
      reply: '先生，今天 15°C 阴，湿度 64%，适合把行程留在室内。',
      replyEn: 'Fifteen degrees and overcast today, sir, with humidity at sixty-four percent.'
    };
  }

  function routeCity(t) {
    return {
      intent: 'city',
      args: { place: KNOWLEDGE.travel.place, placeEn: KNOWLEDGE.travel.placeEn, view: 'city' },
      reply: '先生，这是大唐不夜城的立体城市视图。',
      replyEn: 'The three-dimensional city view of Datang City that Never Sleeps, sir.'
    };
  }

  function routeSchedule(t) {
    if (/(明天|明儿|tomorrow)/i.test(t)) {
      return {
        intent: 'schedule',
        args: { when: 'tomorrow', items: KNOWLEDGE.agenda.tomorrow },
        reply: '先生，明天上午十点产品评审，下午三点过一遍动效，晚上留给您自己。',
        replyEn: 'Tomorrow, sir: the product review at ten, a motion pass at three, and the evening is yours.'
      };
    }
    return {
      intent: 'schedule',
      args: { when: 'today', items: KNOWLEDGE.agenda.today },
      reply: '先生，今天还剩两件事：21:30 复盘今天的任务，22:30 留给自己。',
      replyEn: 'Two things remain today, sir: a review of the day at 21:30, and the evening is yours from 22:30.'
    };
  }

  function routeTime() {
    var d = new Date();
    var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return {
      intent: 'time',
      args: { time: hm, date: d.getDay() },
      reply: '先生，现在是 ' + hm + '。',
      replyEn: 'It is ' + hm + ', sir.'
    };
  }

  function deviceListRoute() {
    return {
      intent: 'device',
      args: { action: 'list', count: KNOWLEDGE.deviceCount, devices: KNOWLEDGE.devices },
      reply: '先生，我能控制的设备共有九台：两台目前离线的电视（电视共三台）、两台空气净化器，以及晾衣架、风扇、音箱和台灯。',
      replyEn: 'You have nine devices I can control, sir: two TVs that are currently offline, three televisions in total, two air purifiers, the drying rack, the fan, the speaker and the desk lamp.'
    };
  }

  function tvCountRoute() {
    return {
      intent: 'device',
      args: { device: 'tv', action: 'count', count: 3, offline: 2 },
      reply: '先生，电视共三台，其中两台离线。',
      replyEn: 'Three televisions in total, sir, two of them offline.'
    };
  }

  function deviceActionRoute(def, action) {
    var zh, en;
    if (def.id === 'rack' && action === 'off') {
      // 视频原句，逐字保留
      zh = '先生，晾衣架的灯已经关掉了。';
      en = "The drying rack's light is off now, sir.";
    } else if (def.id === 'rack' && action === 'on') {
      zh = '先生，晾衣架的灯已经打开了。';
      en = "The drying rack's light is on now, sir.";
    } else if (def.id === 'tv' && action === 'on') {
      zh = '先生，电视已经打开了；两台离线电视暂时无法唤醒。';
      en = 'The television is on now, sir; two of them remain offline.';
    } else if (action === 'on') {
      zh = '先生，' + def.zh + '已经打开了。';
      en = 'The ' + def.en + ' is on now, sir.';
    } else {
      zh = '先生，' + def.zh + '已经关掉了。';
      en = 'The ' + def.en + ' is off now, sir.';
    }
    return {
      intent: 'device',
      args: { device: def.id, deviceName: def.zh, action: action },
      reply: zh,
      replyEn: en
    };
  }

  function deviceStatusRoute(def) {
    var map = {
      rack: { zh: '先生，晾衣架现在关闭，灯是灭的。', en: 'The drying rack is off, sir; its light is dim.' },
      tv: { zh: '先生，三台电视里两台离线，第三台正常播放。', en: 'Two of your three televisions are offline, sir; the third is running.' },
      purifier: { zh: '先生，两台空气净化器都在运行，空气质量良好。', en: 'Both air purifiers are running, sir, and the air is clean.' },
      fan: { zh: '先生，风扇目前关闭。', en: 'The fan is off, sir.' },
      speaker: { zh: '先生，音箱在线，等待您的指令。', en: 'The speaker is online, sir, awaiting your command.' },
      lamp: { zh: '先生，台灯是关着的。', en: 'The desk lamp is off, sir.' }
    };
    var r = map[def.id] || { zh: '先生，' + def.zh + '在线。', en: 'The ' + def.en + ' is online, sir.' };
    return { intent: 'device', args: { device: def.id, deviceName: def.zh, action: 'status' }, reply: r.zh, replyEn: r.en };
  }

  function routeDevice(t) {
    var dev = findDevice(t);
    var hasSwitch = /(打开|开启|关掉|关闭|关上|开一下|调亮|调暗|亮度|亮一点|暗一点)/.test(t);
    var isList = /(设备|devices?)/i.test(t) && !dev && !hasSwitch;
    if (isList) return deviceListRoute();
    if (dev && dev.id === 'tv' && /(几台|多少台|共几|总数|count)/i.test(t)) return tvCountRoute();
    if (dev && dev.id === 'lamp' && /(调亮|调暗|亮度|亮一点|暗一点)/.test(t)) {
      return {
        intent: 'device',
        args: { device: 'lamp', action: 'brightness', level: 0.6 },
        reply: '先生，台灯亮度已调到 60%。',
        replyEn: 'The desk lamp is dimmed to sixty percent, sir.'
      };
    }
    if (!dev && hasSwitch) {
      return {
        intent: 'device',
        args: { device: null, action: 'unknown' },
        reply: '先生，您要操作哪一台？电视、净化器，还是晾衣架？',
        replyEn: 'Which one shall I operate, sir — the TV, the purifier, or the drying rack?'
      };
    }
    if (!dev) return deviceListRoute();
    var action = detectAction(t);
    if (!action) return deviceStatusRoute(dev);
    return deviceActionRoute(dev, action);
  }

  function routeSummary() {
    return {
      intent: 'summary',
      args: {
        builds: KNOWLEDGE.summary.builds,
        verifies: KNOWLEDGE.summary.verifies,
        failed: KNOWLEDGE.summary.failed,
        done: KNOWLEDGE.summary.done,
        total: KNOWLEDGE.summary.total
      },
      reply: '先生，今天完成 3 项构建、2 次校验，0 项失败；任务面板仍是 0/0，我建议现在把验收跑完。',
      replyEn: 'Three builds and two verifications today, sir, with no failures; the board still reads 0/0, so I suggest we run the acceptance pass.'
    };
  }

  function routeOff(t) {
    if (/(好梦|晚安|good\s*night)/i.test(t)) {
      return {
        intent: 'off',
        args: { reason: 'night' },
        reply: '好梦，先生。待机中，需要时叫我。',
        replyEn: 'Good night, sir. Standing by.'
      };
    }
    return {
      intent: 'off',
      args: { reason: 'poweroff' },
      reply: '先生，已关机待机，随时唤醒我。',
      replyEn: 'Shutting down, sir. Wake me whenever you need.'
    };
  }

  function routeChat(t) {
    if (RE.task.test(t)) {
      return {
        intent: 'chat',
        args: {
          task: 'bugfix',
          tools: [{ name: 'build', detail: 'Claude Code · 修复安装 bag', label: '修复安装 bag' }]
        },
        reply: '先生，我已把修 bug 的活交给 Claude Code，完成后向您汇报。',
        replyEn: 'I have handed the bug fix to Claude Code, sir, and will report once it is done.'
      };
    }
    if (RE.identity.test(t)) {
      return {
        intent: 'chat',
        args: {},
        reply: '先生，我是 JARVIS 2.0，您的全息管家。',
        replyEn: 'I am JARVIS 2.0, sir — your holographic butler.'
      };
    }
    if (RE.thanks.test(t)) {
      return {
        intent: 'chat',
        args: {},
        reply: '先生，不必客气，这是我分内的事。',
        replyEn: 'A pleasure, sir. It is what I am here for.'
      };
    }
    if (RE.ability.test(t)) {
      return {
        intent: 'chat',
        args: {},
        reply: '先生，我能看天气、排日程、控设备、导航城市，也能总结您一天的工作。',
        replyEn: 'Weather, agenda, devices, city navigation, sir — and a summary of your day.'
      };
    }
    if (RE.greeting.test(t)) {
      return {
        intent: 'chat',
        args: {},
        reply: '先生，我在。随时听候吩咐。',
        replyEn: 'I am here, sir. At your service.'
      };
    }
    return {
      intent: 'chat',
      args: {},
      reply: '先生，我在听。要天气、日程，还是去大唐不夜城？',
      replyEn: 'I am listening, sir. Weather, agenda, or a drive to Datang City?'
    };
  }

  function routeByRules(t) {
    if (!t) return routeChat('');
    if (RE.off.test(t)) return routeOff(t);
    if (RE.warp.test(t)) {
      return {
        intent: 'warp',
        args: { duration: 2.5 },
        reply: '先生，坐稳，光速穿梭开始。',
        replyEn: 'Hold tight, sir — engaging lightspeed.'
      };
    }
    if (RE.orb.test(t)) {
      return {
        intent: 'orb',
        args: {},
        reply: '先生，已回到主界面。',
        replyEn: 'Back to the main interface, sir.'
      };
    }
    if (RE.city.test(t)) return routeCity(t);
    if (RE.weather.test(t)) return routeWeather(t);
    if (RE.summary.test(t)) return routeSummary();   // 「总结今天的工作」优先于日程
    if (RE.schedule.test(t)) return routeSchedule(t);
    if (RE.time.test(t)) return routeTime();
    if (RE.device.test(t)) return routeDevice(t);
    if (RE.task.test(t)) return routeChat(t);
    return routeChat(t);
  }

  function localRoute(text) {
    var input = normalizeText(text);
    var route;
    try {
      route = routeByRules(input);
    } catch (e) {
      route = routeChat('');
    }
    if (!route || !route.intent) route = routeChat('');
    route.args = route.args || {};
    route.reply = String(route.reply || '');
    route.replyEn = String(route.replyEn || '');
    route.replyFull = route.reply ? (route.reply + '｜' + route.replyEn) : route.replyEn;
    route.text = input;
    return route;
  }

  /* ============================================================ 事件发送 */
  function emitReply(text, textEn, streaming, extra) {
    var payload = {
      text: text,
      textEn: textEn || '',
      streaming: !!streaming,
      done: !streaming
    };
    if (extra) {
      for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k]; }
    }
    bus.emit('agent:reply', payload);
  }

  // 流式包：text 用「中文｜English」整串，兼容 boot 的 splitBilingual(p.text)
  function emitStreaming(acc) {
    var shown = stripIntentMarkers(acc);
    if (!shown) return;
    var bi = splitBilingual(shown);
    var zhPart = bi.zh || (hasChinese(shown) ? shown : '');
    var enPart = bi.en || (!hasChinese(shown) ? shown : '');
    emitReply(zhPart && enPart ? (zhPart + '｜' + enPart) : (zhPart || enPart), enPart, true, {});
  }

  function emitIntent(intent, args, text, source) {
    bus.emit('agent:intent', { intent: intent || 'chat', args: args || {}, text: text || '', source: source || '' });
  }

  function emitTools(args) {
    if (!args || !args.tools || !args.tools.length) return;
    args.tools.forEach(function (tool) {
      var name = tool.name || 'build';
      var detail = tool.detail || tool.label || '';
      bus.emit('agent:tool', { name: name, status: 'start', detail: detail });
      setTimeout(function () {
        bus.emit('agent:tool', { name: name, status: 'ok', detail: detail });
      }, 700);
    });
  }

  /* ============================================================ 连接状态 */
  function statusPayload(level, extra) {
    var p = {
      status: level,
      llm: level,
      enabled: !!LLM.enabled,
      endpoint: String(LLM.endpoint || ''),
      model: LLM.model || '',
      hasKey: !!LLM.key,
      at: now()
    };
    if (extra) {
      for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) p[k] = extra[k]; }
    }
    return p;
  }

  function setLLMState(level, extra) {
    var normalized = (level === 'llm' || level === 'proxy') ? level : 'offline';
    state.llm = normalized;
    if (JV.state && JV.state !== state) JV.state.llm = normalized;
    bus.emit('agent:status', statusPayload(normalized, extra));
    return normalized;
  }

  /* ------------------------------------------------------------- 探活 */
  var probeSeq = 0;

  function probe() {
    var seq = ++probeSeq;

    function fail(reason) {
      if (seq === probeSeq) setLLMState('offline', { reason: reason || 'offline' });
      return { ok: false, via: 'offline', model: '', provider: 'none', hasKey: false };
    }

    if (!LLM.enabled) return Promise.resolve(fail('disabled'));
    var endpoint = String(LLM.endpoint || '').trim();

    // 完整厂商 URL 直连：没有标准 /api/health，视为已配置可用
    if (endpoint && !looksLikeProxy(endpoint)) {
      if (seq === probeSeq) setLLMState('llm', { provider: 'direct' });
      return Promise.resolve({ ok: true, via: 'llm', model: LLM.model || '', provider: 'direct', hasKey: !!LLM.key });
    }

    var url = resolveHealthUrl(endpoint);
    if (typeof fetch !== 'function' || !url) return Promise.resolve(fail('no-fetch'));

    var ac = makeAbort();
    var timer = setTimeout(function () {
      try { if (ac) ac.abort(); } catch (e) { /* ignore */ }
    }, PROBE_TIMEOUT);

    return fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: ac ? ac.signal : undefined
    }).then(function (res) {
      if (!res || !res.ok) return null;
      return res.json().catch(function () { return null; });
    }).then(function (json) {
      if (seq !== probeSeq) return { ok: false, via: 'offline', model: '', provider: 'none', hasKey: false };
      if (json && json.ok) {
        var hasKey = json.hasKey !== false;
        var level = hasKey ? 'llm' : 'proxy';
        setLLMState(level, { provider: json.provider || 'proxy', model: json.model || LLM.model || '' });
        return {
          ok: true,
          via: hasKey ? 'llm' : 'proxy',
          model: json.model || LLM.model || '',
          provider: json.provider || 'proxy',
          hasKey: hasKey
        };
      }
      return fail('health-not-ok');
    }).catch(function () {
      return fail('network');
    }).then(function (r) {
      clearTimeout(timer);
      return r;
    });
  }

  /* ============================================================ 主请求 */
  var active = null;   // 当前 in-flight 请求（cancel 用）

  function finishCancelled(ctx) {
    ctx.finish({ text: '', textEn: '', intent: null, args: {}, local: false, fallback: false, cancelled: true });
  }

  function localAnswer(input, opts, ctx) {
    var route = localRoute(input);
    emitReply(route.reply, route.replyEn, true, {});   // 先给 HUD 一个流式包
    emitTools(route.args);
    emitIntent(route.intent, route.args, input, 'local');
    emitReply(route.reply, route.replyEn, false, {
      intent: route.intent, local: true, fallback: false
    });
    ctx.finish({
      text: route.reply,
      textEn: route.replyEn,
      reply: route.reply,
      replyEn: route.replyEn,
      raw: route.replyFull,
      intent: route.intent,
      args: route.args,
      local: true,
      fallback: false,
      offline: false
    });
  }

  function fallbackAnswer(input, opts, ctx, reason) {
    if (ctx.cancelled) { finishCancelled(ctx); return; }
    setLLMState('offline', { reason: String(reason || 'fallback'), fallback: true });
    var route = localRoute(input);
    emitReply(route.reply, route.replyEn, true, {});          // 覆盖掉可能残留的半截流式字幕
    emitTools(route.args);
    emitIntent(route.intent, route.args, input, 'local-fallback');
    emitReply(route.reply, route.replyEn, false, {
      intent: route.intent, local: true, fallback: true, reason: String(reason || '')
    });
    ctx.finish({
      text: route.reply,
      textEn: route.replyEn,
      reply: route.reply,
      replyEn: route.replyEn,
      raw: route.replyFull,
      intent: route.intent,
      args: route.args,
      local: true,
      fallback: true,
      offline: false,          // 不置 true：本地文案已经更完整，boot 直接用本结果即可
      reason: String(reason || '')
    });
  }

  // 读取 SSE（兼容 OpenAI / Anthropic / 代理直出 JSON），返回累计文本或错误
  async function readSSEBody(res, ctx, onDelta) {
    var text = '';
    var errorText = '';
    var gotDone = false;

    function feedPayload(payload) {
      if (gotDone) return;
      if (payload === '[DONE]') { gotDone = true; return; }
      var obj = safeJSON(payload);
      if (obj == null) return; // 非 JSON（心跳 / 厂商注释）直接忽略
      var em = errorMessageOf(obj);
      if (em) { errorText = em; gotDone = true; return; }
      var delta = deltaTextOf(obj);
      if (delta) { text += delta; if (onDelta) onDelta(delta); }
    }

    function feedBufferSafely(buffer, flush) {
      var chunk = flush ? (buffer + '\n') : buffer;
      var parsed = consumeSSE(chunk);
      for (var i = 0; i < parsed.payloads.length; i++) feedPayload(parsed.payloads[i]);
      return parsed.rest;
    }

    if (!res.body || typeof res.body.getReader !== 'function') {
      var raw = await res.text();
      var lines = String(raw || '').split(/\r?\n/);
      for (var i = 0; i < lines.length; i++) {
        var m = /^data:\s?(.*)$/.exec(lines[i]);
        if (m) feedPayload(m[1]);
      }
      return { text: text, error: errorText };
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buffer = '';

    while (!gotDone) {
      var step;
      try {
        step = await reader.read();
      } catch (e) {
        if (ctx.cancelled || ctx.timedOut) throw e;
        throw new Error('stream-aborted');
      }
      if (step.done) break;
      buffer += decoder.decode(step.value, { stream: true });
      buffer = feedBufferSafely(buffer, false);
    }
    if (!gotDone && buffer) feedBufferSafely(buffer, true);

    // 尽量释放连接
    try { reader.releaseLock && reader.releaseLock(); } catch (e) { /* ignore */ }
    return { text: text, error: errorText };
  }

  async function streamAnswer(input, opts, ctx) {
    var url = resolveChatUrl(LLM.endpoint);
    var headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
    if (LLM.key) headers.authorization = 'Bearer ' + String(LLM.key);

    var temperature = (typeof opts.temperature === 'number')
      ? opts.temperature
      : (typeof LLM.temperature === 'number' ? LLM.temperature : 0.4);

    var sys = String(opts.systemPrompt || customSystemPrompt || SYSTEM_PROMPT);
    try {
      // 上下文记忆 + 已启用插件（运行时注入，不污染常量）
      if (window.JV && JV.memory && JV.memory.context) {
        var memCtx = JV.memory.context({ turns: 6, facts: 8 });
        if (memCtx) sys += '\n\n' + memCtx;
      }
      if (window.JV && JV.plugins && JV.plugins.promptFragment) {
        var plug = JV.plugins.promptFragment();
        if (plug) sys += '\n\n' + plug;
      }
    } catch (e) { /* 记忆/插件不可用时不影响对话 */ }

    var body = {
      model: String(opts.model || LLM.model || ''),
      stream: true,
      temperature: temperature,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: input }
      ]
    };

    var timeoutTimer = setTimeout(function () {
      ctx.timedOut = true;
      try { if (ctx.ac) ctx.ac.abort(); } catch (e) { /* ignore */ }
    }, requestTimeout());
    ctx.timers.push(timeoutTimer);

    var res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: ctx.ac ? ctx.ac.signal : undefined
      });
    } catch (err) {
      throw new Error(ctx.timedOut ? 'timeout' : ('network: ' + String(err && err.message || err)));
    }
    if (!res) throw new Error('no-response');
    if (!res.ok) throw new Error('http-' + res.status);
    if (ctx.settled()) return;

    var ctype = '';
    try { ctype = res.headers && res.headers.get ? (res.headers.get('content-type') || '') : ''; } catch (e) { ctype = ''; }

    var acc = '';

    if (/application\/json/i.test(ctype)) {
      // 代理在无 key / 出错时会返回 JSON {ok:false,fallback:true}
      var json = null;
      try { json = await res.json(); } catch (e) { throw new Error('bad-json'); }
      var em = errorMessageOf(json);
      if (em) throw new Error(em);
      acc = deltaTextOf(json);
      if (acc) emitStreaming(acc);
    } else {
      var streamed = await readSSEBody(res, ctx, function (delta) {
        acc += delta;
        emitStreaming(acc);
      });
      if (streamed.error) throw new Error(streamed.error);
      acc = streamed.text;
    }

    if (ctx.settled()) return;
    if (ctx.timedOut) throw new Error('timeout');

    var shown = stripIntentMarkers(acc).trim();
    if (!shown) throw new Error('empty-reply');

    var markerIntent = extractIntent(acc);
    var bi = splitBilingual(shown);
    var zh = bi.zh || (hasChinese(shown) ? shown : '');
    var en = bi.en || (hasChinese(shown) ? '' : shown);
    if (!zh) { zh = shown; en = ''; }   // 极端情况下也保证有内容，且不重复占两行

    // 模型没给意图标记时，用本地规则猜一个，保证场景切换不丢
    var guess = localRoute(input);
    var intent = markerIntent || (guess && guess.intent) || 'chat';
    var args = (guess && guess.args) || {};
    if (markerIntent) args = {};  // 标记优先，args 清空避免误导

    emitTools(args);
    emitIntent(intent, args, input, markerIntent ? 'llm-marker' : 'llm-guess');
    setLLMState('llm', { provider: 'llm', model: LLM.model || '' });
    emitReply(zh, en, false, { intent: intent, local: false, fallback: false });

    ctx.finish({
      text: zh,
      textEn: en,
      reply: zh,
      replyEn: en,
      raw: shown,
      intent: intent,
      args: args,
      marker: markerIntent || null,
      local: false,
      fallback: false,
      offline: false
    });
  }

  function send(text, opts) {
    opts = opts || {};
    var input = normalizeText(text);

    return new Promise(function (resolve) {
      var settled = false;
      var ctx = {
        ac: makeAbort(),
        timers: [],
        cancelled: false,
        timedOut: false,
        finish: null,
        settled: function () { return settled; }
      };

      ctx.finish = function (result) {
        if (settled) return;
        settled = true;
        for (var i = 0; i < ctx.timers.length; i++) clearTimeout(ctx.timers[i]);
        ctx.timers.length = 0;
        if (active === ctx) active = null;
        try { resolve(result); } catch (e) { /* ignore */ }
      };

      active = ctx;

      // 安全网：任何情况下 20s 内一定 resolve（12s 超时通常先触发）
      ctx.timers.push(setTimeout(function () {
        if (!settled) fallbackAnswer(input, opts, ctx, 'safety-timeout');
      }, SAFETY_TIMEOUT));

      if (!LLM.enabled) {
        localAnswer(input, opts, ctx);
        return;
      }

      streamAnswer(input, opts, ctx).catch(function (err) {
        if (settled) return;
        if (ctx.cancelled) { finishCancelled(ctx); return; }
        var reason = ctx.timedOut ? 'timeout' : String((err && err.message) || err || 'request-failed');
        fallbackAnswer(input, opts, ctx, reason);
      });
    });
  }

  function cancel() {
    if (!active) return false;
    var ctx = active;
    ctx.cancelled = true;
    try { if (ctx.ac) ctx.ac.abort(); } catch (e) { /* ignore */ }
    if (!ctx.settled()) finishCancelled(ctx);
    return true;
  }

  /* ============================================================ 配置 */
  var customSystemPrompt = '';

  function configure(opts) {
    opts = opts || {};
    // HUD 设置面板是「整体替换」JV.settings.llm，所以这里重新采纳外部对象，避免持有已脱钩的旧引用
    var incoming = settings && settings.llm;
    if (incoming && incoming !== LLM && typeof incoming === 'object') LLM = incoming;
    if (typeof LLM.enabled !== 'boolean') LLM.enabled = false;
    if (typeof LLM.endpoint !== 'string') LLM.endpoint = '';
    if (typeof LLM.model !== 'string') LLM.model = '';
    if (typeof LLM.key !== 'string') LLM.key = '';
    if (typeof LLM.temperature !== 'number') LLM.temperature = 0.4;
    if (typeof LLM.timeoutMs !== 'number') LLM.timeoutMs = DEFAULT_TIMEOUT;
    settings.llm = LLM;
    if (JV.settings && JV.settings !== settings) JV.settings.llm = LLM;

    if (opts.enabled !== undefined) LLM.enabled = !!opts.enabled;
    if (opts.endpoint !== undefined) LLM.endpoint = String(opts.endpoint || '');
    if (opts.model !== undefined) LLM.model = String(opts.model || '');
    if (opts.key !== undefined) LLM.key = String(opts.key || '');
    if (opts.temperature !== undefined) {
      var tp = Number(opts.temperature);
      LLM.temperature = isFinite(tp) ? Math.max(0, Math.min(2, tp)) : 0.4;
    }
    if (opts.timeoutMs !== undefined) {
      var tm = Number(opts.timeoutMs);
      LLM.timeoutMs = isFinite(tm) && tm > 0 ? Math.max(200, Math.min(30000, tm)) : DEFAULT_TIMEOUT;
    }
    if (opts.systemPrompt !== undefined) customSystemPrompt = String(opts.systemPrompt || '');
    try { if (typeof JV.saveSettings === 'function') JV.saveSettings(); } catch (e) { /* ignore */ }

    // 同步一次状态（探活是异步的，先按 enabled 给出瞬时值，避免 UI 停在旧状态）
    if (!LLM.enabled) setLLMState('offline', { reason: 'disabled' });
    var p = probe();
    if (p && typeof p.catch === 'function') p.catch(function () { /* probe 内部已兜底 */ });
    return status();
  }

  function status() {
    return state.llm || 'offline';
  }

  /* ============================================================ 对外对象 */
  var agent = {
    version: '2.0',
    systemPrompt: SYSTEM_PROMPT,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    facts: KNOWLEDGE,
    devices: KNOWLEDGE.devices,
    configure: configure,
    send: send,
    localRoute: localRoute,
    status: status,
    cancel: cancel,
    probe: probe,
    check: probe,
    _internal: {
      splitBilingual: splitBilingual,
      consumeSSE: consumeSSE,
      extractIntent: extractIntent,
      stripIntentMarkers: stripIntentMarkers,
      resolveChatUrl: resolveChatUrl,
      resolveHealthUrl: resolveHealthUrl,
      deltaTextOf: deltaTextOf,
      errorMessageOf: errorMessageOf,
      normalizeText: normalizeText,
      requestTimeout: requestTimeout,
      SYSTEM_PROMPT: SYSTEM_PROMPT,
      KNOWLEDGE: KNOWLEDGE,
      INTENTS: INTENTS
    }
  };

  JV.agent = agent;
  root.JV = JV;

  // 启动探活：浏览器里等所有模块（尤其 08-boot 的 agent:status 监听）就绪后再跑
  if (hasWindow) {
    setTimeout(function () { probe(); }, 0);
  }

  // Node 单测/脚本复用：暴露纯函数，不依赖 window
  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = {
      agent: agent,
      localRoute: localRoute,
      configure: configure,
      send: send,
      status: status,
      cancel: cancel,
      probe: probe,
      splitBilingual: splitBilingual,
      consumeSSE: consumeSSE,
      extractIntent: extractIntent,
      stripIntentMarkers: stripIntentMarkers,
      resolveChatUrl: resolveChatUrl,
      resolveHealthUrl: resolveHealthUrl,
      normalizeText: normalizeText,
      SYSTEM_PROMPT: SYSTEM_PROMPT,
      KNOWLEDGE: KNOWLEDGE,
      INTENTS: INTENTS
    };
  }
})();
