# ADR-005：仓库文件结构——问题在 test/ 与 docs/，不在 src/

- 状态：建议采纳（待技术负责人拍板）
- 日期：2026-11-26
- 基线提交：`5a130da`（main）
- 写域：`docs/arch/**`；`test/**` 与 `README.txt` 的改动列在里程碑卡，不在本文件内执行
- 相关：`AGENTS.md`「工作约定」、`adr-001-module-boundaries.md`（模块分层）、
  `adr-004-engineering-practices.md`（闸门）、`roadmap.md`（已排期卡片）

---

## 1. 背景与目标

**一句话目标：让"改一个端点该动哪个文件"和"这份判断的依据在哪"都能一眼回答。**

被问的是「项目文件结构组织有没有建议」。先给结论，因为它反直觉：

**`src/` 的 7 个文件结构是健康的，不需要动。真正失序的是 `test/` 与 `docs/`。**

| 目录 | 文件数 | 行数 | 结构判断 |
|---|---|---|---|
| `src/` | 7 | 3174 | ✅ 每个文件一个职责，最大 `parse.ts` 991 行有内部接缝但不构成失败场景 |
| `test/` | 25 | 4578 | ⚠️ 一个文件占 1550 行 / 158 项；KV 桩 4 份实现，其中 1 份对某类回归完全无效 |
| `docs/` | 7 | 2230 | ⚠️ 136 处行号锚点；14 处引用从未入库的脚本；README 零处指向它 |
| `public/` | 5 | 1044（另 vendor 2297） | ✅ 731 行原生 JS 分 10 个 section、最长 171 行，拆了只会增加请求数 |
| 根目录 | 10 文件 + 5 目录 | — | ✅ 全是项目必需项；唯一缺项是 `package.json` 的 `engines`（见 §6 M3） |

成功指标（可机械核对）：

1. 修改任一 `/api/*` 端点，需要打开的文件数从 1 个（1550 行）降到 ≤ 2 个（≤ 300 行 + 共享夹具）
2. `grep -rn "KV: {" test --include=*.ts` 输出为空（桩唯一实现）
3. `docs/` 里 `file:line` 形式的锚点数从 136 降到 0，改为符号名
4. `README.txt` 首屏可见指向 `docs/README.md` 的入口
5. 本次改动 **`src/` 零改动**，288 项测试与 golden 8 行 sha 全部不变

---

## 2. 需求分析

### 2.1 约束清单

| # | 约束 | 来源 |
|---|---|---|
| C1 | 不引入构建链、不加后端框架 | `AGENTS.md`「技术栈与结构」 |
| C2 | 新增依赖先说明必要性；不为一次性功能搭抽象层 | `AGENTS.md`「工作约定」 |
| C3 | `parse.ts` / `rename.ts` / `render.ts` 是正确性核心，改动必须带可复现验证样例 | `AGENTS.md`「工作约定」 |
| C4 | 目录清单变更需同步 `README.txt:九` | `AGENTS.md` + `roadmap.md` §5 第 3 条 |
| C5 | 不抢已排期卡片（W2/W3/W5 的写域） | `roadmap.md` §1 |
| C6 | 在途分支 `docs/engineering-adr-004`（PR #27）只新增文档，写域不冲突 | 实测 `git ls-remote` |

### 2.2 假设与证伪条件

| 假设 | 若该假设不成立的应对 |
|---|---|
| A1：拆 `test/index.test.ts` 的收益来自「单次改动的定位成本」，不是「合并冲突」 | 实测它 90 天只被改 2 次（`src/subs.ts` 6 次、`src/index.ts` 5 次），所以本卡不拿冲突当理由。若有人认为 1550 行的定位成本可忽略 → 该卡降为可选，M1/M2 照做 |
| A2：`src/parse.ts` 的 YAML 语法层与领域映射层是稳定接缝 | 若拆分后 `parse.ts` 仍需互引私有函数 → 说明接缝选错，放弃该卡，保留单文件 |
| A3：探针脚本入库后不会膨胀成第二套测试体系 | 若入库 3 个月内新增超过 4 个探针文件且无人维护 → 回退为"文档内嵌代码块"，不入库 |

---

## 3. 问题定义

