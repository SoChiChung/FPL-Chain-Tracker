# FPL Chain Tracker — 技术设计文档（design.md）

> 版本：v1.0 ｜ 日期：2026-08-25 ｜ 状态：待评审
> 本文档只包含架构与数据设计，不含实现代码。后续开发以本文档为唯一技术基线。

---

## 1. 项目简介

FPL Chain Tracker 是一个部署在 GitHub Pages 上的静态数据展示站点，用于完整记录并展示一个特殊 FPL（Fantasy Premier League）接龙账号的历史数据。

该账号（FPL Team ID: `7557100`）从 GW3 起由 9 位玩家轮流接管操作，每人负责一段连续的 Gameweek。系统需要记录每轮阵容、转会、芯片使用、积分与 Overall Rank，并从"接龙玩家"视角统计每位玩家接管期间的战绩。

系统采用完全无服务器架构：GitHub Actions 定时调用 FPL 官方公开 API 抓取数据 → 生成结构化 JSON → 提交到仓库 → GitHub Pages 托管静态页面 → 前端读取 JSON 渲染 GW Timeline。全程不使用数据库，所有历史数据以 JSON 文件形式存在于仓库 `data/` 目录。

---

## 2. 项目目标

### 2.1 核心目标

1. **全自动数据采集**：无需人工维护，GitHub Actions 定时抓取，数据自动生成并提交
2. **完整历史记录**：每个 GW 的阵容（首发 11 + 替补 4 + 队长/副队长）、转会、芯片、积分、Overall Rank
3. **接龙视角统计**：每位玩家接管期间的平均/最佳 Overall Rank、平均/最高/最低得分等自动计算
4. **GW Timeline 前端展示**：折叠/展开两级信息层——折叠显示概要（GW、玩家、分数、总分、OR），展开显示阵容/转会/芯片详情
5. **可扩展**：架构预留多赛季、球员得分明细、图表、多账号等扩展能力（见第 15 章）

### 2.2 非目标（明确不做）

- 不使用数据库、不使用任何后端服务
- 不做比赛进行中的分钟级实时推送（本期只保证"每 6 小时快照"粒度）
- 不做账号登录/鉴权（数据全部公开）
- 前端不引入构建框架（纯静态 HTML/CSS/JS，零构建步骤，降低部署复杂度）

---

## 3. 系统整体架构

### 3.1 架构图

```
┌──────────────────────────────────────────────────────────────┐
│                    FPL 官方公开 API（5 个接口）                 │
│   bootstrap-static / entry / history / picks / transfers      │
└───────────────────────────────┬──────────────────────────────┘
                                │ HTTPS（JSON，无鉴权）
                                ▼
┌──────────────────────────────────────────────────────────────┐
│              GitHub Actions（定时调度，每天 4 次）               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  crawler/（Python 3.11+，纯标准库，无第三方依赖）          │  │
│  │  读取 config.json（唯一配置入口）                          │  │
│  │  抓取 → 丰富 → 聚合 → 统计 → 校验 → 写 data/*.json         │  │
│  └────────────────────────────────────────────────────────┘  │
│  有变更 → git commit & push（幂等，无变更不提交）               │
└───────────────────────────────┬──────────────────────────────┘
                                │ push 到 main 分支
                                ▼
┌──────────────────────────────────────────────────────────────┐
│          GitHub Pages（静态托管，main 分支根目录发布）           │
│   index.html / assets/css / assets/js                        │
│   前端 fetch data/*.json（相对路径）                           │
│   渲染 GW Timeline + 玩家统计 + Deadline Countdown            │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 设计原则

| 原则 | 说明 |
|---|---|
| 数据文件即数据库 | `data/` 下所有 JSON 是唯一数据源，前端不访问任何其他数据来源 |
| 配置与代码分离 | 账号 ID、玩家名单、时区全部在 `config.json`；写死在代码里视为缺陷 |
| 只读历史 + 幂等更新 | 每次运行可重放，输出与上次相同则不产生提交 |
| 前端零构建 | 纯静态文件，不需要 Node/npm/Jekyll |
| 快照固化 | 抓取时完成数据丰富（球员名/球队/位置），写入后不再重算（见 5.5） |

### 3.3 目录设计

```
fpl-chain-tracker/
│
├── config.json                  # 【唯一配置】账号信息 + 9 位接龙玩家 + 采集参数
│
├── index.html                   # 前端入口页面（GitHub Pages 根页面）
├── assets/                      # 前端静态资源（随仓库发布到 Pages）
│   ├── avatar/                  # 玩家微信头像（见 6.4 头像规范）
│   │   ├── Fran.png
│   │   ├── …（与 config 中玩家 name 一一对应）
│   │   └── default.png          # 缺省头像兜底
│   ├── css/                     # 前端样式
│   └── js/                      # 前端脚本（读取 data/ JSON 渲染）
│
├── data/                        # 【采集产物】全部历史数据的唯一存放地，由 crawler 生成
│   ├── meta.json                # 赛季元信息 + 当前 GW + 全部 deadline + 玩家名单 + 版本号
│   ├── summary.json             # 全部 GW 概要数组（时间线折叠态数据源）
│   ├── gw-01.json … gw-38.json  # 每轮详情（懒加载，展开时读取）
│   └── stats.json               # 玩家表现统计 + 赛季汇总
│
├── crawler/                     # Python 采集程序（纯标准库，无第三方依赖）
│   ├── run.py                   # 入口：调度完整采集流程（支持 --full 全量回填）
│   ├── config.py                # config.json 加载 + 启动自检
│   ├── api_client.py            # FPL API 封装（重试/退避/限速/User-Agent）
│   ├── enrich.py                # 球员 ID → 名称/球队/位置 映射与丰富
│   ├── timeutil.py              # UTC ↔ Asia/Shanghai 转换与格式化
│   ├── stats.py                 # 玩家接龙统计计算
│   └── validate.py              # 输出数据自校验（校验失败则不提交）
│
├── scripts/                     # 本地开发辅助脚本（不进 Actions）
│   ├── check_config.py          # 校验 config.json 与头像文件一致性
│   └── backfill.py              # 手动触发全量回填（等价 crawler/run.py --full）
│
├── schema/                      # JSON Schema 定义（文档性 + 可选校验）
│   ├── meta.schema.json
│   ├── summary.schema.json
│   ├── gw.schema.json
│   └── stats.schema.json
│
├── .github/
│   └── workflows/
│       └── update-data.yml      # 定时采集工作流（调度 + 采集 + 提交）
│
└── .nojekyll                    # 空文件，阻止 GitHub Pages 走 Jekyll 处理
```

### 3.4 目录职责说明

| 目录/文件 | 职责 | 谁写 | 谁读 |
|---|---|---|---|
| config.json | 唯一配置入口 | 人工维护 | crawler（前端不直接读） |
| data/ | 数据产物，前端唯一数据源 | crawler 自动生成 | 前端 |
| assets/avatar/ | 玩家头像 | 人工维护 | 前端 |
| crawler/ | 采集与聚合逻辑 | 开发维护 | GitHub Actions |
| scripts/ | 本地辅助 | 开发维护 | 人工本地运行 |
| schema/ | JSON 结构定义 | 开发维护 | validate.py / 文档 |
| .github/workflows/ | 调度与发布 | 开发维护 | GitHub Actions |

**关键约束**：

- 前端**永不**读取 `config.json`，配置信息由 crawler 合并进 `data/meta.json` 后提供给前端（前端单一数据源）
- `data/` 内文件只能由 crawler 生成/覆盖，人工编辑视为配置漂移
- 头像文件名与玩家 name 强绑定（见 6.4）

---

## 4. 数据流设计

### 4.1 主流程

```
每次运行（GitHub Actions 定时或本地手动）：
──────────────────────────────────────────────
 ① config.json 加载与自检
 ② 抓取 bootstrap-static          → 事件表（deadline/finished）、球员映射、球队映射
 ③ 抓取 entry/{id}/               → 队名、started_event、current_event
 ④ 判定当前 GW / 下一 GW / 各轮状态（见第 9 章）
 ⑤ 抓取 entry/{id}/history/       → 每轮 points/total_points/overall_rank、赛季 chips
 ⑥ 抓取 entry/{id}/transfers/     → 全赛季转会列表（按 event 归组）
 ⑦ 抓取 picks（增量集合，见 10.3）→ 每轮阵容
 ⑧ 丰富数据（球员名/球队/位置映射）
 ⑨ 计算玩家统计（stats.py）
 ⑩ 输出 meta.json / summary.json / gw-*.json / stats.json
 ⑪ 自校验（validate.py）
 ⑫ 有变更则提交并推送；无变更则静默退出
