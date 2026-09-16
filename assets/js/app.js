/* FPL Chain Tracker 前端
 * 纯原生 JS，无依赖。数据契约见 design.md §12。
 * 结构：CONFIG → 数据层（fetchJson）→ 渲染层（各 render 函数）→ 事件绑定
 */
'use strict';

/* ============ 配置 ============ */
const CONFIG = {
  dataPath: 'data/',
  // Vercel 无服务器实时接口（服务端代抓 FPL 官方 API —— 官方接口没有 CORS 头，浏览器不能直连）。
  // 非 Vercel 环境（如 GitHub Pages）该路径 404，会自动回落到 data/*.json 静态快照。
  liveApi: 'api/fpl-live',
  defaultAvatar: 'assets/avatar/default.png',
  // 账号头像：把 1:1 头像放入 assets/avatar/ 后修改此路径（PNG/JPG 均可）
  accountAvatar: 'assets/avatar/account.jpg',
  // 阶段化刷新策略（与 lib/fpl-core.js 的 determinePhase 同一口径）：
  //   live     有 GW 正在进行              → 60 秒轮询，绕过缓存
  //   settling 上一 GW 已结束、仍在补分窗口 → 300 秒轮询
  //   idle     GW 未开始 / 上一 GW 已冻结   → 不轮询，使用缓存
  refreshMs: { live: 60000, settling: 300000, idle: 0 },
  // 实时接口不可用时的重试冷却时间，避免每次请求都白等一次失败
  liveCooldownMs: 60000,
};

const PHASE_LABELS = {
  live: '实时更新中',
  settling: '结算观察中',
  idle: '已冻结，使用缓存',
};

const CHIP_LABELS = {
  wildcard: '外卡 Wildcard',
  free_hit: '自由转会 Free Hit',
  bench_boost: '替补加成 Bench Boost',
  triple_captain: '三倍队长 Triple Captain',
};

const POSITION_LABELS = { GKP: '门将', DEF: '后卫', MID: '中场', FWD: '前锋' };

const GW_STATUS_LABELS = { live: '进行中', upcoming: '未开始' };

/* ============ 状态 ============ */
const state = {
  meta: null,
  summary: null,
  stats: null,
  loadedGws: new Set(),
  openedGw: null,
  // 数据来源与刷新状态
  source: null,          // 'live' | 'static'
  liveAvailable: null,   // null = 未知，true / false = 已探测结果
  liveRetryAt: 0,        // 实时接口不可用时的冷却截止时间
  phase: null,           // 'live' | 'settling' | 'idle'
  signature: null,       // 最近一次渲染的数据指纹，用于判断是否需要重绘
  timer: null,
  refreshing: false,
};

/* ============ 工具函数 ============ */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function num(v) {
  return v === null || v === undefined ? '—' : v;
}

function fmtRank(v) {
  return v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('en-US');
}

function padGw(gw) {
  return String(gw).padStart(2, '0');
}

function avatarHtml(src, alt, cls = 'avatar') {
  if (!src) return '';
  return `<img data-avatar class="${cls}" src="${esc(src)}" alt="${esc(alt || '')}">`;
}

function bindAvatarFallback(root) {
  root.querySelectorAll('img[data-avatar]').forEach(img => {
    img.addEventListener('error', () => { img.src = CONFIG.defaultAvatar; }, { once: true });
  });
}

/* ============ 数据层 ============ */

// 静态快照：data/*.json（由 crawler / GitHub Actions 生成）
// ?v= 用 data_version 做缓存破坏：版本没变就命中浏览器缓存，减少请求
function staticUrl(file, bust) {
  const base = CONFIG.dataPath + file;
  return bust ? base + '?t=' + Date.now() : base + '?v=' + (state.meta ? state.meta.data_version : 0);
}

// 实时接口：总是带时间戳绕开浏览器与 CDN 缓存；函数内部有自己的缓存策略
function liveUrl(file) {
  return CONFIG.liveApi + '?file=' + encodeURIComponent(file) + '&t=' + Date.now();
}

/**
 * 取数据：优先实时接口，失败则回落到静态快照。
 * @param {string} file  meta.json / summary.json / stats.json / gw-NN.json
 * @param {object} [opts]
 * @param {boolean} [opts.bust]  绕过静态快照的浏览器缓存
 * @param {boolean} [opts.live]  false 时直接走静态快照（已冻结的历史轮次无需实时接口）
 */
