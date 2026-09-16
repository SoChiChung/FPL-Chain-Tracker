'use strict';

/* FPL Chain Tracker 实时数据核心（Node 18+，纯标准库/内置 fetch，零第三方依赖）
 *
 * 与 crawler/run.py 同源的判定与计算逻辑：GW 状态机、球员丰富、接龙统计、赛事积分。
 * 由 api/fpl-live.js（Vercel 无服务器函数）调用，也可被 scripts/ 下的验证脚本直接 require。
 *
 * 设计约束（与 design.md 保持一致）：
 *   - 输出的 JSON 结构与 data/*.json 完全同构，前端无需区分数据来源
 *   - 已冻结（sealed）的历史以仓库中的 data/ 为权威，本模块只重算「未冻结」的部分
 *   - 「什么时候可以走缓存」的判定集中在 determinePhase()，前端与函数共用同一口径
 */

const fs = require('fs');
const path = require('path');

/* ==================== 常量 ==================== */

const FPL_BASE = 'https://fantasy.premierleague.com/api';
const DEFAULT_UA = 'Mozilla/5.0 (compatible; FPLChainTracker/1.0)';
const GW_TOTAL = 38;
const SEAL_HOURS_DEFAULT = 48;

const CANONICAL_CHIP = {
  wildcard: 'wildcard',
  freehit: 'free_hit',
  bbooster: 'bench_boost',
  '3xc': 'triple_captain',
};

const PENALIZABLE_CHIPS = ['free_hit', 'bench_boost', 'triple_captain'];

const POSITION_BY_ELEMENT_TYPE = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

// 与 crawler/config.py 的 RULES_DEFAULTS 保持一致；meta.json 携带 rules 时以其为准
const RULES_DEFAULTS = {
  large_bgw_gws: [],
  chip_penalty: 1.5,
  hit_penalty_per_4: 0.5,
  avg_or_points: [20, 15, 12, 9, 7, 5, 3, 2, 1],
  weekly_or_tiers: [
    { max_rank: 10000, points: 3 },
    { max_rank: 100000, points: 2 },
    { max_rank: 200000, points: 1 },
  ],
  transfer_pool: 4,
};

/* 阶段（沿用《规则》口径：只有存在「正在进行的 GW」时才必须放弃缓存）
 *   live     —— 有 GW 正在进行（deadline 已过、尚未 finished）：实时刷新
 *   settling —— 最近的 GW 已结束但仍处于补分/封印窗口：低频刷新
 *   idle     —— GW 还没开始，或上一 GW 已冻结且下一 GW 未开始：可用缓存
 */
const PHASE_LIVE = 'live';
const PHASE_SETTLING = 'settling';
const PHASE_IDLE = 'idle';

/* ==================== 基础工具 ==================== */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseUtcMs(iso) {
  const ms = Date.parse(String(iso).replace(' ', 'T'));
  if (!Number.isFinite(ms)) throw new Error(`非法时间字符串: ${iso}`);
  return ms;
}

function formatUtc(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Python round() 的等价实现（十进制四舍六入五成双）。
 * Python 的 round 采用 banker's rounding，直接用 Math.round 会在 .x5 处产生偏差，
 * 而积分/均值要求与 crawler 输出逐位一致。
 */
function pyRound(value, digits = 0) {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const truncated = Math.trunc(scaled);
  const frac = scaled - truncated;
  let out;
  if (Math.abs(Math.abs(frac) - 0.5) < 1e-9) {
    out = truncated % 2 === 0 ? truncated : truncated + Math.sign(scaled);
  } else {
    out = Math.round(scaled);
  }
  return out / factor;
}

function mean(values) {
  return values.length ? pyRound(values.reduce((a, b) => a + b, 0) / values.length, 1) : null;
}

function tzParts(ms, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(ms))) parts[p.type] = p.value;
  return parts;
}

