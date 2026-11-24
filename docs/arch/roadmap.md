# 架构改进路线图（Issue #14 / 批次 W1 之后）

- 基线提交：`ee659eb`（main）
- 输入：`adr-001-module-boundaries.md`、`adr-002-kv-access.md`、`adr-003-router.md`
- 本文件性质：**排期与验收判据**，不含实现代码。`docs/arch/**` 之外一律不改。
- 角色说明：本文件标出的执行角色按 `.cnb/settings.yml` 的 `npc.roles[].name` 解析。
  该仓库当前**没有** `.cnb/settings.yml`（实测 `find . -name settings.yml` 无命中），
  派单前需由技术负责人在仓库补上或改用已有角色名。

---

## 0. 一句话结论

**顺序不能按"看起来最脏的先修"排。** 唯一必须先做的是 ADR-002 的子请求预算（P0，
已经会失败），其余都是可延后的结构性改善。ADR-001 的模块拆分排最后——
它改动面最广、风险最高、用户可感知收益为零。

## 1. 批次总览

| 批次 | 卡片 | 主题 | 优先级 | 改 `src/` | 依赖 | 可回滚粒度 |
|---|---|---|---|---|---|---|
| **W2** | W2-1 | 子请求预算：批量读 + 请求级 memo | **P0** | 是 | 无 | 单 PR |
| **W2** | W2-2 | `renderAll`/`syncTemplate` 停止吞错 | **P0** | 是 | 无（可与 W2-1 同批） | 单 PR |
| **W3** | W3-1 | `deleteSub` 清理 `link.sources` 悬空引用 | P1 | 是 | 无 | 单 PR |
| **W3** | W3-2 | `tpl:` 缓存失效口径收口到 L3 | P2 | 是 | W2-2 | 单 PR |
| **W4** | W4-1 | 入口守卫 + 正则校验抽取 | P2 | 是 | 无 | 单 PR |
| **W5** | W5-1 | 抽 `codec.ts`，切断 L0→auth 反向依赖 | P3 | 是 | W2 全绿 | 单 PR |
| **W5** | W5-2 | `Env` 迁 `env.ts`；`template`→`subs` 绑权收口 | P3 | 是 | W5-1 | 单 PR |

**W2 与 W2-1/W2-2 必须最先做，且两者可以在同一批并行**（写域不重叠：
W2-1 动 `subs.ts`/新建 `kv.ts`；W2-2 动 `template.ts`/`index.ts` 的 catch 块）。

## 2. 为什么是这个顺序

### W2 先做：因为它是"正在失败"，不是"可能变慢"

ADR-002 §4.3 实测：`renderAll` 在 **N=12 订阅 + M=20 自建**、且只有 1 个
singbox 链接（最省配置、2 个模板）时单次调用就需要 **51 个子请求**，已超免费版
50 上限；N=15 时为 **57**；N=15 且有 2 个 singbox 链接时为 **110**。
而调用它的 `syncTemplate`
（`index.ts:64-70`）是**空 catch**，`refreshAllAndTemplate`（`index.ts:57-61`）
由 `index.ts:53` 的 `ctx.waitUntil()` 触发，reject 只进日志。

后果链（`.probe/q5.ts`、`.probe/silent.ts` 实测）：

```
子请求超限抛错
  → syncTemplate 空 catch 吞掉           → 接口返回 200 {ok:true}
  → 实际 tpl:{token} 未更新
  → 客户端拉 /s/{token}，ensureOutput 也想重建 → 同样超限 → 顶层 catch → HTTP 500
```

**两条同时成立**（ADR-002 §4.35）：N≥15/M≥20 时 `renderAll` 与 `/s/{token}`
消耗同一池子请求预算、同时超限，`index.ts:68` 注释承诺的
「读取端按需重建兜底」在超限区间**本身返回 500**。

所以用户看到的不是"缓存旧了"，而是**订阅链接直接不可用**，
且面板上一切正常。

这正是 `AGENTS.md` 工作约定「静默成功比失败更危险」点名的形态。**按该条纪律，
这是 P0。**

### W5 最后做：因为它的用户可感知收益是 0

ADR-001 的模块拆分让依赖方向可判定、`auth.ts` review 面收窄——这些是
**给维护者的收益，不是给用户的**。而它要动 6 个源文件的 import 行，
是在途分支冲突概率最高的卡片。

在 W2 解决完"正在失败"的问题之前花精力做它，是排期错配。

**并且**：W2-1 会新建 `kv.ts`，这本身就是 ADR-001 §3.1 里 L2 层的落地。
先做 W2 等于**顺手完成了 ADR-001 的一部分**，W5 的改动量随之变小。

