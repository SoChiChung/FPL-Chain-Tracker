# FPL 接龙赛 · 赛事积分展示逻辑设计（decide.md）

> 版本：v0.2 ｜ 日期：2026-09-07 ｜ 状态：口径已确认，待实现
> 本文档是 `design.md` 的**增量补充**，仅覆盖「赛事积分」的计算与展示逻辑。
> 其余模块（数据采集、GW 状态机、时间线、转会/阵容详情）维持 design.md 不变。
> 依据：《第1届9人制FPL接力赛规则（修改版）》。

---

## 1. 背景与目标

**现状**：前端 `index.html` 第二个 Tab「玩家积分榜」目前是占位实现（`app.js` 中 `renderLeaderboard` 渲染「积分规则开发中，当前展示玩家接管数据」）。`stats.json` 的 `managers[]` 只含表现统计（`avg_rank`、`best_rank`、`total_transfers` 等），**不含赛事积分**。

**目标**：依据规则，在数据层算出每名经理的赛事积分，并在「玩家积分榜」Tab 完整展示：总分、名次、加分明细、扣分明细、资格状态。

**原则**（沿用 design.md）：
- 积分**由后端 `stats.py` 计算**后写入 `data/stats.json`，前端**只读不重算**（「数据文件即数据库」）。
- 规则参数（分档、处罚额度、大型 BGW 名单）**入配置** `config.json` 的 `rules` 块，不写死（「配置与代码分离」）。
- 前端改动**仅限积分榜区块**，接龙赛时间线等其他区块不动。

---

## 2. 规则 → 积分模型

### 2.1 积分构成总览

每名经理的赛事积分由三类加分项、两类扣分项组成：

| 类别 | 规则出处 | 符号 | 结算时机 |
|---|---|---|---|
| ① 平均 OR 排名奖励 | 二（一） | +20 ~ +1 | 赛季末（9 人全部完成） |
| ② 单周 OR 排名奖励 | 二（二） | 每轮 +0 ~ +3 | 逐轮实时累计 |
| ③ 赛季末转会奖励 | 二（三） | 最少转会者平分 +4 | 赛季末 |
| ④ Hit 处罚 | 二（五） | 每 -4 扣 0.5 | 逐轮实时累计 |
| ⑤ Chip 处罚 | 二（六） | 每张 -1.5 | 逐轮实时累计 |

**总分公式**：

```
score = ① + ② + ③ + ④ + ⑤      （④⑤ 为负值；最终保留一位小数，不取整）
```

> **「实时」vs「结算」分层**是本设计的关键：②④⑤ 每个 GW 结算（sealed）后即可确定，可实时累计展示；①③ 依赖 9 名经理**全部**完成 4 轮后才能排名/评比，属于赛季末结算项。

### 2.2 逐条规则的形式化定义

**符号约定**：经理 `m` 的接管区间 `S = [start_gw, end_gw]`（共 4 轮）；`S_sealed` 表示区间内 `status == "sealed"` 的轮次；`rank_gw` 表示该轮结算后的 Overall Rank（即 `summary.gw_list[].overall_rank`）。

#### ① 平均 OR 排名奖励

```
avg_or(m) = mean( rank_gw )，仅统计 S_sealed 内 rank_gw 非 null 的轮次
```

9 名经理按 `avg_or` **升序**排名（数值越小排名越高），第 1~9 名依次对应下表发分：

| 名次 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|
| 奖励 | 20 | 15 | 12 | 9 | 7 | 5 | 3 | 2 | 1 |

- 平均 OR 精确相同几乎不可能，**不做并列特殊处理**，直接按升序排名发分。
- `rank_gw` 为 null 的轮次（数据抓取异常）从均值中剔除，属容错处理，不引入「弃赛轮」概念。

#### ② 单周 OR 排名奖励

对 `S_sealed` 内每一轮，按该轮结算 OR 分档（**取最高档，不重复累计**）：

```
tier(r) =  3  , 若 r ≤  10,000
        =  2  , 若 r ≤ 100,000
        =  1  , 若 r ≤ 200,000
        =  0  , 若 r >  200,000 或 r 为 null
```

```
weekly_or(m) = Σ_{gw ∈ S_sealed} tier(rank_gw)       （上限 3×4 = 12 分）
```

#### ③ 赛季末转会奖励（已确认）

