#!/usr/bin/env node
/**
 * JARVIS 云端服务（单进程、零依赖）
 * ---------------------------------------------------------------
 * 一个进程同时提供：静态页面 + 大模型代理 + 搜索/地图数据代理 + 记忆同步
 * 部署到任何支持 Node 18+ 的云（Render / Railway / Fly / VPS / Docker）
 *
 * 环境变量：
 *   PORT                监听端口（默认 8890）
 *   OPENAI_API_KEY      大模型 key（DeepSeek 等）
 *   OPENAI_BASE_URL     默认 https://api.deepseek.com/v1
 *   MODEL               默认 deepseek-chat
 *   CLOUD_TOKEN         可选：访问 /api/chat 与 /api/memory 需要 ?token= 或 Authorization
 *   PUBLIC_DIR          静态目录（默认仓库根，能找到 JARVIS-HUD.html / JARVIS-手势版.html）
 *   ASR_WS              可选：本机/云上的语音识别 WS 地址，前端会自动使用
 *
 * 启动：OPENAI_API_KEY=sk-xxx node server/cloud-server.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8890);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || ROOT);
const TOKEN = process.env.CLOUD_TOKEN || '';
const ASR_WS = process.env.ASR_WS || '';

const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.MODEL || 'deepseek-chat';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_BASE_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/+$/, '');

const MEMORY_FILE = path.resolve(process.env.MEMORY_FILE || path.join(os.tmpdir(), 'jarvis-cloud-memory.json'));

/* CORS + 公共响应头 */
function headers(extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    ...extra
  };
}
function json(res, code, body) {
  res.writeHead(code, headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }));
  res.end(JSON.stringify(body));
}
function authed(req, url) {
  if (!TOKEN) return true;
  const q = url.searchParams.get('token');
  const h = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return q === TOKEN || h === TOKEN;
}

/* ------------------------------------------------------------ 静态文件 */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.tflite': 'application/octet-stream',
  '.binarypb': 'application/octet-stream', '.task': 'application/octet-stream', '.ico': 'image/x-icon'
};
function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p === '/' || p === '') p = '/JARVIS-HUD.html';
  const file = path.resolve(PUBLIC_DIR, '.' + p);
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { ok: false, error: 'forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // 单文件版默认回落到 JARVIS-HUD.html
      const fallback = path.join(PUBLIC_DIR, 'JARVIS-HUD.html');
      if (fs.existsSync(fallback) && p !== '/JARVIS-HUD.html') {
        res.writeHead(200, headers({ 'content-type': 'text/html; charset=utf-8' }));
        return fs.createReadStream(fallback).pipe(res);
      }
      return json(res, 404, { ok: false, error: 'not found' });
    }
    const ext = path.extname(file).toLowerCase();
    if (ext === '.html') {
      // 注入 PWA 元信息（iPhone 加到主屏、全屏、图标），单文件本身保持干净
      let html = fs.readFileSync(file, 'utf8');
      if (!html.includes('name="apple-mobile-web-app-capable"')) {
        const inject = [
          '<link rel="manifest" href="/manifest.json" />',
          '<link rel="apple-touch-icon" href="/icon-180.png" />',
          '<meta name="apple-mobile-web-app-capable" content="yes" />',
          '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
          '<meta name="apple-mobile-web-app-title" content="JARVIS" />',
          '<meta name="mobile-web-app-capable" content="yes" />'
        ].join('\n');
        html = html.replace('</head>', inject + '\n</head>');
      }
      res.writeHead(200, headers({ 'content-type': MIME['.html'], 'cache-control': 'no-store' }));
      return res.end(html);
    }
    res.writeHead(200, headers({
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'public, max-age=3600'
    }));
    fs.createReadStream(file).pipe(res);
  });
}