## 3. 卡片详情

### W2-1 · 子请求预算：批量读 + 请求级 memo（P0）

- **写域**：新建 `src/kv.ts`；`src/subs.ts`；`src/template.ts:131,136,264`；
  `src/auth.ts:249,255`；`src/index.ts:133,389,410,429`
- **依据**：ADR-002 §5（K1 memo / K2 禁 list 热路径 / K3 失效口径）
- **必须达成的量化目标**（写进 PR 验收）：
  - `/s/{token}` 单次子请求 **≤ 5**（现状 22，N=5/M=10）
  - `renderAll` 在 N=15/M=20 时 **≤ 15**（现状：1 个 singbox 链接 57 ❌，2 个 110 ❌）
  - `/s/{token}` 路径 **零 `list` 调用**（现状 1 次，`subs.ts:468`）
- **行为等价判据**：
  1. `npx tsc --noEmit` 零输出
  2. `npx vitest run` 92 项全绿（不得减少）
  3. §5 的 7 个 golden sha256 全部不变
  4. 探针复测：跑 `.probe/final.ts` 等价脚本，子请求数达标
- **回滚方式**：单个 PR revert（`src/kv.ts` 为新增文件，revert 即消失）。
  无 KV 数据格式变更 → 无需数据迁移/回滚。
- **风险**：memo 若跨请求复用会导致读到陈旧数据。**必须做到每个
  `fetch`/`scheduled` 调用新建一次**，验收时用一个"先 put 再 get 同 key"的
  单测确认写后读一致。
- **执行角色**：`Web后端`（KV 访问层 + 模块化单体是其路由表范畴）

### W2-2 · `renderAll`/`syncTemplate` 停止吞错（P0）

- **写域**：`src/template.ts:247-252`；`src/index.ts:64-70`
- **要求**：
  1. `renderAll` 不再逐链接空 catch，改为**收集失败清单**返回
     （`{ rendered: number; failed: Array<{token: string; error: string}> }`）
  2. `syncTemplate` 不得静默丢弃：至少把失败写进结构化日志（`console.error` +
     token 脱敏），并在**受影响的链接**上留错误标记供面板展示
  3. 子请求预算耗尽这类"全局性失败"必须**短路后续链接**并明确上报，
     不得继续循环撞同一个错
- **等价判据**：单链接渲染失败时，其余链接仍成功渲染（现有语义保持）；
  新增单测覆盖"第 2 个链接抛错 → 第 1、3 个仍渲染成功且 `failed` 含第 2 个"。
  **注意**：`test/template.test.ts` 现有 `renderAll` 用例断言返回 `number`
  （`expect(...).toBe(2)` 之类），签名变更需同步改断言——这是**允许的行为变化**，
  须在 PR 描述标注。
- **回滚方式**：单 PR revert。若已发布需回滚，注意错误标记是**新增字段**
  （可选），旧代码读不到不影响。
- **风险**：把"静默成功"改成"显式失败"会让原本 200 的接口开始返回错误。
  这是**期望行为**，但需在 PR 里说明"用户会看到新的错误提示"。
- **执行角色**：`正确性审查` 出问题清单 + `通用开发` 落地
  （纯正确性问题、单文件为主）

### W3-1 · `deleteSub` 清理 `link.sources` 悬空引用（P1）

- **写域**：`src/subs.ts:156-159`
- **依据**（实测 `.probe/dangling.ts`）：
  ```
  删除前：collectNodes → get=6, 节点=1
  deleteSub('b'), deleteSub('c') 后
  link.sources = ["a","b","c"]   ← 未清理
  删除后：collectNodes → get=4, skipped=["来源包含已删除的订阅" ×2]
  ```
  `deleteSub`（`subs.ts:156-159`）只删 `sub:` 与 `snap:`，**不清理引用它的
  `link.sources`**。每次 `/s/` 请求为每个已删订阅白付 1 次 get，**永久持续**,
  且 `skipped` 文案永远提示"包含已删除的订阅"。
- **要求**：`deleteSub` 内清理所有 `link:{token}.sources` 中的该 id；
  或在 `collectNodes` 侧改为先 `getMany` 再过滤（W2-1 已覆盖大半，
  但**数据层清理仍应做**，否则 `sources` 数组无限增长）
- **等价判据**：新增单测——删除订阅后 `listLinks()` 返回的每个 link 的
  `sources` 不含该 id；`collectNodes` 的 `skipped` 为空。
