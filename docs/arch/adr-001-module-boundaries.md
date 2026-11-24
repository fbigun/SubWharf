# ADR-001：模块边界与依赖方向

- 状态：建议采纳（待技术负责人拍板）
- 日期：2026-11-24
- 基线提交：`ee659eb`（main）
- 写域：`docs/arch/**`（本 ADR 不改 `src/`）
- 相关：`AGENTS.md` 六条设计决策、`README.txt`「二、总体架构」「四、KV 数据模型」

---

## 1. 背景

SubWharf 是单 Worker、无框架、无构建链的 TypeScript 单体。当前 7 个源文件共 3155 行
（`auth 263 / index 441 / parse 991 / rename 362 / render 302 / subs 495 / template 301`）。

单体不是问题，问题是**边界没有被表述过**，所以每加一个功能都只能照最像的旧代码复制。
本 ADR 把边界写死成可机械检查的 import 规则，供后续编码卡落地。

一条重要的现实约束：**Workers 的模块边界与 Go 的包边界代价不同**。这里是同一个
isolate 内的 ES 模块，拆分本身零运行时成本（不含额外 fetch/binding）。所以本 ADR
追求的不是"物理隔离换隔离性"，而是**让依赖方向可判定**——因为一旦可判定，
"该文件该不该 import 那个模块"就不再是审美问题，而是能写进 review checklist 的规则。

## 2. 现状：实际 import 关系

实测（`grep -n "^import" src/*.ts`，基线 `ee659eb`）：

```ts
// src/index.ts:3-23
import type { Env, Profile } from './auth';
import { clearLoginFail, clearSessionCookie, createSession, generateTotpSecret, getSessionId,
         hashPassword, loginLockRemaining, otpauthUri, recordLoginFail, sessionCookie,
         timingSafeEqual, unwrapField, verifyPassword, verifyTotp, wrapField } from './auth';
import * as subs from './subs';
import * as tpl from './template';
import { renderBase64, renderClash, renderSingbox, renderUri, ... } from './render';

// src/parse.ts:3      ← 解析层反向依赖认证层
import { b64decode, b64urlDecode, errMsg } from './auth';

// src/render.ts:3-4   ← 序列化层反向依赖认证层
import type { ProxyNode } from './parse';
import { b64encode, b64urlEncode } from './auth';

// src/subs.ts:5-8
import type { Env } from './auth';
import { errMsg, hex, newId, unwrapField, wrapField } from './auth';
import { parseNodeUri, parseSubscription, type ProxyNode } from './parse';
import { cleanNodeName } from './rename';

// src/template.ts:3-7  ← 与 subs 双向
import type { Env } from './auth';
import { errMsg, newId } from './auth';
import type { ProxyNode } from './parse';
import { singboxOutbound } from './render';
import { collectNodes, listByPrefix, listLinks, readTextLimited, setLinkTemplate, type LinkRec } from './subs';
```

### 2.1 现状依赖图

```
                        ┌──────────────────────────────────────┐
                        │            auth.ts  (263L)           │
                        │  密码 / TOTP / 会话 / AES-GCM         │
                        │  ★ base64 / base32 / hex 编解码       │
                        │  ★ errMsg 通用错误提取                │
                        │  ★ newId / timingSafeEqual            │
                        └───▲────▲────▲────▲────────────▲──────┘
                            │    │    │    │            │
        ┌───────────────────┘    │    │    │            └──────────────────┐
        │                        │    │    │                               │
   ┌────┴─────┐            ┌─────┴─┐  │  ┌─┴──────┐              ┌─────────┴────────┐
   │ parse.ts │            │subs.ts│  │  │index.ts│              │   template.ts    │
   │  991L    │            │ 495L  │  │  │ 441L   │              │      301L        │
   └────┬─────┘            └───┬───┘  │  └────────┘              └─────────┬────────┘
        │                      │      │                                  │
        │                      │      └──────────► render.ts ◄───────────┘
        │  ProxyNode           │                    302L
        └──────────────────────┴──────────► render.ts
                               │                   ▲
                               │  cleanNodeName    │
                               └──────────► rename.ts (362L)

        subs.ts ◄──────────────────────────────────── template.ts   ← ★ 双向依赖
```

