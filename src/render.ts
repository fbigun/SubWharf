// 输出序列化：内部节点模型 → Clash(Mihomo YAML) / sing-box / URI / base64。
// 四种输出同源，仅 proxies + 单一 PROXY 组；机场 rules / proxy-groups 一律不透传。
import type { ProxyNode } from './parse';
import { b64encode, b64urlEncode } from './auth';

export type OutputTarget = 'clash' | 'singbox' | 'base64' | 'uri';
export type RulesMode = 'none' | 'cn';
export type RuleSource = 'official' | 'jsdelivr';

// 绕华 rule_set 的 .srs 地址：SagerNet 官方，可切 jsDelivr 镜像；服务端不内置任何规则数据
export const RULE_SET_URLS: Record<RuleSource, Record<'geosite-cn' | 'geoip-cn', string>> = {
  official: {
    'geosite-cn': 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs',
    'geoip-cn': 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs',
  },
  jsdelivr: {
    'geosite-cn': 'https://cdn.jsdelivr.net/gh/SagerNet/sing-geosite@rule-set/geosite-cn.srs',
    'geoip-cn': 'https://cdn.jsdelivr.net/gh/SagerNet/sing-geoip@rule-set/geoip-cn.srs',
  },
};

// ---------- Clash (Mihomo YAML) ----------
// 手写 emitter：值统一走 JSON.stringify 的双引号形式，YAML 双引号标量兼容 JSON 转义

const yq = (s: string): string => JSON.stringify(s);

function clashYamlNode(n: ProxyNode): string[] {
  const L: string[] = [];
  const kv = (k: string, v: string | number | boolean) => L.push(`  ${k}: ${typeof v === 'string' ? yq(v) : String(v)}`);
  L.push(`- name: ${yq(n.name)}`);
  kv('type', n.type);
  kv('server', n.server);
  kv('port', n.port);
  kv('udp', true);
  if (n.type === 'ss') {
    kv('cipher', n.cipher || 'aes-128-gcm');
    kv('password', n.password || '');
    if (n.ssPlugin === 'obfs') {
      kv('plugin', 'obfs');
      L.push('  plugin-opts:');
      L.push(`    mode: ${yq(n.ssPluginMode || 'http')}`);
      if (n.ssPluginHost) L.push(`    host: ${yq(n.ssPluginHost)}`);
    }
  } else if (n.type === 'vmess') {
    kv('uuid', n.uuid || '');
    kv('alterId', n.alterId ?? 0);
    kv('cipher', n.encryption || 'auto');
  } else if (n.type === 'vless') {
    kv('uuid', n.uuid || '');
    if (n.flow) kv('flow', n.flow);
  } else if (n.type === 'trojan') {
    kv('password', n.password || '');
  } else if (n.type === 'hysteria2') {
    kv('password', n.password || '');
    if (n.upMbps) kv('up', n.upMbps);
    if (n.downMbps) kv('down', n.downMbps);
    if (n.hy2Obfs) {
      kv('obfs', n.hy2Obfs);
      kv('obfs-password', n.hy2ObfsPassword || '');
    }
  } else if (n.type === 'tuic') {
    kv('uuid', n.uuid || '');
    kv('password', n.password || '');
    if (n.congestion) kv('congestion-controller', n.congestion);
    if (n.udpRelay) kv('udp-relay-mode', n.udpRelay);
  }
  if (n.tls || n.reality) kv('tls', true);
  // Clash 字段惯例：vmess/vless 用 servername，trojan/hysteria2/tuic 用 sni
  if (n.sni) kv(n.type === 'vmess' || n.type === 'vless' ? 'servername' : 'sni', n.sni);
  if (n.insecure) kv('skip-cert-verify', true);
  if (n.fp) kv('client-fingerprint', n.fp);
  if (n.reality) {
    L.push('  reality-opts:');
    L.push(`    public-key: ${yq(n.pbk || '')}`);
    if (n.sid) L.push(`    short-id: ${yq(n.sid)}`);
  }
  if (n.alpn?.length) {
    L.push('  alpn:');
    for (const a of n.alpn) L.push(`    - ${yq(a)}`);
  }
  if (n.network && n.network !== 'tcp') {
    kv('network', n.network);
    if (n.network === 'ws') {
      L.push('  ws-opts:');
      L.push(`    path: ${yq(n.wsPath || '/')}`);
      if (n.wsHost) {
        L.push('    headers:');
        L.push(`      Host: ${yq(n.wsHost)}`);
      }
    } else if (n.network === 'grpc') {
      L.push('  grpc-opts:');
      L.push(`    grpc-service-name: ${yq(n.serviceName || '')}`);
    } else if (n.network === 'h2' || n.network === 'httpupgrade') {
      L.push(`  ${n.network === 'h2' ? 'h2-opts' : 'httpupgrade-opts'}:`);
      L.push(`    path: ${yq(n.wsPath || '/')}`);
      if (n.wsHost) {
        L.push('    host:');
        L.push(`      - ${yq(n.wsHost)}`);
      }
    }
  }
  return L;
}

