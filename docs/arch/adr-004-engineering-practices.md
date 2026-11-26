# ADR-004：工程实践基线——把已有验收判据接进合并前闸门

- 状态：**已采纳**（2026-11-26 拍板，决策见 §0）
- 日期：2026-11-26
- 基线提交：`5a130da`（main）
- 写域：`docs/arch/**`；`.cnb.yml` / `package.json` / `tsconfig.json` / `wrangler.jsonc` 的改动列在里程碑卡，不在本文件内执行
- 相关：`AGENTS.md` 六条设计决策、`docs/arch/adr-001~003`、`docs/arch/roadmap.md`、`docs/perf/01~03`

---

## 0. 决策记录（2026-11-26 拍板）

- 决策人：技术负责人（@fbigun）
- 拍板方式：「按你的建议来」，即采纳本文 §5 推荐方案 B 与 §6 六张卡的优先级
- 本节的效力高于下文正文：两者冲突时以本节为准（正文保留为当时论证）

| # | 待拍板项 | 拍板结论 | 影响范围 |
|---|---|---|---|
| D1 | M1 是否进保护分支的状态检查 | **进**：M1 的流水线接入目标分支「需要通过状态检查」，**但仍不要求人工批准**（单人 + NPC 协作，自我批准是噪音） | 仓库页面设置（人工一次勾选）+ `.cnb.yml`；本文 §2.5 A1 的结论不变 |
| D2 | R4（token 进日志）若为真选哪条路 | **已证实，且不是「若」**：两条独立的泄漏路径都实测存在（§0.1）。处置取「①代码侧路径归一 + ②平台侧关掉 invocation log + 开 query 脱敏」，**不采纳**「改协议挪 query」与 Tail Worker | 升为 **P1**，从 R4「`[待验证]`」改写为 M4 的前置必做项 |
| D3 | 六张卡的排期是否照排 | 照排，顺序与依赖不变 | 无 |

### 0.1 R4 的复核结果：`[待验证]` → 已证实

原文 §2.5 A4 把这件事列为未知、§7 R4 给出三条处置路径。现在两条路径都已实测：

**路径一：代码自己就打印了 token（原有缺陷，与平台无关）**

`src/index.ts` 的 500 兜底日志打的是 `pathname` 原文：

```js
console.error(`${new URL(req.url).pathname}:`, e);   // /s/{token} 时 token 原样进日志
```

用 `test/fakes/env.ts` 的 `FakeKV.fail('link:secretTOKEN123')` 造一次 `/s/secretTOKEN123`
的 500，捕获到的 `console.error` 实参是：

```
["/s/secretTOKEN123:", "boom"]      ← token 明文
```

这条与 Workers 平台无关，纯代码问题，**已违反** `AGENTS.md` 决策 4「日志脱敏」。

**路径二：平台侧 invocation log 记录完整 URL（文档已确认，非猜测）**

Cloudflare 官方文档 `workers/observability/logs/workers-logs/`（抓取于 2026-11-26）原文：

> Each Workers invocation returns a single invocation log that contains details such as
> the Request, Response, and related metadata.
> …
> For example, Fetch requests will have a message describing the request method and
> **the request URL**

且文中列出 invocation message 形态为 `Fetch → <Method> <URL>`。同一文档写明
「All newly created Workers will come with the observability setting enabled by default」，
而本仓 `wrangler.jsonc` **没有** `observability` 段（实测 `grep observability wrangler.jsonc` 空），
即走默认值——**默认就在记录**。故 `/s/{token}` 的 token 会作为 URL 的一部分进 Workers Logs。

### 0.1b M1 的可复制变更（拍板后已定型，执行时照抄）

写域只有 `.cnb.yml`，新增一段 `pull_request`。放在 `main:` 下（不是 `$` 下——PR 事件按目标分支
匹配配置，只有打到 `main` 的 PR 才该跑这条）：

```yaml
main:
  # 合并前门禁：PR 创建 / 重新打开 / 源分支 push 时触发。
  # 不 imports 任何密钥仓库——pull_request 是不可信事件，且本门禁不需要部署凭据。
  # volumes 用 copy-on-write-read-only：PR 并发时不回写 npm 缓存。
  pull_request:
    - name: 合并前检查
      docker:
        image: node:24
        volumes:
          - /root/.npm:copy-on-write-read-only
      stages:
        - name: 安装依赖
          script: npm ci --no-audit --no-fund
        - name: 类型检查
          script: npx tsc --noEmit
        - name: 单元测试
          script: npx vitest run
```

三处刻意的取舍：

- **不写 `ifModify`**：文档改动（如本 ADR 的两个 PR）也该过一遍 `tsc + vitest`，成本 5s，
  省它反而让"文档 PR 一律绿灯"成为习惯
- **不并到 main push 的那条流水线**：main push 的任务里带着 `wrangler deploy` 与密钥 `imports`，
  复用它会顺带把 PR 拖进凭据面
- **不跑 bench / 覆盖率**：bench 对机器差异敏感（`vitest.bench.config.ts` 注释已写明不进 CI 全量），
  覆盖率属 M2

**合并可行性已实测**：把上面这段插进现有 `.cnb.yml` 的 `main:` 之后，用 `yaml` 解析：
`main` 下事件从 `["push"]` 变 `["pull_request","push"]`，`push` 仍是原来的 2 个任务
（`同步源码到 GitHub` / `构建与部署`）未被破坏，`$` 下的 `push`/`tag_push` 不受影响，
新任务的 `imports` 为空。

