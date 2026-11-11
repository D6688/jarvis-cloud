/* ============================================================================
 * JARVIS 2.0 · 06-gesture.js
 * 摄像头手势：MediaPipe Hands（CDN 动态加载）→ 张开/握拳/捏合/指向 + 位置
 * 失败或未授权时自动降级为鼠标拖拽（由 scene 自行处理 mouse 事件）
 * 依赖：JV（00-core.js）
 * ==========================================================================*/
(function () {
  'use strict';
  var JV = window.JV;
  var U = JV.util;
  var bus = JV.bus;

  // 单文件内联模式：资源以 base64 放进 HTML（__JV_MP_ASSETS），转成 blob: URL 给 MediaPipe
  var MP_INLINE = (typeof window !== 'undefined' && window.__JV_MP_ASSETS) || null;
  var mpBlobCache = {};
  function inlineBlob(name) {
    if (!MP_INLINE || !MP_INLINE[name]) return null;
    if (mpBlobCache[name]) return mpBlobCache[name];
    try {
      var b64 = MP_INLINE[name];
      var bin = atob(b64);
      var len = bin.length;
      var bytes = new Uint8Array(len);
      for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
      var type = /\.wasm$/.test(name) ? 'application/wasm'
        : /\.js$/.test(name) ? 'text/javascript'
        : /\.json$/.test(name) ? 'application/json' : 'application/octet-stream';
      var url = URL.createObjectURL(new Blob([bytes], { type: type }));
      mpBlobCache[name] = url;
      return url;
    } catch (e) { return null; }
  }

  var MP_VERSION = '0.4.1675469240';
  // 本地资源候选路径：单文件在仓库根时会走 jarvis/vendor/...；服务版走 vendor/...
  var MP_LOCAL_LIST = ['vendor/mediapipe/', 'jarvis/vendor/mediapipe/'];
  var MP_LOCAL = 'vendor/mediapipe/';
  var MP_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@' + MP_VERSION + '/';
  var mpBase = '';   // 实际使用的基础路径（本地或 CDN）

  var gesture = {
    supported: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    enabled: false,
    ready: false,
    loading: false,
    error: '',
    mode: 'idle',
    count: 0,
    last: null
  };
  // 诊断计数器：定位「没反应」到底卡在哪一步
  var diag = {
    stage: 'idle',        // idle → script → camera → hands → streaming → running
    scriptLoaded: false, handsCtor: false, framesSent: 0, results: 0, resultsWithHands: 0,
    videoReady: 0, videoW: 0, videoH: 0, videoPaused: true, lastResultAt: 0, lastError: '',
    startedAt: 0, lastFrameAt: 0, mpSource: ''
  };

  var video = null, stream = null, hands = null, rafId = 0, lastSend = 0, sending = false;
  var drag = { active: false, x: 0, y: 0 };
  var openFrames = 0, fistFrames = 0;

  function ensureVideo() {
    if (video) return video;
    video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:-10px;';
    document.body.appendChild(video);
    return video;
  }

  function loadScript(src, noCross) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[data-jv-src="' + src + '"]')) { resolve(); return; }
      var el = document.createElement('script');
      el.src = src;
      if (!noCross) el.crossOrigin = 'anonymous';
      el.dataset.jvSrc = src;
      el.onload = function () { resolve(src); };
      el.onerror = function () { reject(new Error('load failed: ' + src)); };
      document.head.appendChild(el);
    });
  }
  // 先试本地（离线可用，多个候选路径），都失败再回 CDN
  function loadMediaPipe() {
    if (MP_INLINE && window.Hands) {
      mpBase = 'inline';
      diag.mpSource = 'inline';
      return Promise.resolve('inline');
    }
    var i = 0;
    function tryLocal() {
      if (i >= MP_LOCAL_LIST.length) return Promise.reject(new Error('no local mediapipe'));
      var base = MP_LOCAL_LIST[i++];
      return loadScript(base + 'hands.js', true).then(function () {
        mpBase = base;
        diag.mpSource = 'local:' + base;
        return base + 'hands.js';
      }).catch(tryLocal);
    }
    return tryLocal().catch(function () {
      var cdn = MP_CDN + 'hands.js';
      return loadScript(cdn).then(function () {
        mpBase = MP_CDN;
        diag.mpSource = 'cdn';
        return cdn;
      });
    });
  }

  function emitState() {
    bus.emit('gesture:state', {
      enabled: gesture.enabled,
      ready: gesture.ready,
      mode: gesture.mode,
      count: gesture.count,
      error: gesture.error
    });
  }

  function dist(a, b) {
    var dx = a[0] - b[0], dy = a[1] - b[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* ==========================================================================
   * 手势解析：MediaPipe Hands 21 点 → 旋转 / 缩放 / 滚转 / 平移
   * --------------------------------------------------------------------------
   * 采用「抓取-变换」（grab & transform）模型：
   *   手进入画面时记录锚点（双手中点 / 双手跨距 / 连线角度 / 单手位置与手掌大小），
   *   之后所有输出都相对锚点计算「绝对目标值」，而不是逐帧累加增量。
   *   好处：可逆、无漂移、松手不跳、来回转不会粘住。
   *
   * 双手：中点位移 → 旋转（水平=偏航，垂直=俯仰）
   *       双手跨距变化 → 缩放
   *       双手连线转动 → 滚转（画面翻转/倾斜）
   * 单手：手掌位置 → 旋转；手掌离镜头远近（手掌尺寸）→ 缩放
   * ======================================================================== */
  var GA = { active: false, hands: 0, anchor: null, base: null, mode: 'idle', lastAt: 0, lostAt: 0 };

  function sens() {                     // 灵敏度系数：低 0.6 / 中 1 / 高 1.6
    var v = JV.settings.gestureSensitivity || 'mid';
    return v === 'low' ? 0.62 : v === 'high' ? 1.6 : 1.0;
  }
  function handSize(p) { return Math.max(0.02, Math.hypot(p[9][0] - p[0][0], p[9][1] - p[0][1])); }
  function palmCenter(p) {
    var ids = [0, 5, 9, 13, 17], x = 0, y = 0;
    ids.forEach(function (i) { x += p[i][0]; y += p[i][1]; });
    return [x / ids.length, y / ids.length];
  }
  function pinchRatio(p) {
    return Math.hypot(p[4][0] - p[8][0], p[4][1] - p[8][1]) / handSize(p);
  }
  function extendedCount(p) {
    var palm = p[0], tips = [4, 8, 12, 16, 20], pips = [3, 6, 10, 14, 18], n = 0;
    for (var i = 0; i < tips.length; i++) {
      var dt = Math.hypot(p[tips[i]][0] - palm[0], p[tips[i]][1] - palm[1]);
      var dp = Math.hypot(p[pips[i]][0] - palm[0], p[pips[i]][1] - palm[1]);
      if (dt > dp * 1.16) n++;
    }
    return n;
  }

  function metrics(list) {
    if (list.length >= 2) {
      var a = list[0], b = list[1];
      var mid = [(a[0][0] + b[0][0]) / 2, (a[0][1] + b[0][1]) / 2];
      var span = Math.hypot(a[0][0] - b[0][0], a[0][1] - b[0][1]) / ((handSize(a) + handSize(b)) / 2);
      var ang = Math.atan2(b[0][1] - a[0][1], b[0][0] - a[0][0]);
      var pinch = Math.min(pinchRatio(a), pinchRatio(b));
      return { mid: mid, span: span, ang: ang, hs: (handSize(a) + handSize(b)) / 2, pinch: pinch, mode: pinch < 0.34 ? 'two-pinch' : 'two-grab' };
    }
    var p = list[0];
    var pr = pinchRatio(p);
    return { mid: palmCenter(p), span: handSize(p), ang: 0, hs: handSize(p), pinch: pr,
             mode: pr < 0.42 ? 'one-pinch' : (extendedCount(p) >= 4 ? 'one-open' : 'one-move') };
  }

  function readState() {
    return {
      rotY: JV.state.rotY || 0, rotX: JV.state.rotX || 0, roll: JV.state.roll || 0,
      zoom: JV.state.zoom || 1, panX: JV.state.panX || 0, panY: JV.state.panY || 0
    };
  }

  var ANCHOR_GRACE = 900;   // 丢手 0.9s 内保留锚点，避免检测抖动导致"每次重新抓取"而不跟手
  function beginAnchor(list) {
    GA.anchor = metrics(list);
    GA.base = readState();
    GA.hands = list.length;
    GA.active = true;
    bus.emit('gesture:anchor', { mode: GA.anchor.mode, hands: list.length });
  }

  var lastEmit = null;
  function applyHands(list) {
    if (!list || !list.length) {
      // 手离开：保留当前姿态（不跳变）。锚点先保留 0.9s，防止检测抖动把"抓取基线"不停重置
      GA.active = false; GA.mode = 'idle';   // 注意：GA.hands 保留，避免"手数变化"被误判
      GA.lostAt = U.nowMs() || 1;
      if (JV.hud && JV.hud.drawHands) JV.hud.drawHands(null);
      bus.emit('gesture:hand', null);
      bus.emit('gesture:transform', { mode: 'idle', hands: 0, idle: true });
      return;
    }
    var stale = !GA.anchor || (GA.lostAt && (U.nowMs() - GA.lostAt) > ANCHOR_GRACE);
    // 只在「没有锚点 / 丢手超过 0.9s / 手数变化」时重新抓取；单帧丢失不再重置基线
    if (stale || GA.hands !== list.length) beginAnchor(list);
    GA.active = true;
    GA.lostAt = 0;
    var m = metrics(list);
    var k = sens();
    var out = { mode: m.mode, hands: list.length, pinch: m.pinch };
    if (list.length >= 2) {
      out.rotY = GA.base.rotY + (m.mid[0] - GA.anchor.mid[0]) * 3.6 * k;   // 双手整体左右 → 偏航（可连续转）
      out.rotX = GA.base.rotX + (m.mid[1] - GA.anchor.mid[1]) * 2.4 * k;   // 上下 → 俯仰
      out.roll = GA.base.roll + (m.ang - GA.anchor.ang) * 1.2 * k;          // 连线转动 → 滚转（翻转/侧倾）
      out.zoom = GA.base.zoom * (m.span / Math.max(0.001, GA.anchor.span));// 拉开 → 放大
      // 双手同时捏合：缩略前先提一下（更容易"抓住"）
      if (m.pinch < 0.34 && GA.anchor.pinch < 0.34) out.zoom = GA.base.zoom * 0.96 + out.zoom * 0.04;
      out.panX = GA.base.panX + (m.mid[0] - GA.anchor.mid[0]) * 1.2 * k;
      out.panY = GA.base.panY - (m.mid[1] - GA.anchor.mid[1]) * 1.2 * k;
    } else {
      out.rotY = GA.base.rotY + (m.mid[0] - GA.anchor.mid[0]) * 3.0 * k;   // 单手移动 → 旋转
      out.rotX = GA.base.rotX + (m.mid[1] - GA.anchor.mid[1]) * 2.0 * k;
      out.zoom = GA.base.zoom * (m.span / Math.max(0.001, GA.anchor.span)); // 手掌变大(靠近) → 放大
      out.roll = GA.base.roll;
      out.panX = GA.base.panX;
      out.panY = GA.base.panY;
    }
    // 限幅：偏航可连续翻转（±4π），俯仰 ±1.15，滚转 ±1.25，缩放 0.55–2.6
    var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
    out.rotY = clamp(out.rotY, -12.56, 12.56);
    out.rotX = clamp(out.rotX, -1.15, 1.15);
    out.roll = clamp(out.roll, -1.25, 1.25);
    out.zoom = clamp(out.zoom, 0.55, 2.6);
    out.panX = clamp(out.panX, -2.6, 2.6);
    out.panY = clamp(out.panY, -1.6, 1.6);
    out.absolute = true;     // 关键：绝对目标值，不是增量
    lastEmit = out;
    GA.mode = m.mode; GA.lastAt = U.nowMs();

    var p0 = list[0];
    var pts = p0.map(function (q) { return [q[0], q[1]]; });
    bus.emit('gesture:hand', {
      points: pts, x: palmCenter(p0)[0], y: palmCenter(p0)[1],
      open: extendedCount(p0) >= 4, fist: extendedCount(p0) <= 1,
      extended: extendedCount(p0), mode: m.mode, count: list.length
    });
    if (JV.hud && JV.hud.drawHands) JV.hud.drawHands(list.map(function (h) { return h.map(function (q) { return [q[0], q[1]]; }); }));
    bus.emit('gesture:transform', out);
  }

  function onResults(results) {
    if (!gesture.enabled && !gesture.demo && !gesture.inject) return;
    diag.results++; diag.lastResultAt = U.nowMs(); diag.stage = 'running';
    if (results && results.multiHandLandmarks && results.multiHandLandmarks.length) diag.resultsWithHands++;
    try {
    var lms = results.multiHandLandmarks;
    if (!lms || !lms.length) {
      gesture.count = 0; gesture.mode = 'idle';
      gesture._twoBase = 0; gesture._pinchBase = 0; gesture._handBase = 0;
      applyHands(null);
      bus.emit('gesture:state', { enabled: gesture.enabled, ready: gesture.ready, mode: 'idle', count: 0 });
      return;
    }
    // 镜像 x（自拍视角）
    var list = lms.map(function (h) { return h.map(function (q) { return [1 - q.x, q.y]; }); });
    gesture.count = list.length;
    gesture.mode = list.length >= 2 ? 'two-hand' : 'one-hand';
    applyHands(list);
    gesture.last = lastEmit;
    bus.emit('gesture:state', { enabled: gesture.enabled, ready: gesture.ready, mode: (lastEmit && lastEmit.mode) || 'idle', count: list.length });
    } catch (err) {
      // 任何异常都不能让 MediaPipe 的 send() 失败（否则整条管线会静默死掉）
      diag.lastError = 'pose: ' + ((err && err.message) || err);
      console.error('[gesture] onResults 异常：', err);
    }
  }

  /* --------------------------------------------------- 合成手势演示（无摄像头） */
  // 用 21 点模板生成一只手：pos 掌心位置、scale 手大小、angle 手腕朝向、pinch 捏合程度
  function synthHand(pos, scale, angle, pinch) {
    var base = [
      [0, 0], [-0.10, -0.10], [-0.16, -0.20], [-0.20, -0.28], [-0.24, -0.34],
      [-0.06, -0.20], [-0.10, -0.36], [-0.12, -0.46], [-0.14, -0.54],
      [0.00, -0.22], [0.00, -0.42], [0.00, -0.54], [0.00, -0.64],
      [0.06, -0.20], [0.10, -0.38], [0.12, -0.48], [0.14, -0.56],
      [0.11, -0.16], [0.17, -0.30], [0.20, -0.38], [0.23, -0.44]
    ];
    var cos = Math.cos(angle), sin = Math.sin(angle);
    return base.map(function (p, i) {
      var x = p[0], y = p[1];
      if (pinch > 0) {
        if (i === 4 || i === 3) { x += (0.10 - x) * pinch * 0.9; y += (-0.16 - y) * pinch * 0.9; }
        if (i === 8 || i === 7) { x += (0.10 - x) * pinch * 0.5; y += (-0.20 - y) * pinch * 0.5; }
      }
      var rx = x * cos - y * sin, ry = x * sin + y * cos;
      return [U.clamp(pos[0] + rx * scale, 0, 1), U.clamp(pos[1] + ry * scale, 0, 1)];
    });
  }

  gesture.demo = false;
  function demoRun(kind) {
    gesture.demo = true;
    gesture.enabled = true;
    var t0 = U.nowMs();
    function tick() {
      if (!gesture.demo) return;
      var t = (U.nowMs() - t0) / 1000;
      var hands;
      if (kind === 'rotate') {
        var ox = 0.5 + Math.sin(t * 0.9) * 0.16;
        var ang = Math.sin(t * 0.7) * 0.7;
        hands = [synthHand([ox - 0.16, 0.52], 1.5, ang, 0), synthHand([ox + 0.16, 0.52], 1.5, -ang, 0)];
      } else if (kind === 'zoom') {
        var d = 0.14 + Math.abs(Math.sin(t * 0.8)) * 0.22;
        hands = [synthHand([0.5 - d, 0.55], 1.4, 0, 0), synthHand([0.5 + d, 0.55], 1.4, 0, 0)];
      } else { // mix：左右平移（旋转）+ 双手拉开（缩放）+ 连线转动（滚转）
        var ox = 0.5 + Math.sin(t * 0.55) * 0.17;
        var oy = 0.55 + Math.sin(t * 0.4) * 0.1;
        var ang2 = Math.sin(t * 0.9) * 0.75;
        var dd = 0.13 + ((Math.sin(t * 0.7) + 1) / 2) * 0.22;
        hands = [synthHand([ox - dd, oy], 1.4, ang2, 0),
                 synthHand([ox + dd, oy], 1.4, -ang2, 0)];
      }
      applyHands(hands);
      requestAnimationFrame(tick);
    }
    tick();
    if (JV.hud) JV.hud.toast('手势演示：' + (kind === 'rotate' ? '转动' : kind === 'zoom' ? '缩放' : '混合'), 2600);
  }
  function demoStop() { gesture.demo = false; gesture.enabled = false; applyHands(null); }

  function frameLoop() {
    if (!gesture.enabled) return;
    rafId = requestAnimationFrame(frameLoop);
    if (!hands || !video || video.readyState < 2) return;
    var now = U.nowMs();
    if (now - lastSend < 33) return; // 30fps
    lastSend = now;
    // 关键：MediaPipe legacy send() 不能重入 —— 上一次没结束就不要再送，否则 wasm 会 abort
    if (sending) return;
    sending = true;
    try {
      diag.framesSent++; diag.lastFrameAt = now;
      diag.videoReady = video.readyState; diag.videoW = video.videoWidth; diag.videoH = video.videoHeight;
      diag.videoPaused = video.paused;
      var p = hands.send({ image: video });
      if (p && p.then) {
        p.then(function () { sending = false; })
         .catch(function (e) { sending = false; diag.lastError = 'send: ' + (e && e.message || e); });
      } else { sending = false; }
    } catch (e) { sending = false; diag.lastError = 'send: ' + (e && e.message || e); }
  }

  function fail(msg) {
    gesture.error = msg;
    gesture.enabled = false;
    gesture.ready = false;
    gesture.loading = false;
    diag.stage = 'error';
    diag.lastError = msg;
    emitState();
    if (JV.hud) {
      JV.hud.setGesture({ enabled: false, error: msg });
      JV.hud.toast('手势启动失败：' + msg, 6000);
    }
    console.warn('[gesture] start failed:', msg);
  }

  function start() {
    if (gesture.enabled) return Promise.resolve(true);
    // file:// 下浏览器禁止加载 WASM/子资源，MediaPipe 必然失败 → 直接给可执行的解决方案
    if (location.protocol === 'file:' && !(MP_INLINE && window.Hands)) {
      fail('当前是 file:// 直接打开的单文件，浏览器禁止加载 WASM。请用「启动Jarvis.command」打开 http://127.0.0.1:8780/JARVIS-HUD.html（或点自检面板「用本地服务打开」）');
      return Promise.resolve(false);
    }
    if (!gesture.supported) { fail('该浏览器不支持摄像头'); return Promise.resolve(false); }
    if (gesture.loading) return Promise.resolve(false);
    gesture.loading = true;
    gesture.error = '';
    diag.stage = 'camera'; diag.startedAt = U.nowMs(); diag.lastError = ''; diag.framesSent = 0; diag.results = 0; diag.resultsWithHands = 0;
    if (JV.hud) JV.hud.setGesture({ enabled: false, mode: '加载中', count: 0 });
    bus.emit('gesture:state', { enabled: false, loading: true });

    var v = ensureVideo();
    function requestCam(constraints) {
      return navigator.mediaDevices.getUserMedia(constraints);
    }
    diag.stage = 'camera'; diag.lastError = '';
    return requestCam({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false })
      .catch(function (e1) {
        // 某些设备不支持 facingMode/分辨率，降级为最简约束
        console.warn('[gesture] 摄像头约束降级：', e1 && e1.name, e1 && e1.message);
        return requestCam({ video: true });
      })
      .then(function (s) {
      stream = s;
      v.srcObject = s;
      var tr = s.getVideoTracks()[0];
      diag.trackLabel = tr ? tr.label : '';
      return v.play().catch(function () { setTimeout(function () { try { v.play(); } catch (e) {} }, 400); });
    }).then(function () {
      diag.stage = 'script';
      return loadMediaPipe();
    }).then(function () {
      // 预检本地资源是否真的可读（file:// 或路径错误时唯一的清晰报错点）
      if (mpBase === 'inline') {
        var keys = Object.keys(MP_INLINE || {});
        diag.assetProbe = keys.length ? 'inline:' + keys.length : 'inline:empty';
        if (!keys.length) throw new Error('内联 MediaPipe 资源为空');
        return true;
      }
      var probeFile = mpBase + 'hands_solution_simd_wasm_bin.wasm';
      return fetch(probeFile, { method: 'HEAD' }).then(function (head) {
        diag.assetProbe = head.ok ? 'ok' : ('HTTP ' + head.status);
        if (!head.ok) throw new Error('WASM 资源不可读（HTTP ' + head.status + '）');
        return true;
      }).catch(function (e) {
        diag.assetProbe = 'fail';
        throw new Error('手势资源加载失败：' + ((e && e.message) || e) +
          (location.protocol === 'file:' ? '（浏览器禁止 file:// 加载 WASM，请用 http:// 打开）' : '（检查 jarvis/vendor/mediapipe/ 是否完整）'));
      });
    }).then(function () {
      diag.scriptLoaded = !!window.Hands;
      diag.stage = 'hands';
      var Hands = window.Hands;
      if (!Hands) throw new Error('MediaPipe Hands 脚本未就绪（本地资源缺失且 CDN 不可达）');
      diag.handsCtor = true;
      hands = new Hands({ locateFile: function (f) {
        if (mpBase === 'inline') {
          var url = inlineBlob(f);
          if (url) return url;
          // 个别加载器文件名可能在资源表里带路径前缀
          var base = String(f).split('/').pop();
          url = inlineBlob(base);
          if (url) return url;
        }
        return mpBase + f;
      } });
      hands.setOptions({
        maxNumHands: 2,
        modelComplexity: 0,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.55
      });
      hands.onResults(onResults);
      gesture.enabled = true;
      gesture.ready = true;
      gesture.loading = false;
      diag.stage = 'streaming';
    sending = false;
      JV.settings.gesture = true; JV.saveSettings();
      if (JV.hud) {
        JV.hud.setGesture({ enabled: true, mode: '待机', count: 0 });
        JV.hud.toast('手势已开启 · 双手拉开/收拢缩放，双手移动旋转（按 V 看自检）', 4200);
      }
      emitState();
      frameLoop();
      var tStart = U.nowMs();
      var watchdog = setInterval(function () {
        if (!gesture.enabled) { clearInterval(watchdog); return; }
        if (diag.results > 0) { clearInterval(watchdog); return; }
        if (U.nowMs() - tStart > 6000) {
          clearInterval(watchdog);
          diag.lastError = 'MediaPipe 6 秒内没有回调：检查 vendor/mediapipe 资源（或显卡/WASM 被禁）';
          if (JV.hud) JV.hud.toast('手势已连摄像头，但 MediaPipe 没有回调，按 V 看自检', 6000);
        }
      }, 1000);
      return true;
    }).catch(function (err) {
      var msg;
      var name = err && err.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        msg = '摄像头权限被拒绝 · 地址栏🔒→摄像头→允许；或系统设置→隐私与安全性→摄像头 勾选 Chrome 后刷新';
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        msg = '没有检测到摄像头设备（外接摄像头是否插好？）';
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        msg = '摄像头被其它程序占用（Zoom/微信/会议软件先关掉）';
      } else if (name === 'OverconstrainedError') {
        msg = '摄像头不支持所需分辨率（已自动降级仍失败）';
      } else if (/mediapipe/i.test(String(err && err.message))) {
        msg = '手势资源加载失败（本地 vendor/mediapipe 缺失且 CDN 不可达）';
      } else {
        msg = '启动失败：' + ((err && err.message) || err);
      }
      fail(msg);
      stopStream();
      return false;
    });
  }

  function stopStream() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    sending = false;
    if (stream) { stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); stream = null; }
    if (video) { video.srcObject = null; }
  }

  function stop() {
    gesture.enabled = false;
    gesture.ready = false;
    gesture.mode = 'idle';
    diag.stage = 'idle';
    GA.active = false; GA.anchor = null;
    JV.settings.gesture = false; JV.saveSettings();
    stopStream();
    emitState();
    if (JV.hud) JV.hud.setGesture({ enabled: false });
    if (JV.hud) JV.hud.drawHand(null);
  }

  /* ------------------------------------------------- 鼠标拖拽降级（全屏） */
  function wirePointerFallback() {
    var root = document.getElementById('jv-root');
    if (!root) return;
    root.addEventListener('pointerdown', function (e) {
      if (gesture.enabled) return;
      if (e.target.closest('button, a, input, #jv-settings, #jv-bottom, #jv-left, #jv-right, #jv-boot')) return;
      drag.active = true; drag.x = e.clientX; drag.y = e.clientY;
      root.style.cursor = 'grabbing';
    });
    window.addEventListener('pointermove', function (e) {
      if (!drag.active) return;
      var dx = (e.clientX - drag.x) / Math.max(1, window.innerWidth);
      var dy = (e.clientY - drag.y) / Math.max(1, window.innerHeight);
      drag.x = e.clientX; drag.y = e.clientY;
      bus.emit('pointer:drag', { dx: dx, dy: dy });
    });
    window.addEventListener('pointerup', function () {
      drag.active = false;
      root.style.cursor = '';
    });
    root.addEventListener('wheel', function (e) {
      if (gesture.enabled) return;
      if (e.target.closest('#jv-settings, #jv-left, #jv-right')) return;
      bus.emit('pointer:wheel', { delta: e.deltaY });
    }, { passive: true });
  }

  var api = {
    support: gesture.supported,
    start: start,
    stop: stop,
    toggle: function () { if (gesture.enabled) stop(); else start(); },
    demo: demoRun,
    demoStop: demoStop,
    simulate: function (hands) { applyHands(hands); },
    _onResults: function (results) { onResults(results); },
    _inject: function (v) { gesture.inject = !!v; },
    isOn: function () { return gesture.enabled; },
    status: function () { return gesture; },
    diag: function () {
      var v = video;
      return Object.assign({}, diag, {
        enabled: gesture.enabled, ready: gesture.ready, loading: gesture.loading,
        error: gesture.error, mode: gesture.mode, hands: gesture.count,
        video: v ? { readyState: v.readyState, w: v.videoWidth, h: v.videoHeight, paused: v.paused, src: !!v.srcObject } : null,
        track: (stream && stream.getVideoTracks ? (function () { var t = stream.getVideoTracks()[0]; return t ? { label: t.label, muted: t.muted, state: t.readyState } : null; })() : null),
        now: U.nowMs()
      });
    }
  };
  JV.gesture = api;
  wirePointerFallback();
})();