export function renderClash(nodes: ProxyNode[], rules: RulesMode): string {
  const L: string[] = ['mixed-port: 7890', 'allow-lan: false', 'mode: rule', 'log-level: info', '', nodes.length ? 'proxies:' : 'proxies: []'];
  for (const n of nodes) L.push(...clashYamlNode(n));
  L.push('', 'proxy-groups:', '  - name: PROXY', '    type: select', '    proxies:');
  if (nodes.length === 0) L.push('      - DIRECT'); // 空节点兜底，保证配置合法
  for (const n of nodes) L.push(`      - ${yq(n.name)}`);
  L.push('', 'rules:');
  if (rules === 'cn') {
    L.push('  - GEOIP,PRIVATE,DIRECT,no-resolve', '  - GEOSITE,CN,DIRECT', '  - GEOIP,CN,DIRECT');
  }
  L.push('  - MATCH,PROXY');
  return L.join('\n') + '\n';
}

// ---------- sing-box ----------

function sbTls(n: ProxyNode): Record<string, unknown> | undefined {
  const alwaysTls = n.type === 'trojan' || n.type === 'hysteria2' || n.type === 'tuic';
  if (!n.tls && !n.reality && !alwaysTls) return undefined;
  const tls: Record<string, unknown> = { enabled: true };
  if (n.sni) tls.server_name = n.sni;
  if (n.insecure) tls.insecure = true;
  if (n.alpn?.length) tls.alpn = n.alpn;
  if (n.fp) tls.utls = { enabled: true, fingerprint: n.fp };
  if (n.reality) tls.reality = { enabled: true, public_key: n.pbk || '', short_id: n.sid || '' };
  return tls;
}

function sbTransport(n: ProxyNode): Record<string, unknown> | undefined {
  if (!n.network || n.network === 'tcp') return undefined;
  if (n.network === 'ws') {
    const t: Record<string, unknown> = { type: 'ws', path: n.wsPath || '/' };
    if (n.wsHost) t.headers = { Host: n.wsHost };
    return t;
  }
  if (n.network === 'grpc') return { type: 'grpc', service_name: n.serviceName || '' };
  if (n.network === 'h2') return { type: 'http', path: n.wsPath || '/', host: n.wsHost ? [n.wsHost] : undefined };
  return { type: 'httpupgrade', path: n.wsPath || '/', host: n.wsHost ? [n.wsHost] : undefined };
}

// singbox 出站类型名与内部模型不同：ss → shadowsocks
const SINGBOX_TYPE: Record<ProxyNode['type'], string> = {
  ss: 'shadowsocks',
  vmess: 'vmess',
  vless: 'vless',
  trojan: 'trojan',
  hysteria2: 'hysteria2',
  tuic: 'tuic',
};

export function singboxOutbound(n: ProxyNode): Record<string, unknown> {
  const o: Record<string, unknown> = { type: SINGBOX_TYPE[n.type], tag: n.name, server: n.server, server_port: n.port };
  if (n.type === 'ss') {
    o.method = n.cipher || 'aes-128-gcm';
    o.password = n.password || '';
    if (n.ssPlugin === 'obfs') {
      o.plugin = 'obfs-local';
      o.plugin_opts = `obfs=${n.ssPluginMode || 'http'}${n.ssPluginHost ? `;obfs-host=${n.ssPluginHost}` : ''}`;
    }
  } else if (n.type === 'vmess') {
    o.uuid = n.uuid;
    o.security = n.encryption || 'auto';
    o.alter_id = n.alterId ?? 0;
  } else if (n.type === 'vless') {
    o.uuid = n.uuid;
    if (n.flow) o.flow = n.flow;
  } else if (n.type === 'trojan' || n.type === 'hysteria2' || n.type === 'tuic') {
    o.password = n.password || '';
  }
  if (n.type === 'hysteria2') {
    if (n.upMbps) o.up_mbps = n.upMbps;
    if (n.downMbps) o.down_mbps = n.downMbps;
    if (n.hy2Obfs) o.obfs = { type: n.hy2Obfs, password: n.hy2ObfsPassword || '' };
  }
  if (n.type === 'tuic') {
    o.uuid = n.uuid;
    if (n.congestion) o.congestion_control = n.congestion;
    if (n.udpRelay) o.udp_relay_mode = n.udpRelay;
  }
  const tls = sbTls(n);
  if (tls) o.tls = tls;
  const transport = sbTransport(n);
  if (transport) o.transport = transport;
  return o;
}