**本条不做的验证**：M1 的红色验收（改一位 sha → 流水线红）必须在**真实 PR 上跑一次**，
本 ADR 无凭据、无流水线触发权限，故 §6 的验收命令保持原样，标注为「执行卡内完成」。

### 0.2 落地形态（两处都已实测可用）

1. **代码侧归一**（`src/index.ts`，1 个函数 + 1 行调用）：`/s/` 前缀统一记成 `/s/{token}`，
   并输出结构化 JSON。实测替换后同一场景的日志实参为：

   ```
   {"event":"unhandled","path":"/s/{token}","err":"boom"}
   ```

   `npx tsc --noEmit` 零输出、`npx vitest run` 288 项全绿（现有 4 处 `vi.spyOn(console,'error')`
   只断言「被调用过」，不匹配文案，无需改断言）。

2. **平台侧关掉 invocation log 并脱敏 query**（`wrangler.jsonc`）：

   ```jsonc
   "observability": { "enabled": true, "redact_query_string": true, "logs": { "invocation_logs": false } }
   ```

   两个字段都取自 `wrangler@4.152.0` 的 `config-schema.json` 的
   `definitions.Observability`：`logs.invocation_logs`（`Set to false to disable invocation logs`）、
   `redact_query_string`（`Whether query strings are removed from request URLs in logs and traces`，默认 `false`）。
   `npx wrangler deploy --dry-run` 通过，包体 **104.78 KiB / gzip 27.95 KiB**（与基线一致）。

   取舍：`enabled: true` 保留，因为**自定义 `console.*` 仍然要进 Workers Logs**（M4 的价值在此）；
   只关 `invocation_logs`——它记的是全量 URL，而本项目需要排障的字段（event / path / err）
   已由代码侧结构化输出覆盖。

3. **不采纳的两条**：`/s/` 改 query 传 token（改协议，破坏所有已发出的订阅链接，
   且 `redact_query_string` 只是缓解而非根治）；Tail Worker 脱敏（新增运行时组件，
   与「免费额度内单 Worker」约束冲突）。

---

## 1. 背景与目标

**一句话目标：让"坏代码进不了 main"成为机制，而不是靠自觉。**

### 1.1 这个仓库已经有什么（实测，不是自评）

在谈"最佳实践"之前必须先承认现状，否则方案会变成给一个健康项目开药：

| 已有的工程资产 | 实测数字 | 出处 |
|---|---|---|
| 单测 | **288 项 / 9 文件全绿** | `npx vitest run` |
| 语句覆盖率 | **96.84%**（分支 80.48% / 函数 100%） | `vitest run --coverage`，见 §2.3 |
| 输出字节级门禁 | **8 行 sha256 基线** | `test/golden.test.ts` |
| 反事实基准 | 18 项 bench，含等价性断言 | `test/bench/**`，跑完 15.5s |
| 运行时口径差 | node vs workerd 逐项对照 | `docs/perf/02` |
| 端到端行为基线 | 1550 行端点断言 | `test/index.test.ts` |
| 架构决策记录 | ADR-001/002/003 + 带验收判据的 roadmap | `docs/arch/**` |
| 打包体积 | 104.78 KiB / gzip **27.95 KiB** | `wrangler deploy --dry-run` |

**结论：测试、基准、文档这三件事的做法已经超过绝大多数个人项目。** 缺的不是"再补工具"。

### 1.2 真正的缺口只有一条

实测 `.cnb.yml`（YAML 解析确认，非肉眼）：

```
main.push          → [同步源码到 GitHub, 构建与部署]
$.push             → [同步源码到 GitHub]
$.tag_push         → [同步源码到 GitHub]
pull_request       → 不存在
```

**没有任何 PR 触发。** 于是：

- 288 项测试、8 行 golden sha、覆盖率 —— 全部只在 **main push** 时执行
- 而 main push 的同一任务里，`npx wrangler deploy` **紧接着就部署到生产**
- 换句话说：**线上是 CI 的下游，main 被当成预发环境用**

这条比"要不要上 ESLint"重要两个量级。工程化的定义差异不在"有没有测试"，在
**"坏代码能不能进 main"**。现状是能——只要 PR 描述写得像样，合并后才在 main 上炸。

### 1.3 成功指标

| 指标 | 现在 | 目标 | 测法 |
|---|---|---|---|
| 会破坏 main 的改动在合并前被拦下的比例 | **0%**（无 PR 门禁） | ≥ 90% | 人为注入 5 类缺陷（改 golden、删断言、类型错、引未用变量、坏 JSON 分支回归），看 PR 是否红 |
| PR 门禁墙钟 | — | ≤ 90s | 流水线日志 |
| 全量覆盖率 | 96.84% | ≥ 95% 不下降 | `vitest run --coverage` |
| main 上首次失败的构建数 | 未知 | 0（失败都发生在 PR 分支） | CNB 洞察 |

---

## 2. 需求分析与非功能量化

### 2.1 功能需求（按价值排序）