/* ------------------------------------------------------- 大模型代理（SSE） */
async function chatProxy(req, res, url) {
  if (!authed(req, url)) return json(res, 401, { ok: false, error: 'unauthorized' });
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy(); });
  req.on('end', async () => {
    let payload;
    try { payload = JSON.parse(body || '{}'); } catch (e) { return json(res, 400, { ok: false, error: 'bad json' }); }
    const provider = payload.provider || (ANTHROPIC_API_KEY && !OPENAI_API_KEY ? 'anthropic' : 'openai');
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const stream = payload.stream !== false;
    const model = payload.model || MODEL;
    try {
      if (provider === 'anthropic') {
        return await anthropicStream(res, messages, { model: payload.anthropicModel || 'claude-3-5-haiku-latest', stream });
      }
      if (!OPENAI_API_KEY) return json(res, 200, { ok: false, fallback: true, error: '云端未配置 OPENAI_API_KEY，使用本地意图' });
      const upstream = await fetch(OPENAI_BASE_URL + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + OPENAI_API_KEY },
        body: JSON.stringify({ model, messages, stream, temperature: payload.temperature ?? 0.6 })
      });
      if (!upstream.ok) {
        const t = await upstream.text();
        return json(res, 502, { ok: false, error: '上游 ' + upstream.status + '：' + t.slice(0, 300) });
      }
      if (!stream) {
        const j = await upstream.json();
        return json(res, 200, { ok: true, text: j.choices?.[0]?.message?.content || '', provider: 'openai', model });
      }
      res.writeHead(200, headers({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' }));
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(dec.decode(value, { stream: true }));
      }
      res.end();
    } catch (e) {
      if (!res.headersSent) json(res, 500, { ok: false, error: e.message });
      else res.end();
    }
  });
}

async function anthropicStream(res, messages, opts) {
  if (!ANTHROPIC_API_KEY) return json(res, 200, { ok: false, fallback: true, error: '云端未配置 ANTHROPIC_API_KEY' });
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const rest = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
  const upstream = await fetch(ANTHROPIC_BASE_URL + '/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: opts.model, system: sys, messages: rest, max_tokens: 1024, stream: true })
  });
  if (!upstream.ok) return json(res, 502, { ok: false, error: 'Anthropic ' + upstream.status });
  res.writeHead(200, headers({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' }));
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const ev = JSON.parse(data);
        if (ev.type === 'content_block_delta' && ev.delta?.text) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: ev.delta.text } }] }) + '\n\n');
        }
      } catch (e) {}
    }
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

/* -------------------------------------------------- 搜索 / 地名 / 瓦片 / 城市 */
const CACHE = new Map();
function cacheGet(k, ttl = 1000 * 60 * 30) {
  const it = CACHE.get(k);
  if (!it || Date.now() - it.at > ttl) return null;
  return it;
}
function cacheSet(k, v) {
  CACHE.set(k, { at: Date.now(), v });
  if (CACHE.size > 800) CACHE.delete(CACHE.keys().next().value);
}

async function search(q, n) {
  const key = 's:' + q + ':' + n;
  const hit = cacheGet(key, 1000 * 60 * 10);
  if (hit) return hit.v;
  const url = 'https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN';
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'accept-language': 'zh-CN,zh;q=0.9' } });
  const html = await res.text();
  const out = [];
  for (const b of html.split('<li class="b_algo"').slice(1)) {
    const m = b.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const a = b.match(/<a[^>]+href="(https?:\/\/[^"]+)"/);
    if (!m || !a) continue;
    const text = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    out.push({ title: text(m[1]), url: a[1], snippet: text((b.match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '').slice(0, 220) });
    if (out.length >= n) break;
  }
  const data = { ok: out.length > 0, engine: 'bing', results: out };
  cacheSet(key, data);
  return data;
}

async function geo(q) {
  const key = 'g:' + q.toLowerCase();
  const hit = cacheGet(key);
  if (hit) return hit.v;
  const res = await fetch('https://photon.komoot.io/api/?q=' + encodeURIComponent(q) + '&limit=5');
  const j = await res.json();
  const results = (j.features || []).map((f) => {
    const p = f.properties || {};
    const [lon, lat] = f.geometry.coordinates;
    return { name: [p.name, p.city, p.state, p.country].filter(Boolean).slice(0, 2).join(' · '), lat, lon, type: p.type || '' };
  });
  const data = { ok: results.length > 0, results };
  cacheSet(key, data);
  return data;
}

const TILE_PROVIDERS = {
  'esri-dark': (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`,
  'esri-sat': (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  'amap': (z, x, y) => `https://webrd0${(x + y) % 4 + 1}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${x}&y=${y}&z=${z}`
};

/* 城市真实数据（MVT）：需要 vendor_node 里的 @mapbox/vector-tile + pbf */
let VectorTile = null, PbfReader = null;
try {
  const req = createRequire(path.join(__dirname, 'vendor_node', 'noop.cjs'));
  VectorTile = req('@mapbox/vector-tile').VectorTile;
  const pbfMod = req('pbf');
  PbfReader = pbfMod.PbfReader || null;
} catch (e) { console.warn('[cloud] MVT 库缺失，城市真实数据不可用（可选）'); }

const lon2x = (lon, z) => (lon + 180) / 360 * Math.pow(2, z);
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z); };
const x2lon = (x, z) => x / Math.pow(2, z) * 360 - 180;
const y2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z); return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };

