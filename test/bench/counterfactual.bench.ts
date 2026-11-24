// 反事实基准 · 为「优化清单」里的每一项提供「改完之后能拿到多少」的实测量。
// 这些实现**不在 src 里**、也不需要合入；它们只是同一份输入上的等价替代，用来把收益从「大概」变成数字。
// 每个反事实都附等价性检查：输出与原实现逐字节/逐语义一致，否则该项结论不成立。
import { describe, it } from 'vitest';
import { parseSubscription, type ProxyNode } from '../../src/parse';
import { renderSingbox } from '../../src/render';
import { b64ToBytes, bytesToB64 } from '../../src/auth';
import { collectNodes, getSub } from '../../src/subs';
import { benchAsync, benchSync, printTable, type BenchResult } from './harness';
import { linkRec, makeStubEnv, uriSubscription } from './fixtures';

const CHUNK = 8192;

// ---------- 反事实 1：base64 解码改为分块下标写回 ----------
function b64ToBytesChunked(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bin.length);
    for (let j = i; j < end; j++) out[j] = bin.charCodeAt(j);
  }
  return out;
}

// ---------- 反事实 2：base64 编码改为分块 String.fromCharCode.apply ----------
function bytesToB64Chunked(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + CHUNK, b.length)) as unknown as number[]);
  }
  return btoa(out);
}

// ---------- 反事实 3：uniqueNames 用 Map 记住下一个可用序号 ----------
function uniqueNamesCurrent(nodes: Array<{ name: string }>): void {
  const used = new Set<string>();
  for (const n of nodes) {
    if (!used.has(n.name)) {
      used.add(n.name);
      continue;
    }
    let i = 2;
    while (used.has(`${n.name} #${i}`)) i++;
    n.name = `${n.name} #${i}`;
    used.add(n.name);
  }
}

function uniqueNamesWithMap(nodes: Array<{ name: string }>): void {
  const used = new Set<string>();
  const next = new Map<string, number>();
  for (const n of nodes) {
    if (!used.has(n.name)) {
      used.add(n.name);
      continue;
    }
    let i = next.get(n.name) ?? 2;
    let cand = `${n.name} #${i}`;
    while (used.has(cand)) {
      i += 1;
      cand = `${n.name} #${i}`;
    }
    next.set(n.name, i + 1);
    n.name = cand;
    used.add(cand);
  }
}

// ---------- 反事实 4：去重键用定序字段数组，免去 Object.entries + sort ----------
const NODE_KEYS = [
  'type', 'server', 'port', 'uuid', 'password', 'cipher', 'alterId', 'encryption', 'flow', 'network',
  'tls', 'sni', 'alpn', 'insecure', 'fp', 'wsPath', 'wsHost', 'serviceName', 'reality', 'pbk', 'sid',
  'hy2Obfs', 'hy2ObfsPassword', 'upMbps', 'downMbps', 'ssPlugin', 'ssPluginMode', 'ssPluginHost',
  'congestion', 'udpRelay',
] as const;

const nodeKeyCurrent = (n: Record<string, unknown>): string =>
  JSON.stringify(
    Object.entries(n)
      .filter(([k, v]) => v !== undefined && k !== 'name' && k !== 'original' && k !== 'source')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );

function nodeKeyFixed(n: Record<string, unknown>): string {
  const parts: unknown[] = [];
  for (const k of NODE_KEYS) {
    const v = n[k];
    if (v !== undefined) parts.push(k, v);
  }
  return JSON.stringify(parts);
}

