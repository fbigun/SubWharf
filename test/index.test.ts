// index.ts 端点行为基线：只断言外部可观察行为（状态码 / 响应头 / JSON 形状 / 错误文案），
// 作为后续路由与 KV 访问层重构的等价比对基准。
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import {
  b64urlEncode,
  createSession,
  generateTotpSecret,
  hashPassword,
  wrapField,
  type Env,
  type Profile,
} from '../src/auth';
import type { ProxyNode } from '../src/parse';
import type { LinkRec, SnapshotRec, SubRec } from '../src/subs';
import type { TemplateRec } from '../src/template';
import { okText, stubFetch } from './fakes/fetch';
import { TEST_SECRETS, makeEnv, type TestEnv } from './fakes/env';
import { totpCode } from './fakes/totp';

const BASE = 'https://sw.test';
const COOKIE = 'sw_sess';

// 订阅样例取自 parse.test.ts 已验证的 URI 形态（ss SIP002 + trojan）
const SS_URI = `ss://${b64urlEncode('aes-256-gcm:pw')}@1.2.3.4:8388#SS1`;
const TROJAN_URI = 'trojan://tp@5.6.7.8:443?sni=t.com#TJ1';
const SUB_URL = 'https://sub.example.com/a';

interface CallInit {
  method?: string;
  body?: BodyInit | null;
  headers?: Record<string, string>;
  cookie?: string;
}

const call = (env: TestEnv, path: string, init: CallInit = {}) => {
  const headers: Record<string, string> = { ...init.headers };
  if (init.cookie) headers.Cookie = init.cookie;
  return worker.fetch(new Request(`${BASE}${path}`, { method: init.method ?? 'GET', body: init.body, headers }), env);
};

const authed = async (): Promise<string> => `${COOKIE}=${await createSession(TEST_SECRETS.SESSION_KEY)}`;

/** 带合法会话的请求 */
const callAuth = async (env: TestEnv, path: string, init: CallInit = {}) =>
  call(env, path, { ...init, cookie: await authed() });

const body = async (res: Response): Promise<any> => JSON.parse(await res.text());

const nodeOf = (name: string, over: Partial<ProxyNode> = {}): ProxyNode => ({
  name,
  type: 'ss',
  server: '1.2.3.4',
  port: 8388,
  cipher: 'aes-256-gcm',
  password: 'pw',
  ...over,
});

const subOf = (id: string, over: Partial<SubRec> = {}): SubRec => ({
  id,
  name: `订阅${id}`,
  urlEnc: '',
  enabled: true,
  createdAt: 1,
  ...over,
});

const snapOf = (nodes: ProxyNode[]): SnapshotRec => ({ nodes, fetchedAt: 1_700_000_000_000 });

const linkOf = (token: string, over: Partial<LinkRec> = {}): LinkRec => ({
  token,
  label: '默认链接',
  target: 'clash',
  rules: 'none',
  sources: [],
  includeCustom: false,
  enabled: true,
  createdAt: 1,
  ...over,
});

const tplOf = (id: string, text: string, over: Partial<TemplateRec> = {}): TemplateRec => ({
  id,
  name: `模板${id}`,
  url: `https://tpl.example.com/${id}.json`,
  text,
  fetchedAt: 1,
  createdAt: 1,
  ...over,
});

const TEMPLATE_JSON = JSON.stringify({
  log: { level: 'info' },
  dns: { final: 'dnspod' },
  inbounds: [{ type: 'tun', auto_route: true }],
  outbounds: [{ type: 'direct', tag: 'direct' }],
  route: { final: 'PROXY' },
});

async function seedProfile(env: TestEnv, password = 'password-2024'): Promise<string> {
  const secret = generateTotpSecret();
  const profile: Profile = {
    passHash: await hashPassword(password),
    totpEnc: await wrapField(env, secret),
    totpVerified: true,
  };
  env.kv.seed('profile', profile);
  return secret;
}

/** 一个订阅 + 快照，供 /s/{token} 与 /api/pool 用例复用 */
function seedSource(env: TestEnv) {
  env.kv.seed('sub:s1', subOf('s1', { name: '机场A', clean: false }));
  env.kv.seed('snap:s1', snapOf([nodeOf('SS1'), nodeOf('TJ1', { type: 'vmess', uuid: 'uuid-1', wsPath: '/ws' })]));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------- 1. /api/me ----------

describe('/api/me', () => {
  it('GET 未初始化且无会话 → initialized false / authed false', async () => {
    const res = await call(makeEnv(), '/api/me');
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ initialized: false, authed: false });
  });

  it('GET 已初始化且有会话 → 两个标记均 true', async () => {
    const env = makeEnv();
    await seedProfile(env);
    const res = await callAuth(env, '/api/me');
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ initialized: true, authed: true });
  });

  it('GET 伪造/异密钥会话 → authed false（不报错）', async () => {
    const env = makeEnv();
    await seedProfile(env);
    const forged = `${COOKIE}=${await createSession('another-key')}`;
    const res = await call(env, '/api/me', { cookie: forged });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ initialized: true, authed: false });
  });

  it('GET 响应头带 nosniff 与 JSON Content-Type', async () => {
    const res = await call(makeEnv(), '/api/me');
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});

// ---------- 2. /api/setup ----------

describe('/api/setup', () => {
  const post = (env: TestEnv, payload: unknown) =>
    call(env, '/api/setup', { method: 'POST', body: JSON.stringify(payload) });

  it('POST 口令与密码合法 → 200 且返回 secret 与 otpauth', async () => {
    const env = makeEnv();
    const res = await post(env, { setupCode: TEST_SECRETS.SETUP_CODE, password: 'password-2024' });
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(Object.keys(b).sort()).toEqual(['otpauth', 'secret']);
    expect(b.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(b.otpauth).toContain(`secret=${b.secret}`);
    expect(b.otpauth.startsWith('otpauth://totp/')).toBe(true);
    // 初始化后 profile 落盘，TOTP 尚未绑定
    expect(env.kv.read<Profile>('profile')?.totpVerified).toBe(false);
  });

  it('POST 口令错误 → 403', async () => {
    const env = makeEnv();
    const res = await post(env, { setupCode: 'wrong-code', password: 'password-2024' });
    expect(res.status).toBe(403);
    expect(await body(res)).toEqual({ error: '初始化口令错误' });
    expect(env.kv.has('profile')).toBe(false);
  });

  it('POST 已初始化 → 409', async () => {
    const env = makeEnv();
    await seedProfile(env);
    const res = await post(env, { setupCode: TEST_SECRETS.SETUP_CODE, password: 'password-2024' });
    expect(res.status).toBe(409);
    expect(await body(res)).toEqual({ error: '已初始化，请直接登录' });
  });

  it('POST 密码不足 8 位 → 400 且不落盘', async () => {
    const env = makeEnv();
    const res = await post(env, { setupCode: TEST_SECRETS.SETUP_CODE, password: '1234567' });
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: '密码至少 8 位' });
    expect(env.kv.has('profile')).toBe(false);
  });

  it('POST 缺少口令或密码 → 400', async () => {
    const env = makeEnv();
    expect((await post(env, { password: 'password-2024' })).status).toBe(400);
    expect((await post(env, { setupCode: TEST_SECRETS.SETUP_CODE })).status).toBe(400);
    expect(await body(await post(env, {}))).toEqual({ error: '缺少初始化口令或密码' });
  });

  it('POST 请求体非法 JSON → 400（按缺少字段处理）', async () => {
    const res = await call(makeEnv(), '/api/setup', { method: 'POST', body: 'not-json' });
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: '缺少初始化口令或密码' });
  });

  it('POST 连续 5 次口令错误后 → 429 锁定', async () => {
    const env = makeEnv();
    for (let i = 0; i < 5; i++) await post(env, { setupCode: 'wrong', password: 'password-2024' });
    const res = await post(env, { setupCode: TEST_SECRETS.SETUP_CODE, password: 'password-2024' });
    expect(res.status).toBe(429);
    expect((await body(res)).error).toMatch(/^尝试次数过多，请 \d+ 分钟后再试$/);
  });
});

// ---------- 3. setup/verify、login、logout ----------

