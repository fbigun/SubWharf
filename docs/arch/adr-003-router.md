# ADR-003：路由形态——保持 if 链

- 状态：建议采纳（待技术负责人拍板）
- 日期：2026-11-24
- 基线提交：`ee659eb`（main）
- 写域：`docs/arch/**`
- 相关：ADR-001（L4 传输层边界）

---

## 1. 结论

**保持 if 链，不引入路由表，不引入框架。**

但**要抽出「中间件」**——现状把鉴权、body 限制、JSON 解析散在分支里，这是真问题。
对策不是换路由形态，而是把 4 个横切关注点提到 `api()` 入口处的 3 行守卫。

一句话：**问题不在"怎么匹配路径"，在"每个 handler 各自重复横切逻辑"。**
换路由表解决不了后者，只会把 441 行变成 2 个文件共 500 行。

## 2. 现状量化

`api()` 函数：`src/index.ts:128-329`，**202 行**。

| 指标 | 值 | 出处 |
|---|---|---|
| API 端点数 | **27** | 手工枚举自 `index.ts` |
| 顶层分支（`p ===` / `seg[1] ===`） | 16 | `grep -cE "if \(p ===\|if \(seg\[1\]"` |
| `method ===` 判断 | 27 | 同上 |
| `readJson(req)` 调用 | 10 | `grep -c "readJson(req)"` |
| `invalidRegex(b...)` 校验 | 4 | 同上 |
| `return err(...)` 分支 | 19 | 区间内 grep |
| `await syncTemplate(env)` | 10 | `grep -c` |
| `tpl.deleteOutput` | 3 | `index.ts:313,320,326` |

27 个端点 / 202 行 = **平均 7.5 行一个端点**。这个密度是健康的——
对比常见"每个 handler 一个文件"的路由目录，同样的端点数通常要用掉 400~600 行
（每个文件 import、签名、导出样板就有 5~8 行）。

### 2.1 端点清单（从代码反推，用于判断规模）

| # | 方法 | 路径 | 需要 body | 需要登录 |
|---|---|---|---|---|
| 1 | GET | `/api/me` | - | 否 |
| 2 | POST | `/api/setup` | ✓ | 否 |
| 3 | POST | `/api/setup/verify` | ✓ | 否 |
| 4 | POST | `/api/login` | ✓ | 否 |
| 5 | POST | `/api/logout` | - | 是 |
| 6 | GET | `/api/status` | - | 是 |
| 7 | GET | `/api/pool` | - | 是 |
| 8 | POST | `/api/refresh-all` | - | 是 |
| 9 | GET | `/api/templates` | - | 是 |
| 10 | POST | `/api/templates` | ✓ | 是 |
| 11 | POST | `/api/templates/refresh` | - | 是 |
| 12 | PUT | `/api/templates/:id` | ✓ | 是 |
| 13 | DELETE | `/api/templates/:id` | - | 是 |
| 14 | POST | `/api/templates/:id/refresh` | - | 是 |
| 15 | GET | `/api/subs/:id/nodes` | - | 是 |
| 16 | POST | `/api/subs` | ✓ | 是 |
| 17 | PUT | `/api/subs/:id` | ✓ | 是 |
| 18 | DELETE | `/api/subs/:id` | - | 是 |
| 19 | POST | `/api/subs/:id/refresh` | - | 是 |
| 20 | GET | `/api/nodes` | - | 是 |
| 21 | POST | `/api/nodes` | ✓ | 是 |
| 22 | DELETE | `/api/nodes/:id` | - | 是 |
| 23 | GET | `/api/links` | - | 是 |
| 24 | POST | `/api/links` | ✓ | 是 |
| 25 | PUT | `/api/links/:id` | ✓ | 是 |
| 26 | POST | `/api/links/:id/reset` | - | 是 |
| 27 | DELETE | `/api/links/:id` | - | 是 |

16 个需要 body（全部是 POST/PUT），**其中 4 处额外做正则校验**
（`index.ts:227,245,300,308`）。注意这 4 处是**同一个校验重复了 4 遍**：

```ts
if (invalidRegex(b?.include) || invalidRegex(b?.exclude)) return err('节点筛选正则表达式无效');
```

## 3. 决策论证

### 3.1 为什么 if 链够用

**判据不是"行数"，是"新增一个端点要改几处"。**

现状新增 `POST /api/links/:id/foo`：插入 1 个 `if` 块（约 6 行），不动任何已有代码。
这是 if 链**最好**的性质——零耦合、零注册、零字典维护。

