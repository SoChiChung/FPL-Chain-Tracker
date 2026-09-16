'use strict';

/* 实时数据层验证脚本（零依赖）
 *
 * 用法：
 *   node scripts/verify-live.js            全部检查（含联网差分校验）
 *   node scripts/verify-live.js --offline  跳过联网的差分校验
 *
 * 检查项：
 *   A 差分校验：实时装配结果应与 crawler（Python）产出的 data/*.json 一致
 *   B 积分计算：与 stats.py 在同一合成赛程下的输出逐位一致（覆盖结算分支）
 *   C 状态机：classifyEvent / determinePhase 的边界情形
 *   D 接口：无服务器函数经 HTTP 调用的状态码、响应头与结构
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require(path.join(__dirname, '..', 'lib', 'fpl-core.js'));

const OFFLINE = process.argv.includes('--offline');
const failures = [];
const passes = [];

function check(name, condition, detail) {
  if (condition) {
    passes.push(name);
  } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function deepEqual(a, b) {
  return core.stableStringify(a) === core.stableStringify(b);
}

/** 差异列表，忽略随时间变化的字段 */
const VOLATILE = new Set(['data_version', 'updated_at_utc', 'generated_at_utc', 'server_timestamp']);

// 实时层有意新增、Python 侧暂不产出的字段（向后兼容：design.md §8.5「只增不改」）
const LIVE_ONLY = new Set(['timezone', 'rules', 'seal_after_hours']);