async function fetchFile(file, opts = {}) {
  const allowLive = opts.live !== false && state.liveAvailable !== false;
  if (allowLive) {
    try {
      const res = await fetch(liveUrl(file), { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        state.liveAvailable = true;
        state.source = 'live';
        const phase = res.headers.get('X-FPL-Phase');
        if (phase && PHASE_LABELS[phase]) state.phase = phase;
        if (res.headers.get('X-FPL-Source') === 'base-fallback') state.source = 'static';
        return data;
      }
      // 404 => 该部署没有实时接口（GitHub Pages 等），永久回落；其他错误按冷却期重试
      state.liveAvailable = false;
      state.liveRetryAt = res.status === 404 ? Number.POSITIVE_INFINITY : Date.now() + CONFIG.liveCooldownMs;
    } catch (err) {
      state.liveAvailable = false;
      state.liveRetryAt = Date.now() + CONFIG.liveCooldownMs;
    }
    state.source = 'static';
  } else if (state.liveAvailable === false && Date.now() > state.liveRetryAt) {
    state.liveAvailable = null; // 冷却期满，下一次请求重新尝试实时接口
  }

  const resp = await fetch(staticUrl(file, opts.bust), opts.bust ? { cache: 'no-store' } : undefined);
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + file);
  state.source = state.source === 'live' ? 'live' : 'static';
  return resp.json();
}

async function loadCore() {
  [state.meta, state.summary, state.stats] = await Promise.all([
    fetchFile('meta.json', { bust: true }),
    fetchFile('summary.json'),
    fetchFile('stats.json'),
  ]);
}

/* ============ 阶段判定与自动刷新 ============ */

/**
 * 由 summary 的轮次状态推导阶段。与 lib/fpl-core.js 的 determinePhase() 同一口径：
 * 只有「存在正在进行中的 GW」才必须放弃缓存；GW 未开始或上一 GW 已冻结时可用缓存。
 */
function phaseFromSummary(summary) {
  const list = (summary && summary.gw_list) || [];
  if (!list.length) return 'idle';
  let currentId = null;
  for (const g of list) {
    if (g.status !== 'upcoming') currentId = currentId === null ? g.gw : Math.max(currentId, g.gw);
  }
  if (currentId === null) return 'idle';                                  // 赛季未开始
  if (list[list.length - 1].status === 'sealed') return 'idle';           // 赛季结束
  for (const g of list) {
    if (g.status === 'live') return 'live';
    if (g.status === 'finished' && g.gw <= currentId) return 'settling';
  }
  return 'idle';
}

/** 关键字段指纹：只有真正影响展示的内容变化时才重绘，避免轮询造成闪烁 */
function summarySignature(summary) {
  const list = (summary && summary.gw_list) || [];
  return list.map(g => [
    g.gw, g.status, g.score, g.overall_rank, g.total_points,
    g.transfers_count, g.transfers_cost, (g.chips || []).join('+'),
  ].join(':')).join('|');
}

function scheduleRefresh() {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const delay = CONFIG.refreshMs[state.phase] || 0;
  if (!delay) return; // idle：按约定使用缓存，不再轮询
  state.timer = setTimeout(pollOnce, delay);
}

async function pollOnce() {
  state.timer = null;
  if (state.refreshing) {
    scheduleRefresh();
    return;
  }
  // 后台标签页不抓取，切回前台时会立即补一次
  if (document.hidden) {
    scheduleRefresh();
    return;
  }
  try {
    const summary = await fetchFile('summary.json', { bust: true });
    const nextPhase = phaseFromSummary(summary);
    const signature = summarySignature(summary);
    if (signature !== state.signature || nextPhase !== state.phase) {
      state.summary = summary;
      await reloadAll();
    } else {
      state.phase = nextPhase;
    }
  } catch (err) {
    // 轮询失败静默处理，保留当前展示内容，下一轮再试
  }
  scheduleRefresh();
}

