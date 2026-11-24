# ADR-002：KV 访问层契约与配额账

- 状态：建议采纳（待技术负责人拍板）
- 日期：2026-11-24
- 基线提交：`ee659eb`（main）
- 写域：`docs/arch/**`
- 相关：`README.txt`「六、配额核对」、`AGENTS.md` 决策 5（CPU 10ms/次）

---

## 1. 结论先行

当前 KV 访问有三类问题，优先级完全不同。**最要命的一条初审没提到**：

| # | 问题 | 严重度 | 触发条件 |
|---|---|---|---|
| **A** | 单次调用子请求数突破免费版 **50 上限**，且失败静默 | **P0（已确定性突破）** | §4.3 / §4.35 |
| B | 单次 `/s/` 请求重复读全部 sub + snap，无请求级 memo，热路径用 `list` | P1（List 配额 + 延迟） | 每次客户端拉订阅 |
| C | `listByPrefix` 逐键串行 `get`，无批量读 | P2（延迟，非配额） | 每次 `list*` 调用 |

**A 是架构级缺陷，不是优化项。** 初审把它归为「配额」问题（读 10 万/天），
方向对但量级判断错了：

```
subrequests 50/次   ← 已超（N≥15,M≥20 必然超，§4.35）
List 1,000/天       ← 5.7× 余量（§4.4）
Reads 100,000/天    ← 56× 余量（§4.4），根本不是瓶颈
```

三者差两个数量级。且 A 的表现是**功能直接失败**：
轻则模板缓存静默陈旧（§4.3），重则订阅链接返回 HTTP 500（§4.35）。

## 2. 事实基线：Cloudflare 配额语义

已核对官方文档（抓取时间 2026-11-24 UTC）：

| 项 | 免费版 | 出处 |
|---|---|---|
| KV Reads | **100,000 / 天** | `developers.cloudflare.com/kv/platform/limits/` |
| KV Writes（不同键） | 1,000 / 天 | 同上 |
| **List requests** | **1,000 / 天**（与 Reads **分开计**） | `developers.cloudflare.com/kv/platform/pricing/` |
| 存储 | 1 GB | limits |
| **Subrequests / invocation** | **50 / 次调用** | `developers.cloudflare.com/workers/platform/limits/` |
| 并发出站连接 | 6 / 请求 | 同上 |

三条被普遍误解的语义，直接决定后面的账：

1. **`list()` 不计入 Reads，单独记 List requests。** 官方 pricing 页把
   「Keys read 100,000/day」与「List requests 1,000/day」列为两行。
   → **一次 `list` 的代价在配额上等价于 1 次读，但走的是 1,000/天 的紧口袋。**
2. **KV 操作计入 subrequests。** 官方 Workers limits 页明确：「a subrequest is any
   request a Worker makes using the Fetch API **or to Cloudflare services like R2,
   KV, or D1**」。→ 50 上限**同时约束** KV 调用次数，不只是 `fetch`。
3. **批量读存在，但按 key 计费。** 官方 pricing：「Bulk read operations are billed by
   the amount of keys read」。`env.KV.get([k1...k100])`（上限 100 键，
   `kv/api/read-key-value-pairs/`）**只算 1 个 subrequest，但仍算 N 次 Read**。
   → 批量读能解 A（子请求），不能解 Reads 配额。

> ⚠️ `README.txt:六` 写的「KV 读 100,000/天，用量约几百/天」只对了一半：
> 它没列 List requests 的 1,000/天 独立上限，而代码里 `list` 是热路径。

## 3. 现状代码盘点

全部 KV 访问点（`grep -n "env.KV\." src/*.ts`）：

```
src/auth.ts:249,255,258,262      login:fail 读写删
src/index.ts:133,389,402,410,420,429   profile 读写（散在 setup/login 里）
src/subs.ts:69                   ★ KV.list({prefix})  ← list 配额入口
src/subs.ts:72                   ★ 循环内逐键 KV.get   ← N 次读，串行
src/subs.ts:79                   getJson 单键
src/subs.ts:83                   putJson
src/subs.ts:157,158,268,351,357  delete
src/template.ts:127,131,136,180,183,229,259,264,276  template/tpl 读写删
```