function diffPaths(a, b, prefix = '', out = []) {
  if (out.length >= 12) return out;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (!deepEqual(a, b)) out.push(`${prefix || '(root)'}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (VOLATILE.has(k) || LIVE_ONLY.has(k)) continue;
    diffPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k, out);
    if (out.length >= 12) break;
  }
  return out;
}

/* ==================== A 差分校验（真实数据，需联网） ==================== */

async function testDifferential() {
  if (OFFLINE) {
    console.log('· A 差分校验：已跳过（--offline）');
    return;
  }
  let live;
  try {
    live = await core.collectLive();
  } catch (err) {
    check('A 实时装配（联网）', false, err.message);
    return;
  }
  console.log(`· A 差分校验：阶段=${live.phase} 当前 GW=${live.currentGw} 抓取轮次=[${live.picksSet}] 上游请求=${live.requests}`);

  const base = core.loadBase();
  for (const [file, baseObj] of [['summary.json', base.summary], ['stats.json', base.stats], ['meta.json', base.meta]]) {
    if (!baseObj) {
      check(`A ${file} 基线存在`, false, '仓库中缺少该文件');
      continue;
    }
    const diffs = diffPaths(baseObj, live.files[file]);
    check(`A ${file} 与 Python 产出一致`, diffs.length === 0,
      diffs.length ? `\n      ${diffs.join('\n      ')}` : '');
  }
  check('A 实时结果包含 meta.json', Boolean(live.files['meta.json']));
  check('A meta.events 为 38 轮', (live.files['meta.json'].events || []).length === 38);
  const rules = live.files['meta.json'].rules;
  check('A meta 携带 rules（供积分层共用配置）', Boolean(rules) && Array.isArray(rules.avg_or_points));
  // rules / timezone / seal_after_hours 是实时层有意新增的字段（diffPaths 里已豁免），
  // 这里单独做一次等价性断言，避免两侧口径悄悄分叉。
  if (base.meta && base.meta.rules) {
    check('A rules 与 crawler 写入的完全一致', deepEqual(base.meta.rules, rules),
      `${JSON.stringify(base.meta.rules)} ≠ ${JSON.stringify(rules)}`);
    check('A timezone 与 crawler 一致', base.meta.timezone === live.files['meta.json'].timezone,
      `${base.meta.timezone} ≠ ${live.files['meta.json'].timezone}`);
    check('A seal_after_hours 与 crawler 一致',
      Number(base.meta.seal_after_hours) === Number(live.files['meta.json'].seal_after_hours),
      `${base.meta.seal_after_hours} ≠ ${live.files['meta.json'].seal_after_hours}`);
  }
}

/* ==================== B 积分计算（合成赛程，期望值由 stats.py 生成） ==================== */

function buildFixture() {
  // 与生成期望值时的 Python 脚本使用同一套确定性公式
  const managers = [
    { name: 'Fran', start_gw: 3, end_gw: 6, avatar: 'Fran.jpg' },
    { name: 'remember', start_gw: 7, end_gw: 10, avatar: 'remember.jpg' },
    { name: '欧巡', start_gw: 11, end_gw: 14, avatar: 'ocean.jpg' },
    { name: '中国合伙人', start_gw: 15, end_gw: 18, avatar: 'gsg.jpg' },
    { name: '进藤光', start_gw: 19, end_gw: 22, avatar: 'jtg.jpg' },
    { name: '香克利', start_gw: 23, end_gw: 26, avatar: 'shankly.jpg' },
    { name: '紫葱酱', start_gw: 27, end_gw: 30, avatar: 'zcj.jpg' },
    { name: '面条', start_gw: 31, end_gw: 34, avatar: 'miantiao.jpg' },
    { name: '企鹅', start_gw: 35, end_gw: 38, avatar: 'penguin.jpg' },
  ];
  const gwList = [];
  for (let g = 1; g <= 38; g += 1) {
    const manager = managers.find((m) => m.start_gw <= g && g <= m.end_gw) || null;
    gwList.push({
      gw: g,
      status: 'sealed',
      manager: manager ? manager.name : null,
      manager_avatar: manager ? `assets/avatar/${manager.avatar}` : null,
      score: 60 + (g % 7) * 3,
      total_points: 60 * g,
      overall_rank: 900000 - g * 21000 + (g % 5) * 4000,
      gw_rank: 500000 + g,
      chips: [],
      transfers_count: 0,
      transfers_cost: 0,
      has_detail: true,
    });
  }
  let running = 0;
  for (const row of gwList) {
    running += row.score;
    row.total_points = running;
  }
  const setGw = (gw, patch) => Object.assign(gwList[gw - 1], patch);
  setGw(4, { transfers_count: 2, transfers_cost: -4 });
  setGw(5, { transfers_count: 1 });
  setGw(8, { transfers_count: 3, chips: ['free_hit'] });
  setGw(12, { transfers_count: 1, chips: ['wildcard'] });
  setGw(18, { transfers_count: 2, chips: ['bench_boost'] });
  setGw(20, { transfers_count: 1, transfers_cost: -8 });
  setGw(33, { transfers_count: 4, chips: ['triple_captain'] });
  setGw(36, { transfers_count: 2, chips: ['free_hit'] });
  const rules = { ...core.RULES_DEFAULTS, large_bgw_gws: [18, 29] };
  return { managers, gwList, rules };
}

// 期望值来自 crawler/stats.py（脚本见提交说明），逐位对照
const EXPECTED = [
  { name: 'Fran', score: 0.5, rank: 5, settled: true, dq: false, reason: null, weekly: 0, avgOr: 1, avgOrPos: 9, transferAward: 0, hit: -0.5, chip: 0, tcount: 3 },
  { name: 'remember', score: 0.5, rank: null, settled: true, dq: true, reason: 'unauthorized_chip', weekly: 0, avgOr: 2, avgOrPos: 8, transferAward: 0, hit: 0, chip: -1.5, tcount: 3 },
  { name: '欧巡', score: 3, rank: null, settled: true, dq: true, reason: 'wildcard', weekly: 0, avgOr: 3, avgOrPos: 7, transferAward: 0, hit: 0, chip: 0, tcount: 1 },
  { name: '中国合伙人', score: 3.5, rank: 4, settled: true, dq: false, reason: null, weekly: 0, avgOr: 5, avgOrPos: 6, transferAward: 0, hit: 0, chip: -1.5, tcount: 2 },
  { name: '进藤光', score: 6, rank: 3, settled: true, dq: false, reason: null, weekly: 0, avgOr: 7, avgOrPos: 5, transferAward: 0, hit: -1, chip: 0, tcount: 1 },
  { name: '香克利', score: 11, rank: 2, settled: true, dq: false, reason: null, weekly: 0, avgOr: 9, avgOrPos: 4, transferAward: 2, hit: 0, chip: 0, tcount: 0 },
  { name: '紫葱酱', score: 14, rank: 1, settled: true, dq: false, reason: null, weekly: 0, avgOr: 12, avgOrPos: 3, transferAward: 2, hit: 0, chip: 0, tcount: 0 },
  { name: '面条', score: 13.5, rank: null, settled: true, dq: true, reason: 'unauthorized_chip', weekly: 0, avgOr: 15, avgOrPos: 2, transferAward: 0, hit: 0, chip: -1.5, tcount: 4 },
  { name: '企鹅', score: 22.5, rank: null, settled: true, dq: true, reason: 'unauthorized_chip', weekly: 4, avgOr: 20, avgOrPos: 1, transferAward: 0, hit: 0, chip: -1.5, tcount: 2 },
];

function testScoring() {
  const { managers, gwList, rules } = buildFixture();
  const stats = core.computeManagerStats(managers, gwList);
  const { managers: scored, season_settled: settled } = core.computeScores(stats, gwList, rules);
  const totals = core.computeSeasonTotals(gwList);

  check('B season_settled 为 true（9 人全部冻结）', settled === true);
  check('B season_totals.total_points 为末轮累计分', totals.total_points === gwList[37].total_points,
    `实际 ${totals.total_points}`);

  EXPECTED.forEach((exp, i) => {
    const m = scored[i];
    if (!m) {
      check(`B ${exp.name}`, false, '缺少该经理');
      return;
    }
    const actual = {
      name: m.name,
      score: m.score,
      rank: m.rank,
      settled: m.settled,
      dq: m.disqualified,
      reason: m.disqualify_reason,
      weekly: m.points.weekly_or_award,
      avgOr: m.points.avg_or_award,
      avgOrPos: m.points.avg_or_position,
      transferAward: m.points.transfer_award,
      hit: m.points.hit_penalty,
      chip: m.points.chip_penalty,
      tcount: m.points.transfer_count,
    };
    check(`B ${exp.name} 积分与 stats.py 一致`, deepEqual(actual, exp),
      `期望 ${JSON.stringify(exp)}\n      实际 ${JSON.stringify(actual)}`);
  });

  // 明细结构（前端直接渲染 score_details）
  const fran = scored[0];
  check('B score_details 为扁平数组', Array.isArray(fran.score_details) && fran.score_details.length >= 3);
  check('B 结算后不再出现「待结算」', fran.score_details.every((d) => d.kind !== 'pending'));
  const dqRow = scored.find((m) => m.disqualified);
  check('B 取消资格者无名次', dqRow && dqRow.rank === null);
}

/* ==================== C 状态机与阶段 ==================== */

function testStateMachine() {
  const now = Date.parse('2026-09-16T06:00:00Z');
  const base = (id, deadline, finished) => ({ id, deadline_time: deadline, finished });

  check('C deadline 未过 → upcoming',
    core.classifyEvent(base(5, '2026-09-18T17:30:00Z', false), now, 48, () => true) === 'upcoming');
  check('C deadline 已过且未 finished → live',
    core.classifyEvent(base(4, '2026-09-12T12:30:00Z', false), now, 48, () => true) === 'live');
  check('C finished 但在封印窗口内 → finished',
    core.classifyEvent(base(4, '2026-09-15T12:30:00Z', true), now, 48, () => true) === 'finished');
  check('C finished 且超出封印窗口但详情缺失 → finished（不冻结）',
    core.classifyEvent(base(4, '2026-09-12T12:30:00Z', true), now, 48, () => false) === 'finished');
  check('C finished 且超出封印窗口且详情已抓 → sealed',
    core.classifyEvent(base(4, '2026-09-12T12:30:00Z', true), now, 48, () => true) === 'sealed');

  check('C 季前（无 deadline 已过）→ idle',
    core.determinePhase({ 1: 'upcoming', 2: 'upcoming' }) === core.PHASE_IDLE);
  check('C 有 live 轮 → live',
    core.determinePhase({ 1: 'sealed', 2: 'live', 3: 'upcoming' }) === core.PHASE_LIVE);
  check('C 上一轮 finished（补分窗口）→ settling',
    core.determinePhase({ 1: 'sealed', 2: 'finished', 3: 'upcoming' }) === core.PHASE_SETTLING);
  check('C 上一轮已冻结、下一轮未开始 → idle（可用缓存）',
    core.determinePhase({ 1: 'sealed', 2: 'sealed', 3: 'upcoming' }) === core.PHASE_IDLE);

  const seasonEnded = {};
  for (let g = 1; g <= core.GW_TOTAL; g += 1) seasonEnded[g] = 'sealed';
  check('C 赛季结束 → idle', core.determinePhase(seasonEnded) === core.PHASE_IDLE);

  check('C pyRound 与 Python round 一致（四舍六入五成双）',
    core.pyRound(2.5) === 2 && core.pyRound(3.5) === 4 && core.pyRound(-2.5) === -2
    && core.pyRound(1.25, 1) === 1.2 && core.pyRound(1.35, 1) === 1.4);

  const fields = core.deadlineFields('2026-09-12T12:30:00Z', 'Asia/Shanghai');
  check('C deadline 北京时间换算正确',
    fields.deadline_beijing === '2026-09-12T20:30:00+08:00', `实际 ${fields.deadline_beijing}`);
  check('C deadline 时间戳正确', fields.deadline_timestamp === Date.parse('2026-09-12T12:30:00Z'));
}

/* ==================== D 无服务器接口 ==================== */

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    }).on('error', reject);
  });
}

async function testHandler() {
  const handler = require(path.join(__dirname, '..', 'api', 'fpl-live.js'));
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/fpl-live`;
  try {
    const meta = await get(`${base}?file=meta.json`);
    check('D meta.json 返回 200', meta.status === 200, `实际 ${meta.status} ${meta.text.slice(0, 160)}`);
    check('D 带 CORS 头', meta.headers['access-control-allow-origin'] === '*');
    check('D 暴露阶段响应头', typeof meta.headers['x-fpl-phase'] === 'string',
      `实际 ${meta.headers['x-fpl-phase']}`);
    check('D 有缓存策略头', /s-maxage=\d+/.test(String(meta.headers['cache-control'])),
      `实际 ${meta.headers['cache-control']}`);
    if (meta.status === 200) {
      const body = JSON.parse(meta.text);
      check('D meta 结构完整',
        body.season && body.current_gw && Array.isArray(body.events) && Array.isArray(body.managers));
    }

    const summary = await get(`${base}?file=summary.json`);
    check('D summary.json 返回 200', summary.status === 200, `实际 ${summary.status}`);
    if (summary.status === 200) {
      const body = JSON.parse(summary.text);
      check('D summary.gw_list 为 38 项', (body.gw_list || []).length === 38);
    }

    const gw = await get(`${base}?file=gw-04.json`);
    check('D gw-04.json 返回 200', gw.status === 200, `实际 ${gw.status}`);
    if (gw.status === 200) {
      const body = JSON.parse(gw.text);
      check('D gw 详情含阵容与概要', Boolean(body.lineup && body.summary));
    }

    const bad = await get(`${base}?file=../config.json`);
    check('D 非法 file 参数返回 400', bad.status === 400, `实际 ${bad.status}`);

    const missing = await get(`${base}?file=gw-38.json`);
    check('D 无数据的轮次返回 404', missing.status === 404, `实际 ${missing.status}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/* ==================== E 前端逻辑（阶段判定 / 数据回落 / 刷新排程） ==================== */

function makeAppSandbox(fetchImpl) {
  const timers = [];
  const stubEl = () => ({
    textContent: '',
    innerHTML: '',
    dataset: {},
    classList: { add() {}, remove() {}, toggle() { return false; } },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  });
  return {
    document: {
      hidden: false,
      addEventListener() {},
      getElementById() { return stubEl(); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    fetch: fetchImpl,
    URL,
    setTimeout(fn, delay) { timers.push(delay); return timers.length; },
    clearTimeout() {},
    console: { warn() {}, log() {}, error() {} },
    __timers: timers,
  };
}

async function testFrontend() {
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'app.js'), 'utf8');
  const probeSrc = '\n;globalThis.__probe = { CONFIG, state, PHASE_LABELS, phaseFromSummary,'
    + ' summarySignature, fetchFile, scheduleRefresh };';

  const calls = [];
  const routes = [];
  const fakeFetch = async (url) => {
    calls.push(String(url));
    for (const [pattern, responder] of routes) {
      if (String(url).includes(pattern)) return responder();
    }
    return { ok: false, status: 404, headers: { get: () => null }, async json() { return null; } };
  };

  const sandbox = makeAppSandbox(fakeFetch);
  vm.createContext(sandbox);
  vm.runInContext(appSrc + probeSrc, sandbox);
  const app = sandbox.__probe;
  const rows = (rowsIn) => ({ gw_list: rowsIn.map((r, i) => ({ gw: i + 1, status: 'sealed', score: 50, overall_rank: 100000, total_points: 100, transfers_count: 0, transfers_cost: 0, chips: [], ...r })) });

  // ---- 阶段判定（决定「什么时候可以用缓存」）----
  check('E 季前：GW 未开始 → idle（用缓存）',
    app.phaseFromSummary(rows([{ status: 'upcoming' }, { status: 'upcoming' }])) === 'idle');
  check('E 有 GW 正在进行 → live（必须刷新）',
    app.phaseFromSummary(rows([{ status: 'sealed' }, { status: 'live' }, { status: 'upcoming' }])) === 'live');
  check('E 上一 GW 已结束、仍在补分窗口 → settling',
    app.phaseFromSummary(rows([{ status: 'sealed' }, { status: 'finished' }, { status: 'upcoming' }])) === 'settling');
  check('E 上一 GW 已冻结、下一 GW 未开始 → idle（用缓存）',
    app.phaseFromSummary(rows([{ status: 'sealed' }, { status: 'sealed' }, { status: 'upcoming' }])) === 'idle');
  check('E 赛季结束 → idle',
    app.phaseFromSummary(rows([{ status: 'sealed' }, { status: 'sealed' }])) === 'idle');
  check('E 无数据 → idle', app.phaseFromSummary(null) === 'idle');

  // ---- 数据指纹：只有真正变化才重绘 ----
  const sigA = app.summarySignature(rows([{ status: 'live', score: 40 }, { status: 'upcoming' }]));
  const sigB = app.summarySignature(rows([{ status: 'live', score: 41 }, { status: 'upcoming' }]));
  check('E 分数变化会改变指纹', sigA !== sigB);
  check('E 内容不变则指纹稳定',
    sigA === app.summarySignature(rows([{ status: 'live', score: 40 }, { status: 'upcoming' }])));

  // ---- 实时接口不可用时回落静态快照 ----
  // 注意：app.js 用的是相对路径 'api/fpl-live'（浏览器按文档基址解析），
  // 沙箱里没有基址，所以这里按子串 'api/fpl-live' 匹配。
  routes.length = 0;
  calls.length = 0;
  routes.push(['api/fpl-live', () => ({ ok: false, status: 404, headers: { get: () => null }, async json() { return null; } })]);
  routes.push(['data/meta.json', () => ({ ok: true, status: 200, headers: { get: () => null }, async json() { return { origin: 'static' }; } })]);
  const first = await app.fetchFile('meta.json');
  check('E 实时接口 404 时回落静态快照', first && first.origin === 'static');
  check('E 回落时来源标记为 static', app.state.source === 'static');
  check('E 404 后标记实时接口不可用', app.state.liveAvailable === false);
  calls.length = 0;
  await app.fetchFile('meta.json');
  check('E 已判定不可用后不再浪费一次实时请求',
    calls.length > 0 && calls.every((u) => !u.includes('api/fpl-live')), calls.join(' | '));

  // ---- 实时接口可用时优先走它，并从响应头读取阶段 ----
  routes.length = 0;
  calls.length = 0;
  routes.push(['api/fpl-live', () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k === 'X-FPL-Phase' ? 'live' : (k === 'X-FPL-Source' ? 'live' : null)) },
    async json() { return { origin: 'live' }; },
  })]);
  app.state.liveAvailable = null;
  app.state.liveRetryAt = 0;
  const live = await app.fetchFile('summary.json');
  check('E 优先使用实时接口', live && live.origin === 'live', calls.join(' | '));
  check('E 从响应头读取阶段', app.state.phase === 'live');
  check('E 来源标记为 live', app.state.source === 'live');

  // ---- 刷新排程：缓存允许的阶段不轮询 ----
  sandbox.__timers.length = 0;
  app.state.phase = 'live';
  app.scheduleRefresh();
  check('E live 阶段按 60 秒排程', sandbox.__timers[0] === 60000, `实际 ${sandbox.__timers[0]}`);
  sandbox.__timers.length = 0;
  app.state.phase = 'settling';
  app.scheduleRefresh();
  check('E settling 阶段按 300 秒排程', sandbox.__timers[0] === 300000, `实际 ${sandbox.__timers[0]}`);
  sandbox.__timers.length = 0;
  app.state.phase = 'idle';
  app.scheduleRefresh();
  check('E idle 阶段不排程（按约定使用缓存）', sandbox.__timers.length === 0);

  // ---- 静态一致性：页脚按钮与配置口径 ----
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'css', 'cinematic.css'), 'utf8');
  check('E index.html 存在刷新按钮（app.js 绑定了它）', /id="refresh-data"/.test(html));
  check('E .refresh-btn 样式已定义', /\.refresh-btn\b/.test(css));
  check('E app.js 引用的元素 id 都存在',
    ['account-card', 'gw-timeline', 'leaderboard', 'updated-at'].every((id) => html.includes(`id="${id}"`)));
  check('E 阶段标签覆盖全部阶段',
    ['live', 'settling', 'idle'].every((k) => typeof app.PHASE_LABELS[k] === 'string'));
  check('E 刷新策略与文档口径一致（60s / 300s / 不轮询）',
    app.CONFIG.refreshMs.live === 60000 && app.CONFIG.refreshMs.settling === 300000
    && app.CONFIG.refreshMs.idle === 0);
}

/* ==================== 运行 ==================== */

(async () => {
  console.log('FPL Chain Tracker —— 实时数据层验证');
  console.log('─'.repeat(56));
  testStateMachine();
  testScoring();
  await testFrontend();
  await testDifferential();
  await testHandler();

  console.log('─'.repeat(56));
  console.log(`通过 ${passes.length} 项`);
  if (failures.length) {
    console.log(`失败 ${failures.length} 项：`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  } else {
    console.log('全部检查通过 ✓');
  }
})();