/** 重新拉取全部数据并重绘，保留展开中的轮次 */
async function reloadAll() {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const results = await Promise.all([
      fetchFile('meta.json', { bust: true }),
      fetchFile('summary.json', { bust: true }),
      fetchFile('stats.json', { bust: true }),
    ]);
    [state.meta, state.summary, state.stats] = results;
    state.loadedGws.clear(); // 进行中的轮次详情已过期，下次展开时重新拉取
    renderAll();
    reopenCurrentGw();
  } catch (err) {
    // 保留旧数据
  } finally {
    state.refreshing = false;
  }
}

function reopenCurrentGw() {
  if (state.openedGw === null) return;
  const itemEl = document.querySelector('.gw-item[data-gw="' + state.openedGw + '"]');
  if (!itemEl) return;
  itemEl.classList.add('open');
  const toggle = itemEl.querySelector('.gw-toggle');
  if (toggle) toggle.textContent = '▾';
  openGw(state.openedGw, itemEl);
}

/** 手动刷新（页脚按钮 / 切回前台） */
async function refreshNow() {
  if (state.liveAvailable === false) {
    state.liveAvailable = null; // 手动刷新时重新尝试实时接口
    state.liveRetryAt = 0;
  }
  await reloadAll();
  scheduleRefresh();
}

/* ============ Tab 1：接龙赛 ============ */

// 账号名片：名称/头像来自 meta，当前总积分与 OR 取 summary 中最近一个有数据的 GW
function renderAccountCard() {
  const el = document.getElementById('account-card');
  const team = (state.meta && state.meta.team) || {};
  let points = null;
  let rank = null;
  if (state.summary && Array.isArray(state.summary.gw_list)) {
    for (let i = state.summary.gw_list.length - 1; i >= 0; i--) {
      const g = state.summary.gw_list[i];
      if (g.total_points != null) { points = g.total_points; rank = g.overall_rank; break; }
    }
  }
  el.innerHTML = `
    ${avatarHtml(CONFIG.accountAvatar, team.name, 'account-avatar')}
    <div class="account-info">
      <div class="account-name">${esc(team.name || '—')}</div>
      <div class="account-season">赛季 ${esc((state.meta && state.meta.season) || '—')}</div>
      <div class="account-stats">
        <div class="stat"><span class="stat-label">总积分</span><span class="stat-value">${num(points)}</span></div>
        <div class="stat"><span class="stat-label">Overall Rank</span><span class="stat-value">${fmtRank(rank)}</span></div>
      </div>
    </div>`;
  bindAvatarFallback(el);
}

// GW 时间线（Accordion，折叠态）
function renderTimeline() {
  const el = document.getElementById('gw-timeline');
  if (!state.summary || !Array.isArray(state.summary.gw_list)) {
    el.innerHTML = '<p class="gw-empty">暂无数据</p>';
    return;
  }
  el.innerHTML = state.summary.gw_list.map(gwRowHtml).join('');
  bindAvatarFallback(el);
}

function gwRowHtml(item) {
  const hasManager = !!item.manager;
  // 无 manager（GW1-GW2 接龙前）：不显示头像和名字，显示"系统随机阵容"
  const avatar = hasManager ? avatarHtml(item.manager_avatar, item.manager) : '';
  const name = hasManager
    ? esc(item.manager)
    : '<span class="gw-system">系统随机阵容</span>';
  const statusBadge = GW_STATUS_LABELS[item.status]
    ? `<span class="badge badge-${item.status}">${GW_STATUS_LABELS[item.status]}</span>`
    : '';
  return `
    <div class="gw-item" data-gw="${item.gw}">
      <div class="gw-head">
        <span class="gw-number">GW${item.gw}</span>
        <span class="gw-manager">${avatar}${name}</span>
        <span class="gw-score">${num(item.score)} pts</span>
        <span class="gw-rank">OR ${fmtRank(item.overall_rank)}</span>
        ${statusBadge}
        <span class="gw-toggle">▸</span>
      </div>
      <div class="gw-detail"></div>
    </div>`;
}