```

### 4.2 数据归属

| 输出文件 | 由哪些步骤产出 |
|---|---|
| meta.json | ②③④⑩（事件表、当前 GW、玩家名单） |
| summary.json | ⑤⑧⑩（每轮概要，含 manager 归属） |
| gw-{n}.json | ⑤⑥⑦⑧⑩（阵容/转会/芯片/概要） |
| stats.json | ⑤⑨⑩（玩家统计） |

### 4.3 原子性与幂等

- 所有文件先写 `data/.tmp/` 下的临时文件，**全部生成并校验通过后**一次性 move 到正式位置
- 任一接口失败或校验失败导致数据不完整时：**不覆盖旧文件**，本次运行标记失败（旧数据保留，下次运行重试补齐）
- 每次运行对同一输入产生同一输出（幂等）；输出与上次相同则 git 无 diff，不产生空提交

---

## 5. API 使用说明

### 5.1 接口清单

| # | 接口 | URL | 调用频率 | 用途 |
|---|---|---|---|---|
| 1 | Bootstrap Static | `https://fantasy.premierleague.com/api/bootstrap-static/` | 每次运行 1 次 | 赛季基础数据：events（deadline/finished）、elements（球员 ID 映射）、teams（球队映射） |
| 2 | 账号信息 | `https://fantasy.premierleague.com/api/entry/{team_id}/` | 每次运行 1 次 | 队名、玩家姓名、started_event（账号首个参赛 GW）、current_event |
| 3 | 赛季历史 | `https://fantasy.premierleague.com/api/entry/{team_id}/history/` | 每次运行 1 次 | `current[]`：每轮 points / total_points / rank / overall_rank / event_transfers；`chips[]`：赛季芯片使用记录 |
| 4 | 每轮阵容 | `https://fantasy.premierleague.com/api/entry/{team_id}/event/{gw}/picks/` | 增量（见 10.3） | `picks[]`：15 人（element、position 1-15、is_captain、is_vice_captain、multiplier）；`active_chip` |
| 5 | 转会记录 | `https://fantasy.premierleague.com/api/entry/{team_id}/transfers/` | 每次运行 1 次 | `transfers[]`：element_in / element_out / cost（负分）/ event / time |

### 5.2 关键字段（字段名以实际响应为准）

| 接口 | 使用字段 | 说明 |
|---|---|---|
| bootstrap-static | `events[].{id, name, deadline_time, finished}` | deadline_time 为 UTC ISO 字符串；finished 表示结算完成 |
| bootstrap-static | `elements[].{id, web_name, first_name, second_name, element_type, team}` | element_type: 1=GKP 2=DEF 3=MID 4=FWD；team 为球队内部 ID |
| bootstrap-static | `teams[].{id, name, short_name}` | 用于把 team ID 映射为三字母代码（如 LIV） |
| entry/{id} | `{name, player_first_name, player_last_name, started_event, current_event}` | name 为队名 |
| history | `current[].{event, points, total_points, rank, rank_sort, overall_rank, event_transfers, event_transfers_cost, chips}` | overall_rank 为当前排名（若缺失回退用 rank） |
| history | `chips[].{name, event, time}` | **赛季芯片权威来源**；name 枚举映射见 5.4 |
| picks | `picks[].{element, position, is_captain, is_vice_captain, multiplier, is_substitute}` | position 1-11 首发、12-15 替补；is_substitute 字段若缺失则以 position > 11 推导 |
| picks | `active_chip` | 该轮使用的芯片（与 history 交叉校验，互异时以 picks 为准） |
| transfers | `transfers[].{element_in, element_out, cost, event, time}` | cost 为负浮点数（如 -4.0）；event 为转会发生 GW |

### 5.3 请求规范

- **必须携带 User-Agent**：FPL API 对缺失/默认 UA 的请求会返回 403。UA 格式建议 `Mozilla/5.0 (compatible; FPLChainTracker/1.0; +https://github.com/{owner}/{repo})`
- **限速**：两次请求间隔 ≥ 300ms（默认 400ms，config.crawl 可调）
- **超时与重试**：单请求超时 10s；失败重试 3 次，退避 5s/10s/20s
- **429 处理**：读取响应头 `Retry-After`，按其值等待后重试；连续 3 次 429 则本次运行中止并标记失败
- **bootstrap-static 体积**：约 3-4MB，每次运行只抓取 1 次，**不落盘、不入库**，仅用于本次运行的内存映射

### 5.4 芯片名称映射

| FPL API 原始值 | 存储规范值（canonical） |
|---|---|
| `wildcard` | `wildcard` |
| `freehit` | `free_hit` |
| `bbooster` | `bench_boost` |
| `3xc` | `triple_captain` |

（API 中两次通配符机会均返回 `wildcard`，不做区分，原样记录。）

### 5.5 快照原则

球员名称、所属球队、位置在**采集当日**由 bootstrap 映射写入并固化。历史 GW 文件一经写入，不再用最新 bootstrap 重算（避免球员跨赛季转会等导致的历史数据漂移）。全量回填（见 10.4）会导致快照整体更新，属预期行为。

---

## 6. Config.json 设计

### 6.1 设计原则

- config.json 是 crawler 的**唯一配置入口**，前端不读取
- 所有可变内容（账号、玩家、时区、采集参数）入配置，不写死
- 采集程序启动时对 config 做完整性自检，不合法则拒绝运行

### 6.2 完整示例

```json
{
  "team_id": 7557100,
  "timezone": "Asia/Shanghai",
  "season": "2026-27",
  "managers": [
    { "name": "Fran",  "start_gw": 3,  "end_gw": 6,  "avatar": "Fran.png" },
    { "name": "Anna",  "start_gw": 7,  "end_gw": 10, "avatar": "Anna.png" },
    { "name": "Ben",   "start_gw": 11, "end_gw": 14, "avatar": "Ben.png" },
    { "name": "Carol", "start_gw": 15, "end_gw": 18, "avatar": "Carol.png" },
    { "name": "David", "start_gw": 19, "end_gw": 22, "avatar": "David.png" },
    { "name": "Emma",  "start_gw": 23, "end_gw": 26, "avatar": "Emma.png" },
    { "name": "Frank", "start_gw": 27, "end_gw": 30, "avatar": "Frank.png" },
    { "name": "Grace", "start_gw": 31, "end_gw": 34, "avatar": "Grace.png" },
    { "name": "Henry", "start_gw": 35, "end_gw": 38, "avatar": "Henry.png" }
  ],
  "crawl": {
    "request_delay_seconds": 0.4,
    "max_retries": 3,
    "request_timeout_seconds": 10,
    "seal_after_hours": 48,
    "user_agent": "Mozilla/5.0 (compatible; FPLChainTracker/1.0)"
  }
}
```

（managers 中 9 人为占位示例，正式上线前按真实名单填写；每人一段连续区间。）

