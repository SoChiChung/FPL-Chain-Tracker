# FPL Chain Tracker

Fantasy Premier League 接龙账号历史追踪系统 —— 一个部署在 GitHub Pages 上的静态数据展示站点，完整记录接龙账号（Team ID: `7557100`）从 GW3 起由 9 位玩家轮流接管的全部历史：每轮阵容、转会、芯片、积分与 Overall Rank，并按玩家维度统计接管期间的表现。

## 功能特性

- **自动采集**：GitHub Actions 每 30 分钟调用 FPL 官方公开 API（无需鉴权），自动生成并提交数据
- **实时数据层**：部署在 Vercel 时，`api/fpl-live.js` 在服务端代抓官方 API，页面按 GW 阶段自动刷新当轮比分/阵容/积分；非 Vercel 环境自动回落到静态快照（详见「实时数据层」）
- **完整历史**：每轮阵容（首发 11 + 替补 4 + 队长/副队长）、转会明细、芯片使用、积分与排名
- **接龙统计**：每位玩家接管期间的平均/最佳 OR、平均/最高/最低得分、排名变化等自动计算
- **GW Timeline**：前端折叠/展开两级展示，详情懒加载
- **Deadline Countdown**：基于 Unix 时间戳的前端实时倒计时（北京时间）
- **零依赖**：采集程序仅用 Python 标准库；前端纯静态 HTML/CSS/JS，无构建步骤
- **无数据库**：所有历史数据为 `data/` 下的 JSON 文件，随仓库版本化

## 整体架构

```
FPL API（bootstrap-static / entry / history / transfers / picks / event-live）
    │  HTTPS（无鉴权；注意：响应不含 CORS 头，浏览器不能直连）
    │
    ├─（离线路径）GitHub Actions 定时执行 → crawler/（Python 标准库）
    │      抓取 → 丰富 → 统计 → 校验 → 原子写入
    │      ▼
    │   data/*.json 提交到 main 分支（git add -f）
    │      ▼
    │   静态托管（Vercel / GitHub Pages）→ 前端读取 JSON 渲染 GW Timeline
    │
    └─（在线路径）Vercel 无服务器函数 api/fpl-live.js → lib/fpl-core.js
           服务端代抓官方 API，按 GW 阶段决定是否重算
           ▼
       前端优先请求 /api/fpl-live，失败回落 data/*.json
```

两条路径共用同一套判定与计算口径：`crawler/*.py` 是 Python 版，`lib/fpl-core.js` 是同源 JS 版，
由 `npm run verify` 做逐字段差分校验（见「验证」）。

详细设计见 [design.md](design.md)（数据模型、JSON Schema、GW 状态机、更新策略等）。
实时数据层见 design.md 第 16 章。

## 目录结构

```
├── config.json                  # 唯一配置：账号 + 接龙玩家 + 采集参数 + 积分规则
├── index.html                   # 前端入口页面
├── vercel.json                  # Vercel 部署配置（函数超时 / data 打包 / 静态缓存头）
├── assets/
│   ├── avatar/                  # 玩家头像（文件名 = config 的 avatar 字段）
│   ├── css/                     # 前端样式
│   └── js/app.js                # 前端脚本（含实时数据源与阶段化刷新）
├── api/
│   └── fpl-live.js              # Vercel 无服务器函数：实时数据接口（零依赖）
├── lib/
│   └── fpl-core.js              # 实时数据核心：GW 状态机 / 丰富 / 统计 / 积分（与 crawler 同源）
├── data/                        # 采集产物（GitHub Pages 数据源，由 crawler 生成）
│   ├── meta.json                # 头部元数据：当前 GW / deadline / 玩家名单 / rules
│   ├── summary.json             # 全部 GW 概要（时间线折叠态）
│   ├── gw-01.json … gw-38.json  # 每轮详情（懒加载）
│   └── stats.json               # 玩家接龙统计 + 赛事积分
├── crawler/                     # 采集程序（Python 3.11+，纯标准库）
│   ├── run.py                   # 入口
│   ├── config.py                # 配置加载与自检
│   ├── api_client.py            # FPL API 封装（重试/限速/UA）
│   ├── timeutil.py              # UTC ↔ Asia/Shanghai 转换
│   ├── enrich.py                # 球员映射丰富
│   ├── stats.py                 # 接龙统计 + 赛事积分计算
│   └── validate.py              # 输出结构自校验
├── scripts/                     # 本地开发辅助
│   ├── live-server.js           # 本地预览线上的实时数据行为（静态 + 实时接口同端口）
│   ├── verify-live.js           # 实时数据层验证（差分校验 + 前端逻辑 + 接口）
│   ├── check_config.py          # 严格配置检查
│   └── backfill.py              # 全量回填
├── server.js / dev.js           # 本地静态服务器 / 抓取后启动预览
├── schema/                      # JSON Schema 文档
└── .github/workflows/
    └── update-data.yml          # 定时采集工作流
```

