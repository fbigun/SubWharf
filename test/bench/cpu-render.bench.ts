// CPU 侧基准 · 四种输出序列化：Clash(Mihomo YAML) / sing-box / URI / base64。
// 输出侧是 /s/{token} 的必经路径，且 base64 与 uri 都是对全量节点做字符串拼接后编码。
import { describe, it } from 'vitest';
import { renderBase64, renderClash, renderSingbox, renderUri } from '../../src/render';
import { parseSubscription } from '../../src/parse';
import { b64encode } from '../../src/auth';
import { benchSync, printTable, type BenchResult } from './harness';
import { uriSubscription } from './fixtures';

describe('bench/cpu-render', () => {
  it('四种输出 CPU 基线', () => {
    const nodes = parseSubscription(uriSubscription(300)).nodes;
    const nodes500 = parseSubscription(uriSubscription(500)).nodes;
    const rows: BenchResult[] = [];

    // 300 节点：Clash 受限解析器上限附近的常见规模
    rows.push(benchSync('renderClash 300 节点 (rules=none)', () => void renderClash(nodes, 'none'), { batch: 10 }));
    rows.push(benchSync('renderClash 300 节点 (rules=cn)', () => void renderClash(nodes, 'cn'), { batch: 10 }));
    rows.push(benchSync('renderSingbox 300 节点 (rules=none)', () => void renderSingbox(nodes, 'none'), { batch: 10 }));
    rows.push(benchSync('renderSingbox 300 节点 (rules=cn)', () => void renderSingbox(nodes, 'cn'), { batch: 10 }));
    rows.push(benchSync('renderUri 300 节点', () => void renderUri(nodes), { batch: 10 }));
    rows.push(benchSync('renderBase64 300 节点', () => void renderBase64(nodes), { batch: 6 }));

    // 500 节点：单链接全量输出的较大规模
    rows.push(benchSync('renderClash 500 节点', () => void renderClash(nodes500, 'none'), { batch: 8 }));
    rows.push(benchSync('renderSingbox 500 节点', () => void renderSingbox(nodes500, 'none'), { batch: 8 }));
    rows.push(benchSync('renderUri 500 节点', () => void renderUri(nodes500), { batch: 8 }));
    rows.push(benchSync('renderBase64 500 节点', () => void renderBase64(nodes500), { batch: 4 }));

    // base64 输出的编解码底噪：renderUri 之后还要过一次 bytesToB64
    const uriText = renderUri(nodes500);
    rows.push(benchSync('bytesToB64（renderBase64 的编码步）', () => void b64encode(uriText), { batch: 6 }));

    printTable('cpu-render（µs/op，node 本地，非 workerd）', rows);

    const clash = renderClash(nodes, 'none');
    const sb = renderSingbox(nodes, 'cn');
    const uri = renderUri(nodes);
    console.log(
      [
        '',
        `输出字节（300 节点）：clash ${clash.length}B / singbox 缩进 ${sb.length}B / singbox 压缩 ${JSON.stringify(JSON.parse(sb)).length}B / uri ${uri.length}B / base64 ${renderBase64(nodes).length}B`,
        'Clash 一栏偏高的机制：每个字段一次 JSON.stringify（yq），每节点 15~25 次小串分配。',
      ].join('\n')
    );
  });
});
