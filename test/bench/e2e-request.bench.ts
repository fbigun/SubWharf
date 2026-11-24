// 端到端请求预算 · 直接调 src/index.ts 的 default.fetch，量一次 /s/{token} 花多少「计算时间」。
// 桩 KV 零延迟 → 测到的是 CPU 侧（汇总/清洗/序列化/Response 构造）+ await 开销，不含真实网络。
// 对照口径：免费版 CPU 10ms/请求（README 六）。node 数字只作方向参考；workerd 下的绝对值
// 见 docs/perf/02-workerd-vs-node.md，结论按 [unverified] 标注。
import { describe, it } from 'vitest';
import worker from '../../src/index';
import { parseSubscription } from '../../src/parse';
import { b64encode } from '../../src/auth';
import { benchAsync, printTable, type BenchResult } from './harness';
import { b64Subscription, linkRec, makeStubEnv, uriSubscription, type NameProfile } from './fixtures';

const OUTPUTS = ['clash', 'singbox', 'base64', 'uri'] as const;

describe('bench/e2e-request', () => {
  it('/s/{token} 单请求计算成本（输出格式 × 节点规模 × 两个节点名画像）', async () => {
    const rows: BenchResult[] = [];

    const scenarios: Array<{ label: string; perSub: number; subs: number; profile: NameProfile }> = [
      { label: '2 订阅 / 300 节点 · 名字唯一', perSub: 150, subs: 2, profile: 'distinct' },
      { label: '2 订阅 / 300 节点 · 同名清洗', perSub: 150, subs: 2, profile: 'collide' },
      { label: '2 订阅 / 500 节点 · 名字唯一', perSub: 250, subs: 2, profile: 'distinct' },
      { label: '2 订阅 / 500 节点 · 同名清洗', perSub: 250, subs: 2, profile: 'collide' },
      { label: '4 订阅 / 800 节点 · 同名清洗', perSub: 200, subs: 4, profile: 'collide' },
    ];

    for (const sc of scenarios) {
      const specs = Array.from({ length: sc.subs }, (_, i) => ({ id: `s${i}`, name: `机场${i}`, nodes: sc.perSub }));
      const link = linkRec({ sources: specs.map((s) => s.id) });
      const { env } = makeStubEnv(specs, { profile: sc.profile, link });
      for (const target of OUTPUTS) {
        const req = new Request(`https://bench.local/s/bench?target=${target}`);
        rows.push(
          await benchAsync(`${sc.label} · ${target}`, async () => {
            const res = await worker.fetch(req, env);
            await res.text(); // 计入响应体物化（真实链路还要把 body 写出）
          }, { samples: 9 })
        );
      }
    }

    printTable('e2e-request（µs/请求，node 本地 + 零延迟桩 KV，非 workerd）', rows);
    printBudget(rows);
  });

  it('抓取侧：单订阅解析成本（cron / 手动刷新，逐订阅串行）', async () => {
    const plain = uriSubscription(500);
    const b64 = b64Subscription(500);
    const rows: BenchResult[] = [];
    rows.push(await benchAsync('解析 500 节点明文 URI', async () => void parseSubscription(plain), { samples: 9 }));
    rows.push(await benchAsync('解析 500 节点 base64', async () => void parseSubscription(b64), { samples: 9 }));
    rows.push(await benchAsync('解析 500 节点 base64（＝分块实现的参照）', async () => void b64decodeChunkedPath(b64), { samples: 9 }));
    printTable('抓取侧（µs/次，node 本地，非 workerd）', rows);
    console.log(
      [
        '',
        `- base64 订阅 ${b64.length}B：解码段占整条解析链 ${(rows[1].p50Us - rows[0].p50Us).toFixed(0)}µs，是明文 URI 路径的 ${(rows[1].p50Us / rows[0].p50Us).toFixed(1)}×`,
        '- cron 一次调用里 refreshAll 逐订阅 await（subs.ts:229-233），单订阅解析超 10ms 就会顶到免费版单次调用的 CPU 上限。',
      ].join('\n')
    );
  });
});

/** 只替换 base64 解码的等价实现，用来估算「解码换成分块」后整条解析链的样子（不进入 src） */
function b64decodeChunkedPath(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 8192) {
    const end = Math.min(i + 8192, bin.length);
    for (let j = i; j < end; j++) bytes[j] = bin.charCodeAt(j);
  }
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  return parseSubscription(text).nodes.length.toString();
}

function printBudget(rows: BenchResult[]): void {
  const budget = 10_000;
  const over = rows.filter((r) => r.p50Us > budget);
  console.log(
    [
      '',
      '### 与 10ms CPU 预算对账（[unverified]：node ≠ workerd 的 CPU 计量口径）',
      `- 预算 10000µs。本组 ${rows.length} 个组合里 p50 超预算的有 ${over.length} 个。`,
      ...over.slice(0, 8).map((r) => `  - ${r.name}：${r.p50Us.toFixed(0)}µs（超 ${((r.p50Us / budget - 1) * 100).toFixed(0)}%）`),
      '- 注意：node 的 JIT 与 GC 行为、`performance.now()` 精度、以及 Cloudflare 的 CPU 计时是否包含 GC 都不同，绝对值必须在 workerd 下复测。',
    ].join('\n')
  );
}