## 快速开始

### 本地运行采集

```bash
# 需要 Python 3.11+（仅标准库，无需 pip install）
python crawler/run.py --config config.json
```

成功后数据写入 `data/`。重复运行是幂等的：内容无变化则不递增版本号、不产生提交。

> 注意：`data/` 已加入 `.gitignore`，本地运行只用于调试，**不会进入任何提交**。正式数据由 GitHub Actions 在服务端生成并提交（见下文「本地运行与提交」）。

其他用法：

```bash
# 全量回填（首次部署 / 重建历史）
python crawler/run.py --full
# 或
python scripts/backfill.py

# 离线测试：用本地 bootstrap JSON 代替网络请求
python crawler/run.py --bootstrap-local D:/path/to/FPLstatic.json

# 严格配置检查（头像文件必须齐全）
python scripts/check_config.py
```

### 部署到 Vercel（推荐：可享实时数据层）

1. 在 Vercel 导入 `SoChiChung/FPL-Chain-Tracker`，框架预设选 **Other**，Build Command 与 Output Directory **留空**（本仓库无构建步骤，Vercel 直接托管仓库根目录）
2. Vercel 会自动把 `api/fpl-live.js` 识别为无服务器函数并挂到 `/api/fpl-live`
3. 部署完成后页面页脚会显示「实时接口 · …」；GitHub Pages 等无函数环境会显示「静态快照 · 未连接实时接口」

`vercel.json` 已声明该函数的 `includeFiles: data/**`（让它能读到仓库快照作为基线）、`maxDuration: 30`，
并给 `/data/*` 加了 `must-revalidate` 缓存头。

> **首次部署必须有基线 `data/`**：实时层以 `data/meta.json` + `data/summary.json` 作为「已冻结历史」的起点，
> 仓库里没有这两份文件时它无法装配数据。仓库已包含一份基线快照；若你是从零开始，先本地跑一次
> `npm run crawl` 再提交：`git add -f data/ ':(exclude)data/.tmp'`。

### 部署到 GitHub Pages（无实时数据层，靠定时任务）

1. 推送仓库到 GitHub（`git push`），在仓库 Settings → Pages 中选择发布来源 `Deploy from a branch` → 分支 `main`，目录 `/`（仓库根）
2. 工作流 `.github/workflows/update-data.yml` 会自动定时采集（**每 30 分钟一次**，UTC），也可以在 Actions 页面手动触发 `workflow_dispatch`
3. 站点 URL：`https://{owner}.github.io/{repo}/`

> GitHub Pages 只能托管静态文件，无法运行无服务器函数，因此页面读的是 GitHub Actions 提交的 `data/*.json`，
> 新鲜度取决于工作流频率（`idle` 阶段本来也不需要更实时）。
> 另外 GitHub 会在**仓库连续 60 天无活动后自动停用定时工作流**，长期休赛期后记得去 Actions 页面重新启用。

> 仓库根已有 `.nojekyll` 空文件，保证 JSON 文件按原样发布。

### 本地运行与提交（避免冲突）

`data/`（API 采集产物）已在 `.gitignore` 中，本地不跟踪：

- **本地只提交代码逻辑**（`crawler/`、`config.json`、`index.html` 等），运行采集产生的数据不会出现在 `git status` 中
- **数据由 GitHub Actions 生成**：工作流在服务端跑同样的 `crawler/run.py`，用 `git add -f data/` 强制提交（`.gitignore` 挡不住 Actions 的强制添加），GitHub Pages 直接发布这些数据
- 这样本地永远不会产生数据相关的提交冲突；拉取（`git pull`）只会把服务端新数据带下来

唯一需要注意的场景：如果**先**跑过本地采集、**又**拉了服务端数据提交，本地的 `data/` 文件可能被标记为已跟踪（`git status` 出现 `modified: data/...`）。执行一次即可永久解决：

```bash
git ls-files data/ | xargs git update-index --skip-worktree
```

（撤销：把 `--skip-worktree` 换成 `--no-skip-worktree` 重跑一遍。）

> 提示：每 30 分钟轮询一次对 FPL API 是较高频的请求（比赛日约 240 次/天），若日志出现大量 429 限流提示，可在工作流中把 `cron: "*/30 * * * *"` 调低频率。

## 配置说明（config.json）

