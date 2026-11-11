/* ============================================================================
 * JARVIS 2.0 · 02-scene-city.js
 * 场景：城市全息沙盘 / 路径导航 / 设备绿光层
 * 形态：build · orbit · route · green · powerOff
 * 依赖：00-core.js（JV / THREE），纯 <script>，IIFE，无 import、无 fetch、不写 DOM。
 *
 * 视觉来源（dyref 实测）：悬浮在星尘里的线框城市沙盘——
 *   · 楼体 = 点状竖直虚线（sparkler 感）+ 极细线框边 + 顶部轮廓
 *   · 街道 = 白/青双线发光光带 + 交点亮点；沙盘边缘一圈亮边
 *   · 底盘 = 贴地的椭圆光池（低视角时收成一条亮带）+ 倒影 + 外围弧线刻度
 *   · 罗盘 = 西/东/北 圆形 canvas 徽标（相机相对摆放，永远左/右/远）
 *   · route = 青绿发光路径（流动光点）+ 「起点」牌 + 终点 pin + 琥珀描边信息牌
 *   · green = 整城青绿设备层 + 9 个设备点位脉冲环与连线
 * ==========================================================================*/
(function () {
  'use strict';

  if (typeof window.JV === 'undefined') {
    console.error('[city] 需要先加载 00-core.js');
    return;
  }
  var JV = window.JV;

  /* ========================================================== 常量 / 小工具 */
  var PX = 5.1;   // 沙盘半宽（x）
  var PZ = 3.3;   // 沙盘半深（z）
  var PLATE_Y = 0.02;

  var TAU = Math.PI * 2;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ease(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function easeOut(t) { t = clamp(t, 0, 1); return 1 - (1 - t) * (1 - t); }

  /* ====================================================== 着色器源码（共用） */
  // 全局共享 uniform（所有材质引用同一批对象，一处更新处处生效）
  function makeUniforms() {
    return {
      uTime: { value: 0 },
      uGrow: { value: 1 },      // 0..1 楼群生长
      uFade: { value: 1 },      // 0..1 整体亮度（关机）
      uGreen: { value: 0 },     // 0..1 青绿设备层
      uDev: { value: 0 },       // 0..1 设备点位
      uRoute: { value: 0 },     // 0..1 路径揭示
      uDim: { value: 1 },       // 城市压暗系数（route 时让路径跳出来）
      uPixel: { value: 1 }
    };
  }

  /* ------------------------------- 点精灵（楼体虚线 / 尘埃 / 光点 / 设备点） */
  var POINT_VS = [
    'attribute vec3 aCol;',
    'attribute float aA;',
    'attribute float aSize;',
    'attribute float aPhase;',
    '#ifdef GROW',
    'attribute float aH;',
    '#endif',
    'uniform float uTime, uGrow, uFade, uGreen, uSizeK, uDrift, uPixel, uDim;',
    '#ifdef DEV',
    'uniform float uDev;',
    '#endif',
    'varying vec3 vCol;',
    'varying float vA;',
    'void main(){',
    '  vec3 p = position;',
    '#ifdef GROW',
    '  float k = clamp((uGrow - aPhase) / 0.45, 0.0, 1.0);',
    '  p.y *= k;',
    '#endif',
    '  p.x += sin(uTime * 0.31 + aPhase * 6.283) * uDrift;',
    '  p.y += cos(uTime * 0.24 + aPhase * 11.0) * uDrift * 0.85;',
    '  p.z += sin(uTime * 0.27 + aPhase * 4.7) * uDrift;',
    '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
    '  gl_Position = projectionMatrix * mv;',
    '  gl_PointSize = aSize * uSizeK * uPixel * (10.0 / max(0.15, -mv.z));',
    '  vCol = mix(aCol, aCol * vec3(0.22, 1.0, 0.62), uGreen);',
    '  vA = aA * uFade;',
    '#ifdef DIM',
    '  vA *= uDim;',
    '#endif',
    '#ifdef DEV',
    '  vA *= uDev;',
    '#endif',
    '#ifdef GROW',
    '  vA *= step(p.y, aH * k + 0.012);',
    '#endif',
    '}'
  ].join('\n');

  var POINT_FS = [
    'varying vec3 vCol;',
    'varying float vA;',
    'void main(){',
    '  if (vA <= 0.002) discard;',
    '  vec2 d = gl_PointCoord - vec2(0.5);',
    '  float r2 = dot(d, d) * 4.0;',
    '  float a = exp(-r2 * 3.1) * (1.0 - smoothstep(0.72, 1.0, r2));',
    '  gl_FragColor = vec4(vCol, vA * a);',
    '}'
  ].join('\n');

  /* -------------------------------------- 光带面片（街道 / 沙盘边框 / 路径） */
  var ROAD_VS = [
    'attribute vec3 aCol;',
    'attribute vec3 aXK;',   // x: 横向 -1..1  y: 类型  z: 流动相位
    'attribute float aA;',
    'attribute float aT;',   // 路径进度
    'uniform float uGrow, uFade, uGreen, uRoute, uDim;',
    'varying vec3 vCol;',
    'varying float vA;',
    'varying float vKind;',
    'varying float vCross;',
    'varying float vT;',
    'varying float vFlow;',
    'void main(){',
    '  vCross = aXK.x; vKind = aXK.y; vFlow = aXK.z; vT = aT;',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  gl_Position = projectionMatrix * mv;',
    '  vCol = mix(aCol, aCol * vec3(0.20, 1.0, 0.58), uGreen);',
    '  vA = aA * uFade;',
    '  if (aXK.y < 3.5) vA *= uDim;',
    '  else vA *= step(aT, uRoute);',
    '}'
  ].join('\n');

  var ROAD_FS = [
    'uniform float uTime, uGreen;',
    'varying vec3 vCol;',
    'varying float vA;',
    'varying float vKind;',
    'varying float vCross;',
    'varying float vT;',
    'varying float vFlow;',
    'void main(){',
    '  float c = vCross;',
    '  float core = exp(-c * c * 11.0);',
    '  float glow = exp(-c * c * 2.6);',
    '  float pulse = 0.86 + 0.14 * sin(uTime * 1.35 + vFlow * 6.283);',
    '  vec3 col = vCol;',
    '  float a;',
    '  if (vKind < 0.5) {',
    '    a = vA * (0.035 + glow * 0.155) * pulse;',                 // 街道外晕
    '  } else if (vKind < 1.5) {',
    '    a = vA * (0.18 + core * 0.62) * pulse;',                   // 街道亮芯
    '  } else if (vKind < 2.5) {',
    '    a = vA * 0.88; col *= 1.12;',                              // 街道边线
    '  } else if (vKind < 3.5) {',
    '    a = vA * (0.20 + core * 0.62) * (1.0 + uGreen * 0.90);',     // 沙盘边框（green 补偿）
    '  } else if (vKind < 4.5) {',
    '    a = vA * (0.10 + glow * 0.34) * (1.0 - vT * 0.25);',        // 路径外晕
    '  } else {',
    '    float f = 0.72 + 0.28 * sin(uTime * 5.0 - vT * 26.0);',      // 路径亮芯 + 流光
    '    a = vA * (0.55 + core * 0.70) * f;',
    '    col = mix(col, vec3(0.92, 1.0, 0.97), (1.0 - vT) * 0.22);',
    '  }',
    '  gl_FragColor = vec4(col, a);',
    '}'
  ].join('\n');

  /* -------------------------------------------------- 设备脉冲环（合并绘制） */
  var RING_VS = [
    'attribute vec2 aCen;',
    'attribute vec2 aLoc;',
    'attribute vec3 aCol;',
    'attribute float aA;',
    'attribute float aPhase;',
    'uniform float uTime, uDev, uFade;',
    'varying vec3 vCol;',
    'varying float vA;',
    'void main(){',
    '  float k = fract(uTime * 0.42 + aPhase);',
    '  float s = 0.34 + k * 2.05;',
    '  vA = aA * (0.22 + (1.0 - k) * (1.0 - k)) * uDev * (0.42 + 0.58 * uFade);',
    '  vCol = aCol;',
    '  vec3 p = vec3(aCen.x + aLoc.x * s, 0.075 + aPhase * 0.01, aCen.y + aLoc.y * s);',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);',
    '}'
  ].join('\n');

  var RING_FS = [
    'varying vec3 vCol;',
    'varying float vA;',
    'void main(){',
    '  if (vA <= 0.002) discard;',
    '  gl_FragColor = vec4(vCol, vA);',
    '}'
  ].join('\n');

  /* ================================================= 顶点累加器（构建期用） */
  function Acc() {
    this.pos = []; this.col = []; this.aA = []; this.aSz = [];
    this.aPh = []; this.aH = []; this.aT = []; this.aXK = [];
  }
  // 线/面：单顶点
  Acc.prototype.v = function (x, y, z, r, g, b, a, ph, h) {
    this.pos.push(x, y, z); this.col.push(r, g, b); this.aA.push(a);
    this.aPh.push(ph); this.aH.push(h);
  };
  // 点的附加尺寸
  Acc.prototype.p = function (x, y, z, r, g, b, a, ph, h, sz) {
    this.v(x, y, z, r, g, b, a, ph, h); this.aSz.push(sz);
  };
  // 面片顶点（带横向坐标与类型）
  Acc.prototype.q = function (x, y, z, r, g, b, a, cross, kind, flow, t) {
    this.pos.push(x, y, z); this.col.push(r, g, b); this.aA.push(a);
    this.aXK.push(cross, kind, flow); this.aT.push(t);
  };

  /* ======================================================== 场景主体工厂 */
  JV.registerScene('city', function createCity(ctx) {
    var THREE = ctx.THREE;
    var PAL = ctx.palette;
    var U = ctx.util || JV.util;
    var bus = ctx.bus || JV.bus;

    var UNI = makeUniforms();
    var quality = ctx.quality || 'high';

    /* ------------------------------------------------------------- 组容器 */
    var group = new THREE.Group();
    group.name = 'city-scene';

    // 沙盘组（build 时整体缩放/生长）
    var plateGroup = new THREE.Group();
    plateGroup.name = 'city-plate';
    group.add(plateGroup);

    /* --------------------------------------------------------- 运行状态 */
    var time = 0;
    var modeT = 0;
    var mode = 'build';
    var level = 0;
    var disposed = false;

    // 视觉过渡量
    var grow = 1, fade = 1, greenAmt = 0, devAmt = 0, routeAmt = 0;

    // 相机装置
    var cam = { az: 0.0, el: 0.34, r: 12.4, ty: 0.42, tx: -0.30 };
    var orbitAz = 0;
    var gesture = { x: 0, y: 0, pinch: 0, active: false };
    var gestureSeenNeg = false;

    // 构建期缓存（dispose / setQuality 用）
    var built = null;        // { geoms:[], mats:[], texs:[] }
    var roadAcc = null;      // 街道数据（供 route 复用）
    var routeData = null;    // { pts:Float32Array, samples }

    // 每帧复用的临时量（禁止每帧 new）
    var _v1 = new THREE.Vector3();
    var _v2 = new THREE.Vector3();
    var _c1 = new THREE.Color();

    /* ================================================================ 颜色 */
    function C(hex) { return new THREE.Color(hex); }
    var COL = {
      road: C(PAL.white).lerp(C(PAL.mintLight), 0.22),
      roadGlow: C(PAL.mintGlow),
      rim: C(PAL.mintLight),
      bld: C(PAL.mintLight),
      bldCool: C(PAL.mint),
      bldWarm: C(PAL.amber),
      route: C(PAL.mintGlow),
      routeCore: C(PAL.mintLight),
      green: C(PAL.mint),
      greenDeep: C(PAL.mintDeep),
      amber: C(PAL.amber)
    };

    /* ==================================================== 纹理 / 文字画布 */
    function canvasTex(w, h, draw) {
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var g2 = cv.getContext('2d');
      draw(g2, w, h);
      var tx = new THREE.CanvasTexture(cv);
      tx.minFilter = THREE.LinearFilter;
      tx.magFilter = THREE.LinearFilter;
      tx.generateMipmaps = false;
      return tx;
    }

    function roundRect(g2, x, y, w, h, r) {
      g2.beginPath();
      g2.moveTo(x + r, y);
      g2.lineTo(x + w - r, y);
      g2.quadraticCurveTo(x + w, y, x + w, y + r);
      g2.lineTo(x + w, y + h - r);
      g2.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      g2.lineTo(x + r, y + h);
      g2.quadraticCurveTo(x, y + h, x, y + h - r);
      g2.lineTo(x, y + r);
      g2.quadraticCurveTo(x, y, x + r, y);
      g2.closePath();
    }

    var FONT_ZH = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';

    /* 罗盘徽标：暗底圆 + 细环 + 字 */
    function compassTex(ch, ring) {
      return canvasTex(128, 128, function (g2) {
        g2.clearRect(0, 0, 128, 128);
        // 外柔光
        var gr = g2.createRadialGradient(64, 64, 8, 64, 64, 62);
        gr.addColorStop(0, 'rgba(7,20,22,.92)');
        gr.addColorStop(0.72, 'rgba(5,14,17,.86)');
        gr.addColorStop(1, 'rgba(4,10,12,0)');
        g2.fillStyle = gr;
        g2.beginPath(); g2.arc(64, 64, 62, 0, TAU); g2.fill();
        // 细环
        g2.strokeStyle = ring;
        g2.lineWidth = 2.2;
        g2.beginPath(); g2.arc(64, 64, 43, 0, TAU); g2.stroke();
        // 刻度
        g2.strokeStyle = 'rgba(185,255,232,.5)';
        g2.lineWidth = 1.6;
        for (var i = 0; i < 8; i++) {
          var a = i / 8 * TAU;
          g2.beginPath();
          g2.moveTo(64 + Math.cos(a) * 47, 64 + Math.sin(a) * 47);
          g2.lineTo(64 + Math.cos(a) * 51, 64 + Math.sin(a) * 51);
          g2.stroke();
        }
        // 文字
        g2.fillStyle = '#d8fff1';
        g2.font = '600 40px ' + FONT_ZH;
        g2.textAlign = 'center';
        g2.textBaseline = 'middle';
        g2.fillText(ch, 64, 66);
      });
    }

    /* 「起点」小牌 */
    function startChipTex() {
      return canvasTex(256, 96, function (g2) {
        g2.clearRect(0, 0, 256, 96);
        roundRect(g2, 6, 14, 244, 68, 9);
        g2.fillStyle = 'rgba(6,17,21,.82)';
        g2.fill();
        g2.strokeStyle = 'rgba(180,255,236,.72)';
        g2.lineWidth = 2.2;
        g2.stroke();
        // 左侧小三角指示
        g2.fillStyle = 'rgba(180,255,236,.85)';
        g2.beginPath();
        g2.moveTo(28, 48); g2.lineTo(38, 42); g2.lineTo(38, 54);
        g2.closePath(); g2.fill();
        g2.fillStyle = '#e6fff8';
        g2.font = '500 40px ' + FONT_ZH;
        g2.textAlign = 'left';
        g2.textBaseline = 'middle';
        g2.fillText('起点', 54, 50);
      });
    }

    /* 琥珀信息牌：大唐不夜城 / 38 分钟 · 20.6km · 预计 21:43 到达 */
    function infoCardTex() {
      return canvasTex(760, 200, function (g2) {
        g2.clearRect(0, 0, 760, 200);
        // 牌底
        roundRect(g2, 6, 10, 748, 178, 10);
        g2.fillStyle = 'rgba(11,7,4,.80)';
        g2.fill();
        // 双层琥珀描边（外柔内硬）
        g2.strokeStyle = 'rgba(255,138,61,.32)';
        g2.lineWidth = 6;
        g2.stroke();
        roundRect(g2, 6, 10, 748, 178, 10);
        g2.strokeStyle = 'rgba(255,150,70,.95)';
        g2.lineWidth = 2;
        g2.stroke();
        // 四角短刻线
        g2.strokeStyle = 'rgba(255,196,140,.9)';
        g2.lineWidth = 3;
        var cx = [[6, 10], [754, 10], [6, 188], [754, 188]];
        for (var i = 0; i < 4; i++) {
          var sx = cx[i][0], sy = cx[i][1];
          var dx = (i % 2 === 0) ? 1 : -1, dy = (i < 2) ? 1 : -1;
          g2.beginPath();
          g2.moveTo(sx + dx * 2, sy + dy * 2);
          g2.lineTo(sx + dx * 22, sy + dy * 2);
          g2.moveTo(sx + dx * 2, sy + dy * 2);
          g2.lineTo(sx + dx * 2, sy + dy * 20);
          g2.stroke();
        }
        // 标题
        g2.fillStyle = '#ffd9ac';
        g2.font = '600 46px ' + FONT_ZH;
        g2.textAlign = 'left';
        g2.textBaseline = 'middle';
        g2.fillText('大唐不夜城', 40, 68);
        // 细分隔线
        g2.strokeStyle = 'rgba(255,150,70,.34)';
        g2.lineWidth = 1;
        g2.beginPath(); g2.moveTo(40, 106); g2.lineTo(720, 106); g2.stroke();
        // 数据行
        g2.fillStyle = '#ffb063';
        var line2 = '38 分钟  ·  20.6 km  ·  预计 21:43 到达';
        var fs = 31;
        g2.font = '400 ' + fs + 'px ' + FONT_ZH;
        while (g2.measureText(line2).width > 676 && fs > 20) { fs -= 1; g2.font = '400 ' + fs + 'px ' + FONT_ZH; }
        g2.fillText(line2, 40, 150);
        // 左上小标签
        g2.fillStyle = 'rgba(255,196,140,.75)';
        g2.font = '500 19px ' + FONT_ZH;
        g2.fillText('ROUTE  ·  驾车', 40, 28);
      });
    }

    /* 贴地径向光池纹理 */
    function glowTex(inner, outer) {
      return canvasTex(128, 128, function (g2) {
        var gr = g2.createRadialGradient(64, 64, 0, 64, 64, 64);
        gr.addColorStop(0, inner);
        gr.addColorStop(0.45, outer);
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g2.fillStyle = gr;
        g2.fillRect(0, 0, 128, 128);
      });
    }

    /* ============================================================ 城市布局 */
    // 街道位置（带抖动，确定性随机）
    var roadX = [], roadZ = [], roadWX = [], roadWZ = [];
    var diags = [];

    function layoutCity(rnd) {
      roadX.length = 0; roadZ.length = 0; roadWX.length = 0; roadWZ.length = 0; diags.length = 0;
      var i;
      var NX = 10, NZ = 6;
      for (i = 0; i < NX; i++) {
        var x = -PX + 0.42 + (i + 0.5) * ((2 * PX - 0.84) / NX) + (rnd() - 0.5) * 0.14;
        roadX.push(x);
        roadWX.push(i % 3 === 1 ? 0.130 : 0.076);
      }
      for (i = 0; i < NZ; i++) {
        var z = -PZ + 0.40 + (i + 0.5) * ((2 * PZ - 0.80) / NZ) + (rnd() - 0.5) * 0.12;
        roadZ.push(z);
        roadWZ.push(i % 3 === 2 ? 0.125 : 0.074);
      }
      // 斜切大道（参考帧里的对角线）
      diags.push([-PX + 0.15, 2.75, 0.75, -PZ + 0.12, 0.155]);
      diags.push([0.35, PZ - 0.10, PX - 0.10, -1.05, 0.135]);
      diags.push([-1.55, -PZ + 0.10, 1.25, PZ - 0.12, 0.105]);
    }

    // 楼高分布场（CBD 团簇 → 高低层次）
    function district(x, z) {
      var d1 = Math.hypot((x + 1.05) / 2.15, (z + 0.55) / 1.45);
      var h1 = Math.exp(-d1 * d1 * 1.9);
      var d2 = Math.hypot((x - 2.30) / 1.45, (z + 1.95) / 1.05);
      var h2 = Math.exp(-d2 * d2 * 1.7) * 0.72;
      var d3 = Math.hypot((x + 3.45) / 1.20, (z - 1.75) / 0.95);
      var h3 = Math.exp(-d3 * d3 * 2.0) * 0.34;
      var d4 = Math.hypot((x - 0.1) / 1.7, (z - 1.5) / 0.95);
      var h4 = Math.exp(-d4 * d4 * 2.2) * 0.20;
      return Math.min(1, h1 + h2 + h3 + h4);
    }

    // 判断点是否落在斜切大道上（避开建筑）
    function nearDiag(x, z, pad) {
      for (var i = 0; i < diags.length; i++) {
        var d = diags[i];
        var ax = d[0], az = d[1], bx = d[2], bz = d[3];
        var dx = bx - ax, dz = bz - az;
        var L2 = dx * dx + dz * dz;
        var t = L2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1) : 0;
        var px = ax + dx * t, pz = az + dz * t;
        if (Math.hypot(x - px, z - pz) < pad) return true;
      }
      return false;
    }

    /* ====================================================== 楼群几何构建 */
    // 一栋楼：4 根点状竖线 + 线框边
    function pushBuilding(accEdge, accDot, accReflEdge, accReflDot, x, z, w, d, h, tint, alpha, phase, dotGap) {
      var hw = w * 0.5, hd = d * 0.5;
      var r = tint.r, g = tint.g, b = tint.b;

      // 低矮建筑压暗，高层才亮 —— 形成参考帧里那种高低层次的明暗节奏
      var hk = clamp(h / 1.15, 0.16, 1.0);
      var al = alpha * (0.34 + 0.66 * hk);

      // ---- 线框边（棱线压得很淡，只做"骨架"，避免低层糊成白块）
      var ex = [x - hw, x + hw], ez = [z - hd, z + hd];
      var aEdge = al * 0.20;
      for (var ix = 0; ix < 2; ix++) {
        for (var iz = 0; iz < 2; iz++) {
          // 竖棱
          accEdge.v(ex[ix], 0, ez[iz], r, g, b, aEdge * 1.45, phase, h);
          accEdge.v(ex[ix], h, ez[iz], r, g, b, aEdge * 1.45, phase, h);
          // 倒影竖棱
          accReflEdge.v(ex[ix], 0, ez[iz], r, g, b, aEdge * 0.26, phase, h);
          accReflEdge.v(ex[ix], -h, ez[iz], r, g, b, aEdge * 0.26, phase, h);
        }
      }
      // 顶面轮廓（底面画了也看不见，省掉 → 街区留黑）
      var corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
      for (var k = 0; k < 4; k++) {
        var c0 = corners[k], c1 = corners[(k + 1) % 4];
        accEdge.v(ex[c0[0]], h, ez[c0[1]], r, g, b, aEdge * 1.1, phase, h);
        accEdge.v(ex[c1[0]], h, ez[c1[1]], r, g, b, aEdge * 1.1, phase, h);
        // 倒影顶面
        accReflEdge.v(ex[c0[0]], -h, ez[c0[1]], r, g, b, aEdge * 0.20, phase, h);
        accReflEdge.v(ex[c1[0]], -h, ez[c1[1]], r, g, b, aEdge * 0.20, phase, h);
      }
      // 每隔一段高度加一道横向箍（高层更有层次）
      if (h > 1.15) {
        var rings = Math.min(3, Math.floor(h / 0.85));
        for (var ri = 1; ri <= rings; ri++) {
          var yy = h * ri / (rings + 1);
          var aa = aEdge * 0.62 * (1 - ri / (rings + 1.6));
          for (var m = 0; m < 4; m++) {
            var q0 = corners[m], q1 = corners[(m + 1) % 4];
            accEdge.v(ex[q0[0]], yy, ez[q0[1]], r, g, b, aa, phase, h);
            accEdge.v(ex[q1[0]], yy, ez[q1[1]], r, g, b, aa, phase, h);
          }
        }
      }

      // ---- 点状竖线：JARVIS 标志性的 sparkler 竖虚线
      var gap = dotGap;
      var cols = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
      for (var ci = 0; ci < 4; ci++) {
        var dx = cols[ci][0], dz = cols[ci][1];
        var n = Math.max(2, Math.round(h / gap));
        var step = h / n;
        for (var s = 0; s <= n; s++) {
          var yy2 = s * step;
          var t01 = yy2 / (h || 1);
          var aa2 = al * (0.70 + 0.55 * (1 - t01));
          var sz = 2.1 + 2.4 * (1 - t01) + hk * 1.6;
          accDot.p(x + dx, yy2, z + dz, r, g, b, aa2, phase, h, sz);
          // 倒影点（更稀、更暗）
          if ((s & 1) === 0) {
            accReflDot.p(x + dx, -yy2, z + dz, r, g, b, aa2 * 0.16, phase, h, sz * 1.15);
          }
        }
      }
      // 顶盖高光点（楼顶更亮，形成天际线的"亮帽"）
      for (var ci2 = 0; ci2 < 4; ci2++) {
        accDot.p(x + cols[ci2][0], h, z + cols[ci2][1], 1.0, 1.0, 1.0, al * 1.15, phase, h, 2.4 + hk);
      }
      accDot.p(x, h, z, r, g, b, al * 0.75, phase, h, 2.0);
    }

    /* ------------------------------------------------ 沙盘面片（街道/边框） */
    function roadQuad(acc, x1, z1, x2, z2, off, halfW, kind, colr, alpha, flow, t0, t1, y) {
      var dx = x2 - x1, dz = z2 - z1;
      var L = Math.hypot(dx, dz) || 1;
      dx /= L; dz /= L;
      var nx = -dz, nz = dx;
      var ax = x1 + nx * off, az = z1 + nz * off;
      var bx = x2 + nx * off, bz = z2 + nz * off;
      var y0 = (y === undefined) ? PLATE_Y : y;
      var p0x = ax - nx * halfW, p0z = az - nz * halfW;
      var p1x = ax + nx * halfW, p1z = az + nz * halfW;
      var p2x = bx + nx * halfW, p2z = bz + nz * halfW;
      var p3x = bx - nx * halfW, p3z = bz - nz * halfW;
      var r = colr.r, g = colr.g, b = colr.b;
      acc.q(p0x, y0, p0z, r, g, b, alpha, -1, kind, flow, t0);
      acc.q(p1x, y0, p1z, r, g, b, alpha, 1, kind, flow, t0);
      acc.q(p2x, y0, p2z, r, g, b, alpha, 1, kind, flow, t1);
      acc.q(p0x, y0, p0z, r, g, b, alpha, -1, kind, flow, t0);
      acc.q(p2x, y0, p2z, r, g, b, alpha, 1, kind, flow, t1);
      acc.q(p3x, y0, p3z, r, g, b, alpha, -1, kind, flow, t1);
    }

    // 一条街（4 层面片：外晕 / 亮芯 / 两侧边线）
    function pushRoad(acc, x1, z1, x2, z2, w, flow, mul) {
      var y = PLATE_Y;
      var k = mul === undefined ? 1 : mul;
      roadQuad(acc, x1, z1, x2, z2, 0, w * 1.10, 0, COL.roadGlow, 0.40 * k, flow, 0, 0, y);
      roadQuad(acc, x1, z1, x2, z2, 0, w * 0.44, 1, COL.road, 0.78 * k, flow, 0, 0, y + 0.001);
      roadQuad(acc, x1, z1, x2, z2, -w * 0.62, w * 0.034, 2, COL.rim, 0.90 * k, flow, 0, 0, y + 0.002);
      roadQuad(acc, x1, z1, x2, z2, w * 0.62, w * 0.034, 2, COL.rim, 0.90 * k, flow, 0, 0, y + 0.002);
    }

    /* ================================================================ 构建 */
    function disposeBuilt() {
      if (!built) return;
      var i;
      for (i = 0; i < built.geoms.length; i++) { try { built.geoms[i].dispose(); } catch (e) {} }
      for (i = 0; i < built.mats.length; i++) { try { built.mats[i].dispose(); } catch (e) {} }
      for (i = 0; i < built.texs.length; i++) { try { built.texs[i].dispose(); } catch (e) {} }
      built = { geoms: [], mats: [], texs: [] };
    }

    function reg(geo) { built.geoms.push(geo); return geo; }
    function regM(m) { built.mats.push(m); return m; }
    function regT(t) { built.texs.push(t); return t; }

    function pointMat(opt) {
      var defines = {};
      if (opt.grow) defines.GROW = 1;
      if (opt.dev) defines.DEV = 1;
      if (opt.dim) defines.DIM = 1;
      var m = new THREE.ShaderMaterial({
        defines: defines,
        uniforms: {
          uTime: UNI.uTime, uGrow: UNI.uGrow, uFade: UNI.uFade, uGreen: UNI.uGreen,
          uDev: UNI.uDev, uPixel: UNI.uPixel, uDim: UNI.uDim,
          uSizeK: { value: opt.sizeK || 1 },
          uDrift: { value: opt.drift || 0 }
        },
        vertexShader: POINT_VS, fragmentShader: POINT_FS,
        transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.AdditiveBlending
      });
      m.userData.sizeK = m.uniforms.uSizeK;
      return regM(m);
    }

    function roadMat() {
      return regM(new THREE.ShaderMaterial({
        uniforms: {
          uTime: UNI.uTime, uFade: UNI.uFade, uGreen: UNI.uGreen, uRoute: UNI.uRoute,
          uDim: UNI.uDim
        },
        vertexShader: ROAD_VS, fragmentShader: ROAD_FS,
        transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide
      }));
    }

    function lineMat(opacity) {
      return regM(new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: opacity === undefined ? 1 : opacity,
        depthWrite: false, blending: THREE.AdditiveBlending
      }));
    }

    // 由累加器生成几何
    function lineGeo(acc) {
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(acc.col, 3));
      return reg(g);
    }
    function pointGeo(acc) {
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
      g.setAttribute('aCol', new THREE.Float32BufferAttribute(acc.col, 3));
      g.setAttribute('aA', new THREE.Float32BufferAttribute(acc.aA, 1));
      g.setAttribute('aSize', new THREE.Float32BufferAttribute(acc.aSz, 1));
      g.setAttribute('aPhase', new THREE.Float32BufferAttribute(acc.aPh, 1));
      if (acc.aH.length === acc.aPh.length && acc.aH.length > 0) {
        g.setAttribute('aH', new THREE.Float32BufferAttribute(acc.aH, 1));
      }
      return reg(g);
    }
    function quadGeo(acc) {
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
      g.setAttribute('aCol', new THREE.Float32BufferAttribute(acc.col, 3));
      g.setAttribute('aXK', new THREE.Float32BufferAttribute(acc.aXK, 3));
      g.setAttribute('aA', new THREE.Float32BufferAttribute(acc.aA, 1));
      g.setAttribute('aT', new THREE.Float32BufferAttribute(acc.aT, 1));
      return reg(g);
    }

    /* 质量档位 → 采样密度 */
    function qparams(q) {
      if (q === 'low') return { dotGap: 0.115, dust: 1800, bokeh: 44, sub: 1, spark: 0 };
      if (q === 'med') return { dotGap: 0.072, dust: 4800, bokeh: 92, sub: 2, spark: 400 };
      return { dotGap: 0.040, dust: 11000, bokeh: 160, sub: 3, spark: 700 };
    }

    /* ------------------------------------------------------------ 主构建 */
    function build() {
      disposeBuilt();
      built = { geoms: [], mats: [], texs: [], refs: {} };
      compassSprites.length = 0;
      plateGroup.clear();
      // 清掉非沙盘的子对象（罗盘/尘埃等在 group 上）
      for (var gi = group.children.length - 1; gi >= 0; gi--) {
        if (group.children[gi] !== plateGroup) group.remove(group.children[gi]);
      }

      var Q = qparams(quality);
      var rnd = U.rng(20241110);

      layoutCity(rnd);

      /* ---------- 1. 楼群 ---------- */
      var accEdge = new Acc();
      var accDot = new Acc();
      var accRE = new Acc();   // 倒影线
      var accRD = new Acc();   // 倒影点

      // 由街道切分街区，再切地块
      var xs = [-PX].concat(roadX, [PX]);
      var zs = [-PZ].concat(roadZ, [PZ]);
      var imax = xs.length - 1, jmax = zs.length - 1;
      var sub = Q.sub;

      for (var i = 0; i < imax; i++) {
        for (var j = 0; j < jmax; j++) {
          var bx0 = xs[i] + 0.14, bx1 = xs[i + 1] - 0.14;
          var bz0 = zs[j] + 0.14, bz1 = zs[j + 1] - 0.14;
          var bw = bx1 - bx0, bd = bz1 - bz0;
          if (bw < 0.16 || bd < 0.16) continue;

          // 地块细分数：越靠 CBD 越碎（出现更多细高楼）
          var ccx = (bx0 + bx1) / 2, ccz = (bz0 + bz1) / 2;
          var dist = district(ccx, ccz);
          var nx = bw > 0.62 ? (dist > 0.5 && bw > 0.95 ? 3 : 2) : 1;
          var nz = bd > 0.50 ? (dist > 0.5 && bd > 0.78 ? 3 : 2) : 1;
          nx = Math.min(nx, Math.max(1, Math.round(sub * bw / 0.55)));
          nz = Math.min(nz, Math.max(1, Math.round(sub * bd / 0.55)));
          nx = clamp(nx, 1, 4); nz = clamp(nz, 1, 4);

          for (var u = 0; u < nx; u++) {
            for (var v = 0; v < nz; v++) {
              var lx0 = bx0 + (bw * u) / nx, lx1 = bx0 + (bw * (u + 1)) / nx;
              var lz0 = bz0 + (bd * v) / nz, lz1 = bz0 + (bd * (v + 1)) / nz;
              var lm = 0.028 + rnd() * 0.070;
              var w = (lx1 - lx0) - lm * 2, d = (lz1 - lz0) - lm * 2;
              if (w < 0.09 || d < 0.09) continue;
              var cx = (lx0 + lx1) / 2 + (rnd() - 0.5) * 0.03;
              var cz = (lz0 + lz1) / 2 + (rnd() - 0.5) * 0.03;
              if (nearDiag(cx, cz, 0.30)) continue;         // 避开斜切大道
              if (rnd() > 0.86) continue;                   // 空地块（留呼吸感）
              var dstr = district(cx, cz);
              var h = 0.09 + rnd() * 0.13 + Math.pow(dstr, 1.25) * (1.85 + rnd() * 1.85);
              if (h > 3.5) h = 3.5;
              // 少量地标塔
              if (rnd() > 0.975 && dstr > 0.55) h = 2.9 + rnd() * 0.7;
              // 颜色：主青白，少量暖琥珀（对应参考帧里的橙色塔）
              var warm = rnd() > 0.88;
              var colr = warm ? COL.bldWarm : (rnd() > 0.6 ? COL.bldCool : COL.bld);
              var alpha = (warm ? 0.20 : 0.24) + rnd() * 0.26;
              pushBuilding(accEdge, accDot, accRE, accRD, cx, cz, w, d, h, colr, alpha, rnd() * 0.42, Q.dotGap);
            }
          }
        }
      }

      var bldEdgeGeo = lineGeo(accEdge);
      var bldDotGeo = pointGeo(accDot);
      var bldEdgeMat = lineMat(0.40);
      var bldDotMat = pointMat({ grow: true, sizeK: 1.0, drift: 0, dim: true });
      var edgeMesh = new THREE.LineSegments(bldEdgeGeo, bldEdgeMat);
      edgeMesh.name = 'city-buildings-wire';
      var dotMesh = new THREE.Points(bldDotGeo, bldDotMat);
      dotMesh.name = 'city-buildings-dots';
      plateGroup.add(edgeMesh, dotMesh);

      // 倒影（更暗、更稀）
      var reflEdgeMesh = new THREE.LineSegments(lineGeo(accRE), lineMat(0.30));
      reflEdgeMesh.name = 'city-reflect-wire';
      var reflDotMesh = new THREE.Points(pointGeo(accRD), pointMat({ grow: true, sizeK: 1.1, drift: 0, dim: true }));
      reflDotMesh.name = 'city-reflect-dots';
      plateGroup.add(reflEdgeMesh, reflDotMesh);

      /* ---------- 2. 街道 / 沙盘边框 / 路径面片（同一材质 → 1 个 drawcall） ---------- */
      var accRoad = new Acc();

      // 街道
      for (var a = 0; a < roadX.length; a++) {
        pushRoad(accRoad, roadX[a], -PZ + 0.06, roadX[a], PZ - 0.06, roadWX[a], rnd());
      }
      for (var b = 0; b < roadZ.length; b++) {
        pushRoad(accRoad, -PX + 0.06, roadZ[b], PX - 0.06, roadZ[b], roadWZ[b], rnd());
      }
      // 斜切大道
      for (var dd = 0; dd < diags.length; dd++) {
        var D = diags[dd];
        pushRoad(accRoad, D[0], D[1], D[2], D[3], D[4], rnd(), 0.48);
      }

      // 沙盘边框（双圈 + 外发光），四边各一条
      var rimPts = [[-PX, -PZ], [PX, -PZ], [PX, PZ], [-PX, PZ]];
      var greenRim = C(PAL.mint);
      for (var r2 = 0; r2 < 4; r2++) {
        var rp0 = rimPts[r2], rp1 = rimPts[(r2 + 1) % 4];
        // 大范围绿雾（低视角时把前缘托亮）
        roadQuad(accRoad, rp0[0], rp0[1], rp1[0], rp1[1], 0, 0.20, 0, greenRim, 0.42, 0, 0, 0, PLATE_Y - 0.01);
        // 中层绿光
        roadQuad(accRoad, rp0[0], rp0[1], rp1[0], rp1[1], 0, 0.062, 0, greenRim, 0.70, 0, 0, 0, PLATE_Y);
        // 基座亮线与高光芯：全息沙盘的"地平线"
        roadQuad(accRoad, rp0[0], rp0[1], rp1[0], rp1[1], 0, 0.026, 3, greenRim, 1.15, 0, 0, 0, PLATE_Y + 0.003);
        roadQuad(accRoad, rp0[0], rp0[1], rp1[0], rp1[1], 0, 0.011, 3, COL.rim, 0.55, 0, 0, 0, PLATE_Y + 0.004);
        // 内圈（略缩小轮廓）
        var sx = rp0[0] * 0.955, sz = rp0[1] * 0.955, ex2 = rp1[0] * 0.955, ez2 = rp1[1] * 0.955;
        roadQuad(accRoad, sx, sz, ex2, ez2, 0, 0.014, 2, COL.rim, 0.20, 0, 0, 0, PLATE_Y + 0.002);
      }

      /* ---------- 3. 路径（route 形态）---------- */
      buildRouteGeometry(accRoad, rnd);

      var roadGeometry = quadGeo(accRoad);
      var roadMesh = new THREE.Mesh(roadGeometry, roadMat());
      roadMesh.name = 'city-streets';
      roadMesh.frustumCulled = false;
      plateGroup.add(roadMesh);

      /* ---------- 4. 街道交点亮点 ---------- */
      var accJ = new Acc();
      for (var ja = 0; ja < roadX.length; ja++) {
        for (var jb = 0; jb < roadZ.length; jb++) {
          var main = (ja % 3 === 1) || (jb % 3 === 2);
          accJ.p(roadX[ja], PLATE_Y + 0.004, roadZ[jb], 1, 1, 1,
            main ? 0.38 : 0.20, rnd(), 1e9, main ? 3.0 : 2.0);
        }
      }
      // 沿主街撒一些"车流"光点（静态，靠漂移微动）
      for (var tc = 0; tc < (quality === 'low' ? 60 : 190); tc++) {
        var along = rnd() > 0.5;
        var x3 = along ? -PX + rnd() * 2 * PX : roadX[(rnd() * roadX.length) | 0];
        var z3 = along ? roadZ[(rnd() * roadZ.length) | 0] : -PZ + rnd() * 2 * PZ;
        accJ.p(x3, PLATE_Y + 0.006, z3, 1, 1, 1, 0.10 + rnd() * 0.18, rnd(), 1e9, 1.5 + rnd() * 1.2);
      }
      var junctionMat = pointMat({ sizeK: 1.0, drift: 0.006, dim: true });
      var junctionMesh = new THREE.Points(pointGeo(accJ), junctionMat);
      junctionMesh.name = 'city-junctions';
      plateGroup.add(junctionMesh);

      /* ---------- 5. 贴地光池（低视角时收成亮带）+ 青绿设备层光 ---------- */
      var baseTex = regT(glowTex('rgba(232,255,248,.90)', 'rgba(126,245,207,.34)'));
      var baseMat = regM(new THREE.MeshBasicMaterial({
        map: baseTex, transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.AdditiveBlending, opacity: 0.10
      }));
      var basePlane = new THREE.Mesh(reg(new THREE.PlaneGeometry(2 * PX * 1.05, 2 * PZ * 1.34)), baseMat);
      basePlane.rotation.x = -Math.PI / 2;
      basePlane.position.y = PLATE_Y * 0.5;
      basePlane.name = 'city-base-glow';
      plateGroup.add(basePlane);

      // 基座下沿的第二条绿光（略低、略外扩 → 低视角叠成一条粗绿线）
      var underTex = regT(glowTex('rgba(126,245,207,.85)', 'rgba(56,224,174,.28)'));
      var underMat = regM(new THREE.MeshBasicMaterial({
        map: underTex, transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.AdditiveBlending, opacity: 0.30
      }));
      var underPlane = new THREE.Mesh(reg(new THREE.PlaneGeometry(2 * PX * 1.06, 2 * PZ * 1.20)), underMat);
      underPlane.rotation.x = -Math.PI / 2;
      underPlane.position.y = -0.03;
      underPlane.name = 'city-under-glow';
      plateGroup.add(underPlane);
      built.refs.underMat = underMat;

      // 更高的柔光（让底部在低视角下有一层光雾）
      var hazeTex = regT(glowTex('rgba(160,255,230,.55)', 'rgba(56,224,174,.16)'));
      var hazeMat = regM(new THREE.MeshBasicMaterial({
        map: hazeTex, transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.AdditiveBlending, opacity: 0.055
      }));
      var hazePlane = new THREE.Mesh(reg(new THREE.PlaneGeometry(2 * PX * 1.5, 2 * PZ * 2.0)), hazeMat);
      hazePlane.rotation.x = -Math.PI / 2;
      hazePlane.position.y = -0.10;
      hazePlane.name = 'city-base-haze';
      plateGroup.add(hazePlane);

      // 青绿设备层地面光（green 形态淡入）
      var greenTex = regT(glowTex('rgba(120,255,208,.75)', 'rgba(15,191,143,.30)'));
      var greenMat = regM(new THREE.MeshBasicMaterial({
        map: greenTex, transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.AdditiveBlending, opacity: 0
      }));
      var greenPlane = new THREE.Mesh(reg(new THREE.PlaneGeometry(2 * PX * 1.1, 2 * PZ * 1.25)), greenMat);
      greenPlane.rotation.x = -Math.PI / 2;
      greenPlane.position.y = PLATE_Y + 0.008;
      greenPlane.name = 'city-green-glow';
      plateGroup.add(greenPlane);

      /* ---------- 6. 外围弧线 + 刻度 ---------- */
      buildRings(rnd);

      /* ---------- 7. 漂浮尘埃 / 光斑 ---------- */
      buildDust(rnd, Q);

      /* ---------- 8. 罗盘 / 起点牌 / 终点 pin / 信息牌 ---------- */
      buildLabels();

      /* ---------- 9. 设备点位 ---------- */
      buildDevices(rnd);

      // 缓存材质引用便于逐帧驱动
      built.refs.edgeMesh = edgeMesh;
      built.refs.dotMesh = dotMesh;
      built.refs.reflEdgeMesh = reflEdgeMesh;
      built.refs.bldEdgeMat = bldEdgeMat;
      built.refs.reflDotMesh = reflDotMesh;
      built.refs.roadMesh = roadMesh;
      built.refs.junctionMesh = junctionMesh;
      built.refs.baseMat = baseMat;
      built.refs.hazeMat = hazeMat;
      built.refs.greenMat = greenMat;
      built.refs.basePlane = basePlane;
      built.refs.hazePlane = hazePlane;
      built.refs.greenPlane = greenPlane;

      // 应用当前过渡量
      applyTint();
    }

    /* ------------------------------------------------------- 外围弧线刻度 */
    var ringsGroup = null;
    function buildRings(rnd) {
      ringsGroup = new THREE.Group();
      ringsGroup.name = 'city-rings';

      var accA = new Acc();
      var accB = new Acc();

      // 暗环（细密刻度）
      var R1 = 5.65;
      for (var i = 0; i < 180; i++) {
        var a0 = (i / 180) * TAU;
        var a1 = a0 + 0.012;
        var isMajor = (i % 15 === 0);
        var rr = R1 + (isMajor ? 0.14 : 0.05);
        accA.v(Math.cos(a0) * R1, 0, Math.sin(a0) * R1, 0.49, 0.96, 0.87, isMajor ? 0.34 : 0.13, 0, 1e9);
        accA.v(Math.cos(a0) * rr, 0, Math.sin(a0) * rr, 0.49, 0.96, 0.87, isMajor ? 0.34 : 0.13, 0, 1e9);
        // 内弧（断续）
        if (i % 3 !== 0) {
          accA.v(Math.cos(a0) * 4.85, 0, Math.sin(a0) * 4.85 * 0.72, 0.49, 0.96, 0.87, 0.06, 0, 1e9);
          accA.v(Math.cos(a1) * 4.85, 0, Math.sin(a1) * 4.85 * 0.72, 0.49, 0.96, 0.87, 0.06, 0, 1e9);
        }
      }
      var ringMeshA = new THREE.LineSegments(lineGeo(accA), lineMat(1.0));
      ringMeshA.position.y = -0.055;
      ringMeshA.scale.set(1.0, 1, 0.74);
      ringMeshA.frustumCulled = false;
      ringsGroup.add(ringMeshA);

      // 亮弧（缓慢自转）
      var R2 = 6.35;
      var N2 = 150, from = 0.0, to = Math.PI * 1.15;
      for (var k = 0; k < N2; k++) {
        var b0 = from + (to - from) * (k / N2);
        var b1 = from + (to - from) * ((k + 1) / N2);
        var fadeK = Math.sin((k / N2) * Math.PI);
        accB.v(Math.cos(b0) * R2, 0, Math.sin(b0) * R2, 0.72, 1.0, 0.94, 0.40 * fadeK, 0, 1e9);
        accB.v(Math.cos(b1) * R2, 0, Math.sin(b1) * R2, 0.72, 1.0, 0.94, 0.40 * fadeK, 0, 1e9);
      }
      // 第二段反向弧
      for (var m = 0; m < N2; m++) {
        var c0 = Math.PI * 1.35 + (Math.PI * 0.55) * (m / N2);
        var c1 = Math.PI * 1.35 + (Math.PI * 0.55) * ((m + 1) / N2);
        var fk = Math.sin((m / N2) * Math.PI);
        accB.v(Math.cos(c0) * 8.45, 0, Math.sin(c0) * 8.45, 0.49, 0.96, 0.87, 0.30 * fk, 0, 1e9);
        accB.v(Math.cos(c1) * 8.45, 0, Math.sin(c1) * 8.45, 0.49, 0.96, 0.87, 0.30 * fk, 0, 1e9);
      }
      var ringMeshB = new THREE.LineSegments(lineGeo(accB), lineMat(1.0));
      ringMeshB.position.y = -0.045;
      ringMeshB.scale.set(1.0, 1, 0.74);
      ringMeshB.frustumCulled = false;
      ringsGroup.add(ringMeshB);

      group.add(ringsGroup);
      built.refs.ringsA = ringMeshA;
      built.refs.ringsB = ringMeshB;
      built.refs.ringsGroup = ringsGroup;
    }

    /* ------------------------------------------------- 漂浮尘埃 / 虚化光斑 */
    var dustMesh = null, bokehMesh = null;
    function buildDust(rnd, Q) {
      // 尘埃
      var acc = new Acc();
      var N = Q.dust;
      var R = 15.5, HY = 6.2;
      for (var i = 0; i < N; i++) {
        var r = Math.pow(rnd(), 0.62) * R + 1.2;
        var ang = rnd() * TAU;
        var x = Math.cos(ang) * r;
        var z = Math.sin(ang) * r * 0.75;
        var y = (rnd() - 0.45) * HY;
        var warm = rnd() > 0.86;
        var bright = 0.25 + rnd() * 0.75;
        var cr = warm ? COL.bldWarm.r : 0.85;
        var cg = warm ? COL.bldWarm.g : 0.98;
        var cb = warm ? COL.bldWarm.b : 0.95;
        acc.p(x, y, z, cr, cg, cb, 0.14 + rnd() * 0.42 * bright, rnd(), 1e9, 1.0 + rnd() * 1.5);
      }
      dustMesh = new THREE.Points(pointGeo(acc), pointMat({ sizeK: 1.0, drift: 0.16 }));
      dustMesh.name = 'city-dust';
      dustMesh.frustumCulled = false;
      group.add(dustMesh);

      // 虚化光斑（暖/冷混合，参考帧里的散景圆点）
      var accB = new Acc();
      var NB = Q.bokeh;
      for (var j = 0; j < NB; j++) {
        var br = Math.pow(rnd(), 0.8) * 14.0 + 1.6;
        var bang = rnd() * TAU;
        var bx = Math.cos(bang) * br;
        var bz = Math.sin(bang) * br * 0.8;
        var by = (rnd() - 0.4) * 7.0;
        var bwarm = rnd() > 0.66;
        var bc = bwarm ? COL.amber : (rnd() > 0.5 ? COL.bldCool : COL.roadGlow);
        accB.p(bx, by, bz, bc.r, bc.g, bc.b, 0.040 + rnd() * 0.075, rnd(), 1e9, 7 + rnd() * 20);
      }
      bokehMesh = new THREE.Points(pointGeo(accB), pointMat({ sizeK: 1.0, drift: 0.10 }));
      bokehMesh.name = 'city-bokeh';
      bokehMesh.frustumCulled = false;
      group.add(bokehMesh);
    }

    /* --------------------------------------------- 罗盘 / 起点 / 终点 / 信息牌 */
    var compassSprites = [];
    var compassGroup = null;
    var startChip = null, startLead = null;
    var endPinGroup = null, endPinBall = null, endPinRing = null;
    var infoCard = null, infoLead = null;

    function buildLabels() {
      compassGroup = new THREE.Group();
      compassGroup.name = 'city-compass';
      var labels = [
        { ch: '西', ring: 'rgba(126,245,207,.72)' },
        { ch: '东', ring: 'rgba(126,245,207,.72)' },
        { ch: '北', ring: 'rgba(255,193,119,.85)' }
      ];
      for (var i = 0; i < labels.length; i++) {
        var tx = regT(compassTex(labels[i].ch, labels[i].ring));
        var m = regM(new THREE.SpriteMaterial({
          map: tx, transparent: true, depthWrite: false, depthTest: false,
          blending: THREE.NormalBlending, opacity: 0.92
        }));
        var sp = new THREE.Sprite(m);
        sp.scale.set(0.62, 0.62, 1);
        sp.renderOrder = 20;
        compassSprites.push(sp);
        compassGroup.add(sp);
      }
      group.add(compassGroup);

      // 起点牌 + 引线
      var stx = regT(startChipTex());
      var stm = regM(new THREE.SpriteMaterial({
        map: stx, transparent: true, depthWrite: false, depthTest: false,
        blending: THREE.NormalBlending, opacity: 0.95
      }));
      startChip = new THREE.Sprite(stm);
      startChip.scale.set(1.06, 0.40, 1);
      startChip.renderOrder = 21;
      group.add(startChip);

      var accL = new Acc();
      var sp = routeStart();
      accL.v(sp[0] + 0.10, sp[1] + 0.04, PLATE_Y, 0.72, 1.0, 0.94, 0.42, 0, 1e9);
      accL.v(sp[0] + 0.36, sp[1] - 0.16, 1.34, 1.0, 1.0, 1.0, 0.42, 0, 1e9);
      startLead = new THREE.LineSegments(lineGeo(accL), lineMat(1.0));
      startLead.frustumCulled = false;
      group.add(startLead);

      // 终点 pin（竖线 + 光球 + 脉冲环）
      endPinGroup = new THREE.Group();
      endPinGroup.name = 'city-endpin';
      var ep = routeEnd();
      var accP = new Acc();
      accP.v(ep[0], PLATE_Y, ep[1], 0.72, 1.0, 0.94, 0.8, 0, 1e9);
      accP.v(ep[0], 0.95, ep[1], 1.0, 1.0, 1.0, 1.0, 0, 1e9);
      // 顶部横杠
      accP.v(ep[0] - 0.10, 0.95, ep[1], 1.0, 1.0, 1.0, 0.9, 0, 1e9);
      accP.v(ep[0] + 0.10, 0.95, ep[1], 1.0, 1.0, 1.0, 0.9, 0, 1e9);
      var pinLine = new THREE.LineSegments(lineGeo(accP), lineMat(1.0));
      pinLine.frustumCulled = false;
      endPinGroup.add(pinLine);

      var ballTex = regT(glowTex('rgba(255,255,255,1)', 'rgba(126,245,207,.45)'));
      var ballMat = regM(new THREE.SpriteMaterial({
        map: ballTex, transparent: true, depthWrite: false, depthTest: false,
        blending: THREE.AdditiveBlending, opacity: 0.95
      }));
      endPinBall = new THREE.Sprite(ballMat);
      endPinBall.scale.set(0.46, 0.46, 1);
      endPinBall.position.set(ep[0], 0.95, ep[1]);
      endPinBall.renderOrder = 22;
      endPinGroup.add(endPinBall);

      // 地面脉冲环
      var accR = new Acc();
      var SEG = 48;
      for (var s = 0; s < SEG; s++) {
        var a0 = (s / SEG) * TAU, a1 = ((s + 1) / SEG) * TAU;
        accR.v(ep[0] + Math.cos(a0) * 0.30, PLATE_Y + 0.01, ep[1] + Math.sin(a0) * 0.30, 0.78, 1.0, 0.94, 0.85, 0, 1e9);
        accR.v(ep[0] + Math.cos(a1) * 0.30, PLATE_Y + 0.01, ep[1] + Math.sin(a1) * 0.30, 0.78, 1.0, 0.94, 0.85, 0, 1e9);
      }
      endPinRing = new THREE.LineSegments(lineGeo(accR), lineMat(1.0));
      endPinRing.frustumCulled = false;
      endPinGroup.add(endPinRing);
      group.add(endPinGroup);

      // 琥珀信息牌 + 引线
      var ctx2 = regT(infoCardTex());
      var cardMat = regM(new THREE.SpriteMaterial({
        map: ctx2, transparent: true, depthWrite: false, depthTest: false,
        blending: THREE.NormalBlending, opacity: 0.96
      }));
      infoCard = new THREE.Sprite(cardMat);
      infoCard.scale.set(2.44, 0.642, 1);
      infoCard.position.set(CARD_POS[0], CARD_POS[1], CARD_POS[2]);
      infoCard.renderOrder = 25;
      infoCard.visible = false;
      group.add(infoCard);

      var accI = new Acc();
      // 折线：信息牌左下 → 折点 → 终点 pin 头部
      accI.v(CARD_POS[0] - 0.62, CARD_POS[1] - 0.26, CARD_POS[2], COL.amber.r, COL.amber.g, COL.amber.b, 0.42, 0, 1e9);
      accI.v(ep[0] + 0.05, 1.30, ep[1], COL.amber.r, COL.amber.g, COL.amber.b, 0.80, 0, 1e9);
      accI.v(ep[0] + 0.05, 1.30, ep[1], COL.amber.r, COL.amber.g, COL.amber.b, 0.80, 0, 1e9);
      accI.v(ep[0], 0.98, ep[1], COL.amber.r, COL.amber.g, COL.amber.b, 0.90, 0, 1e9);
      infoLead = new THREE.LineSegments(lineGeo(accI), lineMat(1.0));
      infoLead.frustumCulled = false;
      infoLead.visible = false;
      group.add(infoLead);

      built.refs.compassGroup = compassGroup;
      built.refs.startChip = startChip;
      built.refs.startLead = startLead;
      built.refs.endPinGroup = endPinGroup;
      built.refs.endPinBall = endPinBall;
      built.refs.endPinRing = endPinRing;
      built.refs.infoCard = infoCard;
      built.refs.infoLead = infoLead;
    }

    /* ------------------------------------------------------------ 路径数据 */
    var ROUTE_START = [-3.95, 1.55];
    var ROUTE_END = [3.55, -1.95];
    // 信息牌锚点：城市中心偏左、略低 → 屏幕 x≈1000-1250 / y≈280-360，避开右侧 HUD
    var CARD_POS = [1.30, 1.78, -0.70];
    function routeStart() { return ROUTE_START; }
    function routeEnd() { return ROUTE_END; }

    var routeCurve = null;
    function routeWaypoints() {
      return [
        new THREE.Vector3(ROUTE_START[0], 0, ROUTE_START[1]),
        new THREE.Vector3(-4.35, 0, 2.35),
        new THREE.Vector3(-2.85, 0, 2.62),
        new THREE.Vector3(-1.15, 0, 2.15),
        new THREE.Vector3(0.15, 0, 1.32),
        new THREE.Vector3(1.45, 0, 0.72),
        new THREE.Vector3(2.42, 0, -0.05),
        new THREE.Vector3(3.18, 0, -1.05),
        new THREE.Vector3(ROUTE_END[0], 0, ROUTE_END[1])
      ];
    }

    function buildRouteGeometry(acc, rnd) {
      if (!routeCurve) {
        routeCurve = new THREE.CatmullRomCurve3(routeWaypoints(), false, 'catmullrom', 0.28);
      }
      var N = 150;
      var pts = routeCurve.getPoints(N);
      var flat = new Float32Array((N + 1) * 3 + 3);
      for (var i = 0; i <= N; i++) {
        flat[i * 3] = pts[i].x; flat[i * 3 + 1] = 0; flat[i * 3 + 2] = pts[i].z;
      }
      routeData = { pts: flat, n: N };

      var y = PLATE_Y + 0.02;
      for (var k = 0; k < N; k++) {
        var p0 = pts[k], p1 = pts[k + 1];
        var t0 = k / N, t1 = (k + 1) / N;
        var w = 0.052 + 0.030 * Math.sin(t0 * Math.PI);
        // 外晕
        roadQuad(acc, p0.x, p0.z, p1.x, p1.z, 0, w * 2.7, 4, COL.route, 0.62, rnd(), t0, t1, y);
        // 亮芯
        roadQuad(acc, p0.x, p0.z, p1.x, p1.z, 0, w * 0.78, 5, COL.routeCore, 0.72, rnd(), t0, t1, y + 0.001);
      }
    }

    /* --------------------------------------------------------- 9 个设备点位 */
    var DEV_POS = [
      [-1.55, 0.55], [-0.55, 1.30], [1.05, 0.62], [-3.05, 1.90],
      [2.35, 1.35], [-2.45, -1.55], [3.55, -0.55], [0.62, -2.20], [-1.20, -2.35]
    ];
    var deviceRings = null, deviceDots = null, deviceLinks = null;

    function buildDevices(rnd) {
      var accR = new Acc();  // 需要 aCen/aLoc → 单独构造
      var posArr = [], cenArr = [], locArr = [], colArr = [], aArr = [], phArr = [];
      var SEG = 40;
      var devCol = [PAL.mintGlow, PAL.mintLight, PAL.mint];
      var links = new Acc();

      for (var d = 0; d < DEV_POS.length; d++) {
        var dx = DEV_POS[d][0], dz = DEV_POS[d][1];
        var c = COL.green;
        var cr = 0.42, cg = 1.0, cb = 0.78;
        // 两条不同相位的脉冲环
        for (var ring = 0; ring < 3; ring++) {
          var R = 0.20 + ring * 0.085;
          var phase = (d * 0.137 + ring * 0.34) % 1;
          var rc = ring === 0 ? [1.0, 1.0, 1.0] : (ring === 1 ? [0.62, 1.0, 0.88] : [0.40, 1.0, 0.78]);
          cr = rc[0]; cg = rc[1]; cb = rc[2];
          for (var s = 0; s < SEG; s++) {
            var a0 = (s / SEG) * TAU, a1 = ((s + 1) / SEG) * TAU;
            // 每个顶点 3 个位置分量（用 aCen+aLoc 重建）
            posArr.push(dx, 0, dz); cenArr.push(dx, dz); locArr.push(Math.cos(a0) * R, Math.sin(a0) * R);
            colArr.push(cr, cg, cb); aArr.push(ring === 0 ? 1.0 : (ring === 1 ? 0.72 : 0.42)); phArr.push(phase);
            posArr.push(dx, 0, dz); cenArr.push(dx, dz); locArr.push(Math.cos(a1) * R, Math.sin(a1) * R);
            colArr.push(cr, cg, cb); aArr.push(ring === 0 ? 1.0 : (ring === 1 ? 0.72 : 0.42)); phArr.push(phase);
          }
        }
        // 竖直引线 + 顶部小点
        links.v(dx, PLATE_Y, dz, 0.75, 1.0, 0.92, 0.90, 0, 1e9);
        links.v(dx, 0.66, dz, 0.90, 1.0, 0.98, 0.60, 0, 1e9);
        links.v(dx, dx * 0.35, dz, 0.55, 1.0, 0.85, 0.10, 0, 1e9);
        // 与"中枢"的连线
        links.v(dx, PLATE_Y + 0.008, dz, 0.55, 1.0, 0.85, 0.42, 0, 1e9);
        links.v(0.10, PLATE_Y + 0.008, -0.20, 0.55, 1.0, 0.85, 0.05, 0, 1e9);
      }

      var g = reg(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
      g.setAttribute('aCen', new THREE.Float32BufferAttribute(cenArr, 2));
      g.setAttribute('aLoc', new THREE.Float32BufferAttribute(locArr, 2));
      g.setAttribute('aCol', new THREE.Float32BufferAttribute(colArr, 3));
      g.setAttribute('aA', new THREE.Float32BufferAttribute(aArr, 1));
      g.setAttribute('aPhase', new THREE.Float32BufferAttribute(phArr, 1));
      var ringMat = regM(new THREE.ShaderMaterial({
        uniforms: { uTime: UNI.uTime, uDev: UNI.uDev, uFade: UNI.uFade },
        vertexShader: RING_VS, fragmentShader: RING_FS,
        transparent: true, depthWrite: false, depthTest: false,
        blending: THREE.AdditiveBlending
      }));
      deviceRings = new THREE.LineSegments(g, ringMat);
      deviceRings.name = 'city-device-rings';
      deviceRings.frustumCulled = false;
      plateGroup.add(deviceRings);

      // 设备点（用点精灵）
      var accD = new Acc();
      for (var e = 0; e < DEV_POS.length; e++) {
        accD.p(DEV_POS[e][0], 0.72, DEV_POS[e][1], 1.0, 1.0, 1.0, 1.0, (e * 0.11) % 1, 1e9, 6.0);
        accD.p(DEV_POS[e][0], 0.72, DEV_POS[e][1], 0.70, 1.0, 0.92, 0.85, (e * 0.11) % 1, 1e9, 16.0);
        accD.p(DEV_POS[e][0], 0.30, DEV_POS[e][1], 0.55, 1.0, 0.85, 0.70, (e * 0.17) % 1, 1e9, 3.4);
        accD.p(DEV_POS[e][0], PLATE_Y + 0.012, DEV_POS[e][1], 0.55, 1.0, 0.85, 0.95, (e * 0.17) % 1, 1e9, 7.0);
      }
      deviceDots = new THREE.Points(pointGeo(accD), pointMat({ sizeK: 1.0, drift: 0.02, dev: true }));
      deviceDots.name = 'city-device-dots';
      deviceDots.frustumCulled = false;
      plateGroup.add(deviceDots);

      var linkMesh = new THREE.LineSegments(lineGeo(links), lineMat(1.0));
      linkMesh.name = 'city-device-links';
      linkMesh.frustumCulled = false;
      plateGroup.add(linkMesh);

      built.refs.deviceRings = deviceRings;
      built.refs.deviceDots = deviceDots;
      built.refs.deviceLinks = linkMesh;
      // 设备层仅在 green 形态可见
      deviceRings.visible = false;
      deviceDots.visible = false;
      linkMesh.visible = false;
    }

    /* -------------------------------------------------------- 形态 → 着色 */
    function applyTint() {
      UNI.uGrow.value = grow;
      UNI.uFade.value = fade * (1 - 0.45 * greenAmt);   // green 形态整体压暗，避免整屏发白
      UNI.uGreen.value = greenAmt;
      UNI.uDev.value = devAmt;
      UNI.uRoute.value = routeAmt;
      UNI.uPixel.value = Math.min((JV.renderer && JV.renderer.getPixelRatio && JV.renderer.getPixelRatio()) || 1, 2);

      if (!built || !built.refs) return;
      var R = built.refs;
      if (R.ringsGroup) R.ringsGroup.visible = fade > 0.02;
      UNI.uDim.value = 1 - 0.52 * routeAmt;
      if (R.bldEdgeMat) R.bldEdgeMat.opacity = 0.40 * UNI.uDim.value;
      if (R.greenMat) R.greenMat.opacity = greenAmt * 0.10;
      if (R.baseMat) R.baseMat.opacity = 0.085 + 0.08 * Math.min(1, level);
      if (R.hazeMat) R.hazeMat.opacity = 0.04 + 0.05 * level;
      if (R.underMat) R.underMat.opacity = 0.34 * (0.55 + 0.45 * fade) * (1 + 0.20 * greenAmt);

      var showDev = devAmt > 0.02;
      if (R.deviceRings) R.deviceRings.visible = showDev;
      if (R.deviceDots) R.deviceDots.visible = showDev;
      if (R.deviceLinks) R.deviceLinks.visible = showDev;

      var showRoute = routeAmt > 0.02;
      if (R.infoCard) R.infoCard.visible = showRoute;
      if (R.infoLead) R.infoLead.visible = showRoute;
      if (R.endPinGroup) R.endPinGroup.visible = showRoute;
      if (R.startLead) R.startLead.visible = routeAmt > 0.02;

      if (R.compassGroup) {
        R.compassGroup.visible = fade > 0.02;
        for (var i = 0; i < compassSprites.length; i++) {
          // 沙盘塌陷时罗盘也淡出
          compassSprites[i].material.opacity = 0.92 * clamp(fade, 0, 1);
        }
      }
      if (R.startChip) R.startChip.material.opacity = 0.95 * clamp(routeAmt * 1.4, 0, 1);
      if (R.infoCard) R.infoCard.material.opacity = 0.96 * clamp(routeAmt * 1.4, 0, 1);
      if (R.endPinBall) R.endPinBall.material.opacity = 0.95 * routeAmt;
    }

    /* ============================================================ 相机姿态 */
    function applyCamera(dt) {
      var camObj = ctx.camera;
      if (!camObj) return;

      var wantAz, wantEl, wantR, wantTy;
      var gx = gesture.active ? clamp(gesture.x, -1, 1) : 0;
      var gy = gesture.active ? clamp(gesture.y, -1, 1) : 0;
      var pinch = gesture.active ? clamp(gesture.pinch || 0, -1, 1) : 0;

      if (mode === 'build') {
        var p = ease(clamp(modeT / 1.2, 0, 1));
        wantAz = orbitAz + gx * 0.25;
        wantEl = lerp(0.10, 0.575, p) + gy * 0.10;
        wantR = lerp(13.2, 11.15, p) - pinch * 0.6;
        wantTy = lerp(0.28, 0.44, p);
      } else if (mode === 'route') {
        wantAz = orbitAz + 0.40 + gx * 0.55;
        wantEl = 0.215 + gy * 0.10;
        wantR = 9.7 - pinch * 1.2;
        wantTy = 0.36;
      } else if (mode === 'green') {
        wantAz = orbitAz + gx * 0.75;
        wantEl = clamp(0.68 - gy * 0.22, 0.18, 0.95);
        wantR = 11.7 - pinch * 1.4;
        wantTy = 0.30;
      } else if (mode === 'powerOff') {
        wantAz = orbitAz + gx * 0.25;
        wantEl = 0.50 - clamp(modeT / 0.8, 0, 1) * 0.10;
        wantR = 11.1 + clamp(modeT / 0.8, 0, 1) * 0.8;
        wantTy = 0.36;
      } else { // orbit
        wantAz = orbitAz + gx * 1.35;
        wantEl = clamp(0.625 - gy * 0.24, 0.12, 0.95);
        wantR = 10.95 - pinch * 1.6;
        wantTy = 0.42;
      }

      var k = mode === 'build' ? 1 : clamp(dt * 2.2, 0, 1);
      if (mode === 'build') k = clamp(dt * 3.2, 0, 1);
      cam.az += (wantAz - cam.az) * k;
      cam.el += (wantEl - cam.el) * k;
      cam.r += (wantR - cam.r) * k;
      cam.ty += (wantTy - cam.ty) * k;

      var ce = Math.cos(cam.el), se = Math.sin(cam.el);
      camObj.position.set(
        cam.tx + Math.sin(cam.az) * cam.r * ce,
        cam.ty + se * cam.r,
        Math.cos(cam.az) * cam.r * ce
      );
      _v1.set(cam.tx, cam.ty, 0);
      camObj.lookAt(_v1);
    }

    /* ------------------------------------------------- 罗盘随相机的环状摆放 */
    function updateCompass() {
      if (!compassGroup || !ctx.camera) return;
      var camObj = ctx.camera;
      // 相机水平右方向与"朝向"（由相机看向原点推算）
      var fx = -camObj.position.x, fz = -camObj.position.z;
      var fl = Math.hypot(fx, fz) || 1;
      fx /= fl; fz /= fl;                 // 水平前向（指向沙盘中心）
      var rx = -fz, rz = fx;              // 水平右向
      var R = 5.75;
      var y = 0.06;
      // 西：右向的负方向；东：正；北：前向（远）
      compassSprites[0].position.set(-rx * R, y, -rz * R);
      compassSprites[1].position.set(rx * R, y, rz * R);
      compassSprites[2].position.set(fx * R * 1.02, y - 0.02, fz * R * 1.02);
      // 北在相机反方向看为"远"，所以前向 = 远离相机
    }

    /* ============================================================== 形态逻辑 */
    // 各形态的相机基准（setMode 时立即对齐，之后由阻尼吸收手势增量）
    function camBase(m) {
      if (m === 'route') return { el: 0.215, r: 9.7, ty: 0.36, tx: -0.30 };
      if (m === 'green') return { el: 0.68, r: 11.7, ty: 0.30, tx: 0 };
      if (m === 'powerOff') return { el: 0.50, r: 11.1, ty: 0.36, tx: -0.30 };
      if (m === 'build') return { el: 0.10, r: 13.2, ty: 0.28, tx: -0.30 };
      return { el: 0.625, r: 10.95, ty: 0.42, tx: -0.30 };   // orbit
    }

    function setMode(m, payload) {
      var next = m || 'build';
      if (next === mode && modeT < 0.01) return;
      mode = next;
      modeT = 0;
      if (mode === 'build') { grow = 0; fade = 1; }
      if (mode === 'orbit') { grow = 1; fade = 1; }
      if (mode === 'route') { grow = 1; fade = 1; }
      if (mode === 'green') { grow = 1; fade = 1; }
      if (mode === 'powerOff') { /* 从当前值开始塌陷 */ }
      var cb = camBase(mode);
      cam.el = cb.el; cam.r = cb.r; cam.ty = cb.ty;
      if (cb.tx !== undefined) cam.tx = cb.tx;
      applyTint();
    }

    function update(t, dt, state) {
      if (disposed) return;
      time += dt;
      modeT += dt;
      UNI.uTime.value = time;

      /* ---- 形态时间线 ---- */
      if (mode === 'build') {
        var p = clamp(modeT / 1.05, 0, 1);
        grow = ease(p);
        fade = clamp(modeT / 0.28, 0, 1);
        routeAmt += (0 - routeAmt) * clamp(dt * 4, 0, 1);
        greenAmt += (0 - greenAmt) * clamp(dt * 4, 0, 1);
        devAmt += (0 - devAmt) * clamp(dt * 4, 0, 1);
      } else if (mode === 'orbit') {
        grow += (1 - grow) * clamp(dt * 4, 0, 1);
        fade += (1 - fade) * clamp(dt * 4, 0, 1);
        routeAmt += (0 - routeAmt) * clamp(dt * 3.5, 0, 1);
        greenAmt += (0 - greenAmt) * clamp(dt * 3.5, 0, 1);
        devAmt += (0 - devAmt) * clamp(dt * 3.5, 0, 1);
        orbitAz += dt * 0.075;      // 缓慢自转
      } else if (mode === 'route') {
        grow += (1 - grow) * clamp(dt * 4, 0, 1);
        fade += (1 - fade) * clamp(dt * 4, 0, 1);
        routeAmt = Math.min(1, modeT / 0.85);
        greenAmt += (0 - greenAmt) * clamp(dt * 4, 0, 1);
        devAmt += (0 - devAmt) * clamp(dt * 4, 0, 1);
        orbitAz += dt * 0.020;
      } else if (mode === 'green') {
        grow += (1 - grow) * clamp(dt * 4, 0, 1);
        fade += (1 - fade) * clamp(dt * 4, 0, 1);
        routeAmt += (0 - routeAmt) * clamp(dt * 3, 0, 1);
        greenAmt = Math.min(1, modeT / 0.55);
        devAmt = clamp((modeT - 0.28) / 0.5, 0, 1);
        orbitAz += dt * 0.045;
      } else if (mode === 'powerOff') {
        var kk = clamp(modeT / 0.8, 0, 1);
        grow = 1 - easeOut(kk);        // 塌陷
        fade = 1 - clamp((modeT - 0.46) / 0.30, 0, 1);
        routeAmt += (0 - routeAmt) * clamp(dt * 6, 0, 1);
        greenAmt += (0 - greenAmt) * clamp(dt * 6, 0, 1);
        devAmt += (0 - devAmt) * clamp(dt * 6, 0, 1);
      }

      // 沙盘整体微浮（悬浮感）
      var bob = Math.sin(time * 0.62) * 0.022;
      plateGroup.position.y = bob;
      plateGroup.rotation.y = 0;
      if (ringsGroup) {
        ringsGroup.position.y = bob - 0.02;
        ringsGroup.rotation.y = time * 0.035;
        if (built.refs.ringsB) built.refs.ringsB.rotation.y = -time * 0.10;
      }

      applyCamera(dt);
      applyTint();
      updateCompass();

      // 路径流动光点
      if (routeData && built.refs && built.refs.infoCard) {
        var showP = routeAmt > 0.05;
        if (deviceRings) deviceRings.visible = devAmt > 0.02;
        if (built.refs.endPinRing) {
          var pulse = 1 + Math.sin(time * 4.2) * 0.18;
          built.refs.endPinRing.scale.set(pulse, 1, pulse);
          built.refs.endPinRing.material.opacity = 0.55 + 0.4 * Math.sin(time * 4.2) * 0.5 + 0.2;
        }
        if (built.refs.endPinBall) {
          var bs = 0.44 + 0.05 * Math.sin(time * 3.1);
          built.refs.endPinBall.scale.set(bs, bs, 1);
        }
        if (built.refs.infoCard) {
          built.refs.infoCard.position.y = CARD_POS[1] + Math.sin(time * 0.9) * 0.035;
        }
        // 起点牌随沙盘浮动
        if (built.refs.startChip) {
          var sp2 = ROUTE_START;
          built.refs.startChip.position.set(sp2[0] + 0.36, 1.50 + bob + Math.sin(time * 1.1) * 0.02, sp2[1] - 0.16);
        }
        // 光点流动
        updateFlow(dt, showP);
        // 卡片引导线随浮动轻微更新（省略，静态足够）
      }
    }

    /* ------------------------------------------------ 路径上的流动光点 */
    var flowMesh = null, flowAttr = null, flowOff = null, FLOW_N = 0;
    function buildFlow() {
      // 依赖 routeData；在 build() 里被调用前 routeData 已就绪
      FLOW_N = quality === 'low' ? 26 : quality === 'med' ? 46 : 72;
      var pos = new Float32Array(FLOW_N * 3);
      var col = [], aA = [], aSz = [], aPh = [];
      for (var i = 0; i < FLOW_N; i++) {
        col.push(1, 1, 1); aA.push(0.85); aSz.push(2.6 + (i % 3)); aPh.push(i / FLOW_N);
      }
      var g = reg(new THREE.BufferGeometry());
      var attr = new THREE.BufferAttribute(pos, 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('position', attr);
      g.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute('aA', new THREE.Float32BufferAttribute(aA, 1));
      g.setAttribute('aSize', new THREE.Float32BufferAttribute(aSz, 1));
      g.setAttribute('aPhase', new THREE.Float32BufferAttribute(aPh, 1));
      flowAttr = attr;
      flowMesh = new THREE.Points(g, pointMat({ sizeK: 1.0, drift: 0 }));
      flowMesh.name = 'city-route-flow';
      flowMesh.frustumCulled = false;
      group.add(flowMesh);
      flowOff = new Float32Array(FLOW_N);
      for (var j = 0; j < FLOW_N; j++) flowOff[j] = Math.random();
      built.refs.flowMesh = flowMesh;
    }

    function updateFlow(dt, visible) {
      if (!flowMesh) return;
      flowMesh.visible = visible && routeAmt > 0.06;
      if (!flowMesh.visible || !routeData) return;
      var arr = flowAttr.array;
      var n = routeData.n, pts = routeData.pts;
      var spd = 0.10;
      for (var i = 0; i < FLOW_N; i++) {
        var t = (flowOff[i] + time * spd) % 1;
        t = t * routeAmt;   // 随揭示进度推进
        var f = t * n;
        var i0 = f | 0, i1 = Math.min(n, i0 + 1), fr = f - i0;
        var x = pts[i0 * 3] + (pts[i1 * 3] - pts[i0 * 3]) * fr;
        var z = pts[i0 * 3 + 2] + (pts[i1 * 3 + 2] - pts[i0 * 3 + 2]) * fr;
        arr[i * 3] = x;
        arr[i * 3 + 1] = PLATE_Y + 0.035;
        arr[i * 3 + 2] = z;
      }
      flowAttr.needsUpdate = true;
    }

    /* ============================================================== 对外接口 */
    function resize(w, h) {
      applyTint();
    }

    function dispose() {
      disposed = true;
      bus.off('gesture:hand', onGesture);
      disposeBuilt();
      // 释放画布纹理
      if (compassSprites.length) {
        for (var i = 0; i < compassSprites.length; i++) {
          var m = compassSprites[i].material;
          if (m) { if (m.map) m.map.dispose(); m.dispose(); }
        }
        compassSprites.length = 0;
      }
      // 兜底：遍历释放
      var geoSet = [], matSet = [], texSet = [];
      group.traverse(function (o) {
        if (o.geometry && geoSet.indexOf(o.geometry) < 0) geoSet.push(o.geometry);
        var mm = o.material;
        if (mm) {
          var arr = Array.isArray(mm) ? mm : [mm];
          for (var k = 0; k < arr.length; k++) {
            if (matSet.indexOf(arr[k]) < 0) matSet.push(arr[k]);
          }
        }
      });
      for (var a = 0; a < geoSet.length; a++) { try { geoSet[a].dispose(); } catch (e) {} }
      for (var b = 0; b < matSet.length; b++) {
        try {
          if (matSet[b].map && texSet.indexOf(matSet[b].map) < 0) { texSet.push(matSet[b].map); }
          matSet[b].dispose();
        } catch (e) {}
      }
      for (var c = 0; c < texSet.length; c++) { try { texSet[c].dispose(); } catch (e) {} }
      if (group.parent) group.parent.remove(group);
      plateGroup.clear();
      group.clear();
    }

    function onGesture(ev) {
      // 手势旋转统一由全局 stage 处理（boot 里 apply），这里不再自己转，避免双重旋转
      if (!JV.settings || JV.settings.gestureGlobal !== false) return;
      if (!ev) return;
      // 兼容 0..1 或 -1..1 两种归一化；见过负数就按 -1..1 处理
      if (typeof ev.x === 'number' && (ev.x < -0.02 || (typeof ev.y === 'number' && ev.y < -0.02))) gestureSeenNeg = true;
      var nx, ny;
      if (gestureSeenNeg) { nx = ev.x; ny = ev.y; }
      else { nx = (ev.x - 0.5) * 2; ny = (ev.y - 0.5) * 2; }
      gesture.x = clamp(nx || 0, -1, 1);
      gesture.y = clamp(ny || 0, -1, 1);
      gesture.pinch = typeof ev.pinch === 'number' ? ev.pinch : 0;
      gesture.active = true;
    }

    // 首次构建
    build();
    buildFlow();
    bus.on('gesture:hand', onGesture);

    // enter：切入时重置形态
    function enter(opts) {
      opts = opts || {};
      var mt = typeof opts === 'string' ? opts : opts.mode;
      if (mt) { mode = mt; modeT = 0; }
      else { mode = 'build'; modeT = 0; }
      if (mode === 'build') { grow = 0; fade = 1; }
      else { grow = 1; fade = 1; }
      routeAmt = 0; greenAmt = 0; devAmt = 0;
      var cb2 = camBase(mode);
      cam.el = cb2.el; cam.r = cb2.r; cam.ty = cb2.ty;
      if (cb2.tx !== undefined) cam.tx = cb2.tx;
      applyTint();
    }

    return {
      name: 'city',
      group: group,
      enter: enter,
      setMode: setMode,
      setLevel: function (v) { level = clamp(v || 0, 0, 1); },
      setQuality: function (q) {
        if (q === quality) return;
        quality = q;
        build();
        buildFlow();
      },
      update: update,
      resize: resize,
      dispose: dispose,
      // 调试用
      _debug: function () {
        return { mode: mode, modeT: modeT, grow: grow, fade: fade, green: greenAmt, dev: devAmt, route: routeAmt };
      }
    };
  });
})();
