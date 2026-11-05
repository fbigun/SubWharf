import { describe, expect, it } from 'vitest';
import type { Env } from '../src/auth';
import type { ProxyNode } from '../src/parse';
import { getLink, type LinkRec } from '../src/subs';
import {
  buildTemplateConfig,
  createTemplate,
  deleteTemplate,
  getOutput,
  getTemplate,
  normalizeTemplateUrl,
  renderAll,
  updateTemplate,
} from '../src/template';

const node = (name: string): ProxyNode => ({ name, type: 'ss', server: 's.example.com', port: 8388, cipher: 'aes-128-gcm', password: 'pw' });

function template(outbounds: unknown[]): string {
  return JSON.stringify({
    log: { level: 'info' },
    dns: { final: 'dnspod' },
    inbounds: [{ type: 'tun', auto_route: true }],
    outbounds,
    route: { final: '远程' },
  });
}

const fullTemplate = (): string =>
  template([
    { type: 'direct', tag: '🎯 全球直连' },
    { type: 'selector', tag: '🚀 节点选择', outbounds: ['🔯 香港节点', '🔴 日本节点', '✨ 美国节点', '♻️ 自动选择', '🐸 手动切换'] },
    { type: 'selector', tag: '🐸 手动切换', outbounds: [] },
    { type: 'urltest', tag: '♻️ 自动选择', outbounds: [] },
    { type: 'urltest', tag: '🔯 香港节点', outbounds: [] },
    { type: 'urltest', tag: '🔴 日本节点', outbounds: [] },
    { type: 'urltest', tag: '✨ 美国节点', outbounds: [] },
  ]);

const parsed = (text: string) => JSON.parse(text);
const byTag = (cfg: any, tag: string) => cfg.outbounds.find((o: any) => o.tag === tag);

describe('buildTemplateConfig', () => {
  const nodes = [node('[机场A] 香港 01'), node('[机场A] 日本 01'), node('[机场A] 美国 01')];

  it('按地区与全部分组注入节点，保留模板其他字段', () => {
    const cfg = parsed(buildTemplateConfig(fullTemplate(), nodes));
    expect(cfg.log).toEqual({ level: 'info' });
    expect(cfg.dns).toEqual({ final: 'dnspod' });
    expect(cfg.route).toEqual({ final: '远程' });

    expect(byTag(cfg, '🔯 香港节点').outbounds).toEqual(['[机场A] 香港 01']);
    expect(byTag(cfg, '🔴 日本节点').outbounds).toEqual(['[机场A] 日本 01']);
    expect(byTag(cfg, '✨ 美国节点').outbounds).toEqual(['[机场A] 美国 01']);
    expect(byTag(cfg, '♻️ 自动选择').outbounds).toEqual(nodes.map((n) => n.name));
    expect(byTag(cfg, '🐸 手动切换').outbounds).toEqual(nodes.map((n) => n.name));
    // 已有静态成员的组保持不变
    expect(byTag(cfg, '🚀 节点选择').outbounds).toEqual(['🔯 香港节点', '🔴 日本节点', '✨ 美国节点', '♻️ 自动选择', '🐸 手动切换']);

    const injected = byTag(cfg, '[机场A] 香港 01');
    expect(injected).toMatchObject({ type: 'ss', server: 's.example.com', server_port: 8388, method: 'aes-128-gcm', password: 'pw' });
  });

  it('地区无匹配节点时回退 COMPATIBLE，且只创建一个直连出口', () => {
    const cfg = parsed(buildTemplateConfig(fullTemplate(), [node('[机场A] 香港 01')]));
    expect(byTag(cfg, '🔯 香港节点').outbounds).toEqual(['[机场A] 香港 01']);
    expect(byTag(cfg, '🔴 日本节点').outbounds).toEqual(['COMPATIBLE']);
    expect(byTag(cfg, '✨ 美国节点').outbounds).toEqual(['COMPATIBLE']);
    expect(cfg.outbounds.filter((o: any) => o.tag === 'COMPATIBLE')).toEqual([{ type: 'direct', tag: 'COMPATIBLE' }]);
  });

  it('空的自定义分组填全部节点', () => {
    const t = template([
      { type: 'selector', tag: '🚀 节点选择', outbounds: ['手动'] },
      { type: 'selector', tag: '手动', outbounds: ['DIRECT'] },
      { type: 'selector', tag: '🧪 自定义', outbounds: [] },
    ]);
    const cfg = parsed(buildTemplateConfig(t, [node('香港 01'), node('新加坡 01')]));
    expect(byTag(cfg, '🚀 节点选择').outbounds).toEqual(['手动']);
    expect(byTag(cfg, '手动').outbounds).toEqual(['DIRECT']);
    expect(byTag(cfg, '🧪 自定义').outbounds).toEqual(['香港 01', '新加坡 01']);
  });

  it('节点名与模板标签冲突时追加序号', () => {
    const t = template([
      { type: 'direct', tag: '[机场A] 香港 01' },
      { type: 'urltest', tag: '🔯 香港节点', outbounds: [] },
    ]);
    const cfg = parsed(buildTemplateConfig(t, [node('[机场A] 香港 01')]));
    expect(byTag(cfg, '🔯 香港节点').outbounds).toEqual(['[机场A] 香港 01 #2']);
    expect(cfg.outbounds.findIndex((o: any) => o.tag === '[机场A] 香港 01')).toBe(0);
  });

  it('无节点时所有分组回退直连', () => {
    const cfg = parsed(buildTemplateConfig(fullTemplate(), []));
    expect(byTag(cfg, '🔯 香港节点').outbounds).toEqual(['COMPATIBLE']);
    expect(byTag(cfg, '♻️ 自动选择').outbounds).toEqual(['COMPATIBLE']);
    expect(cfg.outbounds.filter((o: any) => o.tag === 'COMPATIBLE')).toHaveLength(1);
  });

  it('拒绝非 JSON 或缺少 outbounds 的模板', () => {
    expect(() => buildTemplateConfig('not json', [])).toThrow('模板不是有效 JSON');
    expect(() => buildTemplateConfig('{"dns":{}}', [])).toThrow('模板缺少 outbounds 数组');
    expect(() => buildTemplateConfig('[]', [])).toThrow('模板缺少 outbounds 数组');
  });
});