| # | 需求 | 为什么是需求而不是"加分项" |
|---|---|---|
| F1 | PR 创建/push 时自动跑 `tsc --noEmit` + `vitest run`，红则不可合并 | 唯一能真正阻止退化 |
| F2 | golden 8 行 sha 变化必须在 PR 描述解释 | 已有铁律写在 `test/golden.test.ts:1-27`，但**没人执行** |
| F3 | 覆盖率纳入趋势并可设红线 | 已 96.84%，红线才是"防止往下掉"，不是"逼着往上爬" |
| F4 | 部署前有可执行的回滚预案 | 0 个 tag、main 直接上生产，无任何回退路径文档 |
| F5 | 协作契约可机读（分支/tag/提交/PR 模板、角色名对齐） | roadmap §8 已写明"派单前先确认角色名"，而 `.cnb/settings.yml` **不存在** |
| F6 | 日志结构化且脱敏（token / 订阅 URL 永不出现） | `AGENTS.md` 决策 4 的要求；现状仅 1 处 `console.error` 且非 JSON |

### 2.2 非功能量化表

| 维度 | 量级（实测/估算） | 依据 | 对方案的含义 |
|---|---|---|---|
| 代码规模 | src **3174** 行 / test **3082** 行 / public **943** 行 | `wc -l` | 单人可全量阅读，**不需要**分层 CI、不需要并行分片 |
| 提交频率 | **43 次/30 天** | `git log --since` | 每 PR 门禁若 > 5 分钟会显著打断节奏 |
| 协作者 | 1 管理员 + N 个 NPC 角色 | `AGENTS.md` 决策 6 | **PR 会并发**（`npc/*` 分支），门禁必须支持多分支并行 |
| CI 计算耗时 | npm ci 2.4s + tsc 2.0s + vitest 3.3s + dry-run 1.7s ≈ **9.4s** | 本机实测 | 全链路墙钟瓶颈在 runner 调度与依赖下载，不在计算 |
| 生产配额 | KV 读 ~1,776/天、List ~174/天、CPU 10ms/次 | `adr-002` §4.4 | 方案不得引入任何运行时组件 |
| 可用性目标 | 个人自用，无 SLA；但订阅链接 500 = 断网 | `README.txt` 五 | 发布必须可回滚 |
| 失败容忍 | 订阅抓取失败保留旧快照；**派生数据失败不得静默** | `roadmap.md` W2-2 | 门禁失败必须显式红，不得 `continue-on-error` |

### 2.3 实测补充数据（本方案新增，此前仓库没有）

**覆盖率（`@vitest/coverage-v8@3` 临时安装测得，未入库）：**

```
File         | % Stmts | % Branch | % Funcs | % Lines
All files    |   96.84 |    80.48 |     100 |   96.84
 auth.ts     |     100 |     92.5 |     100 |     100
 index.ts    |     100 |     96.7 |     100 |     100
 parse.ts    |    92.9 |    66.07 |     100 |    92.9
 rename.ts   |   99.39 |    98.03 |     100 |   99.39
 render.ts   |   95.57 |    70.62 |     100 |   95.57
 subs.ts     |    99.7 |    87.26 |     100 |    99.7
 template.ts |   97.73 |    93.39 |     100 |   97.73
```

**这组数字决定了红线怎么设**：`parse.ts` 92.9%、`render.ts` 95.57% 已经低于 96.84%
的均值。若红线按**文件**卡 98%，`parse.ts` 立刻红，等于逼人写无意义的覆盖率测试。
故红线只能按**全量**设，且必须低于当前值（见 §6 M2 的可证伪条件）。

**严格模式选项的边际成本（逐个开一遍 tsc，实测）：**

| 编译选项 | 总报错 | 其中 `src/` | 判定 |
|---|---|---|---|
| `--verbatimModuleSyntax` | **0** | 0 | 现在就能开，零成本 |
| `--noUnusedLocals --noUnusedParameters` | 4 | **0** | 现在就能开（4 处全在 `test/bench/`） |
| `--exactOptionalPropertyTypes` | 27 | 19 | 暂不开（见下） |
| `--noUncheckedIndexedAccess` | 115 | 47 | 分级开（见下） |

`noUncheckedIndexedAccess` 的 47 处分布：`parse.ts` 20 / `index.ts` 15 / `auth.ts` 11 /
`template.ts` 1。**`parse.ts` 占 42%** —— 那正是数组下标与 YAML 行解析最密的地方，
也是 `AGENTS.md` 点名的"正确性核心"。这不是巧合，是该选项最该开的地方。

### 2.4 约束清单

| 约束 | 来源 | 对本方案的限制 |
|---|---|---|
| 无构建链、无后端框架 | `AGENTS.md` | 不引入 bundler / 框架；CI 侧只允许 `npm ci` + `npx` |
| 依赖从简 | `AGENTS.md` | 每加一个 devDependency 必须在方案里给量级依据 |
| 全部功能在免费额度内 | `README.txt` | 不能用 Workers Builds（付费/集成绑定）、不能用 Durable Objects |
| 单管理员 | `AGENTS.md` 决策 6 | 无多角色权限，CI 也只需一个部署身份 |
| secrets 不入库不入文档 | `AGENTS.md` 决策 4 | PR 流水线**不得** imports `cloudflare.yml` |
| `parse/rename/render` 改动须附样例 | `AGENTS.md` 工作约定 | 门禁必须能验证"有没有带样例"——靠 golden + 覆盖率，不靠人查 |