**★ 标记即问题所在**：三个底层领域模块（`parse`、`render`、`subs`）为了几个
与认证毫无关系的纯函数，反向依赖了认证层。

### 2.2 反向依赖的定量盘点

用「符号 × 外部消费者」矩阵核对（`src/auth.ts` 共 29 个导出）：

| 导出符号 | 语义归属 | 外部消费者 | 判定 |
|---|---|---|---|
| `b64decode` | 编解码 | `parse.ts`、`render.test`、`auth.test` | **错位** |
| `b64urlDecode` | 编解码 | `parse.ts` | **错位** |
| `b64encode` | 编解码 | `render.ts`、`parse.test`、`auth.test` | **错位** |
| `b64urlEncode` | 编解码 | `render.ts`、`parse.test` | **错位** |
| `hex` | 编解码 | `subs.ts` | **错位** |
| `newId` | 标识生成 | `subs.ts`、`template.ts` | **错位** |
| `errMsg` | 通用错误 | `parse.ts`、`subs.ts`、`template.ts` | **错位**（最分散） |
| `timingSafeEqual` | 安全原语 | `index.ts`、`auth.test` | 合理（认证语义） |
| `wrapField` / `unwrapField` | 密钥封装 | `index.ts`、`subs.ts` | 合理（`subs` 需存加密订阅 URL，见 `subs.ts:115`） |
| `hashPassword` / `verifyPassword` / `verifyTotp` / `otpauthUri` / `generateTotpSecret` | 认证 | `index.ts` | 正确 |
| `createSession` / `sessionCookie` / `clearSessionCookie` / `getSessionId` | 会话 | `index.ts` | 正确 |
| `loginLockRemaining` / `recordLoginFail` / `clearLoginFail` | 限速 | `index.ts` | 正确 |
| `bytesToB64` / `b64ToBytes` / `base32Encode` / `base32Decode` / `PBKDF2_ITERATIONS` | 编解码 / 认证 | 仅 `auth` 内部 | 非问题 |

**结论：7 个符号错位，占 29 个导出的 24%。** 它们集中在三条正交关注点上：
编解码（6 个）、标识生成（1 个）、错误提取（1 个）。`auth.ts:1-2` 的注释自己
承认了这个混装：「base64/base32 等二进制编码工具也集中在此，供 parse / render 复用」。

> 这不是"文件太长该拆"的审美判断。判据是**变化原因**：`auth.ts` 会因为
> 「密码策略变了」而改，也会因为「base64url 要兼容某个客户端的填充差异」而改。
> 两个不相关的变化源被绑在一个文件里，任何一方改动都要回归另一方的测试面。

## 3. 决策

### 3.1 五层划分

按「变化原因」而非「代码相似度」分层：

| 层 | 模块 | 一句话职责 | 允许 import |
|---|---|---|---|
| **L0 codec** | `codec.ts`（新建） | 纯编解码与通用原语：base64/base64url/base32/hex、`errMsg`、`newId` | 无（仅 Web 标准 API） |
| **L1 domain** | `parse.ts`、`rename.ts`、`render.ts` | 订阅解析 / 节点名清洗 / 输出序列化。**无 I/O、无 `Env`** | L0 |
| **L2 store** | `kv.ts`（新建）+ `auth.ts`(缩减) | KV 访问契约（见 ADR-002）；认证与会话 | L0 |
| **L3 domain-service** | `subs.ts`、`template.ts` | 订阅/节点/链接管理；模板渲染与缓存 | L0、L1、L2 |
| **L4 transport** | `index.ts` | 路由、中间件、HTTP 编解码、错误映射 | 全部 |

`Env` 接口（`auth.ts:4-10`）是 5 个字段的运行时绑定描述，被所有层引用。
它不是"认证概念"——**必须搬到 `env.ts` 或被 `kv.ts` 重新导出**，否则
L1/L3 都得为了拿类型去 import 认证模块，反向依赖永远修不干净。

### 3.2 目标 import 关系（单向，无环）

