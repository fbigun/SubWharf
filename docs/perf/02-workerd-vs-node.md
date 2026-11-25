# node vs workerd：运行时口径差实测

- 基线提交：`ee659eb`
- 测量日期：2026-11-24
- node：v24.22.2（vitest 3.2.7）
- workerd：`wrangler dev` 本地运行时（`wrangler 4.152.0` / `workerd 1.20261019.1`）
- 探针：`test/bench/workerd/probe.ts`，与 node 侧共用 `test/bench/fixtures.ts` 夹具

---

## 为什么要单独做这一篇

T1 的要求里有一条：**哪些结论必须在 workerd 下才能确认，标 `unverified`，不许写成已通过**。

本机 node 与 workerd 是两套运行时。不开这个对照，报告里所有绝对值都只是「本机 node 的数」，拿它去论证生产 CPU 预算是不严谨的。所以我在本地起了真实 workerd，用同一套夹具、同一个采样核心跑了一遍。

**注意边界**：`wrangler dev` 是本地 workerd，不是生产边缘节点。它同构于生产运行时（同一份 V8 + Workers API 实现），但没有 Cloudflare 的调度、网络与计量层。所以：

- **可以**用它判断「node 与 Workers 运行时的相对差异」
- **不可以**用它替代生产 CPU 计量（尤其「Cloudflare 计不计 GC」这类问题）

---

## 复现方式

```bash
# 起本地 workerd（不部署、不绑 KV、不涉 secret）
npx wrangler dev --config test/bench/workerd/wrangler.jsonc --port 8811

# 另开一个终端取报告（首次请求要等编译，约 20~30s）
curl -s http://127.0.0.1:8811/ | python3 -m json.tool
```

探针文件不是 `*.bench.ts`，`vitest.bench.config.ts` 的 include 抓不到它，也不会进 CI 全量测试。

---

## 稳定性：三次连续请求

workerd 的 `performance.now()` **量化到 1ms**（Spectre 缓解）。这意味着单次测量天然带 ±1000µs 误差，所以探针里所有慢 case 都显式给了 batch（结果里带 `batch` 字段，误差上限 = 1000/batch µs）。

三次连续请求的 p50（µs）：

| case | 第 1 次 | 第 2 次 | 第 3 次 | 取用值 |
|---|---|---|---|---|
| `parseUriList` 500 明文 | 3500 | 3167 | 3500 | 3167 |
| `parseSubscription` base64 500 | 11000 | 10000 | 10500 | 10000 |
| `b64ToBytes` 140KB（现实现） | 7000 | 6250 | 7000 | 6250 |
| `b64ToBytes` 140KB（分块反事实） | 220 | 203 | 215 | 203 |
| `bytesToB64` 105KB（现实现） | 1150 | 1150 | 1200 | 1150 |
| `bytesToB64` 105KB（分块反事实） | 425 | 408 | 413 | 408 |
| `cleanNodeName` ×500 | 700 | 700 | 700 | 700 |
| `renderClash` 300 | 600 | 600 | 600 | 600 |
| `renderSingbox` 300 | 400 | 433 | 433 | 400 |
| `renderUri` 300 | 950 | 950 | 950 | 950 |
| `renderBase64` 300 | 1700 | 1700 | 1700 | 1700 |

**抖动幅度**：多数 case 三次完全一致或差一个量化档；最差的是 `parseSubscription base64`（10000~11000，10%）。在 1ms 量化下这是预期行为，不是环境不稳。

---

## node vs workerd 对照

同一份夹具、同一份采样核心。node 取 p50，workerd 取三次最小值（量化向下取整，取最小更接近真实值）。

| case | node (µs) | workerd (µs) | workerd/node | 结论 |
|---|---|---|---|---|
| `parseUriList` 500 明文 | 2969 | 3167 | 1.07× | 基本一致 |
| `parseSubscription` base64 500 | 11769 | 10000 | **0.85×** | workerd 更快 |
| `b64ToBytes` 140KB（现实现） | 8005 | 6250 | **0.78×** | workerd 更快 |
| `b64ToBytes` 140KB（分块反事实） | 235 | 203 | 0.86× | workerd 更快 |
| `bytesToB64` 105KB（现实现） | 1836 | 1150 | **0.63×** | workerd 明显更快 |
| `bytesToB64` 105KB（分块反事实） | 477 | 408 | 0.86× | workerd 更快 |
| `cleanNodeName` ×500 | 769（×400） | 700 | — | 规模不同，不可直接比 |
| `renderClash` 300 | 748 | 600 | 0.80× | workerd 更快 |
| `renderSingbox` 300 | 581 | 400 | 0.69× | workerd 更快 |
| `renderUri` 300 | 801 | 950 | **1.19×** | workerd 更慢 |
| `renderBase64` 300 | 1733 | 1700 | 0.98× | 基本一致 |

（`renderUri` 的 node 值取的是 `cpu-render.bench.ts` 的 801µs；`bytesToB64` 用的是 `cpu-codec` 的 1836µs。不同文件间的微小差异见 01 篇的噪声说明。）