### 3.1 数据流：一次改动的波及面

现状修改一个 `/api/*` 端点，实际要面对的文件：

```
改 API 行为
  ├─ src/index.ts        441 行（api() 一段 209 行）
  └─ test/index.test.ts 1550 行 / 24 个 describe ← 全部挤在一个文件
       └─ 顶部 124 行是共享夹具（call/callAuth/nodeOf/subOf/linkOf/tplOf）
            每个 describe 都在这个文件里找位置，插入点靠行号，靠 Ctrl+F
```

对照 `src/` 侧：7 个文件、17 条 `import` 语句、**14 条模块间依赖边、无环**。
边方向全部单向（`index`→4、`template`→4、`subs`→3、`render`→2、`parse`→1，
`auth`/`rename` 为零出边）。**依赖图是干净的**——ADR-001 已论证分层，本次不重复。

### 3.2 三类实测缺陷（这是本 ADR 的真实依据）

#### 缺陷 1：KV 桩有 4 份实现，其中 1 份对某类回归完全无效

| 位置 | 行数 | 能力 |
|---|---|---|
| `test/fakes/kv.ts` | 74 | 完整：get(type)/put/delete/list 分页 + `fail()` + `read()` |
| `test/subs.test.ts`（文件内 `kvStub`） | 12 | **只有 get + list**，get 忽略 `type` 参数 |
| `test/template.test.ts`（文件内 `kvStub`） | 21 | get/put/delete/list，get 支持 `type`；返回的 `store` **从未被使用** |
| `test/bench/fixtures.ts`（`makeStubEnv`） | 74 | get/list/put + 延迟注入 + 计数器（基准专用，**保留**） |

**变异实验（可复现）**：把 `src/subs.ts` 的两处 `env.KV.get(..., 'json')` 改为
`env.KV.get(...)`（模拟真实回归：漏写反序列化参数），分别跑：

| 测试文件 | 用的桩 | 结果 |
|---|---|---|
| `test/subs.test.ts` | 自造（忽略 type） | **21 项全绿通过** ← 缺陷被掩盖 |
| `test/template.test.ts` | 自造（支持 type） | 3 项失败 |
| `test/index.test.ts` | `FakeKV` | 52 项失败 |

把 `test/subs.test.ts` 的 12 行自造桩换成一行 `const kvStub = (data) => makeEnv(data)`，
不加改任何用例，同一变异立刻变红：**18 failed | 3 passed**。
（换桩本身不改行为：不施加变异时，该文件 21 项全绿。）

**结论：这不是"代码重复不好看"，是"这个文件的测试对某一类回归是无效的"。**

#### 缺陷 2：`test/index.test.ts` 的规模已过组织阈值

```
1550 行 / 158 项 / 24 个 describe / 占全部 288 项的 54.9%
其中顶部共享夹具 124 行，最长 describe 157 行
```

按端点族归并后的可行切分（逐段核对：24 个 describe 合计 1427 行 + 顶部共享 124 行，
合计 1551，与 `wc -l` 的 1550 差 1 行是文件末的换行，下表每行都是原文切段、未重写）：

| 目标文件 | 并入的 describe | 行数 |
|---|---|---|
| `test/api/support.ts` | 共享夹具：`call`/`callAuth`/`authed`/`body` + 5 个记录工厂（`nodeOf`/`subOf`/`snapOf`/`linkOf`/`tplOf`）+ `seedProfile`/`seedSource` + 常量 | 124 |
| `test/api/auth.test.ts` | me 33 + setup 65 + setup-verify/login 110 + 受保护未登录 44 + me 组合 22 | 274 |
| `test/api/subs.test.ts` | subs 157 + 上游请求头 28 + 其他分支 31 + 快照错误 26 | 242 |
| `test/api/links.test.ts` | links 104 + 其他分支 37 | 141 |
| `test/api/templates.test.ts` | templates 123 | 123 |
| `test/api/status.test.ts` | status 47 + pool 40 | 87 |
| `test/api/nodes.test.ts` | nodes 59 | 59 |
| `test/api/subscribe.test.ts` | `/s/{token}` 157 + 输出细节 46 + 模板影响 42 + 空节点 25 | 270 |
| `test/api/guards.test.ts` | 请求体上限 67 + 路由兜底 63 + 边界分支 58 + 模板缓存失败 23 + scheduled 20 | 231 |