// 展开：懒加载 data/gw-{nn}.json，已加载过的轮次不再请求
async function openGw(gw, itemEl) {
  const detailEl = itemEl.querySelector('.gw-detail');
  if (state.loadedGws.has(gw)) {
    detailEl.classList.add('loaded');
    return;
  }
  // 已冻结的轮次内容不会再变，直接走静态快照，省一次实时接口调用
  const row = state.summary && state.summary.gw_list ? state.summary.gw_list[gw - 1] : null;
  const needLive = !row || row.status !== 'sealed';
  detailEl.innerHTML = '<p class="gw-loading">加载中…</p>';
  try {
    const data = await fetchFile(`gw-${padGw(gw)}.json`, { live: needLive, bust: needLive });
    state.loadedGws.add(gw);
    detailEl.innerHTML = gwDetailHtml(data);
  } catch (err) {
    detailEl.innerHTML = '<p class="gw-empty">暂无数据</p>';
    return;
  }
  detailEl.classList.add('loaded');
}

function gwDetailHtml(g) {
  return lineupHtml(g.lineup) + transfersHtml(g.transfers) + chipsHtml(g.chips);
}

function sectionHtml(title, body) {
  return `<div class="gw-section"><h4 class="gw-section-title">${title}</h4>${body}</div>`;
}

function lineupHtml(lineup) {
  if (lineup === null || lineup === undefined) {
    return sectionHtml('阵容', '<p class="gw-empty">暂无数据</p>');
  }
  const starters = lineup.starters || [];
  const subs = lineup.subs || [];
  const groups = { GKP: [], DEF: [], MID: [], FWD: [] };
  starters.forEach(p => { (groups[p.position_type] ||= []).push(p); });
  const groupHtml = ['GKP', 'DEF', 'MID', 'FWD'].map(pos => {
    if (!groups[pos].length) return '';
    return `<div class="pos-group">
      <span class="pos-label">${POSITION_LABELS[pos]}</span>
      <div class="pos-list">${groups[pos].map(playerHtml).join('')}</div>
    </div>`;
  }).join('');
  const subsHtml = subs.length
    ? `<div class="pos-group">
        <span class="pos-label">替补</span>
        <div class="pos-list">${subs.map(playerHtml).join('')}</div>
      </div>`
    : '';
  return sectionHtml('阵容', groupHtml + subsHtml);
}

function playerHtml(p) {
  const badge = p.is_captain
    ? '<span class="tag tag-c" title="队长">C</span>'
    : p.is_vice_captain
      ? '<span class="tag tag-vc" title="副队长">V</span>'
      : '';
  const pts = (p.points !== null && p.points !== undefined)
    ? `<span class="player-pts${p.is_substitute ? ' player-pts-sub' : ''}">${p.points}</span>`
    : '';
  return `<div class="player">
    <span class="player-name">${esc(p.name || '?')}</span>
    <span class="player-team">${esc(p.team || '')}</span>
    ${badge}
    ${pts}
  </div>`;
}

function transfersHtml(transfers) {
  if (transfers === null || transfers === undefined) {
    return sectionHtml('转会', '<p class="gw-empty">暂无数据</p>');
  }
  if (!transfers.length) {
    return sectionHtml('转会', '<p class="gw-empty">本轮无转会</p>');
  }
  const rows = transfers.map(t => `
    <div class="transfer-row">
      <span class="transfer-out">${esc(t.element_out_name || '#' + t.element_out)}</span>
      <span class="transfer-arrow">→</span>
      <span class="transfer-in">${esc(t.element_in_name || '#' + t.element_in)}</span>
    </div>`).join('');
  return sectionHtml(`转会（${transfers.length} 笔）`, rows);
}

function chipsHtml(chips) {
  if (chips === null || chips === undefined) {
    return sectionHtml('芯片', '<p class="gw-empty">暂无数据</p>');
  }
  if (!chips.length) {
    return sectionHtml('芯片', '<p class="gw-empty">未使用</p>');
  }
  const badges = chips.map(c =>
    `<span class="chip-badge">${esc(CHIP_LABELS[c] || c)}</span>`).join('');
  return sectionHtml('芯片', badges);
}

/* ============ Tab 2：玩家积分榜 ============ */

