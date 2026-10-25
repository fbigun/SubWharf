// 订阅 / 自建节点 / 输出链接的 KV 管理与抓取调度。
// 订阅 URL、TOTP 密钥等敏感数据 AES-GCM 加密落盘；日志与错误信息不包含 URL 与 token。
import type { Env } from './auth';
import { hex, unwrapField, wrapField } from './auth';
import { parseNodeUri, parseSubscription, type ProxyNode } from './parse';

export interface UserInfo {
  upload: number;
  download: number;
  total: number;
  expire: number; // Unix 秒
}

export type FetchFormat = 'base64' | 'clash';

export interface SubRec {
  id: string;
  name: string;
  urlEnc: string; // AES-GCM 加密的订阅 URL
  ua?: string;
  format?: FetchFormat; // 缺省按 base64/URI 轻解析
  enabled: boolean;
  createdAt: number;
}

export interface NodeRec {
  id: string;
  node: ProxyNode;
  createdAt: number;
}

export interface LinkRec {
  token: string;
  label: string;
  target: 'clash' | 'singbox' | 'base64' | 'uri';
  rules: 'none' | 'cn';
  ruleSource?: 'official' | 'jsdelivr';
  sources: string[]; // 勾选的订阅 id
  includeCustom: boolean;
  enabled: boolean;
  createdAt: number;
  include?: string; // 节点名包含正则（匹配含 [来源] 前缀的完整名），留空不过滤
  exclude?: string; // 节点名排除正则
}

export interface SnapshotRec {
  nodes: ProxyNode[];
  skipped?: string[];
  userinfo?: UserInfo;
  fetchedAt?: number;
  error?: string;
  errorAt?: number;
}

export const DEFAULT_UA = 'v2rayN/6.60';
const CLASH_UA = 'clash.meta/v1.19.10';

// ---------- KV 基础 ----------

// 单管理员量级，KV list 一页（1000 键）足够
async function listByPrefix<T>(env: Env, prefix: string): Promise<T[]> {
  const res = await env.KV.list({ prefix });
  const out: T[] = [];
  for (const k of res.keys) {
    const v = await env.KV.get<T>(k.name, 'json');
    if (v !== null) out.push(v as T);
  }
  return out;
}

async function getJson<T>(env: Env, key: string): Promise<T | null> {
  return env.KV.get<T>(key, 'json');
}

async function putJson(env: Env, key: string, value: unknown, ttl?: number): Promise<void> {
  await env.KV.put(key, JSON.stringify(value), ttl ? { expirationTtl: ttl } : undefined);
}

const newId = () => hex(crypto.getRandomValues(new Uint8Array(8)));
export const newToken = () => hex(crypto.getRandomValues(new Uint8Array(16))); // 128-bit

// ---------- 订阅 ----------