两个结构性观察：

- **没有一处 memo**：同一请求内 `listSubs()` 可能被调 2~3 次，每次都重新 `list + N get`
- **没有批量读**：`listByPrefix`（`subs.ts:68-76`）的循环是 `await` 串行，
  N 个键 = N 次往返 + N 个 subrequest
- **`profile` 的 KV 访问漏在传输层**：`index.ts:133/389/402/410/420/429` 直接
  `env.KV.get('profile')`，绕过任何访问层。这是 ADR-001 里 B6 的同源问题

## 4. 配额账（实测，非估算）

### 4.1 测量方法

写探针 `.probe/final.ts`（未入库，仅用于产出本文数字）：用 `Map` 实现 KV stub，
**统计每次 `list`/`get`/`put`/`delete`/`fetch` 调用的真实次数**，然后按
`index.ts` 各端点的实际调用顺序复现。

规模变量：`N` = 订阅数、`M` = 自建节点数、`L` = 输出链接数。每订阅 20 个节点。

复现命令（探针脚本内容见附录 A）：
```bash
npx vite-node .probe/final.ts
```

### 4.2 单次请求的子请求数（硬上限 50）

**N=5，M=10，L=4**（一个"正常用了一阵"的个人实例）：

| 操作 | KV get | KV list | KV put | KV del | fetch | **合计子请求** |
|---|---|---|---|---|---|---|
| `/s/{token}` target=clash（`includeCustom=true`） | 21 | 1 | 0 | 0 | 0 | **22** |
| `/s/{token}` target=clash（`includeCustom=false`） | 11 | 0 | 0 | 0 | 0 | **11** |
| `/s/{token}` target=singbox 冷缓存 | 23 | 1 | 1 | 0 | 0 | **25** |
| `/s/{token}` target=singbox 热缓存 | 2 | 0 | 0 | 0 | 0 | **2** |
| 面板 `reload()` 一次（5 个 API 并行） | 51 | 7 | 0 | 0 | 0 | **58** ❌ |
| cron：`refreshTemplates` + `renderAll` | 47 | 5 | 3 | 0 | 1 | **56** ❌ |
| cron：仅 `renderAll` | 45 | 4 | 2 | 0 | 0 | **51** ❌ |

**N=10，M=20，L=8**（一个用了半年的实例）：

| 操作 | KV get | KV list | KV put | fetch | **合计子请求** |
|---|---|---|---|---|---|
| `/s/{token}` clash（`includeCustom=true`） | 41 | 1 | 0 | 0 | **42** |
| `/s/{token}` singbox 冷缓存 | 43 | 1 | 1 | 0 | **45** |
| 面板 `reload()` 一次 | 100 | 7 | 0 | 0 | **107** ❌❌ |
| cron：`refreshTemplates` + `renderAll` | 131 | 6 | 4 | 1 | **142** ❌❌❌ |

> 注：`/api/*` 是**独立的一次 Worker 调用**，`reload()` 里 5 个 API 是 5 次调用，
> 各自独立吃 50 的预算。表中把它们合计是为了展示"面板一次刷新"的总量；
> 单看每个接口：`/api/status`=11、`/api/pool`=22、`/api/nodes`=11、
> `/api/links`=5、`/api/templates`=9，**均未超 50**。
> 真正单次调用即超限的是 **cron 与 `syncTemplate`**（见 4.3）。

### 4.3 已确定性突破 50 的位置：`renderAll`

`renderAll`（`template.ts:240-255`）在**一次调用**里：
`listTemplates`(1 list + T get) → `listLinks`(1 list + L get) → 每个可渲染链接
`collectNodes`(2N get + 1 list + M get) + `put`。

