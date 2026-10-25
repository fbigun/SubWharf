// 订阅解析：URI / base64 / sing-box JSON / Clash YAML → 统一内部节点模型。
// 覆盖 ss / vmess / vless / trojan / hysteria2 / tuic，未知协议跳过并在结果中说明原因。
import { b64decode, b64urlDecode } from './auth';

export type ProxyType = 'ss' | 'vmess' | 'vless' | 'trojan' | 'hysteria2' | 'tuic';

export interface ProxyNode {
  name: string;
  type: ProxyType;
  server: string;
  port: number;
  uuid?: string; // vmess / vless / tuic
  password?: string; // ss / trojan / hysteria2 / tuic
  cipher?: string; // ss 加密方法
  alterId?: number; // vmess
  encryption?: string; // vmess 加密方式 / vless 固定 none
  flow?: string; // vless
  network?: 'tcp' | 'ws' | 'grpc' | 'h2' | 'httpupgrade';
  tls?: boolean;
  sni?: string;
  alpn?: string[];
  insecure?: boolean;
  fp?: string; // uTLS 指纹
  wsPath?: string;
  wsHost?: string;
  serviceName?: string; // grpc
  reality?: boolean;
  pbk?: string; // reality public key
  sid?: string; // reality short id
  hy2Obfs?: string; // hysteria2 混淆（salamander）
  hy2ObfsPassword?: string;
  upMbps?: number;
  downMbps?: number;
  ssPlugin?: string; // 目前支持 obfs（simple-obfs / obfs-local）
  ssPluginMode?: string;
  ssPluginHost?: string;
  congestion?: string; // tuic 拥塞控制
  udpRelay?: string; // tuic udp_relay_mode
}

export interface ParseResult {
  nodes: ProxyNode[];
  skipped: string[];
}

// Clash YAML 用自研受限子集解析器：免费版（CPU 10ms/次）预算内安全，经确认默认启用
// （项目决策见 AGENTS.md #5；通用 yaml 库解析整份订阅会超免费版 CPU 限制）。

export function parseSubscription(content: string): ParseResult {
  const text = (content || '').trim();
  if (!text) return { nodes: [], skipped: [] };

  // 1. 明文 JSON（sing-box）
  if (text.startsWith('{') || text.startsWith('[')) {
    const r = trySingbox(text);
    if (r) return r;
  }
  // 2. Clash YAML
  if (/^[\t ]*proxies\s*:/m.test(text)) return parseClashPart(text);
  // 3. URI 列表（明文）
  if (text.includes('://')) return parseUriList(text);
  // 4. base64 订阅
  const decoded = tryBase64(text);
  if (decoded) {
    const d = decoded.trim();
    if (d.startsWith('{')) {
      const r = trySingbox(d);
      if (r) return r;
    }
    if (/^[\t ]*proxies\s*:/m.test(d)) return parseClashPart(d);
    if (d.includes('://')) return parseUriList(d);
  }
  return { nodes: [], skipped: ['无法识别订阅内容（不是 URI、base64、sing-box JSON 或 Clash YAML）'] };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function parseClashPart(text: string): ParseResult {
  try {
    return parseClashYaml(text);
  } catch (e) {
    return { nodes: [], skipped: [`Clash YAML 解析失败：${msg(e)}`] };
  }
}

function trySingbox(text: string): ParseResult | null {
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && Array.isArray(obj.outbounds)) return parseSingboxJson(obj);
  } catch {
    // 不是 JSON，继续按其它格式处理
  }
  return null;
}

function tryBase64(text: string): string | null {
  const t = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/\-_]+={0,2}$/.test(t)) return null;
  try {
    let s = t.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4 !== 0) s += '=';
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
    // 解码结果混有不可打印控制字符视为非文本订阅
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

// ---------- URI ----------

function parseUriList(text: string): ParseResult {
  const nodes: ProxyNode[] = [];
  const skipped: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const uri = line.trim();
    if (!uri) continue;
    try {
      nodes.push(parseNodeUri(uri));
    } catch (e) {
      const i = uri.indexOf('://');
      skipped.push(`${i > 0 ? uri.slice(0, i + 3) : '未知协议'}${msg(e)}`);
    }
  }
  return { nodes, skipped };
}

export function parseNodeUri(uri: string): ProxyNode {
  const m = /^([a-z0-9]+):\/\//i.exec(uri);
  if (!m) throw new Error('不是节点 URI');
  switch (m[1].toLowerCase()) {
    case 'ss':
      return parseSs(uri);
    case 'vmess':
      return parseVmess(uri);
    case 'vless':
      return parseVless(uri);
    case 'trojan':
      return parseTrojan(uri);
    case 'hysteria2':
    case 'hy2':
      return parseHy2(uri);
    case 'tuic':
      return parseTuic(uri);
    default:
      throw new Error(`不支持的协议 ${m[1].toLowerCase()}`);
  }
}