```
  ┌──────────────────────────────────────────────────────────────┐
  │  L4  transport            index.ts                           │
  └───────┬──────────────┬───────────────┬───────────────────────┘
          │              │               │
          ▼              ▼               ▼
  ┌──────────────┐ ┌─────────────┐ ┌──────────────────────────┐
  │  L3 subs.ts  │ │template.ts  │ │  L2 auth.ts (认证/会话)   │
  └───┬──────┬───┘ └──┬───────┬──┘ └────────────┬─────────────┘
      │      │        │       │                 │
      │      │        │       └────────────────►│ (读 profile/login:fail)
      │      │        │                         │
      │      │        └──────────┐              │
      │      └─────────┐         │              │
      ▼                ▼         ▼              ▼
  ┌──────────────────────────────────────────────────────────┐
  │  L1  domain:  parse.ts   rename.ts   render.ts            │
  │       （零 I/O、零 Env、纯函数，可被独立单测）              │
  └───────────────────────────┬──────────────────────────────┘
                              ▼
  ┌──────────────────────────────────────────────────────────┐
  │  L0  codec.ts:  b64/b64url/base32/hex, errMsg, newId      │
  └──────────────────────────────────────────────────────────┘

  L2 kv.ts（新增）独立于 L1，只依赖 L0：
  ┌──────────────────────────────────────────┐
  │  L2  kv.ts:  KV 访问契约（ADR-002）        │
  └──────────────────────────────────────────┘
```

### 3.3 禁止边（可机械检查）

| # | 禁止 | 现状 | 违例位置 |
|---|---|---|---|
| B1 | L0/L1 不得 import `auth.ts` | ❌ 已违反 | `parse.ts:3`、`render.ts:4` |
| B2 | L1 不得 import L2/L3/L4 | ✅ 未违反 | — |
| B3 | L1 不得出现 `Env` / `fetch` / `env.KV` | ✅ 未违反 | — |
| B4 | `template.ts` (L3) 不得与 `subs.ts` (L3) 双向依赖 | ❌ 已违反 | `template.ts:7` → `subs`；语义上 `subs` 不感知模板 |
| B5 | L4 以外的模块不得读 `cookies` / `Request` / `Response` | ✅ 未违反 | `index.ts` 独有 |
| B6 | 除 `index.ts` 外不得写 HTTP 状态码与文案 | ✅ 未违反 | `index.ts:26-27` 的 `json`/`err` |
| B7 | L0 之外不得重复实现同一编解码 | ⚠️ 待查 | `render.ts` 自身无 base64 实现，暂无重复 |

> B1 的检查命令（放进 CI 前的 review 清单）：
> ```bash
> grep -n "from './auth'" src/parse.ts src/rename.ts src/render.ts && echo "违例 B1"
> ```

### 3.4 关键取舍：`template` 与 `subs` 谁是所有者

**问题**（对应初审候选问题 4）：`template.ts:7` 从 `subs.ts` 引 5 个符号
（`collectNodes`、`listByPrefix`、`listLinks`、`readTextLimited`、`setLinkTemplate`），
而 `subs.ts` 完全不提"模板"（`grep -c template src/subs.ts` 的 11 次命中全是
`templateId` 字段名与注释，无逻辑依赖）。**这是一条单向边，但方向错了**：

- `template.ts` 关心链接（要按链接渲染、要写 `tpl:{token}`），所以它必须读链接
- `subs.ts` 不关心模板，但它持有链接的所有权（`LinkRec` 定义在 `subs.ts:38-51`）

真正的耦合点是**链接的写权限**：`template.ts:184` 调 `setLinkTemplate()` 改链接记录，
而链接的 KV 键归 `subs.ts` 管。这是"跨模块直连他人存储"的变体。

**决策**：保留 `LinkRec` 在 `subs.ts`（数据所有权明确），但把
`setLinkTemplate` 的调用权收回：`template.ts` 只暴露
`getLinksBoundTo(templateId)` 与 `unbindLinks(templateId)` 语义的**查询**，
解除绑定由 L4（`index.ts`）在删除模板的用例里编排。

