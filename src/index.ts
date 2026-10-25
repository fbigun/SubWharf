// 路由入口：/ 静态面板（Workers Static Assets 托管）、/api/* 管理 API、/s/{token} 公开订阅输出。
// 日志与错误响应不包含订阅 URL 与 token。
import type { Env, Profile } from './auth';
import {
  clearLoginFail,
  clearSessionCookie,
  createSession,
  generateTotpSecret,
  getSessionId,
  hashPassword,
  loginLockRemaining,
  otpauthUri,
  recordLoginFail,
  sessionCookie,
  unwrapField,
  verifyPassword,
  verifyTotp,
  wrapField,
} from './auth';
import * as subs from './subs';
import { renderBase64, renderClash, renderSingbox, renderUri, type OutputTarget, type RuleSource, type RulesMode } from './render';

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
const err = (message: string, status = 400) => json({ error: message }, status);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await handle(req, env);
    } catch (e) {
      return err(e instanceof Error ? e.message : '服务器内部错误', 500);
    }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(subs.refreshAll(env));
  },
};

async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return api(req, env, url);
  if (url.pathname.startsWith('/s/')) return serveSubscription(env, url);
  return env.ASSETS.fetch(req);
}

// ---------- 公开订阅输出 ----------

async function serveSubscription(env: Env, url: URL): Promise<Response> {
  const token = decodeURIComponent(url.pathname.slice(3));
  const link = token ? await subs.getLink(env, token) : null;
  if (!link || !link.enabled) return new Response('not found', { status: 404 });

  const qTarget = url.searchParams.get('target');
  const qRules = url.searchParams.get('rules');
  const target: OutputTarget = (['clash', 'singbox', 'base64', 'uri'] as const).includes(qTarget as OutputTarget)
    ? (qTarget as OutputTarget)
    : link.target;
  const rules: RulesMode = qRules === 'cn' || qRules === 'none' ? qRules : link.rules;
  const ruleSource: RuleSource = link.ruleSource === 'jsdelivr' ? 'jsdelivr' : 'official';

  const { nodes } = await subs.collectNodes(env, link);
  const headers: Record<string, string> = { 'profile-update-interval': '12', 'Cache-Control': 'no-store' };
  let body: string;
  if (target === 'clash') {
    body = renderClash(nodes, rules);
    headers['Content-Type'] = 'text/yaml; charset=utf-8';
    headers['Content-Disposition'] = 'attachment; filename="config.yaml"';
  } else if (target === 'singbox') {
    body = renderSingbox(nodes, rules, ruleSource);
    headers['Content-Type'] = 'application/json; charset=utf-8';
    headers['Content-Disposition'] = 'attachment; filename="config.json"';
  } else if (target === 'uri') {
    body = renderUri(nodes);
    headers['Content-Type'] = 'text/plain; charset=utf-8';
  } else {
    body = renderBase64(nodes);
    headers['Content-Type'] = 'text/plain; charset=utf-8';
  }
  return new Response(body, { headers });
}

// ---------- 管理 API ----------

async function api(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname;
  const method = req.method;
  const seg = p.split('/').filter(Boolean); // ['api', 'subs', ':id', ...]

  // 无需登录
  if (p === '/api/me' && method === 'GET') {
    const initialized = !!(await env.KV.get('profile'));
    return json({ initialized, authed: !!(await getSessionId(env.SESSION_KEY, req)) });
  }
  if (p === '/api/setup' && method === 'POST') return setup(req, env);
  if (p === '/api/setup/verify' && method === 'POST') return setupVerify(req, env);
  if (p === '/api/login' && method === 'POST') return login(req, env);

  // 以下全部需要会话（无状态签名 Cookie，验签即登录）
  if (!(await getSessionId(env.SESSION_KEY, req))) return err('未登录', 401);

  if (p === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
  }

  if (p === '/api/status' && method === 'GET') return json(await statusPayload(env));

  if (p === '/api/refresh-all' && method === 'POST') {
    await subs.refreshAll(env);
    return json(await statusPayload(env));
  }

  if (seg[1] === 'subs') {
    if (method === 'GET' && seg.length === 4 && seg[3] === 'nodes') {
      const rec = await subs.getSub(env, seg[2]);
      if (!rec) return err('订阅不存在', 404);
      const snap = await subs.getSnapshot(env, seg[2]);
      return json({
        name: rec.name,
        nodes: (snap?.nodes ?? []).map((n) => ({ name: n.name, type: n.type, server: n.server, port: n.port })),
      });
    }
    if (method === 'POST' && seg.length === 2) {
      const b = await readJson(req);
      if (typeof b?.url !== 'string' || !b.url.trim()) return err('缺少订阅 URL');
      const rec = await subs.createSub(env, {
        name: String(b.name ?? ''),
        url: b.url,
        ua: b.ua ? String(b.ua) : undefined,
        format: b.format,
        enabled: b.enabled,
      });
      const snap = await subs.refreshSub(env, rec); // 新增后立即抓一次
      return json({ id: rec.id, snap: snapSummary(snap) });
    }
    if (method === 'PUT' && seg.length === 3) {
      const b = await readJson(req);
      const rec = await subs.updateSub(env, seg[2], {
        name: b?.name,
        url: b?.url,
        ua: b?.ua,
        format: b?.format,
        enabled: b?.enabled,
      });
      if (!rec) return err('订阅不存在', 404);
      return json({ ok: true });
    }
    if (method === 'DELETE' && seg.length === 3) {
      await subs.deleteSub(env, seg[2]);
      return json({ ok: true });
    }
    if (method === 'POST' && seg.length === 4 && seg[3] === 'refresh') {
      const rec = await subs.getSub(env, seg[2]);
      if (!rec) return err('订阅不存在', 404);
      return json({ snap: snapSummary(await subs.refreshSub(env, rec)) });
    }
  }

  if (seg[1] === 'nodes') {
    if (method === 'GET' && seg.length === 2) return json({ nodes: await subs.listNodes(env) });
    if (method === 'POST' && seg.length === 2) {
      const b = await readJson(req);
      if (typeof b?.uris !== 'string' || !b.uris.trim()) return err('缺少节点 URI');
      return json(await subs.addNodes(env, b.uris));
    }
    if (method === 'DELETE' && seg.length === 3) {
      await subs.deleteNode(env, seg[2]);
      return json({ ok: true });
    }
  }

  if (seg[1] === 'links') {
    if (method === 'GET' && seg.length === 2) return json({ links: await subs.listLinks(env) });
    if (method === 'POST' && seg.length === 2) {
      const b = await readJson(req);
      if (invalidRegex(b?.include) || invalidRegex(b?.exclude)) return err('节点筛选正则表达式无效');
      return json({ link: await subs.createLink(env, b ?? {}) });
    }
    if (method === 'PUT' && seg.length === 3) {
      const b = await readJson(req);
      if (invalidRegex(b?.include) || invalidRegex(b?.exclude)) return err('节点筛选正则表达式无效');
      const rec = await subs.updateLink(env, seg[2], b ?? {});
      if (!rec) return err('链接不存在', 404);
      return json({ link: rec });
    }
    if (method === 'POST' && seg.length === 4 && seg[3] === 'reset') {
      const rec = await subs.resetLinkToken(env, seg[2]);
      if (!rec) return err('链接不存在', 404);
      return json({ link: rec });
    }
    if (method === 'DELETE' && seg.length === 3) {
      await subs.deleteLink(env, seg[2]);
      return json({ ok: true });
    }
  }

  return err('接口不存在', 404);
}