最大文件从 1550 降到 274（`test/api/auth.test.ts`）。**已实测**：`test/` 下新建子目录、
用例里用 `../../src/*` 相对路径，`npx vitest run` 默认 include 能正常抓取（临时加 1 个用例 →
288 变 289，验证后删除，已还原）。

#### 缺陷 3：`docs/` 的锚点与外部事实已分叉

| 实测项 | 数字 | 后果 |
|---|---|---|
| `file.ts:行号` 形式锚点 | **136 处**（130 指向 `src/*.ts`，6 指向 `test/*.ts`） | 任何 `src/` 重排即失效 |
| 其中指向 W5 计划拆分/缩减的文件（`auth`/`parse`/`subs`/`template`） | **85 处（63%）** | W5 落地即 63% 失效 |
| `.probe/*.ts` 引用 | **14 处 / 7 个文件** | `git log --all` 查无记录，**从未入库**；`npx vite-node .probe/final.ts` 跑不了 |
| `vite-node` 是否在 `devDependencies` | **否**（靠 vitest 传递依赖） | 复现命令依赖一个未声明的依赖 |
| `README.txt` 提到 `docs/` | **0 处** | 208 行 README 读完不知道有 ADR |
| `roadmap.md` §4 的 8 行 golden sha vs `test/golden.test.ts` 的 GOLDEN 表 | **8 项全不同**（如 `renderClash(rules=none)` 1631/`c78a566…` vs 1684/`ad0d497…`） | 文档要求"逐行对比"，但对比对象是两套数，指令本身执行不了 |

分三类看：前两行是**锚点形态**问题，中间两行是**复现命令悬空**，后两行是**已发生的分叉**。
最后一行的性质与前五行不同——它不是"将来会坏"，而是**现在就已经不一致**：
`roadmap.md` 要求"PR 里贴出改造后重跑的表逐行对比"，但表里 8 行数字与 `test/golden.test.ts`
的 `GOLDEN` 表 8 行**没有一行相同**（例：`renderClash(rules=none)` 文档 1631 / `c78a566…`，
代码 1684 / `ad0d497…`）。这条验收指令照抄就会得出"全部不符"。

我不判定哪套数"对"——只报两个事实：**代码那套今天能跑**（`npx vitest run test/golden.test.ts`
的 10 项全绿），**文档那套的来源脚本 `.probe/golden.ts` 不存在**。所以按"可执行者为准"，
真值应落在 `test/golden.test.ts`。

根因是同一个：**文档复制了代码里的真值，而没有指向它**。修法不是"下次注意同步"，
是把真值的唯一出处定在代码里（§5.3），文档只写指针。

---

## 4. 候选方案对比

| 维度 | A 最简：只补文档索引与锚点规范 | **B 推荐：A + test/ 重组 + 桩统一** | C 重：B + 拆 `src/`（parse/auth） | D 真空：什么都不动 |
|---|---|---|---|---|
| 改动文件数 | 2（`README.txt`、新增 `docs/README.md`） | 2 + 9 新增 + 4 改（`test/`） | B + 6（`src/`） | 0 |
| `src/` 是否改动 | 否 | **否** | 是 | 否 |
| 解决缺陷 1（桩掩盖缺陷） | ❌ | ✅ | ✅ | ❌ |
| 解决缺陷 2（1550 行单文件） | ❌ | ✅ | ✅ | ❌ |
| 解决缺陷 3（锚点/探针/索引） | 部分（锚点规范 + 索引，探针仍悬空） | ✅ | ✅ | ❌ |
| 与已排期卡片的冲突 | 无 | 无（`roadmap.md` 未覆盖 `test/` 结构） | **抢 W5 的写域**（`parse.ts` 顶部 import 行、`auth.ts` 缩减） | 无 |
| 可单 PR 回滚 | ✅ | ✅（新增文件为主） | ⚠️ 多 PR，需按序 | — |
| 风险 | 低（但缺陷 1 仍在） | **低**（`src/` 零改动，行为零变化） | 中（`parse.ts` 是正确性核心，`AGENTS.md` C3） | 低（问题留存） |

