/* FPL Chain Tracker 前端
 * 纯原生 JS，无依赖。数据契约见 design.md §12。
 * 结构：CONFIG → 数据层（fetchJson）→ 渲染层（各 render 函数）→ 事件绑定
 */
'use strict';

/* ============ 配置 ============ */
const CONFIG = {
  dataPath: 'data/',
  defaultAvatar: 'assets/avatar/default.png',
  // 账号头像：把 1:1 头像放入 assets/avatar/ 后修改此路径（PNG/JPG 均可）
  accountAvatar: 'assets/avatar/account.jpg',
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
async function fetchJson(file, opts = {}) {
  const base = CONFIG.dataPath + file;
  const url = opts.noCache
    ? base + '?t=' + Date.now()
    : base + '?v=' + (state.meta ? state.meta.data_version : 0);
  const resp = await fetch(url, opts.noCache ? { cache: 'no-store' } : undefined);
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + file);
  return resp.json();
}

async function loadCore() {
  [state.meta, state.summary, state.stats] = await Promise.all([
    fetchJson('meta.json', { noCache: true }),
    fetchJson('summary.json'),
    fetchJson('stats.json'),
  ]);
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
  detailEl.innerHTML = '<p class="gw-loading">加载中…</p>';
  try {
    const data = await fetchJson(`gw-${padGw(gw)}.json`);
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
  return `<div class="player">
    <span class="player-name">${esc(p.name || '?')}</span>
    <span class="player-team">${esc(p.team || '')}</span>
    ${badge}
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
      <span class="transfer-cost">${t.cost != null ? t.cost : ''}</span>
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
    score: null,
    hasScore: false,
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
    players.sort((a, b) => (b.score || 0) - (a.score || 0));
  }
  el.innerHTML = `
    <div class="lb-header">
      <h2>玩家积分榜</h2>
      ${hasScore ? '' : '<span class="lb-hint">积分规则开发中，当前展示玩家接管数据</span>'}
    </div>
    <div class="lb-table">
      ${players.map((p, i) => leaderboardRowHtml(p, i + 1, hasScore)).join('')}
    </div>`;
}

function leaderboardRowHtml(p, fallbackRank, hasScore) {
  const rank = p.rank !== null && p.rank !== undefined ? p.rank : fallbackRank;
  const scoreHtml = hasScore
    ? `<span class="lb-score">${num(p.score)}</span>`
    : '<span class="lb-score lb-score-tbd">待定</span>';
  const awards = (p.awards && p.awards.length)
    ? `<div class="lb-awards-line">${p.awards.map(a =>
        `<span class="award-badge">${esc(a)}</span>`).join('')}</div>`
    : '';
  return `
    <div class="lb-row" data-name="${esc(p.name)}">
      <div class="lb-row-main">
        <span class="lb-rank">${rank}</span>
        ${avatarHtml(p.avatar, p.name, 'avatar avatar-sm')}
        <span class="lb-name">${esc(p.name)}</span>
        ${scoreHtml}
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
      rows.push(`<div class="lb-detail-row"><span>${esc(d.label)}</span><span>${num(d.value)}</span></div>`);
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

/* ============ 页脚更新时间 ============ */
function renderFooter() {
  const el = document.getElementById('updated-at');
  const ts = state.meta && state.meta.generated_at_utc;
  if (!ts) { el.textContent = ''; return; }
  const local = new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  el.textContent = '数据更新于 ' + local + '（北京时间）· 数据来源 FPL 官方 API';
}

/* ============ 启动 ============ */
async function init() {
  bindTabs();
  bindTimeline();
  bindLeaderboard();
  try {
    await loadCore();
  } catch (err) {
    document.querySelector('.container').innerHTML =
      '<p class="lb-empty">数据加载失败，请稍后重试（' + esc(err.message) + '）</p>';
    return;
  }
  renderAccountCard();
  renderTimeline();
  renderLeaderboard();
  renderFooter();
}

document.addEventListener('DOMContentLoaded', init);