async function cityMap(lat, lon) {
  const z = 14;
  const key = 'cm:' + lat.toFixed(4) + ',' + lon.toFixed(4);
  const hit = cacheGet(key, 1000 * 60 * 10);
  if (hit) return hit.v;
  if (!VectorTile || !PbfReader) return { ok: false, error: 'MVT 库缺失' };
  const cx = Math.floor(lon2x(lon, z)), cy = Math.floor(lat2y(lat, z));
  const center = { lat, lon };
  const buildings = [], roads = [];
  const proj = (geom, extent, tx, ty) => geom.map((p) => {
    const plon = x2lon(tx + p.x / extent, z), plat = y2lat(ty + p.y / extent, z);
    return [Math.round((plon - center.lon) * 111320 * Math.cos(center.lat * Math.PI / 180)), Math.round((center.lat - plat) * 110540)];
  });
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const tx = cx + dx, ty = cy + dy;
    try {
      const r = await fetch(`https://tiles.openfreemap.org/planet/20240701_001001_pt/${z}/${tx}/${ty}.pbf`, { headers: { 'user-agent': 'JARVIS-cloud/2.0' } });
      if (!r.ok) continue;
      const tile = new VectorTile(new PbfReader(Buffer.from(await r.arrayBuffer())));
      const bl = tile.layers.building;
      if (bl) for (let i = 0; i < bl.length && buildings.length < 4000; i++) {
        const f = bl.feature(i);
        const h = Number(f.properties.render_height) || (Number(f.properties.levels) ? Number(f.properties.levels) * 3.2 : 0) || 0;
        f.loadGeometry().forEach((ring) => { if (ring.length >= 3) buildings.push({ p: proj(ring, bl.extent, tx, ty), h: h > 0 ? Math.min(h, 300) : 6 + Math.abs(ring[0].x * 7 + ring[0].y * 13) % 24 }); });
      }
      const tl = tile.layers.transportation;
      if (tl) for (let i = 0; i < tl.length && roads.length < 4000; i++) {
        const f = tl.feature(i);
        f.loadGeometry().forEach((line) => { if (line.length >= 2) roads.push({ p: proj(line, tl.extent, tx, ty), c: f.properties.class || 'street' }); });
      }
    } catch (e) { /* 单块失败忽略 */ }
  }
  const data = { ok: buildings.length > 0, source: 'OpenFreeMap / OpenStreetMap (ODbL)', center, z, buildings, roads, extentMeters: Math.round(40075016.7 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z)) };
  cacheSet(key, data);
  return data;
}

/* ------------------------------------------------------------ 记忆同步 */
function loadMemory() {
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveMemory(m) {
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(m)); } catch (e) {}
}