### 6.3 字段表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `team_id` | int | 是 | FPL 账号 ID（7557100） |
| `timezone` | string | 是 | IANA 时区名，默认 `Asia/Shanghai`，用于 deadline 展示转换 |
| `season` | string | 否 | 赛季标识（如 `2026-27`）；缺省时由 bootstrap 自动判定 |
| `managers[]` | array | 是 | 接龙玩家列表（9 人） |
| `managers[].name` | string | 是 | 玩家显示名；**必须与头像文件名一致**（见 6.4） |
| `managers[].start_gw` | int | 是 | 接管起始 GW |
| `managers[].end_gw` | int | 是 | 接管结束 GW（含） |
| `managers[].avatar` | string | 否 | 头像**文件名**（如 `Fran.png`）；缺省自动推导为 `{name}.png`（见 6.4） |
| `crawl` | object | 否 | 采集行为参数（见 6.5），缺省使用内置默认值 |

### 6.4 头像（avatar）路径规范

- **存放位置**：`assets/avatar/`（随仓库发布到 GitHub Pages，公开可访问）
- **命名规则**：文件名任意（支持 png/jpg/jpeg/webp/gif），在 config 的 `avatar` 字段中指定
  - 例：玩家 `欧巡` → `assets/avatar/ocean.jpg`（avatar 值为 `ocean.jpg`）
  - 缺省时自动推导为 `{name}.png`
- **config 冗余字段**：`avatar` 字段可选，值为文件名。校验规则：
  - 缺省时自动推导为 `{name}.png`
  - 若填写，必须为图片文件名（含图片扩展名），否则启动自检失败
  - 不强制文件名与玩家 name 一致（微信头像导出文件名各异）
- **前端读取**：crawler 将每个玩家的头像**归一化为完整相对路径**（`assets/avatar/Fran.png`）写入 `data/meta.json` 与 `data/summary.json`（见 8.1/8.2）。前端使用相对路径拼接，不依赖站点根域名，兼容 `user.github.io/repo/` 子路径部署
- **兜底**：`assets/avatar/default.png` 为默认头像；玩家 avatar 为 null 或文件加载失败（404）时前端显示默认头像
- **双重校验**：crawler 启动自检 + `scripts/check_config.py` 均校验"config 中每位玩家的头像文件必须存在"
- **微信头像说明**：图片由人工导出为 PNG 放入该目录（微信导出的 HEIC/WebP 需转码为 PNG；建议统一 128×128 以上、正方形）

### 6.5 crawl 参数默认值

| 参数 | 默认值 | 说明 |
|---|---|---|
| `request_delay_seconds` | 0.4 | 请求间隔，防限流 |
| `max_retries` | 3 | 单请求最大重试次数 |
| `request_timeout_seconds` | 10 | 单请求超时 |
| `seal_after_hours` | 48 | GW 结算完成后多少小时冻结数据（见 9.4） |
| `user_agent` | — | 自定义 UA；缺省用 5.3 推荐的自动生成值 |

### 6.6 启动自检规则（config.py）

1. `team_id` 为整数
2. `managers` 非空
3. 玩家 name 不重复
4. 每个玩家 `1 ≤ start_gw ≤ end_gw ≤ 38`
5. 接管区间两两不重叠（可相邻：上一人 end_gw + 1 = 下一人 start_gw）
6. 每个玩家的头像文件存在于 `assets/avatar/`（文件名任意，须为图片扩展名）
7. `timezone` 为合法 IANA 时区名
8. 任一规则失败 → 打印明确错误并退出，不启动采集

---

## 7. 数据模型设计

### 7.1 概念模型

```
Account (7557100)
   │ 1
   ▼
Season (2026-27)
   │ 1 : n
   ▼
Gameweek (1..38) ────── 归属判定 ────── Manager (name, start_gw, end_gw)
   │                                 （GW 编号落在哪个接管区间即归哪位玩家）
   ├── Summary   (score, total_points, overall_rank, gw_rank)
   ├── Lineup    (starters[11] + subs[4]，含队长/副队长)
   ├── Transfers (in / out / cost / time)  0..n
   └── Chips     (0..1 个/轮：wildcard / free_hit / bench_boost / triple_captain)
```

**关系说明**：

- Gameweek 与 Manager 通过 config 中的区间 `[start_gw, end_gw]` 归属：GW 编号落在哪个区间即归哪位玩家
- 未覆盖区间（如接龙开始前的 GW1-GW2）的 GW `manager = null`，前端显示"未参与接龙"
- 同一位玩家若分多段接管（扩展场景），在 config 中登记多条同 name 记录；统计按 name 聚合（见 11.4）

### 7.2 实体字段

| 实体 | 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| Summary | gw | int | 是 | GW 编号 |
| Summary | manager | string/null | 是 | 归属玩家名，无则 null |
| Summary | score | int | 是 | 本轮得分（live GW 为实时分；未开始为 null） |
| Summary | total_points | int | 是 | 累计总积分 |
| Summary | overall_rank | int/null | 是 | Overall Rank；缺失（如弃赛轮）为 null |
| Summary | gw_rank | int/null | 是 | 本轮世界排名（history.rank） |
| Summary | status | enum | 是 | upcoming / live / finished / sealed（见 9.1） |
| Summary | chips | array | 是 | 本轮使用芯片 canonical 名数组，无则 [] |
| Summary | transfers_count | int | 是 | 本轮转会笔数 |
| Summary | transfers_cost | number | 是 | 本轮转会扣分（负数），无则 0 |
| Lineup | starters | array[11] | 条件 | 首发；GW 未开始时为 null |
| Lineup | subs | array[4] | 条件 | 替补；GW 未开始时为 null |
| PlayerEntry | element | int | 是 | 球员 FPL ID |
| PlayerEntry | name | string | 是 | 球员 web_name（快照） |
| PlayerEntry | team | string | 是 | 球队三字母代码（如 LIV，快照） |
| PlayerEntry | position_type | enum | 是 | GKP / DEF / MID / FWD |
| PlayerEntry | is_captain | bool | 是 | 是否队长 |
| PlayerEntry | is_vice_captain | bool | 是 | 是否副队长 |
| PlayerEntry | multiplier | int | 是 | 得分倍率（队长=2，替补=0/1） |
| PlayerEntry | is_substitute | bool | 是 | 是否替补席 |
| Transfer | element_in | int | 是 | 转入球员 ID |
| Transfer | element_in_name | string | 是 | 转入球员名（快照） |
| Transfer | element_out | int | 是 | 转出球员 ID |
| Transfer | element_out_name | string | 是 | 转出球员名（快照） |
| Transfer | cost | number | 是 | 转会扣分（负浮点数） |
| Transfer | time_utc | string | 是 | 转会发生时间（UTC ISO） |

### 7.3 空值语义（重要约定）

| 值 | 语义 | 前端处理 |
|---|---|---|
| `null` | 数据**不存在 / 尚未产生 / 抓取失败** | 显示占位（"—"或"暂无"） |
| `[]` | 数据已确认**为空**（如该轮无转会、无芯片） | 显示空态提示 |
| `manager: null` | 该 GW 无接龙玩家归属（接龙前/间隙） | 显示"未参与接龙" |
| 文件缺失（gw-N.json 404） | 该 GW 尚无详情 | 折叠态正常展示，展开提示"暂无数据" |

### 7.4 文件切分策略与理由

| 文件 | 内容 | 切分理由 |
|---|---|---|
| meta.json | 赛季/当前 GW/deadline/玩家名单/版本号 | 头部常驻数据，体积小，每次加载 |
| summary.json | 全部 GW 概要 | 时间线默认一次加载即可渲染全部 38 轮折叠态 |
| gw-N.json | 单轮详情 | **懒加载**：展开时才请求；单轮修改只重写单文件（增量友好）；浏览器可缓存 |
| stats.json | 玩家统计 | 独立于时间线，便于单独缓存与后续扩展图表 |

### 7.5 球员得分边界（明确说明）

picks 接口**不返回**球员本轮得分（仅 live 接口提供）。因此本期 schema 中阵容不包含球员得分。后续如需展示单轮球员得分明细，扩展方案见 15.2。

---

## 8. JSON Schema 设计