### 4.1 为什么否掉 C（拆 `src/`）

不是"以后再说"，是三条具体理由：

1. **`src/` 的问题已经有归属**：ADR-001 + `roadmap.md` W5-1/W5-2 已排期拆 `codec.ts` / `env.ts`，
   写域写死在 `roadmap.md` 的 W5-1 / W5-2 卡片里。本 ADR 再拆一次 = 两张卡动同一批 `import` 行，冲突是必然的。
2. **`parse.ts` 991 行不是失败场景**：`roadmap.md` §6 的结论是"行数长不是拆分理由，没有失败场景才是理由"，
   本 ADR 沿用该判据。**唯一值得单列的是 YAML 语法层**：从 `YamlValue` 类型定义到 `unquoteKey`
   结束共 **342 行**，区间内 `ProxyNode` 引用 **0 次**、`export` **0 次**，纯 `YamlValue` 变换。
   它有独立接缝，但没有独立失败场景，所以排 P3 且**放在 W5 之后**，不并入本批。
3. **C 的正确性风险落在 `AGENTS.md` 点名的地方**：`parse.ts` / `render.ts` 改动必须带真实订阅样例验证，
   而它的验证成本远高于 `test/` 重组（后者逐用例名可比对，见 §6 验收命令）。

### 4.2 为什么否掉 A（只补文档）

A 是有价值的，但它漏掉了最有证据的一条：**`subs.test.ts` 的 21 项测试对"漏 type 反序列化"是盲的**
（§3.2 实测）。只改文档不动这个桩，等于承认缺陷但留档不修。A 作为 B 的前置步骤被吸收。

### 4.3 为什么否掉 D

唯一支持 D 的论据是"现在能跑"。但缺陷 1 的证据是**测试有效性**问题，不是美观问题。
`AGENTS.md`「工作约定」要求改动附带可复现验证——一个会放过缺陷的测试不满足该要求。

---

## 5. 推荐方案：B

### 5.1 目标结构（只画变化的部分）

```
src/                        ← 不变（除 W5 已排期的 codec/env）
  index.ts  auth.ts  subs.ts  template.ts
  parse.ts  rename.ts  render.ts

test/
  api/                      ← 新增：index.test.ts 按端点族拆 7 份 + support.ts
    support.ts              共享夹具（124 行）
    auth.test.ts  subs.test.ts  links.test.ts  templates.test.ts
    status.test.ts  nodes.test.ts  subscribe.test.ts  guards.test.ts
  fakes/                    ← 保留，且成为唯一 KV 桩实现
    kv.ts  env.ts  fetch.ts  assets.ts  totp.ts  fakes.test.ts
  bench/                    ← 不变
    *.bench.ts  fixtures.ts  harness.ts  workerd/
  auth.test.ts  golden.test.ts  parse.test.ts  rename.test.ts
  render.test.ts  subs.test.ts  template.test.ts     ← 平铺保留，仅换用统一桩
                                                       （index.test.ts 拆走后剩 7 个，55~408 行）

docs/
  README.md                 ← 新增：索引（全部 ADR + roadmap + perf 三篇，含阅读顺序）
  arch/  perf/              ← 保持
```

**不动 `public/`**：731 行原生 JS 分 10 个 section、最长 171 行，拆文件只会增加 HTTP 请求数
（当前 `app.js` gzip 6.9 KB 单请求拿完）。

**不动根目录**：`git ls-files` 的根一级条目 15 个（10 个文件 + 5 个目录），无临时脚本、无遗留配置，健康。
唯一要补的是 `package.json` 的 `engines`（§6 M3）。

### 5.2 三条硬规则（可机械检查）

| # | 规则 | 检查命令 |
|---|---|---|
| S1 | **一个桩，一个实现**。`test/` 下不得内联 KV 桩 | `grep -rn "KV: {" test --include=*.ts` → 空 |
| S2 | **锚点用符号名，不用行号**。文档引用代码写 `` `subs.listByPrefix` ``，不写「文件 + 冒号 + 行号」 | `grep -rnE "\.ts:[0-9]+" docs/ --include=*.md` → 空（基线快照表例外，见 §5.3） |
| S3 | **测试文件上限 450 行**（超了按 describe 边界切） | `find test -name '*.test.ts' \| xargs wc -l \| awk '$1>450'` → 空 |