// 兼容两种数据形态：
//   未来 stats.players：[{name, avatar, score, rank, awards, ...}]（后端已计算积分）
//   当前 stats.managers：[{name, start_gw, end_gw, avg_rank, best_rank, ...}]（无积分）
function normalizePlayers(stats) {
  const byName = new Map((state.meta && state.meta.managers || []).map(m => [m.name, m]));
  if (Array.isArray(stats.players)) {
    return stats.players.map(p => ({
      ...p,
      hasScore: p.score !== null && p.score !== undefined,
      avatar: p.avatar || (byName.get(p.name) || {}).avatar || null,
      range: byName.get(p.name) || null,
      stats: p,
    }));
  }
  const list = (stats.managers || []).map(m => ({
    name: m.name,
    avatar: (byName.get(m.name) || {}).avatar || null,
    score: m.score,
    rank: m.rank,
    hasScore: m.score !== null && m.score !== undefined,
    settled: m.settled,
    disqualified: m.disqualified,
    disqualify_reason: m.disqualify_reason,
    score_details: m.score_details,
    awards: [],
    range: m,
    stats: m,
  }));
  list.sort((a, b) => (a.range.start_gw || 0) - (b.range.start_gw || 0));
  return list;
}

function renderLeaderboard() {
  const el = document.getElementById('leaderboard');
  if (!state.stats) {
    el.innerHTML = '<p class="lb-empty">暂无统计数据</p>';
    return;
  }
  const players = normalizePlayers(state.stats);
  const hasScore = players.some(p => p.hasScore);
  if (hasScore) {
    // 取消资格者置后；其余按积分降序
    players.sort((a, b) => {
      if (!!a.disqualified !== !!b.disqualified) return a.disqualified ? 1 : -1;
      return (b.score || 0) - (a.score || 0);
    });
  }
  const seasonSettled = !!state.stats.season_settled;
  el.innerHTML = `
    <div class="lb-header">
      <h2>玩家积分榜</h2>
      ${hasScore && !seasonSettled
        ? '<span class="lb-hint">赛季进行中，平均 OR 与转会奖励待结算</span>'
        : (hasScore ? '' : '<span class="lb-hint">暂无积分数据</span>')}
    </div>
    <div class="lb-table">
      ${players.map((p, i) => leaderboardRowHtml(p, i + 1, hasScore)).join('')}
    </div>`;
}

function leaderboardRowHtml(p, fallbackRank, hasScore) {
  const rankHtml = p.disqualified
    ? '<span class="lb-rank lb-rank-dq">—</span>'
    : `<span class="lb-rank">${p.rank !== null && p.rank !== undefined ? p.rank : fallbackRank}</span>`;
  const scoreHtml = hasScore
    ? `<span class="lb-score${p.disqualified ? ' lb-score-dq' : ''}">${num(p.score)}</span>`
    : '<span class="lb-score lb-score-tbd">待定</span>';
  const badges = [];
  if (p.disqualified) {
    badges.push(`<span class="badge badge-dq" title="${esc(p.disqualify_reason || '')}">取消资格</span>`);
  } else if (hasScore && p.settled === false) {
    badges.push('<span class="badge badge-tbd">暂定</span>');
  }
  const awards = (p.awards && p.awards.length)
    ? `<div class="lb-awards-line">${p.awards.map(a =>
        `<span class="award-badge">${esc(a)}</span>`).join('')}</div>`
    : '';
  return `
    <div class="lb-row${p.disqualified ? ' lb-row-dq' : ''}" data-name="${esc(p.name)}">
      <div class="lb-row-main">
        ${rankHtml}
        ${avatarHtml(p.avatar, p.name, 'avatar avatar-sm')}
        <span class="lb-name">${esc(p.name)}</span>
        ${scoreHtml}
        ${badges.join('')}
        <span class="lb-toggle">▸</span>
      </div>
      ${awards}
      <div class="lb-detail">${playerDetailHtml(p)}</div>
    </div>`;
}

