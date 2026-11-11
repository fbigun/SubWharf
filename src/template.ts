// 模板输出：管理多个 sing-box 模板，按链接绑定的模板注入节点并填充分组。
// 模板自带的 inbounds / dns / route / rule_set 原样保留；渲染结果按输出链接缓存到 KV。
import type { Env } from './auth';
import { errMsg, newId } from './auth';
import type { ProxyNode } from './parse';
import { singboxOutbound } from './render';
import { collectNodes, listByPrefix, listLinks, readTextLimited, setLinkTemplate, type LinkRec } from './subs';

export interface TemplateRec {
  id: string;
  name: string;
  url: string;
  text?: string; // 最近一次成功拉取的模板原文
  fetchedAt?: number;
  error?: string;
  errorAt?: number;
  createdAt: number;
}

export interface TemplateOutput {
  config: string;
  generatedAt: number;
  nodeCount: number;
  templateId: string;
  version: number;
}

export interface TemplateOutputStatus {
  token: string;
  label: string;
  generatedAt?: number;
  nodeCount?: number;
}

export interface TemplateStatus {
  id: string;
  name: string;
  url: string;
  fetchedAt?: number;
  error?: string;
  errorAt?: number;
  createdAt: number;
  outputs: TemplateOutputStatus[];
}

const PREFIX = 'template:';
const OUTPUT_PREFIX = 'tpl:';
const tkey = (id: string) => `${PREFIX}${id}`;
const outputKey = (token: string) => `${OUTPUT_PREFIX}${token}`;
const TEMPLATE_UA = 'SubWharf/1.0';
// 模板抓取响应上限：真实模板 JSON < 100KB，超限按失败处理并保留上次成功原文
const MAX_TEMPLATE_BYTES = 1024 * 1024;
// 输出序列化变更时递增：旧缓存按未命中处理，首次拉取自动重建
const RENDER_VERSION = 1;

// 地区分组识别与空分组兜底，语义与 Sub-Store 模板脚本一致
const REGION_TAGS = [/港|hk|hongkong|kong kong|🇭🇰/i, /日本|jp|japan|🇯🇵/i, /美|us|unitedstates|united states|🇺🇸/i];
const ALL_NODE_TAGS = /自动选择|手动切换/;
const FALLBACK_TAG = 'COMPATIBLE';

/** CNB 文件页地址（/-/blob/）转为原始内容地址（/-/git/raw/）；其他地址原样使用 */
export function normalizeTemplateUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.hostname === 'cnb.cool') {
    const m = /^\/([^/]+)\/([^/]+)\/-\/blob\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (m) return `${url.origin}/${m[1]}/${m[2]}/-/git/raw/${m[3]}/${m[4]}`;
  }
  return url.toString();
}

function parseTemplate(text: string): Record<string, unknown> {
  let cfg: any;
  try {
    cfg = JSON.parse(text);
  } catch {
    throw new Error('模板不是有效 JSON');
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || !Array.isArray(cfg.outbounds)) {
    throw new Error('模板缺少 outbounds 数组');
  }
  return cfg;
}

/** 模板骨架 + 节点：节点追加进 outbounds，按 tag 语义填充分组，空分组回退直连 */
export function buildTemplateConfig(text: string, nodes: ProxyNode[]): string {
  const cfg = parseTemplate(text);
  const outbounds = cfg.outbounds as any[];
  const tags = new Set<string>();
  for (const o of outbounds) if (typeof o?.tag === 'string') tags.add(o.tag);

  const nodeTags: string[] = [];
  for (const n of nodes) {
    let tag = n.name;
    for (let i = 2; tags.has(tag); i++) tag = `${n.name} #${i}`;
    tags.add(tag);
    nodeTags.push(tag);
    outbounds.push({ ...singboxOutbound(n), tag });
  }

  const groups = outbounds.filter((o) => o && typeof o === 'object' && Array.isArray(o.outbounds));
  for (const g of groups) {
    const tag = typeof g.tag === 'string' ? g.tag : '';
    const region = REGION_TAGS.findIndex((re) => re.test(tag));
    let add: string[] = [];
    if (region >= 0) add = nodeTags.filter((t) => REGION_TAGS[region].test(t));
    else if (ALL_NODE_TAGS.test(tag)) add = nodeTags;
    else if (g.outbounds.length === 0) add = nodeTags;
    if (add.length) g.outbounds = [...new Set([...g.outbounds, ...add])];
  }

  // 地区无匹配节点或模板留空的分组不能为空：统一回退到一个共享的直连出口
  let fallback = outbounds.find((o) => o?.tag === FALLBACK_TAG);
  for (const g of groups) {
    if (g.outbounds.length > 0) continue;
    if (!fallback) {
      fallback = { type: 'direct', tag: FALLBACK_TAG };
      outbounds.push(fallback);
    }
    g.outbounds.push(FALLBACK_TAG);
  }
  return JSON.stringify(cfg, null, 2);
}

// ---------- 模板管理 ----------

async function putTemplate(env: Env, rec: TemplateRec): Promise<void> {
  await env.KV.put(tkey(rec.id), JSON.stringify(rec));
}

export async function listTemplates(env: Env): Promise<TemplateRec[]> {
  const recs = await listByPrefix<TemplateRec>(env, PREFIX);
  return recs.filter((t) => typeof t.id === 'string').sort((a, b) => a.createdAt - b.createdAt);
}

export async function getTemplate(env: Env, id: string): Promise<TemplateRec | null> {
  return env.KV.get<TemplateRec>(tkey(id), 'json');
}

