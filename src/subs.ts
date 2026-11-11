// 订阅 / 自建节点 / 输出链接的 KV 管理与抓取调度。
// 订阅 URL、TOTP 密钥等敏感数据 AES-GCM 加密落盘；日志与错误信息不包含 URL 与 token。
// 节点凭据（uuid/password）随快照与自建节点明文落盘：与订阅 URL 内的机场账号 token 不同级，
// 且输出渲染频繁、逐字段加解密会超免费版 CPU 预算，属有意取舍。
import type { Env } from './auth';
import { errMsg, hex, newId, unwrapField, wrapField } from './auth';
import { parseNodeUri, parseSubscription, type ProxyNode } from './parse';
import { cleanNodeName } from './rename';

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
  include?: string; // 节点原名包含正则
  exclude?: string; // 节点原名排除正则
  clean?: boolean; // 节点名清洗，缺省按开启处理
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
  templateId?: string; // 绑定的输出模板；缺省使用内置最小配置
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
export async function listByPrefix<T>(env: Env, prefix: string): Promise<T[]> {
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
  input: {
    name: string;
    url: string;
    ua?: string;
    format?: FetchFormat;
    include?: string;
    exclude?: string;
    clean?: boolean;
    enabled?: boolean;
  }
): Promise<SubRec> {
  const rec: SubRec = {
    id: newId(),
    name: input.name.trim() || '未命名订阅',
    urlEnc: await wrapField(env, input.url.trim()),
    ua: input.ua?.trim() || undefined,
    format: input.format === 'clash' ? 'clash' : undefined,
    include: input.include?.trim() || undefined,
    exclude: input.exclude?.trim() || undefined,
    clean: input.clean ?? true,
    enabled: input.enabled ?? true,
    createdAt: Date.now(),
  };
  await putJson(env, `sub:${rec.id}`, rec);
  return rec;
}