S3 的门槛按"现状最大健康文件"往上一档取（408 → 450），不是拍脑袋定一个漂亮数字：
平铺的 8 个测试文件里，除 `index.test.ts`（1550 行）外 6 个 ≤ 278 行；
唯一 408 行的 `parse.test.ts` 对应 991 行的 `parse.ts`，比例 1:2.4 合理——
所以 450 是"刚够放过现有最大健康文件"的值，规则落地当天不会立刻红。

### 5.3 例外：哪些行号可以保留

只有一类：**基线快照**（golden sha + 字节数），因为它的价值恰在"当时的字节"。
规则是必须带提交号且**唯一出处**：数字以 `test/golden.test.ts` 的 `GOLDEN` 表为唯一来源，
文档只写 `见 test/golden.test.ts:GOLDEN`，不复制数字——这直接修掉 §3.2 缺陷 3 的第五项
（现在 `roadmap.md` §4 复制了一份 8 行、且与代码里的 8 行全不同）。

### 5.4 探针脚本的归宿

现状 14 处引用 7 个 `.probe/*.ts`，全部不存在、且 `vite-node` 不在 `devDependencies`。
三个选项：

| 选项 | 代价 | 判断 |
|---|---|---|
| ① 入库为 `test/probe/*.bench.ts`，复用现有 `test/bench/harness.ts` | 改成 `.bench.ts` 即可被 `vitest.bench.config.ts` 抓到，**零新依赖** | **推荐**。复现命令统一成 `npx vitest run --config vitest.bench.config.ts test/probe/xxx.bench.ts` |
| ② 新建 `tools/probe/` + 显式声明 `vite-node` | +1 devDependency，且需 `include` 应对配置 | 否：违反 C2（`vite-node` 只是 runner 差异） |
| ③ 文档内嵌代码块，不入库 | 零成本 | 备选：若 A3 证伪（探针膨胀失控）则退到这条 |

**推荐 ①**：现有 `harness.ts` 已有 `benchSync` / `benchAsync` / `printTable`，
`fixtures.ts` 已有 `makeStubEnv`（带 KV 计数器——正是 ADR-002 数子请求所需的桩）。
探针本质就是"带断言的基准"，`.bench.ts` 是它的正确归属。

---

## 6. 里程碑与验收标准

| 卡 | 内容 | 优先级 | 写域 | 依赖 |
|---|---|---|---|---|
| **M1** | 文档索引 + 锚点规范落地 | **P1** | `README.txt`、新增 `docs/README.md`、`docs/arch/*.md`（仅改锚点形态） | 无 |
| **M2** | 测试桩统一（S1） | **P1** | `test/subs.test.ts`、`test/template.test.ts` | 无 |
| **M3** | `package.json` 补 `engines` | P2 | `package.json` | 无 |
| **M4** | `test/index.test.ts` 按端点族拆分（S3） | P2 | 新增 `test/api/**`，删除 `test/index.test.ts` | M2（复用 support.ts） |
| **M5** | 探针入库为 `test/probe/*.bench.ts` | P3 | 新增 `test/probe/**`、`docs/arch/*.md` 的复现命令 | M1 |
| **M6** | `parse.ts` 抽 `yaml-lite.ts` | P3 | `src/parse.ts`、新增 `src/yaml-lite.ts` | **W5 全绿之后** |

**M1 排第一的理由**：M4、M5 的验收判据都要靠"用例名集合"与"符号名"来比对，锚点规范不先立，
后续每张卡的 PR 描述都无法机械核对。

### M1 · 文档索引 + 锚点规范

- 新增 `docs/README.md`：现有全部 ADR（含状态与一句话结论）+ `roadmap.md` + `docs/perf/` 三篇，
  标阅读顺序（"先 ADR-004 看闸门，再 roadmap 看排期，ADR-001~003 是细节"）
- `README.txt:九` 末尾加一行：`docs/  设计决策（ADR）与性能基线，入口 docs/README.md`
- 136 处「文件 + 冒号 + 行号」→ 符号名（如列表读取那处改为 `subs.listByPrefix`）
- **验收**：`grep -rnoE "[a-zA-Z0-9._-]+\.(ts|js):[0-9]+" docs/ --include=*.md | wc -l` → 0（基线快照的引用行除外）

