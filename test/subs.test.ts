import { describe, expect, it } from 'vitest';
import { collectNodes, type LinkRec, type SnapshotRec, type SubRec } from '../src/subs';
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

const sub = (id: string, name: string): SubRec => ({ id, name, urlEnc: '', enabled: true, createdAt: 1 });

const snap = (names: string[]): SnapshotRec => ({
  nodes: names.map((n) => ({ name: n, type: 'ss' as const, server: 's', port: 1 })),
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

  it('包含正则只留匹配节点', async () => {
    const r = await collectNodes(env, link({ sources: ['a', 'b'], include: 'HK' }));
    expect(r.nodes.map((n) => n.name)).toEqual(['[机场A] HK-1', '[机场B] HK-2']);
  });

  it('排除正则匹配含 [来源] 前缀的完整名', async () => {
    const r = await collectNodes(env, link({ sources: ['a'], exclude: '公告|机场B' }));
    expect(r.nodes.map((n) => n.name)).toEqual(['[机场A] HK-1']);
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

  it('重名追加序号', async () => {
    const env2 = kvStub({
      'sub:m': sub('m', 'M'),
      'snap:m': snap(['HK', 'HK']),
    });
    const r = await collectNodes(env2, link({ sources: ['m'] }));
    expect(r.nodes.map((n) => n.name)).toEqual(['[M] HK', '[M] HK #2']);
  });
});
