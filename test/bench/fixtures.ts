// 基准夹具：全部由定种子 PRNG 生成，任何机器跑出的输入字节数完全一致。
// 不依赖网络与 Date.now()，保证「数」可跨机器、跨次对账。
import type { Env } from '../../src/auth';
import { b64encode, b64urlEncode } from '../../src/auth';
import type { LinkRec, SnapshotRec, SubRec } from '../../src/subs';

// ---------- 定种子 PRNG ----------
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length) % xs.length];

// ---------- 节点名：覆盖 cleanNodeName 的各识别分支 ----------
export const NAME_POOL = [
  '🇭🇰 香港 01',
  '🇯🇵 日本 02 | 家宽 IPLC ˣ²',
  '🇺🇸 美国 03 x2',
  '🇸🇬 新加坡 04 | 专线 3倍',
  '🇹🇼 台湾 05 游戏 UDP',
  '🇰🇷 首尔 06',
  '🇬🇧 London 07',
  '🇩🇪 Frankfurt 08',
  'US-09',
  'HK-10 0.5x',
  'JP 大阪 11',
  'SG-12 | GPT 家宽',
  'Australia 13',
  'Bosnia and Herzegovina 14',
  'My Node 15',
  'Relay-16',
] as const;

// ---------- 节点 URI：六种协议混排，字段贴近真实机场 ----------
const UUID = (i: number) => `11111111-2222-3333-4444-${String(i).padStart(12, '0')}`;
const md5ish = (i: number) => `ab${i.toString(16).padStart(6, '0')}`;

export function nodeUri(i: number, name: string): string {
  const host = `n${i}.edge${i % 9}.example.com`;
  const frag = encodeURIComponent(name);
  switch (i % 6) {
    case 0:
      // ss SIP002：base64url(method:password)
      // 只用 Web 标准 API：同一夹具在 node 与 workerd 下都能跑
      return `ss://${b64urlEncode(`aes-256-gcm:pw${md5ish(i)}`)}@${host}:8388#${frag}`;
    case 1:
      // vmess：v2rayN JSON + ws + tls
      return `vmess://${b64encode(
        JSON.stringify({
          v: '2',
          ps: name,
          add: host,
          port: '443',
          id: UUID(i),
          aid: '0',
          scy: 'auto',
          net: 'ws',
          type: 'none',
          host: host,
          path: `/ws${i % 5}`,
          tls: 'tls',
          sni: host,
        })
      )}`;
    case 2:
      // vless：reality + ws
      return `vless://${UUID(i)}@${host}:443?encryption=none&security=reality&sni=${host}&fp=chrome&pbk=PBK${i}&sid=abcd&type=ws&path=%2Fws&host=${host}#${frag}`;
    case 3:
      // trojan：ws + allowInsecure
      return `trojan://pw${md5ish(i)}@${host}:443?type=ws&path=%2Ft&host=${host}&allowInsecure=1&peer=${host}#${frag}`;
    case 4:
      // hysteria2：salamander 混淆 + 速率
      return `hy2://hp${md5ish(i)}@${host}:443?sni=${host}&obfs=salamander&obfs-password=obfs${i}&upmbps=30&downmbps=200#${frag}`;
    default:
      // tuic：v5 + bbr
      return `tuic://${UUID(i)}:tp${md5ish(i)}@${host}:443?sni=${host}&alpn=h3&congestion_control=bbr&udp_relay_mode=native#${frag}`;
  }
}

export function uriList(n: number, seed = 42): string[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => nodeUri(i, pick(rnd, NAME_POOL)));
}

/** 明文 URI 订阅（v2rayN 系机场在请求到明文时的形态） */
export function uriSubscription(n: number): string {
  return uriList(n).join('\n');
}

/** base64 订阅（本项目默认抓取形态） */
export function b64Subscription(n: number): string {
  return b64encode(uriSubscription(n));
}

// ---------- Clash YAML：受限子集解析器的输入形态 ----------
export function clashSubscription(n: number, opts: { preambleLines?: number } = {}): string {
  const rnd = mulberry32(7);
  const head: string[] = ['port: 7890', 'socks-port: 7891', 'mode: rule', 'log-level: info'];
  const preamble = opts.preambleLines ?? 0;
  if (preamble > 0) {
    // 真实机场会先发一大段 rules / proxy-groups；解析器要逐行扫到 proxies: 才开工
    head.push('rules:');
    for (let i = 0; i < preamble; i++) head.push(`  - DOMAIN-SUFFIX,site${i}.example.com,PROXY`);
  }
  head.push('proxies:');
  const items: string[] = [];
  for (let i = 0; i < n; i++) {
    const name = pick(rnd, NAME_POOL);
    const host = `c${i}.example${i % 5}.com`;
    items.push(
      [
        `  - name: "${name} ${i}"`,
        '    type: vless',
        `    server: ${host}`,
        '    port: 443',
        `    uuid: ${UUID(i)}`,
        `    servername: ${host}`,
        '    network: ws',
        '    tls: true',
        '    udp: true',
        '    skip-cert-verify: false',
        '    client-fingerprint: chrome',
        '    ws-opts:',
        `      path: /ws${i % 4}`,
        '      headers:',
        `        Host: ${host}`,
        '    reality-opts:',
        `      public-key: PBK${i}`,
        '      short-id: abcd',
        '    alpn:',
        '      - h2',
        '      - http/1.1'
      ].join('\n')
    );
  }
  return [...head, ...items].join('\n') + '\n';
}