### M2 · 测试桩统一

- `test/subs.test.ts`、`test/template.test.ts` 的 `kvStub` 改为 `import { makeEnv } from './fakes/env'`
- **已实测可行**（两个文件都试过，逐项全绿）：
  - `subs.test.ts`：把 12 行 `kvStub` 换成 `const kvStub = (data) => makeEnv(data)` → **21 项全绿**
  - `template.test.ts`：把 21 行 `kvStub` 换成 `const kvStub = (data) => ({ env: makeEnv(data) })`
    → **15 项全绿**。该文件的 `store` 返回值**从未被解构使用**（6 处调用全是 `const { env } = kvStub(...)`），
    所以连 `FakeKV.read()` 都用不上，改动就是删 20 行
- **验收**：
  1. `grep -rn "KV: {" test --include=*.ts` 输出为空
  2. `npx vitest run` 仍 **288 项全绿**（数量不得变）
  3. **变异测试**：临时删掉 `src/subs.ts` 的 `listByPrefix` / `getJson` 里的 `'json'` 实参，
     `test/subs.test.ts` **必须失败**。实测对照：
     - 换桩前：**21 项全绿**（缺陷被掩盖）
     - 换桩后：**18 failed | 3 passed**
     这一条是 M2 的核心价值证明，必须写进 PR 描述。跑完还原。
  4. `src/` 零改动 → golden 8 行 sha 天然不变

### M3 · `package.json` 补 `engines`

- 现状：`README.txt`「五、部署」写「Node 18+」，但 `wrangler@4.152.0` 的 `engines.node` 是 `>=22.0.0`
  → 按 README 装 Node 18 会直接失败
- 补 `"engines": { "node": ">=22" }`，同步把该行改成「Node 22+」
- **验收**：`node -e "console.log(require('./package.json').engines)"` 输出 `{ node: '>=22' }`

### M4 · `test/index.test.ts` 拆分

- 按 §3.2 缺陷 2 的表格切 7 份 + `support.ts`；共享夹具从文件内私有导出改为 `support.ts` 导出
- **验收（这是本 ADR 最关键的判据）**：

```bash
# 导出「用例全名」集合（describe + it，不含文件路径），实测 288 条、去重后仍 288 条
dump() {
  npx vitest run --reporter=json 2>/dev/null | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const j=JSON.parse(s);
      console.log(j.testResults.flatMap(f=>f.assertionResults.map(a=>a.fullName)).sort().join('\n'));
    });"
}

dump > /tmp/before.txt   # 改动前跑一次：288 行
dump > /tmp/after.txt    # 改动后再跑一次
diff /tmp/before.txt /tmp/after.txt && echo "用例集合逐条一致"
```

  拆分允许**改变**的：文件路径。**不允许**改变的：用例全名、断言内容、288 这个总数。
  已实测两条前提：该 dump 两次运行结果**完全一致**（无随机序），
  288 个 `fullName` **两两不重复**（否则 diff 会掩盖重名）。
- 回滚：`git revert` 单 PR；`test/api/**` 为新增目录，revert 即消失

### M5 · 探针入库

- `.probe/final.ts`（KV 子请求计数）→ `test/probe/kv-subrequests.bench.ts`，复用 `fixtures.makeStubEnv` 的计数器
- `.probe/golden.ts` → 已被 `test/golden.test.ts` 覆盖，**不搬**，改为在 `roadmap.md` 里指向该文件
- `.probe/{q5,silent,badjson,dangling,breakeven}.ts` → 各自对应 `roadmap.md` 的一张卡，
  **随卡落地时入库**，不提前搬（避免入库即陈旧，A3 的风险控制）
- **验收**：`npx vitest run --config vitest.bench.config.ts test/probe/` 可跑通；
  `docs/` 里不再出现 `.probe/` 字符串

### M6 · `parse.ts` 抽 `yaml-lite.ts`（W5 之后）