- **评选资格**：区间 `S` 内**任一**轮 `transfers_cost < 0`（即用过 Hit）的经理，失去评选资格。
- **比较指标**：`transfer_count = Σ_{gw∈S} transfers_count_gw`，即 transfer **总数量**（免费 + 付费转会都算）。
- **发分**：在有资格的经理中，按 `transfer_count` **从小到大**排列，取最小值 `min_count`；`transfer_count == min_count` 的经理（并列最少）共同分享 4 分：

```
min_count       = min({ transfer_count(m) | eligible(m) })
winners         = { m | eligible(m) 且 transfer_count(m) == min_count }
transfer_award  = m ∈ winners ? round( 4 ÷ |winners| , 1 ) : 0
```

（口径：**资格看是否用过 Hit，排名看 transfer 总数量**；仅并列最少者平分 4 分，而非所有有资格者平分。）

#### ④ Hit 处罚

```
hit_cost(m)      = Σ_{gw ∈ S} transfers_cost_gw      （负值，如 -4 / -8 / -12）
hit_penalty(m)   = hit_cost / 8                      （每 -4 扣 0.5，允许 0.5 步进，不取整）
```

#### ⑤ Chip 处罚

对 `S` 内使用的每张 `free_hit` / `bench_boost` / `triple_captain` 扣 1.5 分：

```
chip_penalty(m) = -1.5 × (区间内上述三类 chip 的总张数)
```

#### 取消资格（Disqualify）

出现以下任一情形，`disqualified = true`，**不计入排名、不参与评奖与奖金**：

| 情形 | 判定 |
|---|---|
| 使用 Wildcard | 区间内任一轮 `chips` 含 `wildcard`（全赛季禁止） |
| 非大型 BGW 违规用 Chip | 区间内某轮用了 Chip 且该轮**不属于大型 BGW**（`config.rules.large_bgw_gws`） |

---

## 3. 数据来源映射

规则所需数据与现有 JSON 字段的对应关系（**无需新增采集接口**，除大型 BGW 名单）：

| 规则字段 | 现有字段 | 来源文件 |
|---|---|---|
| 单轮结算 OR | `summary.gw_list[].overall_rank` | summary.json |
| 轮次是否结算 | `summary.gw_list[].status`（`sealed`） | summary.json |
| 转会笔数 | `summary.gw_list[].transfers_count` | summary.json |
| 转会扣分（Hit） | `summary.gw_list[].transfers_cost` | summary.json |
| Chip 使用 | `summary.gw_list[].chips`（canonical 名） | summary.json |
| 经理接管区间 | `meta.managers[].start_gw/end_gw` | meta.json |
| 大型 BGW 名单 | `config.rules.large_bgw_gws`（人工维护） | config.json |
| Top 10000 平均分（奖金 tie-breaker） | **无 → 可选扩展** | 本期不实现（见 §7 待定） |

> 说明：现有 `stats.py` 已计算 `avg_rank`（= `mean(overall_rank)`），与 ① 所需口径一致；但积分口径要求**只用 sealed 轮**，故在积分计算中单独取 `S_sealed`，避免 live 轮实时排名导致积分抖动。

---

## 4. 数据结构设计（stats.json 扩展）

### 4.1 `managers[]` 元素新增字段

在现有 `managers[]` 元素上**追加**（不删改既有字段，向后兼容）：

```json
{
  "name": "Fran",
  "start_gw": 3,
  "end_gw": 6,
  "...": "（原有 avg_rank / best_rank / total_transfers 等字段不变）",

  "score": 22.0,
  "rank": 2,
  "settled": false,
  "disqualified": false,
  "disqualify_reason": null,

  "points": {
    "avg_or_award": null,
    "avg_or_position": null,
    "weekly_or_award": 9,
    "transfer_award": null,
    "transfer_eligible": true,
    "transfer_count": 6,
    "hit_penalty": -1.5,
    "hit_cost": -12,
    "chip_penalty": -1.5,
    "chips_penalized": ["free_hit"]
  },

  "score_details": [
    { "label": "平均 OR 排名奖励", "value": "待结算", "kind": "pending" },
    { "label": "单周 OR 奖励（GW3-GW6）", "value": 9, "kind": "reward" },
    { "label": "赛季末转会奖励", "value": "待结算", "kind": "pending" },
    { "label": "Hit 处罚（-12 分）", "value": -1.5, "kind": "penalty" },
    { "label": "Chip 处罚（Free Hit）", "value": -1.5, "kind": "penalty" }
  ]
}
```