### 读法

1. **workerd 在「逐字节 JS 操作」上普遍更快**（`b64ToBytes` 0.78×、`bytesToB64` 0.63×）。合理推测是 workerd 的 V8 配置在该模式下内联/优化得更激进，但**这是推测，未验证**。

2. **`renderUri` 在 workerd 上反而慢 19%**。它主要成本是 `URLSearchParams` 拼装与字符串模板；可能与该 API 在 workerd 的实现路径有关。`[unverified]`

3. **关键是排序没有变**：node 上「解码 ≫ 输出 > 解析」的结论，在 workerd 上同样成立。这也是为什么本文所有优化清单的优先级都建立在**相对关系**上，而不是绝对值上。

4. **workerd 下 base64 解码 6250µs，仍是单函数占用 10ms 预算的 62.5%**。这条结论是 workerd 实测的，不需要 `unverified` 标注。

---

## workerd 下的端到端与 O(n²) 确认

### `/s/{token}` 单请求（真实 `src/index.ts`，零延迟桩 KV）

| 场景 | workerd 耗时 |
|---|---|
| 300 节点 · 名字唯一 · clash | 2ms |
| 300 节点 · 同名清洗 · clash | 5ms |
| 500 节点 · 名字唯一 · clash | 3ms |
| 500 节点 · 同名清洗 · clash | 11ms |
| 500 节点 · 同名清洗 · singbox | 11ms |
| 500 节点 · 同名清洗 · base64 | 12ms |

**这是 workerd 实测**：500 节点同名清洗在 workerd 上是 11~12ms，超 10ms 预算。这一条不需要标 `unverified`——它就是在本项目的目标运行时上测的。

### `uniqueNames` 的平方阶在 workerd 同样成立

| 场景 | workerd |
|---|---|
| `collectNodes` 400 节点 · collide | 11ms |
| `collectNodes` 400 节点 · distinct | 1ms |
| `collectNodes` 800 节点 · collide | 42ms |
| `collectNodes` 800 节点 · distinct | 2ms |

- collide 400→800：11ms → 42ms，**×3.8**（线性应为 ×2.0）
- distinct 400→800：1ms → 2ms，**×2.0**（严格线性）

同一份代码、同一个运行时，两种名字画像给出「平方」与「线性」两条曲线。这与 node 侧的 ×3.99 一致，**不是 node 特有的抖动**。

---

## 必须先标 `[unverified]` 的结论

以下结论**在本机能测到的范围内无法确认**，谁要拿去决策，必须先补生产观测：

| # | 结论 | 为什么未验证 | 怎么验证 |
|---|---|---|---|
| 1 | Cloudflare 的 10ms CPU 计量是否含 GC 时间 | `wrangler dev` 不暴露 CPU 计量，只有墙钟 | 部署一版带 `Server-Timing: cpu;dur=...`（读 `performance.now()` 差值）的 Worker，或用 `wrangler tail` 看 CPU 时间字段 |
| 2 | 生产边缘节点上的绝对值 | 本地 workerd 的 CPU 型号、降频、邻居干扰都不同 | 生产 A/B：同一份订阅分别在改动前后抓 `/s/` 的 CPU 时间 |
| 3 | 真实 KV 单跳延迟分布 | 桩延迟是假设值（3ms） | `wrangler tail` 抓 KV 调用耗时，或临时在 `subs.ts` 里打点 |
| 4 | 6 连接上限下的并发排队行为 | 桩里 6 路并发是理想化的 | 生产环境实测「6 路并发读 vs 串行读」的端到端墙钟差 |
| 5 | isolate 内存峰值（128MB 限制） | 本地 `wrangler dev` 不强制该限制 | 在 workerd 里构造 800 节点 × sing-box 缩进输出（约 380KB body）+ 并发请求，观察是否 OOM |
| 6 | Cron Trigger 的 CPU 预算是与 HTTP 请求同额还是另计 | README 未写明，本地无法区分 | 查 Cloudflare 官方文档 + 生产 `wrangler tail` 看 cron 调用的 CPU 时间 |
| 7 | `renderUri` 在 workerd 上慢 19% 的根因 | 只有相对数字，没有 profile | 在 workerd 里对 `URLSearchParams` 相关路径做采样，或逐个 API 微基准 |

---

## 给 W2 编码卡的输入

1. **可以基于本文直接排优先级**：所有 Top-N 优化项的相对收益在 node 与 workerd 上同向，且 `b64ToBytes` 与 `uniqueNames` 两条都在 workerd 上实测确认。
2. **不要基于本文的绝对值做容量规划**：需要先补上表 #1、#2 的生产观测。
3. **验收方式建议**：每个编码卡落地后，用 `npx vitest run --config vitest.bench.config.ts` 比 p50，再用 `test/bench/workerd/probe.ts` 复测一遍 workerd 侧。两边都改善才算过——只改 node 数字的优化可能在生产上无效（`renderUri` 就是反例）。