### 2.5 澄清记录与假设（信息不足处按保守假设推进）

| # | 未知 | 采纳的假设 | 若假设不成立的应对 |
|---|---|---|---|
| A1 | 是否希望 PR 门禁卡"必须 1 人批准" | 不卡（单人 + NPC 协作，卡批准会卡死自己） | 若引入第二个真人，改为 `pull_request.mergeable` |
| A2 | 是否接受 CI 墙钟从 0 变 ~60s | 接受（9.4s 计算 + 依赖下载） | 加 `/root/.npm:copy-on-write` 卷，实测能把 npm ci 压到秒级 |
| A3 | 期望的 tag / 发布节奏 | 打语义化 tag（`v1.x.y`），发布 = tag + main push | 若坚持"永远 latest"，则放弃 `wrangler rollback` 的版本锚点，回滚只能靠 revert + 重跑 |
| A4 | Workers Logs 是否记录 `/s/{token}` 的完整 path | ~~未知，标 `[待验证]`~~ → **已证实会记录**（§0.1，两条路径），处置见 §0.2 | 已在 §0.2 落地，不再依赖假设 |
| A5 | 是否有第二个真实用户 | 无 | 若有，`/api/me` 的 `profile` 读放大与登录锁定全局计数都会变真问题 |

> `[待验证]` 的处置纪律沿用 `docs/perf/02` 立的规矩：**没在对应环境实测过的，不许写成已通过。**

---

## 3. 问题定义

### 3.1 两条流

工程化方案只该改上面那条流：

```
【代码流】现状：闸门在终点之后
  分支 push ──────────────────────────────────────────► main ─► npm ci ─► tsc ─► vitest ─► deploy ─► 生产
              （PR 阶段零检查；NPC 分支与人工分支无差别）              ▲
                                                                     └── 唯一的门禁在这里，且门禁后面就是线上

【代码流】目标：闸门在入口
  分支 push ─► PR ─► [tsc ─► vitest ─► golden ─► coverage] ─红─► 不可合并
                                  │绿
                                  ▼
                                 main ─► npm ci ─► 三项检查 ─► dry-run ─► deploy ─► 生产
                                                                          ▲
                                                          失败则停在 dry-run，生产不动
```

```
【运行流】不改：cron 0 1,13 * * * ─► 抓取 N 个订阅 ─► 解析 ─► snap: 写 KV
                                                        │
              客户端 ─► /s/{token} ─► 读 link + snap ─► render ─► clash / singbox / uri
```

### 3.2 不改变的东西（这划定了方案的边界）

- 运行流的**一个字节都不改**：不新增 KV 键、不改输出格式、不加运行时依赖
- 不改变任何面向用户的行为（除 §6 M4 的错误文案）
- 不推进 `roadmap.md` 里 W2/W3/W5 的编码卡——本 ADR 是**流程层**，与它们正交

---

## 4. 候选方案对比

### 方案 A（最简可行）：只补 PR 门禁

`.cnb.yml` 增加 `pull_request` 触发，一条任务跑 `npm ci → tsc → vitest`。

- 改动：**1 个文件，约 12 行**
- 收益：F1 全拿，F2 从"纸面铁律"变成"红灯"
- 代价：不解决覆盖率趋势、回滚、协作契约
- 会不会过度设计：不会；反过来看，**它是否足够**——是的，若只允许做一件事，就是这件

### 方案 B（推荐）：PR 门禁 + 质量基线五件套

方案 A + 覆盖率红线与徽章 + `tsconfig` 分级严格化 + 结构化脱敏日志 + 发布回滚规程 + 协作契约模板。

### 方案 C（重）：再加本地钩子、Lint 全家桶、多环境预发、属性测试

| 项 | 实测/依据 | 否决理由 |
|---|---|---|
| husky / lefthook 本地钩子 | 需新增 devDependency | 可 `--no-verify` 绕过；云端工作区里钩子装不装得上取决于镜像。**门禁必须在服务端**。零依赖替代：`npm run check` 一条命令 |
| ESLint + typescript-eslint + 插件集 | 通常 8~12 个包 | 能抓的类别里，**unused 已由 tsc 零成本覆盖（src 0 报错）**；其余（格式、导入顺序）是审美，本项目风格靠 3000 行既有代码已相当自洽。收益/依赖比不合算 |
| Vitest Browser Mode / 前端测试 | 面板 943 行、16 处 `innerHTML` 但全部经 `esc()` | 引入 Playwright 级依赖与 GB 级镜像，为一个单管理员面板 |
| 多环境（staging Worker） | 需第二个 Worker + 第二套 KV + 第二套 secrets | 单管理员没有"灰度人群"。**免费版也不支持渐进发布** |
| 属性测试 / 模糊测试 | `parse.ts` 991 行是理想靶子 | 真实收益存在但**无法给出量级依据**；现有 golden 8 行 + 27 项 parse 单测已覆盖已知形态。列为演进预留而非 v1 |
| Durable Objects 提升一致性 | — | 需付费计划，`adr-002` §7 已否决 |

### 4.1 维度对比