路由表能改善的只有"查找是 O(1) 而非 O(n)"。**但 n=27，且这是字符串比较**，
不是数据库查询。`if` 链平均命中在第 13.5 个分支，每次比较是几纳秒的
`p === '/api/...'`。27 次字符串比较总计 < 1μs，而免费版 CPU 预算是 **10ms**。
**路由匹配占 CPU 预算 < 0.01%。** 用路由表换来的是 0.01% → 0.004%，
这个优化没有任何用户可感知的效果。

> 对照：本项目真正接近 10ms CPU 预算的地方是 `parse.ts`（991 行解析器）与
> `render.ts`（序列化）。`AGENTS.md` 决策 5 为此专门做了"轻解析 + 受限 YAML 子集"。
> 把注意力放在路由上是**优化错了对象**。

### 3.2 为什么"路由表 + handler 签名统一"也不行

初审提的方案是「路由表 + handler 签名统一」。逐条评估：

| 收益 | 是否真实 | 说明 |
|---|---|---|
| 中间件统一 | **真实，但不需要路由表** | 见 3.3，3 行守卫即可 |
| handler 签名统一 | **真实，但可以用类型别名** | 不需要表也能统一 |
| 新增端点不复制 | **部分真实** | 复制的是 4 处正则校验和 10 处 `syncTemplate`，不是路由 |
| 路径匹配可读 | 主观 | 27 个 `if` 在一个函数里，`Ctrl+F` 就能找 |

**关键论据：路由表解决不了现状里真正重复的东西。**

现状重复的是：

1. `readJson(req)` × 10 —— 每次都要处理 `null`（解析失败）的返回值
2. `invalidRegex(b?.include) || invalidRegex(b?.exclude)` × 4 —— 逐字重复
3. `await syncTemplate(env)` × 10 —— 8 处是"写完后重渲染"，2 处是模板操作
4. `if (!rec) return err('...不存在', 404)` × 6 —— 存在性检查样板

这四条**全部与路由形态无关**。换成路由表后，你仍然要在每个 handler 里
写 `readJson`、写正则校验、写 `syncTemplate`。**改动量不减，只是挪了位置。**

### 3.3 真正的对策：入口守卫（不换路由形态）

在 `api()` 里把横切关注点提为 3 个守卫，**改动集中在 1 处入口 + 每个 handler 减 1~2 行**：

```ts
async function api(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname;
  const method = req.method;

  // 守卫 1：公开端点白名单（现状 index.ts:132-138 已是这个形状，保留）
  // 守卫 2：鉴权（现状 index.ts:141，已是单点，保留）
  // 守卫 3：body 按需解析 —— 只在需要时读，且解析失败统一 400
  //        现状：每个 handler 各自 readJson + 各自判断 null（10 处）
}
```

现在的问题具体是：`readJson` 解析失败返回 `null`（`index.ts:368-370`），
各 handler 用 `b?.field` 可选链兜底，**没有一处对"body 不是合法 JSON"报明确错误**。
实测：`POST /api/subs` 发 `{bad json` → `b` 为 `null` → `b?.url` 为 `undefined`
→ 返回 `缺少订阅 URL`（400）。**错误文案误导**（用户发的是坏 JSON，被告知缺字段）。

这是本 ADR 认为**必须修**的一点，但它同样不需要路由表：

```ts
// 在入口统一：需要 body 的写端点，body 必须可解析
const needsBody = method === 'POST' || method === 'PUT';
if (needsBody) { const b = await readJson(req); if (b === null) return err('请求体不是合法 JSON', 400); }
```

### 3.4 反例：为什么另外两条路都不行

**反例 A：引入 Hono / itty-router 等 Workers 路由框架**

- 违反 `AGENTS.md`「无框架、无构建链」
- 违反本项目「依赖从简：新增依赖先说明必要性」
- 框架的中间件模型要求 handler 签名统一成 `(c) => Response`，**27 个 handler 全部重写**
- 收益是 `c.req.param('id')` 替代 `seg[2]`，**节省不到 50 行**
- 依赖健康度四查（本项目版本）：框架自身的 release 节奏、CVE 面、license
  都要持续跟进，而它替我们解决的问题量级是 μs

**具体反例说明**（为什么不是"以后再说"）：`seg` 切分（`index.ts:129`
`p.split('/').filter(Boolean)`）在 27 个端点里被以 3 种模式消费：
`seg.length === 2/3/4` + `seg[3] === 'refresh' | 'nodes' | 'reset'`。
路由框架的 `:id` 参数模式**表达不了** `seg[3] === 'refresh'` 这种
"第 4 段是固定动词"的语义——要么用嵌套路由（`/api/templates/:id/refresh`
变成子路由组），要么在 handler 里再判一次。**多数情况下框架版本会更长。**

**反例 B：`Map` 路由表 + 正则路径模板（无框架，纯手写）**