```json
{
  "team_id": 7557100,
  "timezone": "Asia/Shanghai",
  "season": "2026-27",
  "managers": [
    { "name": "Fran", "start_gw": 3, "end_gw": 6, "avatar": "Fran.png" }
  ],
  "crawl": {
    "request_delay_seconds": 0.4,
    "max_retries": 3,
    "request_timeout_seconds": 10,
    "seal_after_hours": 48
  }
}
```

| 字段 | 说明 |
|---|---|
| `team_id` | FPL 账号 ID |
| `timezone` | IANA 时区名，deadline 展示转换用 |
| `season` | 赛季标识，缺省时由 GW1 deadline 自动推导 |
| `managers[]` | 接龙玩家；`start_gw`/`end_gw` 为接管区间（两两不重叠），`name` 必须与头像文件名一致 |
| `crawl` | 采集行为参数，均有默认值 |
| `rules` | 赛事积分规则参数（含大型 BGW 名单），详见下方「rules（赛事积分规则参数）」 |

### rules（赛事积分规则参数）

`rules` 块集中管理赛事积分规则参数，供积分计算读取。**大型 BGW 名单需人工维护**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `large_bgw_gws` | int 数组 | **大型 BGW 轮次编号**（缺赛球队 ≥5 的 Gameweek），按 FPL 官方赛程在每轮开赛前手动填入；无则 `[]` |
| `chip_penalty` | number | 使用一张 Chip 扣减的赛事积分（默认 1.5） |
| `hit_penalty_per_4` | number | 每 -4 分游戏内转会扣分对应的赛事积分扣分（默认 0.5） |
| `avg_or_points` | int 数组 | 平均 OR 排名奖励分档，第 1~9 名依次对应 |
| `weekly_or_tiers` | 对象数组 | 单周 OR 奖励分档；`max_rank` 为该档上限（含），`points` 为该档奖励，按 `max_rank` 升序排列 |
| `transfer_pool` | number | 赛季末转会奖励奖池总分（默认 4） |

**large_bgw_gws 填写示例**：

```json
"rules": {
  "large_bgw_gws": [18, 29],
  "chip_penalty": 1.5,
  "hit_penalty_per_4": 0.5,
  "avg_or_points": [20, 15, 12, 9, 7, 5, 3, 2, 1],
  "weekly_or_tiers": [
    { "max_rank": 10000,  "points": 3 },
    { "max_rank": 100000, "points": 2 },
    { "max_rank": 200000, "points": 1 }
  ],
  "transfer_pool": 4
}
```

> 大型 BGW 判定依赖「缺赛球队数 ≥5」，现有 FPL API 无法自动获取，故由主办方依据官方赛程手动维护 `large_bgw_gws`。该名单用于判断「非大型 BGW 使用 Chip → 取消资格」。

## 头像规范

- 位置：`assets/avatar/`
- 命名：文件名任意（png/jpg 均可），在 `config.json` 的 `avatar` 字段指定，如 `"name": "欧巡", "avatar": "ocean.jpg"`
- 前端加载失败时自动兜底为 `assets/avatar/default.png`
- 上线前把微信头像（PNG/JPG）放入该目录即可，无需改代码

## 数据文件说明

| 文件 | 内容 | 前端用法 |
|---|---|---|
| `meta.json` | 当前 GW、下一轮 deadline（UTC/北京/时间戳三份）、38 轮事件、玩家名单，以及 `timezone` / `rules` / `seal_after_hours`（供实时层共用配置） | 首屏 + 倒计时 |
| `summary.json` | 38 轮概要数组 | 时间线折叠态 |
| `gw-{nn}.json` | 单轮阵容/转会/芯片详情 | 展开时懒加载 |
| `stats.json` | 玩家接龙统计 + 赛事积分 | 积分榜 |

完整字段定义与 JSON Schema 见 [design.md](design.md) 第 8 章与 `schema/` 目录。

## 本地开发与预览

| 命令 | 行为 |
|---|---|
| `npm start` | **抓取最新数据 → 启动预览服务器**（默认 http://localhost:8000/）。抓取失败则不启动，旧数据保持不变 |
| `npm run dev` | 同 `npm start`（保留的别名） |
| `npm run serve` | 只启动静态服务器，不抓取数据 |
| `npm run live` | 不抓数据，但挂载实时接口（http://localhost:8001/），**预览线上 Vercel 的行为** |
| `npm run crawl` | 只抓取数据，不起服务器 |
| `npm run verify` | 跑实时数据层验证（见下文「验证」） |

`npm start` / `npm run dev` 依次执行：① 自动定位可用的 Python（优先已装 `tzdata` 的隔离环境）→ ② 运行 `crawler/run.py` 抓取最新 FPL 数据 → ③ 启动静态预览服务器。若抓取失败，服务器不会启动，旧数据保持不变。