// ---------- 反事实 5：YAML 标量快路径（无特殊字符时不走 JSON.stringify） ----------
const NEEDS_ESCAPE = /[\\"\u0000-\u001f\u007f]/;
const yqFast = (s: string): string => (NEEDS_ESCAPE.test(s) ? JSON.stringify(s) : `"${s}"`);

describe('bench/counterfactual', () => {
  it('base64 解码：现实现 vs 分块写回', () => {
    const plain = uriSubscription(500);
    const b64 = bytesToB64(new TextEncoder().encode(plain));
    const rows: BenchResult[] = [
      benchSync('b64ToBytes 现实现（Uint8Array.from 回调）', () => void b64ToBytes(b64)),
      benchSync('b64ToBytes 反事实（分块下标写回）', () => void b64ToBytesChunked(b64)),
    ];
    printTable('反事实 · base64 解码（µs/op）', rows);
    assertEqualBytes(b64ToBytes(b64), b64ToBytesChunked(b64), '解码');
    console.log(`\n- 输出等价：140KB 输入解码结果逐字节相同（${b64.length}B → ${b64ToBytes(b64).length}B）`);
    console.log(`- 收益：${rows[0].p50Us.toFixed(0)}µs → ${rows[1].p50Us.toFixed(0)}µs，省 ${(rows[0].p50Us - rows[1].p50Us).toFixed(0)}µs（${(rows[0].p50Us / rows[1].p50Us).toFixed(0)}×）`);
  });

  it('base64 编码：现实现 vs 分块 apply', () => {
    const bytes = new TextEncoder().encode(uriSubscription(500));
    const rows: BenchResult[] = [
      benchSync('bytesToB64 现实现（逐字节拼接）', () => void bytesToB64(bytes)),
      benchSync('bytesToB64 反事实（分块 apply）', () => void bytesToB64Chunked(bytes)),
    ];
    printTable('反事实 · base64 编码（µs/op）', rows);
    if (bytesToB64(bytes) !== bytesToB64Chunked(bytes)) throw new Error('编码输出不一致');
    console.log(`\n- 输出等价：${bytes.length}B 编码结果完全一致`);
    console.log(`- 收益：${rows[0].p50Us.toFixed(0)}µs → ${rows[1].p50Us.toFixed(0)}µs，省 ${(rows[0].p50Us - rows[1].p50Us).toFixed(0)}µs`);
  });

  it('uniqueNames：线性探测 vs Map 记序号', () => {
    const rows: BenchResult[] = [];
    for (const n of [200, 400, 800]) {
      const mk = () => Array.from({ length: n }, () => ({ name: '[机场A] 香港' }));
      rows.push(benchSync(`现实现 · ${n} 个同名`, () => void uniqueNamesCurrent(mk())));
      rows.push(benchSync(`反事实 · ${n} 个同名`, () => void uniqueNamesWithMap(mk())));
    }
    printTable('反事实 · uniqueNames（µs/op）', rows);
    for (const n of [200, 400, 800]) {
      const a = Array.from({ length: n }, () => ({ name: '香港' }));
      const b = Array.from({ length: n }, () => ({ name: '香港' }));
      uniqueNamesCurrent(a);
      uniqueNamesWithMap(b);
      if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`uniqueNames 输出不一致 @${n}`);
    }
    // 边界：名字里本身带 `#N` 时，两种实现的序号分配是否仍一致（Map 版会不会「跳过」别人的后缀）
    const edgeCases: string[][] = [
      ['a', 'a', 'b', 'a'],
      ['a #2', 'a', 'a'],
      ['a', 'a #2', 'a'],
      ['a', 'a', 'a #2', 'a #3'],
      ['香港', '香港 #2', '香港', '香港'],
      ['x', 'x', 'x', 'x', 'x'],
    ];
    for (const c of edgeCases) {
      const a = c.map((name) => ({ name }));
      const b = c.map((name) => ({ name }));
      uniqueNamesCurrent(a);
      uniqueNamesWithMap(b);
      const ra = a.map((x) => x.name).join('|');
      const rb = b.map((x) => x.name).join('|');
      if (ra !== rb) throw new Error(`边界用例不一致 ${JSON.stringify(c)}：${ra} vs ${rb}`);
      console.log(`  边界 ${JSON.stringify(c)} → ${ra}`);
    }
    console.log('\n- 输出等价：200/400/800 三档逐项一致（含 `#2`、`#3` 序号分配顺序）');
    console.log('- 边界等价：6 组「名字本身含 #N」的输入全部一致（含 `a #2` 已被占用、`香港 #2` 与 `香港` 混排）');
    console.log(`- 收益 @200：${rows[0].p50Us.toFixed(0)}µs → ${rows[1].p50Us.toFixed(0)}µs；@400：${rows[2].p50Us.toFixed(0)}µs → ${rows[3].p50Us.toFixed(0)}µs；@800：${rows[4].p50Us.toFixed(0)}µs → ${rows[5].p50Us.toFixed(0)}µs`);
    console.log('- 注意：现实现是 O(n²)；反事实是 O(n) 均摊（撞名序号单调递增，不回头）。');
  });

  it('去重键：entries+sort vs 定序字段数组', () => {
    const nodes = parseSubscription(uriSubscription(300)).nodes as unknown as Array<Record<string, unknown>>;
    const one = nodes.map((n) => ({ ...n, name: 'ignored' }));
    const rows: BenchResult[] = [
      benchSync('nodeKey 现实现（entries+filter+sort+stringify）×300', () => {
        for (const n of one) nodeKeyCurrent(n);
      }, { batch: 3 }),
      benchSync('nodeKey 反事实（定序字段数组）×300', () => {
        for (const n of one) nodeKeyFixed(n);
      }, { batch: 3 }),
    ];
    printTable('反事实 · 去重键（µs/op，300 节点）', rows);
    assertKeyEquivalence(nodes);
    console.log('\n- 语义等价：对随机字段组合的节点对穷举比对「判重结论是否一致」，见本用例 output 的对数；断言失败会直接抛错');
    console.log(`- 收益：${rows[0].p50Us.toFixed(0)}µs → ${rows[1].p50Us.toFixed(0)}µs（300 节点）`);
    console.log('- 注意：键的**字符串内容不同**（字段顺序与结构都变了），但只用于同一进程内判重，不落盘、不跨版本比较，故不影响行为。');
  });

  it('sing-box 输出：pretty vs compact', () => {
    const nodes = parseSubscription(uriSubscription(300)).nodes;
    const pretty = renderSingbox(nodes, 'cn');
    const cfg = JSON.parse(pretty) as Record<string, unknown>;
    const rows: BenchResult[] = [
      benchSync('现实现 path：stringify(parse(pretty)) 再压缩', () => void JSON.stringify(JSON.parse(pretty)), { batch: 5 }),
      benchSync('反事实：直接 stringify(config)', () => void JSON.stringify(cfg), { batch: 20 }),
    ];
    printTable('反事实 · sing-box 压缩（µs/op，300 节点）', rows);
    if (JSON.stringify(JSON.parse(pretty)) !== JSON.stringify(cfg)) throw new Error('压缩结果不一致');
    const compact = JSON.stringify(cfg);
    console.log(`\n- 输出等价：压缩结果一致\n- 体积：${pretty.length}B → ${compact.length}B（省 ${(((pretty.length - compact.length) / pretty.length) * 100).toFixed(0)}%）`);
    console.log(`- 收益：${rows[0].p50Us.toFixed(0)}µs → ${rows[1].p50Us.toFixed(0)}µs（省掉一次全量 parse + 一次全量 stringify）`);
    console.log('- 前提：需把 renderSingbox 拆出「构造 config 对象」与「序列化」两步，属重构而非纯局部替换。');
  });

  it('YAML 标量：全走 JSON.stringify vs 无特殊字符走快路径', () => {
    const names = parseSubscription(uriSubscription(300)).nodes.map((n) => n.name);
    const rows: BenchResult[] = [
      benchSync('yq 现实现（JSON.stringify）×300', () => {
        for (const s of names) JSON.stringify(s);
      }, { batch: 20 }),
      benchSync('yq 反事实（正则判定后直拼）×300', () => {
        for (const s of names) yqFast(s);
      }, { batch: 20 }),
    ];
    printTable('反事实 · YAML 标量转义（µs/op）', rows);
    const tricky = ['a"b', 'a\\b', 'a\tb', '普通中文', ''];
    for (const s of [...names, ...tricky]) {
      if (JSON.stringify(s) !== yqFast(s)) throw new Error(`转义不等价：${JSON.stringify(s)}`);
    }
    console.log('\n- 输出等价：含引号/反斜杠/制表符/中文/空串全部一致');
    console.log(`- 收益：${rows[0].p50Us.toFixed(0)}µs → ${rows[1].p50Us.toFixed(0)}µs（300 个标量）`);
    console.log('- 但注意：renderClash 300 节点总耗时约 680µs，标量转义只占 ~45µs，单改这一项收益有限（P3）。');
  });

  it('KV 串行 vs 6 路分批（结构收益，不含 CPU）', async () => {
    const specs = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, name: `机场${i}`, nodes: 50 }));
    const sources = specs.map((s) => s.id);
    const serial = makeStubEnv(specs, { latencyMs: 3, profile: 'distinct' });
    const batched = makeStubEnv(specs, { latencyMs: 3, profile: 'distinct' });
    const rows: BenchResult[] = [
      await benchAsync('现实现：逐订阅串行 await', async () => void (await collectNodes(serial.env, linkRec({ sources }))), { samples: 7 }),
      await benchAsync('反事实：16 次读按 6 路并发', async () => {
        const keys = specs.flatMap((x) => [x.id, `snap:${x.id}`]);
        for (let i = 0; i < keys.length; i += 6) {
          await Promise.all(keys.slice(i, i + 6).map((k) => getSub(batched.env, k)));
        }
      }, { samples: 7 }),
    ];
    printTable('反事实 · KV 读取结构（ms/op，桩延迟 3ms）', rows.map((r) => ({ ...r, p50Us: r.p50Us / 1000, minUs: r.minUs / 1000, meanUs: r.meanUs / 1000 })));
    console.log(
      [
        '',
        `- 串行 ${(rows[0].p50Us / 1000).toFixed(1)}ms → 6 路 ${(rows[1].p50Us / 1000).toFixed(1)}ms`,
        '- 与 io-kv.bench.ts 的并发对照组配合阅读；本项收益是墙钟，不是 CPU（I/O 等待不计 CPU 时间）。',
        '- [unverified] 真实 KV 单跳延迟与 6 连接下的排队行为须在生产/预览环境观测。',
      ].join('\n')
    );
  });
});