- 接缝已实测：从 `YamlValue` 类型定义（含 `CLASH_MAX_INPUT` / `CLASH_MAX_NODES` 两个常量）
  到 `unquoteKey` 结束，共 **342 行**；区间内 `ProxyNode` 引用 **0 次**、`export` **0 次**，
  只做 `YamlValue` 变换。对外只暴露 `parseProxiesSection(text, limits)`
- 拆分后 `parse.ts` 991 → ≈ 650 行，`yaml-lite.ts` ≈ 345 行
- **验收**：`npx tsc --noEmit` 零输出；`npx vitest run` 全绿；
  **`test/golden.test.ts` 的 8 行 sha 与字节数全部不变**（这是 `AGENTS.md` C3 的硬要求）；
  `test/parse.test.ts` 的 6 项 Clash YAML 用例逐条比对不变
- **回滚**：单 PR revert，`yaml-lite.ts` 为新增文件

### 排期

```
M1 (P1) ──┬─→ M5 (P3)
          ├─→ M2 (P1) ─→ M4 (P2)
          └─→ M3 (P2，可任意时刻)

W5 全绿 ──→ M6 (P3)
```

M1/M2/M3 写域互不重叠，可并行；M4 依赖 M2（`support.ts` 要指向统一桩）。

---

## 7. 风险与预案

| # | 风险 | 概率 | 影响 | 预案 / 触发降级条件 |
|---|---|---|---|---|
| R1 | M4 拆分时漏掉或改动用例断言，288 项名集合出现差异 | 中 | 中 | §6 的 before/after 全名 diff 是硬门禁；**任一条不一致即 revert 该文件**，不逐条修补 |
| R2 | M2 换桩后 `template.test.ts` 的断言失效 | 低 | 低 | 实测该文件不消费 `store`（6 处调用只取 `env`），换桩后 15 项全绿；若未来新增存储断言，改用 `FakeKV.read()`（已有该方法，语义为 `JSON.parse` 后返回） |
| R3 | 与在途 PR #27（`docs/engineering-adr-004`）抢 `docs/arch/` 行号 | **高** | 低 | M1 只改**锚点形态**（行号→符号名），不改 ADR 正文结论；#27 合入后 rebase 一次即可，冲突段集中在被引用行 |
| R4 | M5 入库的探针三个月后无人维护，变成第二套陈旧断言 | 中 | 中 | A3 的证伪条件：3 个月内 > 4 个探针文件无改动 → 回退到"文档内嵌代码块" |
| R5 | M6 拆 `parse.ts` 触发 golden sha 变化 | 中 | **高** | 任一行 sha 变即 revert；若确有行为变化，逐字节解释后再来（同 `roadmap.md` R5） |
| R6 | M1 的 136 处锚点改造引入错误引用（符号名写错） | 中 | 低 | 抽查 20%（27 处）：`grep -n "export \?\(async \)\?function <符号名>" src/*.ts` 能命中即通过 |

降级触发线（写死，避免临场判断）：

- M4 的用例全名 diff 出现任何差异且 30 分钟内解释不出 → revert
- M6 的 golden 8 行 sha 出现任何变化 → revert
- 任一卡导致 `npx vitest run` 少于 288 项 → 该卡不算完成

---

## 8. 不做什么（v1 negative scope）

| 不做 | 理由 |
|---|---|
| 拆 `public/app.js` | 731 行单文件 gzip 6.9 KB 一次请求拿完；拆成模块要加 `<script type="module">` 与多次请求，收益为负 |
| 动 `src/` 的 7 文件布局 | 依赖图已干净（14 条边、无环）；ADR-001 + W5 已排期拆 `codec`/`env`，本 ADR 不抢 |
| 建 `src/domain/` `src/infra/` 这类分层目录 | 7 个文件 3174 行建 2 层目录 = 每层 3~4 个文件，纯增路径深度。分层已在 ADR-001 用**注释与依赖规则**表达，不需要用目录再表达一次 |
| 按测试类型建 `unit/` `integration/` `e2e/` 三层目录 | 本项目 vitest 用统一 fake，没有"集成 vs 单元"的运行时差异；按类型分目录会让人纠结"这个用例算哪层"。按**端点族 + 领域**分（`api/` + 平铺领域文件）更贴近"改哪儿测哪儿" |
| 根目录加 `.nvmrc` / `.editorconfig` / `LICENSE` | 单人项目；`engines` 已能表达 Node 版本要求（M3）。LICENSE 若需开源再单开 |
| 为 `docs/` 建静态站（VitePress 等） | 新增依赖 + 构建链，违反 C1；一个 30 行 `docs/README.md` 索引够用 |
| 自动生成"文档锚点有效性"CI 检查 | M1 之后锚点是符号名，本身不随行号漂移；再加一层校验是给"会漂的东西"准备的 |
| 搬 `.probe/golden.ts` | 其职责已被 `test/golden.test.ts` 完全覆盖（8 行 + 夹具名 + 往返三组断言）；搬 = 两份真值 |