理由：删除模板是**跨两个聚合的事务性用例**（模板记录 + 链接绑定 + 渲染缓存），
它不该藏在 `deleteTemplate` 内部（现状 `template.ts:178-187` 就在里面干了三件事）。
但**这不构成本批次必须改的阻塞项**——见 roadmap 卡片 W3-3，按优先级排后。

> ⚠️ 与 `AGENTS.md` 的关系：本条不触及「六条设计决策」任何一条，无需用户确认。
> 但它会改变 `deleteTemplate` 的调用签名，属于**行为可见的 API 变更**，
> 落地前需在 PR 描述里显式标出（见 roadmap 等价判据）。

### 3.5 `index.ts` 中的双向清理为何要收口

现状散落三处（`index.ts`）：

```ts
313:      if (before?.templateId !== rec.templateId) await tpl.deleteOutput(env, rec.token);  // PUT link 换绑
320:      await tpl.deleteOutput(env, seg[2]);                                              // POST link reset
326:      await tpl.deleteOutput(env, seg[2]);                                              // DELETE link
```

这不是"代码难看"，而是**缓存失效口径写在传输层**。三个后果：

1. 新增一个"改链接"的入口（比如批量导入）必然忘掉第 313 行的条件判断
2. `deleteOutput` 在 `test/` 里**零覆盖**（`grep -n deleteOutput test/*.ts` 无命中），
   改错没人发现
3. `resetLinkToken` 用旧 token 变出新 token（`subs.ts:347-354`），第 320 行删的是
   **旧 token** 的缓存——这是对的（新 token 无缓存），但正确性依赖调用方记得

**决策**：缓存失效随领域操作走，不随 HTTP 入口走。目标形态是
`subs.updateLink()` 内部在 `templateId` 变化时发失效事件，或由 L3 提供一个
`onLinkChanged(before, after)` 的单点。本 ADR 只定方向，实现见 roadmap W3-2。

## 4. 对初审候选问题 4 的结论（边界模糊）

> **候选问题 4：`template` 与 `subs` 缺明确所有者 —— 结论：成立，但定性需修正。**

初审描述的两点逐条核对：

**（a）「`template.ts` 直接调 `subs.ts` 的 `listLinks` / `setLinkTemplate`」——成立。**
`template.ts:7` 一行 import 引 5 个符号；实际调用点：

| 调用 | 位置 | 用途 |
|---|---|---|
| `listByPrefix` | `template.ts:131` | 列出模板 |
| `listLinks` | `template.ts:181, 243, 258, 280` | 四处遍历链接（删模板 / 渲染 / 清缓存 / 状态） |
| `setLinkTemplate` | `template.ts:184` | 删除模板时解绑链接 |
| `collectNodes` | `template.ts:221` | 渲染时取节点 |
| `readTextLimited` | `template.ts:196` | 拉模板响应限流 |

**（b）「`subs.ts` 又不知道模板存在」——成立。** `subs.ts` 里 `template` 的
11 处文本命中全部是 `templateId` 字段名与注释文字，**无一处逻辑依赖** `template.ts`。

修正点：初审说这是"双向清理散落"，**但清理本身不是双向的**。
实际是「`template` 单方面操作 `subs` 拥有的数据」：

```
template.ts ──写 link:{token}.templateId──► subs 拥有的 KV 键     ← 越界写
subs.ts     ──完全不感知──►  template                            ← 无反向依赖
index.ts:313,320,326 ──删 tpl:{token}──► template 拥有的 KV 键    ← 越界删
```

三条边里，`template → subs` 是**模块间依赖**（可接受，方向清晰），
另外两条是**跨模块直连他人存储**（违反 ADR-001 §3.3 的精神：谁拥有数据谁提供接口）。

**结论：问题成立，但"所有者在哪"不是"缺所有者"，而是"所有权被两处越界"。**

明确的所有者应当是：

| 数据 | 所有者 | 允许的写入口 |
|---|---|---|
| `link:{token}`（含 `templateId`） | `subs` | 只有 `subs` 的函数（`updateLink` / `setLinkTemplate`） |
| `tpl:{token}` | `template` | 只有 `template` 的函数 |
| 删除模板的**跨聚合用例** | **`index.ts`（L4）编排** | L4 依次调 `tpl.deleteTemplate`、`tpl.deleteOutput`、`subs.setLinkTemplate` |