> 说明：以下 JSON 为结构示例。`schema/` 目录提供对应 JSON Schema 定义文件；`validate.py` 实现结构断言校验（Python 标准库自带 json 模块，不引入第三方依赖）。

### 8.1 meta.json

**职责**：站点头部元数据。前端首屏加载，用于渲染标题、当前 GW、Deadline Countdown、玩家名单。

```json
{
  "season": "2026-27",
  "team": {
    "id": 7557100,
    "name": "FPL Chain Team",
    "player_first_name": "Fan",
    "player_last_name": "Chain",
    "started_event": 1,
    "current_event": 5
  },
  "current_gw": { "id": 5, "status": "live" },
  "next_deadline": {
    "gw": 6,
    "deadline_utc": "2026-08-28T05:30:00Z",
    "deadline_beijing": "2026-08-28T13:30:00+08:00",
    "deadline_timestamp": 1785360600000
  },
  "events": [
    {
      "id": 5,
      "name": "Gameweek 5",
      "deadline_utc": "2026-08-28T05:30:00Z",
      "deadline_beijing": "2026-08-28T13:30:00+08:00",
      "deadline_timestamp": 1785360600000,
      "finished": false,
      "status": "live"
    }
  ],
  "managers": [
    { "name": "Fran", "start_gw": 3, "end_gw": 6, "avatar": "assets/avatar/Fran.png", "active": true }
  ],
  "data_version": 12,
  "generated_at_utc": "2026-08-25T02:00:00Z",
  "server_timestamp": 1785607200000
}
```

字段表：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `season` | string | 是 | 赛季标识 |
| `team.id` | int | 是 | 账号 ID |
| `team.name` | string | 是 | 队名（entry.name） |
| `team.player_first_name` / `team.player_last_name` | string | 是 | 账号 Owner 姓名（来自 API） |
| `team.started_event` | int | 是 | 账号首个参赛 GW |
| `team.current_event` | int | 是 | API 报告的当前 event |
| `current_gw.id` | int/null | 是 | 判定出的当前 GW（见 9.2）；季前为 null |
| `current_gw.status` | enum | 是 | `pre_season` / `live` / `season_ended` |
| `next_deadline` | object/null | 条件 | 下一轮 deadline；赛季结束后为 null |
| `next_deadline.gw` | int | 是 | 下一轮编号 |
| `next_deadline.deadline_utc` | string | 是 | 原始 UTC ISO 串 |
| `next_deadline.deadline_beijing` | string | 是 | 转换后 `+08:00` ISO 串（见 9.3） |
| `next_deadline.deadline_timestamp` | int | 是 | Unix 毫秒时间戳，countdown 用（见 9.5） |
| `events[]` | array | 是 | 全部 38 轮事件（字段同上，另含 `finished`、`status`） |
| `managers[]` | array | 是 | 接龙玩家名单（来自 config，avatar 为归一化相对路径） |
| `managers[].active` | bool | 是 | 该玩家当前是否处于接管期（start_gw ≤ current ≤ end_gw） |
| `data_version` | int | 是 | 数据版本号，**仅在数据内容变化时 +1**；前端缓存破坏用（见 12.5） |
| `generated_at_utc` | string | 是 | 本次生成时间（UTC ISO） |
| `server_timestamp` | int | 是 | 生成时刻 Unix 毫秒；前端时钟偏移校正用（见 9.5） |

### 8.2 summary.json

**职责**：时间线折叠态数据源，一次加载渲染全部 GW。

```json
{
  "season": "2026-27",
  "data_version": 12,
  "updated_at_utc": "2026-08-25T02:00:00Z",
  "gw_list": [
    {
      "gw": 1,
      "status": "sealed",
      "manager": null,
      "manager_avatar": null,
      "score": 68,
      "total_points": 68,
      "overall_rank": 482301,
      "gw_rank": 310245,
      "chips": [],
      "transfers_count": 0,
      "transfers_cost": 0,
      "has_detail": true
    },
    {
      "gw": 3,
      "status": "sealed",
      "manager": "Fran",
      "manager_avatar": "assets/avatar/Fran.png",
      "score": 92,
      "total_points": 254,
      "overall_rank": 15342,
      "gw_rank": 882,
      "chips": ["wildcard"],
      "transfers_count": 2,
      "transfers_cost": -4,
      "has_detail": true
    },
    {
      "gw": 5,
      "status": "live",
      "manager": "Fran",
      "manager_avatar": "assets/avatar/Fran.png",
      "score": 41,
      "total_points": 410,
      "overall_rank": 12001,
      "gw_rank": 88331,
      "chips": [],
      "transfers_count": 1,
      "transfers_cost": 0,
      "has_detail": true
    }
  ]
}
```

字段表（gw_list 元素）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `gw` | int | 是 | GW 编号 |
| `status` | enum | 是 | upcoming / live / finished / sealed |
| `manager` | string/null | 是 | 归属玩家名；接龙前为 null |
| `manager_avatar` | string/null | 是 | 头像相对路径（冗余存储，避免前端 join） |
| `score` | int/null | 是 | 本轮得分；live 为实时分；未开始时为 null |
| `total_points` | int/null | 是 | 累计总积分；未开始时为 null |
| `overall_rank` | int/null | 是 | Overall Rank；未开始/缺失为 null |
| `gw_rank` | int/null | 是 | 本轮世界排名 |
| `chips` | array/null | 是 | 本轮芯片 canonical 名数组（0..1 个）；未开始时为 null |
| `transfers_count` | int | 是 | 本轮转会笔数；未开始时为 0 |
| `transfers_cost` | number | 是 | 本轮转会扣分；未开始时为 0 |
| `has_detail` | bool | 是 | 是否存在 gw-{n}.json 详情文件（决定展开时是否发起请求） |

### 8.3 gw-{n}.json（每轮详情）

**职责**：单轮完整详情，前端展开时懒加载。文件名为 `gw-{两位零填充}.json`（如 `gw-03.json`），保证字典序即时间序。

```json
{
  "season": "2026-27",
  "gw": 3,
  "status": "sealed",
  "summary": {
    "gw": 3,
    "manager": "Fran",
    "manager_avatar": "assets/avatar/Fran.png",
    "score": 92,
    "total_points": 254,
    "overall_rank": 15342,
    "gw_rank": 882,
    "chips": ["wildcard"],
    "transfers_count": 2,
    "transfers_cost": -4,
    "has_detail": true
  },
  "lineup": {
    "starters": [
      {
        "element": 234,
        "name": "Salah",
        "team": "LIV",
        "position_type": "MID",
        "is_captain": true,
        "is_vice_captain": false,
        "multiplier": 2,
        "is_substitute": false
      }
    ],
    "subs": [
      {
        "element": 456,
        "name": "Watkins",
        "team": "AVL",
        "position_type": "FWD",
        "is_captain": false,
        "is_vice_captain": true,
        "multiplier": 0,
        "is_substitute": true
      }
    ]
  },
  "transfers": [
    {
      "element_in": 234,
      "element_in_name": "Salah",
      "element_out": 98,
      "element_out_name": "Saka",
      "cost": -4,
      "gw": 3,
      "time_utc": "2026-08-20T10:00:00Z"
    }
  ],
  "chips": ["wildcard"]
}
```

字段表：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `season` | string | 是 | 赛季标识 |
| `gw` | int | 是 | GW 编号 |
| `status` | enum | 是 | 见 9.1 |
| `summary` | object | 是 | 冗余保存该轮概要（文件自包含，独立请求时无需再拉 summary.json） |
| `lineup` | object/null | 条件 | GW 未开始/无数据时为 null；否则为阵容对象 |
| `lineup.starters` | array[11] | 条件 | 首发 11 人 |
| `lineup.subs` | array[4] | 条件 | 替补 4 人 |
| `transfers` | array/null | 条件 | 本轮转会；**确认无转会时为 []**；数据缺失时为 null |
| `chips` | array/null | 条件 | 本轮芯片；**确认未使用时为 []**；数据缺失时为 null |