可选环境变量：

- `FPL_PYTHON`：手动指定 Python 解释器路径（默认自动探测）
- `PORT`：覆盖预览端口（`serve`/`dev` 默认 8000，`live` 默认 8001）
- `FPL_DATA_DIR`：覆盖基线数据目录（默认项目根下的 `data/`）

## 实时数据层

**为什么需要它**：FPL 官方 API **不返回 `Access-Control-Allow-Origin`**（响应头 `Vary` 仅为 `X-API-Language, Accept-Encoding`），
所以浏览器无法直连官方接口。任何「页面自己拉实时数据」的方案都必须有一个服务端代理。

**怎么工作**：

```
浏览器 ──► /api/fpl-live?file=summary.json ──► api/fpl-live.js（Vercel 函数，服务端代抓）
                                                    │  读 data/*.json 作为已冻结历史的基线
                                                    ▼
                                              lib/fpl-core.js（状态机 / 统计 / 积分）
浏览器 ◄──────── 与 data/*.json 完全同构的 JSON ◄────┘
```

- 输出结构与 `data/*.json` **完全同构**，前端无需区分来源
- 非 Vercel 环境（GitHub Pages、纯静态托管）该路径返回 404，前端自动回落到 `data/*.json` 静态快照，页面照常可用
- 上游抓取失败时，函数回落到仓库里的快照并在响应头标注 `X-FPL-Source: base-fallback`，不会白屏

### 缓存策略（什么时候可以走缓存）

判定集中在 `lib/fpl-core.js` 的 `determinePhase()`，前端 `app.js` 用同一口径的 `phaseFromSummary()`：

| 阶段 | 判定 | 前端轮询 | 函数侧缓存 | 依据 |
|---|---|---|---|---|
| `live` | 有 GW 正在进行（deadline 已过、尚未 finished） | 60 秒 | 30 秒 | 比分会变，必须刷新 |
| `settling` | 最近的 GW 已结束但仍在补分/封印窗口（默认 48h） | 300 秒 | 120 秒 | 补分会微调，低频刷新 |
| `idle` | GW 还没开始，或上一 GW 已冻结且下一 GW 未开始 | **不轮询** | 1800 秒 | 数据不可能变，用缓存即可 |

也就是说：**只有存在「正在进行中的 Gameweek」时才必须放弃缓存**；GW 未开始、或上一 GW 已结束的阶段，直接使用缓存。
上游 picks 的抓取集合同样遵守这条口径——`idle` 阶段只请求 4 个基础接口，完全不抓 picks。

前端每轮只请求 `summary.json` 一个文件，内容指纹没变就不重绘（避免闪烁）；后台标签页不抓取，切回前台立即补一次。

### 验证

```bash
npm run verify            # 全部检查（含联网差分校验）
npm run verify:offline    # 跳过联网部分
```

覆盖 4 类检查：

1. **差分校验**：JS 实时装配结果 vs Python crawler 产出的 `data/*.json`，逐字段比对（`summary` / `stats` / `meta` 三份零差异）
2. **积分计算**：与 `stats.py` 在同一合成赛程下的输出逐位一致（覆盖 ①平均 OR ②单周 OR ③转会奖励 ④Hit ⑤Chip、取消资格、大型 BGW 例外、并列平分）
3. **状态机与前端逻辑**：GW 状态边界、阶段判定、实时接口回落、刷新排程
4. **无服务器接口**：状态码、CORS 头、缓存头、结构完整性

> 差分校验要求 `data/` 是 Python 侧的稳定输出。若刚跑完采集，需再跑一次让轮次状态落定
> （`finished → sealed` 的过渡会在下一次运行时完成），否则会看到一次性差异。

## 前端开发指引

前端为纯静态页面（`index.html` + `assets/js/app.js`），按 [design.md](design.md) 第 12 章 Frontend Data Contract 实现：

- **数据来源双层**：优先 `api/fpl-live?file=…`（实时接口），失败或 404 时回落 `data/*.json`（静态快照）。两者结构一致，渲染层无需区分；`state.source` 只用于页脚提示
- **缓存**：实时接口请求始终带时间戳绕开浏览器/CDN 缓存（函数内部按阶段缓存）；静态快照请求带 `?v={data_version}`，版本没变即命中浏览器缓存
- **自动刷新**：按 GW 阶段轮询（`live` 60 秒 / `settling` 300 秒 / `idle` 不轮询），详见「实时数据层 · 缓存策略」
- 相对路径读取，兼容 `user.github.io/repo/` 子路径部署
- 数据缺失按「`null` = 无数据、`[]` = 确认空」语义渲染，不抛错
