/* ============================================================================
 * JARVIS 2.0 · 04-hud.js
 * HUD DOM 控制器：时钟 / 面板数据 / 字幕 / 输入 / 快捷指令 / 波形 / 设置抽屉
 * 依赖：JV（00-core.js）
 * ==========================================================================*/
(function () {
  'use strict';
  var JV = window.JV;
  var U = JV.util;

  function $(id) { return document.getElementById(id); }
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var el = {
    root: $('jv-root'),
    clock: $('jv-clock'), date: $('jv-date'),
    fps: $('jv-fps'), quality: $('jv-quality'), link: $('jv-link'),
    statusDot: $('jv-status-dot'), statusText: $('jv-status-text'),
    tasks: $('jv-tasks'), taskDone: $('jv-task-done'), taskTotal: $('jv-task-total'),
    ticks: $('jv-ticks'), taskbarTime: $('jv-taskbar-time'),
    askText: $('jv-ask-text'),
    wave: $('jv-wave-canvas'),
    temp: $('jv-temp'), cond: $('jv-cond'), feel: $('jv-feel'),
    forecast: $('jv-forecast'), travelPlace: $('jv-travel-place'),
    travelMeta: $('jv-travel-meta'), arrive: $('jv-arrive'),
    agendaList: $('jv-agenda-list'), agendaFoot: $('jv-agenda-foot'),
    llmChip: $('jv-llm-chip'), llmHint: $('jv-llm-hint'),
    subtitle: $('jv-subtitle'), subSpeaker: $('jv-sub-speaker'),
    subZh: $('jv-sub-zh'), subEn: $('jv-sub-en'),
    transcript: $('jv-transcript'),
    chips: $('jv-chips'), input: $('jv-input'), inputWrap: $('jv-inputwrap'),
    mic: $('jv-mic'), hold: $('jv-hold'),
    coords: $('jv-coords'), sceneLabel: $('jv-scene-label'),
    gesture: $('jv-gesture'), gestureLabel: $('jv-gesture-label'), gestureMode: $('jv-gesture-mode'),
    handCanvas: $('jv-hand-canvas'),
    hint: $('jv-hint'), toast: $('jv-toast'),
    settings: $('jv-settings'), boot: $('jv-boot'), enter: $('jv-enter'),
    qr: $('jv-qr')
  };
  el.transcriptTxt = el.transcript ? qs('.txt', el.transcript) : null;

  /* ------------------------------------------------------------------ 时钟 */
  var lastClock = '';
  function tickClock() {
    var d = new Date();
    var hhmm = U.fmtTime(d);
    var sec = ('0' + d.getSeconds()).slice(-2);
    if (el.clock) {
      var key = hhmm + sec;
      if (key !== lastClock) {
        lastClock = key;
        el.clock.innerHTML = hhmm + '<span class="sec">:' + sec + '</span>';
      }
    }
    if (el.date) el.date.textContent = U.fmtDate(d, JV.settings.lang);
    if (el.taskbarTime) el.taskbarTime.textContent = U.fmtTimeSec(d);
  }

  /* --------------------------------------------------------------- 场景名 */
  var SCENE_LABELS = {
    orb: '能量核心', city: '城市全息沙盘', grid: '系统自检'
  };
  function setZoom(z) {
    var el2 = $('jv-zoom');
    if (el2) el2.textContent = '×' + (Number(z) || 1).toFixed(2);
  }

  function setScene(name, label) {
    JV.state.sceneName = name;
    if (el.sceneLabel) el.sceneLabel.textContent = label || SCENE_LABELS[name] || name;
  }

  /* --------------------------------------------------------------- 字幕 */
  var subHideTimer = 0, typeTimer = 0;
  function setSubtitle(opts) {
    opts = opts || {};
    var who = opts.who || 'jarvis';
    var zh = opts.zh != null ? opts.zh : (opts.text || '');
    var en = opts.en != null ? opts.en : (opts.textEn || '');
    var done = opts.done !== false;
    var animate = opts.animate !== false && done;
    if (el.subSpeaker) el.subSpeaker.textContent = who === 'you' ? 'YOU' : 'JARVIS';
    if (el.subEn) {
      el.subEn.textContent = en;
      el.subEn.style.display = (!en || JV.settings.lang === 'en') ? 'none' : '';
    }
    if (el.subtitle) {
      el.subtitle.classList.remove('is-hidden');
      el.subtitle.classList.toggle('is-you', who === 'you');
      el.subtitle.classList.toggle('is-streaming', !done);
    }
    clearTimeout(typeTimer);
    if (el.subZh) {
      if (animate && zh.length > 6) {
        // 逐字出现（约 45 字/秒），保留光标
        var i = 0;
        el.subZh.textContent = '';
        var caret = document.createElement('i');
        caret.className = 'caret';
        el.subZh.appendChild(caret);
        typeTimer = setInterval(function () {
          i++;
          el.subZh.textContent = zh.slice(0, i);
          el.subZh.appendChild(caret);
          if (i >= zh.length) {
            clearInterval(typeTimer);
            caret.style.display = 'none';
          }
        }, 22);
      } else {
        el.subZh.textContent = zh;
      }
    }
    clearTimeout(subHideTimer);
    if (done) {
      var hold = Math.max(3600, Math.min(12000, (zh.length + en.length) * 130));
      subHideTimer = setTimeout(function () {
        if (el.subtitle) el.subtitle.classList.add('is-hidden');
      }, hold + Math.min(1600, zh.length * 22));
    }
  }
  function hideSubtitle() {
    if (el.subtitle) el.subtitle.classList.add('is-hidden');
    clearTimeout(subHideTimer);
  }

  function setTranscript(o) {
    if (!el.transcriptTxt) return;
    o = o || {};
    var text = o.text || '';
    el.transcriptTxt.textContent = text || (o.placeholder || '说出你的想法，先生。');
    el.transcriptTxt.classList.toggle('is-placeholder', !text);
  }

  /* --------------------------------------------------------------- 快捷指令 */
  function setChips(list) {
    if (!el.chips) return;
    el.chips.innerHTML = '';
    (list || []).forEach(function (item) {
      var b = document.createElement('button');
      b.className = 'jv-chip';
      b.type = 'button';
      var text = typeof item === 'string' ? item : item.text;
      b.textContent = text;
      b.dataset.q = (typeof item === 'string') ? item : (item.send || text);
      el.chips.appendChild(b);
    });
  }

  /* --------------------------------------------------------------- 左栏任务 */
  var TASK_META = {
    search: { en: 'SEARCH', zh: '搜索与深度分析' },
    build: { en: 'BUILDER', zh: '生成与方案构建' },
    verify: { en: 'VIEW', zh: '评估与风险审查' }
  };
  function taskNode(name) {
    return el.tasks ? qs('.jv-task[data-tool="' + name + '"]', el.tasks) : null;
  }
  function setTaskStatus(name, status) {
    var node = taskNode(name);
    if (!node) return;
    node.classList.toggle('is-active', status === 'start');
    node.classList.toggle('is-done', status === 'ok');
    node.classList.toggle('is-fail', status === 'fail');
  }
  function setTasks(list) {
    (list || []).forEach(function (t) {
      if (t && t.tool) setTaskStatus(t.tool, t.status);
    });
  }
  var progress = { done: 0, total: 0 };
  var TICK_SEGMENTS = 12;   // 原片：12 段短横
  function renderTicks() {
    if (!el.ticks) return;
    var filled = progress.total ? Math.round(progress.done / progress.total * TICK_SEGMENTS) : 0;
    var html = '';
    for (var i = 0; i < TICK_SEGMENTS; i++) {
      html += '<i class="' + (i < filled ? 'is-done' : '') + '"></i>';
    }
    el.ticks.innerHTML = html;
  }
  var ringEl = $('jv-ring'), ringNum = $('jv-ring-num');
  function setTaskProgress(done, total) {
    progress.done = Math.max(0, done | 0);
    progress.total = Math.max(progress.done, total | 0);
    if (el.taskDone) el.taskDone.textContent = String(progress.done);
    if (el.taskTotal) el.taskTotal.textContent = String(progress.total);
    var pct = progress.total ? Math.round(progress.done / progress.total * 100) : 0;
    if (ringEl) ringEl.style.setProperty('--p', String(pct));
    if (ringNum) ringNum.textContent = pct + '%';
    renderTicks();
  }

  /* ----------------------------------------------------------------- 天气 */
  var WEATHER_CODES = {
    0: ['晴', '☀'], 1: ['多云', '☀'], 2: ['多云', '⛅'], 3: ['阴', '☁'],
    45: ['雾', '☁'], 48: ['雾凇', '☁'], 51: ['小雨', '☂'], 53: ['小雨', '☂'], 55: ['中雨', '☂'],
    61: ['小雨', '☂'], 63: ['中雨', '☂'], 65: ['大雨', '☂'], 71: ['小雪', '❄'], 73: ['中雪', '❄'],
    75: ['大雪', '❄'], 80: ['阵雨', '☂'], 81: ['阵雨', '☂'], 82: ['强阵雨', '☂'],
    95: ['雷阵雨', '⚡'], 96: ['雷阵雨', '⚡'], 99: ['雷阵雨', '⚡']
  };
  function codeInfo(c) {
    return WEATHER_CODES[c] || ['阴', '☁'];
  }
  // 线性图标（比 emoji 更像全息 HUD，且各平台一致）
  function iconFor(code) {
    var sun = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
      '<path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
    var cloud = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 16.5a3.9 3.9 0 0 1 .3-7.8 5.4 5.4 0 0 1 10.2 1.2 3.4 3.4 0 0 1-.4 6.6H6.4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    var rain = cloud + '';
    rain = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 14.6a3.6 3.6 0 0 1 .3-7.2 5 5 0 0 1 9.5 1.1 3.2 3.2 0 0 1-.4 6.1H6.4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
      '<path d="M8.6 17.4l-.7 2.4M12.4 17.4l-.7 2.4M16.2 17.4l-.7 2.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
    var snow = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 14.2a3.6 3.6 0 0 1 .3-7.2 5 5 0 0 1 9.5 1.1 3.2 3.2 0 0 1-.4 6.1H6.4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
      '<path d="M9 18.2v2M12 18.2v2M15 18.2v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
    var thunder = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 13.8a3.6 3.6 0 0 1 .3-7.2 5 5 0 0 1 9.5 1.1 3.2 3.2 0 0 1-.4 6.1H6.4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
      '<path d="M12.6 15.4l-2.2 3h2.6l-1.6 3.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    if (code === 0 || code === 1) return sun;
    if (code >= 71 && code <= 77) return snow;
    if (code >= 95) return thunder;
    if (code >= 51) return rain;
    return cloud;
  }
  function setWeather(w) {
    w = w || {};
    if (el.temp && w.temp != null) el.temp.textContent = String(Math.round(w.temp));
    if (el.cond) el.cond.textContent = w.cond || '阴';
    if (el.feel) el.feel.textContent = w.feel || '未来景区 湿度 64%';
    if (el.forecast && w.days && w.days.length) {
      el.forecast.innerHTML = w.days.slice(0, 3).map(function (d) {
        return '<li><span>' + U.esc(d.label) + '</span><i>' + iconFor(d.code) + '</i><b>' +
          Math.round(d.min) + '°/' + Math.round(d.max) + '°</b></li>';
      }).join('');
    }
  }
  var DEFAULT_WEATHER = {
    temp: 15, cond: '阴', feel: '未央区 湿度 64%',
    days: [
      { label: '今天', min: 10, max: 20, code: 3 },
      { label: '明天', min: 9, max: 19, code: 0 },
      { label: '周三', min: 8, max: 13, code: 3 }
    ]
  };
  function loadWeather() {
    setWeather(DEFAULT_WEATHER);
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=31.2304&longitude=121.4737' +
      '&current=temperature_2m,relative_humidity_2m,weather_code' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=4&timezone=Asia%2FShanghai';
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 6000);
    fetch(url, { signal: ctrl.signal }).then(function (r) { return r.json(); }).then(function (j) {
      clearTimeout(timer);
      if (!j || !j.current) return;
      var days = (j.daily && j.daily.time || []).map(function (dt, i) {
        var label = i === 0 ? '今天' : i === 1 ? '明天' : (function () {
          var wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
          return wd[new Date(dt + 'T00:00:00').getDay()];
        })();
        return {
          label: label,
          min: j.daily.temperature_2m_min[i],
          max: j.daily.temperature_2m_max[i],
          code: j.daily.weather_code[i]
        };
      });
      var code = j.current.weather_code;
      setWeather({
        temp: j.current.temperature_2m,
        cond: codeInfo(code)[0],
        feel: '未央区 湿度 ' + Math.round(j.current.relative_humidity_2m || 64) + '%',
        days: days
      });
      bus.emit('weather:loaded', { temp: j.current.temperature_2m, code: code, days: days });
    }).catch(function () { clearTimeout(timer); /* 保持默认演示数据 */ });
  }

  function setTravel() { /* 已按需求移除「去大唐不夜城」路程信息 */ }

  /* --------------------------------------------------------------- 今日安排 */
  var LS_AGENDA = 'jarvis2.agenda.v1';
  var agenda = [];
  try { agenda = JSON.parse(localStorage.getItem(LS_AGENDA) || '[]') || []; } catch (e) { agenda = []; }
  function renderAgenda() {
    if (!el.agendaList) return;
    if (!agenda.length) {
      el.agendaList.innerHTML =
        '<li class="jv-agenda-item is-empty"><span class="jv-agenda-day">今天</span>' +
        '<div class="jv-agenda-body"><b>还没有安排</b>' +
        '<span>说 “Hey Jarvis”，告诉我今天要做什么</span></div></li>';
      if (el.agendaFoot) el.agendaFoot.textContent = '一切归零 · 今日自由';
      return;
    }
    el.agendaList.innerHTML = agenda.map(function (a, i) {
      return '<li class="jv-agenda-item" data-idx="' + i + '">' +
        '<span class="jv-agenda-day">' + U.esc(a.when || '今天') + '</span>' +
        '<div class="jv-agenda-body"><b>' + U.esc(a.title) + '</b>' +
        '<span>' + U.esc(a.detail || '') + '</span></div></li>';
    }).join('');
    if (el.agendaFoot) el.agendaFoot.textContent = agenda.length + ' 项安排 · 按优先级排序';
  }
  function setAgenda(list, persist) {
    agenda = (list || []).slice(0, 6);
    renderAgenda();
    if (persist !== false) {
      try { localStorage.setItem(LS_AGENDA, JSON.stringify(agenda)); } catch (e) {}
    }
  }
  function addAgenda(item) {
    agenda.unshift(item);
    setAgenda(agenda);
  }

  /* ---------------------------------------------------------- 语音自检面板 */
  var vd = {
    root: null, engine: null, ws: null, ctx: null, device: null, meter: null, rms: null,
    counters: null, last: null, err: null, timer: 0, micsLoaded: false
  };
  function vdInit() {
    vd.root = $('jv-voicediag');
    vd.engine = $('jv-vd-engine'); vd.ws = $('jv-vd-ws'); vd.ctx = $('jv-vd-ctx');
    vd.device = $('jv-vd-device'); vd.meter = $('jv-vd-meter'); vd.rms = $('jv-vd-rms');
    vd.counters = $('jv-vd-counters'); vd.last = $('jv-vd-last'); vd.err = $('jv-vd-err');
    var rc = $('jv-vd-reconnect'), st = $('jv-vd-settings');
    if (rc) rc.addEventListener('click', function () { if (JV.voice && JV.voice.reconnect) JV.voice.reconnect(); });
    var gstop2 = $('jv-gd-stop'), greset = $('jv-gd-reset');
    if (gstop2) gstop2.addEventListener('click', function () {
      if (JV.gesture) { JV.gesture.stop(); toast('已关闭手势摄像头', 1800); }
    });
    var gserver = $('jv-gd-server');
    if (gserver) gserver.addEventListener('click', function () {
      var target = 'http://127.0.0.1:8780/JARVIS-HUD.html';
      fetch(target, { method: 'HEAD', mode: 'no-cors' }).then(function () {
        location.href = target;
      }).catch(function () {
        toast('本地服务没启动：先双击 启动Jarvis.command', 5000);
      });
    });
    if (greset) greset.addEventListener('click', function () {
      JV.state.rotY = 0; JV.state.rotX = 0; JV.state.roll = 0; JV.state.zoom = 1; JV.state.panX = 0; JV.state.panY = 0;
      toast('姿态已复位', 1600);
    });
    var gs = $('jv-gd-start'), gd2 = $('jv-gd-demo');
    if (gs) gs.addEventListener('click', function () {
      if (!JV.gesture) { toast('手势模块未加载', 2200); return; }
      var btn = gs;
      var old = btn.textContent;
      btn.textContent = '正在申请摄像头…';
      btn.disabled = true;
      toast('正在申请摄像头权限，请在浏览器弹窗里点「允许」', 3600);
      Promise.resolve(JV.gesture.start()).then(function (ok) {
        btn.disabled = false;
        btn.textContent = old;
        if (!ok) toast('手势没起来：' + ((JV.gesture.status() && JV.gesture.status().error) || '未知原因') + '（面板里有错误行）', 6000);
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = old;
        toast('手势启动异常：' + ((e && e.message) || e), 5000);
      });
    });
    if (gd2) gd2.addEventListener('click', function () {
      if (!JV.gesture) return;
      if (JV.gesture.demoOn && JV.gesture.demoOn()) JV.gesture.demoStop();
      else JV.gesture.demo('mix');
      toast('合成双手演示（再点一次停止）', 2200);
    });
    if (vd.device) vd.device.addEventListener('change', function () {
      if (JV.voice && JV.voice.useMic) JV.voice.useMic(vd.device.value || '').then(function () { toast('已切换麦克风', 1600); });
    });
    if (st) st.addEventListener('click', function () { openSettings(); });
  }
  function vdTick() {
    if (!vd.root || vd.root.classList.contains('is-hidden')) return;
    var d = (JV.voice && JV.voice.diag) ? JV.voice.diag() : null;
    if (!d) return;
    var eng = { local: '本机离线识别', webspeech: '浏览器语音', none: '未启用' }[d.engine] || d.engine;
    if (vd.engine) vd.engine.textContent = eng + (d.listening ? ' · 聆听中' : '');
    if (vd.ws) vd.ws.textContent = ({ '-1': '未连接', 0: '连接中', 1: '已连接', 2: '关闭中', 3: '已关闭' }[d.ws]) || d.ws;
    if (vd.ctx) vd.ctx.textContent = (d.ctxState || 'none') + (d.sampleRate ? ' · ' + d.sampleRate + 'Hz' : '');
    if (vd.device && !vd.micsLoaded && JV.voice && JV.voice.listMics) {
      vd.micsLoaded = true;
      JV.voice.listMics().then(function (mics) {
        (mics || []).forEach(function (m) {
          var opt = document.createElement('option');
          opt.value = m.id; opt.textContent = (m.label || '麦克风').slice(0, 22);
          if (JV.settings.micId && JV.settings.micId === m.id) opt.selected = true;
          vd.device.appendChild(opt);
        });
      });
    }
    if (vd.meter) vd.meter.style.width = Math.min(100, Math.round(d.rms * 260)) + '%';
    if (vd.rms) vd.rms.textContent = d.rms.toFixed(3);
    if (vd.counters) vd.counters.textContent = d.frames + ' 帧 / partial ' + d.partials + ' · final ' + d.finals;
    if (vd.last) vd.last.textContent = d.lastFinal || d.lastPartial || '—';
    if (vd.err) vd.err.textContent = d.lastError || '—';
    // 手势诊断
    var gd = (JV.gesture && JV.gesture.diag) ? JV.gesture.diag() : null;
    var setT = function (id, txt) { var e = $(id); if (e) e.textContent = txt; };
    if (gd) {
      setT('jv-gd-src', gd.mpSource ? (gd.mpSource.indexOf('local') === 0 ? '本地（离线可用）' : 'CDN') : '未加载');
      setT('jv-gd-stage', ({ idle: '待机', camera: '申请摄像头', script: '加载资源', hands: '初始化', streaming: '送帧中', running: '识别中' }[gd.stage]) || gd.stage);
      setT('jv-gd-count', gd.framesSent + ' 帧 / ' + gd.results + ' 次');
      setT('jv-gd-hands', gd.resultsWithHands + ' 次 · 当前 ' + (gd.hands || 0) + ' 手');
      setT('jv-gd-xf', 'rot ' + (JV.state.rotY || 0).toFixed(2) + ' / zoom ×' + (JV.state.zoom || 1).toFixed(2));
      var ge = $('jv-gd-err');
      if (ge) {
        var errTxt = gd.lastError || gd.error || '—';
        ge.textContent = errTxt;
        ge.style.color = (gd.lastError || gd.error) ? '#ff8a3d' : '';
      }
    }
  }
  function toggleVoiceDiag(force) {
    if (!vd.root) vdInit();
    if (!vd.root) return;
    var show = force != null ? force : vd.root.classList.contains('is-hidden');
    vd.root.classList.toggle('is-hidden', !show);
    clearInterval(vd.timer);
    if (show) { vdTick(); vd.timer = setInterval(vdTick, 400); }
  }

  /* ------------------------------------------------------------------ QR */
  function drawQR() { /* 出行二维码随路程卡一起移除 */ }

  /* --------------------------------------------------------------- 波形图 */
  var waveCtx = el.wave ? el.wave.getContext('2d') : null;
  var wavePhase = 0;
  var waveLevel = 0;
  function drawWave(dt) {
    if (!waveCtx) return;
    var c = el.wave, w = c.width, h = c.height;
    wavePhase += dt * (0.7 + waveLevel * 2.4);
    waveCtx.clearRect(0, 0, w, h);
    var layers = [
      { color: 'rgba(126,245,207,', amp: .34, freq: 1.0, speed: 1.0, alpha: .85 },
      { color: 'rgba(126,245,207,', amp: .22, freq: 1.7, speed: -1.5, alpha: .45 },
      { color: 'rgba(255,193,119,', amp: .14, freq: 2.6, speed: 2.1, alpha: .5 }
    ];
    layers.forEach(function (L, li) {
      waveCtx.beginPath();
      for (var x = 0; x <= w; x += 3) {
        var nx = x / w;
        var env = Math.sin(nx * Math.PI);
        var y = h / 2 +
          Math.sin(nx * Math.PI * 2 * L.freq + wavePhase * L.speed) * L.amp * h * env * (1 + waveLevel * 1.8) +
          Math.sin(nx * Math.PI * 5 + wavePhase * L.speed * .6) * L.amp * h * .18 * env;
        if (x === 0) waveCtx.moveTo(x, y); else waveCtx.lineTo(x, y);
      }
      waveCtx.strokeStyle = L.color + (L.alpha * (0.55 + waveLevel * 0.45)) + ')';
      waveCtx.lineWidth = li === 0 ? 1.5 : 1;
      waveCtx.shadowColor = L.color + '.5)';
      waveCtx.shadowBlur = 6;
      waveCtx.stroke();
    });
    waveCtx.shadowBlur = 0;
  }

  /* ------------------------------------------------------------- 麦克风态 */
  var MIC_TEXT = {
    idle: '待唤醒', listen: '聆听中', think: '思考中', speak: '回应中', off: '未启用'
  };
  function setMicState(state) {
    JV.state.mode = state;
    if (el.mic) {
      el.mic.classList.toggle('is-listen', state === 'listen');
      el.mic.classList.toggle('is-think', state === 'think');
      el.mic.classList.toggle('is-speak', state === 'speak');
    }
    if (el.hold) el.hold.classList.toggle('is-on', state === 'listen');
    if (el.statusDot && el.statusText) {
      el.statusText.textContent = MIC_TEXT[state] || state;
      var wrap = el.statusDot.parentNode;
      if (wrap) {
        wrap.classList.toggle('is-listen', state === 'listen');
        wrap.classList.toggle('is-think', state === 'think');
      }
    }
    if (state === 'listen' && el.input) el.input.placeholder = '正在聆听…';
    else if (el.input) el.input.placeholder = '说 “Hey Jarvis”，或在这里打字';
  }

  function setLlmStatus(status, model) {
    JV.state.llm = status;
    if (el.llmChip) el.llmChip.classList.toggle('is-live', status === 'llm' || status === 'proxy');
    if (el.llmHint) {
      el.llmHint.textContent = status === 'llm' ? (model || '已接入')
        : status === 'proxy' ? '代理在线' : '本地意图';
    }
    if (el.link) el.link.textContent = status === 'llm' ? 'LLM' : status === 'proxy' ? 'PROXY' : 'LOCAL';
    var stateEl = $('jv-llm-state');
    if (stateEl) {
      stateEl.textContent = status === 'llm' ? '已连接 · ' + (model || '')
        : status === 'proxy' ? '代理在线 · 未配置模型' : '未接入 · 使用本地意图';
    }
  }

  function setToolsStatus(info) {
    info = info || {};
    var chip = $('jv-tools-chip'), hint = $('jv-tools-hint'), state = $('jv-tools-state');
    var on = !!info.available;
    if (chip) chip.classList.toggle('is-live', on);
    if (hint) hint.textContent = on ? '已接入' : (info.error ? '未接入' : '检测中…');
    if (state) state.textContent = on ? '已连接 · 127.0.0.1:8824' : ('未连接' + (info.error ? ' · ' + info.error : ''));
  }

  function setGesture(info) {
    info = info || {};
    if (el.gesture) el.gesture.classList.toggle('is-off', !info.enabled);
    if (el.gestureLabel) el.gestureLabel.textContent = info.enabled ? '手势 · 运行中' : (info.error ? '手势 · 不可用' : '手势 · 关闭');
    if (el.gestureMode) {
      el.gestureMode.textContent = info.error ? info.error
        : info.enabled ? ('识别：' + (info.mode || '待机') + (info.count ? ' · ' + info.count + ' 手' : ''))
          : '按 G 开启摄像头';
    }
  }

  var toastTimer = 0;
  function toast(msg, ms) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('is-on'); }, ms || 2200);
  }

  /* ------------------------------------------------------------ 设置抽屉 */
  var ui = {
    voice: $('jv-set-voice'), gesture: $('jv-set-gesture'), en: $('jv-set-en'),
    theme: $('jv-set-theme'), quality: $('jv-set-quality'), gender: $('jv-set-gender'),
    llm: $('jv-set-llm'), endpoint: $('jv-llm-endpoint'), model: $('jv-llm-model'),
    key: $('jv-llm-key'), llmTest: $('jv-llm-test')
  };
  function openSettings() {
    if (!el.settings) return;
    syncSettingsUI();
    el.settings.classList.add('is-open');
    el.settings.setAttribute('aria-hidden', 'false');
  }
  function closeSettings() {
    if (!el.settings) return;
    el.settings.classList.remove('is-open');
    el.settings.setAttribute('aria-hidden', 'true');
  }
  function syncSettingsUI() {
    var s = JV.settings;
    if (ui.voice) ui.voice.checked = !!s.voice;
    if (ui.gesture) ui.gesture.checked = !!s.gesture;
    if (ui.en) ui.en.checked = s.lang !== 'en';
    if (ui.theme) qsa('button', ui.theme).forEach(function (b) { b.classList.toggle('is-on', b.dataset.v === s.theme); });
    // 记忆
    var memBox = $('jv-set-memory');
    if (memBox) {
      memBox.checked = JV.settings.memoryEnabled !== false;
      memBox.addEventListener('change', function () {
        JV.settings.memoryEnabled = memBox.checked; JV.saveSettings();
        toast(memBox.checked ? '上下文记忆已开启' : '上下文记忆已关闭', 1800);
      });
    }
    var memView = $('jv-memory-view'), memClear = $('jv-memory-clear');
    if (memView) memView.addEventListener('click', function () {
      var facts = (JV.memory && JV.memory.facts()) || [];
      toast(facts.length ? facts.map(function (f) { return f.text; }).slice(-4).join(' ｜ ') : '还没有长期记忆', 6000);
    });
    if (memClear) memClear.addEventListener('click', function () {
      if (JV.memory) { JV.memory.clear(); renderMemoryStat(); toast('记忆已清空', 1800); }
    });
    JV.bus.on('memory:changed', renderMemoryStat);

    // 插件
    renderPlugins();
    renderCities();
    JV.bus.on('plugins:changed', function () { renderPlugins(); });

    // 手势灵敏度 / 关闭摄像头
    var gsens = $('jv-set-gsens');
    if (gsens) qsa('button', gsens).forEach(function (b) {
      b.addEventListener('click', function () {
        JV.settings.gestureSensitivity = b.dataset.v; JV.saveSettings();
        qsa('button', gsens).forEach(function (x) { x.classList.toggle('is-on', x === b); });
        toast('手势灵敏度：' + ({ low: '低', mid: '中', high: '高' }[b.dataset.v]), 1600);
      });
    });
    var gstop = $('jv-set-gstop');
    if (gstop) gstop.addEventListener('click', function () {
      if (JV.gesture) { JV.gesture.stop(); toast('已关闭手势摄像头', 1800); }
      hud.setGesture({ enabled: false });
    });

    if (ui.gender) qsa('button', ui.gender).forEach(function (b) { b.classList.toggle('is-on', b.dataset.v === (s.voiceGender || 'male')); });
    var gsens2 = $('jv-set-gsens');
    if (gsens2) qsa('button', gsens2).forEach(function (b) { b.classList.toggle('is-on', b.dataset.v === (s.gestureSensitivity || 'mid')); });
    var memBox2 = $('jv-set-memory');
    if (memBox2) memBox2.checked = s.memoryEnabled !== false;
    renderMemoryStat();
    var vn = $('jv-voice-name');
    if (vn && JV.voice && JV.voice.voiceName) vn.textContent = JV.voice.voiceName() || '系统默认';
    // 记忆
    var memBox = $('jv-set-memory');
    if (memBox) {
      memBox.checked = JV.settings.memoryEnabled !== false;
      memBox.addEventListener('change', function () {
        JV.settings.memoryEnabled = memBox.checked; JV.saveSettings();
        toast(memBox.checked ? '上下文记忆已开启' : '上下文记忆已关闭', 1800);
      });
    }
    var memView = $('jv-memory-view'), memClear = $('jv-memory-clear');
    if (memView) memView.addEventListener('click', function () {
      var facts = (JV.memory && JV.memory.facts()) || [];
      toast(facts.length ? facts.map(function (f) { return f.text; }).slice(-4).join(' ｜ ') : '还没有长期记忆', 6000);
    });
    if (memClear) memClear.addEventListener('click', function () {
      if (JV.memory) { JV.memory.clear(); renderMemoryStat(); toast('记忆已清空', 1800); }
    });
    JV.bus.on('memory:changed', renderMemoryStat);

    // 插件
    renderPlugins();
    renderCities();
    JV.bus.on('plugins:changed', function () { renderPlugins(); });

    // 手势灵敏度 / 关闭摄像头
    var gsens = $('jv-set-gsens');
    if (gsens) qsa('button', gsens).forEach(function (b) {
      b.addEventListener('click', function () {
        JV.settings.gestureSensitivity = b.dataset.v; JV.saveSettings();
        qsa('button', gsens).forEach(function (x) { x.classList.toggle('is-on', x === b); });
        toast('手势灵敏度：' + ({ low: '低', mid: '中', high: '高' }[b.dataset.v]), 1600);
      });
    });
    var gstop = $('jv-set-gstop');
    if (gstop) gstop.addEventListener('click', function () {
      if (JV.gesture) { JV.gesture.stop(); toast('已关闭手势摄像头', 1800); }
      hud.setGesture({ enabled: false });
    });

    if (ui.gender) qsa('button', ui.gender).forEach(function (b) {
      b.addEventListener('click', function () {
        var g = b.dataset.v;
        if (JV.voice && JV.voice.setGender) JV.voice.setGender(g);
        syncSettingsUI();
        toast('声音已切换为' + (g === 'male' ? '男声' : '女声'), 1600);
        if (JV.voice) setTimeout(function () { JV.voice.speak('先生，已经换成' + (g === 'male' ? '男声' : '女声') + '了。'); }, 220);
      });
    });
    // 本机权限开关
    var grantMap = { 'jv-grant-system': 'system', 'jv-grant-files': 'files', 'jv-grant-shell': 'shell', 'jv-grant-network': 'network' };
    Object.keys(grantMap).forEach(function (id) {
      var box = $(id);
      if (!box) return;
      if (!JV.settings.grants) JV.settings.grants = {};
      box.checked = JV.settings.grants[grantMap[id]] !== false;
      box.addEventListener('change', function () {
        JV.settings.grants[grantMap[id]] = box.checked;
        JV.saveSettings();
        toast((box.checked ? '已授权：' : '已关闭：') + box.closest('.jv-set-row').querySelector('span').textContent, 1800);
      });
    });
    if (ui.quality) qsa('button', ui.quality).forEach(function (b) { b.classList.toggle('is-on', b.dataset.v === s.quality); });
    if (ui.llm) ui.llm.checked = !!(s.llm && s.llm.enabled);
    if (ui.endpoint) ui.endpoint.value = (s.llm && s.llm.endpoint) || '';
    if (ui.model) ui.model.value = (s.llm && s.llm.model) || '';
    if (ui.key) ui.key.value = (s.llm && s.llm.key) || '';
  }
  function renderPlugins() {
    var box = $('jv-set-plugins');
    if (!box || !JV.plugins) return;
    var list = JV.plugins.list();
    box.innerHTML = '';
    list.forEach(function (p) {
      var row = document.createElement('label');
      row.className = 'jv-plugin-row';
      row.innerHTML = '<span class="ico">' + (p.icon || '●') + '</span>' +
        '<span class="nm">' + U.esc(p.name) + '</span>' +
        '<span class="ds">' + U.esc(p.desc || '') + '</span>' +
        '<input type="checkbox" ' + (p.enabled ? 'checked' : '') + ' data-pid="' + p.id + '" /><i class="sw"></i>';
      var box2 = row.querySelector('input');
      box2.addEventListener('change', function () {
        JV.plugins.toggle(p.id, box2.checked);
        toast((box2.checked ? '已启用插件：' : '已关闭插件：') + p.name, 1600);
      });
      box.appendChild(row);
    });
  }
  var HOT_CITIES = ['北京','上海','广州','深圳','成都','杭州','西安','重庆','南京','武汉','苏州','天津','长沙','青岛','厦门','昆明','大连','哈尔滨','乌鲁木齐','拉萨','三亚','香港','台北'];
  function renderCities() {
    var box = $('jv-set-cities');
    if (!box) return;
    box.innerHTML = '';
    HOT_CITIES.forEach(function (city) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = city;
      b.addEventListener('click', function () {
        toast('正在加载 ' + city + ' 的真实城市全息…', 2200);
        closeSettings();
        if (JV.globe && JV.globe.focus) {
          JV.globe.focus(city).then(function (r) {
            if (r && r.ok) toast(city + ' · 已加载 ' + (r.buildings || 0) + ' 栋建筑', 3000);
            else toast(city + ' 数据不可用，已回退示意', 3000);
          });
        }
      });
      box.appendChild(b);
    });
  }

  function renderMemoryStat() {
    var el2 = $('jv-memory-stat');
    if (!el2 || !JV.memory) return;
    var st = JV.memory.stats();
    el2.textContent = '对话 ' + st.turns + ' 条 · 长期记忆 ' + st.facts + ' 条';
  }

  function wireSettings() {
    var gear = $('jv-gear');
    if (gear) gear.addEventListener('click', function (e) { e.stopPropagation(); openSettings(); });
    var closeBtn = $('jv-set-close');
    if (closeBtn) closeBtn.addEventListener('click', closeSettings);
    if (ui.voice) ui.voice.addEventListener('change', function () {
      JV.settings.voice = ui.voice.checked; JV.saveSettings();
      if (JV.voice) { if (ui.voice.checked) JV.voice.enable(); else JV.voice.disable(); }
    });
    if (ui.gesture) ui.gesture.addEventListener('change', function () {
      JV.settings.gesture = ui.gesture.checked; JV.saveSettings();
      if (JV.gesture) { if (ui.gesture.checked) JV.gesture.start(); else JV.gesture.stop(); }
    });
    if (ui.en) ui.en.addEventListener('change', function () {
      JV.settings.lang = ui.en.checked ? 'zh' : 'en'; JV.saveSettings();
      JV.bus.emit('lang:changed', { lang: JV.settings.lang });
    });
    if (ui.theme) qsa('button', ui.theme).forEach(function (b) {
      b.addEventListener('click', function () {
        JV.applyTheme(b.dataset.v); syncSettingsUI();
        JV.bus.emit('theme:changed', { theme: b.dataset.v });
      });
    });
    // 记忆
    var memBox = $('jv-set-memory');
    if (memBox) {
      memBox.checked = JV.settings.memoryEnabled !== false;
      memBox.addEventListener('change', function () {
        JV.settings.memoryEnabled = memBox.checked; JV.saveSettings();
        toast(memBox.checked ? '上下文记忆已开启' : '上下文记忆已关闭', 1800);
      });
    }
    var memView = $('jv-memory-view'), memClear = $('jv-memory-clear');
    if (memView) memView.addEventListener('click', function () {
      var facts = (JV.memory && JV.memory.facts()) || [];
      toast(facts.length ? facts.map(function (f) { return f.text; }).slice(-4).join(' ｜ ') : '还没有长期记忆', 6000);
    });
    if (memClear) memClear.addEventListener('click', function () {
      if (JV.memory) { JV.memory.clear(); renderMemoryStat(); toast('记忆已清空', 1800); }
    });
    JV.bus.on('memory:changed', renderMemoryStat);

    // 插件
    renderPlugins();
    renderCities();
    JV.bus.on('plugins:changed', function () { renderPlugins(); });

    // 手势灵敏度 / 关闭摄像头
    var gsens = $('jv-set-gsens');
    if (gsens) qsa('button', gsens).forEach(function (b) {
      b.addEventListener('click', function () {
        JV.settings.gestureSensitivity = b.dataset.v; JV.saveSettings();
        qsa('button', gsens).forEach(function (x) { x.classList.toggle('is-on', x === b); });
        toast('手势灵敏度：' + ({ low: '低', mid: '中', high: '高' }[b.dataset.v]), 1600);
      });
    });
    var gstop = $('jv-set-gstop');
    if (gstop) gstop.addEventListener('click', function () {
      if (JV.gesture) { JV.gesture.stop(); toast('已关闭手势摄像头', 1800); }
      hud.setGesture({ enabled: false });
    });

    if (ui.gender) qsa('button', ui.gender).forEach(function (b) {
      b.addEventListener('click', function () {
        var g = b.dataset.v;
        if (JV.voice && JV.voice.setGender) JV.voice.setGender(g);
        syncSettingsUI();
        toast('声音已切换为' + (g === 'male' ? '男声' : '女声'), 1600);
        if (JV.voice) setTimeout(function () { JV.voice.speak('先生，已经换成' + (g === 'male' ? '男声' : '女声') + '了。'); }, 220);
      });
    });
    // 本机权限开关
    var grantMap = { 'jv-grant-system': 'system', 'jv-grant-files': 'files', 'jv-grant-shell': 'shell', 'jv-grant-network': 'network' };
    Object.keys(grantMap).forEach(function (id) {
      var box = $(id);
      if (!box) return;
      if (!JV.settings.grants) JV.settings.grants = {};
      box.checked = JV.settings.grants[grantMap[id]] !== false;
      box.addEventListener('change', function () {
        JV.settings.grants[grantMap[id]] = box.checked;
        JV.saveSettings();
        toast((box.checked ? '已授权：' : '已关闭：') + box.closest('.jv-set-row').querySelector('span').textContent, 1800);
      });
    });
    if (ui.quality) qsa('button', ui.quality).forEach(function (b) {
      b.addEventListener('click', function () {
        JV.settings.quality = b.dataset.v; JV.saveSettings();
        JV.applyQuality(b.dataset.v === 'auto' ? 'high' : b.dataset.v);
        syncSettingsUI();
      });
    });
    function saveLLM() {
      JV.settings.llm = {
        enabled: ui.llm ? ui.llm.checked : false,
        endpoint: ui.endpoint ? ui.endpoint.value.trim() : '',
        model: ui.model ? ui.model.value.trim() : '',
        key: ui.key ? ui.key.value.trim() : ''
      };
      JV.saveSettings();
      if (JV.agent) JV.agent.configure(JV.settings.llm);
    }
    [ui.llm, ui.endpoint, ui.model, ui.key].forEach(function (n) { if (n) n.addEventListener('change', saveLLM); });
    if (ui.llmTest) ui.llmTest.addEventListener('click', function () {
      saveLLM();
      if (!JV.agent) { toast('模块未就绪'); return; }
      ui.llmTest.textContent = '测试中…';
      JV.agent.probe().then(function (r) {
        ui.llmTest.textContent = '测试连接';
        toast(r && r.ok ? '连接成功 · ' + (r.model || '') : '连接失败，已回落本地意图', 3200);
        setLlmStatus(r && r.ok ? (r.via === 'proxy' ? 'proxy' : 'llm') : 'offline', r && r.model);
      });
    });
  }

  /* ------------------------------------------------------------- 手势画布 */
  var handCtx = el.handCanvas ? el.handCanvas.getContext('2d') : null;
  var HAND_COLORS = ['rgba(126,245,207,', 'rgba(255,193,119,'];
  var HAND_CHAINS = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20]];
  function drawHands(list) {
    if (!handCtx) return;
    var c = el.handCanvas, w = c.width, h = c.height;
    handCtx.clearRect(0, 0, w, h);
    handCtx.fillStyle = 'rgba(2,6,4,.92)';
    handCtx.fillRect(0, 0, w, h);
    // 网格 + 安全框
    handCtx.strokeStyle = 'rgba(126,245,207,.09)';
    handCtx.lineWidth = 1;
    for (var i = 1; i < 6; i++) {
      handCtx.beginPath(); handCtx.moveTo(i * w / 6, 0); handCtx.lineTo(i * w / 6, h); handCtx.stroke();
      handCtx.beginPath(); handCtx.moveTo(0, i * h / 6); handCtx.lineTo(w, i * h / 6); handCtx.stroke();
    }
    if (!list || !list.length) {
      handCtx.fillStyle = 'rgba(198,255,239,.35)';
      handCtx.font = '11px -apple-system, "PingFang SC", sans-serif';
      handCtx.textAlign = 'center';
      handCtx.fillText('举起双手 · 转动 / 缩放', w / 2, h / 2 + 4);
      return;
    }
    list.forEach(function (pts, idx) {
      if (!pts) return;
      var col = HAND_COLORS[idx % HAND_COLORS.length];
      // 骨骼连线
      handCtx.strokeStyle = col + '0.62)';
      handCtx.lineWidth = 1.6;
      HAND_CHAINS.forEach(function (ch) {
        handCtx.beginPath();
        ch.forEach(function (k, i) {
          var q = pts[k]; if (!q) return;
          if (i === 0) handCtx.moveTo(q[0] * w, q[1] * h); else handCtx.lineTo(q[0] * w, q[1] * h);
        });
        handCtx.stroke();
      });
      // 关节点
      pts.forEach(function (q, k) {
        var big = (k === 4 || k === 8);
        handCtx.beginPath();
        handCtx.arc(q[0] * w, q[1] * h, big ? 3.2 : 1.9, 0, Math.PI * 2);
        handCtx.fillStyle = col + (big ? '0.98)' : '0.82)');
        handCtx.fill();
      });
      // 手掌中心
      var cx = 0, cy = 0;
      [0, 5, 9, 13, 17].forEach(function (k) { cx += pts[k][0]; cy += pts[k][1]; });
      cx /= 5; cy /= 5;
      handCtx.beginPath();
      handCtx.arc(cx * w, cy * h, 5, 0, Math.PI * 2);
      handCtx.strokeStyle = col + '0.9)';
      handCtx.stroke();
      handCtx.fillStyle = col + '0.35)';
      handCtx.fill();
    });
    // 双手连线（旋转/缩放的"杠杆")
    if (list.length >= 2) {
      var a = list[0], b = list[1];
      function palm(p) { var x = 0, y = 0; [0, 5, 9, 13, 17].forEach(function (k) { x += p[k][0]; y += p[k][1]; }); return [x / 5, y / 5]; }
      var pa = palm(a), pb = palm(b);
      handCtx.beginPath();
      handCtx.moveTo(pa[0] * w, pa[1] * h);
      handCtx.lineTo(pb[0] * w, pb[1] * h);
      handCtx.strokeStyle = 'rgba(185,255,232,.45)';
      handCtx.setLineDash([4, 4]);
      handCtx.stroke();
      handCtx.setLineDash([]);
      handCtx.beginPath();
      handCtx.arc(((pa[0] + pb[0]) / 2) * w, ((pa[1] + pb[1]) / 2) * h, 3, 0, Math.PI * 2);
      handCtx.fillStyle = 'rgba(185,255,232,.8)';
      handCtx.fill();
    }
  }

  /* ------------------------------------------------------------- 输入/发送 */
  function sendText(text) {
    text = (text || '').trim();
    if (!text) return;
    setTranscript({ text: text });
    setSubtitle({ who: 'you', zh: text, en: '', done: true });
    if (el.input) el.input.value = '';
    if (JV.bus) JV.bus.emit('ui:send', { text: text });
  }

  function wireInput() {
    if (el.inputWrap) {
      el.inputWrap.addEventListener('submit', function (e) { e.preventDefault(); sendText(el.input.value); });
    }
    if (el.input) {
      el.input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); sendText(el.input.value); }
        e.stopPropagation();
      });
    }
    if (el.mic) {
      el.mic.addEventListener('click', function () {
        if (JV.bus) JV.bus.emit('ui:mic', {});
      });
    }
    if (el.chips) {
      el.chips.addEventListener('click', function (e) {
        var b = e.target.closest('.jv-chip');
        if (!b) return;
        sendText(b.dataset.q || b.textContent);
      });
    }
    if (el.transcript) {
      el.transcript.addEventListener('click', function () { if (el.input) el.input.focus(); });
    }
    if (el.hint) setTimeout(function () { el.hint.classList.add('is-hidden'); }, 12000);
  }

  /* --------------------------------------------------------------- 对外 API */
  var hud = {
    el: el,
    setScene: setScene,
    setZoom: setZoom,
    setSubtitle: setSubtitle,
    hideSubtitle: hideSubtitle,
    setTranscript: setTranscript,
    setChips: setChips,
    setTasks: setTasks,
    setTaskStatus: setTaskStatus,
    setTaskProgress: setTaskProgress,
    setWeather: setWeather,
    setTravel: setTravel,
    setAgenda: setAgenda,
    addAgenda: addAgenda,
    getAgenda: function () { return agenda.slice(); },
    setMicState: setMicState,
    setLlmStatus: setLlmStatus,
    setGesture: setGesture,
    setToolsStatus: setToolsStatus,
    toast: toast,
    openSettings: openSettings,
    closeSettings: closeSettings,
    toggleVoiceDiag: toggleVoiceDiag,
    sendText: sendText,
    drawHand: drawHands,
    drawHands: drawHands,
    tick: function (t, dt) {
      drawWave(dt);
      var lvl = JV.state.level || 0;
      waveLevel += (lvl - waveLevel) * Math.min(1, dt * 6);
    }
  };

  JV.hud = hud;
  vdInit();
  wireInput();
  wireSettings();
  setChips([
    '今天还有什么安排?',
    '让 Claude Code 把登录页的 bug 修一下',
    '明天天气怎么样?',
    '总结一下今天的工作进度',
    '看看纽约的全息城市'
  ]);
  tickClock();
  setInterval(tickClock, 1000);
  loadWeather();
  setAgenda(agenda, false);
  setTaskProgress(0, 0);
  setMicState('idle');
  setLlmStatus('offline');
  setGesture({ enabled: false });
  setToolsStatus({ available: false });
  JV.onHudTick(function (t, dt, st) {
    hud.tick(t, dt);
    if (el.fps) el.fps.textContent = String(Math.round(JV.fps()));
    if (el.quality) el.quality.textContent = String(JV.quality()).toUpperCase();
  });
  // 场景切换 → 场景名
  JV.bus.on('scene:changed', function (p) { setScene(p.name); });

  JV.bus.on('voice:error', function (p) {
    if (!p) return;
    toast((p.message || '语音不可用') + '（按 V 看语音自检）', 5200);
    setTimeout(function () { toggleVoiceDiag(true); }, 600);
  });

  JV.bus.on('app:ready', function () {
    var r = el.root;
    if (r) r.classList.add('is-live');
  });

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    JV.bus.emit('hud:ready', { hud: hud });
  } else {
    document.addEventListener('DOMContentLoaded', function () { JV.bus.emit('hud:ready', { hud: hud }); });
  }
})();
