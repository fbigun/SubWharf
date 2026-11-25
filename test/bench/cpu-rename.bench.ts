// CPU 侧基准 · 节点名清洗：地区识别（别名 / 中文 / 国旗 / 英文全称 / 英文缩写）+ 倍率与特殊标识提取。
// 这条路径每个节点跑一次，400 节点概览页与每次 /s/ 输出都会走，属高频小函数。
import { describe, it } from 'vitest';
import { cleanNodeName } from '../../src/rename';
import { benchSync, printTable, type BenchResult } from './harness';
import { NAME_POOL } from './fixtures';

describe('bench/cpu-rename', () => {
  it('cleanNodeName CPU 基线', () => {
    const rows: BenchResult[] = [];
    const sample = NAME_POOL;
    const repeated = Array.from({ length: 400 }, (_, i) => sample[i % sample.length]);

    rows.push(benchSync('cleanNodeName 单次（16 种名字轮转）', () => {
      let acc = 0;
      for (const n of sample) acc += cleanNodeName(n).length;
      if (acc < 0) throw new Error('unreachable');
    }, { batch: 20 }));
    rows.push(benchSync('cleanNodeName ×400 节点（一次请求级）', () => {
      for (const n of repeated) cleanNodeName(n);
    }, { batch: 3 }));

    // 分档看哪一类名字最贵：命中别名 vs 命中英文缩写 vs 完全未识别
    const buckets: Array<[string, string]> = [
      ['命中城市别名（东京/伦敦/法兰克福）', '🇬🇧 London 07 | 家宽 IPLC ˣ²'],
      ['命中中文地区（香港/日本）', '🇭🇰 香港 01 x2'],
      ['命中英文缩写（US-09）', 'US-09 0.5x'],
      ['命中英文全称（Bosnia and Herzegovina）', 'Bosnia and Herzegovina 14'],
      ['未识别地区（直接返回原名）', 'Relay-16'],
      ['长名 + 多标识（最坏情况）', '🇯🇵 日本 02 | 家宽 IPLC ˣ² 专线 3倍 GPT UDP 游戏'],
    ];
    for (const [label, name] of buckets) {
      rows.push(benchSync(label, () => void cleanNodeName(name), { batch: 2000 }));
    }

    printTable('cpu-rename（µs/op，node 本地，非 workerd）', rows);
  });
});
