/* ============================================================================
 * JARVIS 2.0 · 03-scene-grid.js
 * 系统自检 / 兜底场景：雷达扫描网格 + 扫描线 + 星尘
 * 依赖：JV（00-core.js）
 * ==========================================================================*/
(function () {
  'use strict';
  var JV = window.JV;
  if (!JV || !window.THREE) return;
  var THREE = window.THREE;
  var U = JV.util;

  JV.registerScene('grid', function (ctx) {
    var P = ctx.palette;
    var group = new THREE.Group();
    group.name = 'scene-grid';
    ctx.parent.add(group);

    var quality = ctx.quality || 'high';
    var disposables = [];

    // 地面网格
    var gridGeo = new THREE.PlaneBufferGeometry(60, 60, 60, 60);
    var gridMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(P.mint), wireframe: true, transparent: true,
      opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false
    });
    var grid = new THREE.Mesh(gridGeo, gridMat);
    grid.rotation.x = -Math.PI / 2;
    grid.position.y = -2.2;
    group.add(grid);
    disposables.push(gridGeo, gridMat);

    // 雷达环
    var rings = [];
    for (var i = 0; i < 4; i++) {
      var r = 2 + i * 2.4;
      var rg = new THREE.RingBufferGeometry(r, r + 0.02, 96, 1);
      var rm = new THREE.MeshBasicMaterial({
        color: new THREE.Color(i % 2 ? P.amber : P.mint), transparent: true,
        opacity: 0.22 - i * 0.035, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false
      });
      var ring = new THREE.Mesh(rg, rm);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = -2.18;
      group.add(ring);
      rings.push(ring);
      disposables.push(rg, rm);
    }

    // 扫描扇面
    var sweepGeo = new THREE.CircleBufferGeometry(9, 48, 0, Math.PI / 5);
    var sweepMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(P.mintLight), transparent: true, opacity: 0.06,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false
    });
    var sweep = new THREE.Mesh(sweepGeo, sweepMat);
    sweep.rotation.x = -Math.PI / 2;
    sweep.position.y = -2.17;
    group.add(sweep);
    disposables.push(sweepGeo, sweepMat);

    // 星尘
    var count = quality === 'high' ? 4200 : quality === 'med' ? 1800 : 700;
    var pos = new Float32Array(count * 3);
    var seed = U.rng(7717);
    for (var k = 0; k < count; k++) {
      var rr = 2 + seed() * 16;
      var th = seed() * Math.PI * 2;
      pos[k * 3] = Math.cos(th) * rr;
      pos[k * 3 + 1] = (seed() - 0.35) * 12;
      pos[k * 3 + 2] = Math.sin(th) * rr;
    }
    var dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    var dustMat = new THREE.PointsMaterial({
      color: new THREE.Color(P.mintLight), size: 0.035, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    var dust = new THREE.Points(dustGeo, dustMat);
    group.add(dust);
    disposables.push(dustGeo, dustMat);

    // 中心竖直光柱
    var beamGeo = new THREE.CylinderBufferGeometry(0.02, 0.34, 8, 12, 1, true);
    var beamMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(P.mint), transparent: true, opacity: 0.07,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false
    });
    var beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.y = 1.4;
    group.add(beam);
    disposables.push(beamGeo, beamMat);

    var t0 = 0, mode = 'idle';
    return {
      name: 'grid',
      group: group,
      enter: function () { t0 = 0; },
      setMode: function (m) { mode = m; },
      setLevel: function () {},
      setQuality: function () {},
      update: function (t, dt) {
        t0 += dt;
        sweep.rotation.z = -t0 * 1.4;
        rings.forEach(function (r, i) {
          r.material.opacity = 0.16 + Math.sin(t0 * 1.4 - i * 0.6) * 0.07;
        });
        dust.rotation.y = t0 * 0.035;
        dust.position.y = Math.sin(t0 * 0.4) * 0.15;
        beam.material.opacity = 0.045 + Math.sin(t0 * 2.1) * 0.02;
        gridMat.opacity = 0.1 + Math.sin(t0 * 0.8) * 0.02;
        group.rotation.y = Math.sin(t0 * 0.12) * 0.06;
      },
      resize: function () {},
      dispose: function () {
        disposables.forEach(function (d) { try { d.dispose(); } catch (e) {} });
        if (group.parent) group.parent.remove(group);
      }
    };
  });
})();
