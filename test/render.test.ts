import { describe, expect, it } from 'vitest';
import { parse as yamlParse } from 'yaml';
import { parseNodeUri, parseSubscription, type ProxyNode } from '../src/parse';
import { b64decode } from '../src/auth';
import { renderBase64, renderClash, renderSingbox, renderUri } from '../src/render';

const fixtures: ProxyNode[] = [
  { name: 'SS-基础', type: 'ss', server: '1.2.3.4', port: 8388, cipher: 'aes-256-gcm', password: 'p@ss:-word' },
  { name: 'SS-OBFS', type: 'ss', server: 'a.com', port: 443, cipher: 'aes-128-gcm', password: 'pw', ssPlugin: 'obfs', ssPluginMode: 'http', ssPluginHost: 'a.com' },
  { name: 'VM-WS', type: 'vmess', server: 'b.com', port: 443, uuid: 'u1', alterId: 0, encryption: 'auto', network: 'ws', tls: true, sni: 'b.com', wsPath: '/ws', wsHost: 'b.com' },
  { name: 'VLESS-Reality', type: 'vless', server: 'c.com', port: 443, uuid: 'u2', encryption: 'none', network: 'tcp', tls: true, reality: true, pbk: 'PBK', sid: 'abcd', sni: 'c.com', fp: 'chrome', flow: 'xtls-rprx-vision' },
  { name: 'TROJAN-WS', type: 'trojan', server: 'd.com', port: 443, password: 'tp', tls: true, network: 'ws', wsPath: '/t', wsHost: 'd.com', insecure: true },
  { name: 'HY2-OBFS', type: 'hysteria2', server: 'e.com', port: 443, password: 'hp', tls: true, hy2Obfs: 'salamander', hy2ObfsPassword: 'op', upMbps: 30, downMbps: 200, sni: 'e.com' },
  { name: 'TUIC', type: 'tuic', server: 'f.com', port: 443, uuid: 'u3', password: 'tp3', tls: true, congestion: 'bbr', udpRelay: 'native', sni: 'f.com', alpn: ['h3'] },
];

describe('renderUri ↔ parse 往返', () => {
  it('每种协议 URI 往返后与原模型一致', () => {
    for (const f of fixtures) {
      const uri = renderUri([f]);
      const back = parseNodeUri(uri);
      expect(back, `往返失败：${f.name} → ${uri}`).toEqual(f);
    }
  });
});

describe('renderClash', () => {
  it('YAML 可解析且字段与模型一致', () => {
    const text = renderClash(fixtures, 'none');
    const doc = yamlParse(text) as any;
    expect(doc['mixed-port']).toBe(7890);
    expect(doc.proxies).toHaveLength(fixtures.length);
    const byName = Object.fromEntries(doc.proxies.map((p: any) => [p.name, p]));
    expect(byName['SS-基础']).toMatchObject({ type: 'ss', server: '1.2.3.4', port: 8388, cipher: 'aes-256-gcm', password: 'p@ss:-word', udp: true });
    expect(byName['SS-OBFS']).toMatchObject({ plugin: 'obfs', 'plugin-opts': { mode: 'http', host: 'a.com' } });
    expect(byName['VM-WS']).toMatchObject({ uuid: 'u1', alterId: 0, cipher: 'auto', tls: true, servername: 'b.com', network: 'ws', 'ws-opts': { path: '/ws', headers: { Host: 'b.com' } } });
    expect(byName['VLESS-Reality']).toMatchObject({ uuid: 'u2', flow: 'xtls-rprx-vision', 'reality-opts': { 'public-key': 'PBK', 'short-id': 'abcd' }, 'client-fingerprint': 'chrome' });
    expect(byName['TROJAN-WS']).toMatchObject({ password: 'tp', 'skip-cert-verify': true, 'ws-opts': { path: '/t', headers: { Host: 'd.com' } } });
    expect(byName['HY2-OBFS']).toMatchObject({ obfs: 'salamander', 'obfs-password': 'op', up: 30, down: 200 });
    expect(byName['TUIC']).toMatchObject({ 'congestion-controller': 'bbr', 'udp-relay-mode': 'native', alpn: ['h3'] });
    expect(doc['proxy-groups']).toEqual([{ name: 'PROXY', type: 'select', proxies: fixtures.map((f) => f.name) }]);
  });

  it('仅输出节点与单一 PROXY 组，不透传机场配置', () => {
    const text = renderClash(fixtures, 'none');
    expect(text).toContain('- MATCH,PROXY');
    expect(text).not.toMatch(/GEOSITE|GEOIP/);
  });

  it('rules=cn 绕华最小规则', () => {
    const text = renderClash(fixtures, 'cn');
    expect(text).toContain('- GEOIP,PRIVATE,DIRECT,no-resolve');
    expect(text).toContain('- GEOSITE,CN,DIRECT');
    expect(text).toContain('- GEOIP,CN,DIRECT');
    expect(text).toContain('- MATCH,PROXY');
  });

  it('空节点时仍生成合法配置', () => {
    const doc = yamlParse(renderClash([], 'cn')) as any;
    expect(doc.proxies).toEqual([]);
    expect(doc['proxy-groups'][0].proxies).toContain('DIRECT');
  });

  it('Clash 输出再解析与原模型一致', () => {
    const text = renderClash(fixtures, 'none');
    const r = parseSubscription(text);
    expect(r.skipped).toEqual([]);
    expect(r.nodes).toEqual(fixtures);
  });
});