### 8.4 stats.json

**职责**：玩家接龙统计 + 赛季汇总。

```json
{
  "season": "2026-27",
  "data_version": 12,
  "updated_at_utc": "2026-08-25T02:00:00Z",
  "managers": [
    {
      "name": "Fran",
      "start_gw": 3,
      "end_gw": 6,
      "gw_count": 4,
      "completed": true,
      "live": false,
      "avg_rank": 14986.5,
      "best_rank": 13902,
      "avg_score": 87.5,
      "best_score": 102,
      "worst_score": 71,
      "total_score": 350,
      "rank_change": -1240,
      "chips_used": ["wildcard"],
      "total_transfers": 6,
      "total_transfers_cost": -12
    }
  ],
  "season_totals": {
    "total_points": 254,
    "best_rank": 13902,
    "current_rank": 15342,
    "gw_played": 4,
    "total_transfers": 6,
    "total_transfers_cost": -12
  }
}
```

字段表（managers 元素）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 玩家名 |
| `start_gw` / `end_gw` | int | 是 | 接管区间 |
| `gw_count` | int | 是 | 已有数据的 GW 数 |
| `completed` | bool | 是 | 区间内全部 GW 是否已 sealed（统计是否为终态） |
| `live` | bool | 是 | 区间内是否存在 live/finished（未封印）GW，统计含实时数据 |
| `avg_rank` | number | 是 | 接管期间平均 Overall Rank（公式见 11.2） |
| `best_rank` | int | 是 | 接管期间最好（最小）OR |
| `avg_score` | number | 是 | 平均本轮得分 |
| `best_score` | int | 是 | 最高单轮得分 |
| `worst_score` | int | 是 | 最低单轮得分 |
| `total_score` | int | 是 | 接管期间累计得分 |
| `rank_change` | int | 是 | 接管期间排名变化（负=上升，公式见 11.2） |
| `chips_used` | array | 是 | 接管期间使用的全部芯片 |
| `total_transfers` | int | 是 | 接管期间转会总笔数 |
| `total_transfers_cost` | number | 是 | 接管期间转会总扣分 |

### 8.5 通用规则

- 所有文件根级含 `season`、`data_version`、`updated_at_utc`（meta.json 为 `generated_at_utc`）
- 未知字段容忍：前端对未知字段不做断言，保证向后兼容
- 数值类型统一：积分/排名为 int，扣分为 number（可能为负浮点）
- 时间格式统一：UTC 一律 ISO 8601 带 `Z` 后缀；北京时间一律 ISO 8601 带 `+08:00` 偏移

---

## 9. Gameweek Deadline 管理设计

### 9.1 GW 状态机

```
             deadline 已过              finished = true            超过封印宽限期
upcoming ───────────────────► live ────────────────────► finished ───────────────► sealed
（未开始）                    （进行中/实时）              （已结算）               （已冻结，不再抓取）

全局状态：
  pre_season    ：GW1 deadline 未过，赛季未开始
  season_ended  ：最后一轮已 sealed，赛季结束
```

| 状态 | 判定条件 | 数据行为 |
|---|---|---|
| `upcoming` | `deadline_time > now` | 不抓取 picks；summary 积分字段为 null |
| `live` | `deadline_time ≤ now` 且 `finished == false` | 抓取 picks；数据实时变动，每次运行覆盖 |
| `finished` | `finished == true` 且距 deadline 未超过封印宽限期 | 抓取并覆盖；数据可能因补分微调（等待封印） |
| `sealed` | `finished == true` 且超过宽限期（默认 48h）**且详情已抓取成功** | 不再抓取，文件视为终态 |

**封印条件补充**：若某轮 finished 但详情抓取失败，不进入 sealed，留在下次运行的抓取集合中（防止"带着缺失数据被冻结"，见 10.3）。

### 9.2 当前 GW 判定算法

判定顺序（输入：bootstrap-static `events[]` + 当前 UTC 时间）：

1. 对每个 event 计算 `deadline_passed = (deadline_time ≤ now)`（统一转 UTC 比较，避免时区歧义）
2. `current_gw = deadline_passed 为 true 的编号最大的 event`（即最近一个 deadline 已过的 GW）
3. 若没有任何 event 的 deadline 已过 → 全局状态 `pre_season`，`current_gw = null`
4. 若最后一轮（GW38）已 sealed → 全局状态 `season_ended`，`next_deadline = null`
5. `next_deadline = current_gw 的下一个 event`（若存在）
6. 每轮状态由 9.1 状态机独立判定（不依赖全局状态）

> 交叉校验：bootstrap 的 events 若含 `is_current` / `is_next` 字段，可与判定结果比对；不一致时以本算法结果为准并记录 warning 日志。

### 9.3 时间转换规范

- **来源**：FPL API 全部返回 UTC（ISO 8601，`Z` 后缀），如 `2026-08-21T05:30:00Z`
- **存储**（三份并存，避免前端重复换算、保证可展示）：

| 字段 | 格式 | 示例 |
|---|---|---|
| `deadline_utc` | 原始 ISO（`Z` 后缀） | `2026-08-21T05:30:00Z` |
| `deadline_beijing` | ISO 8601 带 `+08:00` 偏移 | `2026-08-21T13:30:00+08:00` |
| `deadline_timestamp` | Unix 毫秒 | `1784602200000` |

- **实现**：Python `zoneinfo`（标准库，3.9+）按 `config.timezone` 转换；北京时间 = UTC+8（无夏令时，转换恒定）
- **展示**：前端展示格式（如 `2026-08-21 13:30:00`）由前端自行格式化，后端只保证三份结构化数据正确

### 9.4 封印宽限期（seal_after_hours）

FPL 在 GW 结算后存在补分窗口（bonus 调整等），`finished` 翻绿后数据仍可能微调。因此：

- 默认 `seal_after_hours = 48`（config.crawl 可调）
- 宽限期内状态为 `finished`，每次运行仍抓取覆盖（确保拿到最终修正值）
- 超过宽限期 → `sealed`，永久冻结（不再请求该 GW，节省请求量、保证历史稳定）

### 9.5 Deadline Countdown 推荐方案（结论：后端存 timestamp，前端实时计算）

| 方案 | 结论 | 理由 |
|---|---|---|
| 后端保存计算好的"剩余秒数" | ❌ 不采用 | 静态 JSON 无法保鲜，发布后即过期；Actions 调度粒度太粗 |
| 后端保存 `deadline_timestamp` + 前端实时计算 | ✅ **采用** | JSON 中的绝对时间戳永远有效；前端每秒 tick 本地计算，实现"实时倒计时" |
| 前端直接用本地时钟 | ⚠️ 需校正 | 用户设备时钟可能偏差，倒计时会不准 |

**最终设计**：

1. meta.json 保存 `next_deadline.deadline_timestamp`（目标时刻）与 `server_timestamp`（生成时刻）
2. 前端加载 meta.json 时记录 `received_at = Date.now()`，计算 `clock_offset = server_timestamp - received_at`
3. 任意时刻 `remaining_ms = next_deadline.deadline_timestamp - (Date.now() + clock_offset)`
4. 倒计时 UI 每秒刷新；`remaining_ms ≤ 0` 时提示并重新拉取 meta.json（此时 Actions 可能已更新 next_deadline）
5. 展示粒度：剩余 > 24h 显示到小时，< 24h 显示到秒（由前端决定）

---

## 10. 数据更新策略

### 10.1 运行流程

```
 1 加载 config.json（自检失败则中止）
 2 抓取 bootstrap-static
 3 抓取 entry/{id}（队名 / started_event / current_event）
 4 根据 events 判定当前 GW 与各轮状态（第 9 章）
 5 抓取 history（全部轮次概要 + 赛季 chips）
 6 抓取 transfers（全赛季，按 event 归组）
 7 抓取 picks（增量集合，见 10.3）
 8 用 bootstrap 映射丰富球员名/球队/位置（见 5.5 快照原则）
 9 stats.py 计算玩家统计
10 写临时文件 → 校验（validate.py）→ 通过后原子替换 data/ 正式文件
11 若 data/ 相对上次有变化 → git commit + push；否则静默退出
```