export async function createTemplate(env: Env, input: { name: string; url: string }): Promise<TemplateRec> {
  const rec: TemplateRec = {
    id: newId(),
    name: input.name.trim() || '未命名模板',
    url: normalizeTemplateUrl(input.url),
    createdAt: Date.now(),
  };
  await putTemplate(env, rec);
  return rec;
}

/** 更新名称/地址；地址变化时丢弃旧原文与渲染缓存，等待重新拉取 */
export async function updateTemplate(
  env: Env,
  id: string,
  patch: { name?: string; url?: string }
): Promise<TemplateRec | null> {
  const rec = await getTemplate(env, id);
  if (!rec) return null;
  let reset = false;
  if (patch.name !== undefined) rec.name = patch.name.trim() || rec.name;
  if (patch.url !== undefined) {
    const url = normalizeTemplateUrl(patch.url);
    if (url !== rec.url) {
      rec.url = url;
      reset = true;
    }
  }
  if (reset) {
    delete rec.text;
    delete rec.fetchedAt;
    delete rec.error;
    delete rec.errorAt;
  }
  await putTemplate(env, rec);
  if (reset) await deleteTemplateOutputs(env, id);
  return rec;
}

export async function deleteTemplate(env: Env, id: string): Promise<boolean> {
  if (!(await getTemplate(env, id))) return false;
  await env.KV.delete(tkey(id));
  for (const link of await listLinks(env)) {
    if (link.templateId !== id) continue;
    await env.KV.delete(outputKey(link.token));
    await setLinkTemplate(env, link.token, undefined);
  }
  return true;
}

/** 重新拉取模板原文；失败保留上次成功模板并记录错误 */
export async function refreshTemplate(env: Env, id: string): Promise<TemplateRec | null> {
  const rec = await getTemplate(env, id);
  if (!rec) return null;
  try {
    const res = await fetch(normalizeTemplateUrl(rec.url), { headers: { 'User-Agent': TEMPLATE_UA }, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await readTextLimited(res, MAX_TEMPLATE_BYTES);
    parseTemplate(text);
    const next: TemplateRec = { id: rec.id, name: rec.name, url: rec.url, text, fetchedAt: Date.now(), createdAt: rec.createdAt };
    await putTemplate(env, next);
    return next;
  } catch (e) {
    const next: TemplateRec = { ...rec, error: errMsg(e), errorAt: Date.now() };
    await putTemplate(env, next);
    return next;
  }
}

export async function refreshTemplates(env: Env): Promise<TemplateRec[]> {
  const out: TemplateRec[] = [];
  for (const t of await listTemplates(env)) {
    const rec = await refreshTemplate(env, t.id);
    if (rec) out.push(rec);
  }
  return out;
}

// ---------- 按链接渲染与缓存 ----------

async function renderWith(env: Env, link: LinkRec, template: TemplateRec): Promise<TemplateOutput | null> {
  if (!template.text) return null;
  const { nodes } = await collectNodes(env, link);
  const out: TemplateOutput = {
    config: buildTemplateConfig(template.text, nodes),
    generatedAt: Date.now(),
    nodeCount: nodes.length,
    templateId: template.id,
    version: RENDER_VERSION,
  };
  await env.KV.put(outputKey(link.token), JSON.stringify(out));
  return out;
}

export async function renderLink(env: Env, link: LinkRec): Promise<TemplateOutput | null> {
  if (link.target !== 'singbox' || !link.templateId) return null;
  const template = await getTemplate(env, link.templateId);
  return template ? renderWith(env, link, template) : null;
}

/** 用已缓存的模板原文重渲染全部启用链接；单个链接失败不影响其他链接 */
export async function renderAll(env: Env): Promise<number> {
  const templates = new Map((await listTemplates(env)).map((t) => [t.id, t]));
  let rendered = 0;
  for (const link of await listLinks(env)) {
    if (!link.enabled || link.target !== 'singbox' || !link.templateId) continue;
    const template = templates.get(link.templateId);
    if (!template?.text) continue;
    try {
      await renderWith(env, link, template);
      rendered += 1;
    } catch {
      // 保留该链接上次成功的缓存
    }
  }
  return rendered;
}

async function deleteTemplateOutputs(env: Env, templateId: string): Promise<void> {
  for (const link of await listLinks(env)) {
    if (link.templateId === templateId) await env.KV.delete(outputKey(link.token));
  }
}

export async function getOutput(env: Env, token: string): Promise<TemplateOutput | null> {
  return env.KV.get<TemplateOutput>(outputKey(token), 'json');
}

/** 拉取时优先读缓存；缓存缺失或模板已切换时按需生成 */
export async function ensureOutput(env: Env, link: LinkRec): Promise<TemplateOutput | null> {
  if (link.target !== 'singbox' || !link.templateId) return null;
  const cached = await getOutput(env, link.token);
  if (cached?.templateId === link.templateId && cached.version === RENDER_VERSION) return cached;
  return renderLink(env, link);
}

export async function deleteOutput(env: Env, token: string): Promise<void> {
  await env.KV.delete(outputKey(token));
}

export async function templateStatuses(env: Env): Promise<TemplateStatus[]> {
  const links = await listLinks(env);
  const out: TemplateStatus[] = [];
  for (const t of await listTemplates(env)) {
    const outputs: TemplateOutputStatus[] = [];
    for (const link of links) {
      if (link.templateId !== t.id || link.target !== 'singbox') continue;
      const cached = await getOutput(env, link.token);
      outputs.push({ token: link.token, label: link.label, generatedAt: cached?.generatedAt, nodeCount: cached?.nodeCount });
    }
    out.push({
      id: t.id,
      name: t.name,
      url: t.url,
      fetchedAt: t.fetchedAt,
      error: t.error,
      errorAt: t.errorAt,
      createdAt: t.createdAt,
      outputs,
    });
  }
  return out;
}
