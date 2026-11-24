// CPU 侧基准 · 解析路径：订阅格式识别 → URI / base64 / Clash YAML / sing-box JSON → 内部模型。
// 口径：抓取侧（cron 或手动刷新）每订阅走一次；这里量一次要花多少 µs，对照免费版 10ms CPU 预算。
import { describe, it } from 'vitest';
import { parseSubscription } from '../../src/parse';
import { b64decode } from '../../src/auth';
import { benchSync, printTable, type BenchResult } from './harness';
import { b64Subscription, clashSubscription, singboxSubscription, uriSubscription } from './fixtures';

const N = 500; // 常见机场量级；也贴近 CLASH_MAX_NODES=300 的 1.7 倍

describe('bench/cpu-parse', () => {
  it('解析路径 CPU 基线', () => {
    const plain = uriSubscription(N);
    const b64 = b64Subscription(N);
    const clash = clashSubscription(300);
    const clashPreamble = clashSubscription(300, { preambleLines: 400 });
    const singbox = singboxSubscription(N);
    const rows: BenchResult[] = [];

    // 这几个 case 单次 0.8~12ms：显式给 batch 压噪声，否则 batch=1 时 p50 会被单次抖动带偏
    rows.push(benchSync('parseUriList 500 明文', () => void parseSubscription(plain), { batch: 8 }));
    rows.push(benchSync('parseSubscription base64 500（默认抓取形态）', () => void parseSubscription(b64), { batch: 4 }));
    rows.push(benchSync('└ 其中 base64 解码一段', () => void b64decode(b64), { batch: 4 }));
    rows.push(benchSync('parseClashYaml 300 节点', () => void parseSubscription(clash), { batch: 8 }));
    rows.push(benchSync('parseClashYaml 300 节点 + 400 行前导 rules', () => void parseSubscription(clashPreamble), { batch: 8 }));
    rows.push(benchSync('parseSingboxJson 500 outbounds', () => void parseSubscription(singbox), { batch: 8 }));

    printTable('cpu-parse（µs/op，node 本地，非 workerd）', rows);

    const [plainUri, base64Total, decodeStep] = rows;
    console.log(
      [
        '',
        `输入字节：明文 URI ${plain.length}B / base64 ${b64.length}B / Clash ${clash.length}B / Clash+前导 ${clashPreamble.length}B / sing-box ${singbox.length}B`,
        '',
        '拆解（base64 路径 vs 明文路径）：',
        `- 同样的 500 节点，base64 路径 ${base64Total.p50Us.toFixed(0)}µs，明文路径 ${plainUri.p50Us.toFixed(0)}µs，差 ${(base64Total.p50Us - plainUri.p50Us).toFixed(0)}µs`,
        `- 其中解码一段 ${decodeStep.p50Us.toFixed(0)}µs，占 base64 路径的 ${((decodeStep.p50Us / base64Total.p50Us) * 100).toFixed(0)}%`,
        '- 结论：base64 订阅的成本几乎全在 base64 解码（src/auth.ts:34-36 的每字节回调），不在解析逻辑本身。',
        '- Clash 解析器与节点数、前导行数关系不大：输入上限 256KB 截断 + 单遍扫描（parse.ts:544-557）。',
      ].join('\n')
    );
  });

  it('规模敏感性：节点数 → 解析成本', () => {
    const rows: Array<{ n: number; plain: number; b64: number; bytes: string }> = [];
    for (const n of [50, 100, 200, 300, 500]) {
      const p = uriSubscription(n);
      const b = b64Subscription(n);
      rows.push({
        n,
        plain: benchSync(`plain-${n}`, () => void parseSubscription(p), { samples: 9, batch: 12 }).p50Us,
        b64: benchSync(`b64-${n}`, () => void parseSubscription(b), { samples: 9, batch: 6 }).p50Us,
        bytes: `${p.length}/${b.length}`,
      });
    }
    console.log('\n### 规模敏感性（µs，明文 / base64）\n');
    console.log('| 节点数 | 明文 URI | base64 | 输入字节(明文/base64) | 线性外推校验 |');
    console.log('|---|---|---|---|---|');
    for (const r of rows) {
      const expect = (r.n / 50) * rows[0].b64;
      console.log(`| ${r.n} | ${r.plain.toFixed(0)} | ${r.b64.toFixed(0)} | ${r.bytes} | ${(r.b64 / expect).toFixed(2)}× |`);
    }
    console.log('\n（最后一列 =1.00 表示严格线性；偏离说明有固定开销或 GC 影响）');
  });
});
