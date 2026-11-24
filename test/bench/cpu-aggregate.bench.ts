// CPU 侧基准 · 节点汇总：每订阅筛选 + 清洗 + 加来源前缀 → 链接级正则过滤 → 去重 → 唯一命名。
// 去重与唯一命名是 subs.ts 的模块私有函数，只能从 collectNodes 外部观察。桩 KV 零延迟，
// 因此本文件测到的是纯 CPU（对象展开、JSON.stringify 去重键、Set 查询、改名循环）。
//
// 关键发现：uniqueNames（subs.ts:430-442）在「清洗后同名」时是 O(n²)——
// 每个重名节点都从 #2 开始线性探测已用名。真实机场里「200 个香港节点清洗后都叫『香港』」很常见，
// 故本文件把 collide / distinct 两种画像分别量，不做平均。
import { describe, it } from 'vitest';
import { collectNodes } from '../../src/subs';
import { benchAsync, printTable, type BenchResult } from './harness';
import { linkRec, makeStubEnv, type NameProfile } from './fixtures';

describe('bench/cpu-aggregate', () => {
  it('汇总/去重/唯一命名 CPU 基线（I/O 已置零）', async () => {
    const rows: BenchResult[] = [];
    const profiles: Array<[NameProfile, string]> = [
      ['collide', '名字清洗后同名（走 uniqueNames 改名）'],
      ['distinct', '名字天然唯一（不走改名）'],
    ];

    for (const [profile, label] of profiles) {
      for (const n of [200, 400, 800]) {
        const { env } = makeStubEnv([{ id: 'a', name: '机场A', nodes: n }], { profile });
        const link = linkRec({ sources: ['a'], includeCustom: true });
        rows.push(await benchAsync(`${label} · ${n} 节点单订阅`, async () => void (await collectNodes(env, link)), { batch: 3 }));
      }
    }

    // 多订阅合并：来源前缀不同 → 名字不撞；再叠加 collide 画像看放大倍数
    const { env: multi } = makeStubEnv(
      Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, name: `机场${i}`, nodes: 100 })),
      { profile: 'collide' }
    );
    rows.push(await benchAsync('8 订阅 / 800 节点，collide 画像', async () =>
      void (await collectNodes(multi, linkRec({ sources: Array.from({ length: 8 }, (_, i) => `s${i}`) })))
    , { batch: 2 }));

    // 链接级正则过滤：sourceMatches 对每个节点跑两次 test
    const { env: re } = makeStubEnv([{ id: 'a', name: '机场A', nodes: 400 }], { profile: 'distinct' });
    rows.push(await benchAsync('400 节点 + 链接正则过滤', async () =>
      void (await collectNodes(re, linkRec({ sources: ['a'], include: '香港|日本', exclude: '游戏' })))
    , { batch: 3 }));

    printTable('cpu-aggregate（µs/op，node 本地，零延迟桩 KV，非 workerd）', rows);
    printScaling(rows);
  });
});

/** 把 collide 组按节点数排列，直接暴露增长阶数，避免读者从表格里心算 */
function printScaling(rows: BenchResult[]): void {
  const pick = (n: number) => rows.find((r) => r.name.includes(`${n} 节点单订阅`) && r.name.startsWith('名字清洗后同名'));
  const a = pick(200);
  const b = pick(400);
  const c = pick(800);
  if (!a || !b || !c) return;
  const ratio = (x: BenchResult, y: BenchResult, nx: number, ny: number) => ((y.p50Us / x.p50Us) / (ny / nx)).toFixed(2);
  console.log(
    [
      '',
      '### uniqueNames 增长阶（collide 画像）',
      `- 200→400 节点：耗时 ×${(b.p50Us / a.p50Us).toFixed(2)}（线性应为 ×2.00）`,
      `- 400→800 节点：耗时 ×${(c.p50Us / b.p50Us).toFixed(2)}（线性应为 ×2.00）`,
      `- 归一化增长因子：${ratio(a, b, 200, 400)} / ${ratio(b, c, 400, 800)}（1.00 = 线性，2.00 = 平方）`,
      '- 机制：`while (used.has(`${n.name} #${i}`)) i++` 对第 k 个重名节点从 2 数到 k，合计 O(n²) 次字符串拼接 + Set 查询。',
    ].join('\n')
  );
}