| 维度 | A 最简 | **B 推荐** | C 重 |
|---|---|---|---|
| F1 PR 门禁 | ✅ | ✅ | ✅ |
| F2 golden 门禁生效 | ✅ | ✅ | ✅ |
| F3 覆盖率趋势 | ❌ | ✅ | ✅ |
| F4 回滚规程 | ❌ | ✅ | ✅ |
| F5 协作契约 | ❌ | ✅ | ✅ |
| F6 结构化脱敏日志 | ❌ | ✅ | ✅ |
| 新增 devDependency | 0 | **1**（`@vitest/coverage-v8`） | 8~15 |
| 改动文件数 | 1 | 5 | 12+ |
| CI 墙钟增量 | +50s | +55s | +3~5min |
| 6 个月后的维护成本 | 低 | 低 | 高（钩子失效、lint 规则漂移） |
| 过度设计风险 | 无 | 低（每项都有实测依据） | **高** |

---

## 5. 推荐方案与理由

**采纳方案 B。** 逐条对照 §2.2 的量化需求：

1. **F1/F2 用最小代价拿满**：仓库已有 288 项测试与 8 行 golden，把它们放进 PR 触发里
   是**纯接线，零新代码**。这是全项目投入产出比最高的一步。
2. **F3 只加 1 个 devDependency**：`@vitest/coverage-v8@3` 与现有 `vitest@3` 版本锁齐，
   且覆盖率 96.84% 已实测可跑通（见 §2.3 的完整报告）。红线设 **全量 95%**，
   理由是不按文件卡（`parse.ts` 92.9% 已低于均值）。
3. **F4 不新增任何东西**：`wrangler rollback` / `wrangler versions` 已在 CLI 里，
   缺的是**写清楚怎么用**。0 个 tag 说明从没锁定过可回滚的锚点。
4. **F5 只写模板文件**，`.cnb/` 目录本就不存在，增量最小。
5. **F6 是纪律的机械保障**：只有 1 处 `console.error`，改成结构化 JSON 是 3 行；
   `AGENTS.md` 决策 4 的"日志脱敏"目前**没有任何测试覆盖**（实测 `grep console test/`
   只有 4 处 spy，无脱敏断言）。

### 5.1 关键取舍（被否方案留档）

- **为什么不在 PR 流水线里做 `deploy --dry-run`？**
  实测 1.7s，很便宜。但它需要 `CLOUDFLARE_API_TOKEN`，而 PR 流水线一旦 imports
  `cloudflare.yml`，任意 fork / NPC 分支的 PR 都能拿到部署凭据。**收益 1.7s，风险是全套
  secrets。** 故 dry-run 放在 **main push**（部署任务内，已有凭据），PR 只跑纯本地检查。
- **为什么不卡"PR 必须批准"？**
  `AGENTS.md` 决策 6 单管理员。自己批准自己是噪音。留待第二个真人出现再议（§2.5 A1）。
- **为什么覆盖率红线不是 98%？**
  已实测 `parse.ts` 92.9 / `render.ts` 95.57。条值设到当前值之上等于逼人写
  "为覆盖率而覆盖率"的测试，`AGENTS.md` 的"不为一次性功能搭抽象层"同理适用于测试。
  红线的作用是**防下滑**，不是**促上升**。

---

## 6. 里程碑与验收标准

每个里程碑都必须能用一个命令证明自己完成了。**完不成的判定写在卡里，不留给"感觉差不多了"。**

### M1 · PR 门禁（P0，1 个 PR）

- 写域：`.cnb.yml`
- 内容：`pull_request` 事件（glob `**`，覆盖所有源分支含 `npc/*`）→ 单任务
  `npm ci → npx tsc --noEmit → npx vitest run`；**不 imports 任何密钥仓库**
- 顺带：`docker.volumes: ["/root/.npm:copy-on-write-read-only"]`（缓解 A2）。
  **注意类型选的是 `copy-on-write-read-only` 而不是 `copy-on-write`**：CNB 文档「流水线缓存」明确写
  「PR 事件可改用 `copy-on-write-read-only` 类型使缓存只读，避免并发写入冲突」；本项目 PR 会并发
  （NPC 多角色分支），写回缓存会让并发 PR 互相覆盖 `node_modules` 指纹。只读复用即可，
  PR 不需要回写。
- **已拍板（§0 D1）**：目标分支 `main` 设为保护分支，勾选「需要通过状态检查」，
  **不勾**「需要评审人批准」。据 CNB 文档「触发规则」：
  `pull_request` 在 PR 创建、重新打开、源分支 push 时触发，`pull_request.mergeable`
  则要求目标分支是保护分支且勾了状态检查——两者分工是「跑检查」与「拦住合并」，
  M1 两件都要配置，缺前者没结果、缺后者拦不住。
- 配置来源提醒（据 CNB 文档「触发规则」的版本选择表）：`pull_request` 使用
  **预合并后的 Commit**（PR 源分支合入目标分支的结果），故分支上改 `.cnb.yml` 会在下一次 push 时
  按**该分支的配置**执行，无需先合到 main 才能验证门禁；而 `pull_request.target` / `mergeable`
  用的是「合并前目标分支最新 Commit」。M1 只需要前者。
- 安全口径（同文档「不可信事件」）：`pull_request` 属于**不可信事件**，触发令牌 `CNB_TOKEN` 限定在
  当前仓库、且流水线引用的外部文件必须用 `allow_events` 显式声明。本卡 PR 流水线不 `imports`、
  不引用任何外部文件，因此不受这条约束——**这是"不 imports 密钥仓库"之外的第二条理由**。