**字段表（新增部分）**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `score` | number/null | 赛事总积分。结算前为「可确定部分」（②+④+⑤）；结算后为最终总分。null 表示尚无任何数据 |
| `rank` | int/null | 积分榜名次（按 `score` 降序，同分并列；`disqualified` 者置后） |
| `settled` | bool | 该经理区间内 4 轮是否全部 `sealed` |
| `disqualified` | bool | 是否取消资格 |
| `disqualify_reason` | string/null | 取消资格原因（`wildcard` / `unauthorized_chip`） |
| `points.avg_or_award` | number/null | ① 平均 OR 排名奖励（未结算为 null） |
| `points.avg_or_position` | int/null | ① 平均 OR 名次（1-9） |
| `points.weekly_or_award` | number | ② 单周 OR 奖励合计 |
| `points.transfer_award` | number/null | ③ 转会奖励（未结算为 null） |
| `points.transfer_eligible` | bool | ③ 是否有评选资格（未使用 Hit） |
| `points.transfer_count` | int | ③ transfer 总数量 = `Σ transfers_count`（比较指标，免费+付费都算） |
| `points.hit_penalty` | number | ④ Hit 处罚（负值） |
| `points.hit_cost` | number | ④ 游戏内 Hit 扣分原值（透明展示） |
| `points.chip_penalty` | number | ⑤ Chip 处罚（负值） |
| `points.chips_penalized` | array | ⑤ 触发处罚的 chip canonical 名 |
| `score_details[]` | array | 扁平化明细，前端直接渲染（`label` / `value` / `kind`） |

### 4.2 `stats.json` 顶层新增字段

```json
{
  "season": "2026-27",
  "season_settled": false,
  "...": "（原有 data_version / updated_at_utc / managers / season_totals 不变）"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `season_settled` | bool | 9 名经理是否全部 `settled`。为 true 时才结算 ①③ |

---

## 5. 计算流程（stats.py 扩展）

在现有 `compute_manager_stats` 之后新增 `compute_scores(managers_stats, gw_list, rules)`：

```
输入：managers_stats（现有统计）、gw_list（summary）、rules（config.rules）
步骤：
 1  按 manager 区间切出 sealed 轮次集合 S_sealed，以及全区间 S
 2  逐经理计算 ②④⑤（实时可确定项）
      weekly_or_award = Σ tier(rank_gw)
      hit_cost / hit_penalty
      chip_penalty / chips_penalized
 3  判定 disqualify（wildcard / 非大型 BGW 用 chip）
 4  若 season_settled（9 人全部 sealed）：
      计算 avg_or 并 9 人升序排名 → ① avg_or_award / avg_or_position
      判定转会资格（未使用 Hit）→ 按 transfer_count 升序取并列最少者 → ③ transfer_award = round(4 ÷ 获奖人数, 1)
      score = ① + ② + ③ + ④ + ⑤
    否则：
      score = ② + ④ + ⑤（暂定分），①③ 记为 null
 5  生成 score_details 数组
 6  按 score 降序排名（disqualified 置后），写回 rank
 7  输出 season_settled 到 stats.json 顶层