export function renderSingbox(nodes: ProxyNode[], rules: RulesMode, ruleSource: RuleSource = 'official'): string {
  const directNeeded = rules === 'cn' || nodes.length === 0;
  const selectorOutbounds = [...nodes.map((n) => n.name), ...(directNeeded ? ['direct'] : [])];
  const config: Record<string, unknown> = {
    log: { level: 'info', timestamp: true },
    inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 7890 }],
    outbounds: [{ type: 'selector', tag: 'PROXY', outbounds: selectorOutbounds }, ...nodes.map(singboxOutbound), ...(directNeeded ? [{ type: 'direct', tag: 'direct' }] : [])],
    route: { auto_detect_interface: true, final: 'PROXY' },
  };
  if (rules === 'cn') {
    const urls = RULE_SET_URLS[ruleSource];
    config.route = {
      auto_detect_interface: true,
      final: 'PROXY',
      rules: [
        { action: 'route', outbound: 'direct', ip_is_private: true },
        { action: 'route', outbound: 'direct', rule_set: ['geosite-cn'] },
        { action: 'route', outbound: 'direct', rule_set: ['geoip-cn'] },
      ],
      rule_set: [
        { type: 'remote', tag: 'geosite-cn', format: 'binary', url: urls['geosite-cn'], download_detour: 'direct' },
        { type: 'remote', tag: 'geoip-cn', format: 'binary', url: urls['geoip-cn'], download_detour: 'direct' },
      ],
    };
  }
  return JSON.stringify(config, null, 2);
}

// ---------- URI / base64 ----------

function hostPort(n: ProxyNode): string {
  const host = n.server.includes(':') ? `[${n.server}]` : n.server;
  return `${host}:${n.port}`;
}

function nodeUri(n: ProxyNode): string {
  const name = encodeURIComponent(n.name);
  if (n.type === 'ss') {
    const userinfo = b64urlEncode(`${n.cipher || 'aes-128-gcm'}:${n.password || ''}`);
    const q = new URLSearchParams();
    if (n.ssPlugin === 'obfs') {
      q.set('plugin', `obfs-local;obfs=${n.ssPluginMode || 'http'}${n.ssPluginHost ? `;obfs-host=${n.ssPluginHost}` : ''}`);
    }
    return `ss://${userinfo}@${hostPort(n)}${q.size ? `?${q}` : ''}#${name}`;
  }
  if (n.type === 'vmess') {
    const j = {
      v: '2',
      ps: n.name,
      add: n.server,
      port: String(n.port),
      id: n.uuid || '',
      aid: String(n.alterId ?? 0),
      scy: n.encryption || 'auto',
      net: n.network || 'tcp',
      type: '',
      host: n.wsHost || '',
      path: n.wsPath || '',
      tls: n.tls || n.reality ? 'tls' : '',
      sni: n.sni || '',
      alpn: (n.alpn || []).join(','),
      fp: n.fp || '',
    };
    return `vmess://${b64encode(JSON.stringify(j))}`;
  }
  const q = new URLSearchParams();
  if (n.type === 'vless') {
    q.set('encryption', 'none');
    q.set('security', n.reality ? 'reality' : n.tls ? 'tls' : 'none');
    if (n.sni) q.set('sni', n.sni);
    if (n.fp) q.set('fp', n.fp);
    if (n.reality) {
      q.set('pbk', n.pbk || '');
      if (n.sid) q.set('sid', n.sid);
    }
    if (n.flow) q.set('flow', n.flow);
  } else if (n.type === 'trojan') {
    if (n.sni) q.set('sni', n.sni);
  } else if (n.type === 'hysteria2') {
    if (n.sni) q.set('sni', n.sni);
    if (n.insecure) q.set('insecure', '1');
    if (n.hy2Obfs) {
      q.set('obfs', 'salamander');
      q.set('obfs-password', n.hy2ObfsPassword || '');
    }
    if (n.upMbps) q.set('upmbps', String(n.upMbps));
    if (n.downMbps) q.set('downmbps', String(n.downMbps));
  } else if (n.type === 'tuic') {
    if (n.sni) q.set('sni', n.sni);
    if (n.congestion) q.set('congestion_control', n.congestion);
    if (n.udpRelay) q.set('udp_relay_mode', n.udpRelay);
  }
  if ((n.type === 'vless' || n.type === 'trojan') && n.insecure) q.set('allowInsecure', '1');
  if (n.type === 'tuic' && n.insecure) q.set('allow_insecure', '1');
  q.set('type', n.network || 'tcp');
  if (n.wsPath) q.set('path', n.wsPath);
  if (n.wsHost) q.set('host', n.wsHost);
  if (n.network === 'grpc' && n.serviceName) q.set('serviceName', n.serviceName);
  if (n.alpn?.length) q.set('alpn', n.alpn.join(','));
  const scheme = n.type === 'hysteria2' ? 'hy2' : n.type;
  // vless 凭据只有 uuid；tuic 为 uuid:password；其余为 password
  const cred = n.type === 'vless' ? n.uuid || '' : n.type === 'tuic' ? `${n.uuid}:${encodeURIComponent(n.password || '')}` : encodeURIComponent(n.password || '');
  return `${scheme}://${cred}@${hostPort(n)}?${q}#${name}`;
}

export function renderUri(nodes: ProxyNode[]): string {
  return nodes.map(nodeUri).join('\n');
}

export function renderBase64(nodes: ProxyNode[]): string {
  return b64encode(renderUri(nodes));
}
