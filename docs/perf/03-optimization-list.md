# 优化清单（Top-N）

- 基线提交：`ee659eb`
- 依据：[01-baseline.md](01-baseline.md)（node 基线）、[02-workerd-vs-node.md](02-workerd-vs-node.md)（workerd 实测）
- 收益数字来源：`test/bench/counterfactual.bench.ts`，每项都附等价性断言
- 本卡**不改 `src/`**；下面所有「反事实」实现只活在基准文件里，作为 W2 编码卡的验收靶子

---

## 优先级总览

| # | 项 | 级别 | 位置 | 实测收益 | 风险 |
|---|---|---|---|---|---|
| 1 | `uniqueNames` 线性探测 → Map 记序号 | **P1** | `subs.ts:430-442` | 400 节点 11993µs → 94µs（127×） | 低 |
| 2 | base64 解码分块写回 | **P1** | `auth.ts:34-36` | 140KB 8519µs → 242µs（35×） | 低 |
| 3 | base64 编码分块 apply | **P1** | `auth.ts:28-32` | 105KB 1837µs → 473µs（3.9×） | 低 |
| 4 | `collectNodes` 串行 KV 读 → 6 路分批 | **P1** | `subs.ts:449-476` | 墙钟 50.5ms → 9.3ms | 中 |
| 5 | 去重键改定序字段数组 | P2 | `subs.ts:411-416` | 300 节点 609µs → 304µs | 中（键内容变） |
| 6 | sing-box 输出支持 compact | P2 | `render.ts:191-217` | 体积 −35%，耗时 764µs → 337µs | 低 |
| 7 | 请求级 KV memo | P2 | `subs.ts` 采集层 | 重复请求 KV 读 17 → 1 | 中（一致性） |
| 8 | YAML 标量转义快路径 | P3 | `render.ts:25` | 35µs → 11µs（占比小） | 低 |
| 9 | `cleanNodeName` 别名正则 | — | `rename.ts:253` | 不建议改（0.77ms/400 节点） | — |

---

## P1-1 · `uniqueNames` 去掉平方探测

**位置**：`src/subs.ts:430-442`

```ts
function uniqueNames(nodes: CollectedNode[]): void {
  const used = new Set<string>();
  for (const n of nodes) {
    if (!used.has(n.name)) { used.add(n.name); continue; }
    let i = 2;
    while (used.has(`${n.name} #${i}`)) i++;   // ← 每个重名节点都从头数
    n.name = `${n.name} #${i}`;
    used.add(n.name);
  }
}
```

**机制**：第 k 个同名节点要从 `#2` 数到 `#k`，每个候选一次模板字符串拼接 + 一次 Set 查询，合计 Σk = O(n²)。

**为什么这是真实场景**：`cleanNodeName` 把 `🇭🇰 香港 01`…`🇭🇰 香港 200` 全部清洗成「香港」。同一机场同一地区几十上百个节点极常见，一旦清洗开启就必然撞名。

**实测**（`counterfactual.bench.ts` > `uniqueNames：线性探测 vs Map 记序号`）：

| 同名节点数 | 现实现 µs | 反事实 µs | 倍数 |
|---|---|---|---|
| 200 | 2576 | 43 | 59× |
| 400 | 11993 | 94 | 127× |
| 800 | 53057 | 195 | 272× |

**workerd 交叉确认**：`collectNodes` 400 节点 collide 11ms vs distinct 1ms；800 节点 42ms vs 2ms（02 篇）。

**建议实现**：

```ts
function uniqueNames(nodes: CollectedNode[]): void {
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();
  for (const n of nodes) {
    if (!used.has(n.name)) { used.add(n.name); continue; }
    let i = nextSuffix.get(n.name) ?? 2;
    let candidate = `${n.name} #${i}`;
    while (used.has(candidate)) { i++; candidate = `${n.name} #${i}`; }
    nextSuffix.set(n.name, i + 1);
    n.name = candidate;
    used.add(candidate);
  }
}
```

**收益**：把这条路径从「平方」压回「线性」。500 节点同名清洗的 `/s/` 请求从 13.2ms 掉到约 5ms 量级（workerd 上 11ms → 约 3ms）。

**验证方法**：
1. `npx vitest run` 全绿（`test/subs.test.ts` 已有「同名不同节点追加序号」用例，断言 `[M] HK` / `[M] HK #2`）
2. `npx vitest run --config vitest.bench.config.ts`，对比 `cpu-aggregate` 的 collide 三档：增长因子应从 2.00 降到 1.00
3. 补充边界用例：`['a','a','b','a']` → `['a','a #2','b','a #3']`；`['a #2','a','a']` → 需确认 `a #2` 已占用时 `a` 的序号从 3 开始