实测。口径：**`T=2` 个模板，`L=E`（只有 singbox 链接，无其他链接）**：

| N 订阅 | M 自建 | E（singbox 链接） | `renderAll` 子请求 | 是否超 50 |
|---|---|---|---|---|
| 10 | 20 | 1 | 47 | ok |
| **12** | **20** | **1** | **51** | **❌ 超限** |
| 14 | 20 | 1 | 55 | ❌ |
| 15 | 20 | 1 | 57 | ❌ |
| 15 | 20 | 2 | 110 | ❌ |
| 20 | 20 | 1 | 67 | ❌ |

**临界点：N=12 / M=20 且只有 1 个 singbox 链接，`renderAll` 就已超限。**
每多一个 singbox 链接，再叠加 `2N+M+2` 个子请求（N=15 时约 +53）。

**12 个订阅 + 20 个自建节点、仅 1 个 singbox 链接，`renderAll` 就必然抛
`Too many subrequests by single Worker invocation`——且这是最省的配置。**

而这条路径被两个地方无语境地调用：

- `index.ts:64-70` `syncTemplate()` —— **空 catch 吞掉**
- `index.ts:57-61` `refreshAllAndTemplate()` —— 由 `index.ts:53` 的 `ctx.waitUntil()` 触发，
  reject 只进 Cloudflare 日志，cron 端不产生任何用户可见信号

所以真实表现是：**超过阈值后，模板缓存静默停止更新，面板与 API 全部返回成功。**
订阅链接继续返回**旧的模板配置**（节点已换代、配置还是上一版），用户看不到任何异常。

这条直接对应 `AGENTS.md` 工作约定里「静默成功比失败更危险」。

### 4.35 补充发现：「按需重建兜底」在超限区间同时失效

`index.ts:68` 的注释为吞错给出了理由：

```ts
} catch {
  // 模板缓存是加速副本，读取端有按需重建兜底
}
```

这个理由**在 renderAll 超限的同一区间内不成立**。`/s/{token}` 的
`ensureOutput`（`template.ts:268-273`）走 `renderLink` → `renderWith` →
`collectNodes`，与 `renderAll` **消耗同一类子请求**。实测对比（`T=2`，`L=E=1`，即仅 1 个 singbox 链接）：

| N 订阅 | M 自建 | `/s/` clash 子请求 | `renderAll` 子请求 | 状态 |
|---|---|---|---|---|
| 10 | 20 | 42 | 47 | 都 ok |
| 12 | 20 | 46 | **51 ❌** | 只有 renderAll 超 |
| 14 | 20 | 50 | **55 ❌** | 只有 renderAll 超（`/s/` 恰好等于上限，未超） |
| **15** | **20** | **52 ❌** | **57 ❌** | **两者同时超** |
| 20 | 20 | **62 ❌** | **67 ❌** | 两者同时超 |

超限条件可解析：`/s/{token}` clash 的子请求数
= `getLink(1) + getSub×N + getSnapshot×N + list(1) + node×M` = `2N + M + 2`。

```
2N + M + 2 > 50   ⇒   2N + M > 48
```

即 **N=15 时 M>18 就超**、**N=20 时 M>8 就超**、**N=10 时 M>28 就超**。
（`renderAll` 的临界点更早：N=12/M=20 即 51，见 §4.3。）

结论：在 N≥15 且 M≥20 这类完全正常的个人使用规模下，
`renderAll` 与 `/s/{token}` **同时**超 50。此时：

1. cron 的 `renderAll` 静默失败 → 缓存不更新
2. 客户端来拉 `/s/{token}` → `ensureOutput` 也想重建 → **同样抛错** →
   `index.ts:38-45` 顶层 catch → **HTTP 500「服务器内部错误」**

于是**兜底注释所承诺的"读取端按需重建"变成了读取端 500**。
这不是"缓存陈旧"的降级问题，而是**订阅链接直接不可用**。