/** UTC 毫秒 → 配置时区的 ISO 8601 带偏移串（如 2026-09-12T20:30:00+08:00） */
function formatOffsetIso(ms, tz) {
  const p = tzParts(ms, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offsetMin = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
}

/** deadline 的三份结构化表示（design.md §9.3），与 crawler/timeutil.py 一致 */
function deadlineFields(iso, tz) {
  const ms = parseUtcMs(iso);
  return {
    deadline_utc: formatUtc(ms),
    deadline_beijing: formatOffsetIso(ms, tz),
    deadline_timestamp: ms,
  };
}

/** 忽略 data_version / 更新时间的稳定序列化，用于「内容是否真的变了」比对 */
function significantJson(obj) {
  const clone = JSON.parse(JSON.stringify(obj));
  delete clone.data_version;
  delete clone.updated_at_utc;
  delete clone.generated_at_utc;
  delete clone.server_timestamp;
  return stableStringify(clone);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/* ==================== 官方 API 客户端 ==================== */

/**
 * 带重试的 JSON 请求。
 * 与 crawler/api_client.py 的差别：退避更短（无服务器函数有执行时长上限），
 * 且 4xx（除 429）视为不可重试的致命错误。
 */
async function httpJson(url, options = {}) {
  const {
    ua = DEFAULT_UA,
    timeoutMs = 12000,
    retries = 2,
    backoffMs = [400, 1200],
  } = options;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      await sleep(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)]);
    }
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': ua, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return await res.json();
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          await sleep(Math.min(retryAfter * 1000, 3000));
        }
        lastErr = new Error(`HTTP 429 ${url}（触发限流）`);
        continue;
      }
      if (res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} ${url}`);
        continue;
      }
      const fatal = new Error(`HTTP ${res.status} ${url}`);
      fatal.fatal = true;
      throw fatal;
    } catch (err) {
      if (err && err.fatal) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/** 与 crawler/api_client.py 的接口一一对应 */
function createApi(teamId, options = {}) {
  const call = (pathname) => httpJson(`${FPL_BASE}/${pathname}`, options);
  return {
    bootstrapStatic: () => call('bootstrap-static/'),
    entry: () => call(`entry/${teamId}/`),
    history: () => call(`entry/${teamId}/history/`),
    transfers: () => call(`entry/${teamId}/transfers/`),
    picks: (gw) => call(`entry/${teamId}/event/${gw}/picks/`),
    eventLive: (gw) => call(`event/${gw}/live/`),
  };
}

/* ==================== 丰富（enrich.py 等价） ==================== */

function buildMaps(bootstrap) {
  const teams = {};
  for (const t of bootstrap.teams || []) teams[t.id] = t.short_name;
  const players = {};
  for (const el of bootstrap.elements || []) {
    const name =
      el.web_name ||
      [el.first_name, el.second_name].filter(Boolean).join(' ') ||
      `player-${el.id}`;
    players[el.id] = {
      name,
      team: teams[el.team] ?? null,
      position_type: POSITION_BY_ELEMENT_TYPE[el.element_type] ?? null,
    };
  }
  return { players, teams };
}

function enrichPick(pick, players) {
  const player = players[pick.element] || {};
  const position = pick.position === undefined || pick.position === null ? 99 : pick.position;
  return {
    element: pick.element ?? null,
    name: player.name ?? null,
    team: player.team ?? null,
    position_type: player.position_type ?? null,
    is_captain: Boolean(pick.is_captain),
    is_vice_captain: Boolean(pick.is_vice_captain),
    multiplier: pick.multiplier ?? null,
    is_substitute: position > 11,
  };
}

/* ==================== GW 状态机（design.md §9.1） ==================== */

function classifyEvent(ev, nowMs, sealHours, sealedEligible) {
  const deadline = parseUtcMs(ev.deadline_time);
  if (deadline > nowMs) return 'upcoming';
  if (ev.finished && (nowMs - deadline) / 1000 > sealHours * 3600 && sealedEligible(ev.id)) {
    return 'sealed';
  }
  if (ev.finished) return 'finished';
  return 'live';
}

function latestStartedGw(events, nowMs) {
  let current = null;
  for (const e of events) {
    if (parseUtcMs(e.deadline_time) <= nowMs) {
      current = current === null ? e.id : Math.max(current, e.id);
    }
  }
  return current;
}

/**
 * 是否必须放弃缓存去抓上游数据（对应「什么时候可以用缓存」的口径）：
 *   - GW 还没开始（upcoming）            → 不抓
 *   - 上一 GW 已冻结、下一 GW 未开始      → 不抓
 *   - 有 live/finished 轮，或刚刚冻结需补抓最终阵容 → 抓
 */
function determinePhase(statuses) {
  const currentId = Object.keys(statuses)
    .map(Number)
    .filter((id) => statuses[id] !== 'upcoming')
    .reduce((max, id) => (max === null || id > max ? id : max), null);
  if (currentId === null) return PHASE_IDLE;
  if (statuses[GW_TOTAL] === 'sealed') return PHASE_IDLE;
  let settling = false;
  for (const [id, st] of Object.entries(statuses)) {
    if (st === PHASE_LIVE) return PHASE_LIVE;
    if (st === 'finished' && Number(id) <= currentId) settling = true;
  }
  return settling ? PHASE_SETTLING : PHASE_IDLE;
}

/* ==================== 接龙统计（stats.py 等价） ==================== */

function computeManagerStats(managers, gwList) {
  const byGw = new Map(gwList.map((g) => [g.gw, g]));
  return managers.map((m) => {
    const rows = [];
    for (let g = m.start_gw; g <= m.end_gw; g += 1) {
      const row = byGw.get(g);
      if (row) rows.push(row);
    }
    const scores = rows.map((r) => r.score).filter((v) => v !== null && v !== undefined);
    const ranks = rows.map((r) => r.overall_rank).filter((v) => v !== null && v !== undefined);
    const stats = {
      name: m.name,
      start_gw: m.start_gw,
      end_gw: m.end_gw,
      gw_count: rows.length,
      completed: rows.length > 0 && rows.every((r) => r.status === 'sealed'),
      live: rows.some((r) => r.status === 'live' || r.status === 'finished'),
      avg_rank: mean(ranks),
      best_rank: ranks.length ? Math.min(...ranks) : null,
      avg_score: mean(scores),
      best_score: scores.length ? Math.max(...scores) : null,
      worst_score: scores.length ? Math.min(...scores) : null,
      total_score: scores.length ? scores.reduce((a, b) => a + b, 0) : null,
      rank_change: null,
      chips_used: [...new Set(rows.flatMap((r) => r.chips || []))].sort(),
      total_transfers: rows.reduce((a, r) => a + (r.transfers_count || 0), 0),
      total_transfers_cost: pyRound(rows.reduce((a, r) => a + (r.transfers_cost || 0), 0), 1),
    };
    if (rows.length && m.start_gw > 1) {
      const prev = byGw.get(m.start_gw - 1);
      const currentRank = rows[rows.length - 1].overall_rank;
      if (prev && prev.overall_rank !== null && prev.overall_rank !== undefined
        && currentRank !== null && currentRank !== undefined) {
        // 负值 = 排名上升（design.md §11.2）
        stats.rank_change = currentRank - prev.overall_rank;
      }
    }
    return stats;
  });
}

function computeSeasonTotals(gwList) {
  const active = gwList.filter((g) => ['live', 'finished', 'sealed'].includes(g.status));
  const ranks = active.map((g) => g.overall_rank).filter((v) => v !== null && v !== undefined);
  const totals = active.map((g) => g.total_points).filter((v) => v !== null && v !== undefined);
  return {
    total_points: totals.length ? totals[totals.length - 1] : null,
    best_rank: ranks.length ? Math.min(...ranks) : null,
    current_rank: ranks.length ? ranks[ranks.length - 1] : null,
    gw_played: active.length,
    total_transfers: active.reduce((a, g) => a + (g.transfers_count || 0), 0),
    total_transfers_cost: pyRound(active.reduce((a, g) => a + (g.transfers_cost || 0), 0), 1),
  };
}

/** 赛事积分计算（decide.md §2），等价于 stats.py:compute_scores */
function computeScores(managersStats, gwList, rulesInput) {
  const rules = { ...RULES_DEFAULTS, ...(rulesInput || {}) };
  const byGw = new Map(gwList.map((g) => [g.gw, g]));
  const largeBgw = new Set(rules.large_bgw_gws || []);
  const tiers = rules.weekly_or_tiers;
  const avgPoints = rules.avg_or_points;
  const chipUnit = rules.chip_penalty;
  const hitPer4 = rules.hit_penalty_per_4;

  const tier = (rank) => {
    if (rank === null || rank === undefined) return 0;
    for (const t of tiers) if (rank <= t.max_rank) return t.points;
    return 0;
  };

  const computed = managersStats.map((m) => {
    const rows = [];
    for (let g = m.start_gw; g <= m.end_gw; g += 1) {
      const row = byGw.get(g);
      if (row) rows.push(row);
    }
    const sealed = rows.filter((r) => r.status === 'sealed');
    const weekly = sealed.reduce((a, r) => a + tier(r.overall_rank), 0);
    const hitCost = rows.reduce((a, r) => a + (r.transfers_cost || 0), 0);
    const hitAbs = Math.abs(hitCost);
    const hitPenalty = hitAbs ? pyRound((-hitAbs / 4) * hitPer4, 1) : 0;
    const usedChips = rows.flatMap((r) => r.chips || []).filter((c) => PENALIZABLE_CHIPS.includes(c));
    const chipPenalty = usedChips.length ? pyRound(-chipUnit * usedChips.length, 1) : 0;
    const ranks = sealed
      .map((r) => r.overall_rank)
      .filter((v) => v !== null && v !== undefined);
    const usedWildcard = rows.some((r) => (r.chips || []).includes('wildcard'));
    const unauthorized = rows.some((r) => (r.chips || []).some(
      (c) => PENALIZABLE_CHIPS.includes(c) && !largeBgw.has(r.gw),
    ));
    const disqualified = usedWildcard || unauthorized;
    return {
      settled: rows.length > 0 && rows.every((r) => r.status === 'sealed'),
      weekly,
      hit_cost: hitCost,
      hit_penalty: hitPenalty,
      used_chips: usedChips,
      chip_penalty: chipPenalty,
      hit_used: hitAbs > 0,
      transfer_count: rows.reduce((a, r) => a + (r.transfers_count || 0), 0),
      avg_or: ranks.length ? pyRound(ranks.reduce((a, b) => a + b, 0) / ranks.length, 1) : null,
      disqualified,
      reason: usedWildcard ? 'wildcard' : (unauthorized ? 'unauthorized_chip' : null),
      avg_or_award: null,
      avg_or_position: null,
      transfer_award: null,
    };
  });

  const seasonSettled = computed.length > 0 && computed.every((c) => c.settled);

  if (seasonSettled) {
    const ranked = computed.filter((c) => c.avg_or !== null).sort((a, b) => a.avg_or - b.avg_or);
    ranked.forEach((c, i) => {
      c.avg_or_award = i < avgPoints.length ? avgPoints[i] : 0;
      c.avg_or_position = i + 1;
    });
    for (const c of computed) {
      if (c.avg_or === null) {
        c.avg_or_award = 0;
        c.avg_or_position = null;
      }
      c.transfer_award = 0;
    }
    const eligible = computed.filter((c) => !c.hit_used && !c.disqualified);
    if (eligible.length) {
      const minCount = Math.min(...eligible.map((c) => c.transfer_count));
      const winners = eligible.filter((c) => c.transfer_count === minCount);
      const award = pyRound(rules.transfer_pool / winners.length, 1);
      for (const w of winners) w.transfer_award = award;
    }
  }

  const out = computed.map((c, i) => {
    const avgAward = seasonSettled ? c.avg_or_award : null;
    const transferAward = seasonSettled ? c.transfer_award : null;
    const parts = [c.weekly, c.hit_penalty, c.chip_penalty];
    if (seasonSettled) parts.push(avgAward || 0, transferAward || 0);
    const score = pyRound(parts.reduce((a, b) => a + b, 0), 1);

    const points = {
      avg_or_award: avgAward,
      avg_or_position: c.avg_or_position,
      weekly_or_award: c.weekly,
      transfer_award: transferAward,
      transfer_eligible: !c.hit_used && !c.disqualified,
      transfer_count: c.transfer_count,
      hit_penalty: c.hit_penalty,
      hit_cost: c.hit_cost,
      chip_penalty: c.chip_penalty,
      chips_penalized: c.used_chips,
    };

    const details = [];
    details.push(seasonSettled
      ? { label: '平均 OR 排名奖励', value: avgAward, kind: 'reward' }
      : { label: '平均 OR 排名奖励', value: '待结算', kind: 'pending' });
    details.push({ label: '单周 OR 奖励', value: c.weekly, kind: 'reward' });
    details.push(seasonSettled
      ? { label: '赛季末转会奖励', value: transferAward, kind: 'reward' }
      : { label: '赛季末转会奖励', value: '待结算', kind: 'pending' });
    if (c.hit_penalty !== 0) details.push({ label: 'Hit 处罚', value: c.hit_penalty, kind: 'penalty' });
    if (c.chip_penalty !== 0) details.push({ label: 'Chip 处罚', value: c.chip_penalty, kind: 'penalty' });

    return {
      ...managersStats[i],
      score,
      settled: c.settled,
      disqualified: c.disqualified,
      disqualify_reason: c.reason,
      points,
      score_details: details,
      rank: null,
    };
  });

  const ordered = [...out].sort(
    (a, b) => (a.disqualified ? 1 : 0) - (b.disqualified ? 1 : 0) || (b.score || 0) - (a.score || 0),
  );
  const active = ordered.filter((x) => !x.disqualified);
  let position = 0;
  let prevScore = null;
  active.forEach((x, i) => {
    if (x.score !== prevScore) {
      position = i + 1;
      prevScore = x.score;
    }
    x.rank = position;
  });
  for (const x of ordered) if (x.disqualified) x.rank = null;

  return { managers: out, season_settled: seasonSettled };
}

/* ==================== 装配 ==================== */

function buildTransferEntries(transfers, players) {
  return transfers.map((t) => ({
    element_in: t.element_in ?? null,
    element_in_name: (players[t.element_in] || {}).name ?? null,
    element_out: t.element_out ?? null,
    element_out_name: (players[t.element_out] || {}).name ?? null,
    gw: t.event ?? null,
    time_utc: t.time ?? null,
  }));
}

function managerFor(managers, gw) {
  return managers.find((m) => m.start_gw <= gw && gw <= m.end_gw) || null;
}

/**
 * 头像路径归一化。
 * config.json 里是裸文件名（Fran.jpg），meta.json 里是完整相对路径（assets/avatar/Fran.jpg），
 * 两者都可能作为输入，这里统一成完整相对路径，避免重复前缀。
 */
function normalizeAvatarPath(avatar) {
  if (!avatar) return null;
  const value = String(avatar);
  return value.includes('/') ? value : `assets/avatar/${value}`;
}

function avatarPath(manager) {
  return manager ? normalizeAvatarPath(manager.avatar) : null;
}

function chipsForGw(gw, picksData, chipsByGw) {
  let chipsPicks = null;
  if (picksData[gw]) {
    const active = picksData[gw].active_chip;
    chipsPicks = active ? (CANONICAL_CHIP[active] || active) : null;
  }
  const chipsHist = chipsByGw.get(gw);
  if (!chipsHist && !chipsPicks) return [];
  if (chipsHist && chipsPicks && chipsHist !== chipsPicks) return [chipsPicks];
  return [chipsPicks || chipsHist];
}

/**
 * 用一份上游快照装配出全部数据文件（meta / summary / stats / gw-*）。
 *
 * @param {object} input
 * @param {object} input.base        仓库中的基线数据 { meta, summary, stats }
 * @param {object} input.upstream    上游原始响应 { bootstrap, entry, history, transfers, picks, live }
 * @param {number} input.now         当前 UTC 毫秒
 * @param {number} [input.sealHours] 封印宽限期（小时）
 * @returns {{files: object, statuses: object, phase: string, currentGw: number|null, picksSet: number[]}}
 */
function assemble({ base, upstream, now, sealHours = SEAL_HOURS_DEFAULT }) {
  const { bootstrap, entry, history, transfers: transfersRaw } = upstream;
  const tz = (base.meta && base.meta.timezone) || 'Asia/Shanghai';
  const season = (base.meta && base.meta.season)
    || deriveSeason(bootstrap.events[0].deadline_time);
  const managers = (base.meta && base.meta.managers) || [];
  const baseGwList = (base.summary && base.summary.gw_list) || [];

  const events = [...bootstrap.events].sort((a, b) => a.id - b.id);
  const currentGw = latestStartedGw(events, now);

  const baseHasDetail = (id) => {
    const row = baseGwList[id - 1];
    return Boolean(row && row.has_detail);
  };
  const sealedEligible = (id) => currentGw !== null && id <= currentGw && baseHasDetail(id);

  const statuses = {};
  for (const e of events) statuses[e.id] = classifyEvent(e, now, sealHours, sealedEligible);

  // 抓取集合：live/finished，外加「刚由 live/finished 转为 sealed」的补抓
  const picksSet = new Set();
  for (const e of events) {
    const st = statuses[e.id];
    if (st === 'live' || st === 'finished') picksSet.add(e.id);
  }
  for (const e of events) {
    if (statuses[e.id] !== 'sealed') continue;
    const row = baseGwList[e.id - 1];
    if (!row) continue;
    if (row.status === 'live' || row.status === 'finished') picksSet.add(e.id);
  }

  const picksData = upstream.picks || {};
  const livePoints = upstream.live || {};
  const { players } = buildMaps(bootstrap);

  const histByGw = new Map();
  for (const h of (history && history.current) || []) {
    histByGw.set(h.event, {
      score: h.points ?? null,
      total_points: h.total_points ?? null,
      overall_rank: h.overall_rank !== null && h.overall_rank !== undefined ? h.overall_rank : (h.rank ?? null),
      gw_rank: h.rank ?? null,
      event_transfers_cost: h.event_transfers_cost ?? null,
    });
  }
  const chipsByGw = new Map();
  for (const c of (history && history.chips) || []) {
    chipsByGw.set(c.event, CANONICAL_CHIP[c.name] || c.name);
  }

  const transfersList = Array.isArray(transfersRaw)
    ? transfersRaw
    : ((transfersRaw || {}).transfers || []);
  const transfersByGw = new Map();
  for (const t of transfersList) {
    if (!transfersByGw.has(t.event)) transfersByGw.set(t.event, []);
    transfersByGw.get(t.event).push(t);
  }
  for (const list of transfersByGw.values()) {
    list.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
  }

  const gwList = [];
  for (let gw = 1; gw <= GW_TOTAL; gw += 1) {
    const status = statuses[gw];
    const manager = managerFor(managers, gw);
    const hist = histByGw.get(gw) || {};
    const hasPicks = picksSet.has(gw);
    const hasDetail = hasPicks || baseHasDetail(gw);
    gwList.push({
      gw,
      status,
      manager: manager ? manager.name : null,
      manager_avatar: avatarPath(manager),
      score: hist.score ?? null,
      total_points: hist.total_points ?? null,
      overall_rank: hist.overall_rank ?? null,
      gw_rank: hist.gw_rank ?? null,
      chips: status !== 'upcoming' ? chipsForGw(gw, picksData, chipsByGw) : null,
      transfers_count: (transfersByGw.get(gw) || []).length,
      transfers_cost: hist.event_transfers_cost || 0,
      has_detail: hasDetail,
    });
  }

  const gwDetails = {};
  for (const gw of [...picksSet].sort((a, b) => a - b)) {
    const rawPicks = [...((picksData[gw] || {}).picks || [])]
      .sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
    const starters = [];
    const subs = [];
    const ptsMap = livePoints[gw] || {};
    for (const p of rawPicks) {
      const item = enrichPick(p, players);
      item.points = ptsMap[p.element] ?? null;
      (item.is_substitute ? subs : starters).push(item);
    }
    const summary = gwList.find((g) => g.gw === gw);
    gwDetails[gw] = {
      season,
      gw,
      status: summary.status,
      summary,
      lineup: { starters, subs },
      transfers: buildTransferEntries(transfersByGw.get(gw) || [], players),
      chips: summary.chips || [],
    };
  }

  const statsManagers = computeManagerStats(managers, gwList);
  const { managers: scoredManagers, season_settled: seasonSettled } = computeScores(
    statsManagers, gwList, (base.meta && base.meta.rules) || {},
  );
  const seasonTotals = computeSeasonTotals(gwList);

  // ---- 版本号：仅内容真实变化时 +1（design.md §12.5）----
  const summaryObj = { season, data_version: 0, updated_at_utc: '', gw_list: gwList };
  const statsObj = {
    season,
    data_version: 0,
    updated_at_utc: '',
    season_settled: seasonSettled,
    managers: scoredManagers,
    season_totals: seasonTotals,
  };

  const baseSummarySig = base.summary ? significantJson(base.summary) : null;
  const baseStatsSig = base.stats ? significantJson(base.stats) : null;
  const baseVersion = (base.meta && base.meta.data_version) || 0;
  const changed = baseSummarySig !== significantJson(summaryObj)
    || baseStatsSig !== significantJson(statsObj);
  const dataVersion = changed ? baseVersion + 1 : baseVersion;
  const prevUpdated = (base.summary && base.summary.updated_at_utc) || null;
  const updatedAt = changed ? formatUtc(now) : (prevUpdated || formatUtc(now));
  summaryObj.data_version = dataVersion;
  summaryObj.updated_at_utc = updatedAt;
  statsObj.data_version = dataVersion;
  statsObj.updated_at_utc = updatedAt;

  const globalStatus = statuses[GW_TOTAL] === 'sealed'
    ? 'season_ended'
    : (currentGw === null ? 'pre_season' : 'live');
  let nextEvent = null;
  if (globalStatus === 'pre_season') nextEvent = events[0] || null;
  else if (globalStatus !== 'season_ended') nextEvent = events.find((e) => e.id > (currentGw || 0)) || null;
  const nextDeadline = nextEvent
    ? { gw: nextEvent.id, ...deadlineFields(nextEvent.deadline_time, tz) }
    : null;

  const metaEvents = events.map((e) => ({
    id: e.id,
    name: e.name ?? null,
    ...deadlineFields(e.deadline_time, tz),
    finished: Boolean(e.finished),
    status: statuses[e.id],
  }));

  const meta = {
    season,
    timezone: tz,
    team: {
      id: entry.id ?? null,
      name: entry.name ?? null,
      player_first_name: entry.player_first_name ?? null,
      player_last_name: entry.player_last_name ?? null,
      started_event: entry.started_event ?? 1,
      current_event: entry.current_event ?? null,
    },
    current_gw: { id: currentGw, status: globalStatus },
    next_deadline: nextDeadline,
    events: metaEvents,
    managers: managers.map((m) => ({
      name: m.name,
      start_gw: m.start_gw,
      end_gw: m.end_gw,
      avatar: normalizeAvatarPath(m.avatar),
      active: m.start_gw <= (currentGw || 0) && (currentGw || 0) <= m.end_gw,
    })),
    rules: { ...RULES_DEFAULTS, ...((base.meta && base.meta.rules) || {}) },
    seal_after_hours: sealHours,
    data_version: dataVersion,
    generated_at_utc: formatUtc(now),
    server_timestamp: now,
  };

  const files = {
    'meta.json': meta,
    'summary.json': summaryObj,
    'stats.json': statsObj,
  };
  for (const [gw, detail] of Object.entries(gwDetails)) {
    files[`gw-${String(gw).padStart(2, '0')}.json`] = detail;
  }

  return {
    files,
    statuses,
    phase: determinePhase(statuses),
    currentGw,
    picksSet: [...picksSet].sort((a, b) => a - b),
    changed,
  };
}

function deriveSeason(gw1DeadlineIso) {
  const d = new Date(parseUtcMs(gw1DeadlineIso));
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  if (month >= 7) return `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
  return `${year - 1}-${String(year % 100).padStart(2, '0')}`;
}