// 玩家详情：接管范围 + 当前统计数据；未来后端提供积分明细/加分扣分来源时直接渲染
function playerDetailHtml(p) {
  const rows = [];
  if (p.range) {
    rows.push(`<div class="lb-detail-row"><span>接管范围</span><span>GW${p.range.start_gw} - GW${p.range.end_gw}</span></div>`);
  }
  if (Array.isArray(p.score_details)) {
    p.score_details.forEach(d => {
      rows.push(`<div class="lb-detail-row"><span>${esc(d.label)}</span><span class="lb-val lb-val-${esc(d.kind || '')}">${esc(num(d.value))}</span></div>`);
    });
  }
  const s = p.stats || {};
  if (s.avg_rank != null) {
    rows.push(
      `<div class="lb-detail-row"><span>平均 OR</span><span>${fmtRank(s.avg_rank)}</span></div>`,
      `<div class="lb-detail-row"><span>最佳 OR</span><span>${fmtRank(s.best_rank)}</span></div>`,
      `<div class="lb-detail-row"><span>平均得分</span><span>${num(s.avg_score)}</span></div>`,
      `<div class="lb-detail-row"><span>最高得分</span><span>${num(s.best_score)}</span></div>`,
      `<div class="lb-detail-row"><span>最低得分</span><span>${num(s.worst_score)}</span></div>`,
      `<div class="lb-detail-row"><span>接管累计得分</span><span>${num(s.total_score)}</span></div>`,
      `<div class="lb-detail-row"><span>接管期排名变化</span><span>${s.rank_change != null ? s.rank_change : '—'}</span></div>`,
      `<div class="lb-detail-row"><span>接管期转会</span><span>${num(s.total_transfers)} 笔 / ${num(s.total_transfers_cost)} 分</span></div>`,
    );
  }
  if (!rows.length) return '<p class="lb-empty">暂无数据</p>';
  return `<div class="lb-detail-inner">${rows.join('')}</div>`;
}

/* ============ 事件绑定 ============ */
function bindTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-panel').forEach(p =>
        p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
    });
  });
}

function bindTimeline() {
  document.getElementById('gw-timeline').addEventListener('click', async e => {
    const head = e.target.closest('.gw-head');
    if (!head) return;
    const itemEl = head.closest('.gw-item');
    const gw = Number(itemEl.dataset.gw);

    // Accordion：同一时间只展开一个
    if (state.openedGw !== null && state.openedGw !== gw) {
      const prev = document.querySelector(`.gw-item[data-gw="${state.openedGw}"]`);
      if (prev) {
        prev.classList.remove('open');
        const toggle = prev.querySelector('.gw-toggle');
        if (toggle) toggle.textContent = '▸';
      }
    }

    const isOpen = itemEl.classList.toggle('open');
    head.querySelector('.gw-toggle').textContent = isOpen ? '▾' : '▸';
    if (isOpen) {
      state.openedGw = gw;
      await openGw(gw, itemEl);
    } else {
      state.openedGw = null;
    }
  });
}

function bindLeaderboard() {
  document.getElementById('leaderboard').addEventListener('click', e => {
    const main = e.target.closest('.lb-row-main');
    if (!main) return;
    const row = main.closest('.lb-row');
    const isOpen = row.classList.toggle('open');
    row.querySelector('.lb-toggle').textContent = isOpen ? '▾' : '▸';
  });
}

/* ============ 页脚：数据新鲜度 ============ */
function renderAll() {
  renderAccountCard();
  renderTimeline();
  renderLeaderboard();
  renderFooter();
}

function renderFooter() {
  const el = document.getElementById('updated-at');
  if (!el) return;
  const parts = [];
  const ts = state.meta && state.meta.generated_at_utc;
  if (ts) {
    const local = new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    parts.push('数据更新于 ' + local + '（北京时间）');
  }
  if (state.source === 'live') {
    parts.push('实时接口 · ' + (PHASE_LABELS[state.phase] || '已连接'));
  } else if (state.source === 'static') {
    parts.push('静态快照 · 未连接实时接口');
  }
  parts.push('数据来源 FPL 官方 API');
  el.textContent = parts.join(' · ');
}

/* ============ 启动 ============ */
function bindRefresh() {
  const btn = document.getElementById('refresh-data');
  if (btn) btn.addEventListener('click', refreshNow);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // 切回前台时立刻补一次（轮询在后台标签页中会跳过一次）
    if (state.phase && CONFIG.refreshMs[state.phase]) pollOnce();
  });
}

async function init() {
  bindTabs();
  bindTimeline();
  bindLeaderboard();
  bindRefresh();
  try {
    await loadCore();
  } catch (err) {
    document.querySelector('.container').innerHTML =
      '<p class="lb-empty">数据加载失败，请稍后重试（' + esc(err.message) + '）</p>';
    return;
  }
  state.phase = phaseFromSummary(state.summary);
  state.signature = summarySignature(state.summary);
  renderAll();
  scheduleRefresh();
}

document.addEventListener('DOMContentLoaded', init);