function fragName(uri: string): string {
  const i = uri.indexOf('#');
  if (i === -1) return '';
  const raw = uri.slice(i + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function queryOf(uri: string): URLSearchParams {
  const i = uri.indexOf('?');
  const j = uri.indexOf('#');
  const end = j === -1 ? uri.length : j;
  if (i === -1 || i >= end) return new URLSearchParams();
  return new URLSearchParams(uri.slice(i + 1, end));
}

function splitHostPort(s: string): [string, number] {
  if (s.startsWith('[')) {
    const m = /^\[(.+)\]:(\d+)$/.exec(s);
    if (!m) throw new Error('非法 IPv6 地址');
    return [m[1], Number(m[2])];
  }
  const i = s.lastIndexOf(':');
  if (i === -1) throw new Error('缺少端口');
  const port = Number(s.slice(i + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('非法端口');
  return [s.slice(0, i), port];
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function parseSs(uri: string): ProxyNode {
  const name = fragName(uri);
  let body = uri.slice(uri.indexOf('://') + 3);
  const hashIdx = body.indexOf('#');
  if (hashIdx !== -1) body = body.slice(0, hashIdx);
  const qIdx = body.indexOf('?');
  const query = qIdx === -1 ? new URLSearchParams() : new URLSearchParams(body.slice(qIdx + 1));
  if (qIdx !== -1) body = body.slice(0, qIdx);
  body = body.replace(/\/+$/, '');

  let method: string;
  let password: string;
  let host: string;
  let port: number;
  const at = body.lastIndexOf('@');
  if (at !== -1) {
    // SIP002：base64url(method:password)@host:port，2022 系明文 method:password
    const userinfo = body.slice(0, at);
    [host, port] = splitHostPort(body.slice(at + 1));
    let cred = userinfo.includes(':') ? decodeURIComponentSafe(userinfo) : '';
    if (!cred.includes(':')) {
      try {
        cred = b64urlDecode(userinfo);
      } catch {
        cred = '';
      }
      if (!cred.includes(':')) cred = decodeURIComponentSafe(userinfo);
    }
    const i = cred.indexOf(':');
    if (i === -1) throw new Error('缺少加密方法或密码');
    method = cred.slice(0, i);
    password = cred.slice(i + 1);
  } else {
    // 旧格式：整体 base64(method:password@host:port)
    const dec = b64urlDecode(body);
    const at2 = dec.lastIndexOf('@');
    if (at2 === -1) throw new Error('非法 ss URI');
    const cred = dec.slice(0, at2);
    const i = cred.indexOf(':');
    if (i === -1) throw new Error('缺少加密方法或密码');
    method = cred.slice(0, i);
    password = cred.slice(i + 1);
    [host, port] = splitHostPort(dec.slice(at2 + 1));
  }

  const node: ProxyNode = { name, type: 'ss', server: host, port, cipher: method, password };
  const plugin = query.get('plugin');
  if (plugin) {
    const parts = plugin.split(';');
    if (parts[0] === 'obfs-local' || parts[0] === 'simple-obfs') {
      node.ssPlugin = 'obfs';
      for (const kv of parts.slice(1)) {
        const [k, v] = kv.split('=');
        if (k === 'obfs') node.ssPluginMode = v;
        if (k === 'obfs-host') node.ssPluginHost = v;
      }
    } else {
      throw new Error(`不支持的 ss plugin ${parts[0]}`);
    }
  }
  return node;
}

function parseVmess(uri: string): ProxyNode {
  const raw = uri.slice('vmess://'.length).trim();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(b64decode(raw));
  } catch {
    json = JSON.parse(b64urlDecode(raw)); // 少数机场用 url-safe base64
  }
  const str = (k: string) => (json[k] == null ? '' : String(json[k]));
  const net = str('net') || 'tcp';
  if (net === 'tcp' && str('type') === 'http') throw new Error('不支持的 vmess http 伪装');
  const netMap: Record<string, ProxyNode['network']> = { tcp: 'tcp', ws: 'ws', grpc: 'grpc', h2: 'h2', httpupgrade: 'httpupgrade' };
  const network = netMap[net];
  if (!network) throw new Error(`不支持的传输 ${net}`);
  const node: ProxyNode = {
    name: str('ps') || fragName(uri),
    type: 'vmess',
    server: str('add'),
    port: Number(str('port')) || 0,
    uuid: str('id'),
    alterId: Number(str('aid')) || 0,
    encryption: str('scy') || 'auto',
    network,
    tls: str('tls') === 'tls',
  };
  if (!node.server || !node.port || !node.uuid) throw new Error('vmess 缺少必要字段');
  if (str('sni')) node.sni = str('sni');
  if (str('fp')) node.fp = str('fp');
  if (str('alpn')) node.alpn = str('alpn').split(',').filter(Boolean);
  if (network !== 'tcp' && network !== 'grpc') {
    if (str('path')) node.wsPath = str('path');
    if (str('host')) node.wsHost = str('host');
  } else if (network === 'grpc') {
    node.serviceName = str('path');
  }
  return node;
}

const URI_NET_MAP: Record<string, ProxyNode['network']> = {
  tcp: 'tcp',
  ws: 'ws',
  grpc: 'grpc',
  h2: 'h2',
  http: 'h2',
  httpupgrade: 'httpupgrade',
};

function parseVless(uri: string): ProxyNode {
  const name = fragName(uri);
  const authority = uri.slice('vless://'.length).split(/[?#]/)[0].replace(/\/+$/, '');
  const q = queryOf(uri);
  const at = authority.lastIndexOf('@');
  if (at === -1) throw new Error('vless 缺少用户信息');
  const uuid = decodeURIComponentSafe(authority.slice(0, at));
  const [host, port] = splitHostPort(authority.slice(at + 1));
  if ((q.get('encryption') ?? 'none') !== 'none') throw new Error(`不支持的 vless encryption ${q.get('encryption')}`);
  const security = q.get('security') ?? 'none';
  const network = URI_NET_MAP[q.get('type') ?? 'tcp'];
  if (!network) throw new Error(`不支持的传输 ${q.get('type')}`);
  const node: ProxyNode = { name, type: 'vless', server: host, port, uuid, encryption: 'none', network };
  if (security === 'tls' || security === 'reality') {
    node.tls = true;
    if (security === 'reality') {
      node.reality = true;
      node.pbk = q.get('pbk') ?? '';
      node.sid = q.get('sid') ?? '';
    }
    const sni = q.get('sni');
    if (sni) node.sni = sni;
    const fp = q.get('fp');
    if (fp) node.fp = fp;
    if (q.get('alpn')) node.alpn = q.get('alpn')!.split(',').filter(Boolean);
  } else if (security !== 'none' && security !== '') {
    throw new Error(`不支持的 security ${security}`);
  }
  const flow = q.get('flow');
  if (flow) node.flow = flow;
  if (['1', 'true'].includes(q.get('allowInsecure') ?? q.get('insecure') ?? '')) node.insecure = true;
  const path = q.get('path');
  const hostHdr = q.get('host');
  if (network === 'ws' || network === 'h2' || network === 'httpupgrade') {
    if (path) node.wsPath = path;
    if (hostHdr) node.wsHost = hostHdr;
  } else if (network === 'grpc' && path) {
    node.serviceName = path;
  }
  if (!node.uuid) throw new Error('vless 缺少 uuid');
  return node;
}

function parseTrojan(uri: string): ProxyNode {
  const name = fragName(uri);
  const authority = uri.slice('trojan://'.length).split(/[?#]/)[0].replace(/\/+$/, '');
  const q = queryOf(uri);
  const at = authority.lastIndexOf('@');
  if (at === -1) throw new Error('trojan 缺少密码');
  const password = decodeURIComponentSafe(authority.slice(0, at));
  const [host, port] = splitHostPort(authority.slice(at + 1));
  const network = URI_NET_MAP[q.get('type') ?? 'tcp'];
  if (!network) throw new Error(`不支持的传输 ${q.get('type')}`);
  const node: ProxyNode = { name, type: 'trojan', server: host, port, password, tls: true, network };
  node.sni = q.get('sni') ?? q.get('peer') ?? undefined;
  if (q.get('alpn')) node.alpn = q.get('alpn')!.split(',').filter(Boolean);
  if (['1', 'true'].includes(q.get('allowInsecure') ?? q.get('insecure') ?? '')) node.insecure = true;
  const path = q.get('path');
  const hostHdr = q.get('host');
  if (network === 'ws' || network === 'h2' || network === 'httpupgrade') {
    if (path) node.wsPath = path;
    if (hostHdr) node.wsHost = hostHdr;
  } else if (network === 'grpc' && path) {
    node.serviceName = path;
  }
  return node;
}

function parseHy2(uri: string): ProxyNode {
  const name = fragName(uri);
  const authority = uri.slice(uri.indexOf('://') + 3).split(/[?#]/)[0];
  const q = queryOf(uri);
  const at = authority.lastIndexOf('@');
  if (at === -1) throw new Error('hysteria2 缺少密码');
  const password = decodeURIComponentSafe(authority.slice(0, at));
  let hostport = authority.slice(at + 1);
  const comma = hostport.indexOf(','); // 端口范围/多端口暂不支持，取主端口
  if (comma !== -1) hostport = hostport.slice(0, comma);
  const [host, port] = splitHostPort(hostport);
  const node: ProxyNode = { name, type: 'hysteria2', server: host, port, password, tls: true };
  node.sni = q.get('sni') ?? q.get('peer') ?? undefined;
  if (['1', 'true'].includes(q.get('insecure') ?? '')) node.insecure = true;
  if (q.get('obfs')) {
    if (q.get('obfs') !== 'salamander') throw new Error(`不支持的 hysteria2 obfs ${q.get('obfs')}`);
    node.hy2Obfs = 'salamander';
    node.hy2ObfsPassword = q.get('obfs-password') ?? '';
  }
  if (q.get('upmbps')) node.upMbps = Number(q.get('upmbps')) || undefined;
  if (q.get('downmbps')) node.downMbps = Number(q.get('downmbps')) || undefined;
  if (q.get('alpn')) node.alpn = q.get('alpn')!.split(',').filter(Boolean);
  return node;
}

function parseTuic(uri: string): ProxyNode {
  const name = fragName(uri);
  const authority = uri.slice('tuic://'.length).split(/[?#]/)[0].replace(/\/+$/, '');
  const q = queryOf(uri);
  const at = authority.lastIndexOf('@');
  if (at === -1) throw new Error('tuic 缺少用户信息');
  const userinfo = authority.slice(0, at);
  const ci = userinfo.indexOf(':');
  const uuid = decodeURIComponentSafe(ci === -1 ? userinfo : userinfo.slice(0, ci));
  const password = ci === -1 ? '' : decodeURIComponentSafe(userinfo.slice(ci + 1));
  const [host, port] = splitHostPort(authority.slice(at + 1));
  const node: ProxyNode = { name, type: 'tuic', server: host, port, uuid, password, tls: true };
  node.sni = q.get('sni') ?? undefined;
  if (q.get('alpn')) node.alpn = q.get('alpn')!.split(',').filter(Boolean);
  const congestion = q.get('congestion_control');
  if (congestion) node.congestion = congestion;
  const udpRelay = q.get('udp_relay_mode');
  if (udpRelay) node.udpRelay = udpRelay;
  if (['1', 'true'].includes(q.get('allow_insecure') ?? q.get('insecure') ?? '')) node.insecure = true;
  if (!node.uuid) throw new Error('tuic 缺少 uuid');
  return node;
}

// ---------- sing-box JSON ----------

const SB_BUILTIN = new Set(['direct', 'block', 'dns', 'selector', 'urltest']);

function parseSingboxJson(obj: any): ParseResult {
  const nodes: ProxyNode[] = [];
  const skipped: string[] = [];
  for (const o of obj.outbounds) {
    if (!o || typeof o !== 'object') continue;
    const type = String(o.type ?? '');
    if (SB_BUILTIN.has(type)) continue;
    const tag = String(o.tag ?? type);
    try {
      nodes.push(mapSingboxOutbound(o, type, tag));
    } catch (e) {
      skipped.push(`${tag}：${msg(e)}`);
    }
  }
  return { nodes, skipped };
}

function mapSingboxOutbound(o: any, type: string, tag: string): ProxyNode {
  const base = { name: tag, server: String(o.server ?? ''), port: Number(o.server_port ?? 0) };
  if (!base.server || !base.port) throw new Error('缺少 server/server_port');
  const tls = o.tls ?? {};

  const fromTls = (n: ProxyNode) => {
    const alwaysTls = type === 'trojan' || type === 'hysteria2' || type === 'tuic';
    if (!tls?.enabled && !tls?.reality?.enabled && !alwaysTls) return;
    n.tls = true;
    if (tls?.server_name) n.sni = String(tls.server_name);
    if (tls?.insecure) n.insecure = true;
    if (Array.isArray(tls?.alpn) && tls.alpn.length) n.alpn = tls.alpn.map(String);
    if (tls?.utls?.fingerprint) n.fp = String(tls.utls.fingerprint);
    if (tls?.reality?.enabled) {
      n.reality = true;
      n.pbk = String(tls.reality.public_key ?? '');
      n.sid = String(tls.reality.short_id ?? '');
    }
  };

  const fromTransport = (n: ProxyNode) => {
    const t = o.transport;
    if (!t) {
      // sing-box 无 transport 即 tcp 直连传输（vmess/vless/trojan）
      if (type === 'vmess' || type === 'vless' || type === 'trojan') n.network = 'tcp';
      return;
    }
    const tt = String(t.type ?? '');
    const first = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : String(v ?? ''));
    if (tt === 'ws') {
      n.network = 'ws';
      n.wsPath = t.path ? String(t.path) : '/';
      const h = t.headers?.Host ?? t.headers?.host;
      if (h) n.wsHost = first(h);
    } else if (tt === 'grpc') {
      n.network = 'grpc';
      n.serviceName = t.service_name ? String(t.service_name) : '';
    } else if (tt === 'http' || tt === 'httpupgrade') {
      n.network = tt === 'http' ? 'h2' : 'httpupgrade';
      if (t.path) n.wsPath = String(t.path);
      if (t.host) n.wsHost = first(t.host);
    } else {
      throw new Error(`不支持的传输 ${tt}`);
    }
  };

  switch (type) {
    case 'ss': {
      const n: ProxyNode = { ...base, type: 'ss', cipher: String(o.method ?? ''), password: String(o.password ?? '') };
      if (o.plugin) {
        if (o.plugin !== 'obfs-local' && o.plugin !== 'simple-obfs') throw new Error(`不支持的 ss plugin ${o.plugin}`);
        n.ssPlugin = 'obfs';
        for (const kv of String(o.plugin_opts ?? '').split(';')) {
          const [k, v] = kv.split('=');
          if (k === 'obfs') n.ssPluginMode = v;
          if (k === 'obfs-host') n.ssPluginHost = v;
        }
      }
      return n;
    }
    case 'vmess': {
      const n: ProxyNode = { ...base, type: 'vmess', uuid: String(o.uuid ?? ''), alterId: Number(o.alter_id ?? 0), encryption: String(o.security ?? 'auto') };
      fromTls(n);
      fromTransport(n);
      return n;
    }
    case 'vless': {
      const n: ProxyNode = { ...base, type: 'vless', uuid: String(o.uuid ?? ''), encryption: 'none' };
      if (o.flow) n.flow = String(o.flow);
      fromTls(n);
      fromTransport(n);
      return n;
    }
    case 'trojan': {
      const n: ProxyNode = { ...base, type: 'trojan', password: String(o.password ?? ''), tls: true };
      fromTls(n);
      fromTransport(n);
      return n;
    }
    case 'hysteria2': {
      const n: ProxyNode = { ...base, type: 'hysteria2', password: String(o.password ?? ''), tls: true };
      if (Number.isFinite(o.up_mbps)) n.upMbps = Number(o.up_mbps);
      if (Number.isFinite(o.down_mbps)) n.downMbps = Number(o.down_mbps);
      if (o.obfs?.type) {
        if (o.obfs.type !== 'salamander') throw new Error(`不支持的 hysteria2 obfs ${o.obfs.type}`);
        n.hy2Obfs = 'salamander';
        n.hy2ObfsPassword = String(o.obfs.password ?? '');
      }
      fromTls(n);
      return n;
    }
    case 'tuic': {
      const n: ProxyNode = { ...base, type: 'tuic', uuid: String(o.uuid ?? ''), password: String(o.password ?? ''), tls: true };
      if (o.congestion_control) n.congestion = String(o.congestion_control);
      if (o.udp_relay_mode) n.udpRelay = String(o.udp_relay_mode);
      fromTls(n);
      return n;
    }
    default:
      throw new Error(`不支持的协议 ${type}`);
  }
}

// ---------- Clash YAML（受限子集解析器）----------
// 只解析机场 proxies 段用到的语法：块式映射/列表（多层嵌套）、行内 flow map/list、常规标量。
// 不支持锚点、多文档、tag、merge key（机场配置用不到）。单遍扫描 + 大小/数量上限。

const CLASH_MAX_INPUT = 256 * 1024;
const CLASH_MAX_NODES = 300;

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

function parseClashYaml(text: string): ParseResult {
  const notes: string[] = [];
  let truncated = false;
  if (text.length > CLASH_MAX_INPUT) {
    text = text.slice(0, CLASH_MAX_INPUT);
    const cut = text.lastIndexOf('\n');
    if (cut > 0) text = text.slice(0, cut);
    truncated = true;
  }
  const lines = text.split('\n');
  let start = -1;
  let inlineVal = '';
  for (let i = 0; i < lines.length; i++) {
    const m = /^[\t ]*proxies\s*:(.*)$/.exec(lines[i]);
    if (m) {
      start = i;
      inlineVal = m[1].trim();
      break;
    }
  }
  if (start === -1) {
    throw new Error(truncated ? `未找到 proxies: 段（订阅超 ${CLASH_MAX_INPUT / 1024}KB 已截断）` : '未找到顶层 proxies: 段');
  }
  const proxies = parseProxiesValue(lines, start, inlineVal, notes);
  const nodes: ProxyNode[] = [];
  const skipped = notes.slice();
  for (const p of proxies) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    try {
      nodes.push(mapClashProxy(p as any));
    } catch (e) {
      const rec = p as Record<string, YamlValue>;
      skipped.push(`${String(rec.name ?? rec.type ?? '?')}：${msg(e)}`);
    }
  }
  return { nodes, skipped };
}

function parseProxiesValue(lines: string[], keyLine: number, inlineVal: string, notes: string[]): YamlValue[] {
  if (inlineVal !== '') {
    if (inlineVal === '[]') return [];
    const { text } = collectFlow(lines, keyLine + 1, inlineVal);
    const v = parseFlowValue(text, { i: 0 });
    if (!Array.isArray(v)) throw new Error('proxies 不是列表');
    return v;
  }
  const first = nextContent(lines, keyLine + 1);
  if (!first || !lines[first.idx].slice(first.ind).startsWith('-')) return [];
  const [list] = parseYamlList(lines, first.idx, first.ind, notes);
  return list;
}

function nextContent(lines: string[], from: number): { idx: number; ind: number } | null {
  for (let k = from; k < lines.length; k++) {
    const m = /^([\t ]*)(.*)$/.exec(lines[k])!;
    if (m[2] !== '' && !m[2].startsWith('#')) return { idx: k, ind: m[1].length };
  }
  return null;
}

/** flow 值可能跨行：从未平衡处向后拼接，最多 60 行 */
function collectFlow(lines: string[], fromLine: number, text: string): { text: string; next: number } {
  let k = fromLine;
  while (!flowBalanced(text) && k < lines.length && k - fromLine < 60) {
    text += ' ' + lines[k].trim();
    k++;
  }
  return { text, next: k };
}

function flowBalanced(s: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return depth <= 0;
}

function parseYamlList(lines: string[], i: number, indent: number, notes: string[]): [YamlValue[], number] {
  const out: YamlValue[] = [];
  let cur = i;
  for (;;) {
    const nc = nextContent(lines, cur);
    if (!nc || nc.ind < indent) {
      cur = nc ? nc.idx : lines.length;
      break;
    }
    if (out.length >= CLASH_MAX_NODES) {
      notes.push(`节点超过 ${CLASH_MAX_NODES} 个，已截断`);
      cur = nc.idx;
      break;
    }
    if (nc.ind > indent) throw new Error(`缩进异常（第 ${nc.idx + 1} 行）`);
    const content = lines[nc.idx].slice(indent);
    if (!content.startsWith('-')) break;
    cur = nc.idx + 1;
    const rest = content.replace(/^-\s*/, '').trim();
    if (rest === '') {
      const child = nextContent(lines, cur);
      if (!child || child.ind <= indent) {
        out.push(null);
        continue;
      }
      const isListItem = lines[child.idx].slice(child.ind).startsWith('-');
      const [v, next] = isListItem ? parseYamlList(lines, child.idx, child.ind, notes) : parseYamlMap(lines, child.idx, child.ind, notes);
      out.push(v);
      cur = next;
      continue;
    }
    if (rest.startsWith('{') || rest.startsWith('[')) {
      const { text, next } = collectFlow(lines, cur, rest);
      out.push(parseFlowValue(text, { i: 0 }));
      cur = next;
      continue;
    }
    if (splitKey(rest)) {
      // 块式映射项：首键内联在 '- ' 后，其余键缩进 +2
      const [obj, next] = parseYamlMap(lines, cur, indent + 2, notes, rest);
      out.push(obj);
      cur = next;
      continue;
    }
    out.push(parseYamlScalar(rest));
  }
  return [out, cur];
}

function parseYamlMap(
  lines: string[],
  i: number,
  indent: number,
  notes: string[],
  firstRest?: string
): [Record<string, YamlValue>, number] {
  const obj: Record<string, YamlValue> = {};
  let cur = i;
  let rest = firstRest;
  for (;;) {
    let key: string;
    let valText: string;
    if (rest !== undefined) {
      const kv = splitKey(rest);
      if (!kv) throw new Error(`无法解析键值：${rest.slice(0, 40)}`);
      key = kv.key;
      valText = kv.val;
      rest = undefined;
    } else {
      const nc = nextContent(lines, cur);
      if (!nc || nc.ind < indent) {
        cur = nc ? nc.idx : lines.length;
        break;
      }
      if (nc.ind > indent) throw new Error(`缩进异常（第 ${nc.idx + 1} 行）`);
      const content = lines[nc.idx].slice(indent);
      if (content.startsWith('-')) break;
      const kv = splitKey(content);
      if (!kv) throw new Error(`无法解析键值：${content.slice(0, 40)}`);
      key = kv.key;
      valText = kv.val;
      cur = nc.idx + 1;
    }
    if (valText === '') {
      const child = nextContent(lines, cur);
      if (child && child.ind > indent) {
        const isListItem = lines[child.idx].slice(child.ind).startsWith('-');
        const [v, next] = isListItem ? parseYamlList(lines, child.idx, child.ind, notes) : parseYamlMap(lines, child.idx, child.ind, notes);
        obj[key] = v;
        cur = next;
      } else {
        obj[key] = null;
      }
    } else if (valText.startsWith('{') || valText.startsWith('[')) {
      const { text, next } = collectFlow(lines, cur, valText);
      obj[key] = parseFlowValue(text, { i: 0 });
      cur = next;
    } else {
      obj[key] = parseYamlScalar(valText);
    }
  }
  return [obj, cur];
}

interface FlowPos {
  i: number;
}

function parseFlowValue(s: string, p: FlowPos): YamlValue {
  skipFlowWs(s, p);
  const c = s[p.i];
  if (c === '{') return parseFlowMap(s, p);
  if (c === '[') return parseFlowList(s, p);
  return parseFlowScalar(s, p);
}

function skipFlowWs(s: string, p: FlowPos): void {
  while (p.i < s.length && (s[p.i] === ' ' || s[p.i] === '\t' || s[p.i] === ',')) p.i++;
}

function parseFlowMap(s: string, p: FlowPos): Record<string, YamlValue> {
  const obj: Record<string, YamlValue> = {};
  p.i++;
  for (;;) {
    skipFlowWs(s, p);
    if (p.i >= s.length) break;
    if (s[p.i] === '}') {
      p.i++;
      break;
    }
    let quote: string | null = null;
    const keyStart = p.i;
    while (p.i < s.length) {
      const c = s[p.i];
      if (quote) {
        if (quote === '"' && c === '\\') p.i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ':') break;
      p.i++;
    }
    const key = unquoteKey(s.slice(keyStart, p.i).trim());
    p.i++;
    obj[key] = parseFlowValue(s, p);
  }
  return obj;
}

function parseFlowList(s: string, p: FlowPos): YamlValue[] {
  const out: YamlValue[] = [];
  p.i++;
  for (;;) {
    skipFlowWs(s, p);
    if (p.i >= s.length) break;
    if (s[p.i] === ']') {
      p.i++;
      break;
    }
    out.push(parseFlowValue(s, p));
  }
  return out;
}

function parseFlowScalar(s: string, p: FlowPos): YamlValue {
  const q = s[p.i];
  if (q === '"' || q === "'") {
    const start = p.i;
    p.i++;
    while (p.i < s.length) {
      const c = s[p.i];
      if (q === '"' && c === '\\') {
        p.i += 2;
        continue;
      }
      if (c === q) {
        if (q === "'" && s[p.i + 1] === "'") {
          p.i += 2;
          continue;
        }
        p.i++;
        break;
      }
      p.i++;
    }
    return parseYamlScalar(s.slice(start, p.i));
  }
  const start = p.i;
  while (p.i < s.length && s[p.i] !== ',' && s[p.i] !== '}' && s[p.i] !== ']') p.i++;
  return parseYamlScalar(s.slice(start, p.i));
}

function parseYamlScalar(raw: string): YamlValue {
  let t = raw.trim();
  if (t === '') return null;
  if (t.startsWith('"')) {
    let out = '';
    for (let i = 1; i < t.length; i++) {
      const c = t[i];
      if (c === '\\' && i + 1 < t.length) {
        i++;
        const e = t[i];
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
      } else if (c === '"') {
        break;
      } else {
        out += c;
      }
    }
    return out;
  }
  if (t.startsWith("'")) {
    let out = '';
    for (let i = 1; i < t.length; i++) {
      if (t[i] === "'") {
        if (t[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        break;
      }
      out += t[i];
    }
    return out;
  }
  const h = /(^|\s)#/.exec(t);
  if (h) t = t.slice(0, h.index).trim();
  if (t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  if (t === 'true' || t === 'True' || t === 'TRUE') return true;
  if (t === 'false' || t === 'False' || t === 'FALSE') return false;
  if (/^[+-]?\d+$/.test(t) || /^[+-]?\d*\.\d+$/.test(t)) return Number(t);
  return t;
}

function splitKey(content: string): { key: string; val: string } | null {
  let quote: string | null = null;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ':' && (content[i + 1] === undefined || content[i + 1] === ' ' || content[i + 1] === '\t')) {
      return { key: unquoteKey(content.slice(0, i).trim()), val: content.slice(i + 1).trim() };
    }
  }
  return null;
}

function unquoteKey(k: string): string {
  if (k.length >= 2 && ((k[0] === '"' && k.endsWith('"')) || (k[0] === "'" && k.endsWith("'")))) {
    return String(parseYamlScalar(k));
  }
  return k;
}

function clashNet(p: any): Pick<ProxyNode, 'network' | 'wsPath' | 'wsHost' | 'serviceName'> {
  const net = p.network ? String(p.network) : 'tcp';
  const first = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : String(v ?? ''));
  if (net === 'tcp') return { network: 'tcp' };
  if (net === 'ws') {
    const wo = p['ws-opts'] ?? {};
    return { network: 'ws', wsPath: wo.path ? String(wo.path) : '/', wsHost: wo.headers ? first(wo.headers.Host ?? wo.headers.host) : '' };
  }
  if (net === 'grpc') return { network: 'grpc', serviceName: String(p['grpc-opts']?.['grpc-service-name'] ?? '') };
  if (net === 'h2') {
    const ho = p['h2-opts'] ?? {};
    return { network: 'h2', wsPath: ho.path ? String(ho.path) : '/', wsHost: first(ho.host) };
  }
  if (net === 'httpupgrade') {
    const ho = p['httpupgrade-opts'] ?? {};
    return { network: 'httpupgrade', wsPath: ho.path ? String(ho.path) : '/', wsHost: first(ho.host) };
  }
  throw new Error(`不支持的传输 ${net}`);
}

function mapClashProxy(p: any): ProxyNode {
  const type = String(p.type ?? '');
  const base = { name: String(p.name ?? ''), server: String(p.server ?? ''), port: Number(p.port ?? 0) };
  if (!base.server || !base.port) throw new Error('缺少 server/port');
  const insecure = p['skip-cert-verify'] ? true : undefined;
  const alpn = Array.isArray(p.alpn) ? p.alpn.map(String) : typeof p.alpn === 'string' && p.alpn ? [String(p.alpn)] : undefined;
  const applyNet = (n: ProxyNode) => {
    Object.assign(n, clashNet(p));
  };

  switch (type) {
    case 'ss': {
      const n: ProxyNode = { ...base, type: 'ss', cipher: String(p.cipher ?? ''), password: String(p.password ?? '') };
      if (p.plugin) {
        if (String(p.plugin) !== 'obfs') throw new Error(`不支持的 ss plugin ${p.plugin}`);
        n.ssPlugin = 'obfs';
        n.ssPluginMode = p['plugin-opts']?.mode ? String(p['plugin-opts'].mode) : undefined;
        n.ssPluginHost = p['plugin-opts']?.host ? String(p['plugin-opts'].host) : undefined;
      }
      return n;
    }
    case 'vmess': {
      const n: ProxyNode = { ...base, type: 'vmess', uuid: String(p.uuid ?? ''), alterId: Number(p.alterId ?? 0), encryption: String(p.cipher ?? 'auto') };
      applyNet(n);
      if (p.tls) n.tls = true;
      if (p.servername) n.sni = String(p.servername);
      if (insecure) n.insecure = insecure;
      if (alpn) n.alpn = alpn;
      return n;
    }
    case 'vless': {
      const n: ProxyNode = { ...base, type: 'vless', uuid: String(p.uuid ?? ''), encryption: 'none' };
      applyNet(n);
      if (p.flow) n.flow = String(p.flow);
      if (p.tls || p['reality-opts']) n.tls = true;
      if (p['reality-opts']) {
        n.reality = true;
        n.pbk = String(p['reality-opts']['public-key'] ?? '');
        n.sid = String(p['reality-opts']['short-id'] ?? '');
      }
      if (p.servername || p.sni) n.sni = String(p.servername ?? p.sni);
      if (p['client-fingerprint']) n.fp = String(p['client-fingerprint']);
      if (insecure) n.insecure = insecure;
      if (alpn) n.alpn = alpn;
      return n;
    }
    case 'trojan': {
      const n: ProxyNode = { ...base, type: 'trojan', password: String(p.password ?? ''), tls: true };
      applyNet(n);
      const trojanSni = p.sni ? String(p.sni) : p.servername ? String(p.servername) : undefined;
      if (trojanSni) n.sni = trojanSni;
      if (insecure) n.insecure = insecure;
      if (alpn) n.alpn = alpn;
      return n;
    }
    case 'hysteria2': {
      const n: ProxyNode = { ...base, type: 'hysteria2', password: String(p.password ?? ''), tls: true };
      if (p.obfs) {
        if (String(p.obfs) !== 'salamander') throw new Error(`不支持的 hysteria2 obfs ${p.obfs}`);
        n.hy2Obfs = 'salamander';
        n.hy2ObfsPassword = String(p['obfs-password'] ?? '');
      }
      if (p.sni || p.servername) n.sni = String(p.sni ?? p.servername);
      if (p.up) n.upMbps = parseInt(String(p.up), 10) || undefined;
      if (p.down) n.downMbps = parseInt(String(p.down), 10) || undefined;
      if (insecure) n.insecure = insecure;
      if (alpn) n.alpn = alpn;
      return n;
    }
    case 'tuic': {
      const n: ProxyNode = { ...base, type: 'tuic', uuid: String(p.uuid ?? ''), password: String(p.password ?? ''), tls: true };
      if (p.sni || p.servername) n.sni = String(p.sni ?? p.servername);
      if (alpn) n.alpn = alpn;
      if (p['congestion-controller']) n.congestion = String(p['congestion-controller']);
      if (p['udp-relay-mode']) n.udpRelay = String(p['udp-relay-mode']);
      if (insecure) n.insecure = insecure;
      return n;
    }
    default:
      throw new Error(`不支持的协议 ${type}`);
  }
}