- **验收**：在分支上故意把 `test/golden.test.ts` 某行 sha 改 1 位 → 推 PR →
  流水线**红**；改回 → **绿**。贴两次流水线链接。
- **失败即否决**：若 90s 内跑不完 M1 不成立，需回到方案 A 的纯 `tsc + vitest`（去掉 install 缓存调优前先量）。

### M2 · 覆盖率与徽章（P1）

- 写域：`package.json`、`.cnb.yml`
- 内容：加 `@vitest/coverage-v8@3`（唯一新增依赖）+ `npm run coverage`；
  CI 用 CNB 内置任务 `testing:coverage`（`pattern: coverage/lcov.info`，
  `lines: 95`，`diffLines: 80`，`allowExts` 限 `js,ts`）
- **验收**：仓库出现覆盖率徽章；人为删掉 `test/subs.test.ts` 中若干 `collectNodes` 用例后，`npm run coverage` 低于 95 且流水线红（删前先记录实际值，删后贴对比）。
- 可证伪条件：若 `testing:coverage` 解析 vitest 的 lcov 失败（格式兼容问题），
  则降级为 CI 脚本自比 `coverage-summary.json` 阈值，**红线值不变**。

### M3 · tsconfig 分级严格化（P1，可拆 3 个小 PR）

- 写域：`tsconfig.json`、`src/parse.ts`、`src/auth.ts`、`src/index.ts`
- 顺序（**必须按成本递增**）：
  1. `verbatimModuleSyntax: true` —— 实测 0 报错，直接开
  2. `noUnusedLocals/noUnusedParameters: true` —— src 0 报错，顺手清 `test/bench/` 4 处
  3. `noUncheckedIndexedAccess: true` —— **按文件推进**：先 `template.ts`(1) →
     `auth.ts`(11) → `index.ts`(15) → `parse.ts`(20)。每步一次 PR，每步后
     golden 8 行 sha 必须**全部不变**
- `exactOptionalPropertyTypes` **本批不开**：19 处，语义争议大（可选字段"缺省"与
  "显式 undefined"在原代码里未区分），收益不抵误改风险。列入演进预留。
- **验收**：每步 `npx tsc --noEmit` 零输出 + `npx vitest run` 288 项全绿 +
  golden 全部 sha 不变。
- 回滚：单 PR revert。

### M4 · 结构化脱敏日志（**P1**，§0 D2 上调）

- 写域：`src/index.ts`（1 处 + 1 个新函数）、`wrangler.jsonc`、`test/index.test.ts`
- 内容（§0.2 已实测全部可用，直接照抄）：
  1. 500 兜底日志改为结构化 JSON 且路径归一：`/s/{token}` 记成 `/s/{token}` 字面量
     （**这是本卡的核心，不是 P1 里的可选项**——现状实测会打印 token 明文）
  2. `wrangler.jsonc` 加 `"observability": { "enabled": true, "redact_query_string": true, "logs": { "invocation_logs": false } }`
  3. 新增单测：`env.kv.fail('link:secretTOKEN')` → 断言捕获的日志字符串**不含 token**、
     且含 `event` 字段。这条断言是防回退的唯一机械手段。
- **验收**：
  - 新用例在「把 `logLine` 里的 `/s/` 归一去掉」这一变异下**必须变红**（跑完还原）
  - `grep -c "console\." src/` 仍为 1
  - `npx wrangler deploy --dry-run` 包体字节数不变（104.78 KiB / gzip 27.95 KiB）
- **风险已消除**：原稿担心改日志格式会打破已有 4 处 `vi.spyOn(console,'error')` 断言。
  实测这 4 处只断言 `toHaveBeenCalled()`（`test/index.test.ts` 的 500 与公开订阅两例），
  不匹配文案，**无需改任何既有断言**。

### M5 · 发布与回滚规程（P2）

- 写域：`README.txt` 新增「发布与回滚」一节、`.cnb/settings.yml`（tag 自动生成）
- 内容（**只写规程，不改代码**）：
  - 每次发布打 `vX.Y.Z` tag（当前仓库 **0 个 tag**，这是首次建立锚点）
  - 回滚三步：`wrangler deployments list` 找版本 → `wrangler rollback <version-id>`
    → 校验 `/api/me` 与任一 `/s/{token}` 返回 200
  - **KV 数据无版本**：回滚代码不回滚数据。故凡涉及 `snap:/link:/tpl:` 结构变更的
    PR，必须在 PR 描述写明"前滚兼容策略"（字段必须是可选新增，不得改名）
- **验收**：在本地按规程演练一次 `wrangler deployments list`（不实际回滚）；
  文档里三条命令可直接复制执行。

### M6 · 协作契约（P3）

- 写域：`.cnb/ISSUE_TEMPLATE/`、PR 模板、`CONTRIBUTING.md`、`.cnb/settings.yml`
- 内容：
  - Issue 模板两套：缺陷（含"影响订阅链接还是面板"必填）、需求（含量级必填）
  - PR 模板：勾选式强制项 —— 「golden 8 行 sha 是否变化（不变化请贴复核命令输出）」
    「是否新增依赖（是则贴量级依据）」「是否改输出格式（是则贴 Clash/sing-box 导入验证）」
  - `.cnb/settings.yml` 里对齐 `npc.roles[].name`，解掉 `roadmap.md` §8 标注的
    "派单前需确认角色名"这个悬空依赖