/* ==================== 基线数据读取 ==================== */

function candidateDataDirs() {
  const dirs = [];
  if (process.env.FPL_DATA_DIR) dirs.push(process.env.FPL_DATA_DIR);
  dirs.push(path.join(process.cwd(), 'data'));
  dirs.push(path.join(__dirname, '..', 'data'));
  dirs.push(path.join(__dirname, 'data'));
  return dirs;
}

function loadBaseFile(name) {
  for (const dir of candidateDataDirs()) {
    try {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* 尝试下一个候选目录 */
    }
  }
  return null;
}

function loadBase() {
  return {
    meta: loadBaseFile('meta.json'),
    summary: loadBaseFile('summary.json'),
    stats: loadBaseFile('stats.json'),
  };
}

/* ==================== 主流程 ==================== */

const PHASE_CACHE_SECONDS = {
  [PHASE_LIVE]: 60,
  [PHASE_SETTLING]: 300,
  [PHASE_IDLE]: 1800,
};

/**
 * 拉取上游并装配实时数据。
 *
 * @param {object} [options]
 * @param {object} [options.base]       基线数据；缺省从 data/ 读取
 * @param {number} [options.now]        当前 UTC 毫秒，缺省 Date.now()
 * @param {number} [options.sealHours]  封印宽限期
 * @param {string} [options.ua]         请求 User-Agent
 * @param {object} [options.api]        注入自定义 API 客户端（测试用）
 * @param {object} [options.upstream]   直接注入上游快照（测试用，跳过网络）
 * @returns {Promise<object>} assemble() 的结果，另含 refreshed / requests 等运行信息
 */