/* ------------------------------------------------------------------ 路由 */
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, headers()); return res.end(); }
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/api/health') {
    return json(res, 200, {
      ok: true, service: 'jarvis-cloud', version: '1.0.0', node: process.version,
      llm: { provider: OPENAI_API_KEY ? 'openai' : (ANTHROPIC_API_KEY ? 'anthropic' : 'none'), model: MODEL, configured: !!(OPENAI_API_KEY || ANTHROPIC_API_KEY) },
      asrWs: ASR_WS || '', tokenRequired: !!TOKEN, citymap: !!(VectorTile && PbfReader)
    });
  }
  if (p === '/api/config') {
    return json(res, 200, { ok: true, llmEndpoint: '/api/chat', model: MODEL, asrWs: ASR_WS, cloudToken: TOKEN ? '' : '' });
  }
  if (p === '/api/chat') return chatProxy(req, res, url);
  if (p === '/api/search') {
    const q = url.searchParams.get('q') || '';
    const n = Math.max(1, Math.min(8, Number(url.searchParams.get('n') || 5)));
    try { return json(res, 200, await search(q, n)); } catch (e) { return json(res, 502, { ok: false, error: e.message }); }
  }
  if (p === '/api/geo') {
    try { return json(res, 200, await geo(url.searchParams.get('q') || '')); } catch (e) { return json(res, 502, { ok: false, error: e.message }); }
  }
  if (p === '/api/tile') {
    const provider = url.searchParams.get('provider') || 'esri-dark';
    const z = Number(url.searchParams.get('z')), x = Number(url.searchParams.get('x')), y = Number(url.searchParams.get('y'));
    const make = TILE_PROVIDERS[provider] || TILE_PROVIDERS['esri-dark'];
    const key = 't:' + provider + '/' + z + '/' + x + '/' + y;
    const hit = cacheGet(key, 1000 * 60 * 60 * 6);
    if (hit) { res.writeHead(200, headers({ 'content-type': hit.v.type, 'cache-control': 'public, max-age=86400' })); return res.end(hit.v.buf); }
    try {
      const r = await fetch(make(z, x, y), { headers: { 'user-agent': 'JARVIS-cloud/2.0', referer: 'https://www.arcgis.com/' } });
      if (!r.ok) { res.writeHead(204, headers()); return res.end(); }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 200) { res.writeHead(204, headers()); return res.end(); }
      const type = r.headers.get('content-type') || 'image/png';
      cacheSet(key, { buf, type });
      res.writeHead(200, headers({ 'content-type': type, 'cache-control': 'public, max-age=86400' }));
      return res.end(buf);
    } catch (e) { res.writeHead(502, headers()); return res.end(); }
  }
  if (p === '/api/citymap') {
    const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
    if (!isFinite(lat) || !isFinite(lon)) return json(res, 400, { ok: false, error: '缺少 lat/lon' });
    try { return json(res, 200, await cityMap(lat, lon)); } catch (e) { return json(res, 502, { ok: false, error: e.message }); }
  }
  if (p === '/api/fetch') {
    const target = url.searchParams.get('url') || '';
    if (!/^https?:\/\//i.test(target)) return json(res, 400, { ok: false, error: '需要 http(s) 地址' });
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const r = await fetch(target, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 JARVIS-cloud/2.0' } });
      const text = (await r.text())
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
      clearTimeout(timer);
      return json(res, 200, { ok: true, status: r.status, text: 'HTTP ' + r.status + ' · ' + target + '\n' + (text || '（无文本）') });
    } catch (e) { return json(res, 502, { ok: false, error: '抓取失败：' + e.message }); }
  }
  if (p === '/api/memory') {
    if (!authed(req, url)) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy(); });
      return req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          const id = String(data.id || 'default').slice(0, 64);
          const m = loadMemory();
          m[id] = { data: data.memory, updatedAt: Date.now() };
          saveMemory(m);
          json(res, 200, { ok: true, updatedAt: m[id].updatedAt });
        } catch (e) { json(res, 400, { ok: false, error: 'bad json' }); }
      });
    }
    const id = String(url.searchParams.get('id') || 'default').slice(0, 64);
    const m = loadMemory();
    return json(res, 200, { ok: true, memory: (m[id] || {}).data || null, updatedAt: (m[id] || {}).updatedAt || 0 });
  }

  if (p === '/manifest.json' || p === '/icon-180.png' || p === '/icon-512.png') {
    const cand = [path.join(__dirname, p.slice(1)), path.join(PUBLIC_DIR, p.slice(1))];
    for (const f of cand) {
      if (fs.existsSync(f)) {
        res.writeHead(200, headers({ 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'public, max-age=86400' }));
        return fs.createReadStream(f).pipe(res);
      }
    }
  }
  if (p === '/api/asr-info') return json(res, 200, { ok: true, ws: ASR_WS || '' });
  return serveStatic(req, res, p);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  JARVIS 云端服务');
  console.log('  ------------------------------------------------------------');
  console.log(`  地址：http://${HOST}:${PORT}/  （页面 + API 同源）`);
  console.log(`  大模型：${OPENAI_API_KEY ? 'OpenAI 兼容 · ' + MODEL : (ANTHROPIC_API_KEY ? 'Anthropic Claude' : '未配置 key（前端会回落本地意图）')}`);
  console.log(`  城市数据：${VectorTile && PbfReader ? '可用（OpenFreeMap）' : '不可用（缺 vendor_node）'}`);
  console.log(`  语音识别 WS：${ASR_WS || '未配置（手机端可改用系统听写/或单独部署 ASR）'}`);
  console.log(`  访问令牌：${TOKEN ? '已启用' : '未启用（公网部署建议设置 CLOUD_TOKEN）'}`);
  console.log('  ------------------------------------------------------------');
  console.log('');
});