function assertEqualBytes(a: Uint8Array, b: Uint8Array, label: string): void {
  if (a.length !== b.length) throw new Error(`${label}长度不一致`);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(`${label}字节不一致 @${i}`);
}

/** 判重语义等价性：对随机节点对，两种键给出相同的「是否同一节点」结论 */
function assertKeyEquivalence(nodes: Array<Record<string, unknown>>): void {
  const keys = ['type', 'server', 'port', 'uuid', 'password', 'cipher', 'network', 'tls', 'sni', 'alpn', 'upMbps', 'wsPath', 'ssPluginMode'] as const;
  const vals: unknown[] = [undefined, 'x', 1, true, ['h2', 'h1']];
  const mk = (seed: number): Record<string, unknown> => {
    const n: Record<string, unknown> = {};
    let s = seed;
    for (const k of keys) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      if (s % 3 === 0) n[k] = vals[s % vals.length];
    }
    return n;
  };
  const pool = [...nodes, ...Array.from({ length: 300 }, (_, i) => mk(i + 1))];
  let checked = 0;
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const sameFields = keys.every((k) => JSON.stringify(pool[i][k]) === JSON.stringify(pool[j][k]));
      checked++;
      const cur = nodeKeyCurrent(pool[i]) === nodeKeyCurrent(pool[j]);
      const fix = nodeKeyFixed(pool[i]) === nodeKeyFixed(pool[j]);
      if (cur !== fix || cur !== sameFields) {
        throw new Error(`判重语义不一致 @(${i},${j})：cur=${cur} fix=${fix} fields=${sameFields}`);
      }
    }
  }
  console.log(`  判重等价性：${checked} 组节点对全部一致`);
}