describe('normalizeTemplateUrl', () => {
  it('CNB 文件页地址转原始地址', () => {
    expect(normalizeTemplateUrl('https://cnb.cool/owner/sbt/-/blob/main/v1.14.json')).toBe(
      'https://cnb.cool/owner/sbt/-/git/raw/main/v1.14.json'
    );
  });

  it('原始地址与其他站点保持原样', () => {
    expect(normalizeTemplateUrl('https://cnb.cool/owner/sbt/-/git/raw/main/v1.14.json')).toBe(
      'https://cnb.cool/owner/sbt/-/git/raw/main/v1.14.json'
    );
    expect(normalizeTemplateUrl('https://example.com/tpl.json')).toBe('https://example.com/tpl.json');
  });

  it('非法地址抛错', () => {
    expect(() => normalizeTemplateUrl('not-a-url')).toThrow();
  });
});

function kvStub(data: Record<string, unknown>) {
  const store = new Map(Object.entries(data).map(([k, v]) => [k, JSON.stringify(v)]));
  const env = {
    KV: {
      async get(key: string, type?: string) {
        if (!store.has(key)) return null;
        const value = store.get(key)!;
        return type === 'json' ? JSON.parse(value) : value;
      },
      async put(key: string, value: string) {
        store.set(key, value);
      },
      async delete(key: string) {
        store.delete(key);
      },
      async list({ prefix }: { prefix: string }) {
        return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
      },
    },
  } as unknown as Env;
  return { env, store };
}

const tplText = (final: string) =>
  JSON.stringify({ inbounds: [{ type: 'tun' }], outbounds: [{ type: 'selector', tag: '手动', outbounds: [] }], route: { final } });

const linkRec = (token: string, templateId?: string): LinkRec => ({
  token,
  label: token,
  target: 'singbox',
  rules: 'none',
  sources: [],
  includeCustom: false,
  enabled: true,
  createdAt: 1,
  templateId,
});

const tplRec = (id: string, final: string) => ({
  id,
  name: id,
  url: `https://example.com/${id}.json`,
  text: tplText(final),
  fetchedAt: 1,
  createdAt: 1,
});

describe('多模板绑定与缓存', () => {
  const seed = () => ({
    'link:a': linkRec('a', 't1'),
    'link:b': linkRec('b', 't2'),
    'link:c': linkRec('c'),
    'template:t1': tplRec('t1', 'A'),
    'template:t2': tplRec('t2', 'B'),
  });

  it('按链接绑定的模板分别生成，未绑定的链接不生成', async () => {
    const { env } = kvStub(seed());
    expect(await renderAll(env)).toBe(2);
    expect(JSON.parse((await getOutput(env, 'a'))!.config).route.final).toBe('A');
    expect(JSON.parse((await getOutput(env, 'b'))!.config).route.final).toBe('B');
    expect(await getOutput(env, 'c')).toBeNull();
  });

  it('删除模板时解除链接绑定并清除其缓存，其他模板不受影响', async () => {
    const { env } = kvStub(seed());
    await renderAll(env);
    expect(await deleteTemplate(env, 't1')).toBe(true);
    expect(await getTemplate(env, 't1')).toBeNull();
    expect((await getLink(env, 'a'))!.templateId).toBeUndefined();
    expect(await getOutput(env, 'a')).toBeNull();
    expect((await getLink(env, 'b'))!.templateId).toBe('t2');
    expect(await getOutput(env, 'b')).not.toBeNull();
  });

  it('修改模板地址会丢弃旧原文与缓存，名称修改不动原文', async () => {
    const { env } = kvStub(seed());
    await renderAll(env);
    await updateTemplate(env, 't2', { name: '新名称' });
    expect((await getTemplate(env, 't2'))!.text).toBeTruthy();
    expect(await getOutput(env, 'b')).not.toBeNull();

    await updateTemplate(env, 't2', { url: 'https://example.com/other.json' });
    const rec = (await getTemplate(env, 't2'))!;
    expect(rec.name).toBe('新名称');
    expect(rec.url).toBe('https://example.com/other.json');
    expect(rec.text).toBeUndefined();
    expect(await getOutput(env, 'b')).toBeNull();
  });

  it('新增模板会归一化地址并补默认名称', async () => {
    const { env } = kvStub({});
    const rec = await createTemplate(env, { name: '  ', url: 'https://cnb.cool/o/r/-/blob/main/t.json' });
    expect(rec.name).toBe('未命名模板');
    expect(rec.url).toBe('https://cnb.cool/o/r/-/git/raw/main/t.json');
  });
});