```

**幂等性**：积分计算完全由 `summary.json` + `rules` 派生，同输入同输出，与 design.md 幂等原则一致；无变化不触发版本号递增。

---

## 6. 前端展示方案（assets/js/app.js）

### 6.1 数据接入（改动点 1：`normalizePlayers`）

现有函数已兼容 `stats.players` 与 `stats.managers` 两种形态。本期后端继续输出 `stats.managers`（在其上追加积分字段），故将 `managers` 分支改为：

```js
// managers 分支（原 score: null → 改为读取 score）
{
  name: m.name,
  avatar: ...,
  score: m.score,              // ← 由 null 改为 m.score
  rank: m.rank,                // ← 新增
  hasScore: m.score !== null && m.score !== undefined,
  score_details: m.score_details,   // ← 新增，透传
  settled: m.settled,               // ← 新增
  disqualified: m.disqualified,     // ← 新增
  disqualify_reason: m.disqualify_reason,
  range: m, stats: m,
}
```

### 6.2 榜单行渲染（改动点 2：`leaderboardRowHtml`）

- 有 `score` 时：显示数字总分（已有 `.lb-score`）。
- `settled === false` 时：总分旁加「暂定」徽标（提示 ①③ 待结算）。
- `disqualified === true` 时：加「取消资格」徽标，总分弱化/置灰，可 hover 显示 `disqualify_reason`。

### 6.3 明细渲染（改动点 3：`playerDetailHtml`）

复用现有 `score_details` 渲染逻辑（已支持 `{label, value}` 逐条渲染），仅需：
- 按 `kind` 区分样式：`reward`（加分）与 `penalty`（扣分）、`pending`（灰，显示「待结算」）。
- 追加一行「接管范围」与原有统计（`avg_rank` 等）保持不变。

### 6.4 排序

`renderLeaderboard` 中 `hasScore` 时已按 `score` 降序排序；新增：
- `disqualified` 者固定排最后（不参与名次）。
- 同分保持并列（`rank` 相同）。

### 6.5 头部提示（改动点 4）

`lb-header` 的「积分规则开发中」提示改为：
- `season_settled === false` → 「赛季进行中，平均 OR 与转会奖励待结算」。
- `season_settled === true` → 移除提示（展示最终积分）。

---

## 7. 规则口径决议记录（主人 2026-09-07 确认）

| # | 议题 | 决议 |
|---|---|---|
| 7.1 | 转会奖励口径 | **资格看是否用过 Hit，排名看 transfer 总数量**：未使用 Hit 的经理中，transfer 总数量（`Σ transfers_count`）最少者（并列）平分 4 分 |
| 7.2 | 大型 BGW 名单来源 | 由主人在 `config.json` 的 `rules.large_bgw_gws` 手动维护（格式见 README「配置说明」） |
| 7.3 | 平均 OR 并列 | 不做特殊处理（精确并列几乎不可能），直接升序排名发分 |
| 7.4 | 弃赛轮 | 无「弃赛轮」概念；`rank_gw` 为 null 仅作抓取异常容错（该轮计 0 分、均值剔除） |
| 7.5 | 小数精度 | 统一保留**一位小数**，不取整、不四舍五入到整数 |

### 待定

| # | 议题 | 现状 |
|---|---|---|
| 7.6 | 奖金 tie-breaker（规则四） | 需「Top 10000 平均分」数据，本期不实现；积分榜同分并列，奖金裁决人工 |

---

## 8. 边界情况

| 场景 | 处理 |
|---|---|
| 赛季尚未开始 / 无 sealed 轮 | 所有经理 `score` 可确定部分为 0，①③ 为 null；积分榜显示「待结算」 |
| 某经理区间含 live/finished 轮 | 该轮不计入 ②（只用 sealed），`settled=false` |
| 使用 Wildcard | `disqualified=true`，原因 `wildcard`，排名置后 |
| 非大型 BGW 用 Chip | `disqualified=true`，原因 `unauthorized_chip` |
| 未使用 Hit 且 transfer 总数量并列最少 | 平分 4 分，保留一位小数 |
| 同分 | 积分榜并列，`rank` 相同 |

---

## 9. 实施范围与不改动清单

**改动文件（本期）**：

| 文件 | 改动 | 性质 |
|---|---|---|
| `crawler/stats.py` | 新增 `compute_scores` + 输出积分字段 | 后端计算 |
| `config.json` | 新增 `rules` 块（大型 BGW 名单 + 规则参数） | 配置 |
| `README.md` | 补充 `rules` 字段与 `large_bgw_gws` 填写说明 | 文档 |
| `assets/js/app.js` | 积分榜：数据接入、明细渲染、排序、资格/暂定标识 | 前端展示 |
| `assets/css/cinematic.css` | 新增积分明细/徽标样式（可选，复用现有类为主） | 前端样式 |
| `schema/stats.schema.json` | 补充新增字段定义（文档性） | Schema |

**明确不改**：`crawler` 其余模块（采集/丰富/校验）、`index.html` 结构、接龙赛时间线、转会/阵容详情、`meta.json`/`summary.json`/`gw-*.json` 结构。

---

## 附录：与 design.md 的衔接

- 本文档新增字段均追加在 `stats.json` 现有结构上，遵循 design.md §8.5「只增不改、向后兼容」。
- 积分计算位于 `stats.py`，与 design.md §11「统计由 summary 数据计算」的职责边界一致。
- 前端契约（design.md §12）不变，仅积分榜区块从「占位」升级为「真实积分展示」。

---

文档结束。