### 演进预留

| 预留点 | 触发条件（可证伪） |
|---|---|
| `test/api/` 再按资源二级细分（如 `api/subs/refresh.test.ts`） | 单个 `api/*.test.ts` 超过 450 行（S3 触发） |
| `src/` 引入目录分组 | `src/*.ts` 文件数 > 12，或单文件 > 800 行且存在两个以上独立失败场景 |
| `docs/` 拆 `docs/adr/` + `docs/perf/` + `docs/ops/` | `docs/` 出现第三类文档（如运维手册），当前只有 arch/perf 两类 |
| 探针独立成 `test/probe/` 之外的目录 | 探针数量 > 10 且开始承担回归门禁职责（那时它已经不是"探针"） |

---

## 附录 A：本文全部数字的复现命令

| 数字 | 命令 |
|---|---|
| src 7 文件 3174 行 / test 25 文件 4578 行 / docs 7 文件 2230 行 | `wc -l src/*.ts`、`find test -name '*.ts' \| xargs wc -l \| tail -1`、`wc -l docs/*/*.md` |
| `index.test.ts` 1550 行 / 158 项 / 24 个 describe | `wc -l test/index.test.ts`；`npx vitest run test/index.test.ts --reporter=json \| jq .numTotalTests` → 158；`grep -c "^describe(" test/index.test.ts` → 24 |
| 288 项测试、用例名两两唯一 | `npx vitest run --reporter=json \| jq .numTotalTests` → 288；全名去重计数见 §6 M4 的 dump 脚本 |
| KV 桩 4 处实现 | `grep -rn "KV: {" test --include=*.ts`、`grep -rn "makeStubEnv\|new FakeKV" test --include=*.ts` |
| 变异实验（`subs.test.ts` 全绿通过） | 删掉 `subs.listByPrefix` / `subs.getJson` 里的 `'json'` 实参 → `npx vitest run test/subs.test.ts` → 21 passed |
| `src` 14 条模块间依赖边 | `for f in src/*.ts; do for m in auth parse rename render subs template; do grep -q "from '\./$m'" $f && echo "$f -> $m"; done; done` |
| `parse.ts` YAML 层 342 行、区间内 `ProxyNode` 0 次 | `sed -n '547,888p' src/parse.ts \| wc -l` → 342；`sed -n '547,888p' src/parse.ts \| grep -c ProxyNode` → 0 |
| docs 136 处行号锚点（130 指向 src、85 指向 W5 文件） | `grep -ohE "[a-zA-Z0-9._-]+\.(ts\|js):[0-9]+" docs/*/*.md \| awk -F: '{print $1}' \| sort \| uniq -c` |
| `.probe/` 引用 14 处、从未入库 | `grep -o "\.probe/" docs/*/*.md \| wc -l`；`git log --all --oneline -- '.probe/'`（空） |
| `README.txt` 提 `docs/` 0 处 | `grep -c "docs/" README.txt` → 0 |
| golden 表两套数字不同 | `sed -n '/^| \`renderClash/,/^$/p' docs/arch/roadmap.md` 对比 `sed -n '142,151p' test/golden.test.ts` |
| Node 版本冲突 | `node -e "console.log(require('./package-lock.json').packages['node_modules/wrangler'].engines)"` → `{ node: '>=22.0.0' }`；`grep -n "Node 18" README.txt` |
| 测试子目录可被默认 include 抓到 | 在 `test/api/` 建临时用例 → `npx vitest run` → 10 files / 289 tests（验证后删除） |