**可回滚**：纯函数，行为等价。

**等价性证据**（`counterfactual.bench.ts` > `uniqueNames：线性探测 vs Map 记序号`）：
- 200/400/800 三档同名节点，输出逐项一致
- 6 组「名字本身含 `#N`」的边界输入全部一致：

| 输入 | 两种实现的输出 |
|---|---|
| `a, a, b, a` | `a, a #2, b, a #3` |
| `a #2, a, a` | `a #2, a, a #3` |
| `a, a #2, a` | `a, a #2, a #3` |
| `a, a, a #2, a #3` | `a, a #2, a #2 #2, a #3` |
| `香港, 香港 #2, 香港, 香港` | `香港, 香港 #2, 香港 #3, 香港 #4` |

**风险评估**：我一开始担心「名字本身带 `#2` 时 Map 版会跳过别人的后缀」，实测**这个担心不成立**——Map 记的是 `n.name` 的**下一次候选序号**，而 `used.has(candidate)` 的 while 循环仍会跳过任何已被占用的名字，两者语义完全相同。

W2 落地时仍建议把这 6 组作为回归用例写进 `test/subs.test.ts`（当前测试只覆盖了 `['HK','HK'] → ['[M] HK','[M] HK #2']`）。

---

## P1-2 · base64 解码分块写回

**位置**：`src/auth.ts:34-36`

```ts
export function b64ToBytes(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));   // ← 每字节一次回调
}
```

**机制**：`Uint8Array.from(iterable, mapFn)` 对字符串的**每个字符**调用一次 JS 回调。140KB 输入 = 14 万次函数调用。

**实测**：

| 输入 | 现实现 µs | 反事实 µs | 倍数 |
|---|---|---|---|
| 140KB（500 节点订阅） | 8519 | 242 | 35× |
| 28KB（100 节点订阅） | 1585 | 42 | 37× |

**workerd**：6250µs → 203µs（31×）。这条是 workerd 实测的。

**影响面**（`b64decode` / `b64urlDecode` 的所有调用方）：
- `parse.ts:100`（`tryBase64`，**每次 base64 订阅抓取**）
- `parse.ts:256,258`（vmess URI 的 JSON 解码，每节点一次）
- `parse.ts:211,223`（ss 凭据解码，每节点一次）
- `render.ts:254`（`b64encode` 反向路径）
- `auth.ts:128,184`（会话/加密，量小）

**建议实现**：

```ts
const CHUNK = 8192;

export function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bin.length);
    for (let j = i; j < end; j++) out[j] = bin.charCodeAt(j);
  }
  return out;
}
```

**收益**：单函数从占 10ms 预算的 85% 降到 2.4%。**这是整份清单里性价比最高的一项**：改动 8 行、无 API 变化、无调用方改动。

**验证方法**：
1. `npx vitest run` 全绿（`test/auth.test.ts` 有编解码往返用例）
2. `counterfactual.bench.ts` 的「输出等价」断言：逐字节相同
3. 补边界用例：空串、纯 `=`、含换行的 base64、非 4 倍数长度（`b64urlDecode` 会补 `=`）
4. workerd 复测：`probe.ts` 的 `b64ToBytes 140KB（分块反事实）` 应稳定在 ~200µs

**风险**：低。分块 8KB 远低于任何引擎的 `apply` 实参上限；解码输出字节完全一致（有断言）。

---

## P1-3 · base64 编码分块 apply

**位置**：`src/auth.ts:28-32`

```ts
export function bytesToB64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);   // ← 每字节一次字符串拼接
  return btoa(s);
}
```

**机制**：每字节一次 `String.fromCharCode` + 字符串 `+=`。V8 对这种循环有 rope 优化，但仍是每字节一次 JS 层操作。

**实测**：105KB 1837µs → 473µs（3.9×）；workerd 1150µs → 408µs（2.8×）。

**影响面**：
- `b64encode` → `render.ts:254`（vmess URI 输出，每节点一次）
- `renderBase64`（`render.ts:300-302`，**整个 base64 输出格式**）
- `b64urlEncode` → `parse.ts` 的 ss 凭据编码、测试夹具
- `auth.ts:122,129`（密码哈希，量小）

**建议实现**：

```ts
export function bytesToB64(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + CHUNK, b.length)) as unknown as number[]);
  }
  return btoa(out);
}
```

**收益**：`renderBase64` 500 节点从 3050µs 降到约 1700µs（省掉 `renderUri` 之上的编码开销）。

**风险**：低。`apply` 的实参上限（约 65535 或引擎相关）远大于 8192。输出字符串完全一致（有断言）。