> 已用 `.probe/q5.ts` 验证：预算耗尽时 `ensureOutput` 抛
> `Too many subrequests by single Worker invocation`，被顶层 catch 转成 500。
> 同一探针也确认了**未耗尽时**兜底确实有效（`tpl:t` 会被补上）——
> 所以本节的结论是"兜底在超限区间失效"，不是"兜底无用"。

### 4.4 每日配额总量（Reads 与 List 分开算）

建模输入全部取自 §4.2 的实测单次量（N=5 / M=10 / L=4 / T=2）：

| 单次操作 | 实测 get | 实测 list |
|---|---|---|
| cron 一轮（`refreshAll` + `refreshTemplates` + `renderAll`） | 57 | 6 |
| `/s/{token}` target=clash（`includeCustom=true`） | 21 | 1 |
| 面板 `reload()`（5 个接口合计） | 51 | 7 |
| 写接口一次（含 `syncTemplate` → `renderAll`） | 45 | 4 |

使用假设（单人自用，**这是估算，非实测**）：

- 3 台设备 × 4 个链接 × 每台每天拉 1 次 = **12 次 `/s/` 拉取/天**
- 面板每天打开 10 次（每次一个 `reload()`，5 个接口 = 5 次独立 Worker 调用）
- 写操作每天 20 次（改订阅 / 链接 / 节点 / 手动刷新）
- cron 每天 2 轮（`wrangler.jsonc` 的 `0 1,13 * * *`）

| 来源 | 频次/天 | 日 get（Reads） | 日 list |
|---|---|---|---|
| cron 两轮 | 2 | 114 | 12 |
| `/s/{token}` 拉取 | 12 | 252 | 12 |
| 面板 `reload()` | 10 | 510 | 70 |
| 写操作 | 20 | 900 | 80 |
| **合计** | | **1,776** | **174** |

| 配额 | 用量 | 上限 | 余量 | 倍数 |
|---|---|---|---|---|
| KV Reads | 1,776 | 100,000 | **98.2%** | 56.3× |
| List requests | 174 | 1,000 | **82.6%** | **5.7×** |
| KV Writes | ≈40 | 1,000 | 96% | 25× |

**结论：Reads 有 56 倍余量，完全不是瓶颈。真正的紧配额是 List requests，
只有 5.7 倍余量。**

这个对比正是本 ADR 的核心论据：`README.txt:六` 只核对了 Reads（10 万/天），
得出"用量约几百/天，绰绰有余"——**漏掉了 List 的独立 1,000/天 上限**，
而代码里 `list` 恰好出现在热路径（`subs.ts:69`）。

单次调用的天花板更紧：**subrequests 50/次**，`renderAll` 在 N=15/M=20 时已达 56，
已经确定性超限（§4.3）。三个约束的相对紧度：

```
subrequests 50/次   ← 已经超了（§4.3）
List 1,000/天       ← 5.7× 余量，客户端轮询一多就破
Reads 100,000/天    ← 56× 余量，非瓶颈
```

> 一个反直觉的结论：`includeCustom=true`（默认值，`subs.ts:320`）让每个 `/s/`
> 请求都付 1 次 list（`collectNodes:468` → `listNodes()` → `listByPrefix`）。
> 而自建节点通常只有个位数，用 list 拿"有哪些 key"再逐个 get，等于
> **拿 1,000/天 的紧配额去换 10 次 100,000/天 的宽配额**。批量化后这笔交易应当反过来。

## 5. 决策：KV 访问层契约（`src/kv.ts`）

### 5.1 接口

```ts
// src/kv.ts —— L2 层，只依赖 L0 codec（ADR-001）
export interface KvReader {
  get<T>(key: string): Promise<T | null>;
  getMany<T>(keys: string[]): Promise<Map<string, T | null>>;   // 内部按 100 分片
  listKeys(prefix: string): Promise<string[]>;                  // 仅取名字，不取值
}
export interface KvWriter extends KvReader {
  put(key: string, value: unknown, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
  deleteMany(keys: string[]): Promise<void>;
}
```