// ---------- sing-box JSON（outbounds 列表） ----------
export function singboxSubscription(n: number): string {
  const rnd = mulberry32(11);
  const outbounds: unknown[] = [{ type: 'selector', tag: 'PROXY', outbounds: [] }];
  for (let i = 0; i < n; i++) {
    const name = `${pick(rnd, NAME_POOL)} ${i}`;
    const host = `s${i}.example.com`;
    outbounds.push({
      type: 'vless',
      tag: name,
      server: host,
      server_port: 443,
      uuid: UUID(i),
      tls: { enabled: true, server_name: host, utls: { enabled: true, fingerprint: 'chrome' } },
      transport: { type: 'ws', path: `/ws${i % 4}`, headers: { Host: host } },
    });
  }
  return JSON.stringify({ outbounds }, null, 2);
}

// ---------- 汇总用桩 Env：统计 KV 次数，并可注入模拟延迟 ----------
export interface KvCounters {
  gets: number;
  lists: number;
  puts: number;
}

export interface StubEnv {
  env: Env;
  counters: KvCounters;
  store: Map<string, unknown>;
}

export interface SubSpec {
  id: string;
  name: string;
  nodes: number;
  clean?: boolean;
}

/**
 * 节点名画像，决定采集侧走哪条成本曲线：
 * - collide：`🇭🇰 香港 01/02/…` —— 清洗后全部等于「香港」，撞上 uniqueNames 的去重命名
 * - distinct：未识别地区的原名 —— 清洗不生效，名字天然唯一
 * 这不是人为极端化：真实机场两者都常见，基线必须把两端都量出来。
 */
export type NameProfile = 'collide' | 'distinct';

export function snapshotName(profile: NameProfile, i: number): string {
  return profile === 'collide' ? `🇭🇰 香港 ${String(i).padStart(2, '0')}` : `Relay-${String(i).padStart(3, '0')}`;
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export const linkRec = (over: Partial<LinkRec> = {}): LinkRec => ({
  token: 'bench',
  label: 'bench',
  target: 'clash',
  rules: 'none',
  sources: [],
  includeCustom: false,
  enabled: true,
  createdAt: 0,
  ...over,
});

/**
 * 造一个只实现 get/list 的 KV 桩：键值放 Map，每次访问按 latencyMs 模拟 KV 往返。
 * counters 用于断言「一次 /s/ 请求到底读了几次 KV」。
 */
export function makeStubEnv(
  specs: SubSpec[],
  opts: { latencyMs?: number; customNodes?: number; profile?: NameProfile; link?: LinkRec } = {}
): StubEnv {
  const latencyMs = opts.latencyMs ?? 0;
  const profile = opts.profile ?? 'collide';
  const store = new Map<string, unknown>();
  const counters: KvCounters = { gets: 0, lists: 0, puts: 0 };

  specs.forEach((spec, si) => {
    const sub: SubRec = {
      id: spec.id,
      name: spec.name,
      urlEnc: '',
      enabled: true,
      createdAt: si + 1,
      clean: spec.clean ?? true,
    };
    const names = Array.from({ length: spec.nodes }, (_, i) => snapshotName(profile, i));
    const snap: SnapshotRec = {
      nodes: names.map((name, i) => ({
        name,
        type: 'vless' as const,
        server: `${spec.id}-${i}.example.com`,
        port: 443,
        uuid: UUID(i),
        encryption: 'none',
        network: 'ws' as const,
        tls: true,
        wsPath: `/ws${i % 5}`,
        wsHost: `${spec.id}-${i}.example.com`,
        sni: `${spec.id}-${i}.example.com`,
        fp: 'chrome',
      })),
      fetchedAt: 1,
    };
    store.set(`sub:${spec.id}`, sub);
    store.set(`snap:${spec.id}`, snap);
  });

  for (let i = 0; i < (opts.customNodes ?? 0); i++) {
    store.set(`node:c${i}`, {
      id: `c${i}`,
      node: { name: `自建-${i}`, type: 'trojan' as const, server: `c${i}.example.com`, port: 443, password: `pw${i}`, tls: true },
      createdAt: i,
    });
  }

  if (opts.link) store.set(`link:${opts.link.token}`, opts.link);

  const kv = {
    async get(key: string) {
      counters.gets += 1;
      await sleep(latencyMs);
      return store.has(key) ? store.get(key) : null;
    },
    async list({ prefix }: { prefix: string }) {
      counters.lists += 1;
      await sleep(latencyMs);
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    },
    async put(key: string, value: unknown) {
      counters.puts += 1;
      await sleep(latencyMs);
      store.set(key, value);
    },
  };

  return {
    env: { KV: kv, ASSETS: { fetch: async () => new Response('') }, SESSION_KEY: 'k', WRAP_KEY: 'w', SETUP_CODE: 's' } as unknown as Env,
    counters,
    store,
  };
}