- **验收**：新建 Issue/PR 时模板生效（截图）；`roadmap.md` §8 的 ⚠️ 段落可删除。

### 排期与依赖

| 里程碑 | 优先级 | 依赖 | 可并行 | 单 PR 可回滚 |
|---|---|---|---|---|
| M1 PR 门禁 | **P0** | 无 | — | ✅ |
| M2 覆盖率 | P1 | M1（复用同一条任务） | 与 M3 并行 | ✅ |
| M3 严格化 | P1 | M1（否则改坏了没人拦） | 与 M2 并行 | ✅ 每步 |
| M4 结构化日志 | **P1**（§0 D2 上调） | 无（可与 M1 并行，写域不重叠） | 与 M1/M3 并行 | ✅ |
| M5 回滚规程 | P2 | 无 | 任意 | ✅（纯文档） |
| M6 协作契约 | P3 | M5（tag 规范先定） | 任意 | ✅（纯新增） |

**M1 必须先做**，理由不是"最重要"，而是**它是其余五项的验收手段**：没有 PR 门禁，
M3 的"golden sha 不变"就只能靠人肉核对。

---

## 7. 风险与预案

| # | 风险 | 概率 | 影响 | 预案 / 触发降级条件 |
|---|---|---|---|---|
| R1 | PR 门禁墙钟超 90s，打断 43 次/月的节奏 | 中 | 中 | 先量再调：若 npm ci > 40s 则加 `volumes` 缓存；若仍超，PR 只跑 `tsc + vitest`（9.4s 计算），覆盖率挪到 main |
| R2 | 并发 PR（NPC 多角色协同）导致抢同一文件 | **高**（`npc/*` 分支是既有事实） | 中 | 门禁天然并行；冲突靠 `git:auto-merge` 前置 + 写域声明（本 ADR 每卡都写了 `写域`）。**不做**自动合并，直接引用 CNB `git:auto-merge` 仅在保护分支+状态检查通过后启用 |
| R3 | `@vitest/coverage-v8` 大版本与 vitest 漂移 | 中 | 低 | 锁 `^3` 与 `vitest@^3` 同主版本；测试跑不通即视为 M2 未完成，不静默降级 |
| R4 | **`/s/{token}` 的 token 进日志** —— ~~可能~~ **已证实，两条独立路径**：① 代码自己打印 `pathname` 原文；② Workers Logs 的 invocation log 记录 `<Method> <URL>` | **已发生** | **高**（token 即订阅凭据） | 处置已定并实测（§0.1/§0.2）：代码侧路径归一 + `invocation_logs: false` + `redact_query_string: true`，落在 M4。**否决**「改 query 传 token」（破坏已发出的订阅链接）与「Tail Worker 脱敏」（新增运行时组件）。残余风险：M4 合入前产生的历史日志仍含 token——免费版保留 3 天，可等自然过期，无需处置 |
| R5 | `noUncheckedIndexedAccess` 在 `parse.ts` 的 20 处改造引入行为变化 | 中 | **高**（parse 是正确性核心） | 每步都必须 golden 8 行 sha 全不变 + 288 项全绿；任一行 sha 变即 revert 该步，逐字节解释后再来 |
| R6 | 覆盖率红线导致"为覆盖率写测试"的劣化 | 中 | 中 | 红线只设全量下限（95%），**永不按文件卡**；PR 模板要求说明新测试验证的是什么行为 |
| R7 | 165/165 个依赖的 lockfile 全部指向 `registry.npmmirror.com`，镜像不可用时 CI 全红 | 低 | 中 | CI 加 fallback：先默认源，失败重试 npmmirror；`integrity` 字段齐全（实测 165/165），换源不破坏可复现性 |
| R8 | 冻结期：M3 改造 parse 期间若线上需紧急修 bug | 低 | 高 | M3 拆成 4 个小 PR 正是为此；任一 PR 未合入时 main 仍可发版。**紧急修复优先 revert 未合入分支，不在 main 上打补丁** |

**降级 / 回滚触发线（写死，避免临场拍脑袋）：**

- CI 连续 3 次因基础设施（非代码）失败 → 临时关闭该 stage，开 Issue 跟踪，**不得**静默 `continue-on-error`
- 任何已部署版本出现 `/s/{token}` 500 → 立即 `wrangler rollback`，再定位
- golden sha 意外变化且 30 分钟内解释不出 → revert 该 PR

---

## 8. 不做什么（v1 negative scope）与演进预留

### 8.1 v1 明确不做

