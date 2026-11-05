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
import * as tpl from './template';
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
    ctx.waitUntil(refreshAllAndTemplate(env));
  },
};

async function refreshAllAndTemplate(env: Env): Promise<void> {
  await subs.refreshAll(env);
  await tpl.refreshTemplates(env);
  await tpl.renderAll(env);
}

/** 订阅/链接/节点变更后重渲染模板缓存；失败不阻断主操作，拉取时会按需重建 */
async function syncTemplate(env: Env): Promise<void> {
  try {
    await tpl.renderAll(env);
  } catch {
    // 模板缓存是加速副本，读取端有按需重建兜底
  }
}

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

  const headers: Record<string, string> = { 'profile-update-interval': '12', 'Cache-Control': 'no-store' };
  let body: string;
  if (target === 'singbox') {
    // 配置模板后直接返回 KV 中的生成结果；未配置时沿用内置最小配置
    const cached = await tpl.ensureOutput(env, link);
    body = cached ? cached.config : renderSingbox((await subs.collectNodes(env, link)).nodes, rules, ruleSource);
    headers['Content-Type'] = 'application/json; charset=utf-8';
    headers['Content-Disposition'] = 'attachment; filename="config.json"';
  } else {
    const { nodes } = await subs.collectNodes(env, link);
    if (target === 'clash') {
      body = renderClash(nodes, rules);
      headers['Content-Type'] = 'text/yaml; charset=utf-8';
      headers['Content-Disposition'] = 'attachment; filename="config.yaml"';
    } else if (target === 'uri') {
      body = renderUri(nodes);
      headers['Content-Type'] = 'text/plain; charset=utf-8';
    } else {
      body = renderBase64(nodes);
      headers['Content-Type'] = 'text/plain; charset=utf-8';
    }
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

  if (p === '/api/pool' && method === 'GET') {
    const pool = await subs.collectPool(env);
    return json({
      ...pool,
      // 面板只需要展示字段，不回传凭据
      nodes: pool.nodes.map(({ name, original, source, type, server, port }) => ({ name, original, source, type, server, port })),
    });
  }

  if (p === '/api/refresh-all' && method === 'POST') {
    await subs.refreshAll(env);
    await syncTemplate(env);
    return json(await statusPayload(env));
  }

  if (p === '/api/templates' && method === 'GET') return json({ templates: await tpl.templateStatuses(env) });

  if (p === '/api/templates' && method === 'POST') {
    const b = await readJson(req);
    if (typeof b?.name !== 'string' || !b.name.trim()) return err('缺少模板名称');
    if (typeof b?.url !== 'string' || !b.url.trim()) return err('缺少模板地址');
    let rec: tpl.TemplateRec;
    try {
      rec = await tpl.createTemplate(env, { name: b.name, url: b.url });
    } catch {
      return err('模板地址无效');
    }
    await tpl.refreshTemplate(env, rec.id);
    await tpl.renderAll(env);
    return json({ templates: await tpl.templateStatuses(env) });
  }

  if (p === '/api/templates/refresh' && method === 'POST') {
    await tpl.refreshTemplates(env);
    await tpl.renderAll(env);
    return json({ templates: await tpl.templateStatuses(env) });
  }

  if (seg[1] === 'templates' && seg.length === 3) {
    if (method === 'PUT') {
      const b = await readJson(req);
      let rec: tpl.TemplateRec | null;
      try {
        rec = await tpl.updateTemplate(env, seg[2], {
          name: typeof b?.name === 'string' ? b.name : undefined,
          url: typeof b?.url === 'string' && b.url.trim() ? b.url : undefined,
        });
      } catch {
        return err('模板地址无效');
      }
      if (!rec) return err('模板不存在', 404);
      if (typeof b?.url === 'string' && b.url.trim()) await tpl.refreshTemplate(env, rec.id);
      await tpl.renderAll(env);
      return json({ templates: await tpl.templateStatuses(env) });
    }
    if (method === 'DELETE') {
      if (!(await tpl.deleteTemplate(env, seg[2]))) return err('模板不存在', 404);
      return json({ templates: await tpl.templateStatuses(env) });
    }
  }

  if (seg[1] === 'templates' && seg.length === 4 && seg[3] === 'refresh' && method === 'POST') {
    if (!(await tpl.refreshTemplate(env, seg[2]))) return err('模板不存在', 404);
    await tpl.renderAll(env);
    return json({ templates: await tpl.templateStatuses(env) });
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
      if (invalidRegex(b?.include) || invalidRegex(b?.exclude)) return err('节点筛选正则表达式无效');
      const rec = await subs.createSub(env, {
        name: String(b.name ?? ''),
        url: b.url,
        ua: b.ua ? String(b.ua) : undefined,
        format: b.format,
        include: typeof b.include === 'string' ? b.include : undefined,
        exclude: typeof b.exclude === 'string' ? b.exclude : undefined,
        clean: typeof b.clean === 'boolean' ? b.clean : undefined,
        enabled: b.enabled,
      });
      const snap = await subs.refreshSub(env, rec); // 新增后立即抓一次
      await syncTemplate(env);
      return json({ id: rec.id, snap: snapSummary(snap) });
    }
    if (method === 'PUT' && seg.length === 3) {
      const b = await readJson(req);
      if (invalidRegex(b?.include) || invalidRegex(b?.exclude)) return err('节点筛选正则表达式无效');
      const rec = await subs.updateSub(env, seg[2], {
        name: b?.name,
        url: b?.url,
        ua: b?.ua,
        format: b?.format,
        include: typeof b?.include === 'string' ? b.include : undefined,
        exclude: typeof b?.exclude === 'string' ? b.exclude : undefined,
        clean: typeof b?.clean === 'boolean' ? b.clean : undefined,
        enabled: b?.enabled,
      });
      if (!rec) return err('订阅不存在', 404);
      await syncTemplate(env);
      return json({ ok: true });
    }
    if (method === 'DELETE' && seg.length === 3) {
      await subs.deleteSub(env, seg[2]);
      await syncTemplate(env);
      return json({ ok: true });
    }
    if (method === 'POST' && seg.length === 4 && seg[3] === 'refresh') {
      const rec = await subs.getSub(env, seg[2]);
      if (!rec) return err('订阅不存在', 404);
      const snap = await subs.refreshSub(env, rec);
      await syncTemplate(env);
      return json({ snap: snapSummary(snap) });
    }
  }

  if (seg[1] === 'nodes') {
    if (method === 'GET' && seg.length === 2) return json({ nodes: await subs.listNodes(env) });
    if (method === 'POST' && seg.length === 2) {
      const b = await readJson(req);
      if (typeof b?.uris !== 'string' || !b.uris.trim()) return err('缺少节点 URI');
      const r = await subs.addNodes(env, b.uris);
      await syncTemplate(env);
      return json(r);
    }
    if (method === 'DELETE' && seg.length === 3) {
      await subs.deleteNode(env, seg[2]);
      await syncTemplate(env);
      return json({ ok: true });
    }
  }

  if (seg[1] === 'links') {
    if (method === 'GET' && seg.length === 2) return json({ links: await subs.listLinks(env) });
    if (method === 'POST' && seg.length === 2) {
      const b = await readJson(req);
      if (invalidRegex(b?.include) || invalidRegex(b?.exclude)) return err('节点筛选正则表达式无效');
      const link = await subs.createLink(env, b ?? {});
      await syncTemplate(env);
      return json({ link });
    }
    if (method === 'PUT' && seg.length === 3) {
      const b = await readJson(req);
      if (invalidRegex(b?.include) || invalidRegex(b?.exclude)) return err('节点筛选正则表达式无效');
      const before = await subs.getLink(env, seg[2]);
      const rec = await subs.updateLink(env, seg[2], b ?? {});
      if (!rec) return err('链接不存在', 404);
      // 换绑/解绑模板后旧缓存立即失效，避免继续返回上一个模板的配置
      if (before?.templateId !== rec.templateId) await tpl.deleteOutput(env, rec.token);
      await syncTemplate(env);
      return json({ link: rec });
    }
    if (method === 'POST' && seg.length === 4 && seg[3] === 'reset') {
      const rec = await subs.resetLinkToken(env, seg[2]);
      if (!rec) return err('链接不存在', 404);
      await tpl.deleteOutput(env, seg[2]);
      await syncTemplate(env);
      return json({ link: rec });
    }
    if (method === 'DELETE' && seg.length === 3) {
      await subs.deleteLink(env, seg[2]);
      await tpl.deleteOutput(env, seg[2]);
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
      include: s.include,
      exclude: s.exclude,
      clean: s.clean !== false,
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