### 5.2 三条硬规则

**K1 — 请求级 memo 必须存在，且生命周期 = 一次 Worker 调用**

```ts
export function createKv(env: Env): KvWriter  // 每个 fetch/scheduled 调用创建一个
```

`get` 命中同一 key 直接返回缓存；`put`/`delete` 同时写穿 memo（写后读一致，
避免同一请求内读到旧值）。**不跨请求复用**（isolate 复用会让数据陈旧到无法解释）。

> 为什么这在本项目特别重要：`/s/{token}` 里 `collectNodes` 被调 1 次，但
> `PUT /api/links/:id` 的路径是 `getLink`(313) → `updateLink` 内部再 `getLink`(338)
> → `syncTemplate` → `renderAll` → `listLinks` + 每链接 `collectNodes`。
> 同一个 `link:{token}` 在一次请求里被读了 3 次（实测见 4.2 的 51 次 get）。

**K2 — 禁止在热路径用 `list` 取代已知 key 集合**

- `/s/{token}`：链接已持有 `sources: string[]`（`subs.ts:44`）与 `includeCustom`，
  **所有需要读取的 key 都可直接推导** → 用 `getMany([...snapKeys, ...subKeys])`，
  **零 list**
- 自建节点：`collectNodes:468` 的 `listNodes()` 改为读一个 `nodes:index` 键
  （节点增删时维护），或直接在 `link` 记录里存 `customIds`
- `list` **只允许**出现在面板的"列出全部"接口（`/api/subs`、`/api/links` 等）

**K3 — 缓存失效口径跟数据所有权走，不跟 HTTP 入口走**

| 键 | 所有权 | 失效触发 | 现状问题 |
|---|---|---|---|
| `sub:{id}` | `subs` | 增删改 | ok |
| `snap:{subId}` | `subs`（cron 写） | 抓取成功 | ok |
| `node:{id}` | `subs` | 增删 | ok |
| `link:{token}` | `subs` | 增删改、reset | ok |
| `template:{id}` | `template` | 增删改 | ok |
| `tpl:{token}` | `template` | 重渲染、换绑、模板变更 | **散在 `index.ts:313/320/326`** |

`tpl:` 的失效必须在 `template` 模块内闭环，由 `subs` 的链接变更事件驱动。
`RENDER_VERSION`（`template.ts:54`）已经提供了粗粒度版本失效，保留。

### 5.3 目标 import 图

```
  index.ts (L4)
      │  createKv(env) 每请求一次
      ▼
  ┌────────────────────────────────────────────┐
  │ kv.ts (L2)                                  │
  │  ├ memo: Map<key, value>        K1          │
  │  ├ getMany → KV.get(keys[0..99]) K2/批量    │
  │  └ 不做 list（除 kv.listKeys）              │
  └───────────────┬────────────────────────────┘
                  ▼
  ┌────────────────────────────────────────────┐
  │ codec.ts (L0)                               │
  └────────────────────────────────────────────┘

  禁止：kv.ts → auth.ts（认证不该被 KV 层依赖）
        kv.ts → subs/template（KV 层不认识领域类型）
```

## 6. 改造后的配额账（预期）

同样 N=5 / M=10 / L=4 / T=2，以及 §4.3 的超限场景。**子请求数与 Reads 必须分开列**，
因为 `getMany` 只削减前者：

| 操作 | 现在（子请求） | 改造后（子请求） | 现在（Reads） | 改造后（Reads） |
|---|---|---|---|---|
| `/s/{token}` clash | 22 | **2** | 21 | 12 |
| `/s/{token}` singbox 冷 | 25 | **5** | 23 | 14 |
| `/s/{token}` singbox 热 | 2 | **2** | 2 | 2 |
| `renderAll`（N=15,M=20,1 个 singbox 链接） | **59 ❌** | **≈10 ✅** | 55 | ≈32 |
| `renderAll`（N=15,M=20,2 个 singbox 链接） | **111 ❌** | **≈14 ✅** | 105 | ≈47 |
| 面板 `reload()`（5 接口合计） | 46 | 31 | 51 | 33 |

