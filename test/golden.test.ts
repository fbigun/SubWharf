// golden 输出基线：src/render 序列化结果的逐字节判据，用来回答「这次改造把输出改了吗」。
//
// 读这张表之前先读三条铁律：
//   1. 这张表变了 = 行为变了，不是数字过时。见到 sha 不相等，先假设输出真的变了，
//      去把差异解释清楚；「更新基线让它变绿」默认是错的。
//   2. 夹具就在本文件的 FIXTURES 里，自包含、入库、不依赖任何外部订阅。
//      改夹具（增删节点、改字段、改原始名称）必须同时更新整张 GOLDEN 表——输出是夹具的
//      函数，只改夹具不可能不改输出。改夹具本身要在 PR 描述里说明为什么必须改。
//   3. 任何一行 sha 变化都必须在 PR 描述里逐字节解释原因（哪个字段、为什么变），
//      解释不出来即视为行为不等价，不予合并。
//
// 为什么「夹具入库」比「哈希可复现」更重要：哈希只对产出它的那份输入有意义。
// docs/arch/roadmap.md §4 曾有同形态的一张表，但产出它的探针从未入库，于是仓库里没有
// 任何人能验证那 8 个数字——看着权威，实际是死数据。本文件的夹具与基线同处一份源码，
// 任一 checkout 跑 `npx vitest run test/golden.test.ts` 即可重算全表，这才叫判据。
//
// 重算方式：改完 src/ 后跑测试。字节数不符时断言直接报出实际字节数；sha16 不符时
// vitest 的 expected/received 里就是实际值，逐行核对、写回 GOLDEN 表并解释原因。
import { describe, expect, it } from 'vitest';
import { parseSubscription, type ProxyNode } from '../src/parse';
import { cleanNodeName } from '../src/rename';
import { renderBase64, renderClash, renderSingbox, renderUri } from '../src/render';

// ---------- 夹具 ----------
// 本仓支持的 6 种协议各一个节点，字段组合取自 test/parse.test.ts 与 test/render.test.ts
// 里已验证过的形态（不编格式）。原始名称故意带国旗 / 倍率 / 中文别名，过一遍
// cleanNodeName——真实链路（src/subs.ts 的 renderAll）就是这么清洗的，夹具要复现链路
// 行为，而不是绕过它。
const clean = cleanNodeName;

const FIXTURES: ProxyNode[] = [
  {
    name: clean('🇭🇰 香港 01 | 家宽 IPLC ˣ²'),
    type: 'ss',
    server: '1.2.3.4',
    port: 8388,
    cipher: 'aes-256-gcm',
    password: 'pa:ss:word',
    ssPlugin: 'obfs',
    ssPluginMode: 'http',
    ssPluginHost: 'bing.com',
  },
  {
    name: clean('🇺🇸 US-01 | 0.5x GPT'),
    type: 'vmess',
    server: 'b.example.com',
    port: 443,
    uuid: 'u1',
    alterId: 0,
    encryption: 'auto',
    network: 'ws',
    tls: true,
    sni: 'b.example.com',
    wsPath: '/ws',
    wsHost: 'b.example.com',
  },
  {
    name: clean('🇯🇵 JP-01 Reality'),
    type: 'vless',
    server: 'c.example.com',
    port: 443,
    uuid: 'u2',
    encryption: 'none',
    network: 'tcp',
    tls: true,
    reality: true,
    pbk: 'PBK',
    sid: 'abcd',
    sni: 'c.example.com',
    fp: 'chrome',
    flow: 'xtls-rprx-vision',
  },
  {
    name: clean('🇸🇬 SG-01'),
    type: 'trojan',
    server: 'd.example.com',
    port: 443,
    password: 'tp',
    tls: true,
    network: 'ws',
    wsPath: '/t',
    wsHost: 'd.example.com',
    insecure: true,
  },
  {
    name: clean('🇩🇪 DE-01 3倍'),
    type: 'hysteria2',
    server: 'e.example.com',
    port: 443,
    password: 'hp',
    tls: true,
    hy2Obfs: 'salamander',
    hy2ObfsPassword: 'op',
    upMbps: 30,
    downMbps: 200,
    sni: 'e.example.com',
  },
  {
    // 不带地区标识：cleanNodeName 未识别地区时保留原名，这条覆盖该分支
    name: clean('TUIC-直达'),
    type: 'tuic',
    server: 'f.example.com',
    port: 443,
    uuid: 'u3',
    password: 'tp3',
    tls: true,
    congestion: 'bbr',
    udpRelay: 'native',
    sni: 'f.example.com',
    alpn: ['h3'],
  },
];

// 夹具清洗后的名字序列，与 FIXTURES 一一对应。单独钉住一份，是为了让 cleanNodeName
// 的改动与 render 的改动在失败信息上可区分。
const EXPECTED_NAMES = ['香港 2× 家宽 IPLC', '美国 0.5× GPT', '日本', '新加坡', '德国 3×', 'TUIC-直达'];

// ---------- 工具 ----------
const encoder = new TextEncoder();
const bytes = (s: string): number => encoder.encode(s).length;

const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