export async function updateSub(
  env: Env,
  id: string,
  patch: {
    name?: string;
    url?: string;
    ua?: string;
    format?: FetchFormat;
    include?: string;
    exclude?: string;
    clean?: boolean;
    enabled?: boolean;
  }
): Promise<SubRec | null> {
  const rec = await getSub(env, id);
  if (!rec) return null;
  if (patch.name !== undefined) rec.name = patch.name.trim() || rec.name;
  if (patch.url) rec.urlEnc = await wrapField(env, patch.url.trim());
  if (patch.ua !== undefined) rec.ua = patch.ua.trim() || undefined;
  if (patch.format !== undefined) rec.format = patch.format === 'clash' ? 'clash' : undefined;
  if (patch.include !== undefined) rec.include = patch.include.trim() || undefined;
  if (patch.exclude !== undefined) rec.exclude = patch.exclude.trim() || undefined;
  if (patch.clean !== undefined) rec.clean = patch.clean;
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

// 抓取响应体上限：Cloudflare 对响应无平台限制，isolate 内存 128MB；
// 超限按失败处理并保留上次成功快照。常规订阅远小于 2 MiB（Clash 解析器内部另有 256KB 截断）。
export const MAX_FETCH_BYTES = 2 * 1024 * 1024;

/** 读取响应文本，超过 limit 抛错（错误信息不含 URL）；无 Content-Length 的分块响应逐块累计防超限 */
export async function readTextLimited(res: Response, limit: number): Promise<string> {
  if (Number(res.headers.get('Content-Length') ?? '0') > limit) throw new Error(`响应体超过 ${Math.ceil(limit / 1048576)} MiB 上限`);
  const reader = res.body?.getReader();
  if (!reader) return '';
  let size = 0;
  let text = '';
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`响应体超过 ${Math.ceil(limit / 1048576)} MiB 上限`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
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
    const text = await readTextLimited(res, MAX_FETCH_BYTES);
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
    const snap: SnapshotRec = { ...prev, error: errMsg(e), errorAt: Date.now() };
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
      skipped.push(`${uri.slice(0, 20)}…：${errMsg(e)}`);
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
  templateId?: string | null;
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
  const templateId =
    target === 'singbox'
      ? input.templateId !== undefined
        ? typeof input.templateId === 'string'
          ? input.templateId.trim() || undefined
          : undefined
        : prev?.templateId
      : undefined;
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
    templateId,
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

/** 模板删除时解除链接绑定；token 不存在则忽略 */
export async function setLinkTemplate(env: Env, token: string, templateId?: string): Promise<void> {
  const rec = await getLink(env, token);
  if (!rec) return;
  if (templateId) rec.templateId = templateId;
  else delete rec.templateId;
  await putJson(env, `link:${token}`, rec);
}

// ---------- 节点汇总 ----------

/** 编译正则；空或非法返回 null。入口校验（null 即非法）与节点筛选（null 即不过滤）共用 */
export function compileRegex(v?: string): RegExp | null {
  if (!v?.trim()) return null;
  try {
    return new RegExp(v.trim());
  } catch {
    return null;
  }
}

export interface CollectedNode extends ProxyNode {
  original: string; // 清洗前的原始节点名
  source: string; // 订阅名或「自建」
}

/** 每订阅处理：原始名正则筛选 → 名称清洗 → 来源前缀 */
function prepareSubNodes(sub: SubRec, nodes: ProxyNode[]): CollectedNode[] {
  const inc = compileRegex(sub.include);
  const exc = compileRegex(sub.exclude);
  const clean = sub.clean !== false;
  const out: CollectedNode[] = [];
  for (const n of nodes) {
    const original = n.name;
    if (inc && !inc.test(original)) continue;
    if (exc && exc.test(original)) continue;
    out.push({
      ...n,
      name: `[${sub.name}] ${clean ? cleanNodeName(original) : original}`,
      original,
      source: sub.name,
    });
  }
  return out;
}

function prepareCustomNodes(records: NodeRec[]): CollectedNode[] {
  return records.map((r) => ({ ...r.node, name: `[自建] ${r.node.name}`, original: r.node.name, source: '自建' }));
}

// 连接字段相同即视为同一节点；名称与来源不参与比较
const nodeKey = (n: ProxyNode) =>
  JSON.stringify(
    Object.entries(n)
      .filter(([k, v]) => v !== undefined && k !== 'name' && k !== 'original' && k !== 'source')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );

function dedupeNodes(nodes: CollectedNode[]): { nodes: CollectedNode[]; removed: number } {
  const seen = new Set<string>();
  const out: CollectedNode[] = [];
  for (const n of nodes) {
    const k = nodeKey(n);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return { nodes: out, removed: nodes.length - out.length };
}

function uniqueNames(nodes: CollectedNode[]): void {
  const used = new Set<string>();
  for (const n of nodes) {
    if (!used.has(n.name)) {
      used.add(n.name);
      continue;
    }
    let i = 2;
    while (used.has(`${n.name} #${i}`)) i++;
    n.name = `${n.name} #${i}`;
    used.add(n.name);
  }
}

function sourceMatches(re: RegExp, n: CollectedNode): boolean {
  return re.test(n.name) || re.test(`[${n.source}] ${n.original}`);
}

/** 汇总链接勾选的订阅快照与自建节点，按来源加前缀、应用筛选与清洗并去重 */
export async function collectNodes(
  env: Env,
  link: LinkRec
): Promise<{ nodes: CollectedNode[]; skipped: string[]; deduped: number }> {
  const nodes: CollectedNode[] = [];
  const skipped: string[] = [];
  for (const subId of link.sources) {
    const sub = await getSub(env, subId);
    if (!sub) {
      skipped.push('来源包含已删除的订阅');
      continue;
    }
    const snap = await getSnapshot(env, subId);
    if (!snap || !snap.nodes.length) {
      skipped.push(`[${sub.name}] 暂无可用快照`);
      continue;
    }
    nodes.push(...prepareSubNodes(sub, snap.nodes));
  }
  if (link.includeCustom) nodes.push(...prepareCustomNodes(await listNodes(env)));
  // 正则同时匹配清洗后名称与原始名（含来源前缀），避免清洗后旧链接筛选失效
  const inc = compileRegex(link.include);
  const exc = compileRegex(link.exclude);
  const filtered = inc || exc ? nodes.filter((n) => (!inc || sourceMatches(inc, n)) && (!exc || !sourceMatches(exc, n))) : nodes;
  const deduped = dedupeNodes(filtered);
  uniqueNames(deduped.nodes);
  return { nodes: deduped.nodes, skipped, deduped: deduped.removed };
}

/** 面板节点池：所有启用订阅（应用各自筛选/清洗）+ 自建节点 */
export async function collectPool(env: Env): Promise<{ nodes: CollectedNode[]; skipped: string[]; deduped: number }> {
  const nodes: CollectedNode[] = [];
  const skipped: string[] = [];
  for (const sub of await listSubs(env)) {
    if (!sub.enabled) continue;
    const snap = await getSnapshot(env, sub.id);
    if (!snap || !snap.nodes.length) {
      skipped.push(`[${sub.name}] 暂无可用快照`);
      continue;
    }
    nodes.push(...prepareSubNodes(sub, snap.nodes));
  }
  nodes.push(...prepareCustomNodes(await listNodes(env)));
  const deduped = dedupeNodes(nodes);
  uniqueNames(deduped.nodes);
  return { nodes: deduped.nodes, skipped, deduped: deduped.removed };
}