export async function listSubs(env: Env): Promise<SubRec[]> {
  const subs = await listByPrefix<SubRec>(env, 'sub:');
  return subs.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getSub(env: Env, id: string): Promise<SubRec | null> {
  return getJson<SubRec>(env, `sub:${id}`);
}

export async function createSub(
  env: Env,
  input: { name: string; url: string; ua?: string; format?: FetchFormat; enabled?: boolean }
): Promise<SubRec> {
  const rec: SubRec = {
    id: newId(),
    name: input.name.trim() || '未命名订阅',
    urlEnc: await wrapField(env, input.url.trim()),
    ua: input.ua?.trim() || undefined,
    format: input.format === 'clash' ? 'clash' : undefined,
    enabled: input.enabled ?? true,
    createdAt: Date.now(),
  };
  await putJson(env, `sub:${rec.id}`, rec);
  return rec;
}

export async function updateSub(
  env: Env,
  id: string,
  patch: { name?: string; url?: string; ua?: string; format?: FetchFormat; enabled?: boolean }
): Promise<SubRec | null> {
  const rec = await getSub(env, id);
  if (!rec) return null;
  if (patch.name !== undefined) rec.name = patch.name.trim() || rec.name;
  if (patch.url) rec.urlEnc = await wrapField(env, patch.url.trim());
  if (patch.ua !== undefined) rec.ua = patch.ua.trim() || undefined;
  if (patch.format !== undefined) rec.format = patch.format === 'clash' ? 'clash' : undefined;
  if (patch.enabled !== undefined) rec.enabled = patch.enabled;
  await putJson(env, `sub:${id}`, rec);
  return rec;
}

export async function deleteSub(env: Env, id: string): Promise<void> {
  await env.KV.delete(`sub:${id}`);
  await env.KV.delete(`snap:${id}`);
}

// ---------- 快照与抓取 ----------

export async function getSnapshot(env: Env, subId: string): Promise<SnapshotRec | null> {
  return getJson<SnapshotRec>(env, `snap:${subId}`);
}

function parseUserinfoHeader(h: string | null): UserInfo | undefined {
  if (!h) return undefined;
  const num = (k: string) => {
    const m = new RegExp(`\\b${k}\\s*=\\s*(\\d+)`, 'i').exec(h);
    return m ? Number(m[1]) : undefined;
  };
  const total = num('total');
  if (total === undefined) return undefined;
  return { upload: num('upload') ?? 0, download: num('download') ?? 0, total, expire: num('expire') ?? 0 };
}

/** 抓取单个订阅并写快照；失败保留上次成功快照，只记录错误，等下次 cron 重试 */
export async function refreshSub(env: Env, sub: SubRec): Promise<SnapshotRec> {
  try {
    const url = await unwrapField(env, sub.urlEnc);
    const ua = sub.format === 'clash' ? CLASH_UA : sub.ua || DEFAULT_UA;
    const res = await fetch(url, { headers: { 'User-Agent': ua }, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const userinfo = parseUserinfoHeader(res.headers.get('subscription-userinfo'));
    const text = await res.text();
    const parsed = parseSubscription(text);
    const snap: SnapshotRec = {
      nodes: parsed.nodes,
      skipped: parsed.skipped.length ? parsed.skipped : undefined,
      userinfo,
      fetchedAt: Date.now(),
    };
    await putJson(env, `snap:${sub.id}`, snap);
    return snap;
  } catch (e) {
    const prev = (await getSnapshot(env, sub.id)) ?? { nodes: [] };
    const snap: SnapshotRec = { ...prev, error: e instanceof Error ? e.message : String(e), errorAt: Date.now() };
    await putJson(env, `snap:${sub.id}`, snap);
    return snap;
  }
}

export async function refreshAll(env: Env): Promise<void> {
  for (const sub of await listSubs(env)) {
    if (sub.enabled) await refreshSub(env, sub);
  }
}

// ---------- 自建节点 ----------

export async function listNodes(env: Env): Promise<NodeRec[]> {
  const nodes = await listByPrefix<NodeRec>(env, 'node:');
  return nodes.sort((a, b) => a.createdAt - b.createdAt);
}

export async function addNodes(env: Env, urisText: string): Promise<{ added: number; skipped: string[] }> {
  const existing = new Set((await listNodes(env)).map((r) => JSON.stringify(r.node)));
  const skipped: string[] = [];
  let added = 0;
  for (const line of urisText.split(/\r?\n/)) {
    const uri = line.trim();
    if (!uri) continue;
    try {
      const node = parseNodeUri(uri);
      const key = JSON.stringify(node);
      if (existing.has(key)) {
        skipped.push(`${node.name}：已存在`);
        continue;
      }
      existing.add(key);
      const rec: NodeRec = { id: newId(), node, createdAt: Date.now() };
      await putJson(env, `node:${rec.id}`, rec);
      added += 1;
    } catch (e) {
      skipped.push(`${uri.slice(0, 20)}…：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { added, skipped };
}

export async function deleteNode(env: Env, id: string): Promise<void> {
  await env.KV.delete(`node:${id}`);
}

// ---------- 输出链接 ----------

const TARGETS = ['clash', 'singbox', 'base64', 'uri'] as const;

export interface LinkInput {
  label?: string;
  target?: string;
  rules?: string;
  ruleSource?: string;
  sources?: string[];
  includeCustom?: boolean;
  enabled?: boolean;
  include?: string;
  exclude?: string;
}

export async function listLinks(env: Env): Promise<LinkRec[]> {
  const links = await listByPrefix<LinkRec>(env, 'link:');
  return links.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getLink(env: Env, token: string): Promise<LinkRec | null> {
  return getJson<LinkRec>(env, `link:${token}`);
}

function normalizeLink(input: LinkInput, prev?: LinkRec): LinkRec {
  const target = (TARGETS as readonly string[]).includes(input.target ?? '') ? (input.target as LinkRec['target']) : prev?.target ?? 'clash';
  const rules = input.rules === 'cn' || input.rules === 'none' ? input.rules : prev?.rules ?? 'none';
  const ruleSource =
    input.ruleSource === 'jsdelivr' || input.ruleSource === 'official' ? input.ruleSource : prev?.ruleSource ?? 'official';
  const sources = Array.isArray(input.sources) ? input.sources.filter((s) => typeof s === 'string') : prev?.sources ?? [];
  const include = input.include !== undefined ? input.include.trim() || undefined : prev?.include;
  const exclude = input.exclude !== undefined ? input.exclude.trim() || undefined : prev?.exclude;
  return {
    token: prev?.token ?? '',
    label: (input.label ?? prev?.label ?? '').trim() || '默认链接',
    target,
    rules,
    ruleSource,
    sources,
    includeCustom: input.includeCustom ?? prev?.includeCustom ?? true,
    enabled: input.enabled ?? prev?.enabled ?? true,
    createdAt: prev?.createdAt ?? 0,
    include,
    exclude,
  };
}

export async function createLink(env: Env, input: LinkInput): Promise<LinkRec> {
  const rec = normalizeLink(input);
  rec.token = newToken();
  rec.createdAt = Date.now();
  await putJson(env, `link:${rec.token}`, rec);
  return rec;
}

export async function updateLink(env: Env, token: string, input: LinkInput): Promise<LinkRec | null> {
  const old = await getLink(env, token);
  if (!old) return null;
  const rec = normalizeLink(input, old);
  rec.token = token;
  await putJson(env, `link:${token}`, rec);
  return rec;
}

/** 一键重置 token：旧链接立即失效 */
export async function resetLinkToken(env: Env, token: string): Promise<LinkRec | null> {
  const old = await getLink(env, token);
  if (!old) return null;
  const rec: LinkRec = { ...old, token: newToken(), createdAt: Date.now() };
  await env.KV.delete(`link:${token}`);
  await putJson(env, `link:${rec.token}`, rec);
  return rec;
}

export async function deleteLink(env: Env, token: string): Promise<void> {
  await env.KV.delete(`link:${token}`);
}

/** 汇总链接勾选的订阅快照与自建节点，按来源加前缀、应用正则筛选并对重名追加序号 */
export async function collectNodes(env: Env, link: LinkRec): Promise<{ nodes: ProxyNode[]; skipped: string[] }> {
  const nodes: ProxyNode[] = [];
  const skipped: string[] = [];
  for (const subId of link.sources) {
    const sub = await getSub(env, subId);
    const snap = await getSnapshot(env, subId);
    if (!sub) {
      skipped.push('来源包含已删除的订阅');
      continue;
    }
    if (!snap || !snap.nodes.length) {
      skipped.push(`[${sub.name}] 暂无可用快照`);
      continue;
    }
    for (const n of snap.nodes) nodes.push({ ...n, name: `[${sub.name}] ${n.name}` });
  }
  if (link.includeCustom) {
    for (const rec of await listNodes(env)) nodes.push({ ...rec.node, name: `[自建] ${rec.node.name}` });
  }
  // 正则筛选：匹配含 [来源] 前缀的完整节点名；正则非法时视为不过滤（保存时已校验）
  let inc: RegExp | null = null;
  let exc: RegExp | null = null;
  try {
    inc = link.include ? new RegExp(link.include) : null;
  } catch {
    inc = null;
  }
  try {
    exc = link.exclude ? new RegExp(link.exclude) : null;
  } catch {
    exc = null;
  }
  const filtered = inc || exc ? nodes.filter((n) => (!inc || inc.test(n.name)) && (!exc || !exc.test(n.name))) : nodes;
  const seen = new Map<string, number>();
  for (const n of filtered) {
    const c = seen.get(n.name) ?? 0;
    seen.set(n.name, c + 1);
    if (c > 0) n.name = `${n.name} #${c + 1}`;
  }
  return { nodes: filtered, skipped };
}