### 10.2 已结束 / 未结束 GW 的处理

| GW 状态 | 抓取 | 覆盖写 | 说明 |
|---|---|---|---|
| upcoming | 不抓取 | — | 无数据，summary 中积分字段为 null |
| live | 抓取 | 每次覆盖 | 实时分、实时阵容（含自动换人） |
| finished | 抓取 | 每次覆盖 | 等待补分窗口结束 |
| sealed | **不抓取** | 不写 | 终态，节省请求量 |

### 10.3 增量更新与请求量控制

**抓取集合定义**（每次运行实际请求 picks 的轮次）：

```
需要抓取的 GW = { 所有状态 ∈ {live, finished} 的 GW } ∪ { 上次运行抓取失败的 GW }
```

- 正常运行情况下该集合只有 **1-2 个 GW**（当前轮 + 上一轮若在宽限期内）
- 首次运行 / `--full` 回填时：全量抓取 `started_event .. 当前 GW` 的全部轮次
- **请求量预算**：单次运行 picks 请求数 ≤ 40，超过即视为异常，中止并标记失败（防异常循环打爆 API）

**重复请求防护**：

- 幂等：同一输入产生同一输出；git diff 为空则不提交
- 封印机制：sealed GW 永不再请求（见 9.4）
- 并发防护：GitHub Actions 配置 `concurrency`，同一 workflow 只允许一个运行实例（见 13.4）

**断跑恢复（missed runs）**：若 Actions 连续失败多天，恢复后的首次运行因"未封印 GW 集合"自动覆盖所有应抓未抓的轮次（状态机保证），无需人工干预。

### 10.4 全量回填（backfill）

- 场景：首次部署、历史数据重建、schema 大版本升级
- 方式：`crawler/run.py --full`（或 scripts/backfill.py）
- 行为：无视封印，重抓 `started_event .. 当前 GW` 全部轮次并整体重写 data/（全程遵守限速与重试）
- 注意：回填后 GW 数据可能因球员快照差异与旧文件不同（见 5.5），属预期行为

### 10.5 更新频率

| 触发 | 频率 | 说明 |
|---|---|---|
| GitHub Actions 定时 | 每 30 分钟一次（`*/30 * * * *` UTC） | 比赛日 live 分数最快 30 分钟刷新 |
| workflow_dispatch | 手动 | 临时触发，如接龙交接时刻 |

> 说明：每 30 分钟一次由项目方确认。注意 FPL API 对高频轮询可能限流（429），crawler 已按 Retry-After 处理；若被限流可降低频率（改 cron 表达式即可）。GitHub Actions cron 允许一定延迟。数据生成由 Actions 在服务端完成（`git add -f data/` 强制提交），本地 `data/` 在 .gitignore 中，本地只提交代码逻辑，避免本地/服务端数据提交冲突。

---

## 11. 玩家接龙统计设计

### 11.1 数据来源

统计**完全由 summary 数据计算**（stats.py 每次运行重算），不单独采集。输入：`summary.json` 的 gw_list + config 的 managers 区间。

### 11.2 计算公式

对每位玩家，取其区间 `[start_gw, end_gw]` 内**所有已有 summary 数据**的 GW 集合 S：

| 指标 | 字段 | 公式 |
|---|---|---|
| 接管轮数 | `gw_count` | \|S\| |
| 平均 OR | `avg_rank` | mean(S.overall_rank)（仅统计 overall_rank 非 null 的轮次） |
| 最好 OR | `best_rank` | min(S.overall_rank)（数值最小 = 排名最高） |
| 平均得分 | `avg_score` | mean(S.score) |
| 最高得分 | `best_score` | max(S.score) |
| 最低得分 | `worst_score` | min(S.score) |
| 累计得分 | `total_score` | sum(S.score) |
| 排名变化 | `rank_change` | overall_rank(end_gw) − overall_rank(start_gw − 1)；负值 = 排名上升；无前一轮数据（start_gw = 1）时为 null |
| 芯片使用 | `chips_used` | S 中全部非空 chips 合并去重 |
| 转会 | `total_transfers` / `total_transfers_cost` | sum(S.transfers_count) / sum(S.transfers_cost) |

### 11.3 状态边界

| 场景 | 处理 |
|---|---|
| 区间内存在 live/finished GW | 照常计入统计，`live: true` 标记；前端显示"含进行中数据" |
| 区间全部 sealed | `completed: true`，统计为终态 |
| 玩家尚未开始接管 | `gw_count = 0`，各统计字段为 null（前端显示"未接管"） |
| GW 无 manager（接龙前） | 不进任何玩家统计，计入 season_totals |
| overall_rank 为 null（如弃赛轮） | 该轮不参与 avg_rank/best_rank；`gw_count` 仍计入（按得分统计） |

### 11.4 多段接管（扩展说明）

同一玩家多段接管时，config 中登记多条同名记录；stats.py 按 `name` 聚合所有区间的统计（`start_gw` 取最小、`end_gw` 取最大展示）。本期 9 人单段接管不涉及，此规则仅保证扩展不破坏数据结构。

### 11.5 season_totals

独立于玩家维度的赛季汇总：总积分、历史最好 OR、当前 OR、已赛轮数、总转会/总扣分。用于页面顶部概况卡片。

---

## 12. Frontend Data Contract

> 本章定义前端与数据文件的契约，前端实现时以本章为唯一依据。前端语言与框架不限（推荐原生 JS，零构建）。

### 12.1 文件清单与加载时机

| 文件 | 加载时机 | 用途 |
|---|---|---|
| `data/meta.json` | 首屏，与 summary 并行 | 标题/当前 GW/倒计时/玩家名单 |
| `data/summary.json` | 首屏，与 meta 并行 | 渲染完整 GW Timeline 折叠态 |
| `data/gw-{nn}.json` | 展开某轮时（懒加载，每轮仅一次） | 渲染该轮详情（阵容/转会/芯片） |
| `data/stats.json` | 首屏或按需 | 玩家统计卡片、赛季概况 |

所有请求使用**相对路径**（兼容 `user.github.io/repo/` 子路径部署）。

### 12.2 折叠态 → 展开态 渲染映射

**折叠态（summary 数据）**：

| UI 元素 | 字段 |
|---|---|
| GW 编号 | `gw` |
| 玩家头像 | `manager_avatar`（null → default.png） |
| 玩家名字 | `manager`（null → "未参与接龙"） |
| 本轮分数 | `score`（null → "—"） |
| 总积分 | `total_points` |
| OR 排名 | `overall_rank`（null → "—"） |
| 芯片图标（可选） | `chips` 非空时显示对应图标 |
| 状态徽标 | `status`：live → "进行中"，upcoming → "未开始" |

**展开态（gw-{nn}.json）**：

| 区块 | 数据 | 渲染 |
|---|---|---|
| 阵容 | `lineup.starters`（11）+ `lineup.subs`（4） | 按 GKP/DEF/MID/FWD 分组或按位次排列；队长显示 (C)、副队长显示 (V) 标记；替补区弱化显示 |
| 转会 | `transfers` | `[]` → "本轮无转会"；null → "暂无数据"；每条显示：转出 → 转入 + 扣分 |
| 芯片 | `chips` | `[]` → "未使用芯片"；非空 → 芯片名称 + 图标 |
| 概要块 | `summary` | 复用折叠态字段，展开区顶部重复展示（文件自包含） |

**数据缺失处理**：`has_detail = false` 或 gw-N.json 请求 404 → 展开区显示"暂无数据"；所有 null 字段按 7.3 语义渲染，不抛错。