推导（`/s/{token}` clash 为例）：

```
现在   getLink(1) + getSub×5 + getSnapshot×5 + [list(1) + listNodes 逐个 get(10)]  = 22 subrequests
改造后 getLink(1) + getMany(11 键 = sub×5 + snap×5 + nodes:index) = 2 subrequests
       ↑ 零 list；11 键在 getMany 单次 100 键上限内
```

`renderAll`（N=15, M=20, 1 个 singbox 链接）改造后的 ≈10：
`listTemplates(1 list + 2 get) + listLinks(1 list + 4 get) + getMany(31 键 → 1) + put(1) = 3 + 5 + 1 + 1 = 10`。
模板原文与链接记录已被前两步读入 memo，`getMany` 只需补 `sub` / `snap` / 节点索引。

**日配额（沿用 §4.4 假设）：**

| 配额 | 现在 | 改造后（预期） | 上限 | 改造后余量 |
|---|---|---|---|---|
| List requests / 天 | 174 | **≈86** | 1,000 | 91.4% |
| KV Reads / 天 | 1,776 | ≈1,100 | 100,000 | 98.9% |
| 单次最大子请求 | **111 ❌** | ≈14 | 50 | 72% |

**改造收益全部落在两个紧配额上：子请求（从超限到 3.5 倍余量）与 List
（天数余量 5.7× → 11.6×）。Reads 本来就不是瓶颈，改造后也仍不是。**

> `getMany` 的边界：单次上限 100 键（官方文档），超出需分片，每分片 = 1 subrequest。
> N=15 时 31 个键一个分片足够。若将来 N > 100（本项目定位单管理员，
> `AGENTS.md` 决策 6 不开放多用户），分片数 = ceil(N/100)，
> 要到 N≈4900 才撞 50 预算。**不是现实风险。**

## 7. 风险与不做的事

- **`cacheTtl` 不用于本场景**：`cacheTtl` 最小 30 秒，用于跨请求缓存读结果。
  本项目写后要立即读（`updateLink` → `syncTemplate` → `renderAll`），
  用 `cacheTtl` 会引入 30 秒陈旧窗口，**与 K3「写后读一致」冲突，明确不采用**。
- **不引入 Durable Objects**：`AGENTS.md` 决策「全部功能设计在免费额度内」，
  且 DO 需要付费计划。KV 的最终一致性在本项目已被会话设计绕过（`auth.ts:189-191`
  注释说明会话不落 KV），风险已受控。
- **`login:fail` 的读放大**（`auth.ts:248-259`）不在本次范围：它每次登录读写 1 次，
  单管理员场景量级可忽略。但 `recordLoginFail` 内 `get`+`put` 非原子
  （`auth.ts:255-258`），并发爆破可绕过计数——属安全问题，交 `正确性审查`，
  本 ADR 只记录不裁决。

## 7.5 对初审候选问题 5 的结论（失败静默，与 KV 强相关）

> **候选问题 5：`renderAll` / `syncTemplate` 吞异常 —— 结论：成立，且严重度是 P0。**

三处证据，逐条实跑：

1. `template.ts:247-252` —— `renderAll` 逐链接 `try { renderWith } catch { /* 保留上次缓存 */ }`。
   实测（`.probe/q5.ts`，让 `snap:` 读取抛子请求超限错）：
   ```
   renderAll 返回值 = 0     （无异常传播 → 调用方以为成功）
   tpl:t 是否存在 = false   （没有缓存被写入）
   ```
2. `index.ts:64-70` —— `syncTemplate` 空 catch，且注释写「读取端有按需重建兜底」。
3. `index.ts:53` —— `ctx.waitUntil(refreshAllAndTemplate(env))`，reject 只进日志，
   cron 侧无任何用户可见信号。