现状违反点：
- `template.ts:184` 直接改 `link:` 记录（虽然是调 `subs.setLinkTemplate` 而非直写 KV，
  形式上守规矩，但**语义上让 template 知道了链接绑定的存在**）
- `index.ts:313,320,326` 直接删 `tpl:` 键（`tpl.deleteOutput` 是 `template` 的公开函数，
  形式合法，但**失效时机的决策权在传输层**，这才是真问题）

**定量：这三行零测试覆盖**（`grep -n deleteOutput test/*.ts` 无命中），
改动风险由 roadmap W3-2 承担。

优先级判断：这条**不是 P0**。它不会导致功能失败，只是让"新增一个改链接的入口"
时容易漏掉失效逻辑。排 W3（P2），在 W2 的 P0 之后再动。

## 5. 对初审候选问题 1 的结论

> **候选问题 1：依赖方向倒挂 —— 结论：成立。**

证据（全部已核对）：

- `src/auth.ts:1-2` 注释自认混装编解码
- `src/parse.ts:3` `import { b64decode, b64urlDecode, errMsg } from './auth'`
- `src/render.ts:4` `import { b64encode, b64urlEncode } from './auth'`
- `src/subs.ts:6` `import { errMsg, hex, newId, unwrapField, wrapField } from './auth'`
- `src/template.ts:4` `import { errMsg, newId } from './auth'`
- 7/29 个导出错位（见 §2.2）

补充一条初审未提的点：`newId`（`auth.ts:61`）**不是**认证概念，它只是
8 字节随机 hex，用于 `sub.id` / `node.id` / `template.id`。`subs.ts` 与
`template.ts` 为它 import 认证层，是最纯粹的形式倒挂。

但初审里「`auth.ts` 同时装五件事」的表述要修正：`auth.ts` 装的是
**四件**（认证、会话、AES 封装、编解码），base64/base32/hex 归一件（编解码）。
拆成 5 个文件不是目标——目标是 L0 一个文件收走编解码 + 通用原语。

## 6. 后果

**正面**

- 依赖方向可机械检查（B1 一行 grep 即可）
- `parse` / `render` / `rename` 变成零依赖纯函数模块，单测无需构造 `Env`（现状
  `test/parse.test.ts:3` 必须 import `auth` 才能构造测试输入，属于测试被耦合拖累）
- `auth.ts` 缩减到 ~180 行，只保留认证语义，安全 review 面收窄

**负面（必须承认）**

- 新增 `codec.ts` / `env.ts` 两个文件，`README.txt:九` 的目录说明要同步更新
- 一次性改动 6 个源文件的 import 行，与在途分支冲突概率高 → 建议单独占一个批次
- `codec.ts` 与 `auth.ts` 之间的边界会有人想模糊（比如 `timingSafeEqual` 放哪）。
  本 ADR 的判据是：**与密钥/凭据无关 → codec；与密钥/凭据有关 → auth**。
  `timingSafeEqual` 虽然通用，但它的存在理由是防时序侧信道（`auth.ts:98` 注释），
  归 auth。

**不做会怎样**

不拆也能继续加功能。代价是每新增一个消费方，都会再从 `auth` 引一次编解码，
错位符号从 7 个涨到 10 个，最终 `auth.ts` 变成第二个 `utils`。这条路径的问题
不是"丑"，而是**review 时无法说"不"**——没有规则，就没有违例。

## 7. 迁移顺序（摘要，详见 roadmap.md）

1. **W3-1**：抽 `codec.ts`，`auth.ts` 改为从中 import 并 re-export 过渡
2. **W3-2**：`parse` / `render` / `subs` / `template` 改从 `codec` 引，删除 `auth` re-export
3. **W3-3**：`Env` 迁到 `env.ts`；`template` 与 `subs` 的绑定写权收口

每步行为等价判据：`npx tsc --noEmit` + `npx vitest run` 92 项全绿 + `/s/{token}`
四种 target 输出与基线逐字节一致（构造固定订阅样本，比对 sha256）。