describe('renderSingbox', () => {
  it('最小配置：mixed 入站 + PROXY 选择器 + 节点', () => {
    const cfg = JSON.parse(renderSingbox(fixtures, 'none'));
    expect(cfg.inbounds[0]).toMatchObject({ type: 'mixed', listen_port: 7890 });
    expect(cfg.outbounds[0]).toEqual({ type: 'selector', tag: 'PROXY', outbounds: fixtures.map((f) => f.name) });
    expect(cfg.route).toMatchObject({ final: 'PROXY' });
    expect(cfg.outbounds.filter((o: any) => o.type === 'direct')).toHaveLength(0);
    const byTag = Object.fromEntries(cfg.outbounds.slice(1).map((o: any) => [o.tag, o]));
    expect(byTag['SS-基础']).toMatchObject({ method: 'aes-256-gcm', password: 'p@ss:-word', server_port: 8388 });
    expect(byTag['VM-WS']).toMatchObject({ uuid: 'u1', security: 'auto', alter_id: 0, tls: { enabled: true, server_name: 'b.com' }, transport: { type: 'ws', path: '/ws', headers: { Host: 'b.com' } } });
    expect(byTag['VLESS-Reality']).toMatchObject({ flow: 'xtls-rprx-vision', tls: { reality: { enabled: true, public_key: 'PBK', short_id: 'abcd' }, utls: { fingerprint: 'chrome' } } });
    expect(byTag['HY2-OBFS']).toMatchObject({ obfs: { type: 'salamander', password: 'op' }, up_mbps: 30, down_mbps: 200 });
    expect(byTag['TUIC']).toMatchObject({ congestion_control: 'bbr', udp_relay_mode: 'native', tls: { alpn: ['h3'] } });
  });

  it('rules=cn 引用远程 rule_set，可切换 jsDelivr 镜像', () => {
    const official = JSON.parse(renderSingbox(fixtures, 'cn', 'official'));
    expect(official.route.rules).toEqual([
      { action: 'route', outbound: 'direct', ip_is_private: true },
      { action: 'route', outbound: 'direct', rule_set: ['geosite-cn'] },
      { action: 'route', outbound: 'direct', rule_set: ['geoip-cn'] },
    ]);
    expect(official.route.rule_set.map((r: any) => r.url)).toContain('https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs');
    expect(official.outbounds.some((o: any) => o.type === 'direct' && o.tag === 'direct')).toBe(true);

    const mirror = JSON.parse(renderSingbox(fixtures, 'cn', 'jsdelivr'));
    expect(mirror.route.rule_set.map((r: any) => r.url)).toContain('https://cdn.jsdelivr.net/gh/SagerNet/sing-geosite@rule-set/geosite-cn.srs');
  });

  it('sing-box 输出再解析与原模型一致', () => {
    const r = parseSubscription(renderSingbox(fixtures, 'none'));
    expect(r.skipped).toEqual([]);
    expect(r.nodes).toEqual(fixtures);
  });
});

describe('renderBase64 / renderUri', () => {
  it('base64 解码后等于 URI 输出（v2rayN 系可用）', () => {
    expect(b64decode(renderBase64(fixtures))).toBe(renderUri(fixtures));
  });

  it('URI 输出包含各协议 scheme', () => {
    const uris = renderUri(fixtures);
    expect(uris).toMatch(/^ss:\/\//m);
    expect(uris).toMatch(/^vmess:\/\//m);
    expect(uris).toMatch(/^vless:\/\//m);
    expect(uris).toMatch(/^trojan:\/\//m);
    expect(uris).toMatch(/^hy2:\/\//m);
    expect(uris).toMatch(/^tuic:\/\//m);
  });
});