async function collectLive(options = {}) {
  const base = options.base || loadBase();
  if (!base.meta || !base.summary) {
    throw new Error('缺少基线数据 data/meta.json / data/summary.json，无法装配实时数据');
  }
  const now = options.now ?? Date.now();
  const teamId = (base.meta.team && base.meta.team.id) || null;
  if (!teamId) throw new Error('基线 meta.json 缺少 team.id');

  if (options.upstream) {
    return { ...assemble({ base, upstream: options.upstream, now, sealHours: options.sealHours }), refreshed: true, requests: 0 };
  }

  const api = options.api || createApi(teamId, { ua: options.ua || DEFAULT_UA });
  const sealHours = options.sealHours
    ?? (base.meta.seal_after_hours !== undefined ? base.meta.seal_after_hours : SEAL_HOURS_DEFAULT);

  let requests = 0;
  const count = (p) => {
    requests += 1;
    return p;
  };

  // 第一轮：并发取基础数据（事件表 / 账号 / 历史 / 转会）
  const [bootstrap, entry, history, transfers] = await Promise.all([
    count(api.bootstrapStatic()),
    count(api.entry()),
    count(api.history()),
    count(api.transfers()),
  ]);

  // 先判定需要抓哪些轮次，再并发取 picks + live（避免抓全量）
  const preStatuses = {};
  const events = [...bootstrap.events].sort((a, b) => a.id - b.id);
  const currentGw = latestStartedGw(events, now);
  const baseGwList = base.summary.gw_list || [];
  const baseHasDetail = (id) => Boolean(baseGwList[id - 1] && baseGwList[id - 1].has_detail);
  const sealedEligible = (id) => currentGw !== null && id <= currentGw && baseHasDetail(id);
  for (const e of events) preStatuses[e.id] = classifyEvent(e, now, sealHours, sealedEligible);

  const gwNeeded = new Set();
  for (const e of events) {
    const st = preStatuses[e.id];
    if (st === 'live' || st === 'finished') gwNeeded.add(e.id);
  }
  for (const e of events) {
    if (preStatuses[e.id] !== 'sealed') continue;
    const row = baseGwList[e.id - 1];
    if (row && (row.status === 'live' || row.status === 'finished')) gwNeeded.add(e.id);
  }

  const picks = {};
  const live = {};
  await Promise.all([...gwNeeded].sort((a, b) => a - b).map(async (gw) => {
    const [p, l] = await Promise.all([count(api.picks(gw)), count(api.eventLive(gw))]);
    picks[gw] = p;
    live[gw] = {};
    for (const el of (l && l.elements) || []) {
      live[gw][el.id] = ((el.stats || {}).total_points);
    }
  }));

  const result = assemble({
    base,
    upstream: { bootstrap, entry, history, transfers, picks, live },
    now,
    sealHours,
  });
  return { ...result, refreshed: true, requests };
}

module.exports = {
  // 常量
  FPL_BASE,
  DEFAULT_UA,
  GW_TOTAL,
  SEAL_HOURS_DEFAULT,
  RULES_DEFAULTS,
  CANONICAL_CHIP,
  PENALIZABLE_CHIPS,
  PHASE_LIVE,
  PHASE_SETTLING,
  PHASE_IDLE,
  PHASE_CACHE_SECONDS,
  // 工具
  parseUtcMs,
  formatUtc,
  formatOffsetIso,
  deadlineFields,
  pyRound,
  significantJson,
  stableStringify,
  httpJson,
  createApi,
  // 丰富
  buildMaps,
  enrichPick,
  // 状态机
  classifyEvent,
  latestStartedGw,
  determinePhase,
  // 统计
  computeManagerStats,
  computeSeasonTotals,
  computeScores,
  // 装配
  assemble,
  deriveSeason,
  normalizeAvatarPath,
  // 基线
  loadBaseFile,
  loadBase,
  // 主流程
  collectLive,
};
