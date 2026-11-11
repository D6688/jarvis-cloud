/* ============================================================================
 * JARVIS 2.0 · 00-core.js
 * 渲染管线（bloom 后期）、场景注册与切换、主循环、事件总线、色板、工具函数
 * 依赖：window.THREE（three.min.js 先行加载）
 * ==========================================================================*/
(function () {
  'use strict';

  var hasTHREE = typeof window.THREE !== 'undefined';
  if (!hasTHREE) {
    console.error('[JARVIS] 缺少 three.min.js，无法渲染 3D 场景');
  }
  var THREE = window.THREE || {};

  /* ------------------------------------------------------------------ utils */
  var util = {
    clamp: function (v, a, b) { return v < a ? a : v > b ? b : v; },
    lerp: function (a, b, t) { return a + (b - a) * t; },
    smoothstep: function (t) { t = util.clamp(t, 0, 1); return t * t * (3 - 2 * t); },
    rand: function (a, b) { return a + Math.random() * (b - a); },
    randInt: function (a, b) { return Math.floor(util.rand(a, b + 1)); },
    pick: function (arr) { return arr[Math.floor(Math.random() * arr.length)]; },
    rng: function (seed) {
      var s = seed >>> 0 || 1;
      return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    },
    dpr: function () { return Math.min(window.devicePixelRatio || 1, 2); },
    nowMs: function () { return (window.performance && performance.now) ? performance.now() : Date.now(); },
    uid: function (p) { return (p || 'id') + '-' + Math.random().toString(36).slice(2, 8); },
    easeInOut: function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; },
    fmtTime: function (d, lang) {
      d = d || new Date();
      var h = d.getHours(), m = d.getMinutes(), s = d.getSeconds();
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return (lang === 'en' ? '' : '') + p(h) + ':' + p(m);
    },
    fmtTimeSec: function (d) {
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      d = d || new Date();
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    },
    fmtDate: function (d, lang) {
      d = d || new Date();
      var wdZh = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      var wdEn = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
      if (lang === 'en') {
        return wdEn[d.getDay()] + ' · ' + (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
      }
      return (d.getMonth() + 1) + '月' + d.getDate() + '日 · ' + wdZh[d.getDay()];
    },
    esc: function (s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    },
    hexA: function (hex, a) {
      var h = String(hex || '').replace('#', '');
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      if (isNaN(r)) return 'rgba(126,245,207,' + a + ')';
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    },
    // 中英双行字幕拆分：「中文｜English」或「中文\nEnglish」
    splitBilingual: function (text) {
      if (!text) return { zh: '', en: '' };
      var t = String(text).trim();
      var m = t.split(/\s*[｜|]\s*/);
      if (m.length >= 2) return { zh: m[0], en: m.slice(1).join(' ') };
      var lines = t.split(/\n+/).filter(Boolean);
      if (lines.length >= 2) {
        var zh = [], en = [];
        lines.forEach(function (l) {
          if (/[\u4e00-\u9fa5]/.test(l)) zh.push(l); else en.push(l);
        });
        if (zh.length && en.length) return { zh: zh.join(' '), en: en.join(' ') };
      }
      return { zh: /[\u4e00-\u9fa5]/.test(t) ? t : '', en: /[\u4e00-\u9fa5]/.test(t) ? '' : t };
    },
    urlParam: function (k, d) {
      var m = new RegExp('[?&]' + k + '=([^&#]*)').exec(location.search);
      return m ? decodeURIComponent(m[1]) : d;
    }
  };

  /* ---------------------------------------------------------- 主题 / 色板 */
  var PALETTES = {
    mint: {
      bg: '#04070a', bgLift: '#070d10',
      ink: '#dbfff4', inkDim: 'rgba(198,255,239,.55)', inkFaint: 'rgba(198,255,239,.30)',
      mint: '#38e0ae', mintDeep: '#0b8f6b', mintLight: '#b9ffe8', mintGlow: '#7ef5cf',
      amber: '#ffc177', amberDeep: '#a85f24', warm: '#ffe6c2',
      white: '#eafff8', alert: '#ff8a3d',
      line: 'rgba(126,245,207,.16)', lineSoft: 'rgba(126,245,207,.08)'
    },
    amber: {
      bg: '#0a0705', bgLift: '#120c07',
      ink: '#fff1dd', inkDim: 'rgba(255,225,190,.55)', inkFaint: 'rgba(255,225,190,.30)',
      mint: '#ffb166', mintDeep: '#9d5a1c', mintLight: '#fff0d6', mintGlow: '#ffc98c',
      amber: '#7ef5cf', amberDeep: '#146c53', warm: '#d8fff2',
      white: '#fff6ea', alert: '#ff7a4d',
      line: 'rgba(255,177,102,.18)', lineSoft: 'rgba(255,177,102,.08)'
    }
  };

  var LS_KEY = 'jarvis2.settings.v1';
  var DEFAULT_SETTINGS = {
    lang: 'zh', theme: 'mint', quality: 'auto',
    voice: true, gesture: true, voiceGender: 'male',
    grants: { system: true, files: true, shell: true, network: true },
    memoryEnabled: true,
    gestureSensitivity: 'mid', gestureGlobal: true,
    plugins: {},
    llm: { enabled: false, endpoint: '', model: '', key: '' }
  };

  function loadSettings() {
    var s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        Object.keys(saved).forEach(function (k) {
          if (k === 'llm') Object.assign(s.llm, saved.llm || {});
          else if (k === 'grants') Object.assign(s.grants, saved.grants || {});
          else if (k === 'plugins') Object.assign(s.plugins, saved.plugins || {});
          else if (saved[k] !== undefined) s[k] = saved[k];
        });
      }
    } catch (e) { /* 忽略损坏的存档 */ }
    if (PALETTES[s.theme] == null) s.theme = 'mint';
    return s;
  }
  function saveSettings() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  var settings = loadSettings();

  /* ------------------------------------------------------------ 事件总线 */
  var listeners = Object.create(null);
  var bus = {
    on: function (evt, fn) {
      if (typeof fn !== 'function') return;
      (listeners[evt] || (listeners[evt] = [])).push(fn);
    },
    off: function (evt, fn) {
      var arr = listeners[evt]; if (!arr) return;
      var i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1);
    },
    emit: function (evt, payload) {
      var arr = listeners[evt];
      if (!arr) return;
      arr.slice().forEach(function (fn) {
        try { fn(payload); } catch (e) { console.error('[bus:' + evt + ']', e); }
      });
    }
  };

  /* -------------------------------------------------------------- 渲染器 */
  var renderer = null, scene = null, camera = null, stage = null, clock = null;
  var W = 1, H = 1, DPR = 1;
  var bloom = null;

  function initRenderer() {
    renderer = new THREE.WebGLRenderer({
      antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false
    });
    renderer.setClearColor(0x04070a, 1);
    renderer.setPixelRatio(Math.min(DPR, 2));
    if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.autoClear = true;
    renderer.domElement.id = 'jv-canvas';
    return renderer;
  }

  function initScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(settings.theme === 'amber' ? 0x0a0705 : 0x04070a);
    scene.fog = new THREE.FogExp2(settings.theme === 'amber' ? 0x0a0705 : 0x04070a, 0.028);
    camera = new THREE.PerspectiveCamera(46, 16 / 9, 0.1, 400);
    camera.position.set(0, 0.6, 9.5);
    camera.lookAt(0, 0, 0);
    stage = new THREE.Group();
    stage.name = 'stage';
    scene.add(stage);

    // 极简环境光：场景自身以加法发光材质为主，灯光只做材料基础色微调
    var amb = new THREE.AmbientLight(0x7ef5cf, 0.35);
    var key = new THREE.PointLight(0x9dffe0, 0.9, 60);
    key.position.set(4, 6, 8);
    scene.add(amb, key);
    clock = new THREE.Clock();
  }

  /* --------------------------------------------------------------- bloom */
  var BLOOM_VS = [
    'varying vec2 vUv;',
    'void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }'
  ].join('\n');

  var BRIGHT_FS = [
    'precision highp float;',
    'uniform sampler2D tDiffuse; uniform float threshold; uniform float knee;',
    'varying vec2 vUv;',
    'void main(){',
    '  vec3 c = texture2D(tDiffuse, vUv).rgb;',
    '  float l = max(c.r, max(c.g, c.b));',
    '  float s = smoothstep(threshold, threshold + knee, l);',
    '  gl_FragColor = vec4(c * s, 1.0);',
    '}'
  ].join('\n');

  var BLUR_FS = [
    'precision highp float;',
    'uniform sampler2D tDiffuse; uniform vec2 dir; uniform vec2 res;',
    'varying vec2 vUv;',
    'void main(){',
    '  vec2 px = dir / res;',
    '  vec3 c = texture2D(tDiffuse, vUv).rgb * 0.2270270270;',
    '  c += texture2D(tDiffuse, vUv + px * 1.3846153846).rgb * 0.3162162162;',
    '  c += texture2D(tDiffuse, vUv - px * 1.3846153846).rgb * 0.3162162162;',
    '  c += texture2D(tDiffuse, vUv + px * 3.2307692308).rgb * 0.0702702703;',
    '  c += texture2D(tDiffuse, vUv - px * 3.2307692308).rgb * 0.0702702703;',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n');

  var COMPOSITE_FS = [
    'precision highp float;',
    'uniform sampler2D tBase; uniform sampler2D tBloom1; uniform sampler2D tBloom2;',
    'uniform float strength; uniform float time;',
    'varying vec2 vUv;',
    'void main(){',
    '  vec3 base = texture2D(tBase, vUv).rgb;',
    '  vec3 b1 = texture2D(tBloom1, vUv).rgb;',
    '  vec3 b2 = texture2D(tBloom2, vUv).rgb;',
    '  vec3 sum = base + b1 * 1.05 * strength + b2 * 1.35 * strength;',
    '  // 轻微暗角 + 扫描线，营造全息屏质感',
    '  float vig = smoothstep(1.18, 0.28, length(vUv - 0.5) * 1.42);',
    '  sum *= mix(0.62, 1.0, vig);',
    '  float scan = sin((vUv.y + time * 0.02) * 1080.0 * 1.6) * 0.5 + 0.5;',
    '  sum *= 0.985 + scan * 0.015;',
    '  sum = pow(max(sum, 0.0), vec3(0.92));',
    '  gl_FragColor = vec4(sum, 1.0);',
    '}'
  ].join('\n');

  function makeRT(w, h) {
    var rt = new THREE.WebGLRenderTarget(Math.max(2, w | 0), Math.max(2, h | 0), {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false
    });
    if ('texture' in rt) { rt.texture.generateMipmaps = false; }
    return rt;
  }

  function initBloom() {
    var quadGeo = new THREE.PlaneBufferGeometry(2, 2);
    var quad = new THREE.Mesh(quadGeo, new THREE.MeshBasicMaterial());
    var qScene = new THREE.Scene(); qScene.add(quad);
    var qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    var brightMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, threshold: { value: 0.42 }, knee: { value: 0.28 } },
      vertexShader: BLOOM_VS, fragmentShader: BRIGHT_FS, depthTest: false, depthWrite: false
    });
    var blurMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, dir: { value: new THREE.Vector2(1, 0) }, res: { value: new THREE.Vector2(1, 1) } },
      vertexShader: BLOOM_VS, fragmentShader: BLUR_FS, depthTest: false, depthWrite: false
    });
    var compMat = new THREE.ShaderMaterial({
      uniforms: {
        tBase: { value: null }, tBloom1: { value: null }, tBloom2: { value: null },
        strength: { value: 1.0 }, time: { value: 0 }
      },
      vertexShader: BLOOM_VS, fragmentShader: COMPOSITE_FS, depthTest: false, depthWrite: false
    });

    function pass(mat, target) {
      quad.material = mat;
      renderer.setRenderTarget(target || null);
      renderer.render(qScene, qCam);
    }

    bloom = {
      rtScene: makeRT(W, H),
      rtA: makeRT(W / 2, H / 2),
      rtB: makeRT(W / 2, H / 2),
      rtC: makeRT(W / 4, H / 4),
      rtD: makeRT(W / 4, H / 4),
      compMat: compMat,
      quality: 1,
      resize: function (w, h) {
        bloom.rtScene.setSize(Math.max(2, w), Math.max(2, h));
        var b = bloom.rtScene.width, c = bloom.rtScene.height;
        bloom.rtA.setSize(Math.max(2, b >> 1), Math.max(2, c >> 1));
        bloom.rtB.setSize(Math.max(2, b >> 1), Math.max(2, c >> 1));
        bloom.rtC.setSize(Math.max(2, b >> 2), Math.max(2, c >> 2));
        bloom.rtD.setSize(Math.max(2, b >> 2), Math.max(2, c >> 2));
      },
      setQuality: function (n) {
        // n: 2=高（双级 bloom） 1=中（单级） 0=低（关闭）
        bloom.quality = n;
        brightMat.uniforms.threshold.value = n > 0 ? 0.42 : 0.6;
      },
      render: function (time) {
        renderer.setRenderTarget(bloom.rtScene);
        renderer.clear();
        renderer.render(scene, camera);

        // 亮度提取 → 半分辨率
        brightMat.uniforms.tDiffuse.value = bloom.rtScene.texture;
        pass(brightMat, bloom.rtA);

        // 半分辨率模糊
        blurMat.uniforms.tDiffuse.value = bloom.rtA.texture;
        blurMat.uniforms.dir.value.set(1, 0);
        blurMat.uniforms.res.value.set(bloom.rtA.width, bloom.rtA.height);
        pass(blurMat, bloom.rtB);
        blurMat.uniforms.tDiffuse.value = bloom.rtB.texture;
        blurMat.uniforms.dir.value.set(0, 1);
        pass(blurMat, bloom.rtA);

        if (bloom.quality > 1) {
          // 四分之一分辨率二次模糊（大范围光晕）
          blurMat.uniforms.tDiffuse.value = bloom.rtA.texture;
          blurMat.uniforms.dir.value.set(1, 0);
          blurMat.uniforms.res.value.set(bloom.rtA.width, bloom.rtA.height);
          pass(blurMat, bloom.rtC);
          blurMat.uniforms.tDiffuse.value = bloom.rtC.texture;
          blurMat.uniforms.dir.value.set(0, 1);
          blurMat.uniforms.res.value.set(bloom.rtC.width, bloom.rtC.height);
          pass(blurMat, bloom.rtD);
          blurMat.uniforms.tDiffuse.value = bloom.rtD.texture;
          blurMat.uniforms.dir.value.set(1, 0);
          blurMat.uniforms.res.value.set(bloom.rtD.width, bloom.rtD.height);
          pass(blurMat, bloom.rtC);
        }

        compMat.uniforms.tBase.value = bloom.rtScene.texture;
        compMat.uniforms.tBloom1.value = bloom.rtA.texture;
        compMat.uniforms.tBloom2.value = (bloom.quality > 1 ? bloom.rtC : bloom.rtA).texture;
        compMat.uniforms.time.value = time;
        compMat.uniforms.strength.value = bloom.quality > 0 ? 1.0 : 0.0;
        pass(compMat, null);
      }
    };
  }

  /* --------------------------------------------------------- 场景注册中心 */
  var scenes = Object.create(null);
  var current = null;
  var currentName = '';

  function buildContext() {
    return {
      THREE: THREE,
      parent: stage,
      camera: camera,
      renderer: renderer,
      size: { w: W, h: H, dpr: DPR },
      quality: currentQuality,
      palette: PALETTES[settings.theme],
      bus: bus,
      util: util,
      settings: settings,
      resolve: function (p) { return p; }
    };
  }

  function registerScene(name, factory) {
    scenes[name] = { factory: factory, entity: null };
  }

  function disposeEntity(ent) {
    if (!ent) return;
    try { if (ent.group && stage && ent.group.parent === stage) stage.remove(ent.group); } catch (e) {}
    try { if (typeof ent.dispose === 'function') ent.dispose(); } catch (e) { console.error('[dispose]', e); }
  }

  function flashTransition() {
    var el = document.getElementById('jv-flash');
    if (!el) return;
    el.classList.add('is-on');
    setTimeout(function () { el.classList.remove('is-on'); }, 150);
  }

  function show(name, opts) {
    var rec = scenes[name];
    if (!rec) { console.warn('[JARVIS] 未注册场景：' + name); return null; }
    var from = currentName;
    if (from && from !== name) flashTransition();
    if (rec.entity) {
      // 已构建：直接切回复用
      if (current && current !== rec.entity) {
        if (current.group) current.group.visible = false;
        if (typeof current.pause === 'function') current.pause();
      }
      if (rec.entity.group) rec.entity.group.visible = true;
      current = rec.entity; currentName = name;
      if (typeof current.enter === 'function') current.enter(opts || {});
      bus.emit('scene:changed', { name: name, from: from });
      return current;
    }
    var ctx = buildContext();
    ctx.quality = currentQuality;
    var ent;
    try {
      ent = rec.factory(ctx);
    } catch (e) {
      console.error('[JARVIS] 场景构建失败：' + name, e);
      return null;
    }
    rec.entity = ent;
    if (ent.group && !ent.group.parent) stage.add(ent.group);
    if (current && current !== ent) {
      if (current.group) current.group.visible = false;
      if (typeof current.pause === 'function') current.pause();
    }
    current = ent; currentName = name;
    if (typeof ent.enter === 'function') ent.enter(opts || {});
    if (typeof ent.setQuality === 'function') ent.setQuality(currentQuality);
    bus.emit('scene:changed', { name: name, from: from });
    return ent;
  }

  /* ------------------------------------------------------------ 尺寸/帧率 */
  var currentQuality = 'high';
  var frameStats = { acc: 0, n: 0, fps: 60 };
  var hudHandlers = [];

  function resize() {
    W = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1280);
    H = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 720);
    DPR = util.dpr();
    if (!renderer) return;
    renderer.setPixelRatio(Math.min(DPR, 2));
    renderer.setSize(W, H, false);
    if (camera) {
      camera.aspect = W / H;
      camera.updateProjectionMatrix();
      // 竖屏时把镜头拉远，保证主体不被裁切
      var fovBase = 46;
      if (W / H < 1) {
        camera.fov = fovBase * util.clamp(1.5 / (W / H), 1, 1.9);
        camera.position.z = 7.4;
      } else {
        camera.fov = fovBase;
        camera.position.z = 9.5;
      }
      camera.updateProjectionMatrix();
    }
    if (bloom) bloom.resize(W * Math.min(DPR, 2), H * Math.min(DPR, 2));
    if (current && typeof current.resize === 'function') current.resize(W, H);
    bus.emit('resize', { w: W, h: H, dpr: DPR });
  }

  function autoQuality(fps) {
    if (settings.quality !== 'auto') {
      applyQuality(settings.quality);
      return;
    }
    if (fps < 42 && currentQuality !== 'low') applyQuality(currentQuality === 'high' ? 'med' : 'low');
    else if (fps > 56 && currentQuality === 'low') applyQuality('med');
  }

  function applyQuality(q) {
    if (q === currentQuality) return;
    currentQuality = q;
    if (bloom) bloom.setQuality(q === 'high' ? 2 : q === 'med' ? 1 : 0);
    Object.keys(scenes).forEach(function (k) {
      var e = scenes[k].entity;
      if (e && typeof e.setQuality === 'function') e.setQuality(q);
    });
    bus.emit('quality:changed', { quality: q });
  }

  var running = false;
  var lastT = 0;
  function frame() {
    requestAnimationFrame(frame);
    var dt = Math.min(clock.getDelta(), 0.1);
    var t = clock.elapsedTime;
    var st = JV.state;
    // 全局变换：手势 → 缩放 / 旋转 / 平移（对全息体整体生效，不影响 HUD）
    if (stage && JV.state) {
      var st = JV.state;
      var target = JV.util.clamp(st.zoom || 1, 0.55, 2.6);
      var cur = stage.scale.x;
      if (Math.abs(cur - target) > 0.001) {
        var nz = cur + (target - cur) * Math.min(1, dt * 7);
        stage.scale.setScalar(nz);
        bus.emit('zoom:changed', { zoom: nz });
      }
      var k = Math.min(1, dt * 11);
      stage.rotation.y += ((st.rotY || 0) - stage.rotation.y) * k;
      stage.rotation.x += ((st.rotX || 0) - stage.rotation.x) * k;
      stage.rotation.z += ((st.roll || 0) - stage.rotation.z) * k;
      stage.position.x += ((st.panX || 0) - stage.position.x) * k;
      stage.position.y += ((st.panY || 0) - stage.position.y) * k;
    }
    if (current && typeof current.update === 'function') {
      try { current.update(t, dt, st); } catch (e) { console.error('[scene:update]', e); }
    }
    hudHandlers.forEach(function (fn) { try { fn(t, dt, st); } catch (e) { console.error('[hud:tick]', e); } });
    if (bloom) bloom.render(t);
    // 帧率统计
    frameStats.acc += dt; frameStats.n++;
    if (frameStats.acc >= 1) {
      frameStats.fps = frameStats.n / frameStats.acc;
      autoQuality(frameStats.fps);
      frameStats.acc = 0; frameStats.n = 0;
    }
    lastT = t;
  }

  /* --------------------------------------------------------------- 公共状态 */
  var state = {
    mode: 'idle',          // idle | listen | think | speak | warp | off
    level: 0,              // 0..1 音量
    zoom: 1,               // 1.0 = 原始大小（手势/滚轮控制全息图缩放）
    rotY: 0, rotX: 0,      // 手势旋转（弧度）
    panX: 0, panY: 0,      // 手势平移（世界单位）
    roll: 0,               // 双手连线滚转
    sceneName: 'orb',
    micOn: false,
    gestureOn: false,
    llm: 'offline',
    booted: false,
    theme: settings.theme,
    lang: settings.lang
  };

  var JV = {
    version: '2.0',
    settings: settings,
    state: state,
    bus: bus,
    util: util,
    palette: PALETTES[settings.theme],
    THREE: THREE,
    renderer: renderer,
    scene: scene,
    camera: camera,
    stage: stage,
    clock: clock,
    hud: null, voice: null, gesture: null, agent: null, audio: null,
    size: function () { return { w: W, h: H, dpr: DPR }; },
    quality: function () { return currentQuality; },
    fps: function () { return frameStats.fps; },
    registerScene: registerScene,
    scenes: scenes,
    show: show,
    currentScene: function () { return current; },
    currentSceneName: function () { return currentName; },
    bloom: function () { return bloom; },
    applyQuality: applyQuality,
    saveSettings: saveSettings,
    applyTheme: function (name) {
      if (!PALETTES[name]) return;
      settings.theme = name;
      JV.palette = PALETTES[name];
      state.theme = name;
      if (scene) scene.background = new THREE.Color(PALETTES[name].bg);
      document.documentElement.setAttribute('data-theme', name);
      saveSettings();
      bus.emit('theme:changed', { theme: name });
    },
    onHudTick: function (fn) { if (typeof fn === 'function') hudHandlers.push(fn); },
    // 由 index.html 在全部模块加载后启动
    start: function () {
      if (running) return;
      running = true;
      initRenderer();
      initScene();
      DPR = util.dpr();
      JV.renderer = renderer; JV.scene = scene; JV.camera = camera; JV.stage = stage; JV.clock = clock;
      var host = document.getElementById('jv-canvas-host') || document.body;
      renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
      host.appendChild(renderer.domElement);
      document.documentElement.setAttribute('data-theme', settings.theme);
      resize();
      initBloom();
      applyQuality(settings.quality === 'auto' ? 'high' : settings.quality);
      window.addEventListener('resize', resize, { passive: true });
      if (window.visualViewport) window.visualViewport.addEventListener('resize', resize, { passive: true });
      document.addEventListener('visibilitychange', function () { if (clock) clock.getDelta(); });
      // 首个场景：优先 orb
      if (scenes.orb) show('orb');
      else if (scenes.grid) show('grid');
      frame();
    }
  };

  // 暴露三个只能由 core 修改的引用（其他模块只读）
  Object.defineProperty(JV, 'threeRefs', {
    get: function () { return { renderer: renderer, scene: scene, camera: camera, stage: stage, clock: clock }; }
  });

  window.JV = JV;
})();