- **回滚**：单 PR revert。
- **执行角色**：`通用开发`（存量小 bug，领域明确）

### W3-2 · `tpl:` 失效口径收口到 L3（P2）

- **写域**：`src/template.ts`、`src/subs.ts`（接口）、`src/index.ts:313,320,326`
- **依据**：ADR-001 §3.5。现状 `deleteOutput` 散在 `index.ts` 三处，
  且 `grep -n deleteOutput test/*.ts` **零覆盖**。
- **要求**：链接变更（换绑 / reset / 删除）触发的 `tpl:` 失效由 L3 内部完成，
  `index.ts` 不再直接调 `tpl.deleteOutput`
- **等价判据**：
  - 新增单测覆盖三条路径：换绑模板（`before.templateId !== after.templateId`
    → 旧缓存删除）、reset token（旧 token 缓存删除）、删除链接（缓存删除）
  - 现有 `test/template.test.ts` 15 项全绿
- **回滚**：单 PR revert。
- **风险**：`resetLinkToken`（`subs.ts:347-354`）用旧 token 派新 token，
  失效逻辑写错会导致**新 token 首次拉取命中旧缓存**（串号）。这条必须有专门单测。
- **执行角色**：`Web后端`

### W4-1 · 入口守卫 + 正则校验抽取（P2）

- **写域**：`src/index.ts`（`api()` 与 `readJson`）
- **依据**：ADR-003 §3.3
- **要求**：
  1. `readJson` 返回 `null`（JSON 非法）时**统一返回明确错误**，
     不再让各 handler 用 `b?.field` 兜成"缺少 XX"
  2. `invalidRegex(b?.include) || invalidRegex(b?.exclude)` × 4 抽成一个函数
- **等价判据**：
  - 新增单测：`POST /api/subs` 发 `{bad json` → 400 且 message 含"JSON"
  - 现有 27 个端点的正常路径行为不变（可加一组 smoke 断言）
  - 实测现状（`.probe/badjson.ts`）：
    ```
    body="{bad json"  → 现在响应「缺少订阅 URL」（误导）
    ```
- **回滚**：单 PR revert。**唯一可见行为变化**是错误文案，属允许范围。
- **执行角色**：`Web后端`

### W5-1 · 抽 `codec.ts`（P3）

- **写域**：新建 `src/codec.ts`；`src/auth.ts`（缩减）；`src/parse.ts:3`；
  `src/render.ts:4`；`src/subs.ts:6`；`src/template.ts:4`；
  `test/auth.test.ts:2-18`、`test/parse.test.ts:3`、`test/render.test.ts:4`
- **依据**：ADR-001 §3.1/§3.3
- **要求**：`b64encode`/`b64decode`/`b64urlEncode`/`b64urlDecode`/`bytesToB64`/
  `b64ToBytes`/`base32Encode`/`base32Decode`/`hex`/`errMsg`/`newId` 迁入 `codec.ts`。
  `auth.ts` 改为从 `codec` import 并**临时 re-export**（一个批次完成过渡，
  避免一次性改 6 个文件 + 3 个测试的 import）。
- **等价判据**：
  - `npx tsc --noEmit` 零输出
  - `npx vitest run` 92 项全绿
  - §5 golden sha256 全部不变（编解码是输出正确性的根基，这条最关键）
  - **反向依赖检查**：`grep -n "from './auth'" src/parse.ts src/render.ts` 无输出
- **回滚**：单 PR revert。`codec.ts` 为新增文件。
- **执行角色**：`质量审查`（目录结构 / 耦合 / 模块化属其范畴）

### W5-2 · `Env` 迁 `env.ts`（P3）

- **写域**：新建 `src/env.ts`；全部 `src/*.ts` 的 `import type { Env }`
- **依赖**：W5-1 已完成（避免同批改同一批 import 行）
- **等价判据**：同上 4 条；额外确认 `test/subs.test.ts:3`、`test/template.test.ts:2`
  的 `import type { Env } from '../src/auth'` 改为新路径后仍全绿
- **回滚**：单 PR revert。
- **执行角色**：`质量审查`

## 4. 行为等价判据：golden 基线

模块拆分与 KV 改造的**唯一可靠验收**是输出逐字节不变。基线在 `ee659eb` 上实测
（`.probe/golden.ts`，6 种协议各一个节点，经名称清洗后序列化）：