| 不做 | 理由 |
|---|---|
| 引入 ESLint / Prettier / Biome | §4 方案 C；unused 已由 tsc 零成本覆盖（src 0 报错），其余是审美 |
| 本地 git 钩子（husky 等） | 可绕过；门禁必须在服务端。零依赖替代：`npm run check` |
| 多环境（staging Worker / 第二套 KV） | 单管理员无灰度人群；免费版无渐进发布 |
| Durable Objects / R2 / D1 | 需付费；`adr-002` §7 已否决 |
| Workers Builds（Cloudflare 侧 CI） | 与现有 CNB 流水线重复，且会引入第二套凭据面 |
| PR 强制批准 | 单管理员，自我批准是噪音 |
| 拆分 `parse.ts`（991 行） | `roadmap.md` §6 已有结论：没有失败场景；本 ADR 不改它，只给它加索引安全检查 |
| 重排 `roadmap.md` 的 W2/W3/W5 编码卡 | 本 ADR 是流程层，与它们正交；不抢排期 |
| Go 化任何组件 | 语言栈是 Workers/TS。**Go 1.27 的可借鉴点只有形态**：`log/slog` 的结构化 JSON ≈ M4 的日志格式；`testing` 表驱动 ≈ 现有 vitest 用例组织；`synctest` 的确定性并发 ≈ 现有 `test/fakes` 的确定性桩 I/O。**代码不迁移**，本项目 0 行 Go，引入 Go 意味着自建网关，与"免费额度内单 Worker"约束直接冲突。CGO 议题不存在（无 C/C++ 复用场景） |

### 8.2 演进预留（明确不现在做，但留好插入点）

| 预留点 | 触发条件（可证伪） |
|---|---|
| 属性测试 / 模糊测试打 `parse.ts` | 出现第 2 个"真实机场订阅解析错"的线上缺陷 |
| `exactOptionalPropertyTypes` | M3 全部完成且 team 稳定 ≥ 1 个月 |
| 多真人协作（PR 批准 + 角色权限） | 出现第二个有写权限的人 |
| 前端面板自动化测试 | 面板逻辑超过 1500 行，或出现第 3 个"XSS/渲染错"类缺陷 |
| 渐进发布（Workers Versions） | 升级付费计划，或 `README.txt` 的可用性目标从"个人自用"上调 |
| KV 访问层（`src/kv.ts`） | 已在 `roadmap.md` W2-1，**本 ADR 不重复、不抢单** |

---

## 附录 A：本文件的所有实测数字与复现命令

| 数字 | 命令 |
|---|---|
| 288 项测试全绿 | `npx vitest run` |
| 覆盖率 96.84/80.48/100 | `npm i -D @vitest/coverage-v8@3 && npx vitest run --coverage` |
| bench 18 项 / 15.5s | `npx vitest run --config vitest.bench.config.ts` |
| tsc 0 报错 | `npx tsc --noEmit` |
| 严格项报错分布 | `npx tsc --noEmit --noUncheckedIndexedAccess`（115/47），`--exactOptionalPropertyTypes`（27/19），`--noUnusedLocals`（4/0），`--verbatimModuleSyntax`（0/0） |
| 打包 104.78 KiB / gzip 27.95 KiB | `npx wrangler deploy --dry-run --outdir /tmp/out` |
| src/test/public 行数 | `wc -l src/*.ts test/**/*.ts public/*.js public/*.html` |
| `.cnb.yml` 触发事件 | 用 `yaml` 解析后打印 `main.push` 与 `$` 下的事件键（实测无 `pull_request`） |
| 0 个 tag | `git tag -l \| wc -l` |
| 43 次提交/30 天 | `git log --since="30 days ago" --oneline \| wc -l` |
| 本机 CI 计算耗时 | npm ci 2.4s / tsc 2.0s / vitest 3.3s / dry-run 1.7s |
| 依赖源 | `grep -c registry.npmmirror.com package-lock.json` → 165；`grep -c registry.npmjs.org` → 0 |
| `wrangler dev` 冒烟 | `npx wrangler dev --local --test-scheduled` 后 `curl /api/me` → `{"initialized":false,"authed":false}`；`curl "/__scheduled?cron=..."` → 200 |
| R4 路径一：代码打印 token 明文 | 用 `test/fakes/env.ts` 造 `/s/secretTOKEN123` 的 500，spy `console.error` → 实参 `["/s/secretTOKEN123:", "boom"]`；同一场景下 `FakeKV.fail('link:secretTOKEN123')` 触发 `subs.getLink` 抛错 |
| R4 路径二：invocation log 记 `<Method> <URL>` | `curl -s https://developers.cloudflare.com/workers/observability/logs/workers-logs/ \| grep -o "the request URL"`；`grep -c observability wrangler.jsonc` → 0（走默认，默认开启） |
| §0.2 归一后日志实参 | 同一 500 场景 → `{"event":"unhandled","path":"/s/{token}","err":"boom"}`（不含 token） |
| `observability.logs.invocation_logs` / `redact_query_string` 存在 | `node -e "const s=require('./node_modules/wrangler/config-schema.json');console.log(Object.keys(s.definitions.Observability.properties.logs.properties))"` → 含 `invocation_logs`；`Object.keys(s.definitions.Observability.properties)` → 含 `redact_query_string` |
| M1 片段可安全合并进现有 `.cnb.yml` | 把 §0.1b 的片段插到 `main:` 后，`yaml` 解析 → `Object.keys(d.main)` 由 `['push']` 变 `['pull_request','push']`，`d.main.push.length` 仍为 2，新任务 `imports` 为空；文档命令：见 §0.1b 末段 |
| 加了 observability 段后包体不变 | `npx wrangler deploy --dry-run --outdir /tmp/out2` → 104.78 KiB / gzip 27.95 KiB |
| 既有 4 处 console spy 是否匹配文案 | `grep -n "spyOn(console, 'error')" test/index.test.ts` → 1149/1163/1361/1373，断言均为 `toHaveBeenCalled()` |
