// workerd 侧基准探针：在真实 Workers 运行时（wrangler dev → workerd）跑与 node 侧同一套夹具。
// 目的：给 docs/perf 里 node vs workerd 的口径差提供实测，而不是「大概差不多」。
//
// 用法（本地 workerd，不部署、不占生产配额）：
//   npx wrangler dev --config test/bench/workerd/wrangler.jsonc --port 8801
//   curl -s http://127.0.0.1:8801/ | python3 -m json.tool
//
// 关键约束：workerd 的 performance.now() 量化到 1ms（Spectre 缓解）。
// 单次 op 若只有 1~10ms，batch=1 采样就是一堆整数毫秒——故所有慢 case 显式给大 batch，
// 把分辨率压到 µs 级；batch 同时打印在结果里，读者可自行核对量化误差上限（1000/batch µs）。
import worker from '../../../src/index';
import { parseSubscription } from '../../../src/parse';
import { cleanNodeName } from '../../../src/rename';
import { renderBase64, renderClash, renderSingbox, renderUri } from '../../../src/render';
import { b64encode, b64ToBytes, bytesToB64 } from '../../../src/auth';
import { collectNodes } from '../../../src/subs';
import { benchSync, type BenchResult } from '../harness';
import { b64Subscription, linkRec, makeStubEnv, uriSubscription } from '../fixtures';

const N = 500;

function b64ToBytesChunked(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 8192) {
    const end = Math.min(i + 8192, bin.length);
    for (let j = i; j < end; j++) out[j] = bin.charCodeAt(j);
  }
  return out;
}

function bytesToB64Chunked(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 8192) {
    out += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + 8192, b.length)) as unknown as number[]);
  }
  return btoa(out);
}

export default {
  async fetch(): Promise<Response> {
    const plain = uriSubscription(N);
    const b64 = b64Subscription(N);
    const nodes = parseSubscription(plain).nodes;
    const nodes300 = nodes.slice(0, 300);
    const bytes = new TextEncoder().encode(plain);

    const cases: BenchResult[] = [
      // 慢 case 显式 batch，避免 1ms 量化把结果压成「3000/10000」这种整数
      benchSync('parseUriList 500 明文', () => void parseSubscription(plain), { batch: 6 }),
      benchSync('parseSubscription base64 500', () => void parseSubscription(b64), { batch: 4 }),
      benchSync('b64ToBytes 140KB（现实现）', () => void b64ToBytes(b64), { batch: 4 }),
      benchSync('b64ToBytes 140KB（分块反事实）', () => void b64ToBytesChunked(b64), { batch: 400 }),
      benchSync('bytesToB64 105KB（现实现）', () => void bytesToB64(bytes), { batch: 20 }),
      benchSync('bytesToB64 105KB（分块反事实）', () => void bytesToB64Chunked(bytes), { batch: 400 }),
      benchSync('b64encode 105KB', () => void b64encode(plain), { batch: 20 }),
      benchSync('cleanNodeName ×500 节点', () => {
        for (const n of nodes) cleanNodeName(n.name);
      }, { batch: 20 }),
      benchSync('renderClash 300', () => void renderClash(nodes300, 'none'), { batch: 30 }),
      benchSync('renderSingbox 300', () => void renderSingbox(nodes300, 'cn'), { batch: 30 }),
      benchSync('renderUri 300', () => void renderUri(nodes300), { batch: 20 }),
      benchSync('renderBase64 300', () => void renderBase64(nodes300), { batch: 20 }),
    ];

    // 采集侧：collide 画像走 uniqueNames 平方路径，distinct 画像不撞名
    const runCollect = async (profile: 'collide' | 'distinct', nodeCount: number): Promise<number> => {
      const { env } = makeStubEnv([{ id: 'a', name: '机场A', nodes: nodeCount }], { profile });
      await collectNodes(env, linkRec({ sources: ['a'] })); // warmup
      const ts: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        await collectNodes(env, linkRec({ sources: ['a'] }));
        ts.push(performance.now() - t);
      }
      ts.sort((a, b) => a - b);
      return +ts[2].toFixed(2);
    };

    const collect = {
      '400 collide': await runCollect('collide', 400),
      '400 distinct': await runCollect('distinct', 400),
      '800 collide': await runCollect('collide', 800),
      '800 distinct': await runCollect('distinct', 800),
    };

    // 端到端：真实 src/index.ts 的 fetch，量 /s/{token} 的计算成本（桩 KV 零延迟）
    const e2e: Record<string, number> = {};
    for (const [label, profile, perSub] of [
      ['300 同名 clash', 'collide', 150],
      ['300 唯一 clash', 'distinct', 150],
      ['500 同名 clash', 'collide', 250],
      ['500 唯一 clash', 'distinct', 250],
      ['500 同名 singbox', 'collide', 250],
      ['500 同名 base64', 'collide', 250],
    ] as const) {
      const specs = [
        { id: 's0', name: '机场0', nodes: perSub },
        { id: 's1', name: '机场1', nodes: perSub },
      ];
      const link = linkRec({ sources: ['s0', 's1'], target: label.includes('singbox') ? 'singbox' : label.includes('base64') ? 'base64' : 'clash' });
      const { env } = makeStubEnv(specs, { profile, link });
      const target = link.target;
      const req = new Request(`https://bench.local/s/bench?target=${target}`);
      const ts: number[] = [];
      for (let i = 0; i < 7; i++) {
        const t = performance.now();
        const res = await worker.fetch(req, env);
        await res.text();
        ts.push(performance.now() - t);
      }
      ts.sort((a, b) => a - b);
      e2e[label] = +ts[3].toFixed(2);
    }

    return Response.json({
      runtime: navigator.userAgent,
      timerResolutionMs: 1,
      inputs: { plainChars: plain.length, b64Chars: b64.length, nodes: nodes.length },
      cases,
      collectMs400: collect,
      e2eRequestMs: e2e,
    });
  },
};