| 输出 | 字节数 | sha256 前 16 位（基线 `ee659eb`） |
|---|---|---|
| `renderClash(rules=none)` | 1631 | `c78a566cdf3b0a4f` |
| `renderClash(rules=cn)` | 1709 | `c1fdff4533b2a88d` |
| `renderSingbox(rules=none)` | 2549 | `70bb6d6c44cefa12` |
| `renderSingbox(rules=cn,official)` | 3493 | `011cf59c68a22028` |
| `renderSingbox(rules=cn,jsdelivr)` | 3481 | `79d09d4e4777d2c6` |
| `renderUri` | 1033 | `aa648480372a86d3` |
| `renderBase64` | 1380 | `86d3b5237135bc73` |
| 复解析往返（`parseSubscription(renderBase64(...))`） | 6 节点 | `37342569f1ea03e1` |

**用法**：每张卡的 PR 必须在描述里贴出改造后重跑的同一张表，与上表逐行对比。
任何一行 sha 变化都必须在 PR 里**逐字节解释原因**，否则视为行为不等价、不予合并。

> 已知的一处例外：W2-2 会改 `renderAll` 返回类型（`number` → 对象），
> 这不影响上表（上表只覆盖 `render*` 输出），但会影响 `test/template.test.ts` 断言。

## 5. 需要用户确认的事项（按 `AGENTS.md`「变更前必须与用户确认」）

本路线图**不推翻** `AGENTS.md` 六条设计决策中的任何一条，但有三处需当事人点头：

| # | 事项 | 触及的约束 | 需要确认什么 |
|---|---|---|---|
| 1 | W2-2 让模板缓存失败**显式可见**（接口可能开始返回错误） | 无直接冲突，但改变用户可见行为 | 是否接受"宁可见错，不静默旧" |
| 2 | W2-1 新增 `src/kv.ts`（新增文件） | `AGENTS.md`「不为一次性功能搭抽象层」 | 这是**长期**访问层而非一次性，需确认认可 |
| 3 | W5 新增 `codec.ts` / `env.ts`，`README.txt:九` 目录说明需同步改 | `AGENTS.md` 目标目录清单 | 目录清单变更需更新文档 |

第 2、3 条我给出的判断是"应该做"，理由是它们承载的是**每条请求都走的路径**
（KV 访问）与**每层都依赖的原语**（编解码），不属于一次性抽象。但按纪律，
仍标为待确认。

## 6. 明确不做的事

- **不拆 Worker / 不拆服务**：单管理员、2 次 cron/天、日读 2,000 量级。
  没有任何量级证据支持拆分，`AGENTS.md` 决策也不允许。
- **不引入路由框架**：ADR-003 §3.4 反例。
- **不引入 Durable Objects**：免费版约束（`AGENTS.md` 决策「全部功能设计在
  免费额度内」）。
- **不重构 `parse.ts`（991 行）**：它是正确性核心（`AGENTS.md`「工作约定」），
  且当前 24 项单测全绿、CPU 已通过"受限 YAML 子集"控制在预算内。
  行数长不是拆分理由，**没有失败场景**才是理由。
- **不统一错误码体系**：现状 `err(msg, status)` 用 HTTP 语义 + 中文文案，
  单一前端消费，够用。上错误码枚举是给多消费方准备的，本项目没有。

## 7. 批次封存检查表

每批完成后在 Issue #14 追加：

- [ ] 每张卡的 PR 已合并进 `npc/subwharf-14`
- [ ] `npx tsc --noEmit` 零输出（贴输出）
- [ ] `npx vitest run` 全绿（贴输出，注明用例数）
- [ ] §4 golden 表逐行对比（贴改造后表）
- [ ] 配额探针复测数字（贴表格）
- [ ] 回滚演练：`git revert <merge-commit>` 后能否编译 + 单测全绿

## 8. 卡与执行角色对照（派单用）

| 卡片 | 建议执行角色 | 依据（`npc-dispatch` §2.1 信号） |
|---|---|---|
| W2-1 | `Web后端` | KV 访问层、模块化单体 |
| W2-2 | `正确性审查`（出清单）+ `通用开发`（落地） | 静默成功属正确性问题；改动单文件为主 |
| W3-1 | `通用开发` | 存量小 bug、领域明确 |
| W3-2 | `Web后端` | 缓存失效 + 服务层边界 |
| W4-1 | `Web后端` | REST API 与中间件 |
| W5-1 | `质量审查` | 目录结构、耦合、模块化 |
| W5-2 | `质量审查` | 同上 |

> ⚠️ 上述角色名需与仓库 `.cnb/settings.yml` 的 `npc.roles[].name` 精确一致才能
> 召唤成功（`npc-dispatch` §0 硬约束 1）。当前仓库无该文件，**派单前先确认**。
