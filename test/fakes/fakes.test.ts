// 桩自身的语义校准：测试结论的可信度，建立在桩与真实平台行为一致上。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeEnv } from './env';
import { FakeKV } from './kv';
import { stubFetch } from './fetch';
import { totpCode } from './totp';
import { base32Decode, base32Encode, verifyTotp } from '../../src/auth';

describe('FakeKV', () => {
  it('get 按 type 反序列化，缺失键返回 null', async () => {
    const kv = new FakeKV({ 'a:1': { x: 1 } });
    expect(await kv.get('a:1')).toBe('{"x":1}');
    expect(await kv.get('a:1', 'json')).toEqual({ x: 1 });
    expect(await kv.get('a:2')).toBeNull();
    expect(await kv.get('a:2', 'json')).toBeNull();
  });

  it('put / delete 生效', async () => {
    const kv = new FakeKV();
    await kv.put('k', 'v');
    expect(await kv.get('k')).toBe('v');
    await kv.delete('k');
    expect(await kv.get('k')).toBeNull();
  });

  it('list 只返回前缀匹配的键', async () => {
    const kv = new FakeKV({ 'sub:a': 1, 'sub:b': 2, 'node:c': 3 });
    const page = await kv.list({ prefix: 'sub:' });
    expect(page.keys.map((k) => k.name)).toEqual(['sub:a', 'sub:b']);
    expect(page.list_complete).toBe(true);
  });

  it('list 按 limit 分页，cursor 续页不重不漏', async () => {
    const kv = new FakeKV({ 'k:1': 1, 'k:2': 2, 'k:3': 3 });
    const first = await kv.list({ prefix: 'k:', limit: 2 });
    expect(first.keys.map((k) => k.name)).toEqual(['k:1', 'k:2']);
    expect(first.list_complete).toBe(false);
    const next = await kv.list({ prefix: 'k:', limit: 2, cursor: first.cursor });
    expect(next.keys.map((k) => k.name)).toEqual(['k:3']);
    expect(next.list_complete).toBe(true);
  });

  it('fail 让指定键的 get 抛错，模拟 KV 异常', async () => {
    const kv = new FakeKV({ bad: 'x' }).fail('bad', '内部细节');
    await expect(kv.get('bad')).rejects.toThrow('内部细节');
    expect(await kv.get('other')).toBeNull();
  });
});

describe('测试预言机', () => {
  it('totpCode 生成当前时窗内的合法验证码', async () => {
    const secret = base32Encode(new TextEncoder().encode('12345678901234567890'));
    const now = 59_000;
    expect(await totpCode(secret, now)).toBe('287082'); // RFC 6238 附录 B 向量
    expect(await verifyTotp(secret, await totpCode(secret, now), 0, now)).toBe(true);
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it('stubFetch 只放行登记过的 URL，其余抛错', async () => {
    const spy = stubFetch({ 'https://ok.test/': () => new Response('yes') });
    expect(await (await fetch('https://ok.test/')).text()).toBe('yes');
    expect(spy).toHaveBeenCalledTimes(1);
    await expect(fetch('https://other.test/')).rejects.toThrow('unexpected fetch: https://other.test/');
    vi.unstubAllGlobals();
  });

  it('makeEnv 提供与生产同形的 Env，且 secrets 固定', async () => {
    const env = makeEnv({ 'sub:x': { id: 'x' } });
    expect(env.KV).toBe(env.kv);
    expect(await env.KV.get('sub:x', 'json')).toEqual({ id: 'x' });
    expect(env.SESSION_KEY).toBe('test-session-key');
    expect(env.SETUP_CODE).toBe('test-setup-code');
    expect((await env.ASSETS.fetch(new Request('https://sw.test/'))).status).toBe(200);
  });
});

afterEach(() => vi.unstubAllGlobals());
