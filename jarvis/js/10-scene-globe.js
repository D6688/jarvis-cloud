/* ============================================================================
 * JARVIS 2.0 · 10-scene-globe.js
 * 全球城市全息：全息地球 → 飞到任意城市 → 真实街道底图 + 全息楼群
 *
 * 数据：本机权限桥（jarvis/server/system_bridge.mjs，127.0.0.1:8824）
 *   GET /api/geo?q=Tokyo                 地名 → 经纬度（Photon / OpenStreetMap，全球可用）
 *   GET /api/tile?provider=esri-dark&z&x&y 地图瓦片代理（暗色底图，已带 CORS）
 *   （Google 地图在部分网络不可达；若能访问，可用 /api/geoimage 走 Static Maps）
 *
 * 形态：earth（全息地球）/ focus（飞向城市）/ city（城市全息沙盘）/ powerOff
 * 手势：手掌左右旋转、捏合/双指缩放（由 core 的 stage 缩放统一处理）
 * ==========================================================================*/
(function () {
  'use strict';
  var THREE = window.THREE;
  var JV = window.JV;
  if (!THREE || !JV) return;

  var U = JV.util;
  var CLOUD_CFG = window.JV_CLOUD || {};
  var BRIDGE = CLOUD_CFG.base || 'http://127.0.0.1:8824';
  var TILE_Z = 14;              // 城市级瓦片缩放
  var GRID_N = 3;               // 3×3 瓦片
  var TILE_SIZE = 256;

  // 常用城市（中文 → 用于 Photon 查询的英文名），避免中文地名解析偏差
  var CITY_ALIAS = {
    '北京': "Beijing",
    '上海': "Shanghai",
    '广州': "Guangzhou",
    '深圳': "Shenzhen",
    '成都': "Chengdu",
    '杭州': "Hangzhou",
    '西安': "Xi'an",
    '重庆': "Chongqing",
    '南京': "Nanjing",
    '武汉': "Wuhan",
    '苏州': "Suzhou",
    '天津': "Tianjin",
    '长沙': "Changsha",
    '郑州': "Zhengzhou",
    '青岛': "Qingdao",
    '厦门': "Xiamen",
    '昆明': "Kunming",
    '大连': "Dalian",
    '沈阳': "Shenyang",
    '哈尔滨': "Harbin",
    '长春': "Changchun",
    '济南': "Jinan",
    '合肥': "Hefei",
    '福州': "Fuzhou",
    '南昌': "Nanchang",
    '南宁': "Nanning",
    '贵阳': "Guiyang",
    '兰州': "Lanzhou",
    '西宁': "Xining",
    '银川': "Yinchuan",
    '乌鲁木齐': "Urumqi",
    '拉萨': "Lhasa",
    '呼和浩特': "Hohhot",
    '石家庄': "Shijiazhuang",
    '太原': "Taiyuan",
    '海口': "Haikou",
    '三亚': "Sanya",
    '无锡': "Wuxi",
    '宁波': "Ningbo",
    '温州': "Wenzhou",
    '佛山': "Foshan",
    '东莞': "Dongguan",
    '珠海': "Zhuhai",
    '中山': "Zhongshan",
    '惠州': "Huizhou",
    '泉州': "Quanzhou",
    '常州': "Changzhou",
    '南通': "Nantong",
    '徐州': "Xuzhou",
    '烟台': "Yantai",
    '淄博': "Zibo",
    '洛阳': "Luoyang",
    '开封': "Kaifeng",
    '桂林': "Guilin",
    '丽江': "Lijiang",
    '大理': "Dali",
    '敦煌': "Dunhuang",
    '张家界': "Zhangjiajie",
    '黄山': "Huangshan",
    '香港': "Hong Kong",
    '澳门': "Macau",
    '台北': "Taipei",
    '高雄': "Kaohsiung",
    '台中': "Taichung",
    '台南': "Tainan",
    '新北': "New Taipei",
    '桃园': "Taoyuan",
    '扬州': "Yangzhou",
    '绍兴': "Shaoxing",
    '嘉兴': "Jiaxing",
    '汕头': "Shantou",
    '湛江': "Zhanjiang",
    '桂林市': "Guilin",
    '遵义': "Zunyi",
    '绵阳': "Mianyang",
    '宜昌': "Yichang",
    '襄阳': "Xiangyang",
    '赣州': "Ganzhou",
    '九江': "Jiujiang",
    '芜湖': "Wuhu",
    '蚌埠': "Bengbu",
    '唐山': "Tangshan",
    '保定': "Baoding",
    '廊坊': "Langfang",
    '秦皇岛': "Qinhuangdao",
    '大同': "Datong",
    '包头': "Baotou",
    '鄂尔多斯': "Ordos",
    '大庆': "Daqing"
  };


  function lonToTileX(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
  function latToTileY(lat, z) {
    var r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
  }
  function tileXToLon(x, z) { return x / Math.pow(2, z) * 360 - 180; }
  function tileYToLat(y, z) {
    var n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  // 对外 API：城市列表（设置面板的城市快捷入口用）
  JV.globe = {
    cities: Object.keys(CITY_ALIAS),
    focus: function (city) {
      var ent = JV.show('globe');
      if (!ent) return Promise.resolve({ ok: false, error: '场景未就绪' });
      ent.setMode('earth');
      return ent.focus(city);
    }
  };

  JV.registerScene('globe', function (ctx) {
    var P = ctx.palette;
    var group = new THREE.Group();
    group.name = 'scene-globe';
    ctx.parent.add(group);

    var quality = ctx.quality || 'high';
    var disposables = [];
    var reg = function (o) { disposables.push(o); return o; };

    var mode = 'earth';
    var targetZoom = 1;

    /* ------------------------------------------------------------ 全息地球 */
    var earth = new THREE.Group();
    group.add(earth);

    var R = 2.0;
    // 球体线框（经纬）
    var sph = new THREE.SphereGeometry(R, 36, 24);
    var wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(sph),
      new THREE.LineBasicMaterial({ color: new THREE.Color(P.mint), transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    earth.add(wire);
    disposables.push(sph, wire.geometry, wire.material);

    // 大气光圈
    var atmo = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.035, 48, 32),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(P.mintGlow), transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false })
    );
    earth.add(atmo);
    disposables.push(atmo.geometry, atmo.material);

    // 赤道 / 轨道环
    var rings = [];
    for (var ri = 0; ri < 3; ri++) {
      var g = new THREE.RingGeometry(R * (1.12 + ri * 0.06), R * (1.125 + ri * 0.06), 128);
      var m = new THREE.MeshBasicMaterial({ color: new THREE.Color(ri === 1 ? P.amber : P.mint), transparent: true, opacity: 0.16 - ri * 0.03, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
      var ring = new THREE.Mesh(g, m);
      ring.rotation.x = Math.PI / 2 - 0.32 + ri * 0.18;
      earth.add(ring); rings.push(ring);
      disposables.push(g, m);
    }

    // 城市光点（标注几个地标城市）
    var CITIES = [
      { n: 'Tokyo', lat: 35.68, lon: 139.76 }, { n: 'New York', lat: 40.71, lon: -74.0 },
      { n: 'London', lat: 51.5, lon: -0.12 }, { n: 'Paris', lat: 48.85, lon: 2.35 },
      { n: 'Shanghai', lat: 31.23, lon: 121.47 }, { n: 'Dubai', lat: 25.2, lon: 55.27 },
      { n: 'Singapore', lat: 1.35, lon: 103.82 }, { n: 'Sydney', lat: -33.87, lon: 151.21 }
    ];
    var dotGeo = new THREE.BufferGeometry();
    var dotPos = new Float32Array(CITIES.length * 3);
    CITIES.forEach(function (c, i) {
      var phi = (90 - c.lat) * Math.PI / 180, theta = (c.lon + 180) * Math.PI / 180;
      dotPos[i * 3] = -R * Math.sin(phi) * Math.cos(theta);
      dotPos[i * 3 + 1] = R * Math.cos(phi);
      dotPos[i * 3 + 2] = R * Math.sin(phi) * Math.sin(theta);
    });
    dotGeo.setAttribute('position', new THREE.BufferAttribute(dotPos, 3));
    var dotMat = new THREE.PointsMaterial({ color: new THREE.Color(P.mintLight), size: 0.075, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    var dots = new THREE.Points(dotGeo, dotMat);
    earth.add(dots);
    disposables.push(dotGeo, dotMat);

    // 星野
    var starN = quality === 'low' ? 400 : 1200;
    var starGeo = new THREE.BufferGeometry();
    var starPos = new Float32Array(starN * 3);
    var rnd = U.rng(4242);
    for (var si = 0; si < starN; si++) {
      var rr = 12 + rnd() * 20, th = rnd() * Math.PI * 2, ph = Math.acos(rnd() * 2 - 1);
      starPos[si * 3] = rr * Math.sin(ph) * Math.cos(th);
      starPos[si * 3 + 1] = rr * Math.cos(ph);
      starPos[si * 3 + 2] = rr * Math.sin(ph) * Math.sin(th);
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    var starMat = new THREE.PointsMaterial({ color: new THREE.Color(P.mintLight), size: 0.05, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
    var stars = new THREE.Points(starGeo, starMat);
    group.add(stars);
    disposables.push(starGeo, starMat);

    /* ------------------------------------------------------- 城市沙盘容器 */
    var cityGroup = new THREE.Group();
    cityGroup.visible = false;
    group.add(cityGroup);

    var cityState = { name: '', lat: 0, lon: 0, tiles: null, tex: null, loading: false, error: '' };
    var mapPlane = null, mapMat = null, bldGroup = null, scan = null, cityLabel = null, cityLabelTex = null;

    function makeTextTexture(lines, opts) {
      opts = opts || {};
      var cw = 512, ch = 128 * lines.length;
      var cv = document.createElement('canvas');
      cv.width = cw; cv.height = ch;
      var c2 = cv.getContext('2d');
      c2.clearRect(0, 0, cw, ch);
      lines.forEach(function (line, i) {
        c2.font = (i === 0 ? '600 40px ' : '400 26px ') + '"PingFang SC", "Helvetica Neue", sans-serif';
        c2.fillStyle = i === 0 ? 'rgba(185,255,232,.96)' : 'rgba(198,255,239,.62)';
        c2.textAlign = 'center';
        c2.fillText(line, cw / 2, 64 + i * 92);
      });
      var tex = new THREE.CanvasTexture(cv);
      tex.minFilter = THREE.LinearFilter;
      return tex;
    }

    function clearCity() {
      if (bldGroup) { cityGroup.remove(bldGroup); bldGroup.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); bldGroup = null; }
      if (mapPlane) { cityGroup.remove(mapPlane); mapPlane.geometry.dispose(); mapMat.map && mapMat.map.dispose(); mapMat.dispose(); mapPlane = null; }
      if (cityLabel) { cityGroup.remove(cityLabel); cityLabelTex && cityLabelTex.dispose(); cityLabel = null; }
      if (scan) { cityGroup.remove(scan); scan.geometry.dispose(); scan.material.dispose(); scan = null; }
    }

    // 加载 3×3 瓦片 → 拼成一张 texture
    function loadTiles(lat, lon) {
      var n = Math.pow(2, TILE_Z);
      var cx = Math.floor(lonToTileX(lon, TILE_Z));
      var cy = Math.floor(latToTileY(lat, TILE_Z));
      var x0 = cx - Math.floor(GRID_N / 2), y0 = cy - Math.floor(GRID_N / 2);
      var cv = document.createElement('canvas');
      cv.width = GRID_N * TILE_SIZE; cv.height = GRID_N * TILE_SIZE;
      var c2 = cv.getContext('2d');
      c2.fillStyle = '#04090b'; c2.fillRect(0, 0, cv.width, cv.height);
      var jobs = [];
      for (var gy = 0; gy < GRID_N; gy++) {
        for (var gx = 0; gx < GRID_N; gx++) {
          (function (gx2, gy2) {
            var x = x0 + gx2, y = y0 + gy2;
            if (y < 0 || y >= n) { return; }
            var url = BRIDGE + '/api/tile?provider=esri-dark&z=' + TILE_Z + '&x=' + ((x % n) + n) % n + '&y=' + y;
            jobs.push(new Promise(function (resolve) {
              var img = new Image();
              img.crossOrigin = 'anonymous';
              img.onload = function () { try { c2.drawImage(img, gx2 * TILE_SIZE, gy2 * TILE_SIZE, TILE_SIZE, TILE_SIZE); } catch (e) {} resolve(true); };
              img.onerror = function () { resolve(false); };
              img.src = url;
            }));
          })(gx, gy);
        }
      }
      return Promise.all(jobs).then(function (oks) {
        var loaded = oks.filter(Boolean).length;
        if (!loaded) return null;
        // 瓦片网格对应的经纬度范围
        var west = tileXToLon(x0, TILE_Z), east = tileXToLon(x0 + GRID_N, TILE_Z);
        var north = tileYToLat(y0, TILE_Z), south = tileYToLat(y0 + GRID_N, TILE_Z);
        return { canvas: cv, west: west, east: east, north: north, south: south, loaded: loaded };
      });
    }

    // 用底图亮度生成全息楼群：亮处=道路/水面（不起楼），暗块=街区（起楼，高度随机分层）
    function buildBuildings(tiles) {
      var g = new THREE.Group();
      var acc = [];
      var N = quality === 'low' ? 24 : quality === 'med' ? 32 : 40;
      var cv = tiles.canvas;
      var ctx2 = cv.getContext('2d');
      var data;
      try { data = ctx2.getImageData(0, 0, cv.width, cv.height).data; } catch (e) { data = null; }
      var W = 10, D = 10;
      var cellW = W / N, cellD = D / N;
      var seed = U.rng(20260311);
      function lumAt(px, py) {
        if (!data) return 0.2;
        var idx = (py * cv.width + px) * 4;
        return (data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114) / 255;
      }
      for (var iy = 0; iy < N; iy++) {
        for (var ix = 0; ix < N; ix++) {
          var px = Math.floor((ix + 0.5) / N * cv.width);
          var py = Math.floor((iy + 0.5) / N * cv.height);
          var l = lumAt(px, py);
          if (l > 0.30) continue;                       // 道路/标签/水面：不起楼
          if (seed() > 0.52) continue;                  // 街区留白，避免满格
          var h = 0.14 + Math.pow(seed(), 1.5) * 1.7 + (l < 0.1 ? 0.3 : 0);
          var x = -W / 2 + (ix + 0.5) * cellW;
          var z = -D / 2 + (iy + 0.5) * cellD;
          var w = cellW * (0.30 + seed() * 0.16), d = cellD * (0.30 + seed() * 0.16);
          var y1 = h;
          acc.push(x - w, 0, z - d, x - w, y1, z - d);
          acc.push(x + w, 0, z - d, x + w, y1, z - d);
          acc.push(x + w, 0, z + d, x + w, y1, z + d);
          acc.push(x - w, 0, z + d, x - w, y1, z + d);
          acc.push(x - w, y1, z - d, x + w, y1, z - d);
          acc.push(x + w, y1, z - d, x + w, y1, z + d);
          acc.push(x + w, y1, z + d, x - w, y1, z + d);
          acc.push(x - w, y1, z + d, x - w, y1, z - d);
          // 顶部小竖光（高楼更容易被看见）
          if (h > 1.2) acc.push(x, y1, z, x, y1 + 0.12, z);
        }
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(acc, 3));
      var mat = new THREE.LineBasicMaterial({
        color: new THREE.Color(P.mint), transparent: true, opacity: 0.34,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      var lines = new THREE.LineSegments(geo, mat);
      g.add(lines);
      g.userData.destroy = function () { geo.dispose(); mat.dispose(); };
      return g;
    }

    function showCity(tiles, label) {
      clearCity();
      var cv = tiles.canvas;
      var tex = new THREE.CanvasTexture(cv);
      tex.minFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      cityState.tex = tex;

      mapMat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0.42,
        color: new THREE.Color(0x8ef2cf), blending: THREE.NormalBlending, depthWrite: false
      });
      var geo = new THREE.PlaneGeometry(10, 10);
      mapPlane = new THREE.Mesh(geo, mapMat);
      mapPlane.rotation.x = -Math.PI / 2;
      mapPlane.position.y = -0.02;
      cityGroup.add(mapPlane);

      bldGroup = buildBuildings(tiles);
      cityGroup.add(bldGroup);

      // 底座发光边框
      var edgePts = [
        [-5, 0, -5], [5, 0, -5], [5, 0, -5], [5, 0, 5],
        [5, 0, 5], [-5, 0, 5], [-5, 0, 5], [-5, 0, -5]
      ];
      var edgeGeo = new THREE.BufferGeometry();
      var edgeArr = [];
      edgePts.forEach(function (p2) { edgeArr.push(p2[0], 0.01, p2[2]); });
      edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgeArr, 3));
      var edgeMat = new THREE.LineBasicMaterial({ color: new THREE.Color(P.mintGlow), transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false });
      cityGroup.add(new THREE.LineSegments(edgeGeo, edgeMat));
      disposables.push(edgeGeo, edgeMat);

      // 沙盘网格
      var gridG = new THREE.GridHelper(10, 20, new THREE.Color(P.mint), new THREE.Color(P.mintDeep));
      gridG.position.y = 0.005;
      gridG.material.transparent = true; gridG.material.opacity = 0.12;
      gridG.material.depthWrite = false;
      cityGroup.add(gridG);
      disposables.push(gridG.geometry, gridG.material);

      // 扫描线
      var sg = new THREE.PlaneGeometry(10, 0.45);
      var sm = new THREE.MeshBasicMaterial({ color: new THREE.Color(P.mintGlow), transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false });
      scan = new THREE.Mesh(sg, sm);
      scan.rotation.x = -Math.PI / 2;
      scan.position.y = 0.04;
      cityGroup.add(scan);

      // 城市铭牌
      cityLabelTex = makeTextTexture([label.name || label.city || 'CITY', (label.lat.toFixed(4) + '°, ' + label.lon.toFixed(4) + '°'), 'GLOBAL CITY HOLOGRAM']);
      var lm = new THREE.SpriteMaterial({ map: cityLabelTex, transparent: true, depthWrite: false, depthTest: false, opacity: 0.9 });
      cityLabel = new THREE.Sprite(lm);
      cityLabel.scale.set(4.6, 1.15, 1);
      cityLabel.position.set(0, 1.55, -6.2);
      cityGroup.add(cityLabel);

      earth.visible = false;
      cityGroup.visible = true;
      mode = 'city';
    }

    /* -------------------------------------------- 真实城市 3D（OSM 矢量瓦片） */
    function showCity3D(data, label) {
      clearCity();
      // 归一化：取数据自身包围盒居中，横向铺满 ±4.6；高度按最高楼归一
      var minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9, maxH = 20;
      function scanPts(pt) {
        minX = Math.min(minX, pt[0]); maxX = Math.max(maxX, pt[0]);
        minZ = Math.min(minZ, pt[1]); maxZ = Math.max(maxZ, pt[1]);
      }
      (data.buildings || []).forEach(function (b) { b.p.forEach(scanPts); maxH = Math.max(maxH, b.h || 10); });
      (data.roads || []).forEach(function (r) { r.p.forEach(scanPts); });
      (data.water || []).forEach(function (w) { w.p.forEach(scanPts); });
      if (!(maxX > minX) || !(maxZ > minZ)) { minX = -800; maxX = 800; minZ = -800; maxZ = 800; }
      var cX = (minX + maxX) / 2, cZ = (minZ + maxZ) / 2;
      var halfSpan = Math.max((maxX - minX) / 2, (maxZ - minZ) / 2, 150);
      var S = 4.6 / halfSpan;                                  // 世界单位/米
      var HS = 2.6 / Math.max(12, maxH);                       // 高度归一
      var mint = new THREE.Color(P.mint), mintLight = new THREE.Color(P.mintLight);
      var amber = new THREE.Color(P.amber);

      // ---- 地面
      var groundGeo = new THREE.PlaneGeometry(10, 10);
      var groundMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#050f0d'), transparent: true, opacity: 0.9, depthWrite: false });
      var ground = new THREE.Mesh(groundGeo, groundMat);
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.01;
      cityGroup.add(ground);
      disposables.push(groundGeo, groundMat);

      var grid = new THREE.GridHelper(10, 24, new THREE.Color(P.mint), new THREE.Color(P.mintDeep));
      grid.position.y = 0.002;
      grid.material.transparent = true; grid.material.opacity = 0.1; grid.material.depthWrite = false;
      cityGroup.add(grid);
      disposables.push(grid.geometry, grid.material);

      // ---- 水面（多边形填充）
      (data.water || []).forEach(function (w) {
        var pts = w.p.map(function (q) { return new THREE.Vector2((q[0] - cX) * S, (q[1] - cZ) * S); });
        if (pts.length < 3) return;
        var shape = new THREE.Shape(pts);
        var g2 = new THREE.ShapeGeometry(shape);
        var m2 = new THREE.MeshBasicMaterial({ color: new THREE.Color('#0a3b46'), transparent: true, opacity: 0.28, depthWrite: false });
        var mesh = new THREE.Mesh(g2, m2);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.y = 0.004;
        cityGroup.add(mesh);
        disposables.push(g2, m2);
      });

      // ---- 建筑：真实轮廓 → 实例化方盒（位置/尺寸取自 OSM footprint，高度取真实层高）
      var mats = [];
      (data.buildings || []).forEach(function (b) {
        var pts = b.p;
        if (!pts || pts.length < 3) return;
        var minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9, cx = 0, cz = 0;
        for (var i = 0; i < pts.length; i++) {
          var q = pts[i];
          minx = Math.min(minx, q[0]); maxx = Math.max(maxx, q[0]);
          minz = Math.min(minz, q[1]); maxz = Math.max(maxz, q[1]);
          cx += q[0]; cz += q[1];
        }
        cx /= pts.length; cz /= pts.length;
        var w = Math.max(2, (maxx - minx)) * S, d = Math.max(2, (maxz - minz)) * S;
        var h = Math.max(3, b.h || 8) * HS;
        mats.push({ x: (cx - cX) * S, z: (cz - cZ) * S, w: Math.min(w, 0.6), d: Math.min(d, 0.6), h: h });
      });
      var bCount = mats.length;
      if (bCount) {
        var boxGeo = new THREE.BoxGeometry(1, 1, 1);
        var boxMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(P.mint), transparent: true, opacity: 0.3,
          blending: THREE.AdditiveBlending, depthWrite: false
        });
        var inst = new THREE.InstancedMesh(boxGeo, boxMat, bCount);
        var m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), v3 = new THREE.Vector3(), sc = new THREE.Vector3();
        mats.forEach(function (b, i) {
          v3.set(b.x, b.h / 2, b.z);
          sc.set(b.w, b.h, b.d);
          m4.compose(v3, q4, sc);
          inst.setMatrixAt(i, m4);
        });
        inst.instanceMatrix.needsUpdate = true;
        cityGroup.add(inst);
        disposables.push(boxGeo, boxMat);

        // 顶部描边（让轮廓更"全息"）
        var topGeo = new THREE.BoxGeometry(1, 0.001, 1);
        var topMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(P.mintLight), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
        var topInst = new THREE.InstancedMesh(topGeo, topMat, bCount);
        mats.forEach(function (b, i) {
          v3.set(b.x, b.h, b.z); sc.set(b.w * 1.02, 1, b.d * 1.02);
          m4.compose(v3, q4, sc); topInst.setMatrixAt(i, m4);
        });
        topInst.instanceMatrix.needsUpdate = true;
        cityGroup.add(topInst);
        disposables.push(topGeo, topMat);
        bldGroup = new THREE.Group(); bldGroup.add(inst, topInst);
      }

      // ---- 道路：按等级分色
      var ROAD_STYLE = {
        motorway: { c: new THREE.Color(P.amber), o: 0.55 }, trunk: { c: new THREE.Color(P.amber), o: 0.5 },
        primary: { c: new THREE.Color('#ffd9a8'), o: 0.42 }, secondary: { c: new THREE.Color(P.mintLight), o: 0.3 },
        tertiary: { c: new THREE.Color(P.mint), o: 0.26 }
      };
      var groups = {};
      (data.roads || []).forEach(function (r) {
        var st = ROAD_STYLE[r.c] || { c: mint, o: 0.18 };
        var key = r.c + '|' + st.o;
        if (!groups[key]) groups[key] = { c: st.c, o: st.o, seg: [] };
        for (var i = 0; i < r.p.length - 1; i++) {
          groups[key].seg.push((r.p[i][0] - cX) * S, 0.02, (r.p[i][1] - cZ) * S,
                               (r.p[i + 1][0] - cX) * S, 0.02, (r.p[i + 1][1] - cZ) * S);
        }
      });
      Object.keys(groups).forEach(function (k) {
        var g3 = groups[k];
        if (!g3.seg.length) return;
        var rg = new THREE.BufferGeometry();
        rg.setAttribute('position', new THREE.Float32BufferAttribute(g3.seg, 3));
        var rm = new THREE.LineBasicMaterial({ color: g3.c, transparent: true, opacity: g3.o, blending: THREE.AdditiveBlending, depthWrite: false });
        cityGroup.add(new THREE.LineSegments(rg, rm));
        disposables.push(rg, rm);
      });

      // ---- 底座发光边框 + 扫描线
      var edgeArr = [];
      [[-5, -5], [5, -5], [5, -5], [5, 5], [5, 5], [-5, 5], [-5, 5], [-5, -5]].forEach(function (p2) {
        edgeArr.push(p2[0], 0.01, p2[1]);
      });
      var eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.Float32BufferAttribute(edgeArr, 3));
      var em = new THREE.LineBasicMaterial({ color: new THREE.Color(P.mintGlow), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
      cityGroup.add(new THREE.LineSegments(eg, em));
      disposables.push(eg, em);

      var sg = new THREE.PlaneGeometry(10, 0.5);
      var sm = new THREE.MeshBasicMaterial({ color: new THREE.Color(P.mintGlow), transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false });
      scan = new THREE.Mesh(sg, sm);
      scan.rotation.x = -Math.PI / 2;
      scan.position.y = 0.05;
      cityGroup.add(scan);

      // ---- 铭牌：城市 + 真实数据来源
      cityLabelTex = makeTextTexture([
        (label.name || 'CITY') + ' · 真实城市',
        label.lat.toFixed(4) + '°, ' + label.lon.toFixed(4) + '° · ' + bCount + ' 栋建筑',
        'OSM / OpenFreeMap · 3D HOLOGRAM'
      ]);
      var lm = new THREE.SpriteMaterial({ map: cityLabelTex, transparent: true, depthWrite: false, depthTest: false, opacity: 0.92 });
      cityLabel = new THREE.Sprite(lm);
      cityLabel.scale.set(5.2, 1.3, 1);
      cityLabel.position.set(0, 1.8, -6.0);
      cityGroup.add(cityLabel);

      earth.visible = false;
      cityGroup.visible = true;
      mode = 'city';
      cityState.real = true;
      cityState.count = bCount;
      cityState.source = data.source || 'OpenFreeMap';
      JV.bus.emit('globe:city3d', { name: label.name, buildings: bCount, roads: (data.roads || []).length });
    }

    /* ------------------------------------------------------------ 地理查询 */
    function lookupCity(q) {
      var name = String(q || '').trim();
      if (!name) name = 'Tokyo';
      var query = CITY_ALIAS[name] || name;
      cityState.error = '';
      return fetch(BRIDGE + '/api/geo?q=' + encodeURIComponent(query), { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.ok || !j.results || !j.results.length) throw new Error('地名解析失败');
          var city = j.results.filter(function (r) { return r.type === 'city' || r.type === 'administrative'; })[0] || j.results[0];
          cityState.name = name; cityState.lat = city.lat; cityState.lon = city.lon;
          // 首选：真实 OSM 建筑/道路（OpenFreeMap 矢量瓦片）
          return fetch(BRIDGE + '/api/citymap?lat=' + city.lat + '&lon=' + city.lon, { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (data && data.ok && data.buildings && data.buildings.length) {
                showCity3D(data, { name: name, lat: city.lat, lon: city.lon });
                return { ok: true, name: name, lat: city.lat, lon: city.lon, real: true,
                         buildings: data.buildings.length, roads: (data.roads || []).length };
              }
              throw new Error('真实城市数据不可用');
            })
            .catch(function () {
              // 兜底：底图亮度生成示意楼群
              return loadTiles(city.lat, city.lon).then(function (tiles) {
                if (!tiles) throw new Error('地图瓦片不可达');
                showCity(tiles, { name: name, lat: city.lat, lon: city.lon });
                return { ok: true, name: name, lat: city.lat, lon: city.lon, real: false, tiles: tiles.loaded };
              });
            });
        })
        .catch(function (e) {
          cityState.error = e.message || '加载失败';
          // 兜底：没有任何地图数据时，显示程序化城市（用 city 场景的观感）
          return { ok: false, error: cityState.error, name: name };
        });
    }

    /* ---------------------------------------------------------------- 相机 */
    var camBase = { earth: { r: 6.6, el: 0.35 }, city: { r: 13.2, el: 0.82 } };
    var cam = { az: 0.5, el: 0.35, r: 6.6, ty: 0 };
    var drag = { on: false, x: 0, y: 0, yaw: 0 };

    function applyCamera() {
      if (!ctx.camera) return;
      var c = ctx.camera;
      c.position.x = Math.sin(cam.az) * Math.cos(cam.el) * cam.r;
      c.position.y = Math.sin(cam.el) * cam.r + cam.ty;
      c.position.z = Math.cos(cam.az) * Math.cos(cam.el) * cam.r;
      c.lookAt(0, cam.ty * 0.6, 0);
    }

    var t0 = 0, yaw = 0;
    function setMode(m) {
      if (!m) return;
      if (m === 'earth') { mode = 'earth'; earth.visible = true; cityGroup.visible = false; cam.r = camBase.earth.r; cam.el = camBase.earth.el; }
      else if (m === 'city') { mode = 'city'; if (cityState.tex) { earth.visible = false; cityGroup.visible = true; cam.r = camBase.city.r; cam.el = camBase.city.el; } }
      else if (m === 'powerOff') { mode = 'powerOff'; }
      applyCamera();
    }

    applyCamera();

    return {
      name: 'globe',
      group: group,
      enter: function () {
        mode = 'earth'; earth.visible = true; cityGroup.visible = false;
        cam.r = camBase.earth.r; cam.el = camBase.earth.el; applyCamera();
      },
      setMode: setMode,
      setLevel: function () {},
      setQuality: function () {},
      resize: function () { applyCamera(); },
      focus: function (city) {
        setMode('earth');
        return lookupCity(city).then(function (r) {
          if (r && r.ok) {
            mode = 'city';
            cam.r = camBase.city.r; cam.el = camBase.city.el;
            applyCamera();
            JV.bus.emit('globe:focus', r);
          }
          return r;
        });
      },
      lookup: function (city) { return lookupCity(city); },
      status: function () { return { mode: mode, name: cityState.name, lat: cityState.lat, lon: cityState.lon, error: cityState.error, real: !!cityState.real, count: cityState.count || 0, source: cityState.source || '' }; },
      update: function (t, dt) {
        t0 += dt;
        if (mode !== 'city') {
          yaw += dt * 0.055;
          earth.rotation.y = yaw;
          rings.forEach(function (r2, i) { r2.rotation.z += dt * (0.12 - i * 0.03); });
          dots.rotation.y = yaw * 0.0;   // 城市点随球体一起转（已挂在 earth 内）
          stars.rotation.y += dt * 0.004;
          atmo.material.opacity = 0.045 + Math.sin(t0 * 1.4) * 0.015;
        } else {
          if (scan) {
            scan.position.z = -5 + ((t0 * 1.6) % 10);
          }
          if (bldGroup) bldGroup.rotation.y = Math.sin(t0 * 0.06) * 0.02;
        }
        applyCamera();
      },
      dispose: function () {
        clearCity();
        disposables.forEach(function (d) { try { d.dispose(); } catch (e) {} });
        if (group.parent) group.parent.remove(group);
      }
    };
  });
})();