describe('/api/setup/verify 与 /api/login', () => {
  const post = (env: TestEnv, path: string, payload: unknown) =>
    call(env, path, { method: 'POST', body: JSON.stringify(payload) });

  /** 已初始化但未绑定 TOTP 的环境 */
  async function unverifiedEnv(): Promise<{ env: TestEnv; secret: string }> {
    const env = makeEnv();
    const secret = generateTotpSecret();
    env.kv.seed('profile', {
      passHash: await hashPassword('password-2024'),
      totpEnc: await wrapField(env, secret),
      totpVerified: false,
    } satisfies Profile);
    return { env, secret };
  }

  it('POST verify 正确验证码 → 200 且下发会话 Cookie，profile 标记已绑定', async () => {
    const { env, secret } = await unverifiedEnv();
    const res = await post(env, '/api/setup/verify', { code: await totpCode(secret) });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true });
    const cookie = res.headers.get('Set-Cookie') ?? '';
    expect(cookie).toContain(`${COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Max-Age=604800');
    expect(env.kv.read<Profile>('profile')?.totpVerified).toBe(true);
    // 下发的 Cookie 立即可用于受保护端点
    const sid = cookie.slice(`${COOKIE}=`.length).split(';')[0];
    expect((await call(env, '/api/status', { cookie: `${COOKIE}=${sid}` })).status).toBe(200);
  });

  it('POST verify 验证码错误 → 403', async () => {
    const { env } = await unverifiedEnv();
    const res = await post(env, '/api/setup/verify', { code: '000000' });
    expect(res.status).toBe(403);
    expect(await body(res)).toEqual({ error: '验证码错误' });
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('POST verify 未初始化 → 400', async () => {
    const res = await post(makeEnv(), '/api/setup/verify', { code: '123456' });
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: '请先完成初始化' });
  });

  it('POST verify 已绑定 → 409', async () => {
    const env = makeEnv();
    await seedProfile(env);
    const res = await post(env, '/api/setup/verify', { code: '123456' });
    expect(res.status).toBe(409);
    expect(await body(res)).toEqual({ error: 'TOTP 已绑定，请直接登录' });
  });

  it('POST login 密码与验证码正确 → 200 且下发会话 Cookie', async () => {
    const env = makeEnv();
    const secret = await seedProfile(env);
    const res = await post(env, '/api/login', { password: 'password-2024', code: await totpCode(secret) });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true });
    expect(res.headers.get('Set-Cookie')).toContain(`${COOKIE}=`);
  });

  it('POST login 密码或验证码错误 → 403', async () => {
    const env = makeEnv();
    const secret = await seedProfile(env);
    const wrongPass = await post(env, '/api/login', { password: 'wrong-password', code: await totpCode(secret) });
    expect(wrongPass.status).toBe(403);
    expect(await body(wrongPass)).toEqual({ error: '密码或验证码错误' });
    const wrongCode = await post(env, '/api/login', { password: 'password-2024', code: '000000' });
    expect(wrongCode.status).toBe(403);
  });

  it('POST login 未完成初始化 → 400', async () => {
    const env = makeEnv();
    env.kv.seed('profile', { passHash: 'pbkdf2$1$AA$BB', totpEnc: 'v1.a.b', totpVerified: false } satisfies Profile);
    const res = await post(env, '/api/login', { password: 'password-2024', code: '123456' });
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: '未完成初始化' });
    const empty = await post(makeEnv(), '/api/login', { password: 'password-2024', code: '123456' });
    expect(empty.status).toBe(400);
  });

  it('POST login 连续失败 5 次后 → 429 锁定', async () => {
    const env = makeEnv();
    const secret = await seedProfile(env);
    for (let i = 0; i < 5; i++) await post(env, '/api/login', { password: 'bad-password', code: '000000' });
    const res = await post(env, '/api/login', { password: 'password-2024', code: await totpCode(secret) });
    expect(res.status).toBe(429);
    expect((await body(res)).error).toMatch(/^失败次数过多，请 \d+ 分钟后再试$/);
  });

  it('POST logout 有会话 → 200 并清除 Cookie', async () => {
    const env = makeEnv();
    const res = await callAuth(env, '/api/logout', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true });
    const cookie = res.headers.get('Set-Cookie') ?? '';
    expect(cookie).toContain(`${COOKIE}=;`);
    expect(cookie).toContain('Max-Age=0');
  });

  it('POST logout 无会话 → 401', async () => {
    const res = await call(makeEnv(), '/api/logout', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(await body(res)).toEqual({ error: '未登录' });
  });
});

// ---------- 4. 受保护端点未登录 ----------

describe('受保护端点未登录', () => {
  const paths: [string, string][] = [
    ['GET', '/api/status'],
    ['POST', '/api/refresh-all'],
    ['GET', '/api/pool'],
    ['GET', '/api/subs'],
    ['POST', '/api/subs'],
    ['PUT', '/api/subs/s1'],
    ['DELETE', '/api/subs/s1'],
    ['GET', '/api/subs/s1/nodes'],
    ['POST', '/api/subs/s1/refresh'],
    ['GET', '/api/nodes'],
    ['POST', '/api/nodes'],
    ['DELETE', '/api/nodes/n1'],
    ['GET', '/api/links'],
    ['POST', '/api/links'],
    ['PUT', '/api/links/t1'],
    ['DELETE', '/api/links/t1'],
    ['POST', '/api/links/t1/reset'],
    ['GET', '/api/templates'],
    ['POST', '/api/templates'],
    ['PUT', '/api/templates/p1'],
    ['DELETE', '/api/templates/p1'],
    ['POST', '/api/templates/p1/refresh'],
    ['POST', '/api/templates/refresh'],
    ['GET', '/api/unknown'],
  ];

  it.each(paths)('%s %s 未登录 → 401 未登录', async (method, path) => {
    const res = await call(makeEnv(), path, { method, body: method === 'GET' ? null : '{}' });
    expect(res.status).toBe(401);
    expect(await body(res)).toEqual({ error: '未登录' });
  });

  it('错误签名的 Cookie 同样 → 401', async () => {
    const env = makeEnv();
    const sid = (await createSession(TEST_SECRETS.SESSION_KEY)).split('.');
    const res = await call(env, '/api/status', { cookie: `${COOKIE}=${sid[0]}.${sid[1]}.deadbeef` });
    expect(res.status).toBe(401);
  });
});

// ---------- 5. /api/status 与 /api/pool ----------

describe('/api/status', () => {
  it('GET 无订阅 → subs 空数组', async () => {
    const res = await callAuth(makeEnv(), '/api/status');
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ subs: [] });
  });

  it('GET 有订阅 → 字段齐全，format 缺省 base64、clean 缺省 true、无快照时 snap 为 null', async () => {
    const env = makeEnv();
    env.kv.seed('sub:s1', subOf('s1', { name: '机场A', ua: 'ua-1', include: 'HK', createdAt: 100 }));
    const res = await callAuth(env, '/api/status');
    const b = await body(res);
    expect(b.subs).toHaveLength(1);
    expect(b.subs[0]).toEqual({
      id: 's1',
      name: '机场A',
      ua: 'ua-1',
      format: 'base64',
      include: 'HK',
      clean: true,
      enabled: true,
      createdAt: 100,
      snap: null,
    });
  });

  it('GET 有快照 → snap 汇总节点数与抓取时间，不回传节点明细', async () => {
    const env = makeEnv();
    env.kv.seed('sub:s1', subOf('s1'));
    env.kv.seed('snap:s1', {
      nodes: [nodeOf('A'), nodeOf('B', { server: '5.6.7.8' })],
      skipped: ['坏行'],
      userinfo: { upload: 1, download: 2, total: 3, expire: 4 },
      fetchedAt: 1_700_000_000_000,
    } satisfies SnapshotRec);
    const b = await body(await callAuth(env, '/api/status'));
    expect(b.subs[0].snap).toEqual({
      fetchedAt: 1_700_000_000_000,
      nodeCount: 2,
      skipped: ['坏行'],
      userinfo: { upload: 1, download: 2, total: 3, expire: 4 },
    });
    // 成功快照不出现 error / errorAt 键（JSON.stringify 丢弃 undefined）
    expect(Object.keys(b.subs[0].snap).sort()).toEqual(['fetchedAt', 'nodeCount', 'skipped', 'userinfo']);
  });
});

describe('/api/pool', () => {
  it('GET 汇总节点 → 只回传展示字段，凭据不外泄', async () => {
    const env = makeEnv();
    seedSource(env);
    env.kv.seed('node:n1', { id: 'n1', node: nodeOf('自建1', { type: 'trojan', password: 'secret-pw' }), createdAt: 1 });
    const res = await callAuth(env, '/api/pool');
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.nodes.map((n: any) => n.name)).toEqual(['[机场A] SS1', '[机场A] TJ1', '[自建] 自建1']);
    for (const n of b.nodes) {
      expect(Object.keys(n).sort()).toEqual(['name', 'original', 'port', 'server', 'source', 'type']);
    }
    expect(JSON.stringify(b)).not.toContain('pw');
    expect(JSON.stringify(b)).not.toContain('uuid-1');
    expect(JSON.stringify(b)).not.toContain('secret-pw');
    expect(b.skipped).toEqual([]);
    expect(b.deduped).toBe(0);
  });

  it('GET 停用订阅的节点不出现在池中', async () => {
    const env = makeEnv();
    env.kv.seed('sub:on', subOf('on', { name: '启用', clean: false }));
    env.kv.seed('snap:on', snapOf([nodeOf('ON-1')]));
    env.kv.seed('sub:off', subOf('off', { name: '停用', clean: false, enabled: false, createdAt: 2 }));
    env.kv.seed('snap:off', snapOf([nodeOf('OFF-1', { server: '8.8.8.8' })]));
    const b = await body(await callAuth(env, '/api/pool'));
    expect(b.nodes.map((n: any) => n.name)).toEqual(['[启用] ON-1']);
  });

  it('GET 启用但无快照的订阅 → 进 skipped，节点列表仍为空数组', async () => {
    const env = makeEnv();
    env.kv.seed('sub:ghost', subOf('ghost', { name: '幽灵' }));
    const b = await body(await callAuth(env, '/api/pool'));
    expect(b.nodes).toEqual([]);
    expect(b.skipped).toEqual(['[幽灵] 暂无可用快照']);
  });
});

// ---------- 6. /api/subs ----------

describe('/api/subs 增删改查', () => {
  const post = (env: TestEnv, payload: unknown) =>
    callAuth(env, '/api/subs', { method: 'POST', body: JSON.stringify(payload) });

  it('POST 合法订阅 → 立即抓取一次并返回 id 与快照摘要', async () => {
    const env = makeEnv();
    stubFetch({
      [SUB_URL]: () =>
        okText([SS_URI, TROJAN_URI].join('\n'), {
          'subscription-userinfo': 'upload=100; download=200; total=300; expire=400',
        }),
    });
    const res = await post(env, { name: '机场A', url: SUB_URL });
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.id).toMatch(/^[0-9a-f]{16}$/);
    expect(b.snap).toEqual({
      fetchedAt: expect.any(Number),
      nodeCount: 2,
      userinfo: { upload: 100, download: 200, total: 300, expire: 400 },
    });
    expect(await body(await callAuth(env, `/api/subs/${b.id}/nodes`))).toEqual({
      name: '机场A',
      nodes: [
        { name: 'SS1', type: 'ss', server: '1.2.3.4', port: 8388 },
        { name: 'TJ1', type: 'trojan', server: '5.6.7.8', port: 443 },
      ],
    });
  });

  it('POST 缺少 URL → 400', async () => {
    const res = await post(makeEnv(), { name: '机场A' });
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: '缺少订阅 URL' });
  });

  it('POST include 非法正则 → 400 且不落盘', async () => {
    const env = makeEnv();
    const res = await post(env, { name: '机场A', url: SUB_URL, include: '[HK' });
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: '节点筛选正则表达式无效' });
    expect(env.kv.keys('sub:')).toEqual([]);
  });

  it('POST exclude 非法正则 → 400', async () => {
    const res = await post(makeEnv(), { name: '机场A', url: SUB_URL, exclude: '(未闭合' });
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: '节点筛选正则表达式无效' });
  });

  it('POST 抓取失败 → 200 且快照带 error（不抛 500）', async () => {
    const env = makeEnv();
    stubFetch({ [SUB_URL]: () => new Response('boom', { status: 500 }) });
    const res = await post(env, { name: '机场A', url: SUB_URL });
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.snap.error).toBe('HTTP 500');
    expect(b.snap.nodeCount).toBe(0);
  });

  it('PUT 合法改动 → 200 ok，状态随之更新', async () => {
    const env = makeEnv();
    env.kv.seed('sub:s1', subOf('s1', { name: '旧名' }));
    const res = await callAuth(env, '/api/subs/s1', { method: 'PUT', body: JSON.stringify({ name: '新名', enabled: false }) });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true });
    const b = await body(await callAuth(env, '/api/status'));
    expect(b.subs[0]).toMatchObject({ name: '新名', enabled: false });
  });

  it('PUT include 非法正则 → 400', async () => {
    const env = makeEnv();
    env.kv.seed('sub:s1', subOf('s1'));
    const res = await callAuth(env, '/api/subs/s1', { method: 'PUT', body: JSON.stringify({ include: '*bad' }) });
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: '节点筛选正则表达式无效' });
  });

  it('PUT 订阅不存在 → 404', async () => {
    const res = await callAuth(makeEnv(), '/api/subs/nope', { method: 'PUT', body: JSON.stringify({ name: 'x' }) });
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ error: '订阅不存在' });
  });

  it('DELETE → 200 ok 且订阅与快照一并清除', async () => {
    const env = makeEnv();
    env.kv.seed('sub:s1', subOf('s1'));
    env.kv.seed('snap:s1', snapOf([nodeOf('A')]));
    const res = await callAuth(env, '/api/subs/s1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true });
    expect(env.kv.keys('sub:')).toEqual([]);
    expect(env.kv.keys('snap:')).toEqual([]);
    expect(await body(await callAuth(env, '/api/status'))).toEqual({ subs: [] });
  });

  it('GET /api/subs/{id}/nodes → 只回传 name/type/server/port', async () => {
    const env = makeEnv();
    env.kv.seed('sub:s1', subOf('s1', { name: '机场A' }));
    env.kv.seed('snap:s1', snapOf([nodeOf('SS1', { password: 'secret-pw' }), nodeOf('VM', { type: 'vmess', uuid: 'secret-uuid' })]));
    const res = await callAuth(env, '/api/subs/s1/nodes');
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b).toEqual({
      name: '机场A',
      nodes: [
        { name: 'SS1', type: 'ss', server: '1.2.3.4', port: 8388 },
        { name: 'VM', type: 'vmess', server: '1.2.3.4', port: 8388 },
      ],
    });
    expect(JSON.stringify(b)).not.toContain('secret-');
  });

  it('GET /api/subs/{id}/nodes 订阅不存在 → 404', async () => {
    const res = await callAuth(makeEnv(), '/api/subs/nope/nodes');
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ error: '订阅不存在' });
  });

  it('GET /api/subs/{id}/nodes 无快照 → nodes 空数组', async () => {
    const env = makeEnv();
    env.kv.seed('sub:s1', subOf('s1', { name: '机场A' }));
    expect(await body(await callAuth(env, '/api/subs/s1/nodes'))).toEqual({ name: '机场A', nodes: [] });
  });

  it('POST /api/subs/{id}/refresh → 200 且刷新快照', async () => {
    const env = makeEnv();
    env.kv.seed('sub:s1', subOf('s1', { urlEnc: await wrapField(env, SUB_URL) }));
    stubFetch({ [SUB_URL]: () => okText([SS_URI, TROJAN_URI].join('\n')) });
    const res = await callAuth(env, '/api/subs/s1/refresh', { method: 'POST' });
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.snap.nodeCount).toBe(2);
    expect(b.snap.error).toBeUndefined();
  });

  it('POST /api/subs/{id}/refresh 订阅不存在 → 404', async () => {
    const res = await callAuth(makeEnv(), '/api/subs/nope/refresh', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ error: '订阅不存在' });
  });

  it('订阅 URL 加密落盘，不出现在任何响应中', async () => {
    const env = makeEnv();
    stubFetch({ [SUB_URL]: () => okText([SS_URI].join('\n')) });
    const res = await post(env, { name: '机场A', url: SUB_URL });
    expect(await res.text()).not.toContain(SUB_URL);
    const [subKey] = env.kv.keys('sub:');
    const stored = env.kv.read<SubRec>(subKey);
    expect(stored?.urlEnc.startsWith('v1.')).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(SUB_URL);
    expect(await (await callAuth(env, '/api/status')).text()).not.toContain(SUB_URL);
  });
});

// ---------- 7. /api/nodes ----------

describe('/api/nodes', () => {
  it('GET 空 → nodes 空数组', async () => {
    const b = await body(await callAuth(makeEnv(), '/api/nodes'));
    expect(b).toEqual({ nodes: [] });
  });

  it('GET 有节点 → 只回传 name/type/server/port，uuid 与 password 不外泄', async () => {
    const env = makeEnv();
    env.kv.seed('node:n1', { id: 'n1', node: nodeOf('SS1', { password: 'secret-pw' }), createdAt: 1 });
    env.kv.seed('node:n2', { id: 'n2', node: nodeOf('VM', { type: 'vmess', uuid: 'secret-uuid' }), createdAt: 2 });
    const b = await body(await callAuth(env, '/api/nodes'));
    expect(b).toEqual({
      nodes: [
        { id: 'n1', node: { name: 'SS1', type: 'ss', server: '1.2.3.4', port: 8388 } },
        { id: 'n2', node: { name: 'VM', type: 'vmess', server: '1.2.3.4', port: 8388 } },
      ],
    });
    expect(JSON.stringify(b)).not.toContain('secret-');
  });

  it('POST 合法 URI → added 计数，重复行进 skipped', async () => {
    const env = makeEnv();
    const res = await callAuth(env, '/api/nodes', { method: 'POST', body: JSON.stringify({ uris: [SS_URI, TROJAN_URI, SS_URI].join('\n') }) });
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.added).toBe(2);
    expect(b.skipped).toHaveLength(1);
    expect(b.skipped[0]).toContain('已存在');
    expect((await body(await callAuth(env, '/api/nodes'))).nodes).toHaveLength(2);
  });

  it('POST 含无法解析的行 → 200 且 skipped 带原因', async () => {
    const env = makeEnv();
    const b = await body(
      await callAuth(env, '/api/nodes', { method: 'POST', body: JSON.stringify({ uris: [SS_URI, 'snell://bad'].join('\n') }) })
    );
    expect(b.added).toBe(1);
    expect(b.skipped).toHaveLength(1);
    expect(b.skipped[0]).toContain('snell');
  });

  it('POST 缺少 uris → 400', async () => {
    const res = await callAuth(makeEnv(), '/api/nodes', { method: 'POST', body: JSON.stringify({ uris: '   ' }) });
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: '缺少节点 URI' });
  });

  it('DELETE → 200 ok 且节点消失', async () => {
    const env = makeEnv();
    env.kv.seed('node:n1', { id: 'n1', node: nodeOf('SS1'), createdAt: 1 });
    const res = await callAuth(env, '/api/nodes/n1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true });
    expect(await body(await callAuth(env, '/api/nodes'))).toEqual({ nodes: [] });
  });
});

// ---------- 8. /api/links ----------

describe('/api/links', () => {
  it('GET 空 → links 空数组', async () => {
    expect(await body(await callAuth(makeEnv(), '/api/links'))).toEqual({ links: [] });
  });

  it('POST 空对象 → 按默认值建链（clash / none / 默认标签 / 启用）', async () => {
    const env = makeEnv();
    const res = await callAuth(env, '/api/links', { method: 'POST', body: JSON.stringify({}) });
    expect(res.status).toBe(200);
    const { link } = await body(res);
    expect(link).toMatchObject({
      label: '默认链接',
      target: 'clash',
      rules: 'none',
      sources: [],
      includeCustom: true,
      enabled: true,
    });
    expect(link.token).toMatch(/^[0-9a-f]{32}$/);
    expect((await body(await callAuth(env, '/api/links'))).links).toHaveLength(1);
  });

  it('POST 指定 target/rules/sources → 原样保存', async () => {
    const env = makeEnv();
    seedSource(env);
    const res = await callAuth(env, '/api/links', {
      method: 'POST',
      body: JSON.stringify({ label: '手机', target: 'singbox', rules: 'cn', sources: ['s1'] }),
    });
    const { link } = await body(res);
    expect(link).toMatchObject({ label: '手机', target: 'singbox', rules: 'cn', sources: ['s1'] });
  });

  it('POST include 非法正则 → 400', async () => {
    const res = await callAuth(makeEnv(), '/api/links', { method: 'POST', body: JSON.stringify({ include: '[a-' }) });
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: '节点筛选正则表达式无效' });
  });

  it('PUT 修改标签与筛选 → 200 且回写生效', async () => {
    const env = makeEnv();
    env.kv.seed('link:t1', linkOf('t1'));
    const res = await callAuth(env, '/api/links/t1', {
      method: 'PUT',
      body: JSON.stringify({ label: '新标签', include: 'HK', sources: ['s1'] }),
    });
    expect(res.status).toBe(200);
    const { link } = await body(res);
    expect(link).toMatchObject({ token: 't1', label: '新标签', include: 'HK', sources: ['s1'] });
  });

  it('PUT 非法正则 → 400，链接不变', async () => {
    const env = makeEnv();
    env.kv.seed('link:t1', linkOf('t1'));
    const res = await callAuth(env, '/api/links/t1', { method: 'PUT', body: JSON.stringify({ exclude: '(' }) });
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: '节点筛选正则表达式无效' });
    expect(env.kv.read<LinkRec>('link:t1')?.label).toBe('默认链接');
  });

  it('PUT 链接不存在 → 404', async () => {
    const res = await callAuth(makeEnv(), '/api/links/nope', { method: 'PUT', body: JSON.stringify({ label: 'x' }) });
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ error: '链接不存在' });
  });

  it('POST reset → 换新 token：旧 token 404、新 token 可用', async () => {
    const env = makeEnv();
    seedSource(env);
    env.kv.seed('link:oldtoken', linkOf('oldtoken', { sources: ['s1'] }));
    expect((await call(env, '/s/oldtoken')).status).toBe(200);

    const res = await callAuth(env, '/api/links/oldtoken/reset', { method: 'POST' });
    expect(res.status).toBe(200);
    const { link } = await body(res);
    expect(link.token).toMatch(/^[0-9a-f]{32}$/);
    expect(link.token).not.toBe('oldtoken');
    expect(link.sources).toEqual(['s1']);

    const oldRes = await call(env, '/s/oldtoken');
    expect(oldRes.status).toBe(404);
    expect(await oldRes.text()).toBe('not found');
    expect((await call(env, `/s/${link.token}`)).status).toBe(200);
  });

  it('POST reset 链接不存在 → 404', async () => {
    const res = await callAuth(makeEnv(), '/api/links/nope/reset', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ error: '链接不存在' });
  });

  it('DELETE → 200 ok 且公开订阅随之 404', async () => {
    const env = makeEnv();
    seedSource(env);
    env.kv.seed('link:t1', linkOf('t1', { sources: ['s1'] }));
    const res = await callAuth(env, '/api/links/t1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true });
    expect((await call(env, '/s/t1')).status).toBe(404);
  });
});

// ---------- 9. /api/templates ----------

describe('/api/templates', () => {
  const TPL_URL = 'https://tpl.example.com/a.json';

  it('GET 空 → templates 空数组', async () => {
    expect(await body(await callAuth(makeEnv(), '/api/templates'))).toEqual({ templates: [] });
  });

  it('POST 合法模板 → 拉取原文并返回状态（含 outputs 数组）', async () => {
    const env = makeEnv();
    stubFetch({ [TPL_URL]: () => okText(TEMPLATE_JSON) });
    const res = await callAuth(env, '/api/templates', { method: 'POST', body: JSON.stringify({ name: '我的模板', url: TPL_URL }) });
    expect(res.status).toBe(200);
    const { templates } = await body(res);
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({ name: '我的模板', url: TPL_URL, outputs: [] });
    expect(templates[0].fetchedAt).toEqual(expect.any(Number));
    expect(templates[0].error).toBeUndefined();
  });

  it('POST CNB 文件页地址 → 归一化为 raw 地址再拉取', async () => {
    const env = makeEnv();
    const raw = 'https://cnb.cool/owner/repo/-/git/raw/main/tpl.json';
    stubFetch({ [raw]: () => okText(TEMPLATE_JSON) });
    const res = await callAuth(env, '/api/templates', {
      method: 'POST',
      body: JSON.stringify({ name: 't', url: 'https://cnb.cool/owner/repo/-/blob/main/tpl.json' }),
    });
    expect(res.status).toBe(200);
    expect((await body(res)).templates[0].url).toBe(raw);
  });

  it('POST 缺少名称或地址 → 400', async () => {
    const env = makeEnv();
    const noName = await callAuth(env, '/api/templates', { method: 'POST', body: JSON.stringify({ url: TPL_URL }) });
    expect(noName.status).toBe(400);
    expect(await body(noName)).toEqual({ error: '缺少模板名称' });
    const noUrl = await callAuth(env, '/api/templates', { method: 'POST', body: JSON.stringify({ name: 't' }) });
    expect(noUrl.status).toBe(400);
    expect(await body(noUrl)).toEqual({ error: '缺少模板地址' });
  });

  it('POST 地址非法 → 400 模板地址无效且不落盘', async () => {
    const env = makeEnv();
    const res = await callAuth(env, '/api/templates', { method: 'POST', body: JSON.stringify({ name: 't', url: 'not a url' }) });
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: '模板地址无效' });
    expect(env.kv.keys('template:')).toEqual([]);
  });

  it('POST 拉取内容不是模板 → 200 但状态带 error', async () => {
    const env = makeEnv();
    stubFetch({ [TPL_URL]: () => okText('not-a-template') });
    const res = await callAuth(env, '/api/templates', { method: 'POST', body: JSON.stringify({ name: 't', url: TPL_URL }) });
    expect(res.status).toBe(200);
    expect((await body(res)).templates[0].error).toBe('模板不是有效 JSON');
  });

  it('PUT 改名 → 200 且状态更新', async () => {
    const env = makeEnv();
    env.kv.seed('template:p1', tplOf('p1', TEMPLATE_JSON, { name: '旧名' }));
    const res = await callAuth(env, '/api/templates/p1', { method: 'PUT', body: JSON.stringify({ name: '新名' }) });
    expect(res.status).toBe(200);
    const { templates } = await body(res);
    expect(templates[0].name).toBe('新名');
  });

  it('PUT 地址非法 → 400 模板地址无效', async () => {
    const env = makeEnv();
    env.kv.seed('template:p1', tplOf('p1', TEMPLATE_JSON));
    const res = await callAuth(env, '/api/templates/p1', { method: 'PUT', body: JSON.stringify({ url: '::bad' }) });
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: '模板地址无效' });
  });

  it('PUT 模板不存在 → 404', async () => {
    const res = await callAuth(makeEnv(), '/api/templates/nope', { method: 'PUT', body: JSON.stringify({ name: 'x' }) });
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ error: '模板不存在' });
  });

  it('POST /api/templates/{id}/refresh → 200 且原文刷新', async () => {
    const env = makeEnv();
    env.kv.seed('template:p1', tplOf('p1', '', { text: undefined, url: TPL_URL, fetchedAt: undefined }));
    stubFetch({ [TPL_URL]: () => okText(TEMPLATE_JSON) });
    const res = await callAuth(env, '/api/templates/p1/refresh', { method: 'POST' });
    expect(res.status).toBe(200);
    const { templates } = await body(res);
    expect(templates[0].fetchedAt).toEqual(expect.any(Number));
    expect(templates[0].error).toBeUndefined();
  });

  it('POST /api/templates/{id}/refresh 模板不存在 → 404', async () => {
    const res = await callAuth(makeEnv(), '/api/templates/nope/refresh', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ error: '模板不存在' });
  });

  it('POST /api/templates/refresh → 200 且批量刷新', async () => {
    const env = makeEnv();
    env.kv.seed('template:p1', tplOf('p1', '', { text: undefined, url: TPL_URL, fetchedAt: undefined }));
    stubFetch({ [TPL_URL]: () => okText(TEMPLATE_JSON) });
    const res = await callAuth(env, '/api/templates/refresh', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await body(res)).templates[0].fetchedAt).toEqual(expect.any(Number));
  });

  it('DELETE 已存在 → 200 且列表为空', async () => {
    const env = makeEnv();
    env.kv.seed('template:p1', tplOf('p1', TEMPLATE_JSON));
    const res = await callAuth(env, '/api/templates/p1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ templates: [] });
  });

  it('DELETE 不存在 → 404 模板不存在', async () => {
    const res = await callAuth(makeEnv(), '/api/templates/nope', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ error: '模板不存在' });
  });
});

// ---------- 10. /s/{token} 公开订阅 ----------

describe('/s/{token} 公开订阅', () => {
  async function servedEnv(over: Partial<LinkRec> = {}): Promise<TestEnv> {
    const env = makeEnv();
    env.kv.seed('sub:s1', subOf('s1', { name: '机场A', clean: false }));
    env.kv.seed('snap:s1', snapOf([nodeOf('SS1'), nodeOf('TJ1', { type: 'trojan', server: '5.6.7.8', port: 443, password: 'tp' })]));
    env.kv.seed('link:tok', linkOf('tok', { sources: ['s1'], ...over }));
    return env;
  }

  it('GET 不存在 token → 404 not found', async () => {
    const res = await call(makeEnv(), '/s/nope');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('not found');
  });

  it('GET 已禁用链接 → 404', async () => {
    const env = await servedEnv({ enabled: false });
    const res = await call(env, '/s/tok');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('not found');
  });

  it('GET 空 token（/s/）→ 404', async () => {
    expect((await call(makeEnv(), '/s/')).status).toBe(404);
  });

  it('GET 畸形百分号转义 → 按原样匹配后 404（不抛 500）', async () => {
    const res = await call(makeEnv(), '/s/%zz');
    expect(res.status).toBe(404);
  });

  it('GET 默认 target=clash → YAML + 输出头与更新间隔', async () => {
    const env = await servedEnv();
    const res = await call(env, '/s/tok');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/yaml; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="config.yaml"');
    expect(res.headers.get('profile-update-interval')).toBe('12');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const text = await res.text();
    expect(text.startsWith('mixed-port: 7890')).toBe(true);
    expect(text).toContain('- name: "[机场A] SS1"');
    expect(text).toContain('rules:');
    expect(text).toContain('MATCH,PROXY');
    expect(text).not.toContain('GEOSITE,CN');
  });

  it('GET ?target=singbox → JSON 配置（内置最小配置）', async () => {
    const env = await servedEnv();
    const res = await call(env, '/s/tok?target=singbox');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="config.json"');
    expect(res.headers.get('profile-update-interval')).toBe('12');
    const cfg = JSON.parse(await res.text());
    expect(cfg.outbounds[0]).toMatchObject({ type: 'selector', tag: 'PROXY' });
    expect(cfg.outbounds.map((o: any) => o.tag)).toContain('[机场A] SS1');
    expect(cfg.inbounds).toHaveLength(1);
  });

  it('GET ?target=uri → 明文 URI 列表', async () => {
    const env = await servedEnv();
    const res = await call(env, '/s/tok?target=uri');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    const lines = (await res.text()).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith('ss://')).toBe(true);
    expect(lines[0]).toContain(encodeURIComponent('[机场A] SS1'));
    expect(lines[1].startsWith('trojan://')).toBe(true);
  });

  it('GET ?target=base64 → base64 编码的 URI 列表', async () => {
    const env = await servedEnv();
    const res = await call(env, '/s/tok?target=base64');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    const text = await res.text();
    expect(atob(text)).toBe((await (await call(env, '/s/tok?target=uri')).text()));
  });

  it('GET ?rules=cn → Clash 带绕华直连规则', async () => {
    const env = await servedEnv();
    const text = await (await call(env, '/s/tok?rules=cn')).text();
    expect(text).toContain('GEOSITE,CN,DIRECT');
    expect(text).toContain('GEOIP,CN,DIRECT');
    expect(text).toContain('MATCH,PROXY');
  });

  it('GET ?rules=cn 的 singbox → 带 rule_set 与 direct 出口', async () => {
    const env = await servedEnv();
    const cfg = JSON.parse(await (await call(env, '/s/tok?target=singbox&rules=cn')).text());
    expect(cfg.route.rule_set.map((r: any) => r.tag)).toEqual(['geosite-cn', 'geoip-cn']);
    expect(cfg.outbounds.some((o: any) => o.tag === 'direct')).toBe(true);
  });

  it('GET ?rules=none 覆盖链接默认的 cn', async () => {
    const env = await servedEnv({ rules: 'cn' });
    const text = await (await call(env, '/s/tok?rules=none')).text();
    expect(text).not.toContain('GEOSITE,CN');
    expect((await (await call(env, '/s/tok')).text())).toContain('GEOSITE,CN');
  });

  it('GET 非法 target → 回落到链接默认 target', async () => {
    const env = await servedEnv({ target: 'singbox' });
    const res = await call(env, '/s/tok?target=surge');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(JSON.parse(await res.text()).outbounds[0].tag).toBe('PROXY');
  });

  it('GET 非法 rules → 回落到链接默认 rules', async () => {
    const env = await servedEnv({ rules: 'cn' });
    expect(await (await call(env, '/s/tok?rules=always')).text()).toContain('GEOSITE,CN');
  });

  it('GET 绑定 singbox 模板 → 返回模板渲染结果（含模板原有字段与注入节点）', async () => {
    const env = await servedEnv({ target: 'singbox', templateId: 'p1' });
    env.kv.seed('template:p1', tplOf('p1', TEMPLATE_JSON));
    const res = await call(env, '/s/tok');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    const cfg = JSON.parse(await res.text());
    expect(cfg.dns).toEqual({ final: 'dnspod' });
    expect(cfg.inbounds).toEqual([{ type: 'tun', auto_route: true }]);
    const tags = cfg.outbounds.map((o: any) => o.tag);
    expect(tags).toContain('[机场A] SS1');
    expect(tags).toContain('[机场A] TJ1');
  });

  it('GET 同一模板链接连续两次 → 命中缓存结果一致', async () => {
    const env = await servedEnv({ target: 'singbox', templateId: 'p1' });
    env.kv.seed('template:p1', tplOf('p1', TEMPLATE_JSON));
    const first = await (await call(env, '/s/tok')).text();
    const second = await (await call(env, '/s/tok')).text();
    expect(second).toBe(first);
  });

  it('GET 链接绑定的模板已删除 → 回落内置最小配置（不报错）', async () => {
    const env = await servedEnv({ target: 'singbox', templateId: 'gone' });
    const res = await call(env, '/s/tok');
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text()).outbounds[0].tag).toBe('PROXY');
  });

  it('GET 来源订阅已删除 → 200 且只输出空配置', async () => {
    const env = makeEnv();
    env.kv.seed('link:tok', linkOf('tok', { sources: ['gone'], includeCustom: false }));
    const res = await call(env, '/s/tok?target=uri');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});

// ---------- 11. 请求体上限 ----------

describe('请求体上限 1 MiB', () => {
  it('POST Content-Length 声明超限 → 413 请求体过大', async () => {
    const env = makeEnv();
    const res = await callAuth(env, '/api/subs', {
      method: 'POST',
      body: 'x',
      headers: { 'Content-Length': String((1 << 20) + 1) },
    });
    expect(res.status).toBe(413);
    expect(await body(res)).toEqual({ error: '请求体过大' });
  });

  it('POST chunked（无 Content-Length）实际读取超限 → 413', async () => {
    const env = makeEnv();
    const big = 'a'.repeat((1 << 20) + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const req = new Request(`${BASE}/api/nodes`, {
      method: 'POST',
      body: stream,
      duplex: 'half',
      headers: { Cookie: await authed() },
    } as RequestInit);
    expect(req.headers.get('Content-Length')).toBeNull();
    const res = await worker.fetch(req, env as unknown as Env);
    expect(res.status).toBe(413);
    expect(await body(res)).toEqual({ error: '请求体过大' });
  });

  // 当前口径：readJson 判的是 text.length（UTF-16 码元数），不是字节数。
  // 这不是本次要改的行为，但必须钉住——重构时若改成按字节计，这条会红。
  it('chunked 多字节正文：按字符数计口径（1 MiB 个汉字 = 3 MiB 字节仍放行）', async () => {
    const env = makeEnv();
    const text = '中'.repeat(1 << 20);
    expect(new TextEncoder().encode(text).byteLength).toBe(3 * (1 << 20));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    const req = new Request(`${BASE}/api/nodes`, {
      method: 'POST',
      body: stream,
      duplex: 'half',
      headers: { Cookie: await authed() },
    } as RequestInit);
    const res = await worker.fetch(req, env as unknown as Env);
    expect(res.status).toBe(400); // 未被 413 拦，落到「缺少节点 URI」
    expect(await body(res)).toEqual({ error: '缺少节点 URI' });
  });

  it('恰好 1 MiB 以内 → 正常处理（不误判）', async () => {
    const env = makeEnv();
    const padding = 'a'.repeat((1 << 20) - 32);
    const res = await callAuth(env, '/api/nodes', { method: 'POST', body: JSON.stringify({ uris: '', pad: padding }) });
    expect(res.status).toBe(400); // 缺 uris，但证明没被 413 拦下
    expect(await body(res)).toEqual({ error: '缺少节点 URI' });
  });
});

// ---------- 12. 未知接口 / 未捕获异常 ----------

describe('路由兜底与异常处理', () => {
  it('GET 未知 /api/xxx（已登录）→ 404 接口不存在', async () => {
    const res = await callAuth(makeEnv(), '/api/xxx');
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ error: '接口不存在' });
  });

  it('已知路径的错误方法 → 404 接口不存在', async () => {
    const env = makeEnv();
    expect((await callAuth(env, '/api/subs', { method: 'PATCH', body: '{}' })).status).toBe(404);
    expect((await callAuth(env, '/api/status', { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await callAuth(env, '/api/me', { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('未捕获异常 → 500 且只回传统一文案，不泄露内部消息', async () => {
    const env = makeEnv();
    env.kv.seed('sub:s1', subOf('s1'));
    env.kv.fail('sub:s1', 'KV 内部错误：secret-internal-detail');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await callAuth(env, '/api/status');
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: '服务器内部错误' });
    expect(text).not.toContain('secret-internal-detail');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(spy).toHaveBeenCalled();
  });

  it('公开订阅读取异常 → 同样 500 统一文案', async () => {
    const env = makeEnv();
    env.kv.seed('link:tok', linkOf('tok'));
    env.kv.fail('link:tok', 'KV 内部错误：secret-internal-detail');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call(env, '/s/tok');
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: '服务器内部错误' });
    expect(text).not.toContain('secret-internal-detail');
  });

  it('非 /api/ 与 /s/ 路径 → 交给静态资产', async () => {
    const env = makeEnv();
    const res = await call(env, '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toContain('SubWharf');
    expect(env.assets.requests).toHaveLength(1);
    expect(new URL(env.assets.requests[0].url).pathname).toBe('/');
  });

  it('POST /api/refresh-all → 200 且返回最新状态', async () => {
    const env = makeEnv();
    env.kv.seed('sub:s1', subOf('s1', { urlEnc: await wrapField(env, SUB_URL) }));
    stubFetch({ [SUB_URL]: () => okText(SS_URI) });
    const res = await callAuth(env, '/api/refresh-all', { method: 'POST' });
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.subs[0].snap.nodeCount).toBe(1);
  });
});

// ---------- 补充：上面各端点的其余分支（同一批行为的细粒度补齐）----------

describe('/s/{token} 输出细节', () => {
  it('GET ruleSource=jsdelivr 的 singbox rules=cn → rule_set 走镜像地址', async () => {
    const env = makeEnv();
    env.kv.seed('link:tok', linkOf('tok', { target: 'singbox', rules: 'cn', ruleSource: 'jsdelivr' }));
    const cfg = JSON.parse(await (await call(env, '/s/tok')).text());
    expect(cfg.route.rule_set[0].url.startsWith('https://cdn.jsdelivr.net/gh/SagerNet/')).toBe(true);
  });

  it('GET ruleSource=official 的 singbox rules=cn → rule_set 走官方地址', async () => {
    const env = makeEnv();
    env.kv.seed('link:tok', linkOf('tok', { target: 'singbox', rules: 'cn', ruleSource: 'official' }));
    const cfg = JSON.parse(await (await call(env, '/s/tok')).text());
    expect(cfg.route.rule_set[0].url.startsWith('https://raw.githubusercontent.com/SagerNet/')).toBe(true);
  });

  it('GET token 含百分号编码 → 解码后命中同一链接', async () => {
    const env = makeEnv();
    env.kv.seed('link:a-b', linkOf('a-b', { target: 'uri' }));
    expect((await call(env, '/s/a%2Db')).status).toBe(200);
  });

  it('GET 链接筛选正则生效 → 只输出匹配节点', async () => {
    const env = makeEnv();
    env.kv.seed('sub:s1', subOf('s1', { name: '机场A', clean: false }));
    env.kv.seed('snap:s1', snapOf([nodeOf('HK-1'), nodeOf('US-1', { server: '9.9.9.9' })]));
    env.kv.seed('link:tok', linkOf('tok', { sources: ['s1'], target: 'uri', include: 'HK' }));
    const text = await (await call(env, '/s/tok')).text();
    expect(text).toContain('HK-1');
    expect(text).not.toContain('US-1');
  });

  it('PUT 换绑模板 → 旧渲染缓存失效，公开订阅返回新模板配置', async () => {
    const env = makeEnv();
    env.kv.seed('sub:s1', subOf('s1', { name: '机场A', clean: false }));
    env.kv.seed('snap:s1', snapOf([nodeOf('SS1')]));
    env.kv.seed('template:p1', tplOf('p1', TEMPLATE_JSON));
    env.kv.seed('template:p2', tplOf('p2', JSON.stringify({ ...JSON.parse(TEMPLATE_JSON), dns: { final: '另一个DNS' } })));
    env.kv.seed('link:tok', linkOf('tok', { sources: ['s1'], target: 'singbox', templateId: 'p1' }));

    expect(JSON.parse(await (await call(env, '/s/tok')).text()).dns).toEqual({ final: 'dnspod' });
    const put = await callAuth(env, '/api/links/tok', { method: 'PUT', body: JSON.stringify({ templateId: 'p2' }) });
    expect((await body(put)).link.templateId).toBe('p2');
    expect(JSON.parse(await (await call(env, '/s/tok')).text()).dns).toEqual({ final: '另一个DNS' });
  });
});

describe('/api/templates 变更对 /s/{token} 的影响', () => {
  it('PUT 模板改地址 → 从新地址重新拉取', async () => {
    const env = makeEnv();
    const oldUrl = 'https://tpl.example.com/old.json';
    const newUrl = 'https://tpl.example.com/new.json';
    env.kv.seed('template:p1', tplOf('p1', TEMPLATE_JSON, { url: oldUrl }));
    stubFetch({ [newUrl]: () => okText(TEMPLATE_JSON) });
    const res = await callAuth(env, '/api/templates/p1', { method: 'PUT', body: JSON.stringify({ url: newUrl }) });
    expect(res.status).toBe(200);
    const t = (await body(res)).templates[0];
    expect(t.url).toBe(newUrl);
    expect(t.fetchedAt).toEqual(expect.any(Number));
    expect(t.error).toBeUndefined();
  });

  it('DELETE 模板 → 绑定链接回落内置最小配置', async () => {
    const env = makeEnv();
    env.kv.seed('sub:s1', subOf('s1', { name: '机场A', clean: false }));
    env.kv.seed('snap:s1', snapOf([nodeOf('SS1')]));
    env.kv.seed('template:p1', tplOf('p1', TEMPLATE_JSON));
    env.kv.seed('link:tok', linkOf('tok', { sources: ['s1'], target: 'singbox', templateId: 'p1' }));

    expect(JSON.parse(await (await call(env, '/s/tok')).text()).dns).toEqual({ final: 'dnspod' });
    expect((await callAuth(env, '/api/templates/p1', { method: 'DELETE' })).status).toBe(200);
    const cfg = JSON.parse(await (await call(env, '/s/tok')).text());
    expect(cfg.dns).toBeUndefined();
    expect(cfg.outbounds[0].tag).toBe('PROXY');
  });

  it('模板刷新失败 → 200 且状态保留 error，缓存输出不中断', async () => {
    const env = makeEnv();
    const url = 'https://tpl.example.com/broken.json';
    env.kv.seed('template:p1', tplOf('p1', TEMPLATE_JSON, { url, fetchedAt: 1 }));
    stubFetch({ [url]: () => new Response('nope', { status: 503 }) });
    const res = await callAuth(env, '/api/templates/p1/refresh', { method: 'POST' });
    expect(res.status).toBe(200);
    const t = (await body(res)).templates[0];
    expect(t.error).toBe('HTTP 503');
    expect(t.fetchedAt).toBe(1); // 保留上次成功时间
  });
});

describe('/api/status 与 /api/subs 快照错误状态', () => {
  it('GET /api/status 抓取失败的订阅 → snap 带 error 与 errorAt', async () => {
    const env = makeEnv();
    env.kv.seed('sub:s1', subOf('s1'));
    env.kv.seed('snap:s1', { nodes: [], error: 'HTTP 502', errorAt: 1_700_000_000_000 });
    const b = await body(await callAuth(env, '/api/status'));
    expect(b.subs[0].snap).toEqual({
      fetchedAt: undefined,
      error: 'HTTP 502',
      errorAt: 1_700_000_000_000,
      nodeCount: 0,
      skipped: undefined,
      userinfo: undefined,
    });
    // 未产生的字段被 JSON.stringify 丢弃：客户端只看到有内容的键
    expect(Object.keys(b.subs[0].snap).sort()).toEqual(['error', 'errorAt', 'nodeCount']);
  });

  it('POST /api/subs 抓取失败后 nodes 端点仍可读（空列表）', async () => {
    const env = makeEnv();
    stubFetch({ [SUB_URL]: () => new Response('boom', { status: 500 }) });
    const { id } = await body(await callAuth(env, '/api/subs', { method: 'POST', body: JSON.stringify({ name: 'A', url: SUB_URL }) }));
    expect(await body(await callAuth(env, `/api/subs/${id}/nodes`))).toEqual({ name: 'A', nodes: [] });
  });
});

describe('/api/subs 上游请求头', () => {
  it('POST 订阅 format=clash → 用 Clash UA 抓取', async () => {
    const env = makeEnv();
    const seen: Record<string, string> = {};
    stubFetch({
      [SUB_URL]: (_url, init) => {
        Object.assign(seen, (init?.headers ?? {}) as Record<string, string>);
        return okText(SS_URI);
      },
    });
    await callAuth(env, '/api/subs', { method: 'POST', body: JSON.stringify({ name: 'A', url: SUB_URL, format: 'clash' }) });
    expect(seen['User-Agent']).toBe('clash.meta/v1.19.10');
  });

  it('POST 订阅缺省 format → 默认 v2rayN UA', async () => {
    const env = makeEnv();
    const seen: Record<string, string> = {};
    stubFetch({
      [SUB_URL]: (_url, init) => {
        Object.assign(seen, (init?.headers ?? {}) as Record<string, string>);
        return okText(SS_URI);
      },
    });
    await callAuth(env, '/api/subs', { method: 'POST', body: JSON.stringify({ name: 'A', url: SUB_URL }) });
    expect(seen['User-Agent']).toBe('v2rayN/6.60');
  });
});

describe('scheduled 定时任务', () => {
  it('刷新启用订阅与模板，未启用订阅跳过', async () => {
    const env = makeEnv();
    const TPL_URL = 'https://tpl.example.com/sched.json';
    env.kv.seed('sub:s1', subOf('s1', { name: 'A', urlEnc: await wrapField(env, SUB_URL) }));
    env.kv.seed('sub:s2', subOf('s2', { name: 'B', urlEnc: await wrapField(env, 'https://sub.example.com/b'), enabled: false }));
    env.kv.seed('template:p1', tplOf('p1', '', { text: undefined, url: TPL_URL, fetchedAt: undefined }));
    stubFetch({ [SUB_URL]: () => okText([SS_URI, TROJAN_URI].join('\n')), [TPL_URL]: () => okText(TEMPLATE_JSON) });

    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
    await worker.scheduled({} as ScheduledController, env as unknown as Env, ctx);
    await Promise.all(pending);

    expect(env.kv.read<SnapshotRec>('snap:s1')?.nodes).toHaveLength(2);
    expect(env.kv.has('snap:s2')).toBe(false);
    expect(env.kv.read<TemplateRec>('template:p1')?.fetchedAt).toEqual(expect.any(Number));
  });
});

describe('模板缓存失败不影响主操作', () => {
  it('模板重渲染抛错时 POST /api/links 仍返回 200', async () => {
    const env = makeEnv();
    env.kv.seed('template:p1', tplOf('p1', TEMPLATE_JSON));
    env.kv.fail('template:p1', 'KV 读取失败：模板');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await callAuth(env, '/api/links', { method: 'POST', body: JSON.stringify({ label: 'x' }) });
    expect(res.status).toBe(200);
    expect((await body(res)).link.label).toBe('x');
    expect(env.kv.keys('link:')).toHaveLength(1);
  });

  it('模板重渲染抛错时 DELETE /api/subs 仍返回 200', async () => {
    const env = makeEnv();
    env.kv.seed('sub:s1', subOf('s1'));
    env.kv.seed('template:p1', tplOf('p1', TEMPLATE_JSON));
    env.kv.fail('template:p1', 'KV 读取失败：模板');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await callAuth(env, '/api/subs/s1', { method: 'DELETE' })).status).toBe(200);
    expect(env.kv.keys('sub:')).toEqual([]);
  });
});

describe('/s/{token} 空节点输出', () => {
  it('GET target=clash 无节点 → proxies 空列表 + DIRECT 兜底组', async () => {
    const env = makeEnv();
    env.kv.seed('link:tok', linkOf('tok', { target: 'clash' }));
    const text = await (await call(env, '/s/tok')).text();
    expect(text).toContain('proxies: []');
    expect(text).toContain('- DIRECT');
    expect(text).toContain('MATCH,PROXY');
  });

  it('GET target=singbox 无节点 → PROXY 组含 direct 兜底', async () => {
    const env = makeEnv();
    env.kv.seed('link:tok', linkOf('tok', { target: 'singbox' }));
    const cfg = JSON.parse(await (await call(env, '/s/tok')).text());
    expect(cfg.outbounds[0]).toEqual({ type: 'selector', tag: 'PROXY', outbounds: ['direct'] });
    expect(cfg.outbounds.some((o: any) => o.type === 'direct')).toBe(true);
  });

  it('GET target=base64 无节点 → 空串的 base64（即空响应体）', async () => {
    const env = makeEnv();
    env.kv.seed('link:tok', linkOf('tok', { target: 'base64' }));
    expect(await (await call(env, '/s/tok')).text()).toBe('');
  });
});

describe('/api/me 与初始化状态组合', () => {
  it('GET 未初始化但有合法会话 → initialized false / authed true', async () => {
    const env = makeEnv();
    const res = await callAuth(env, '/api/me');
    expect(await body(res)).toEqual({ initialized: false, authed: true });
  });

  it('GET 已初始化无会话 → initialized true / authed false', async () => {
    const env = makeEnv();
    await seedProfile(env);
    expect(await body(await call(env, '/api/me'))).toEqual({ initialized: true, authed: false });
  });

  it('GET /api/me 不受登录锁影响（锁定期间仍可读）', async () => {
    const env = makeEnv();
    for (let i = 0; i < 5; i++) {
      await call(env, '/api/login', { method: 'POST', body: JSON.stringify({ password: 'x', code: '000000' }) });
    }
    expect((await call(env, '/api/me')).status).toBe(200);
  });
});

describe('/api/subs 其他分支', () => {
  it('POST enabled=false → 保存为停用，状态可见', async () => {
    const env = makeEnv();
    stubFetch({ [SUB_URL]: () => okText(SS_URI) });
    const { id } = await body(
      await callAuth(env, '/api/subs', { method: 'POST', body: JSON.stringify({ name: 'A', url: SUB_URL, enabled: false }) })
    );
    const b = await body(await callAuth(env, '/api/status'));
    expect(b.subs.find((x: any) => x.id === id).enabled).toBe(false);
  });

  it('POST 未给名称 → 落盘为「未命名订阅」', async () => {
    const env = makeEnv();
    stubFetch({ [SUB_URL]: () => okText(SS_URI) });
    const { id } = await body(await callAuth(env, '/api/subs', { method: 'POST', body: JSON.stringify({ url: SUB_URL }) }));
    const b = await body(await callAuth(env, '/api/status'));
    expect(b.subs.find((x: any) => x.id === id).name).toBe('未命名订阅');
  });

  it('PUT 改 clean/format/include 生效', async () => {
    const env = makeEnv();
    env.kv.seed('sub:s1', subOf('s1'));
    await callAuth(env, '/api/subs/s1', {
      method: 'PUT',
      body: JSON.stringify({ clean: false, format: 'clash', include: 'HK', exclude: '公告', ua: 'my-ua' }),
    });
    const b = await body(await callAuth(env, '/api/status'));
    expect(b.subs[0]).toMatchObject({ clean: false, format: 'clash', include: 'HK', exclude: '公告', ua: 'my-ua' });
  });
});

describe('/api/links 其他分支', () => {
  it('GET 多条链接 → 每项字段齐全，凭据字段不存在', async () => {
    const env = makeEnv();
    env.kv.seed('link:a', linkOf('a', { label: 'A', createdAt: 1, ruleSource: 'official' }));
    env.kv.seed('link:b', linkOf('b', { label: 'B', createdAt: 2, ruleSource: 'official' }));
    const b = await body(await callAuth(env, '/api/links'));
    expect(b.links.map((l: any) => l.label)).toEqual(['A', 'B']);
    expect(Object.keys(b.links[0]).sort()).toEqual(
      ['createdAt', 'enabled', 'includeCustom', 'label', 'ruleSource', 'rules', 'sources', 'target', 'token'].sort()
    );
  });

  it('POST target=singbox 且带 templateId → 保存绑定', async () => {
    const env = makeEnv();
    env.kv.seed('template:p1', tplOf('p1', TEMPLATE_JSON));
    const { link } = await body(
      await callAuth(env, '/api/links', { method: 'POST', body: JSON.stringify({ target: 'singbox', templateId: 'p1' }) })
    );
    expect(link.templateId).toBe('p1');
  });

  it('POST target 非 singbox 时丢弃 templateId', async () => {
    const env = makeEnv();
    const { link } = await body(
      await callAuth(env, '/api/links', { method: 'POST', body: JSON.stringify({ target: 'clash', templateId: 'p1' }) })
    );
    expect(link.templateId).toBeUndefined();
  });

  it('PUT 非法 target → 保持原 target 不变', async () => {
    const env = makeEnv();
    env.kv.seed('link:t1', linkOf('t1', { target: 'clash' }));
    const { link } = await body(await callAuth(env, '/api/links/t1', { method: 'PUT', body: JSON.stringify({ target: 'surge' }) }));
    expect(link.target).toBe('clash');
  });
});

describe('各端点边界分支', () => {
  it('POST /api/setup/verify 连续失败 5 次后 → 429 锁定', async () => {
    const env = makeEnv();
    env.kv.seed('profile', {
      passHash: await hashPassword('password-2024'),
      totpEnc: await wrapField(env, generateTotpSecret()),
      totpVerified: false,
    } satisfies Profile);
    for (let i = 0; i < 5; i++) {
      await call(env, '/api/setup/verify', { method: 'POST', body: JSON.stringify({ code: '000000' }) });
    }
    const res = await call(env, '/api/setup/verify', { method: 'POST', body: JSON.stringify({ code: '000000' }) });
    expect(res.status).toBe(429);
    expect((await body(res)).error).toMatch(/^尝试次数过多/);
  });

  it('POST /api/setup 口令非字符串 → 403（按口令错误处理）', async () => {
    const res = await call(makeEnv(), '/api/setup', { method: 'POST', body: JSON.stringify({ setupCode: 123456789, password: 'password-2024' }) });
    expect(res.status).toBe(403);
    expect(await body(res)).toEqual({ error: '初始化口令错误' });
  });

  it('GET /api/subs 无列表接口 → 404 接口不存在（列表走 /api/status）', async () => {
    const env = makeEnv();
    env.kv.seed('sub:s1', subOf('s1'));
    const res = await callAuth(env, '/api/subs');
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ error: '接口不存在' });
  });

  it('GET /api/pool 内容重复节点 → deduped 计数 + 去重后列表', async () => {
    const env = makeEnv();
    const same = nodeOf('X', { server: 'same.example.com', port: 443, password: 'pw' });
    env.kv.seed('sub:s1', subOf('s1', { name: 'A', clean: false }));
    env.kv.seed('snap:s1', snapOf([same]));
    env.kv.seed('sub:s2', subOf('s2', { name: 'B', clean: false, createdAt: 2 }));
    env.kv.seed('snap:s2', snapOf([{ ...same, name: 'Y' }]));
    const b = await body(await callAuth(env, '/api/pool'));
    expect(b.nodes.map((n: any) => n.name)).toEqual(['[A] X']);
    expect(b.deduped).toBe(1);
  });

  it('GET /s/{token} 响应统一带 nosniff（含 404）', async () => {
    const env = makeEnv();
    env.kv.seed('link:tok', linkOf('tok', { target: 'uri' }));
    expect((await call(env, '/s/tok')).headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect((await call(env, '/s/nope')).headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('PUT /api/templates/{id} 缺省 name 与 url → 保持原值', async () => {
    const env = makeEnv();
    env.kv.seed('template:p1', tplOf('p1', TEMPLATE_JSON, { name: '原名' }));
    const res = await callAuth(env, '/api/templates/p1', { method: 'PUT', body: JSON.stringify({}) });
    expect(res.status).toBe(200);
    expect((await body(res)).templates[0].name).toBe('原名');
  });
});