// 用平台自带的 crypto.subtle，不引第三方哈希库（AGENTS.md「依赖从简」）
const sha16 = async (s: string): Promise<string> => hex(await crypto.subtle.digest('SHA-256', encoder.encode(s))).slice(0, 16);

// ---------- 基线表 ----------
// bytes + sha256 前 16 位。同时断两个：只断 sha，失败信息是一串哈希没人能定位；
// 只断字节数，漏掉同长度不同内容的改动。
type Baseline = { bytes: number; sha16: string };

const GOLDEN: Record<string, Baseline> = {
  'renderClash(rules=none)': { bytes: 1684, sha16: 'ad0d4970b112e9eb' },
  'renderClash(rules=cn)': { bytes: 1762, sha16: '9c97cca7096dbd2f' },
  'renderSingbox(rules=none)': { bytes: 2784, sha16: 'e959c923f761c0ce' },
  'renderSingbox(rules=cn,official)': { bytes: 3728, sha16: '7787937094b205aa' },
  'renderSingbox(rules=cn,jsdelivr)': { bytes: 3716, sha16: '72c44fc024715546' },
  'renderUri': { bytes: 992, sha16: '62f368bcdf79f608' },
  'renderBase64': { bytes: 1324, sha16: 'd2782a38a89ecbf5' },
  'parseSubscription(renderBase64(…)) 节点名序列': { bytes: 79, sha16: '7ff59de9fc9d07fb' },
};

// 往返结果：base64 订阅解回去之后的节点名，一行一个，用换行拼成可比对的字符串
const roundTripNames = (): string => parseSubscription(renderBase64(FIXTURES)).nodes.map((n) => n.name).join('\n');

// 每行一个用例，失败时用例名直接指出是哪一行输出变了
const ROWS: ReadonlyArray<readonly [string, () => string]> = [
  ['renderClash(rules=none)', () => renderClash(FIXTURES, 'none')],
  ['renderClash(rules=cn)', () => renderClash(FIXTURES, 'cn')],
  ['renderSingbox(rules=none)', () => renderSingbox(FIXTURES, 'none', 'official')],
  ['renderSingbox(rules=cn,official)', () => renderSingbox(FIXTURES, 'cn', 'official')],
  ['renderSingbox(rules=cn,jsdelivr)', () => renderSingbox(FIXTURES, 'cn', 'jsdelivr')],
  ['renderUri', () => renderUri(FIXTURES)],
  ['renderBase64', () => renderBase64(FIXTURES)],
  ['parseSubscription(renderBase64(…)) 节点名序列', roundTripNames],
];

async function expectGolden(label: string, actual: string): Promise<void> {
  const base = GOLDEN[label];
  expect(base, `GOLDEN 表缺少 ${label} 的基线行`).toBeDefined();
  const n = bytes(actual);
  // 先断字节数：能一眼区分「多/少了一个字段」与「同长度内容变了」
  expect(n, `${label} 字节数变化：${n}B（基线 ${base.bytes}B）`).toBe(base.bytes);
  expect(await sha16(actual), `${label} 输出变化：${n}B（基线 ${base.bytes}B）`).toBe(base.sha16);
}

describe('golden 输出基线', () => {
  it('夹具：cleanNodeName 清洗后的节点名序列未漂移', () => {
    const actual = FIXTURES.map((n) => n.name);
    expect(actual, `夹具节点名变化：${JSON.stringify(actual)}（基线 ${JSON.stringify(EXPECTED_NAMES)}）`).toEqual(EXPECTED_NAMES);
  });

  for (const [label, gen] of ROWS) {
    it(`${label}：字节数与 sha256 前 16 位均未变`, async () => {
      await expectGolden(label, gen());
    });
  }

  // 元测试：哈希只证明「和上次一样」，证明不了「还是合法输出」。两件事都要有。
  it('元测试：renderBase64 输出仍是合法订阅，可解析回等量节点', () => {
    const back = parseSubscription(renderBase64(FIXTURES));
    expect(back.skipped, `往返出现跳过项：${JSON.stringify(back.skipped)}`).toEqual([]);
    expect(back.nodes, '往返后节点数不符').toHaveLength(FIXTURES.length);
    expect(back.nodes.map((n) => n.name), '往返后节点名序列不符').toEqual(EXPECTED_NAMES);
    // 不止名字：模型字段也要一致（同义比对，不依赖对象键顺序）
    expect(back.nodes).toEqual(FIXTURES);

    // Clash 与 sing-box 输出同样要能被自家解析器吃回去——三种序列化同源，
    // 合法性一起验证，避免只保住 base64 这一条通路。
    for (const [label, text] of [
      ['renderClash(rules=cn)', renderClash(FIXTURES, 'cn')],
      ['renderSingbox(rules=cn,official)', renderSingbox(FIXTURES, 'cn', 'official')],
    ] as const) {
      const r = parseSubscription(text);
      expect(r.skipped, `${label} 回解析出现跳过项：${JSON.stringify(r.skipped)}`).toEqual([]);
      expect(r.nodes.map((n) => n.name), `${label} 回解析节点名序列不符`).toEqual(EXPECTED_NAMES);
    }
  });
});
