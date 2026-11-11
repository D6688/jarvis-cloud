/* ============================================================================
 * JARVIS 2.0 · 01-scene-orb.js   （T1）
 * 中心全息能量体：三层能量（亮核 + 卷曲丝带 + 点云）+ 倾斜虚线轨道环 +
 * 竖向光雨 + 漂浮数值 Sprite；七形态 idle/listen/think/speak/warp/shutdown/powerOn
 *
 * 依赖：window.THREE（three.min.js r137）、window.JV（00-core.js）
 * 只画 3D：不建 renderer、不写 DOM、不 fetch、不 import。
 * 性能：单场景 drawcall ≈ 21；顶点数 high≈135k / med≈62k / low≈26k；
 *       每帧不分配对象（只有 setQuality 时重建几何）。
 * ==========================================================================*/
(function () {
  'use strict';

  var THREE = window.THREE;
  var JV = window.JV;
  if (!THREE) { console.error('[orb] 缺少 three.min.js'); return; }
  if (!JV || typeof JV.registerScene !== 'function') { console.error('[orb] 缺少 JV 命名空间'); return; }

  var TAU = Math.PI * 2;

  /* ------------------------------------------------------------- 画质预算 */
  // 粒子/顶点预算：high ≤ 220k，med ≈ 一半，low ≈ 四分之一（关闭次要层）
  var BUDGET = {
    high: { bands: 130, threads: 2400, dust: 17000, rain: 1500, stars: 900, ring3: true, shell: true },
    med: { bands: 70, threads: 1200, dust: 8500, rain: 760, stars: 560, ring3: true, shell: true },
    low: { bands: 34, threads: 520, dust: 3800, rain: 380, stars: 280, ring3: false, shell: false }
  };

  var ORB_R = 2.26;        // 能量球基准半径
  var BAND_PTS = 48;       // 宽丝带采样点
  var THREAD_PTS = 18;     // 细丝采样点
  var NUM_BASE = ['0.76', '1.07', '-0.07', '0.80', '0.81', '0.41'];

  /* --------------------------------------------------------- 随机数 / 工具 */
  function rngFactory(seed) {
    var s = (seed >>> 0) || 1;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function smoothstep01(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
  function damp(cur, tgt, dt, rate) {
    var k = 1 - Math.exp(-rate * dt);
    return cur + (tgt - cur) * k;
  }
  function easeOutCubic(t) { t = clamp01(t); var u = 1 - t; return 1 - u * u * u; }

  /* ------------------------------------------------- 调色板 → Color 实例 */
  // 注意：THREE.Color.lerp 只接受 Color 实例；直接传 palette 里的 hex 字符串
  // 会让 r/g/b 变成 undefined → NaN，顶点色 NaN 会导致整层不可见。
  function palColors(pal) {
    return {
      mint: new THREE.Color(pal.mint),
      mintDeep: new THREE.Color(pal.mintDeep),
      mintLight: new THREE.Color(pal.mintLight),
      mintGlow: new THREE.Color(pal.mintGlow),
      amber: new THREE.Color(pal.amber),
      warm: new THREE.Color(pal.warm),
      white: new THREE.Color(pal.white)
    };
  }

  /* --------------------------------------------------------------- 纹理 */
  // 径向发光贴图（复用给核心光晕 / 速度光带 / 闪光）
  function makeGlowTexture() {
    var s = 256;
    var c = document.createElement('canvas');
    c.width = c.height = s;
    var g = c.getContext('2d');
    var grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0.00, 'rgba(255,255,255,1.00)');
    grd.addColorStop(0.12, 'rgba(255,255,255,0.66)');
    grd.addColorStop(0.30, 'rgba(255,255,255,0.24)');
    grd.addColorStop(0.58, 'rgba(255,255,255,0.06)');
    grd.addColorStop(1.00, 'rgba(255,255,255,0.00)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    var tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    tex.needsUpdate = true;
    return tex;
  }

  // 数值 Sprite 用的画布（可原地重绘：数字轻微抖动 = 活数据感）
  function makeNumberSprite(text, colorHex, opacity) {
    var c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    var g = c.getContext('2d');
    var tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    var mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: opacity,
      color: 0xffffff, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: false
    });
    var sp = new THREE.Sprite(mat);
    sp.scale.set(0.86, 0.43, 1);
    var obj = { sprite: sp, canvas: c, ctx: g, tex: tex, text: text, color: colorHex, dirty: true };
    drawNumber(obj, text, colorHex);
    return obj;
  }
  function drawNumber(obj, text, colorHex) {
    var g = obj.ctx, w = 256, h = 128;
    g.clearRect(0, 0, w, h);
    g.save();
    g.font = '200 54px "Helvetica Neue", "Inter", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = colorHex;
    g.shadowBlur = 22;
    g.fillStyle = colorHex;
    g.fillText(text, w / 2, h / 2);
    g.shadowBlur = 8;
    g.fillStyle = colorHex;
    g.fillText(text, w / 2, h / 2);
    g.restore();
    obj.tex.needsUpdate = true;
    obj.text = text;
  }

  /* ------------------------------------------------- 丝带参数（每条一份） */
  // 设计要点：所有丝带绕【同一根漩涡轴】盘旋（像被梳过的绸），
  // 半径/轴向摆幅/相位各自不同 → 得到"层层叠叠的卷曲绸带球"，而不是杂乱毛线团。
  // 全局轴在 build 时算一次，丝带局部再做极小的轴向扰动。
  var SWIRL = (function () {
    var ax = 0.15, ay = 0.62, az = 0.77;
    var al = Math.sqrt(ax * ax + ay * ay + az * az);
    ax /= al; ay /= al; az /= al;
    // e1 = normalize(UP × A)，e2 = A × e1
    var e1x = -az, e1y = 0, e1z = ax;
    var l1 = Math.sqrt(e1x * e1x + e1z * e1z) || 1;
    e1x /= l1; e1z /= l1;
    var e2x = ay * e1z - az * e1y, e2y = az * e1x - ax * e1z, e2z = ax * e1y - ay * e1x;
    return { a: [ax, ay, az], e1: [e1x, e1y, e1z], e2: [e2x, e2y, e2z] };
  })();

  function makeRibbonParams(rnd, kind) {
    var p = {};
    p.seed = rnd();
    p.start = rnd() * TAU;
    p.span = TAU * (0.52 + 0.48 * rnd());       // 开放段：带自由端，像被剪断的绸
    p.r0 = (kind === 'band' ? 0.34 + 0.74 * rnd() : 0.26 + 0.95 * rnd());
    p.hAmp = (kind === 'band' ? 0.30 + 0.55 * rnd() : 0.42 + 0.85 * rnd());
    p.hFreq = 0.7 + 1.6 * rnd();
    p.rippleAmp = 0.08 + 0.16 * rnd();
    p.rippleFreq = 1.2 + 2.4 * rnd();
    p.twist = (rnd() - 0.5) * 1.1;              // 绕轴的螺旋扭转
    p.axisTilt = (rnd() - 0.5) * 0.55;          // 每条环的倾角微差
    p.wobble = 0.03 + 0.07 * rnd();
    p.p1 = rnd() * TAU; p.p2 = rnd() * TAU; p.p3 = rnd() * TAU;
    p.p4 = rnd() * TAU; p.p5 = rnd() * TAU; p.p6 = rnd() * TAU; p.p7 = rnd() * TAU;
    p.width = 0.020 + rnd() * 0.062;
    p.warmBias = 0.03 + rnd() * 0.30;
    p.coolMix = rnd();
    p.whiteMix = rnd() < 0.20 ? 0.30 + rnd() * 0.38 : rnd() * 0.12;
    p.warmSilk = rnd() < 0.22;                  // 少量奶油白/琥珀丝带点缀
    p.hero = rnd() < 0.10;                      // 主丝带：更宽更亮
    p.alphaMul = kind === 'band' ? (0.038 + rnd() * 0.058) : (0.018 + rnd() * 0.042);
    p.spineAlpha = 0.145 + rnd() * 0.135;       // 绸带中心亮丝（清晰但不糊）
    p.torusR = 1.28 + rnd() * 1.38;
    p.torusY = (rnd() - 0.5) * 0.54;
    p.torusPhase = rnd() * TAU;
    return p;
  }

  // 绕统一漩涡轴的卷曲环中心线，写入 cpos（pts*3）
  function fillCenterline(cpos, pts, p, R, minR) {
    var A = SWIRL.a, E1 = SWIRL.e1, E2 = SWIRL.e2;
    // 每条丝带自己的微扰轴：绕 e1 转 axisTilt
    var ct = Math.cos(p.axisTilt), st = Math.sin(p.axisTilt);
    var ax = A[0] * ct + E2[0] * st, ay = A[1] * ct + E2[1] * st, az = A[2] * ct + E2[2] * st;
    var al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    ax /= al; ay /= al; az /= al;
    var e1x = E1[0], e1y = E1[1], e1z = E1[2];
    var e2x = ay * e1z - az * e1y, e2y = az * e1x - ax * e1z, e2z = ax * e1y - ay * e1x;
    var floor = minR || 0;
    for (var k = 0; k < pts; k++) {
      var t01 = k / (pts - 1);
      var th = p.start + t01 * p.span;
      var tw = th + p.twist * t01 * TAU * 0.25;
      var rr = R * p.r0 * (1 + p.rippleAmp * Math.sin(th * p.rippleFreq + p.p1) + p.wobble * Math.sin(th * 3.1 + p.p4));
      var hh = R * p.hAmp * Math.sin(th * p.hFreq + p.p2) + R * 0.22 * Math.sin(th * 2.0 + p.p3);
      var x = (Math.cos(tw) * e1x + Math.sin(tw) * e2x) * rr + ax * hh;
      var y = (Math.cos(tw) * e1y + Math.sin(tw) * e2y) * rr + ay * hh;
      var z = (Math.cos(tw) * e1z + Math.sin(tw) * e2z) * rr + az * hh;
      var rl = Math.sqrt(x * x + y * y + z * z);
      if (floor > 0 && rl > 1e-4 && rl < floor) {
        var kk = floor / rl;
        x *= kk; y *= kk; z *= kk;
      }
      cpos[k * 3] = x;
      cpos[k * 3 + 1] = y;
      cpos[k * 3 + 2] = z;
    }
  }

  /* ------------------------------------------------------- 宽丝带（三角形带） */
  // 返回 { geo, spine }：geo = 有宽度的绸带面；spine = 绸带中心的一道亮丝（清晰的高光）
  function buildBands(R, count, pts, seed, pal) {
    var rnd = rngFactory(seed);
    var vcount = count * pts * 2;
    var pos = new Float32Array(vcount * 3);
    var tor = new Float32Array(vcount * 3);
    var col = new Float32Array(vcount * 3);
    var wbias = new Float32Array(vcount);
    var seedA = new Float32Array(vcount);
    var alpha = new Float32Array(vcount);
    var idx = new Uint32Array(count * (pts - 1) * 6);

    var segs = pts - 1;
    var svcount = count * segs * 2;
    var sp = new Float32Array(svcount * 3);
    var st = new Float32Array(svcount * 3);
    var sc = new Float32Array(svcount * 3);
    var sw = new Float32Array(svcount);
    var ss = new Float32Array(svcount);
    var sa = new Float32Array(svcount);
    var spi = 0;

    var cpos = new Float32Array(pts * 3);
    var C = palColors(pal);
    var cool = new THREE.Color(), tmp = new THREE.Color(), spineCol = new THREE.Color();
    var vi = 0, ii = 0;

    for (var j = 0; j < count; j++) {
      var p = makeRibbonParams(rnd, 'band');
      fillCenterline(cpos, pts, p, R, R * 0.16);

      // 每条丝带一种基调：青绿 / 薄荷白 / 奶油暖白
      if (p.warmSilk) {
        cool.copy(C.amber).lerp(C.warm, 0.30 + 0.55 * p.coolMix).lerp(C.white, p.whiteMix * 0.55);
      } else {
        cool.copy(C.mintDeep).lerp(C.mintGlow, 0.30 + 0.70 * p.coolMix);
        cool.lerp(C.mintLight, p.coolMix * 0.40);
        cool.lerp(C.white, p.whiteMix);
      }
      spineCol.copy(cool).lerp(C.white, 0.18 + 0.30 * p.coolMix);
      var wMul = p.hero ? 1.7 : 1.0;
      var aMul = p.hero ? 1.5 : 1.0;

      for (var k = 0; k < pts; k++) {
        var i3 = k * 3;
        var x = cpos[i3], y = cpos[i3 + 1], z = cpos[i3 + 2];
        var kp = k > 0 ? k - 1 : k, kn = k < pts - 1 ? k + 1 : k;
        var tx = cpos[kn * 3] - cpos[kp * 3];
        var ty = cpos[kn * 3 + 1] - cpos[kp * 3 + 1];
        var tz = cpos[kn * 3 + 2] - cpos[kp * 3 + 2];
        var tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1e-4;
        tx /= tl; ty /= tl; tz /= tl;
        // 副法线 = cross(T, 世界UP) = (-T.z, 0, T.x)，退化时换参照轴
        var nx = -tz, ny = 0, nz = tx;
        var nl = Math.sqrt(nx * nx + nz * nz);
        if (nl < 0.14) { nx = 1; ny = 0; nz = 0; nl = 1; }
        nx /= nl; ny /= nl; nz /= nl;

        var t01 = k / (pts - 1);
        var u = p.start + t01 * p.span;
        // 两端收尖 + 宽度起伏：绸带剪影
        var taper = Math.pow(Math.sin(Math.PI * t01), 0.60);
        var w = R * p.width * wMul * (0.10 + 0.90 * taper) * (0.62 + 0.38 * Math.sin(u * 1.3 + p.p7));
        var bright = 0.52 + 0.60 * Math.abs(Math.sin(u * 1.15 + p.p6));
        tmp.copy(cool).multiplyScalar(bright);
        var seedV = p.seed * 0.72 + t01 * 0.28;
        var aV = p.alphaMul * aMul * (0.25 + 0.90 * taper);

        // 圆盘目标（think：同心环带）
        var ang = t01 * TAU;
        var rT = p.torusR + 0.22 * Math.sin(ang * 2 + p.torusPhase);
        var ty2 = p.torusY + 0.10 * Math.sin(ang * 3 + p.torusPhase);
        var tcx = Math.cos(ang) * rT, tcz = Math.sin(ang) * rT;

        for (var side = 0; side < 2; side++) {
          var sg = side === 0 ? 1 : -1;
          var v3 = vi * 3;
          pos[v3] = x + nx * w * sg;
          pos[v3 + 1] = y + ny * w * sg;
          pos[v3 + 2] = z + nz * w * sg;
          tor[v3] = tcx + nx * w * sg * 0.5;
          tor[v3 + 1] = ty2 + ny * w * sg * 0.5;
          tor[v3 + 2] = tcz + nz * w * sg * 0.5;
          col[v3] = tmp.r; col[v3 + 1] = tmp.g; col[v3 + 2] = tmp.b;
          wbias[vi] = p.warmBias;
          seedA[vi] = seedV;
          alpha[vi] = aV;
          vi++;
        }
      }
      // 索引：每段两个三角形
      for (var s2 = 0; s2 < segs; s2++) {
        var b = (j * pts + s2) * 2;
        idx[ii++] = b; idx[ii++] = b + 1; idx[ii++] = b + 2;
        idx[ii++] = b + 1; idx[ii++] = b + 3; idx[ii++] = b + 2;

        // 中心亮丝：与绸带面同一条中心线
        var a3i = s2 * 3, b3i = (s2 + 1) * 3;
        var t01a = s2 / segs, t01b = (s2 + 1) / segs;
        var angA = t01a * TAU, angB = t01b * TAU;
        var rTa = p.torusR + 0.22 * Math.sin(angA * 2 + p.torusPhase);
        var rTb = p.torusR + 0.22 * Math.sin(angB * 2 + p.torusPhase);
        for (var q = 0; q < 2; q++) {
          var v3s = spi * 3;
          var src = q === 0 ? a3i : b3i;
          var ang = q === 0 ? angA : angB;
          var rTq = q === 0 ? rTa : rTb;
          var tq = q === 0 ? t01a : t01b;
          sp[v3s] = cpos[src]; sp[v3s + 1] = cpos[src + 1]; sp[v3s + 2] = cpos[src + 2];
          st[v3s] = Math.cos(ang) * rTq;
          st[v3s + 1] = p.torusY + 0.10 * Math.sin(ang * 3 + p.torusPhase);
          st[v3s + 2] = Math.sin(ang) * rTq;
          var sb = 0.66 + 0.42 * Math.abs(Math.sin(tq * 6.0 + p.p2));
          sc[v3s] = spineCol.r * sb; sc[v3s + 1] = spineCol.g * sb; sc[v3s + 2] = spineCol.b * sb;
          sw[spi] = p.warmBias;
          ss[spi] = p.seed * 0.7 + tq * 0.3;
          sa[spi] = p.spineAlpha * aMul * (0.2 + 0.95 * Math.pow(Math.sin(Math.PI * tq), 0.5));
          spi++;
        }
      }
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aTorus', new THREE.BufferAttribute(tor, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aWarmBias', new THREE.BufferAttribute(wbias, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seedA, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));

    var spineGeo = new THREE.BufferGeometry();
    spineGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    spineGeo.setAttribute('aTorus', new THREE.BufferAttribute(st, 3));
    spineGeo.setAttribute('aColor', new THREE.BufferAttribute(sc, 3));
    spineGeo.setAttribute('aWarmBias', new THREE.BufferAttribute(sw, 1));
    spineGeo.setAttribute('aSeed', new THREE.BufferAttribute(ss, 1));
    spineGeo.setAttribute('aAlpha', new THREE.BufferAttribute(sa, 1));

    return { geo: geo, spine: spineGeo };
  }

  /* --------------------------------------------------------- 细丝（LineSegments） */
  function buildThreads(R, count, pts, seed, pal) {
    var rnd = rngFactory(seed);
    var segs = pts - 1;
    var vcount = count * segs * 2;
    var pos = new Float32Array(vcount * 3);
    var tor = new Float32Array(vcount * 3);
    var col = new Float32Array(vcount * 3);
    var wbias = new Float32Array(vcount);
    var seedA = new Float32Array(vcount);
    var alpha = new Float32Array(vcount);
    var cpos = new Float32Array(pts * 3);
    var C = palColors(pal);
    var cool = new THREE.Color(), tmp = new THREE.Color();
    var vi = 0;

    for (var j = 0; j < count; j++) {
      var p = makeRibbonParams(rnd, 'thread');
      fillCenterline(cpos, pts, p, R, R * 0.20);
      if (p.warmSilk) {
        cool.copy(C.amber).lerp(C.warm, 0.4 + 0.5 * p.coolMix);
      } else {
        cool.copy(C.mintDeep).lerp(C.mintGlow, 0.35 + 0.65 * p.coolMix);
        cool.lerp(C.mintLight, p.coolMix * 0.5);
        cool.lerp(C.white, p.whiteMix * 0.8);
      }

      for (var k = 0; k < segs; k++) {
        var a3i = k * 3, b3i = (k + 1) * 3;
        var t01 = k / segs;
        var u = p.start + t01 * p.span;
        var taper = 0.45 + 0.55 * Math.pow(Math.sin(Math.PI * (t01 * 0.9 + 0.05)), 0.5);
        var aa = p.alphaMul * taper * (0.55 + 0.45 * Math.abs(Math.sin(u * 1.8 + p.p2)));
        var seedV = p.seed * 0.8 + t01 * 0.2;
        tmp.copy(cool).multiplyScalar(0.55 + 0.6 * Math.abs(Math.sin(u * 1.2 + p.p5)));

        var angA = t01 * TAU, angB = (t01 + 1 / segs) * TAU;
        var rTa = p.torusR + 0.22 * Math.sin(angA * 2 + p.torusPhase);
        var rTb = p.torusR + 0.22 * Math.sin(angB * 2 + p.torusPhase);
        var pairs = [
          cpos[a3i], cpos[a3i + 1], cpos[a3i + 2], Math.cos(angA) * rTa, p.torusY, Math.sin(angA) * rTa,
          cpos[b3i], cpos[b3i + 1], cpos[b3i + 2], Math.cos(angB) * rTb, p.torusY, Math.sin(angB) * rTb
        ];
        for (var q = 0; q < 2; q++) {
          var v3 = vi * 3, o = q * 6;
          pos[v3] = pairs[o]; pos[v3 + 1] = pairs[o + 1]; pos[v3 + 2] = pairs[o + 2];
          tor[v3] = pairs[o + 3]; tor[v3 + 1] = pairs[o + 4]; tor[v3 + 2] = pairs[o + 5];
          col[v3] = tmp.r; col[v3 + 1] = tmp.g; col[v3 + 2] = tmp.b;
          wbias[vi] = p.warmBias;
          seedA[vi] = seedV;
          alpha[vi] = aa;
          vi++;
        }
      }
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aTorus', new THREE.BufferAttribute(tor, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aWarmBias', new THREE.BufferAttribute(wbias, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seedA, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    return geo;
  }

  /* ------------------------------------------------------------- 点云 */
  function buildDust(R, count, seed, pal) {
    var rnd = rngFactory(seed);
    var pos = new Float32Array(count * 3);
    var tor = new Float32Array(count * 3);
    var col = new Float32Array(count * 3);
    var wbias = new Float32Array(count);
    var seedA = new Float32Array(count);
    var alpha = new Float32Array(count);
    var sizes = new Float32Array(count);
    var C = palColors(pal);
    var cool = new THREE.Color(), tmp = new THREE.Color();

    for (var i = 0; i < count; i++) {
      var i3 = i * 3;
      // 体积分布：内部 55% + 外壳 45%
      var shell = rnd() < 0.62;
      var r = shell ? R * (0.86 + 0.40 * rnd()) : R * (0.18 + Math.pow(rnd(), 0.7) * 0.70);
      if (rnd() < 0.30) r = R * (1.00 + 0.05 * rnd());   // 一层极细的球壳点阵 → 勾出球轮廓
      var ct = rnd() * 2 - 1;
      var st = Math.sqrt(Math.max(0, 1 - ct * ct));
      var ph = rnd() * TAU;
      pos[i3] = st * Math.cos(ph) * r;
      pos[i3 + 1] = ct * r * 0.90;
      pos[i3 + 2] = st * Math.sin(ph) * r;

      var ang = rnd() * TAU;
      var rT = 1.30 + 1.35 * rnd();
      tor[i3] = Math.cos(ang) * rT;
      tor[i3 + 1] = (rnd() - 0.5) * 0.42;
      tor[i3 + 2] = Math.sin(ang) * rT;

      var amberish = rnd() < 0.16;
      if (amberish) {
        cool.copy(C.amber).lerp(C.warm, rnd());
        wbias[i] = 0.6 + 0.4 * rnd();
      } else {
        cool.copy(C.mint).lerp(C.mintLight, rnd() * 0.8);
        wbias[i] = 0.03 + 0.28 * rnd();
      }
      tmp.copy(cool).multiplyScalar(0.45 + 0.6 * rnd());
      col[i3] = tmp.r; col[i3 + 1] = tmp.g; col[i3 + 2] = tmp.b;
      seedA[i] = rnd();
      alpha[i] = 0.015 + 0.11 * Math.pow(rnd(), 2.4);
      sizes[i] = (rnd() < 0.006 ? 0.09 + 0.09 * rnd() : 0.012 + 0.042 * rnd());
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aTorus', new THREE.BufferAttribute(tor, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aWarmBias', new THREE.BufferAttribute(wbias, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seedA, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    return geo;
  }
  /* --------------------------------------------------- 竖向光雨（GPU 位移） */
  function buildRain(count, seed) {
    var rnd = rngFactory(seed);
    var RANGE = 4.6;   // y 轴收窄：只在中段下落（约 20%–80% 高度），不越上下 HUD 区
    var pos = new Float32Array(count * 2 * 3);
    var baseY = new Float32Array(count * 2);
    var speed = new Float32Array(count * 2);
    var fade = new Float32Array(count * 2);
    var seedA = new Float32Array(count * 2);
    var vi = 0;
    for (var i = 0; i < count; i++) {
      var x = (rnd() - 0.5) * 22;
      var z = -7.5 + rnd() * 11;
      var by = (rnd() - 0.5) * RANGE;
      var len = 0.10 + rnd() * 0.62;
      var sp = 1.1 + rnd() * 3.0;
      var fd = 0.10 + 0.34 * Math.pow(rnd(), 1.5);
      var sd = rnd();
      for (var q = 0; q < 2; q++) {
        var v3 = vi * 3;
        pos[v3] = x;
        pos[v3 + 1] = q === 0 ? 0 : len;
        pos[v3 + 2] = z;
        baseY[vi] = by;
        speed[vi] = sp;
        fade[vi] = fd;
        seedA[vi] = sd;
        vi++;
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aBaseY', new THREE.BufferAttribute(baseY, 1));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
    geo.setAttribute('aFade', new THREE.BufferAttribute(fade, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seedA, 1));
    return geo;
  }

  /* --------------------------------------------------------------- 星野 */
  function buildStars(count, seed, pal) {
    var rnd = rngFactory(seed);
    var pos = new Float32Array(count * 3);
    var col = new Float32Array(count * 3);
    var seedA = new Float32Array(count);
    var sizes = new Float32Array(count);
    var C = palColors(pal);
    var tmps = new THREE.Color();
    for (var i = 0; i < count; i++) {
      var i3 = i * 3;
      pos[i3] = (rnd() - 0.5) * 34;
      pos[i3 + 1] = (rnd() - 0.5) * 20;
      pos[i3 + 2] = -4 - rnd() * 20;
      tmps.copy(C.mintLight).lerp(C.white, rnd() * 0.8);
      if (rnd() < 0.1) tmps.copy(C.amber);
      var k = 0.30 + 0.7 * rnd();
      col[i3] = tmps.r * k; col[i3 + 1] = tmps.g * k; col[i3 + 2] = tmps.b * k;
      seedA[i] = rnd();
      sizes[i] = 0.04 + 0.16 * Math.pow(rnd(), 2);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seedA, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    return geo;
  }

  /* --------------------------------------------------- 轨道环 + 环上节点 */
  function buildRingGeometry(radius, segs) {
    var arr = new Float32Array((segs + 1) * 3);
    for (var i = 0; i <= segs; i++) {
      var a = (i / segs) * TAU;
      arr[i * 3] = Math.cos(a) * radius;
      arr[i * 3 + 1] = Math.sin(a) * radius;
      arr[i * 3 + 2] = 0;
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    return geo;
  }

  // 三环各自倾斜后，把环上的小节点位置烘焙进同一个 Points
  function buildRingNodes(rings, seed, pal) {
    var rnd = rngFactory(seed);
    var list = [];
    for (var r = 0; r < rings.length; r++) {
      var rg = rings[r];
      var e = new THREE.Euler(rg.rx, rg.ry, rg.rz, 'XYZ');
      var m = new THREE.Matrix4().makeRotationFromEuler(e);
      var n = rg.nodes;
      for (var i = 0; i < n; i++) {
        var a = rnd() * TAU;
        var v = new THREE.Vector3(Math.cos(a) * rg.radius, Math.sin(a) * rg.radius, 0);
        v.applyMatrix4(m);
        list.push({ v: v, big: rnd() < 0.16, amber: rnd() < 0.3 });
      }
    }
    var count = list.length;
    var pos = new Float32Array(count * 3);
    var col = new Float32Array(count * 3);
    var sizes = new Float32Array(count);
    var seedA = new Float32Array(count);
    var C = palColors(pal);
    var tmps = new THREE.Color();
    for (var k = 0; k < count; k++) {
      var it = list[k];
      pos[k * 3] = it.v.x; pos[k * 3 + 1] = it.v.y; pos[k * 3 + 2] = it.v.z;
      tmps.copy(it.amber ? C.amber : C.mintGlow).lerp(C.white, 0.25 + rnd() * 0.5);
      col[k * 3] = tmps.r; col[k * 3 + 1] = tmps.g; col[k * 3 + 2] = tmps.b;
      sizes[k] = it.big ? 0.20 + rnd() * 0.26 : 0.028 + rnd() * 0.06;
      seedA[k] = rnd();
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seedA, 1));
    return geo;
  }

  /* --------------------------------------------------- 光速穿梭：速度线 */
  function buildStreaks(count, seed, pal) {
    var rnd = rngFactory(seed);
    var pos = new Float32Array(count * 2 * 3);
    var dir = new Float32Array(count * 2 * 3);
    var col = new Float32Array(count * 2 * 3);
    var seedA = new Float32Array(count * 2);
    var C = palColors(pal);
    var tmps = new THREE.Color();
    for (var i = 0; i < count; i++) {
      // 偏水平方向（视频里是横向光带）
      var a = (rnd() - 0.5) * 2.2 + (rnd() < 0.5 ? 0 : Math.PI);
      var y = (rnd() - 0.5) * 8.8;
      var zz = (rnd() - 0.5) * 7;
      var x0 = (rnd() - 0.5) * 2.4;
      var yt = y + (rnd() - 0.5) * 1.6;
      var dx = Math.cos(a) * 0.9, dy = Math.sin(a) * 0.18 + (yt - y) * 0.02;
      var dl = Math.sqrt(dx * dx + dy * dy) || 1e-4;
      dx /= dl; dy /= dl;
      var len = 0.5 + rnd() * 2.4;
      tmps.copy(rnd() < 0.35 ? C.mintLight : C.white).lerp(C.warm, rnd() * 0.35);
      for (var q = 0; q < 2; q++) {
        var vi = i * 2 + q, v3 = vi * 3;
        pos[v3] = x0 + dx * (q === 0 ? 0 : len);
        pos[v3 + 1] = y + dy * (q === 0 ? 0 : len);
        pos[v3 + 2] = zz;
        dir[v3] = dx; dir[v3 + 1] = dy; dir[v3 + 2] = 0;
        col[v3] = tmps.r; col[v3 + 1] = tmps.g; col[v3 + 2] = tmps.b;
        seedA[vi] = rnd();
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seedA, 1));
    return geo;
  }

  /* ======================================================================== */
  /*                              场景工厂                                    */
  /* ======================================================================== */
  JV.registerScene('orb', function createOrb(ctx) {
    var pal = ctx.palette;
    var bus = ctx.bus;
    var U = ctx.util;

    var group = new THREE.Group();
    group.name = 'orb';
    var rig = new THREE.Group();       // 球体 / 环 / 数值：随呼吸旋转缩放
    var rainGroup = new THREE.Group(); // 光雨：不随球体自转
    var starGroup = new THREE.Group();
    group.add(rig, rainGroup, starGroup);

    /* ------------------------------------------------- 共享 uniform（单一真源） */
    var UNI = {
      uTime: { value: 0 },
      uMorph: { value: 0 },
      uWarm: { value: 0.1 },
      uOpacity: { value: 1 },
      uDustOpacity: { value: 1 },
      uSpread: { value: 0 },
      uPulse: { value: 0 },
      uCore: { value: 1 },
      uRainOpacity: { value: 1 },
      uRainSpeed: { value: 1 },
      uStarOpacity: { value: 0.55 },
      uPixel: { value: 1 },
      uWarp: { value: 0 },
      uWarmColor: { value: new THREE.Color(pal.warm) },
      uShellOpacity: { value: 0.09 }
    };

    /* ------------------------------------------------------------- 着色器 */
    var RIBBON_VS = [
      'uniform float uTime; uniform float uMorph; uniform float uWarm; uniform float uOpacity;',
      'uniform float uSpread; uniform float uPulse; uniform vec3 uWarmColor;',
      'attribute vec3 aTorus; attribute vec3 aColor; attribute float aWarmBias;',
      'attribute float aSeed; attribute float aAlpha;',
      'varying vec3 vColor; varying float vAlpha;',
      'void main() {',
      '  vec3 p = mix(position, aTorus, uMorph);',
      '  float rad = length(p) + 1e-4;',
      '  p *= 1.0 + uSpread * (0.20 + 0.16 * sin(aSeed * 31.0));',
      '  p *= 1.0 + uPulse * (0.35 + 0.5 * sin(aSeed * 47.0));',
      '  float wob = sin(uTime * 0.85 + aSeed * 23.0 + rad * 1.7);',
      '  p += normalize(p + vec3(0.0, 0.03, 0.0)) * wob * (0.040 * (1.0 - uMorph) + 0.006);',
      '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
      '  gl_Position = projectionMatrix * mv;',
      '  float tone = clamp(uWarm * (0.45 + 1.60 * aWarmBias), 0.0, 1.0);',
      '  vColor = mix(aColor, uWarmColor, tone);',
      '  vAlpha = uOpacity * aAlpha * (0.58 + 0.42 * sin(uTime * 1.6 + aSeed * 43.0));',
      '}'
    ].join('\n');

    var RIBBON_FS = [
            'uniform float uPulse;',
      'varying vec3 vColor; varying float vAlpha;',
      'void main() {',
      '  gl_FragColor = vec4(vColor * (0.88 + uPulse * 1.6), max(vAlpha, 0.0));',
      '}'
    ].join('\n');

    var DUST_VS = [
      'uniform float uTime; uniform float uMorph; uniform float uWarm; uniform float uDustOpacity;',
      'uniform float uSpread; uniform float uPulse; uniform float uPixel; uniform vec3 uWarmColor;',
      'attribute vec3 aTorus; attribute vec3 aColor; attribute float aWarmBias;',
      'attribute float aSeed; attribute float aAlpha; attribute float aSize;',
      'varying vec3 vColor; varying float vAlpha;',
      'void main() {',
      '  vec3 p = mix(position, aTorus, uMorph);',
      '  p *= 1.0 + uSpread * 0.25 + uPulse * 0.4;',
      '  float wob = sin(uTime * 1.1 + aSeed * 37.0);',
      '  p += normalize(p + vec3(0.0, 0.02, 0.0)) * wob * 0.035;',
      '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
      '  gl_Position = projectionMatrix * mv;',
      '  gl_PointSize = clamp(aSize * uPixel * (250.0 / max(0.6, -mv.z)), 0.7, 26.0);',
      '  float tone = clamp(uWarm * (0.45 + 1.60 * aWarmBias), 0.0, 1.0);',
      '  vColor = mix(aColor, uWarmColor, tone);',
      '  vAlpha = uDustOpacity * aAlpha * (0.45 + 0.55 * sin(uTime * 2.2 + aSeed * 61.0));',
      '}'
    ].join('\n');

    var POINTS_FS = [
            'varying vec3 vColor; varying float vAlpha;',
      'void main() {',
      '  float d = length(gl_PointCoord - vec2(0.5));',
      '  float a = smoothstep(0.5, 0.04, d);',
      '  gl_FragColor = vec4(vColor, vAlpha * a);',
      '}'
    ].join('\n');

    var RAIN_VS = [
      'uniform float uTime; uniform float uRainSpeed; uniform float uRainOpacity; uniform float uWarm;',
      'uniform vec3 uWarmColor; uniform float uPixel;',
      'attribute float aBaseY; attribute float aSpeed; attribute float aFade; attribute float aSeed;',
      'varying vec3 vColor; varying float vAlpha;',
      'void main() {',
      '  float range = 4.6;',
      '  float y = mod(aBaseY - uTime * aSpeed * uRainSpeed, range) - range * 0.5;',
      '  vec3 p = vec3(position.x, y + position.y, position.z);',
      '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
      '  gl_Position = projectionMatrix * mv;',
      '  float edge = smoothstep(0.5, 0.16, abs(y) / (range * 0.5));',
      '  vAlpha = uRainOpacity * aFade * edge * (0.45 + 0.55 * sin(uTime * 2.4 + aSeed * 51.0));',
      '  vColor = mix(vec3(0.45, 0.95, 0.82), uWarmColor, uWarm * 0.35) * (0.7 + 0.5 * aSeed);',
      '}'
    ].join('\n');

    var STAR_VS = [
      'uniform float uTime; uniform float uStarOpacity; uniform float uPixel;',
      'attribute vec3 aColor; attribute float aSeed; attribute float aSize;',
      'varying vec3 vColor; varying float vAlpha;',
      'void main() {',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  gl_Position = projectionMatrix * mv;',
      '  gl_PointSize = clamp(aSize * uPixel * (240.0 / max(0.6, -mv.z)), 0.6, 18.0);',
      '  vColor = aColor;',
      '  vAlpha = uStarOpacity * (0.35 + 0.65 * abs(sin(uTime * 1.3 + aSeed * 71.0)));',
      '}'
    ].join('\n');

    var STREAK_VS = [
      'uniform float uTime; uniform float uWarp; uniform float uPixel;',
      'attribute vec3 aDir; attribute vec3 aColor; attribute float aSeed;',
      'varying vec3 vColor; varying float vAlpha;',
      'void main() {',
      '  vec3 p = position + aDir * (uWarp * (7.0 + 6.0 * aSeed));',
      '  p *= 1.0 + uWarp * (0.9 + 0.5 * aSeed);',
      '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
      '  gl_Position = projectionMatrix * mv;',
      '  vColor = aColor;',
      '  vAlpha = uWarp * (0.25 + 0.75 * aSeed) * (0.4 + 0.6 * abs(sin(uTime * 9.0 + aSeed * 33.0)));',
      '}'
    ].join('\n');

    var STREAK_FS = [
            'varying vec3 vColor; varying float vAlpha;',
      'void main() { gl_FragColor = vec4(vColor, vAlpha); }'
    ].join('\n');

    var CORE_VS = [
      'varying vec3 vN; varying vec3 vV;',
      'void main() {',
      '  vN = normalize(normalMatrix * normal);',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  vV = normalize(-mv.xyz);',
      '  gl_Position = projectionMatrix * mv;',
      '}'
    ].join('\n');

    var CORE_FS = [
            'uniform float uTime; uniform float uCore; uniform float uWarm; uniform vec3 uWarmColor;',
      'varying vec3 vN; varying vec3 vV;',
      'void main() {',
      '  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.0);',
      '  vec3 cool = vec3(0.72, 1.0, 0.92);',
      '  vec3 c = mix(cool, uWarmColor, uWarm * 0.8);',
      '  float a = (0.14 + f * 0.20) * uCore * (0.9 + 0.1 * sin(uTime * 2.1));',
      '  gl_FragColor = vec4(c * (0.75 + f * 0.85) * uCore, a);',
      '}'
    ].join('\n');

    var GLASS_FS = [
      'uniform float uTime; uniform float uShellOpacity; uniform float uWarm; uniform vec3 uWarmColor;',
      'varying vec3 vN; varying vec3 vV;',
      'void main() {',
      '  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.6);',
      '  vec3 c = mix(vec3(0.50, 1.0, 0.84), uWarmColor, uWarm * 0.4);',
      '  float a = f * uShellOpacity * (0.85 + 0.15 * sin(uTime * 0.8));',
      '  gl_FragColor = vec4(c, a);',
      '}'
    ].join('\n');

    function shaderMat(vs, fs) {
      return new THREE.ShaderMaterial({
        uniforms: UNI, vertexShader: vs, fragmentShader: fs,
        transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, depthTest: false
      });
    }

    /* --------------------------------------------------------------- 纹理 */
    var glowTex = makeGlowTexture();

    /* ------------------------------------------------------- 1. 亮核 */
    var coreMat = shaderMat(CORE_VS, CORE_FS);
    var coreMesh = new THREE.Mesh(new THREE.SphereGeometry(0.30, 20, 14), coreMat);
    rig.add(coreMesh);

    var coreSpriteMat = new THREE.SpriteMaterial({
      map: glowTex, transparent: true, opacity: 0.85, color: new THREE.Color(pal.mintLight),
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
    });
    var coreSprite = new THREE.Sprite(coreSpriteMat);
    coreSprite.scale.set(0.70, 0.70, 1);
    rig.add(coreSprite);

    // 核心外面的柔和光晕（大而极淡，避免中心堆成白块）
    var haloMat = new THREE.SpriteMaterial({
      map: glowTex, transparent: true, opacity: 0.10, color: new THREE.Color(pal.mintGlow),
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
    });
    var haloSprite = new THREE.Sprite(haloMat);
    haloSprite.scale.set(3.1, 3.1, 1);
    rig.add(haloSprite);

    // 极淡的菲涅尔球壳：把"大球"的轮廓勾出一圈，只画 rim
    var glassMat = shaderMat(CORE_VS, GLASS_FS);
    glassMat.side = THREE.BackSide;
    var glass = new THREE.Mesh(new THREE.SphereGeometry(ORB_R * 1.06, 44, 28), glassMat);
    glass.frustumCulled = false;
    rig.add(glass);

    var flashMat = new THREE.SpriteMaterial({
      map: glowTex, transparent: true, opacity: 0, color: new THREE.Color(pal.white),
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
    });
    var flashSprite = new THREE.Sprite(flashMat);
    flashSprite.scale.set(3, 3, 1);
    rig.add(flashSprite);

    /* --------------------------------------------------- 2. 多边形外壳 */
    var shellMat = new THREE.LineBasicMaterial({
      color: new THREE.Color(pal.mintGlow), transparent: true, opacity: 0.13,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
    });
    var shell = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.72, 1)), shellMat);
    rig.add(shell);

    /* ------------------------------------------- 3. 丝带 / 细丝 / 点云 */
    var bandMat = shaderMat(RIBBON_VS, RIBBON_FS);
    var spineMat = shaderMat(RIBBON_VS, RIBBON_FS);
    var threadMat = shaderMat(RIBBON_VS, RIBBON_FS);
    var dustMat = shaderMat(DUST_VS, POINTS_FS);

    var bands = new THREE.Mesh(new THREE.BufferGeometry(), bandMat);
    var bandSpines = new THREE.LineSegments(new THREE.BufferGeometry(), spineMat);
    var threads = new THREE.LineSegments(new THREE.BufferGeometry(), threadMat);
    var dust = new THREE.Points(new THREE.BufferGeometry(), dustMat);
    bands.frustumCulled = bandSpines.frustumCulled = threads.frustumCulled = dust.frustumCulled = false;
    rig.add(bands, bandSpines, threads, dust);

    /* ----------------------------------------- 4. 倾斜虚线轨道环 + 节点 */
    var RING_DEF = [
      { radius: 2.95, rx: -1.16, ry: 0.0, rz: 0.34, speed: 0.052, color: pal.mintGlow, opMul: 1.0, nodes: 26 },
      { radius: 3.52, rx: -1.36, ry: 0.2, rz: -0.52, speed: -0.038, color: pal.amber, opMul: 0.78, nodes: 30 },
      { radius: 4.12, rx: -0.86, ry: -0.3, rz: 0.92, speed: 0.030, color: pal.mintLight, opMul: 0.55, nodes: 34 }
    ];
    var ringGroup = new THREE.Group();
    rig.add(ringGroup);
    var rings = [];
    RING_DEF.forEach(function (def, i) {
      var g = new THREE.Group();
      g.rotation.set(def.rx, def.ry, def.rz);
      var geo = buildRingGeometry(def.radius, 220);
      var mat = new THREE.LineDashedMaterial({
        color: new THREE.Color(def.color), transparent: true, opacity: 0.4,
        dashSize: 0.035, gapSize: 0.06,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
      });
      var line = new THREE.Line(geo, mat);
      line.computeLineDistances();
      g.add(line);
      ringGroup.add(g);
      rings.push({ group: g, line: line, mat: mat, def: def, index: i, radius: def.radius, rx: def.rx, ry: def.ry, rz: def.rz, spin: 0 });
    });
    var nodeMat = shaderMat(STAR_VS, POINTS_FS);
    var ringNodes = new THREE.Points(buildRingNodes(
      RING_DEF.map(function (d) { return { radius: d.radius, rx: d.rx, ry: d.ry, rz: d.rz, nodes: d.nodes }; }), 9, pal), nodeMat);
    ringNodes.frustumCulled = false;
    ringGroup.add(ringNodes);

    /* ------------------------------------------------- 5. 漂浮数值 Sprite */
    var NUM_DEF = [
      { base: NUM_BASE[0], color: pal.mintGlow, x: -2.62, y: 1.62, z: 0.55, ph: 0.0, drift: 0.20 },
      { base: NUM_BASE[1], color: pal.amber, x: -0.86, y: 2.12, z: -0.5, ph: 1.1, drift: 0.26 },
      { base: NUM_BASE[2], color: pal.mintLight, x: -3.12, y: 0.30, z: 0.15, ph: 2.2, drift: 0.18 },
      { base: NUM_BASE[3], color: pal.amber, x: 2.98, y: 0.62, z: -0.35, ph: 3.0, drift: 0.22 },
      { base: NUM_BASE[4], color: pal.amber, x: 2.58, y: -0.62, z: 0.5, ph: 4.1, drift: 0.16 },
      { base: NUM_BASE[5], color: pal.mintGlow, x: 2.12, y: -1.72, z: 0.35, ph: 5.2, drift: 0.24 }
    ];
    var numbers = [];
    NUM_DEF.forEach(function (d) {
      var o = makeNumberSprite(d.base, d.color, 0.85);
      o.sprite.position.set(d.x, d.y, d.z);
      o.def = d;
      rig.add(o.sprite);
      numbers.push(o);
    });
    var numTimer = 0, numIndex = 0;

    /* ---------------------------------------------- 6. 竖向光雨 / 星野 */
    var rainMat = shaderMat(RAIN_VS, RIBBON_FS);
    var rain = new THREE.LineSegments(new THREE.BufferGeometry(), rainMat);
    rain.frustumCulled = false;
    rainGroup.add(rain);

    var starMat = shaderMat(STAR_VS, POINTS_FS);
    var stars = new THREE.Points(new THREE.BufferGeometry(), starMat);
    stars.frustumCulled = false;
    starGroup.add(stars);

    /* ---------------------------------------------- 7. 光速穿梭配件 */
    var streakMat = shaderMat(STREAK_VS, STREAK_FS);
    var streaks = new THREE.LineSegments(new THREE.BufferGeometry(), streakMat);
    streaks.frustumCulled = false;
    streaks.visible = false;
    rig.add(streaks);

    var bandSpriteMat = new THREE.SpriteMaterial({
      map: glowTex, transparent: true, opacity: 0, color: new THREE.Color(pal.white),
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
    });
    var bandSprite = new THREE.Sprite(bandSpriteMat);
    bandSprite.material.rotation = -0.30;
    bandSprite.scale.set(2, 0.7, 1);
    rig.add(bandSprite);

    /* ------------------------------------------------------- 质量与重建 */
    var quality = ctx.quality || 'high';

    function disposeGeo(obj) {
      if (obj && obj.geometry) obj.geometry.dispose();
    }
    function rebuild(q) {
      quality = q;
      var B = BUDGET[q] || BUDGET.high;
      disposeGeo(bands); disposeGeo(bandSpines); disposeGeo(threads); disposeGeo(dust);
      disposeGeo(rain); disposeGeo(stars); disposeGeo(streaks);
      disposeGeo(shell); disposeGeo(ringNodes);
      var bandBuild = buildBands(ORB_R, B.bands, BAND_PTS, 20240601, pal);
      bands.geometry = bandBuild.geo;
      bandSpines.geometry = bandBuild.spine;
      threads.geometry = buildThreads(ORB_R, B.threads, THREAD_PTS, 771003, pal);
      dust.geometry = buildDust(ORB_R, B.dust, 199311, pal);
      rain.geometry = buildRain(B.rain, 424242);
      stars.geometry = buildStars(B.stars, 50501, pal);
      streaks.geometry = buildStreaks(180, 8080, pal);
      shell.geometry = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.72, 1));
      shell.visible = !!B.shell;
      rings[2].group.visible = !!B.ring3;
      ringNodes.geometry = buildRingNodes(
        RING_DEF.map(function (d) {
          return { radius: d.radius, rx: d.rx, ry: d.ry, rz: d.rz, nodes: Math.round(d.nodes * (q === 'low' ? 0.5 : 1)) };
        }), 9, pal);
    }
    rebuild(quality);

    /* ----------------------------------------------------------- 状态机 */
    var WARP_DUR = 2.5, SHUT_DUR = 1.8, POWER_DUR = 0.9;

    var mode = 'idle', prevMode = 'idle', modeT = 0;
    var updN = 0, updT = -1;
    var level = 0, levelTarget = 0;
    var spinAngle = 0;
    var fitScale = 1;
    var handTiltX = 0, handTiltY = 0;

    var IDLE = {
      morph: 0, warm: 0.10, spread: 0, opacity: 1, ringOpacity: 0.38, ringScale: 1,
      rainOpacity: 0.26, rainSpeed: 1, starOpacity: 0.42, core: 1, scale: 1,
      spin: 0.06, tilt: -0.16, streak: 0, flash: 0, dustOpacity: 1
    };
    var TGT = {}, CUR = {};
    var KEYS = Object.keys(IDLE);
    function resetParams() { var k; for (k = 0; k < KEYS.length; k++) { TGT[KEYS[k]] = IDLE[KEYS[k]]; CUR[KEYS[k]] = IDLE[KEYS[k]]; } }
    resetParams();

    function idleTargets(o, lv) {
      o.morph = 0; o.warm = 0.10 + lv * 0.06; o.spread = 0; o.opacity = 1;
      o.ringOpacity = 0.38; o.ringScale = 1; o.rainOpacity = 0.26; o.rainSpeed = 1;
      o.starOpacity = 0.42; o.core = 1; o.scale = 1; o.spin = 0.06; o.tilt = -0.16;
      o.streak = 0; o.flash = 0; o.dustOpacity = 1;
    }

    function targetsFor(m, mt, lv) {
      var p, e;
      switch (m) {
        case 'listen':
          TGT.morph = 0.14; TGT.warm = 0.24 + lv * 0.22; TGT.spread = 0.52 + lv * 0.30;
          TGT.opacity = 1.05; TGT.ringOpacity = 0.62; TGT.ringScale = 1.03;
          TGT.rainOpacity = 0.38 + lv * 0.16; TGT.rainSpeed = 1.7; TGT.starOpacity = 0.5;
          TGT.core = 1.15 + lv * 0.2; TGT.scale = 1.02 + lv * 0.03; TGT.spin = 0.10;
          TGT.tilt = -0.10; TGT.streak = 0; TGT.flash = 0; TGT.dustOpacity = 1.1;
          break;
        case 'think':
          TGT.morph = 1; TGT.warm = 0.58 + lv * 0.12; TGT.spread = 0.14;
          TGT.opacity = 1.0; TGT.ringOpacity = 0.8; TGT.ringScale = 1.0;
          TGT.rainOpacity = 0.22; TGT.rainSpeed = 2.2; TGT.starOpacity = 0.4;
          TGT.core = 0.85; TGT.scale = 0.98; TGT.spin = 0.55; TGT.tilt = -0.98;
          TGT.streak = 0; TGT.flash = 0; TGT.dustOpacity = 1;
          break;
        case 'speak':
          TGT.morph = 0.10; TGT.warm = 0.74 + lv * 0.18; TGT.spread = 0.34 + lv * 0.16;
          TGT.opacity = 1.05; TGT.ringOpacity = 0.55; TGT.ringScale = 1.02;
          TGT.rainOpacity = 0.30; TGT.rainSpeed = 1.2; TGT.starOpacity = 0.4;
          TGT.core = 1.0 + lv * 0.28; TGT.scale = 1 + lv * 0.04; TGT.spin = 0.16;
          TGT.tilt = -0.2; TGT.streak = 0; TGT.flash = 0; TGT.dustOpacity = 1;
          break;
        case 'warp':
          p = clamp01(mt / WARP_DUR);
          e = p < 0.26 ? smoothstep01(p / 0.26) : (p < 0.80 ? 1 : 1 - smoothstep01((p - 0.80) / 0.20));
          idleTargets(TGT, lv);
          TGT.streak = e; TGT.scale = 1 - 0.26 * e;
          TGT.ringOpacity = 0.42 + 0.75 * e; TGT.ringScale = 1 + 1.5 * e;
          TGT.rainOpacity = 0.26 + 0.55 * e; TGT.rainSpeed = 1 + 7 * e;
          TGT.starOpacity = 0.55 + 1.0 * e; TGT.core = 1 + 1.3 * e;
          TGT.warm = 0.10 + 0.30 * e; TGT.spin = 0.06 + 0.75 * e;
          TGT.flash = 1.1 * e * (0.7 + 0.3 * Math.sin(mt * 21));
          break;
        case 'shutdown':
          p = clamp01(mt / SHUT_DUR);
          idleTargets(TGT, lv);
          e = smoothstep01(p);
          TGT.morph = 0.25 * smoothstep01(p * 1.6);
          TGT.opacity = 1 - smoothstep01(clamp01((p - 0.12) / 0.88));
          TGT.dustOpacity = 1 - smoothstep01(clamp01((p - 0.3) / 0.7));
          TGT.scale = 1 - 0.86 * e;
          TGT.ringOpacity = 0.42 * (1 - smoothstep01(p * 1.15));
          TGT.ringScale = 1 - 0.25 * e;
          TGT.rainOpacity = 0.26 * (1 - smoothstep01(p * 1.1));
          TGT.rainSpeed = 1 + 2.5 * p;
          TGT.starOpacity = 0.55 * (1 - p * 0.45);
          TGT.core = 1 + 0.6 * Math.sin(clamp01(p / 0.35) * Math.PI) - p * 0.9;
          TGT.spin = 0.06 + 0.5 * e;
          TGT.flash = p < 0.35 ? 1.3 * Math.sin(clamp01(p / 0.35) * Math.PI) : 0;
          break;
        case 'powerOn':
          p = clamp01(mt / POWER_DUR);
          e = easeOutCubic(p);
          idleTargets(TGT, lv);
          TGT.scale = IDLE.scale * (0.03 + 0.97 * e) * (1 + 0.10 * Math.sin(clamp01(p) * Math.PI));
          TGT.opacity = e;
          TGT.dustOpacity = e;
          TGT.ringOpacity = 0.42 * e;
          TGT.rainOpacity = 0.26 * (0.1 + 0.9 * e);
          TGT.starOpacity = 0.55 * (0.15 + 0.85 * e);
          TGT.core = 0.35 + 1.5 * (1 - p) + e * 0.6;
          TGT.spin = 0.06 + 0.5 * (1 - e);
          TGT.flash = 1.7 * Math.pow(1 - e, 2.0);
          break;
        default:
          idleTargets(TGT, lv);
      }
    }

    var RATE = { idle: 3.0, listen: 4.0, think: 3.4, speak: 4.2, warp: 7.0, shutdown: 5.0, powerOn: 9.0 };

    function setMode(m, payload) {
      m = m || 'idle';
      if (m === 'off' || m === 'shutdown') m = 'shutdown';
      if (m !== 'idle' && m !== 'listen' && m !== 'think' && m !== 'speak' &&
        m !== 'warp' && m !== 'shutdown' && m !== 'powerOn') m = 'idle';
      if (m === mode && m !== 'warp' && m !== 'shutdown' && m !== 'powerOn') return;
      prevMode = mode;
      mode = m;
      modeT = 0;
      if (m === 'powerOn') {
        CUR.opacity = 0.02; CUR.scale = 0.03; CUR.flash = 1.4; CUR.dustOpacity = 0.05;
        CUR.ringOpacity = 0.02; CUR.rainOpacity = 0.08; CUR.core = 0.4;
      }
      if (m === 'warp') CUR.streak = 0.02;
      if (m === 'shutdown') { CUR.streak = 0; }
      bus.emit('orb:mode', { mode: m, from: prevMode, payload: payload || null });
    }

    /* --------------------------------------------------------- 尺寸适配 */
    function resize(w, h) {
      var asp = w / Math.max(1, h);
      fitScale = asp < 1 ? Math.max(0.62, Math.min(0.96, asp * 1.12)) : 1;
      UNI.uPixel.value = Math.min(window.devicePixelRatio || 1, 2);
    }
    resize(ctx.size.w, ctx.size.h);
    UNI.uPixel.value = Math.min(ctx.size.dpr || 1, 2);

    /* --------------------------------------------------------- bus 订阅 */
    var onLevel = function (p) { if (p && typeof p.level === 'number') levelTarget = clamp01(p.level); };
    var onHand = function (p) {
      if (!p) return;
      handTiltX = (typeof p.x === 'number') ? (p.x - 0.5) * 2 : 0;
      handTiltY = (typeof p.y === 'number') ? (p.y - 0.5) * 2 : 0;
    };
    bus.on('voice:level', onLevel);
    bus.on('gesture:hand', onHand);

    /* ----------------------------------------------------------- 每帧更新 */
    var tWarm = new THREE.Color(pal.amber).lerp(new THREE.Color(pal.warm), 0.55);
    var tCool = new THREE.Color(pal.mintLight);
    var tWhite = new THREE.Color(pal.white);
    var tmpColor = new THREE.Color();

    function update(t, dt, state) {
      updN++; updT = t;
      if (!(dt > 0)) dt = 0.016;
      if (dt > 0.1) dt = 0.1;
      var lvState = (state && typeof state.level === 'number') ? state.level : 0;
      var lvT = Math.max(clamp01(lvState), levelTarget);
      level = damp(level, lvT, dt, 9);

      modeT += dt;
      if (mode === 'warp' && modeT >= WARP_DUR) { setMode('idle'); }
      if (mode === 'powerOn' && modeT >= POWER_DUR + 0.15) { setMode('idle'); }

      targetsFor(mode, modeT, level);
      var rate = RATE[mode] || 3.2;
      var k, key;
      for (k = 0; k < KEYS.length; k++) {
        key = KEYS[k];
        CUR[key] = damp(CUR[key], TGT[key], dt, rate);
      }

      /* ---- uniform ---- */
      UNI.uTime.value = t;
      UNI.uMorph.value = CUR.morph;
      UNI.uWarm.value = CUR.warm;
      UNI.uOpacity.value = CUR.opacity;
      UNI.uDustOpacity.value = CUR.dustOpacity;
      UNI.uSpread.value = CUR.spread;
      UNI.uPulse.value = 0.026 * Math.sin(t * 0.9) + level * 0.16;
      UNI.uCore.value = CUR.core;
      UNI.uRainOpacity.value = CUR.rainOpacity;
      UNI.uRainSpeed.value = CUR.rainSpeed;
      UNI.uStarOpacity.value = CUR.starOpacity;
      UNI.uWarp.value = CUR.streak;

      /* ---- 主体变换：缓慢漂浮 + 呼吸 ---- */
      spinAngle += CUR.spin * dt * (1 + level * 0.6);
      rig.rotation.y = spinAngle;
      rig.rotation.x = CUR.tilt + handTiltY * 0.16;
      rig.rotation.z = 0.10 * Math.sin(t * 0.23) + handTiltX * 0.12;
      var sc = CUR.scale * fitScale * (1 + level * 0.045 + 0.012 * Math.sin(t * 0.8));
      rig.scale.setScalar(sc);
      group.position.set(
        0.06 * Math.sin(t * 0.31),
        0.10 * Math.sin(t * 0.45) + 0.02 * Math.sin(t * 1.3),
        0
      );

      /* ---- 核心 ---- */
      var coreScale = (0.68 + 0.07 * Math.sin(t * 1.1)) * (1 + level * 0.22) * (0.85 + 0.20 * CUR.core);
      coreSprite.scale.set(coreScale, coreScale, 1);
      tmpColor.copy(tWhite).lerp(tWarm, clamp01(0.25 + CUR.warm * 0.65));
      coreSpriteMat.color.copy(tmpColor);
      coreSpriteMat.opacity = clamp01((0.30 + 0.12 * CUR.core) * (0.85 + 0.15 * Math.sin(t * 1.7)));
      var haloScale = (3.0 + 0.25 * Math.sin(t * 0.9)) * (1 + level * 0.2);
      haloSprite.scale.set(haloScale, haloScale, 1);
      haloMat.opacity = clamp01((0.055 + 0.035 * CUR.core) * CUR.opacity * (0.85 + 0.15 * Math.sin(t * 1.3)));
      haloMat.color.copy(tmpColor);
      UNI.uShellOpacity.value = (0.06 + 0.10 * CUR.spread + 0.03 * level) * (1 - 0.92 * CUR.morph);
      glass.scale.setScalar((1 + CUR.spread * 0.10) * (1 - CUR.morph * 0.55));
      coreMesh.scale.setScalar(0.85 + 0.25 * Math.sin(t * 1.4) + level * 0.25);
      coreMesh.visible = CUR.morph < 0.55;   // think 收束成环时不要留一颗灰球

      /* ---- 外壳 ---- */
      shellMat.opacity = (0.09 + 0.06 * Math.sin(t * 0.7) + CUR.spread * 0.10) * CUR.opacity;
      shell.scale.setScalar((1 + CUR.spread * 0.45) * (1 - CUR.morph * 0.15));
      shell.rotation.y = -t * 0.06;
      shell.rotation.x = 0.2 * Math.sin(t * 0.17);

      /* ---- 轨道环 ---- */
      ringGroup.scale.setScalar(CUR.ringScale);
      for (k = 0; k < rings.length; k++) {
        var rg = rings[k];
        rg.spin += rg.def.speed * dt;
        rg.group.rotation.y = rg.def.ry + rg.spin;
        rg.mat.opacity = clamp01(CUR.ringOpacity * rg.def.opMul);
      }

      /* ---- 光雨 / 星野 ---- */
      rainGroup.rotation.z = 0.012 * Math.sin(t * 0.2);
      rain.position.y = -0.2;

      /* ---- 数值 Sprite ---- */
      numTimer += dt;
      if (numTimer > 0.30) {
        numTimer = 0;
        var o = numbers[numIndex % numbers.length];
        numIndex++;
        var baseV = parseFloat(o.def.base);
        var nv = baseV + (Math.random() - 0.5) * 0.03;
        var txt = nv < 0 ? '-' + Math.abs(nv).toFixed(2) : nv.toFixed(2);
        if (o.def.base === '1.07') txt = (1.05 + Math.random() * 0.05).toFixed(2);
        drawNumber(o, txt, o.def.color);
      }
      for (k = 0; k < numbers.length; k++) {
        var s = numbers[k], d = s.def;
        s.sprite.position.set(
          d.x + d.drift * Math.sin(t * 0.34 + d.ph),
          d.y + d.drift * 0.7 * Math.sin(t * 0.47 + d.ph * 1.7),
          d.z
        );
        var vis = (0.55 + 0.45 * Math.abs(Math.sin(t * 0.8 + d.ph))) * clamp01(CUR.opacity);
        s.sprite.material.opacity = 0.36 * vis * (0.55 + 0.45 * CUR.ringOpacity / 0.42);
        s.sprite.scale.set(0.86, 0.43, 1);
      }

      /* ---- 光速穿梭 ---- */
      streaks.visible = CUR.streak > 0.012;
      streaks.scale.setScalar(1 + CUR.streak * 0.5);
      bandSprite.visible = CUR.streak > 0.02;
      var bs = CUR.streak;
      bandSprite.scale.set(2.2 + 15 * bs, 0.35 + 1.15 * bs, 1);
      bandSpriteMat.opacity = clamp01(bs * (0.5 + 0.35 * Math.sin(t * 13)));
      bandSpriteMat.color.copy(tWhite);

      /* ---- 闪光 ---- */
      var fl = CUR.flash;
      flashSprite.visible = fl > 0.01;
      var fs2 = 2.0 + 5.5 * fl;
      flashSprite.scale.set(fs2, fs2, 1);
      flashMat.opacity = clamp01(fl * 0.62);
      flashMat.color.copy(fl > 0.6 ? tWhite : tWarm);

      UNI.uWarmColor.value.copy(tWarm);
    }

    /* ------------------------------------------------------------- 释放 */
    function dispose() {
      bus.off('voice:level', onLevel);
      bus.off('gesture:hand', onHand);
      if (glowTex) glowTex.dispose();
      group.traverse(function (o) {
        if (o.geometry && o.geometry.dispose) o.geometry.dispose();
        var m = o.material;
        if (!m) return;
        var arr = Array.isArray(m) ? m : [m];
        arr.forEach(function (mm) {
          if (mm.map && mm.map.dispose) mm.map.dispose();
          if (mm.dispose) mm.dispose();
        });
      });
      numbers.forEach(function (o) { if (o.tex && o.tex.dispose) o.tex.dispose(); });
      if (group.parent) group.parent.remove(group);
    }

    /* -------------------------------------------------------- 对外 entity */
    var entity = {
      name: 'orb',
      group: group,
      enter: function (opts) {
        opts = opts || {};
        resetParams();
        spinAngle = 0;
        modeT = 0;
        setMode(opts.mode || 'idle');
        if (typeof opts.level === 'number') levelTarget = clamp01(opts.level);
      },
      setMode: setMode,
      setLevel: function (v) { levelTarget = clamp01(typeof v === 'number' ? v : 0); },
      setQuality: function (q) {
        if (q !== 'high' && q !== 'med' && q !== 'low') q = 'med';
        if (q === quality) return;
        rebuild(q);
      },
      update: update,
      resize: resize,
      pause: function () { /* 交还可见性给 core，无需额外处理 */ },
      dispose: dispose,
      // 调试/自测用
      debugInfo: function () {
        return {
          mode: mode, quality: quality, level: level,
          morph: CUR.morph, warm: CUR.warm, opacity: CUR.opacity,
          spread: CUR.spread, tilt: CUR.tilt, streak: CUR.streak,
          rain: CUR.rainOpacity, ring: CUR.ringOpacity,
          updN: updN, updT: updT, modeT: modeT
        };
      }
    };

    ctx.parent.add(group);
    return entity;
  });
})();
