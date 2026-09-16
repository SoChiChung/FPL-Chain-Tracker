'use strict';

/* FPL Chain Tracker 实时数据接口（Vercel 无服务器函数，Node.js Runtime）
 *
 * 为什么需要它：FPL 官方 API 不返回 Access-Control-Allow-Origin，
 * 浏览器无法直连（实测响应头 Vary 仅为 X-API-Language, Accept-Encoding）。
 * 所以由服务端代抓，再把结果按 data/*.json 的同构结构返回给前端。
 *
 * 用法：GET /api/fpl-live?file=meta.json|summary.json|stats.json|gw-04.json
 *   file 缺省为 meta.json
 *   附加参数 refresh=1 可绕开函数内缓存强制重算（调试用）
 *
 * 缓存策略（对应「什么时候可以用缓存」）：
 *   live     有 GW 正在进行        → 30 秒
 *   settling 上一 GW 已结束但仍在补分窗口 → 120 秒
 *   idle      GW 未开始 / 上一 GW 已冻结 → 1800 秒
 * 上游抓取失败时回落到仓库中的 data/*.json 静态快照，本站不会因为 FPL 接口抖动而白屏。
 */

const core = require('../lib/fpl-core.js');

const DEFAULT_FILE = 'meta.json';
const FILE_PATTERN = /^(meta|summary|stats|gw-\d{2})\.json$/;

// 边缘/CDN 缓存秒数（比函数内存缓存的 TTL 略短，保证两者叠加后的新鲜度可预期）
const EDGE_CACHE_SECONDS = {
  [core.PHASE_LIVE]: 30,
  [core.PHASE_SETTLING]: 120,
  [core.PHASE_IDLE]: 1800,
};

/* 函数实例级缓存：同一热容器内的并发请求共享一次上游抓取 */
let memoryCache = null;   // { at, ttl, value }
let inflight = null;      // Promise

function fresh(value, now) {
  return Boolean(value) && (now - value.at) < value.ttl * 1000;
}

async function getLive({ force }) {
  const now = Date.now();
  if (!force && fresh(memoryCache, now)) {
    return { ...memoryCache.value, cached: true };
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const result = await core.collectLive();
      memoryCache = {
        at: Date.now(),
        ttl: core.PHASE_CACHE_SECONDS[result.phase] || 300,
        value: result,
      };
      return result;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function normalizeFile(raw) {
  const name = (raw || DEFAULT_FILE).trim();
  if (!FILE_PATTERN.test(name)) return null;
  return name;
}

function setCommonHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function send(res, status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(text);
}

module.exports = async function handler(req, res) {
  setCommonHeaders(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { error: 'method_not_allowed', allow: ['GET', 'HEAD', 'OPTIONS'] });
    return;
  }

  const url = new URL(req.url || '/', `http://${(req.headers && req.headers.host) || 'localhost'}`);
  const file = normalizeFile(url.searchParams.get('file'));
  if (!file) {
    send(res, 400, { error: 'invalid_file', allow: 'meta.json | summary.json | stats.json | gw-NN.json' });
    return;
  }
  const force = url.searchParams.get('refresh') === '1';

  let live = null;
  let liveError = null;
  try {
    live = await getLive({ force });
  } catch (err) {
    liveError = err;
  }

  // 优先用实时装配结果；该文件不在实时集合内（如已冻结的历史轮次）则回落到仓库快照
  let body = null;
  let source = null;
  if (live && Object.prototype.hasOwnProperty.call(live.files, file)) {
    body = live.files[file];
    source = 'live';
  } else {
    const base = core.loadBaseFile(file);
    if (base !== null) {
      body = base;
      source = live ? 'base' : 'base-fallback';
    }
  }

  if (body === null) {
    res.setHeader('Cache-Control', 'no-store');
    send(res, 404, {
      error: 'not_found',
      file,
      reason: liveError ? `上游抓取失败: ${liveError.message}` : '该文件尚未生成',
    });
    return;
  }

  const phase = live ? live.phase : 'unknown';
  const cacheSeconds = live ? (EDGE_CACHE_SECONDS[live.phase] || 120) : 30;
  res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${cacheSeconds}, stale-while-revalidate=60`);
  res.setHeader('X-FPL-Source', source);
  res.setHeader('X-FPL-Phase', phase);
  res.setHeader('X-FPL-Refreshed', live && live.cached ? 'false' : 'true');
  res.setHeader('X-FPL-Generator', 'fpl-chain-tracker/live');
  if (live && live.files['meta.json']) {
    res.setHeader('X-FPL-Data-Version', String(live.files['meta.json'].data_version));
    res.setHeader('X-FPL-Generated-At', String(live.files['meta.json'].generated_at_utc));
  }
  if (liveError) res.setHeader('X-FPL-Error', String(liveError.message).slice(0, 180));

  if (req.method === 'HEAD') {
    res.statusCode = 200;
    res.end();
    return;
  }
  send(res, 200, body);
};
