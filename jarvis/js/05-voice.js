/* ============================================================================
 * JARVIS 2.0 · 05-voice.js
 * 唤醒词（Hey Jarvis / 贾维斯）/ 连续语音识别 / TTS / 麦克风电平
 * 依赖：JV（00-core.js）；浏览器不支持时静默降级为键盘输入
 * ==========================================================================*/
(function () {
  'use strict';
  var JV = window.JV;
  var U = JV.util;
  var bus = JV.bus;

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  var supported = !!(SR && window.speechSynthesis);

  var voice = {
    supported: supported,
    sttSupported: !!SR,
    ttsSupported: !!window.speechSynthesis,
    enabled: false,
    listening: false,      // 正在听指令
    wakeMode: false,       // 待唤醒常驻
    speaking: false,
    level: 0,
    lastError: '',
    engine: 'none',        // 'webspeech' | 'local' | 'none'（本机离线识别）
    localReady: false,
    localError: ''
  };

  /* ============================================================ 本机离线识别
   * 国内网络访问不到 Chrome 的语音服务（Google），唤醒词会静默失败。
   * 这里接 jarvis/server/asr_vosk.py 的 ws://127.0.0.1:8822：
   *   浏览器采集 16k PCM → 本机 Vosk 识别 → 回传 partial/final 文本
   * 没有启动桥时自动跳过，退回 Web Speech 或键盘。
   * ======================================================================== */
  var CLOUD_CFG = window.JV_CLOUD || {};
  var LOCAL_WS = CLOUD_CFG.asrWs || 'ws://127.0.0.1:8822';
  var localErrorText = '';
  // 指令缓冲：Vosk 在短停顿处会切句，这里合并多段 final，静音 1.2s 后才提交
  var cmdBuf = { text: '', timer: 0, startedAt: 0 };
  function cmdReset() { clearTimeout(cmdBuf.timer); cmdBuf.text = ''; cmdBuf.startedAt = 0; }
  function cmdAppend(t) {
    var piece = String(t || '').replace(/\s+/g, '');
    if (!piece) return;
    if (!cmdBuf.text) cmdBuf.startedAt = Date.now();
    cmdBuf.text = (cmdBuf.text + piece).slice(0, 400);
    clearTimeout(cmdBuf.timer);
    cmdBuf.timer = setTimeout(cmdCommit, 1200);   // 1200ms 静音才算说完
    if (JV.hud) JV.hud.setTranscript({ text: cmdBuf.text });
  }
  function cmdCommit() {
    var text = cmdBuf.text.trim();
    cmdReset();
    if (!text) return;
    voice.listening = false;
    if (JV.hud) JV.hud.setMicState('idle');
    bus.emit('voice:state', { state: 'idle' });
    var split = splitWake(text);
    bus.emit('voice:final', { text: (split.wake && split.rest ? split.rest : text), engine: 'local' });
    voice.lastFinal = text;
  }
  var local = { ws: null, ctx: null, stream: null, node: null, src: null, trying: false, started: false,
                frames: 0, bytes: 0, rms: 0, partials: 0, finals: 0, trackLabel: '', lastSentAt: 0 };

  function probeLocal(timeoutMs) {
    return new Promise(function (resolve) {
      if (location.protocol === 'https:') { resolve(false); return; }   // 混合内容会被浏览器拦截
      if (local.ws && local.ws.readyState === 1) { voice.localReady = true; resolve(true); return; }
      var ws, done = false, timer;
      try { ws = new WebSocket(LOCAL_WS); } catch (e) { resolve(false); return; }
      function finish(ok) {
        if (done) return; done = true;
        clearTimeout(timer);
        voice.localReady = ok;
        if (!ok) { try { ws.close(); } catch (e2) {} }
        else { local.ws = ws; }
        resolve(ok);
      }
      timer = setTimeout(function () { finish(false); }, timeoutMs || 900);
      ws.onopen = function () { finish(true); };
      ws.onerror = function () { finish(false); };
      ws.onclose = function () { finish(false); };
      ws.onopen = function () { finish(true); };
      ws.onmessage = function (ev) { handleLocalMessage(ev.data); };
    });
  }

  function handleLocalMessage(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg) return;
    if (msg.type === 'partial' && msg.text) {
      local.partials++;
      voice.lastPartial = msg.text;
      bus.emit('voice:transcript', { text: msg.text, interim: true });
      if (voice.listening) {
        if (JV.hud) JV.hud.setTranscript({ text: (cmdBuf.text || '') + msg.text });
        if (cmdBuf.text) { clearTimeout(cmdBuf.timer); cmdBuf.timer = setTimeout(cmdCommit, 1200); }
      }
      // 边说边判唤醒（不用等一句话停顿）
      if (!voice.listening) {
        var pv = splitWake(msg.text);
        if (pv.wake && (!pv.rest || pv.rest.length < 2)) {
          var now = U.nowMs();
          if (now - (voice._lastWakeAt || 0) > 2200) {
            voice._lastWakeAt = now;
            bus.emit('voice:wake', { at: now, text: msg.text, engine: 'local', partial: true });
          }
        }
      }
    } else if (msg.type === 'final' && msg.text) {
      local.finals++;
      var text = String(msg.text).replace(/\s+/g, '');
      bus.emit('voice:transcript', { text: text, interim: false });
      var split = splitWake(text);
      if (voice.listening) {
        // 指令模式：先并入缓冲，静音 1.2s 再一次性提交（避免半句被切断）
        cmdAppend(split.wake && split.rest ? split.rest : text);
        clearTimeout(silenceTimer);
      } else if (split.wake) {
        bus.emit('voice:wake', { at: Date.now(), text: text, engine: 'local' });
        if (split.rest && split.rest.length >= 2) {
          cmdAppend(split.rest);          // 「贾维斯，明天天气怎么样」一口气说完
          voice.listening = true;         // 进入指令态，等静音提交
          bus.emit('voice:state', { state: 'listen', engine: 'local' });
          if (JV.hud) { JV.hud.setMicState('listen'); }
        }
      }
    } else if (msg.type === 'error') {
      voice.localError = msg.message || '本机识别错误';
      bus.emit('voice:error', { error: 'local', message: voice.localError });
    } else if (msg.type === 'ready') {
      voice.localReady = true;
    }
  }

  function floatToPcm16(buf) {
    var out = new Int16Array(buf.length);
    for (var i = 0; i < buf.length; i++) {
      var x = Math.max(-1, Math.min(1, buf[i]));
      out[i] = x < 0 ? x * 0x8000 : x * 0x7fff;
    }
    return out;
  }

  function startLocalCapture(deviceId) {
    if (local.started) return Promise.resolve(true);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('浏览器不支持麦克风采集'));
    }
    var audioCfg = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (deviceId) audioCfg.deviceId = { exact: deviceId };
    else if (JV.settings.micId) audioCfg.deviceId = { exact: JV.settings.micId };
    return navigator.mediaDevices.getUserMedia({ audio: audioCfg }).then(function (stream) {
      local.stream = stream;
      var AC = window.AudioContext || window.webkitAudioContext;
      // 让浏览器尽量用 16k 采样（不行就自己重采样）
      try { local.ctx = new AC({ sampleRate: 16000 }); } catch (e) { local.ctx = new AC(); }
      var ctx = local.ctx;
      if (ctx.state === 'suspended' && ctx.resume) { try { ctx.resume(); } catch (e) {} }
      local.src = ctx.createMediaStreamSource(stream);
      local.node = ctx.createScriptProcessor(2048, 1, 1);
      var inRate = ctx.sampleRate || 16000;
      var ratio = inRate / 16000;
      local.trackLabel = (stream.getAudioTracks()[0] && stream.getAudioTracks()[0].label) || '默认麦克风';
      local.src.connect(local.node);
      local.node.connect(ctx.destination);
      local.node.onaudioprocess = function (ev) {
        var input = ev.inputBuffer.getChannelData(0);
        // 实时电平（HUD 麦克风光环 / 波形 / 能量球律动都用它）
        var sum = 0, peak = 0;
        for (var k = 0; k < input.length; k += 4) { var v = input[k]; sum += v * v; if (Math.abs(v) > peak) peak = Math.abs(v); }
        var rms = Math.sqrt(sum / (input.length / 4));
        local.rms = rms;
        var lvl = U.clamp(rms * 6.5, 0, 1);
        voice.level = lvl; JV.state.level = lvl;
        bus.emit('voice:level', { level: lvl });
        if (!local.ws || local.ws.readyState !== 1) return;
        if (voice.speaking) return;   // TTS 期间不送音频，避免回声

        var data = input;
        if (Math.abs(ratio - 1) > 0.01) {
          var n = Math.floor(input.length / ratio);
          data = new Float32Array(n);
          for (var i = 0; i < n; i++) data[i] = input[Math.floor(i * ratio)];
        }
        // 近场增益：小模型对音量敏感，正常说话约 0.02–0.15，放大到 0.1–0.5
        var gain = rms < 0.02 ? 2.6 : rms < 0.06 ? 1.8 : 1.2;
        var scaled = new Float32Array(data.length);
        for (var j = 0; j < data.length; j++) scaled[j] = data[j] * gain;
        var pcm = floatToPcm16(scaled);
        try {
          local.ws.send(pcm.buffer);
          local.frames++; local.bytes += pcm.byteLength; local.lastSentAt = U.nowMs();
          if (local.frames === 12) {
            bus.emit('voice:mic', { state: 'live', label: local.trackLabel });
            if (JV.hud) JV.hud.toast('麦克风已接入 · ' + local.trackLabel, 2600);
          }
        } catch (e) {}
      };
      local.started = true;
      // 有的浏览器 AudioContext 会在后台挂起，定时确认
      setInterval(function () {
        if (!local.started || !local.ctx) return;
        if (local.ctx.state === 'suspended') { try { local.ctx.resume(); } catch (e) {} }
      }, 1500);
      return true;
    });
  }

  function stopLocalCapture() {
    if (local.node) { try { local.node.disconnect(); } catch (e) {} local.node.onaudioprocess = null; local.node = null; }
    if (local.src) { try { local.src.disconnect(); } catch (e) {} local.src = null; }
    if (local.ctx) { try { local.ctx.close(); } catch (e) {} local.ctx = null; }
    if (local.stream) { local.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); local.stream = null; }
    local.started = false;
  }

  var rec = null;
  var recBusy = false;
  var recStartAt = 0;
  var restartTimer = 0;
  var finalText = '';
  var silenceTimer = 0;
  var audioCtx = null, analyser = null, micStream = null, levelRAF = 0;
  var ttsPulse = 0, ttsRAF = 0;

  /* -------------------------------------------------------------- 语音识别 */
  function buildRecognition() {
    if (!SR) return null;
    var r = new SR();
    r.lang = 'zh-CN';
    r.continuous = false;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onstart = function () {
      recBusy = true;
      recStartAt = Date.now();
    };

    r.onresult = function (ev) {
      var interim = '', final = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var res = ev.results[i];
        if (res.isFinal) final += res[0].transcript;
        else interim += res[0].transcript;
      }
      if (interim) {
        bus.emit('voice:transcript', { text: interim, interim: true });
        if (voice.listening) JV.hud && JV.hud.setTranscript({ text: interim });
      }
      if (final) {
        finalText = (finalText + ' ' + final).trim();
        bus.emit('voice:transcript', { text: finalText, interim: false });
        if (voice.listening) {
          clearTimeout(silenceTimer);
          silenceTimer = setTimeout(function () { stopListening(true); }, 260);
        } else {
          // 唤醒模式：命中唤醒词
          if (matchWake(finalText)) {
            bus.emit('voice:wake', { at: Date.now(), text: finalText });
            finalText = '';
          }
        }
      }
    };

    r.onerror = function (ev) {
      recBusy = false;
      voice.lastError = ev.error || 'unknown';
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        voice.enabled = false;
        bus.emit('voice:error', { error: 'not-allowed', message: '麦克风权限被拒绝' });
        if (JV.hud) JV.hud.toast('麦克风权限被拒绝，已切换为键盘输入');
        stopAll();
      } else if (ev.error === 'no-speech' || ev.error === 'aborted') {
        // 静默重试
      } else if (ev.error === 'network') {
        bus.emit('voice:error', { error: 'network', message: '语音识别服务不可达（需要联网）' });
        if (JV.hud) JV.hud.toast('语音服务不可达，可用键盘输入');
        voice.enabled = false;
        stopAll();
      }
    };

    r.onend = function () {
      recBusy = false;
      if (voice.listening && !finalText) {
        // 用户没说话就结束了，回到待唤醒
        stopListening(false);
      }
      if (voice.wakeMode && !voice.listening) scheduleRestart(500);
    };
    return r;
  }

  // 唤醒词：英文路径 + 中文（本机小模型对「贾维斯」的多种音译变体）
  var WAKE_RE = /(?:hey|hi)?\s*jarvis|贾维斯|加维斯|佳维思|家维斯|假维斯|(?:贾|加|家|佳|假|甲|夹|下|盔甲|嘿|嗨)?\s*(?:维|伟|为|微|威|韦|惟)\s*(?:斯|思|师|丝|寺|私)/;
  function matchWake(text) {
    if (!text) return false;
    var t = String(text).toLowerCase().replace(/\s+/g, ' ').replace(/[，。！？,.!?]/g, '');
    return WAKE_RE.test(t);
  }
  // 从一句话里剥掉唤醒词，剩下的就是指令（支持「贾维斯，明天天气怎么样」一口气说完）
  function splitWake(text) {
    var t = String(text || '').replace(/\s+/g, '').replace(/[，。！？,.!?]/g, '');
    var m = t.match(WAKE_RE);
    if (!m) return { wake: false, rest: t };
    var rest = (t.slice(0, m.index) + t.slice(m.index + m[0].length)).replace(/^(你好|您好|在吗|听得到吗)/, '');
    return { wake: true, rest: rest };
  }

  function scheduleRestart(ms) {
    clearTimeout(restartTimer);
    if (!voice.enabled) return;
    restartTimer = setTimeout(function () {
      if (!voice.enabled || voice.listening) return;
      startWake();
    }, ms || 500);
  }

  function startWake() {
    if (!voice.enabled || !SR || voice.listening) return;
    voice.wakeMode = true;
    if (recBusy) return;
    try {
      if (!rec) rec = buildRecognition();
      rec.continuous = true;
      rec.interimResults = false;
      finalText = '';
      rec.start();
      bus.emit('voice:state', { state: 'idle', wake: true });
    } catch (e) {
      // InvalidStateError：已在运行
    }
  }

  function startListening() {
    if (voice.engine === 'local' && voice.localReady) {
      if (voice.listening) return true;
      voice.listening = true;
      finalText = '';
      cmdReset();
      bus.emit('voice:state', { state: 'listen', engine: 'local' });
      if (JV.hud) { JV.hud.setMicState('listen'); JV.hud.setTranscript({ text: '' }); }
      // 9 秒没说完就结束
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(function () {
        if (voice.listening) { voice.listening = false; bus.emit('voice:state', { state: 'idle' }); if (JV.hud) JV.hud.setMicState('idle'); }
      }, 20000);
      return true;
    }
    if (!voice.enabled || !SR) {
      if (JV.hud) JV.hud.setMicState('idle');
      bus.emit('voice:unsupported', {});
      return false;
    }
    if (voice.listening) return true;
    voice.listening = true;
    voice.wakeMode = false;
    finalText = '';
    clearTimeout(restartTimer);
    try {
      if (recBusy) { try { rec.stop(); } catch (e) {} }
      setTimeout(function () {
        try {
          if (!rec) rec = buildRecognition();
          rec.continuous = false;
          rec.interimResults = true;
          rec.start();
        } catch (e) {
          voice.listening = false;
          if (JV.hud) JV.hud.setMicState('idle');
        }
      }, recBusy ? 220 : 0);
    } catch (e) {}
    startMicLevel();
    bus.emit('voice:state', { state: 'listen' });
    if (JV.hud) JV.hud.setMicState('listen');
    setStatus('listen');
    return true;
  }

  var statusTimer = 0;
  function setStatus(state) {
    JV.state.mode = state;
    clearTimeout(statusTimer);
    if (state === 'listen') {
      // 8 秒无语音自动结束
      statusTimer = setTimeout(function () {
        if (voice.listening && !finalText) stopListening(false);
      }, 9000);
    }
  }

  function stopListening(process) {
    if (voice.engine === 'local') {
      clearTimeout(silenceTimer);
      voice.listening = false;
      bus.emit('voice:state', { state: 'idle' });
      if (JV.hud) JV.hud.setMicState('idle');
      return;
    }
    clearTimeout(silenceTimer);
    clearTimeout(statusTimer);
    var text = finalText.trim();
    voice.listening = false;
    finalText = '';
    try { if (rec && recBusy) rec.stop(); } catch (e) {}
    stopMicLevel();
    bus.emit('voice:state', { state: 'idle' });
    if (JV.hud) JV.hud.setMicState('idle');
    if (process && text) {
      bus.emit('voice:final', { text: text });
    }
    if (voice.enabled) scheduleRestart(700);
  }

  function stopAll() {
    clearTimeout(restartTimer);
    clearTimeout(silenceTimer);
    clearTimeout(statusTimer);
    voice.listening = false;
    voice.wakeMode = false;
    finalText = '';
    try { if (rec) rec.abort(); } catch (e) {}
    recBusy = false;
    stopMicLevel();
    bus.emit('voice:state', { state: 'idle' });
    if (JV.hud) JV.hud.setMicState('idle');
  }

  /* --------------------------------------------------------------- 电平 */
  function startMicLevel() {
    if (micStream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      micStream = stream;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = new AC();
      var src = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.75;
      src.connect(analyser);
      var data = new Uint8Array(analyser.frequencyBinCount);
      var smooth = 0;
      function loop() {
        levelRAF = requestAnimationFrame(loop);
        analyser.getByteFrequencyData(data);
        var sum = 0;
        for (var i = 0; i < data.length; i++) sum += data[i];
        var avg = sum / data.length / 255;
        smooth += (avg - smooth) * 0.22;
        var lvl = U.clamp(smooth * 2.6, 0, 1);
        voice.level = lvl;
        JV.state.level = lvl;
        bus.emit('voice:level', { level: lvl });
      }
      loop();
    }).catch(function () { /* 无麦克风 */ });
  }
  function stopMicLevel() {
    if (levelRAF) cancelAnimationFrame(levelRAF);
    levelRAF = 0;
    if (micStream) { micStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); micStream = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
    analyser = null;
    voice.level = 0; JV.state.level = 0;
    bus.emit('voice:level', { level: 0 });
  }

  /* ----------------------------------------------------------------- TTS */
  var preferredVoice = null;
  // 男声优先（管家感），其次才是任意中文声
  var MALE_HINTS = /Reed|Eddy|Rocko|Grandpa|Li-mu|Limu|Yu-shu|Yushu|Kangkang|Yunxi|Yunjian|male|男/i;
  var FEMALE_HINTS = /Tingting|Meijia|Sinji|Sandy|Flo|Shelley|Grandma|Xiaoxiao|Xiaoyi|Huihui|Yaoyao|female|女/i;
  function pickVoice(gender) {
    if (!window.speechSynthesis) return null;
    var g = gender || (JV.settings.voiceGender || 'male');
    var vs = window.speechSynthesis.getVoices() || [];
    if (!vs.length) return null;
    var zh = vs.filter(function (v) { return /zh|Chinese/i.test(v.lang + ' ' + v.name); });
    if (!zh.length) return null;
    // 音色偏好顺序（macOS 内置）：男声 Reed（最像管家）> Rocko > Eddy > Grandpa；
    // 女声 Tingting（婷婷，最自然）> Meijia > Sandy > Flo > Shelley
    var MALES = [/^\s*Reed/i, /^\s*Rocko/i, /^\s*Eddy/i, /^\s*Grandpa/i, /Li-?mu|Yu-?shu|Kangkang/i];
    var FEMALES = [/Tingting|婷婷/i, /Meijia|美佳/i, /Sandy/i, /Sinji|善怡/i, /Flo/i, /Shelley/i, /Grandma/i];
    var ranked = g === 'male' ? MALES : FEMALES;
    var zhCN = zh.filter(function (v) { return /zh_CN|zh-CN/i.test(v.lang); });
    var pool = zhCN.length ? zhCN : zh;
    for (var i = 0; i < ranked.length; i++) {
      var hit = pool.filter(function (v) { return ranked[i].test(v.name); })[0];
      if (hit) { preferredVoice = hit; return hit; }
    }
    preferredVoice = pool[0];
    return preferredVoice;
  }

  function speak(text, opts) {
    opts = opts || {};
    if (!voice.enabled || !window.speechSynthesis || !text) return false;
    var clean = String(text).replace(/[|｜]/g, '，').replace(/⟨[^⟩]*⟩/g, '').replace(/[A-Za-z]{4,}/g, function (m) {
      // 英文行不读，避免中英混读打断
      return '';
    }).trim();
    if (!clean) return false;
    try {
      window.speechSynthesis.cancel();
      var utter = new SpeechSynthesisUtterance(clean);
      var gender = JV.settings.voiceGender || 'male';
      var v = (preferredVoice && preferredVoice.__gender === gender) ? preferredVoice : pickVoice(gender);
      if (v) { v.__gender = gender; utter.voice = v; }
      utter.lang = v && v.lang ? v.lang : 'zh-CN';
      utter.rate = opts.rate || (gender === 'male' ? 0.96 : 1.0);
      utter.pitch = opts.pitch || (gender === 'male' ? 0.72 : 1.02);
      utter.volume = 1;
      utter.onstart = function () {
        voice.speaking = true;
        bus.emit('voice:state', { state: 'speak' });
        if (JV.hud) JV.hud.setMicState('speak');
        startTtsPulse();
      };
      utter.onend = function () {
        voice.speaking = false;
        stopTtsPulse();
        bus.emit('voice:state', { state: 'idle' });
        if (JV.hud) JV.hud.setMicState('idle');
      };
      utter.onerror = function () { voice.speaking = false; stopTtsPulse(); };
      window.speechSynthesis.speak(utter);
      return true;
    } catch (e) { return false; }
  }

  function startTtsPulse() {
    stopTtsPulse();
    var t0 = U.nowMs();
    function loop() {
      ttsRAF = requestAnimationFrame(loop);
      var t = (U.nowMs() - t0) / 1000;
      var lvl = 0.32 + Math.sin(t * 7.4) * 0.14 + Math.sin(t * 3.1 + 1.2) * 0.1 + Math.random() * 0.06;
      lvl = U.clamp(lvl, 0.08, 0.85);
      voice.level = lvl; JV.state.level = lvl;
      bus.emit('voice:level', { level: lvl });
    }
    loop();
  }
  function stopTtsPulse() {
    if (ttsRAF) cancelAnimationFrame(ttsRAF);
    ttsRAF = 0;
    window.setTimeout(function () {
      if (!voice.speaking) { voice.level = 0; JV.state.level = 0; bus.emit('voice:level', { level: 0 }); }
    }, 120);
  }

  function stopSpeak() {
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
    voice.speaking = false;
    stopTtsPulse();
  }

  /* ---------------------------------------------------------------- 开关 */
  function enable(force) {
    voice.enabled = true;
    JV.settings.voice = true; JV.saveSettings();
    if (voice.engine === 'local' && voice.localReady) return;
    if (JV.hud) JV.hud.setMicState('idle');
    // 1) 先探本机离线识别（国内网络最可靠）
    probeLocal(900).then(function (ok) {
      if (ok) {
        voice.engine = 'local';
        bus.emit('voice:engine', { engine: 'local', ready: true });
        if (JV.hud) JV.hud.toast('语音引擎：本机离线识别（Vosk）', 2600);
        return startLocalCapture().then(function () {
          voice.wakeMode = true;
          bus.emit('voice:state', { state: 'idle', wake: true, engine: 'local' });
        });
      }
      // 2) 退回浏览器识别
      if (!supported) {
        voice.engine = 'none';
        bus.emit('voice:error', {
          error: 'unsupported',
          message: '本机语音桥未启动，且当前浏览器不支持语音识别。可双击 启动Jarvis.command，或直接用键盘输入。'
        });
        if (JV.hud) JV.hud.toast('语音不可用：请双击 启动Jarvis.command（本机识别）或改用键盘', 5200);
        return;
      }
      voice.engine = 'webspeech';
      bus.emit('voice:engine', { engine: 'webspeech', ready: true });
      startWake();
    }).catch(function (err) {
      voice.localError = (err && err.message) || '本机语音启动失败';
      bus.emit('voice:error', { error: 'local', message: voice.localError });
      if (JV.hud) JV.hud.toast('麦克风不可用：' + voice.localError, 4200);
    });
  }
  function disable() {
    voice.enabled = false;
    JV.settings.voice = false; JV.saveSettings();
    stopAll();
    stopLocalCapture();
    stopSpeak();
    voice.engine = 'none';
    bus.emit('voice:engine', { engine: 'none', ready: false });
  }

  var api = {
    supported: supported,
    sttSupported: !!SR,
    ttsSupported: !!window.speechSynthesis,
    enable: enable,
    disable: disable,
    splitWake: splitWake,
    setGender: function (g) {
      JV.settings.voiceGender = (g === 'female' ? 'female' : 'male');
      JV.saveSettings();
      preferredVoice = null;
      pickVoice(JV.settings.voiceGender);
      return JV.settings.voiceGender;
    },
    voiceName: function () { var v = preferredVoice || pickVoice(); return v ? v.name : ''; },
    diag: function () {
      var tr = local.stream && local.stream.getAudioTracks ? local.stream.getAudioTracks()[0] : null;
      return {
        engine: voice.engine, enabled: voice.enabled, listening: voice.listening,
        localReady: voice.localReady, ws: local.ws ? local.ws.readyState : -1,
        ctxState: local.ctx ? local.ctx.state : 'none', sampleRate: local.ctx ? local.ctx.sampleRate : 0,
        track: tr ? { label: tr.label, muted: tr.muted, enabled: tr.enabled, readyState: tr.readyState } : null,
        frames: local.frames, bytes: local.bytes, rms: Math.round(local.rms * 1000) / 1000,
        partials: local.partials, finals: local.finals,
        lastPartial: voice.lastPartial || '', lastFinal: voice.lastFinal || '',
        lastError: voice.lastError || localErrorText
      };
    },
    listMics: function () {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return Promise.resolve([]);
      return navigator.mediaDevices.enumerateDevices().then(function (list) {
        return list.filter(function (d) { return d.kind === 'audioinput'; })
          .map(function (d) { return { id: d.deviceId, label: d.label || '麦克风' }; });
      });
    },
    useMic: function (deviceId) {
      JV.settings.micId = deviceId; JV.saveSettings();
      stopLocalCapture();
      return startLocalCapture(deviceId);
    },
    reconnect: function () {
      stopLocalCapture();
      voice.engine = 'none'; voice.localReady = false;
      local.ws && local.ws.close && local.ws.close();
      local.ws = null;
      return enable(true);
    },
    _onLocalMessage: handleLocalMessage,
    start: function () { return startListening(); },
    stop: function () { stopListening(false); },
    wake: function () { bus.emit('voice:wake', { at: Date.now() }); },
    speak: speak,
    stopSpeak: stopSpeak,
    isListening: function () { return voice.listening; },
    isEnabled: function () { return voice.enabled; },
    state: function () { return voice.listening ? 'listen' : voice.speaking ? 'speak' : 'idle'; },
    level: function () { return voice.level; },
    status: function () { return voice; },
    engine: function () { return voice.engine; },
    probeLocal: probeLocal,
    enableLocal: function () { return probeLocal(1200).then(function (ok) { if (ok) voice.engine = 'local'; return ok; }); }
  };

  JV.voice = api;

  // 语音最终结果 → 交给 boot / agent 处理
  bus.on('voice:final', function (p) {
    if (JV.hud) {
      JV.hud.setTranscript({ text: p.text });
      JV.hud.setSubtitle({ who: 'you', zh: p.text, en: '', done: true });
    }
    bus.emit('ui:send', { text: p.text, from: 'voice' });
  });

  // 唤醒 → 开始听指令
  bus.on('voice:wake', function () {
    if (JV.hud) JV.hud.toast('贾维斯在听，先生', 1600);
    if (voice.listening) return;
    setTimeout(function () { startListening(); }, 120);
  });
})();
