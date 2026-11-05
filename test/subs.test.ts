import { describe, expect, it } from 'vitest';
import { collectNodes, collectPool, type LinkRec, type SnapshotRec, type SubRec } from '../src/subs';
import type { Env } from '../src/auth';

function kvStub(data: Record<string, unknown>): Env {
  const store = new Map(Object.entries(data));
  return {
    KV: {
      async list({ prefix }: { prefix: string }) {
        return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
      },
      async get(key: string) {
        return store.has(key) ? store.get(key) : null;
      },
    },
  } as unknown as Env;
}

const sub = (id: string, name: string, over: Partial<SubRec> = {}): SubRec => ({
  id,
  name,
  urlEnc: '',
  enabled: true,
  createdAt: 1,
  clean: false, // 旧用例显式关闭清洗；清洗行为单独覆盖
  ...over,
});

const snap = (names: string[]): SnapshotRec => ({
  nodes: names.map((n, i) => ({ name: n, type: 'ss' as const, server: `s:${n}:${i}`, port: 1 })),
  fetchedAt: 1,
});

const link = (over: Partial<LinkRec>): LinkRec => ({
  token: 't',
  label: 'L',
  target: 'clash',
  rules: 'none',
  sources: [],
  includeCustom: false,
  enabled: true,
  createdAt: 1,
  ...over,
});

const env = kvStub({
  'sub:a': sub('a', '机场A'),
  'snap:a': snap(['HK-1', 'US-1 公告']),
  'sub:b': sub('b', '机场B'),
  'snap:b': snap(['HK-2']),
  'sub:ghost': sub('ghost', 'ghost'),
  'node:x': { id: 'x', node: { name: 'mine', type: 'trojan', server: 's', port: 1 }, createdAt: 1 },
});

describe('collectNodes', () => {
  it('来源前缀与自建节点合并', async () => {
    const r = await collectNodes(env, link({ sources: ['a', 'b'], includeCustom: true }));
    expect(r.nodes.map((n) => n.name)).toEqual(['[机场A] HK-1', '[机场A] US-1 公告', '[机场B] HK-2', '[自建] mine']);
  });

  it('订阅级包含正则只匹配原始节点名', async () => {
    const env2 = kvStub({
      'sub:f': sub('f', 'F', { include: 'HK', exclude: '公告' }),
      'snap:f': snap(['HK-1', 'HK-2 公告', 'US-1']),
    });
    const r = await collectNodes(env2, link({ sources: ['f'] }));
    expect(r.nodes.map((n) => n.name)).toEqual(['[F] HK-1']);
  });

  it('清洗后加来源前缀；未识别保留原名', async () => {
    const env2 = kvStub({
      'sub:c': sub('c', '机场C', { clean: true }),
      'snap:c': snap(['🇭🇰 香港 01 | 家宽 IPLC ˣ²', 'US-02', 'My Node']),
    });
    const r = await collectNodes(env2, link({ sources: ['c'] }));
    expect(r.nodes.map((n) => n.name)).toEqual(['[机场C] 香港 2× 家宽 IPLC', '[机场C] 美国', '[机场C] My Node']);
  });

  it('clean 缺省按开启处理', async () => {
    const env2 = kvStub({
      'sub:d': sub('d', 'D', { clean: undefined }),
      'snap:d': snap(['HK-01']),
    });
    const r = await collectNodes(env2, link({ sources: ['d'] }));
    expect(r.nodes.map((n) => n.name)).toEqual(['[D] 香港']);
  });

  it('链接正则同时匹配清洗后名称与原始名', async () => {
    const env2 = kvStub({
      'sub:l': sub('l', 'L', { clean: true }),
      'snap:l': snap(['HK-01', 'US-01']),
    });
    const byOriginal = await collectNodes(env2, link({ sources: ['l'], include: 'HK' }));
    expect(byOriginal.nodes.map((n) => n.name)).toEqual(['[L] 香港']);
    const byCleaned = await collectNodes(env2, link({ sources: ['l'], exclude: '美国' }));
    expect(byCleaned.nodes.map((n) => n.name)).toEqual(['[L] 香港']);
  });

  it('包含与排除同时应用', async () => {
    const r = await collectNodes(env, link({ sources: ['a'], include: '.', exclude: '公告' }));
    expect(r.nodes.map((n) => n.name)).toEqual(['[机场A] HK-1']);
  });

  it('无效正则不抛错、不过滤（保存时已校验）', async () => {
    const r = await collectNodes(env, link({ sources: ['a'], include: '[HK' }));
    expect(r.nodes).toHaveLength(2);
  });

  it('快照缺失与已删除订阅分别进 skipped，不阻断其他来源', async () => {
    const r = await collectNodes(env, link({ sources: ['a', 'ghost', 'gone'], includeCustom: true }));
    expect(r.nodes.map((n) => n.name)).toEqual(['[机场A] HK-1', '[机场A] US-1 公告', '[自建] mine']);
    expect(r.skipped).toEqual(['[ghost] 暂无可用快照', '来源包含已删除的订阅']);
  });

  it('内容完全相同的节点只保留第一个', async () => {
    const same = { name: 'HK-1', type: 'ss' as const, server: 'same', port: 443, password: 'pw' };
    const env2 = kvStub({
      'sub:a': sub('a', '机场A'),
      'snap:a': { nodes: [same], fetchedAt: 1 },
      'sub:b': sub('b', '机场B'),
      'snap:b': { nodes: [{ ...same, name: 'HK-1-B' }], fetchedAt: 1 },
    });
    const r = await collectNodes(env2, link({ sources: ['a', 'b'] }));
    expect(r.nodes.map((n) => n.name)).toEqual(['[机场A] HK-1']);
    expect(r.deduped).toBe(1);
  });

  it('同名不同节点追加序号', async () => {
    const env2 = kvStub({
      'sub:m': sub('m', 'M'),
      'snap:m': snap(['HK', 'HK']),
    });
    const r = await collectNodes(env2, link({ sources: ['m'] }));
    expect(r.nodes.map((n) => n.name)).toEqual(['[M] HK', '[M] HK #2']);
  });
});

describe('collectPool', () => {
  it('汇总启用订阅的清洗后节点 + 自建，跳过停用订阅', async () => {
    const env2 = kvStub({
      'sub:a': sub('a', '机场A', { clean: true }),
      'snap:a': snap(['HK-01', 'US-01']),
      'sub:b': sub('b', '机场B', { enabled: false }),
      'snap:b': snap(['JP-01']),
      'node:x': { id: 'x', node: { name: 'mine', type: 'trojan', server: 's', port: 1 }, createdAt: 1 },
    });
    const r = await collectPool(env2);
    expect(r.nodes.map((n) => [n.name, n.original, n.source])).toEqual([
      ['[机场A] 香港', 'HK-01', '机场A'],
      ['[机场A] 美国', 'US-01', '机场A'],
      ['[自建] mine', 'mine', '自建'],
    ]);
    expect(r.skipped).toEqual([]);
  });

  it('启用但无快照的订阅进 skipped', async () => {
    const env2 = kvStub({ 'sub:ghost': sub('ghost', 'ghost') });
    const r = await collectPool(env2);
    expect(r.nodes).toEqual([]);
    expect(r.skipped).toEqual(['[ghost] 暂无可用快照']);
  });
});