**注意**：`as unknown as number[]` 是为了满足 TS 签名；运行时传的是 `Uint8Array`，`apply` 接受类数组。W2 落地时可以用 `String.fromCharCode(...chunk)` 更干净，但要确认 workerd 不爆栈——建议保持 8192 分块。

---

## P1-4 · `collectNodes` 的串行 KV 读

**位置**：`src/subs.ts:449-476`

```ts
for (const subId of link.sources) {
  const sub = await getSub(env, subId);        // ← 串行
  const snap = await getSnapshot(env, subId);  // ← 再串行
}
```

**机制**：n 个订阅 = 2n 次串行 await。8 订阅 = 16 跳全串成一条链。`listByPrefix`（`subs.ts:68-76`）也是 list 之后逐键 get。

**实测**（桩延迟 3ms/跳）：

| 方案 | 墙钟 |
|---|---|
| 现有实现：逐订阅串行 | 50.5ms |
| 反事实：16 次读全并发 `Promise.all` | 3.2ms |
| 反事实：按 6 路分批并发 | 9.3ms |

**为什么是 6 路**：README「六」写明单请求最多 6 个并发连接。全并发（3.2ms）在真实 KV 上会踩限制，6 路分批（9.3ms）是可落地的下限。

**注意：这不是 CPU 优化。** I/O 等待不计入 CPU 时间，所以对 10ms CPU 预算**无收益**；收益在墙钟（客户端首字节）。这条不能和上面三条混着说。

**建议实现**（示意，W2 需覆盖错误处理）：

```ts
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    await Promise.all(batch.map(async (it, k) => { out[i + k] = await fn(it); }));
  }
  return out;
}
```

**验证方法**：
1. `npx vitest run` 全绿——`test/subs.test.ts` 的 `collectNodes` 用例覆盖了「已删除订阅 → skipped」「无快照 → skipped」「顺序保持」三类行为
2. **顺序必须保持**：现在节点顺序 = `link.sources` 顺序 × 订阅内顺序。并发读若乱序写入 `nodes` 数组，输出节点顺序会变，客户端的节点排序会跳
3. 用 `io-kv.bench.ts` 的 KV 次数断言确认往返次数不增加（应保持 16 次）
4. 补用例：某个 `getSnapshot` 抛错时，该订阅进 `skipped`，其它订阅不受影响

**风险**：中。三个具体坑：
- **顺序**：必须按 `sources` 索引写回，不能用 `push`
- **错误隔离**：`Promise.all` 一挂全挂，需 `allSettled` 或逐个 catch
- **KV 一致性**：并发读同一 namespace 无一致性问题（只读），但要注意不要顺手把写也并发了

---

## P2-5 · 去重键改定序字段数组

**位置**：`src/subs.ts:411-416`

```ts
const nodeKey = (n: ProxyNode) =>
  JSON.stringify(
    Object.entries(n)
      .filter(([k, v]) => v !== undefined && k !== 'name' && k !== 'original' && k !== 'source')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
```

**机制**：每个节点要 `Object.entries` 建 30 个键值对数组、filter、sort、再 stringify。300 节点 ≈ 9000 次小数组操作。

**实测**：300 节点 609µs → 304µs（2×）。

**建议实现**：用 `ProxyNode` 的字段做定序数组，跳过 entries/sort。

**收益**：300 节点省 300µs。**比前三条小一个量级**，所以是 P2。

**验证方法**：`counterfactual.bench.ts` 里的判重等价性断言已经跑过 179700 组节点对，0 处不一致。W2 落地后可把这段断言搬到 `test/subs.test.ts` 作为回归。

**风险**：中。键的**字符串内容会变**（字段顺序与结构都不同）。因为只用于同一进程内判重、不落盘、不跨版本比较，所以不影响行为——但这条需要 W2 明确确认一遍，不能想当然。

**附带收益**：`NODE_KEYS` 数组可以当 `ProxyNode` 的运行时字段清单，顺带给「新增字段忘了加进判重键」加一道防线（现在新增字段会自动进 entries，改后要手动加）。

---

## P2-6 · sing-box 输出支持 compact

**位置**：`src/render.ts:216`

```ts
return JSON.stringify(config, null, 2);   // ← 缩进 2 空格
```

**机制**：缩进输出 138KB（300 节点），其中约 49KB 是纯空白。客户端（sing-box）不读缩进。

**实测**：体积 138229B → 89536B（**−35%**）；耗时 764µs → 337µs（省掉一次全量 parse + 一次全量 stringify）。

**但要注意**：当前代码**并没有** `JSON.stringify(JSON.parse(x))` 这一步。764µs 那一栏测的是「如果按下游消费方式压缩」的成本，用来给「要不要提供 compact 选项」提供依据，不代表现有代码有这笔开销。

