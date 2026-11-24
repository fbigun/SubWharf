// I/O 侧基准 · KV 往返账：谁串行、串了几次、这些等待怎么叠进墙钟。
// 桩 KV 按固定延迟模拟往返（3ms 是 README 里的量级假设，**不是** Cloudflare 实测值）。
// 关键产出不是「多少毫秒」，而是两个与延迟无关的确定值：
//   1) 一次 /s/{token} 要发多少次 KV 往返
//   2) 这些往返是不是串着等（决定延迟被放大几倍）
import { describe, it } from 'vitest';
import { collectNodes, collectPool, getLink, getSub } from '../../src/subs';
import { benchAsync, printTable, type BenchResult } from './harness';
import { linkRec, makeStubEnv, type NameProfile, type SubSpec } from './fixtures';

const LATENCY_MS = 3;
const toMs = (rows: BenchResult[]): BenchResult[] => rows.map((r) => ({ ...r, p50Us: r.p50Us / 1000, minUs: r.minUs / 1000, meanUs: r.meanUs / 1000 }));

const eightSubs = (): SubSpec[] => Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, name: `机场${i}`, nodes: 50 }));
const eightSources = Array.from({ length: 8 }, (_, i) => `s${i}`);

describe('bench/io-kv', () => {
  it('KV 往返次数（确定值，与延迟无关）', async () => {
    const lines: string[] = [];

    async function count(label: string, run: (env: ReturnType<typeof makeStubEnv>) => Promise<void>, specs: SubSpec[], opts = {}) {
      const stub = makeStubEnv(specs, opts);
      await run(stub);
      const total = stub.counters.gets + stub.counters.lists;
      lines.push(`| ${label} | ${stub.counters.gets} | ${stub.counters.lists} | **${total}** |`);
      return total;
    }

    lines.push('| 场景 | get | list | 合计往返 |', '|---|---|---|---|');
    const c1 = await count('collectNodes：8 订阅 / 400 节点，不含自建', async (s) => void (await collectNodes(s.env, linkRec({ sources: eightSources }))), eightSubs());
    const c2 = await count('collectNodes：8 订阅 + 5 自建节点', async (s) => void (await collectNodes(s.env, linkRec({ sources: eightSources, includeCustom: true }))), eightSubs(), { customNodes: 5 });
    const c3 = await count('collectPool：8 订阅 + 5 自建节点', async (s) => void (await collectPool(s.env)), eightSubs(), { customNodes: 5 });
    const c4 = await count('/s/{token} 读取段：getLink + collectNodes（8 订阅）', async (s) => {
      const l = await getLink(s.env, 'bench');
      if (l) await collectNodes(s.env, l);
    }, eightSubs(), { link: linkRec({ sources: eightSources }) });

    // 单个 get 的对照：一次 getSub 只发 1 次 get
    await count('单次 getSub（对照）', async (s) => void (await getSub(s.env, 's0')), eightSubs());

    console.log('\n### KV 往返次数\n');
    console.log(lines.join('\n'));
    console.log(
      [
        '',
        '读法：',
        `- 8 订阅不含自建 = ${c1} 次 = 8×(sub + snap) 两次 get，**全串行**（subs.ts:455-467 的 for-await）。`,
        `- 带自建节点多出 ${c2 - c1} 次 = list('node:') + 5 次 get（listByPrefix 逐键 get，subs.ts:68-76）。`,
        `- /s/{token} 每次客户端拉取都重跑一遍：getLink 1 次 + collectNodes ${c1} 次 = ${c4} 次，无请求级 memo。`,
        '- KV 免费版 10 万读/天。按 ${c4} 次/请求算，约 100000/'.replace('${c4}', String(c4)) + String(c4) + ' ≈ ' + Math.floor(100000 / c4) + ' 次 /s/ 请求/天就吃满读配额（尚未计管理面与 cron）。',
      ].join('\n')
    );
  });

  it('串行墙钟（桩延迟 3ms/跳）', async () => {
    const rows: BenchResult[] = [];

    const one = makeStubEnv(eightSubs(), { latencyMs: LATENCY_MS });
    rows.push(await benchAsync(`KV get ×1（对照，模拟 ${LATENCY_MS}ms/跳）`, async () => void (await getSub(one.env, 's0')), { samples: 9 }));

    // 两档名字画像分开：collide 会叠上 uniqueNames 平方路径，别把 I/O 与 CPU 混成一坨
    const profiles: Array<[NameProfile, string]> = [
      ['distinct', '名字唯一'],
      ['collide', '同名清洗'],
    ];
    for (const [profile, label] of profiles) {
      const stub = makeStubEnv(eightSubs(), { latencyMs: LATENCY_MS, profile });
      const link = linkRec({ sources: eightSources });
      rows.push(await benchAsync(`collectNodes 8 订阅/400 节点 · ${label}`, async () => void (await collectNodes(stub.env, link)), { samples: 7 }));
    }

    const withCustom = makeStubEnv(eightSubs(), { latencyMs: LATENCY_MS, customNodes: 5, profile: 'distinct' });
    rows.push(await benchAsync('collectNodes 8 订阅 + 5 自建 · 名字唯一', async () => void (await collectNodes(withCustom.env, linkRec({ sources: eightSources, includeCustom: true }))), { samples: 7 }));

    const serve = makeStubEnv(eightSubs(), { latencyMs: LATENCY_MS, profile: 'distinct', link: linkRec({ sources: eightSources }) });
    rows.push(await benchAsync('/s/{token} 读取段 · 名字唯一', async () => {
      const l = await getLink(serve.env, 'bench');
      if (l) await collectNodes(serve.env, l);
    }, { samples: 7 }));

    const pool = makeStubEnv(eightSubs(), { latencyMs: LATENCY_MS, customNodes: 5, profile: 'distinct' });
    rows.push(await benchAsync('collectPool 8 订阅 + 5 自建 · 名字唯一', async () => void (await collectPool(pool.env)), { samples: 7 }));

    printTable(`io-kv 墙钟（ms/op，node 本地，桩 KV 模拟 ${LATENCY_MS}ms/跳）`, toMs(rows), '\n注：桩延迟是假设值，绝对值不可外推到生产；可外推的是「串行次数 × 单跳延迟」这个结构。');
  });

  it('串行 vs 并发：结构代价（反事实，不代表现有代码行为）', async () => {
    const serial = makeStubEnv(eightSubs(), { latencyMs: LATENCY_MS, profile: 'distinct' });
    const s = await benchAsync('现有实现：8×(sub,snap) 串行', async () => void (await collectNodes(serial.env, linkRec({ sources: eightSources }))), { samples: 7 });

    const par = makeStubEnv(eightSubs(), { latencyMs: LATENCY_MS, profile: 'distinct' });
    const p = await benchAsync('反事实：同一批读取 Promise.all 并发', async () => {
      await Promise.all(eightSubs().flatMap((x) => [getSub(par.env, x.id), getSub(par.env, `snap:${x.id}`)]));
    }, { samples: 7 });

    const chunks = makeStubEnv(eightSubs(), { latencyMs: LATENCY_MS, profile: 'distinct' });
    const c = await benchAsync('反事实：按 6 路分批并发（贴合单请求 6 连接上限）', async () => {
      const keys = eightSubs().flatMap((x) => [x.id, `snap:${x.id}`]);
      for (let i = 0; i < keys.length; i += 6) {
        await Promise.all(keys.slice(i, i + 6).map((k) => getSub(chunks.env, k)));
      }
    }, { samples: 7 });

    printTable(`串行 vs 并发（ms/op，桩延迟 ${LATENCY_MS}ms/跳）`, toMs([s, p, c]));
    console.log(
      [
        '',
        `- 串行 ${(s.p50Us / 1000).toFixed(1)}ms vs 全并发 ${(p.p50Us / 1000).toFixed(1)}ms：${(s.p50Us / p.p50Us).toFixed(1)}× 差，即 16 跳被摊成 1 跳。`,
        `- 6 路分批 ${(c.p50Us / 1000).toFixed(1)}ms：受 README「六」单请求 6 连接上限约束，这是**现实可取的**下限。`,
        '- [unverified] 真实 KV 单跳延迟分布、以及 6 连接上限下的排队行为，本机无法测量；须用 wrangler tail / 生产观测确认。',
        '- 纯 I/O 等待不计入 CPU 时间，所以并发化对 10ms CPU 预算无直接收益，收益在墙钟（客户端首字节）。',
      ].join('\n')
    );
  });
});