### 12.3 玩家统计区块

读取 `stats.json`，每位玩家渲染一张卡片：头像、名字、接管区间（GW3-GW6）、核心指标（avg_rank / best_rank / avg_score / best_score / worst_score）、`completed` / `live` 状态提示。

### 12.4 Countdown 前端逻辑

见 9.5：读取 `meta.json.next_deadline.deadline_timestamp` 与 `server_timestamp` 计算时钟偏移，每秒刷新。倒计时归零 → 重新拉取 meta.json。

### 12.5 缓存策略

- 所有 data 请求携带 `?v={data_version}`（来自 meta.json）
- `data_version` 仅在**数据内容变化**时 +1（crawler 每次运行比对新旧输出，变化才递增并提交）
- meta.json 每次运行都会更新（generated_at_utc 变化），因此 meta 单独使用 `?t={server_timestamp}` 或 `cache: no-store` 不做缓存
- 效果：summary / gw-* / stats 命中浏览器缓存；meta 永远新鲜

### 12.6 头像解析

- 路径来自 `manager_avatar` / `managers[].avatar`（相对路径 `assets/avatar/X.png`）
- 加载失败（404）→ 替换为 `assets/avatar/default.png`
- 建议前端预加载首屏可见头像

### 12.7 错误状态约定

| 场景 | 前端表现 |
|---|---|
| meta/summary 加载失败 | 整页错误提示 + 重试按钮 |
| gw-N.json 404 | 展开区显示"暂无数据" |
| stats 缺失 | 统计区隐藏 |
| JSON 解析失败 | 控制台告警 + 对应区块降级（不影响其他区块） |

---

## 13. GitHub Actions 部署方案

> 本章为方案设计（不含 YAML 实现）。实施时按此规格编写 `.github/workflows/update-data.yml`。

### 13.1 触发方式

| 触发 | 表达式/方式 | 说明 |
|---|---|---|
| 定时 | `cron: */30 * * * *`（UTC） | 每 30 分钟一次；Actions cron 按 UTC 计算 |
| 手动 | `workflow_dispatch` | 接龙交接、数据修复后手动触发 |
| 代码变更 | `push` 至 main（可选） | 数据更新逻辑改动时自动验证 |

### 13.2 工作流步骤（一次运行）

```
 1 checkout 仓库（含 data/ 历史与 config.json）
 2 安装 Python 3.11（纯标准库，无需 pip install）
 3 运行采集：python crawler/run.py --config config.json
   （内部：抓取 → 丰富 → 统计 → 校验；任一步失败退出码非 0，直接标记运行失败）
 4 git diff 检测 data/ 变更
 5 有变更 → git commit（作者设为 bot 身份）→ git push 回 main
 6 无变更 → 退出 0（不产生空提交）
```

### 13.3 权限与安全

- 使用内置 `GITHUB_TOKEN`，授予 `contents: write`（推送 data 变更）
- 提交者身份：`FPLChainTracker Bot <bot@users.noreply.github.com>`（可配置）
- **无任何密钥/密文**：本系统不访问私有资源，config.json 不含敏感信息

### 13.4 稳定性配置

| 配置 | 值 | 理由 |
|---|---|---|
| `concurrency` | 按 workflow 分组 | 防止调度重叠（上一轮未跑完、新一轮启动） |
| `timeout-minutes` | 30 | 单次运行最多 30 分钟（正常 < 5 分钟） |
| 运行日志 | 关键步骤打印结构化摘要 | 失败排查 |

### 13.5 GitHub Pages 发布

- Pages 来源：`Deploy from a branch` → 分支 `main`，目录 `/`（仓库根）
- 仓库根放 `.nojekyll` 空文件：禁用 Jekyll 处理，保证 `data/*.json` 与 `assets/` 按原样发布
- 每次 push 到 main，GitHub 自动发布新版本（无需单独 deploy job）
- 站点 URL：`https://{owner}.github.io/{repo}/`（项目页为子路径，故前端必须用相对路径，见 12.1）
- 可选：绑定自定义域名（CNAME 文件放仓库根）

---

## 14. 错误处理方案

### 14.1 错误分层

| 层 | 错误类型 | 处理策略 |
|---|---|---|
| 网络层 | 超时 / 5xx / 403 / 连接失败 | 重试 3 次（5s/10s/20s 退避）；最终失败 → 本次运行失败 |
| 限流层 | 429 | 读 `Retry-After` 等待重试；连续 3 次 → 本次运行失败并退出 |
| 数据层 | 响应结构异常 / 字段缺失 | 记录 warning，按 7.3 空值语义兜底；JSON 解析失败（结构性损坏）→ 视为该接口失败 |
| 校验层 | 输出与 schema 不符 | **不写正式文件，不提交**，本次运行失败 |
| 配置层 | config 自检失败 | 立即退出（见 6.6） |

### 14.2 数据完整性保证

- **临时文件 + 原子替换**：全部输出先写 `data/.tmp/`，全部成功并校验通过后一次性 move；任何一步失败都不触碰旧文件
- **失败不删数据**：抓取失败的 GW 保留旧文件；该 GW 加入下次抓取集合（封印条件含"详情已抓取成功"，见 9.1）
- **校验门槛**：meta/summary 必须全部生成成功（它们是前端首屏数据）；gw 详情允许部分缺失（懒加载容错）

### 14.3 运行状态记录

- 每次运行在 Actions 日志输出：请求数、成功/失败接口、更新了哪些文件、数据版本号
- `meta.json` 记录 `generated_at_utc`，前端/人工可判断数据新鲜度
- 连续失败告警（可选扩展）：失败时自动创建 GitHub Issue（见 15.4）

### 14.4 已知边界情况

| 情况 | 处理 |
|---|---|
| 季前（无 GW 开始） | meta 输出 pre_season；不抓 picks；页面显示"赛季未开始" |
| 账号无转会 | transfers 接口返回空数组 → gw 详情 `transfers: []` |
| GW 进行中发生自动换人 | picks 实时返回换人后阵容，如实存储（live 状态） |
| 双赛周/空赛周 | 不影响设计：每轮独立存文件，事件表如实反映 |
| FPL API 宕机 | 本次失败，下次运行自动补齐；数据缺口由增量集合自动覆盖 |
| 弃赛轮（无 OR） | overall_rank = null，统计跳过该轮（见 11.3） |

---

## 15. 后续扩展方案

> 按优先级排列；所有扩展均遵循"只增不改"原则，不改变既有 JSON 字段结构，保证向后兼容。

### 15.1 多赛季支持（P1）

- config 增加 `season` 字段（已预留，见 6.3）
- data 目录演进为 `data/seasons/{season}/`，旧结构平滑迁移；meta.json 增加赛季列表，前端增加赛季切换
- schema 根级 `season` 字段（已预留，见 8.5）

### 15.2 单轮球员得分明细（P1）

- 引入 `https://fantasy.premierleague.com/api/event/{gw}/live/` 接口，获取 live GW 的球员实时分
- gw-N.json 的 lineup 元素增加 `points` 字段（可选，缺失为 null，前端兼容）
- 收益：阵容卡可显示每人得分，"谁贡献了大分"一目了然

### 15.3 图表化（P2）

- 前端基于 summary.json 直接绘制：OR 走势折线、每轮得分柱状图、玩家接管区间分段着色
- 无需新增数据结构；stats.json 可扩展 `rank_trend`（接管期间每轮 OR 快照数组）

### 15.4 失败通知（P2）

- Actions 失败时自动创建 GitHub Issue（模板 + 失败日志摘要），替代人工巡检日志

### 15.5 联赛/迷你联赛（P2）

- 抓取 `entry/{id}/` 中 leagues 数据与 `league/{id}/standings`，新增"对手榜"页面

### 15.6 多账号支持（P3）

- config 的 `team_id` 演进为 `teams: []`，data 目录按账号拆分；前端支持切换

### 15.7 数据压缩与合并导出（P3）