这是初审提到的最合理方向，但仍然不划算。写出来是这样：

```ts
const ROUTES: Array<[string, RegExp, Handler]> = [
  ['GET', /^\/api\/subs\/([^/]+)\/nodes$/, ...],
  ['POST', /^\/api\/subs\/([^/]+)\/refresh$/, ...],
  // …27 条，每条含一个正则
];
```

问题：

1. **27 个正则字面量**，每个都要编译（或预编译成常量）。正则匹配比字符串
   `===` 慢 —— 对 `p=/api/status` 这种精确路径，要试完前面所有正则才命中。
2. **丢失精确匹配的明确性**：`/api/templates/refresh` 会被
   `/^\/api\/templates\/([^/]+)$/` 这条**先命中**（如果顺序在前），把
   `"refresh"` 当成 `:id`。这是路由表经典的**顺序陷阱**，`if` 链里
   根本不存在（`p === '/api/templates/refresh'` 精确匹配优先）。
3. 加 1 条路由 = 往数组里插 1 行，**但插错位置就静默改行为**。`if` 链插错位置
   的后果同样，但至少插入点在函数里可见，且精确匹配天然免疫顺序问题。

> 若一定要表驱动，唯一可接受形态是
> `Map<string /* `${method} ${path}` */, Handler>` 精确匹配 + 单独处理 5 个
> 带 `:id` 的端点。这在 27 个端点里只能覆盖 22 个，剩下 5 个仍要 if。
> **为了覆盖 22/27 而引入一层间接，不值。**

### 3.5 什么情况下本决策应当推翻

明确的推翻条件（写给未来，避免拍脑袋）：

- 端点数 **> 50**，且新增端点频率 > 2 个/月 → 重新评估表驱动
- 出现**同路径不同 version** 的诉求（`/api/v2/*`）→ 那时需要前缀路由组，
  if 链会开始难维护
- 出现**按角色/权限区分端点**的诉求 → 中间件模型才有意义
  （但 `AGENTS.md` 决策 6 明确「单管理员 + 不开放多用户」，此路已封）

当前 27 个端点、单管理员、无版本诉求 → **三条全不满足**。

## 4. 对初审候选问题 3 的结论

> **候选问题 3：路由手写 if 链，是否值得走路由表 —— 结论：不成立（不该换）。**

- 「`src/index.ts` 441 行」—— 事实成立（`wc -l` = 441），但 `api()` 只占 202 行，
  其余是 `fetch`/`scheduled` 入口、`serveSubscription`、`setup`/`login` 三个认证流程
- 「`api()` 内按 `seg[]` 判断」—— 事实成立
- 「中间件散在分支里，新增端点靠复制」—— **成立，且这才是真问题**
- 「是否值得走路由表」—— **不值得**

初审的直觉（"别为 20 条路由引入框架"）是对的，但**推论要再进一步**：
不是"别引框架、但该引表"，而是"**表和框架都不需要，需要的是入口守卫**"。

真正该修的 3 件事（按收益排序）：

1. **`readJson` 解析失败无明确报错**（10 处，误导性文案）—— 入口守卫，~5 行
2. **正则校验重复 4 遍**（`index.ts:227,245,300,308`）—— 抽 `validateLinkFilters(b)`，~8 行
3. **`deleteOutput` 散在 3 处且零测试覆盖** —— 归 ADR-001 §3.5

这三条加起来 ~20 行改动，收益大于 27 个 handler 全量重写。

## 5. 后果

**正面**

- 零新增依赖、零新增文件、零 CPU 开销
- 新增端点仍是"插一个 if"，心智负担最低
- 改动集中在入口守卫，可在一个小 PR 内完成并验证

**负面（诚实的代价）**

- `api()` 保持 ~200 行，会长到 250 行左右（守卫 + 未来端点）
- `if` 链的顺序在带 `:id` 的端点间仍有微妙依赖：
  `seg.length === 3` 的 PUT 必须在 `seg.length === 4` 的判断之后吗？实际不会
  （长度不同互斥），但未来若加 `/api/subs/:id/:action` 需要留意
- **本 ADR 主动放弃了"路由可自描述"**：没有一张表能一眼看完所有端点。
  缓解手段：在 `api()` 顶部维护注释版端点清单（即 §2.1 的表）

## 6. 落地卡片

见 `roadmap.md` 的 **W4 批次**，仅一张卡：

- **W4-1 入口守卫 + 正则校验抽取**：写域 `src/index.ts` 单文件；
  行为变化有一处（坏 JSON 从"缺少 XX"改为"请求体不是合法 JSON"），
  需在 PR 描述显式标注并更新 `test/` 对应断言（当前无该用例，需新增）。