**关键判断：第 2 条的注释给出的免责理由是错的（§4.35）。**
`renderAll` 与 `/s/{token}` 的 `ensureOutput` 消耗同一池子请求预算，
在 N≥15/M≥20 时同时超限，兜底路径本身返回 500。
所以「静默」在这里不是"降级以避免报错"，而是**把一个本应上报的容量问题
掩盖成了随机 500**。

按 `AGENTS.md` 工作约定「静默成功比失败更危险」——**违反，判 P0。**

需要补充的边界：吞错**本身**不是无理由的。模板缓存确实是可重建的派生数据，
"单链接渲染失败不该拖垮其他链接"这个意图是对的。
问题在于当前实现把两种失败混为一谈：

| 失败类型 | 应如何处理 | 现状 |
|---|---|---|
| 单个链接的**数据问题**（模板 JSON 坏、该链接无节点） | 跳过该链接，其余继续，**在面板标记** | 静默跳过 ✓（但没有标记 ✗） |
| **全局容量问题**（子请求耗尽、KV 不可用） | **短路剩余循环并显式上报** | 静默跳过每个链接，逐个撞同一个错 ✗ |

正确做法不是"不吞错"，而是**分类**：前者继续（但留痕），后者短路（并上报）。
这正是 roadmap W2-2 的要求。

## 8. 对初审候选问题 2 的结论

> **候选问题 2：KV 访问无边界 —— 结论：成立，但严重度判断需上调。**

- 「`listByPrefix` 逐键串行 get」（`subs.ts:68-76`）—— **成立**
- 「`collectNodes`（`subs.ts:449`）/ `collectPool`（`subs.ts:479`）每请求重读全部
  sub + snap」—— **成立**，实测 `/s/` 单次 21~43 次 get
- 「`/s/{token}` 每次客户端拉取都重跑」—— **成立**，且 `Cache-Control: no-store`
  （`index.ts:105`）保证 CDN 也不兜
- 「KV 读配额 10 万/天」—— **部分不成立**：Reads 余量 98%，不是瓶颈。
  **真正先撞的是 subrequests 50/次（已确定性突破，§4.3）与 List 1,000/天。**

初审给的「缺请求级 memo 与批量读策略」方向正确，是正确解的一部分，
但不足以覆盖 A；A 需要的是「**任何单次调用都不得随 N/M/L 线性增长**」这条更强的约束。

## 附录 A：测量脚本

`.probe/final.ts`（临时文件，未提交）：

```ts
import { collectNodes, getLink } from '../src/subs';
import { ensureOutput, renderAll, templateStatuses } from '../src/template';

const ops = { get: 0, list: 0, put: 0, del: 0, fetch: 0 };
function mkEnv(store: Map<string, unknown>) {
  return { KV: {
    async list({ prefix }: any) { ops.list++; return { keys: [...store.keys()]
      .filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; },
    async get(key: any, type?: string) {
      if (Array.isArray(key)) { ops.get += key.length; return new Map(key.map((k) => [k, null])); }
      ops.get++; const v = store.get(key); if (v === undefined) return null;
      return type === 'json' ? JSON.parse(JSON.stringify(v)) : v; },
    async put(k: string, v: string) { ops.put++; store.set(k, JSON.parse(v)); },
    async delete(k: string) { ops.del++; store.delete(k); },
  } } as any;
}
// … 构造 N/M/L 规模数据后逐端点复现 index.ts 的调用顺序
```

复现全部表格：`npx vite-node .probe/final.ts`（三组规模一次跑完）。
`50 上限突破点`：`npx vite-node .probe/breakeven.ts`。
`静默吞错验证`：`npx vite-node .probe/silent.ts`（模拟第 51 个子请求抛错，
观察 `renderAll` 返回 `1`、`syncTemplate` 正常返回、接口回 200）。