- 提供单文件全量导出（`data/full.json`）便于下载/离线存档；大文件考虑 gzip（GitHub Pages 支持）

### 15.8 API 友好性（持续）

- 引入 If-Modified-Since / ETag 缓存（bootstrap-static 支持），进一步降低请求频率

---

## 16. 实时数据层（增量补充）

> 版本：v1.1 ｜ 日期：2026-09-16 ｜ 状态：已实现
> 本章是 design.md 的增量：不改动第 1-15 章的任何既有约定，只新增一条「在线」数据通道。
> 动机：静态托管下，数据新鲜度受限于 Actions 调度粒度；而 §10.2 的「只有 live GW 才需要抓取」这一口径，
> 天然适合做成「按需实时读取」。

### 16.1 硬约束：官方 API 不支持浏览器直连

实测 `GET https://fantasy.premierleague.com/api/entry/{id}/` 与 `/bootstrap-static/`：

| 观测项 | 结果 |
|---|---|
| 响应头 `Access-Control-Allow-Origin` | **不存在** |
| 响应头 `Vary` | `X-API-Language, Accept-Encoding`（不含 `Origin`，非条件性 CORS） |
| 响应头 `Cache-Control` | `max-age=0, no-cache, no-store, must-revalidate` |

结论：**浏览器无法直接读取 FPL 官方 API**。任何「前端自行刷新」的方案都必须经由服务端代理，
因此本层引入了唯一一个服务端组件（Vercel 无服务器函数）。

### 16.2 架构

```
浏览器 ──► GET /api/fpl-live?file=<name> ──► api/fpl-live.js
                                                 │ 读 data/*.json（已冻结历史基线）
                                                 │ 代抓 FPL 官方 API（服务端，无 CORS 限制）
                                                 ▼
                                            lib/fpl-core.js
                                      状态机 / 丰富 / 接龙统计 / 赛事积分
浏览器 ◄──── 与 data/*.json 同构的 JSON ◄────────┘
```

- `lib/fpl-core.js`：零依赖 Node 模块，是 `crawler/*.py` 的**同源 JS 实现**（判定与计算口径一致）
- `api/fpl-live.js`：纯 Node 请求处理器，只用内置模块，便于本地直接起 http server 验证
- 静态托管不可用（GitHub Pages）时，前端回落 `data/*.json`，功能不降级，仅新鲜度降低

**与既有原则的关系**：本层不改变「数据文件即数据库」——它输出的仍是同一套 JSON 契约（§8），
只是其中「未冻结部分」改为按需重算。已冻结（`sealed`）的轮次一律以仓库中的 `data/` 为权威，不重算。

### 16.3 接口契约

| 项 | 约定 |
|---|---|
| 路径 | `/api/fpl-live` |
| 参数 | `file`（`meta.json` / `summary.json` / `stats.json` / `gw-NN.json`，缺省 `meta.json`）；`refresh=1` 绕开函数内缓存（调试用） |
| 方法 | `GET` / `HEAD` / `OPTIONS`（其余 405） |
| 响应体 | 与 `data/<name>` **完全同构** |
| 响应头 | `X-FPL-Source`（`live` / `base` / `base-fallback`）、`X-FPL-Phase`、`X-FPL-Refreshed`、`X-FPL-Data-Version`、`X-FPL-Generated-At`、`Access-Control-Allow-Origin: *` |
| 错误 | 非法 `file` → 400；无该文件且无基线 → 404（附失败原因） |

请求集合（§10.3 的增量版）：只抓 `live` / `finished` 的轮次，以及「刚由 live/finished 转为 sealed」需补抓最终阵容的轮次；
`idle` 阶段只请求 `bootstrap-static` / `entry` / `history` / `transfers` 四个基础接口，**不抓 picks**。

### 16.4 缓存策略

判定集中在 `determinePhase(statuses)`：

| 阶段 | 判定条件 | 函数侧缓存 | 前端轮询 | 上游抓取 |
|---|---|---|---|---|
| `live` | 存在 `deadline ≤ now` 且 `finished == false` 的 GW | 30s | 60s | 抓 picks + live |
| `settling` | 最近的 GW `finished`，未进入 `sealed`（封印窗口内） | 120s | 300s | 抓 picks + live |
| `idle` | 季前（无 GW 开始）／上一 GW 已 `sealed` 且下一 GW `upcoming`／赛季结束 | 1800s | 不轮询 | 仅 4 个基础接口 |

即：**只有存在「正在进行中的 GW」时才必须放弃缓存**；GW 未开始、或上一 GW 已结束的阶段可直接使用缓存（§10.2 的同一口径）。
`settling` 之所以保留低频刷新，是因为 §9.4 的补分窗口（bonus 调整）会让已结算分数继续微调。

前端额外约束：每轮只轮询 `summary.json`，用关键字段指纹决定是否重绘；后台标签页不抓取，`visibilitychange` 回前台立即补一次。

### 16.5 与 Python 实现的一致性是硬要求

两套实现（Python / JS）必须给出相同结果，否则「线上实时」与「仓库快照」会互相矛盾。
一致性由 `npm run verify` 的差分校验保证：以 `crawler` 的产出为基准，逐字段比对
`summary.json` / `stats.json` / `meta.json`，并要求零差异。

> 注意：GW 从 `finished` 过渡到 `sealed` 后，`sealed_eligible` 条件才成立，
> 需要再跑一次采集让 Python 侧的状态落定，差分校验才有意义（脚本输出里会打印当前阶段与抓取轮次）。

### 16.6 meta.json 新增字段（§8.1 的增量）

| 字段 | 类型 | 说明 |
|---|---|---|
| `timezone` | string | IANA 时区名，实时层做 deadline 换算用 |
| `rules` | object | 赛事积分规则（原仅存在于 `config.json`，§6）；实时层需要它才能独立算分 |
| `seal_after_hours` | number | 封印宽限期，与 `crawl.seal_after_hours` 同值 |

依据 §8.5「只增不改」，前端对未知字段不做断言；`schema/meta.schema.json` 已同步。

### 16.7 部署与回落

- **Vercel**：函数自动挂在 `/api/fpl-live`；`vercel.json` 声明 `includeFiles: data/**` 让函数能读到基线快照
- **GitHub Pages**：`/api/fpl-live` 返回 404，前端据此**永久**回落静态快照（不再重试该接口）
- **上游抖动**：函数返回基线快照并在 `X-FPL-Source` 标注 `base-fallback`；前端视为静态来源，不会白屏
- **首次部署**：仓库必须包含基线 `data/meta.json` + `data/summary.json`，否则实时层无起点（见 README 部署章节）

### 16.8 不改动清单

`crawler/` 的采集与校验逻辑、`index.html` 结构、第 8 章的 JSON 契约、第 9 章状态机、第 10 章更新策略、
第 11 章统计与积分口径、第 12 章前端契约 —— **均无改动**。本层只在既有链路上增加一条可按需调用的数据通道。

---

## 附录 A：开发实施顺序（建议里程碑）

1. **M1 骨架**：目录结构、config.json（含 9 位玩家占位）、头像目录与 default.png、`.nojekyll`
2. **M2 采集闭环**：config.py + api_client.py + timeutil.py → 最小运行（bootstrap + history → meta.json / summary.json），本地手动跑通
3. **M3 详情采集**：picks + transfers + enrich → gw-N.json；`--full` 回填历史
4. **M4 统计**：stats.py + stats.json；check_config.py
5. **M5 校验与原子写**：validate.py、临时文件替换、空提交防护
6. **M6 自动化**：GitHub Actions workflow + Pages 发布配置；观察 2-3 天自动运行
7. **M7 前端**：GW Timeline（折叠/展开）、玩家统计卡片、Deadline Countdown、头像兜底
8. **M8 上线**：真实玩家名单与头像录入、数据核对（与 FPL 官网逐轮比对）、UI 走查

---

文档结束。