**建议**：加 `?format=compact` 或链接级选项，默认保持缩进（用户会拿配置文件去看/改）。**这是一项产品决策，不是纯性能优化**——体积收益 35%，代价是可读性。

**验证方法**：`render.test.ts` 已有 sing-box 输出用 `JSON.parse` 往返校验，改 compact 不影响；另需一个用例断言 compact 与 pretty 的 `JSON.parse` 结果深相等。

**风险**：低（实现），中（产品语义：是否让用户选）。

---

## P2-7 · 请求级 KV memo

**位置**：`src/subs.ts:449`（`collectNodes`）、`:479`（`collectPool`）

**现状**：`/s/{token}` 每次客户端拉取都重跑 `getLink` + `collectNodes`。8 订阅 = 17 次 KV 读，无请求级缓存。

**实测次数**（`io-kv.bench.ts`，确定值）：

| 场景 | get | list | 合计 |
|---|---|---|---|
| `collectNodes` 8 订阅，不含自建 | 16 | 0 | 16 |
| `collectNodes` 8 订阅 + 5 自建 | 21 | 1 | 22 |
| `/s/{token}` 读取段 | 17 | 0 | 17 |

**配额账**：10 万读/天 ÷ 17 ≈ **5882 次 /s/ 请求/天**就到顶（未计管理面与 cron）。个人用量远低于此，但这是硬上限。

**建议方向**（需与 T2 的 ADR-002 对齐，本卡不决策）：
- 请求级 memo：同一个请求内 `collectNodes` 被调两次时复用（`serveSubscription` 里 singbox 分支有 `ensureOutput` + `collectNodes` 两次调用路径）
- 跨请求缓存：`/s/` 的响应体按 token 缓存到 KV/`caches.default`，用快照时间戳做失效键——但这会把「KV 读」换成「KV 读 + 写」，收益要重算

**风险**：中。KV 是最终一致存储，跨请求缓存会放大「改了订阅但客户端还拿旧内容」的窗口。**必须先定失效口径**。

**注意**：`caches.default` 在 Workers 上可用，但 `/s/{token}` 现在显式设了 `Cache-Control: no-store`（`index.ts:99`），改成可缓存是**安全语义变更**（token 即凭据，README「七」第 4 条），须用户确认。

---

## P3-8 · YAML 标量转义快路径

**位置**：`src/render.ts:25`

```ts
const yq = (s: string): string => JSON.stringify(s);
```

**实测**：300 个标量 35µs → 11µs。

**但**：`renderClash` 300 节点总耗时 748µs，标量转义只占约 35µs（4.7%）。改这一项最多省 24µs，即 **3%**。

**结论**：**不建议单独做**。如果 W2 正好在动 `renderClash`（比如为了 P2-6 拆「构造对象 / 序列化」两步），可以顺手带上；否则不值得为 3% 引入一个需要正确性证明的转义快路径（错误转义 = 生成的 YAML 客户端解析失败，属正确性 bug）。

**风险**：低但不为零。现有 `JSON.stringify` 是 100% 正确的 YAML 双引号标量；快路径的正则必须覆盖 `"`、`\`、所有控制字符（含 `\u007f`）、以及 U+0085/U+2028 等「JSON 不转义但 YAML 敏感」的字符。基准里只验证了 5 个样本，**不够**。

---

## 不建议做（附理由）

### `cleanNodeName` 的正则优化

`rename.ts:253` 把 20+ 条别名合成一条带命名捕获组的大正则。看起来「一个节点跑 20 个分支」很浪费，但实测**别名命中档 3.31µs/节点**，400 节点 769µs，占 10ms 预算 7.7%。

真要优化，把别名改成「先按首字符建索引」之类的结构，收益上限也就 500µs，而风险是地区识别出现回归（这条路径有 10 个用例覆盖，但真实节点名千奇百怪）。

**判断：不做。** 这是典型的「看起来该优化、实际不值得」的地方。

### `parseClashYaml` 的性能

实测 300 节点 3796µs，且与输入前导行数无关（+400 行 rules 只差 104µs）。受限解析器的设计是对的，没有明显浪费。

值得注意的是它比明文 URI 路径（2969µs）贵 30%——但 Clash 形态只在个别机场作为兜底，量级不需要优化。

**判断：不做。**

---

## 附：清单里每项的复现命令

```bash
# 全部基准
npx vitest run --config vitest.bench.config.ts

# 只跑反事实（优化收益的直接依据）
npx vitest run --config vitest.bench.config.ts test/bench/counterfactual.bench.ts

# workerd 侧交叉确认
npx wrangler dev --config test/bench/workerd/wrangler.jsonc --port 8811
curl -s http://127.0.0.1:8811/ | python3 -m json.tool
```