function invalidRegex(v: unknown): boolean {
  if (typeof v !== 'string' || !v.trim()) return false;
  try {
    new RegExp(v.trim());
    return false;
  } catch {
    return true;
  }
}

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function snapSummary(snap: subs.SnapshotRec) {
  return {
    fetchedAt: snap.fetchedAt,
    error: snap.error,
    errorAt: snap.errorAt,
    nodeCount: snap.nodes.length,
    skipped: snap.skipped,
    userinfo: snap.userinfo,
  };
}

async function statusPayload(env: Env) {
  const out = [];
  for (const s of await subs.listSubs(env)) {
    const snap = await subs.getSnapshot(env, s.id);
    out.push({
      id: s.id,
      name: s.name,
      ua: s.ua,
      format: s.format ?? 'base64',
      enabled: s.enabled,
      createdAt: s.createdAt,
      snap: snap ? snapSummary(snap) : null,
    });
  }
  return { subs: out };
}

// ---------- 初始化与登录 ----------

async function setup(req: Request, env: Env): Promise<Response> {
  const remain = await loginLockRemaining(env);
  if (remain > 0) return err(`尝试次数过多，请 ${Math.ceil(remain / 60)} 分钟后再试`, 429);
  const b = await readJson(req);
  if (await env.KV.get('profile')) return err('已初始化，请直接登录', 409);
  if (!b?.setupCode || !b?.password) return err('缺少初始化口令或密码');
  if (b.setupCode !== env.SETUP_CODE) {
    await recordLoginFail(env);
    return err('初始化口令错误', 403);
  }
  if (String(b.password).length < 8) return err('密码至少 8 位');
  const secret = generateTotpSecret();
  const profile: Profile = {
    passHash: await hashPassword(String(b.password)),
    totpEnc: await wrapField(env, secret),
    totpVerified: false,
  };
  await env.KV.put('profile', JSON.stringify(profile));
  return json({ secret, otpauth: otpauthUri(secret) });
}

async function setupVerify(req: Request, env: Env): Promise<Response> {
  const remain = await loginLockRemaining(env);
  if (remain > 0) return err(`尝试次数过多，请 ${Math.ceil(remain / 60)} 分钟后再试`, 429);
  const b = await readJson(req);
  const profile = await env.KV.get<Profile>('profile', 'json');
  if (!profile) return err('请先完成初始化', 400);
  if (profile.totpVerified) return err('TOTP 已绑定，请直接登录', 409);
  const secret = await unwrapField(env, profile.totpEnc);
  if (!(await verifyTotp(secret, String(b?.code ?? '')))) {
    await recordLoginFail(env);
    return err('验证码错误', 403);
  }
  await clearLoginFail(env);
  profile.totpVerified = true;
  await env.KV.put('profile', JSON.stringify(profile));
  const value = await createSession(env.SESSION_KEY);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(value) });
}

async function login(req: Request, env: Env): Promise<Response> {
  const remain = await loginLockRemaining(env);
  if (remain > 0) return err(`失败次数过多，请 ${Math.ceil(remain / 60)} 分钟后再试`, 429);
  const b = await readJson(req);
  const profile = await env.KV.get<Profile>('profile', 'json');
  if (!profile || !profile.totpVerified) return err('未完成初始化', 400);
  const secret = await unwrapField(env, profile.totpEnc);
  const ok =
    (await verifyPassword(String(b?.password ?? ''), profile.passHash)) && (await verifyTotp(secret, String(b?.code ?? '')));
  if (!ok) {
    await recordLoginFail(env);
    return err('密码或验证码错误', 403);
  }
  await clearLoginFail(env);
  const value = await createSession(env.SESSION_KEY);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(value) });
}
