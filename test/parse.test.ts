import { describe, expect, it } from 'vitest';
import { parseNodeUri, parseSubscription, type ProxyNode } from '../src/parse';
import { b64encode, b64urlEncode } from '../src/auth';

// ---- 可复现样例：各协议标准 URI ----

describe('URI 解析', () => {
  it('ss SIP002（base64url 凭据 + 名称转义）', () => {
    const uri = `ss://${b64urlEncode('aes-256-gcm:pa:ss:word')}@1.2.3.4:8388#HK%2001`;
    expect(parseNodeUri(uri)).toEqual({
      name: 'HK 01',
      type: 'ss',
      server: '1.2.3.4',
      port: 8388,
      cipher: 'aes-256-gcm',
      password: 'pa:ss:word',
    });
  });

  it('ss 明文凭据（SIP002 2022 系）', () => {
    const uri = `ss://2022-blake3-aes-256-gcm:${encodeURIComponent('abc==def')}@[2001:db8::1]:443#V2`;
    const n = parseNodeUri(uri);
    expect(n.cipher).toBe('2022-blake3-aes-256-gcm');
    expect(n.password).toBe('abc==def');
    expect(n.server).toBe('2001:db8::1');
    expect(n.port).toBe(443);
  });

  it('ss 旧格式（整体 base64）', () => {
    const uri = `ss://${b64encode('aes-128-gcm:pw@5.6.7.8:1234')}` + '#old';
    const n = parseNodeUri(uri);
    expect(n).toMatchObject({ type: 'ss', server: '5.6.7.8', port: 1234, cipher: 'aes-128-gcm', password: 'pw', name: 'old' });
  });

  it('ss obfs plugin', () => {
    const uri = `ss://${b64urlEncode('aes-256-gcm:pw')}@a.com:443?plugin=${encodeURIComponent('obfs-local;obfs=http;obfs-host=fake.com')}#OB`;
    expect(parseNodeUri(uri)).toMatchObject({ ssPlugin: 'obfs', ssPluginMode: 'http', ssPluginHost: 'fake.com' });
  });

  it('ss v2ray-plugin 明确跳过', () => {
    const uri = `ss://${b64urlEncode('aes-256-gcm:pw')}@a.com:443?plugin=v2ray-plugin%3Bmode%3Dwebsocket#X`;
    expect(() => parseNodeUri(uri)).toThrow(/v2ray-plugin/);
  });

  it('vmess（v2rayN JSON）ws + tls', () => {
    const j = { v: '2', ps: 'VM 节点', add: 'b.com', port: '443', id: 'u1', aid: '0', scy: 'auto', net: 'ws', type: '', host: 'b.com', path: '/ws', tls: 'tls', sni: 'b.com' };
    const n = parseNodeUri(`vmess://${b64encode(JSON.stringify(j))}`);
    expect(n).toEqual({
      name: 'VM 节点',
      type: 'vmess',
      server: 'b.com',
      port: 443,
      uuid: 'u1',
      alterId: 0,
      encryption: 'auto',
      network: 'ws',
      tls: true,
      sni: 'b.com',
      wsPath: '/ws',
      wsHost: 'b.com',
    });
  });

  it('vmess http 伪装跳过', () => {
    const j = { v: '2', ps: 'x', add: 'b.com', port: '80', id: 'u1', net: 'tcp', type: 'http' };
    expect(() => parseNodeUri(`vmess://${b64encode(JSON.stringify(j))}`)).toThrow(/http 伪装/);
  });

  it('vmess net=http（Xray 风格 JSON）按 h2 处理', () => {
    const j = { v: '2', ps: 'x', add: 'b.com', port: '443', id: 'u1', net: 'http', host: 'b.com', path: '/h2' };
    const n = parseNodeUri(`vmess://${b64encode(JSON.stringify(j))}`);
    expect(n.network).toBe('h2');
    expect(n.wsPath).toBe('/h2');
    expect(n.wsHost).toBe('b.com');
  });

  it('vless reality + ws', () => {
    const uri =
      'vless://11111111-2222-3333-4444-555555555555@c.com:443?encryption=none&security=reality&sni=c.com&fp=chrome&pbk=PBKKEY&sid=abcd&flow=xtls-rprx-vision&type=ws&path=%2Fws&host=c.com#V%2FR';
    const n = parseNodeUri(uri);
    expect(n).toEqual({
      name: 'V/R',
      type: 'vless',
      server: 'c.com',
      port: 443,
      uuid: '11111111-2222-3333-4444-555555555555',
      encryption: 'none',
      network: 'ws',
      tls: true,
      reality: true,
      pbk: 'PBKKEY',
      sid: 'abcd',
      sni: 'c.com',
      fp: 'chrome',
      flow: 'xtls-rprx-vision',
      wsPath: '/ws',
      wsHost: 'c.com',
    });
  });

  it('vless 非法 encryption 拒绝', () => {
    expect(() => parseNodeUri('vless://u@c.com:443?encryption=aes-128-gcm#x')).toThrow(/encryption/);
  });

  it('trojan ws', () => {
    const n = parseNodeUri('trojan://pw%40rd@d.com:443?type=ws&path=%2Ft&host=d.com&allowInsecure=1&peer=d.com#T');
    expect(n).toMatchObject({
      type: 'trojan',
      server: 'd.com',
      port: 443,
      password: 'pw@rd',
      tls: true,
      network: 'ws',
      wsPath: '/t',
      wsHost: 'd.com',
      insecure: true,
      sni: 'd.com',
    });
  });

  it('hysteria2 带 salamander 混淆与端口范围（取主端口）', () => {
    const n = parseNodeUri('hy2://hp@e.com:443,20000-30000?sni=e.com&insecure=1&obfs=salamander&obfs-password=op&upmbps=30&downmbps=200#H');
    expect(n).toEqual({
      name: 'H',
      type: 'hysteria2',
      server: 'e.com',
      port: 443,
      password: 'hp',
      tls: true,
      sni: 'e.com',
      insecure: true,
      hy2Obfs: 'salamander',
      hy2ObfsPassword: 'op',
      upMbps: 30,
      downMbps: 200,
    });
  });

  it('tuic', () => {
    const n = parseNodeUri('tuic://u3:tp3@f.com:443?sni=f.com&alpn=h3&congestion_control=bbr&udp_relay_mode=native#TU');
    expect(n).toEqual({
      name: 'TU',
      type: 'tuic',
      server: 'f.com',
      port: 443,
      uuid: 'u3',
      password: 'tp3',
      tls: true,
      sni: 'f.com',
      alpn: ['h3'],
      congestion: 'bbr',
      udpRelay: 'native',
    });
  });

  it('未知协议抛出原因', () => {
    expect(() => parseNodeUri('snell://x')).toThrow(/snell/);
  });
});

// ---- 可复现样例：整份订阅内容 ----

describe('订阅内容解析', () => {
  const ssUri = `ss://${b64urlEncode('aes-256-gcm:pw')}@1.2.3.4:8388#SS1`;
  const trojanUri = 'trojan://tp@5.6.7.8:443?sni=t.com#TJ1';

  it('base64 订阅（v2rayN 系 UA 常见返回）', () => {
    const r = parseSubscription(b64encode([ssUri, trojanUri].join('\n')));
    expect(r.nodes).toHaveLength(2);
    expect(r.nodes[0]).toMatchObject({ type: 'ss', name: 'SS1' });
    expect(r.nodes[1]).toMatchObject({ type: 'trojan', name: 'TJ1' });
    expect(r.skipped).toEqual([]);
  });

  it('明文 URI 订阅，坏行进入 skipped', () => {
    const r = parseSubscription([ssUri, 'snell://bad', '', trojanUri].join('\n'));
    expect(r.nodes).toHaveLength(2);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).toContain('snell');
  });

  it('sing-box JSON：内置 outbound 忽略，未知类型跳过', () => {
    const obj = {
      outbounds: [
        { type: 'direct', tag: 'direct' },
        { type: 'vless', tag: 'V-示例', server: 'c.com', server_port: 443, uuid: 'u2', flow: 'xtls-rprx-vision',
          tls: { enabled: true, server_name: 'c.com', utls: { enabled: true, fingerprint: 'chrome' },
            reality: { enabled: true, public_key: 'PBK', short_id: 'abcd' } } },
        { type: 'ss', tag: 'S-示例', server: '1.2.3.4', server_port: 8388, method: 'aes-256-gcm', password: 'pw' },
        { type: 'snell', tag: 'X', server: 'x.com', server_port: 1, psk: 'k' },
      ],
    };
    const r = parseSubscription(JSON.stringify(obj));
    expect(r.nodes).toHaveLength(2);
    expect(r.nodes[0]).toEqual({
      name: 'V-示例', type: 'vless', server: 'c.com', port: 443, uuid: 'u2', encryption: 'none', network: 'tcp',
      flow: 'xtls-rprx-vision', tls: true, reality: true, pbk: 'PBK', sid: 'abcd', sni: 'c.com', fp: 'chrome',
    });
    expect(r.nodes[1]).toMatchObject({ type: 'ss', cipher: 'aes-256-gcm', password: 'pw' });
    expect(r.skipped).toEqual(['X：不支持的协议 snell']);
  });

  it('sing-box JSON：vmess/hysteria2/tuic 映射', () => {
    const obj = {
      outbounds: [
        { type: 'vmess', tag: 'VM', server: 'b.com', server_port: 443, uuid: 'u1', security: 'auto', alter_id: 0,
          tls: { enabled: true, server_name: 'b.com' }, transport: { type: 'ws', path: '/ws', headers: { Host: 'b.com' } } },
        { type: 'hysteria2', tag: 'HY', server: 'e.com', server_port: 443, password: 'hp', up_mbps: 30, down_mbps: 200,
          obfs: { type: 'salamander', password: 'op' }, tls: { enabled: true, server_name: 'e.com', insecure: true } },
        { type: 'tuic', tag: 'TU', server: 'f.com', server_port: 443, uuid: 'u3', password: 'tp3',
          congestion_control: 'bbr', udp_relay_mode: 'native', tls: { enabled: true, server_name: 'f.com', alpn: ['h3'] } },
      ],
    };
    const r = parseSubscription(JSON.stringify(obj));
    expect(r.nodes).toHaveLength(3);
    expect(r.nodes[0]).toMatchObject({ type: 'vmess', uuid: 'u1', alterId: 0, encryption: 'auto', network: 'ws', wsPath: '/ws', wsHost: 'b.com', tls: true });
    expect(r.nodes[1]).toMatchObject({ type: 'hysteria2', hy2Obfs: 'salamander', hy2ObfsPassword: 'op', upMbps: 30, downMbps: 200, insecure: true });
    expect(r.nodes[2]).toMatchObject({ type: 'tuic', congestion: 'bbr', udpRelay: 'native', alpn: ['h3'] });
  });

  it('Clash YAML：块式配置映射正确，未知类型跳过', () => {
    const r = parseSubscription(clashSample);
    expect(r.nodes).toHaveLength(3);
    expect(r.nodes[0]).toEqual({
      name: 'SS-示例', type: 'ss', server: '1.2.3.4', port: 8388, cipher: 'aes-256-gcm', password: 'pw',
      ssPlugin: 'obfs', ssPluginMode: 'http', ssPluginHost: 'example.com',
    });
    expect(r.nodes[1]).toEqual({
      name: 'VM-示例', type: 'vmess', server: 'b.com', port: 443, uuid: '11111111-2222-3333-4444-555555555555',
      alterId: 0, encryption: 'auto', network: 'ws', tls: true, sni: 'b.com', wsPath: '/ws', wsHost: 'b.com',
    });
    expect(r.nodes[2]).toEqual({
      name: 'HY2-示例', type: 'hysteria2', server: 'e.com', port: 443, password: 'hp', tls: true,
      hy2Obfs: 'salamander', hy2ObfsPassword: 'op', upMbps: 30, downMbps: 200, sni: 'e.com',
    });
    expect(r.skipped).toEqual(['SNELL-示例：不支持的协议 snell']);
  });

  it('Clash YAML：行内 flow、嵌套 flow、引号转义与注释', () => {
    const yaml = [
      'port: 7890 # 注释',
      'proxies:',
      '  - {name: "F-01", type: ss, server: 1.2.3.4, port: 8388, cipher: "aes-256-gcm", password: "p@ss \\"q\\" d", udp: true}',
      '  - name: F-02',
      '    type: vmess',
      '    server: b.com',
      '    port: 443',
      '    uuid: u1',
      '    alterId: 0',
      '    cipher: auto',
      '    tls: true',
      '    network: ws',
      '    ws-opts: { path: /ws, headers: { Host: b.com } }',
      "    servername: 'it''s #not-comment'",
      '    alpn: [h3, h2]',
    ].join('\n');
    const r = parseSubscription(yaml);
    expect(r.skipped).toEqual([]);
    expect(r.nodes[0]).toEqual({ name: 'F-01', type: 'ss', server: '1.2.3.4', port: 8388, cipher: 'aes-256-gcm', password: 'p@ss "q" d' });
    expect(r.nodes[1]).toEqual({
      name: 'F-02', type: 'vmess', server: 'b.com', port: 443, uuid: 'u1', alterId: 0, encryption: 'auto',
      network: 'ws', tls: true, wsPath: '/ws', wsHost: 'b.com', sni: "it's #not-comment", alpn: ['h3', 'h2'],
    });
  });

  it('Clash YAML：proxies 单行 flow 顶层', () => {
    const r = parseSubscription("proxies: [{name: 'S1', type: ss, server: s.com, port: 443, cipher: aes-128-gcm, password: pw}] # tail");
    expect(r.nodes).toEqual([{ name: 'S1', type: 'ss', server: 's.com', port: 443, cipher: 'aes-128-gcm', password: 'pw' }]);
  });

  it('Clash YAML：超过节点上限截断并提示', () => {
    const many = Array.from(
      { length: 305 },
      (_, i) => `  - name: n${i}\n    type: ss\n    server: ${i}.com\n    port: 443\n    cipher: aes-128-gcm\n    password: p`
    ).join('\n');
    const r = parseSubscription(`proxies:\n${many}\nrules:\n  - MATCH,DIRECT`);
    expect(r.nodes).toHaveLength(300);
    expect(r.skipped.some((s) => s.includes('截断'))).toBe(true);
  });

  it('Clash YAML：超大输入截断', () => {
    const big = `port: 7890\n# ${'x'.repeat(300 * 1024)}\nproxies:\n  - name: a\n    type: ss\n    server: 1.1.1.1\n    port: 1\n    cipher: c\n    password: p`;
    const r = parseSubscription(big);
    expect(r.nodes).toEqual([]);
    expect(r.skipped[0]).toContain('截断');
  });

  it('无法识别的内容', () => {
    expect(parseSubscription('hello world !!').skipped[0]).toContain('无法识别');
    expect(parseSubscription('').nodes).toEqual([]);
  });
});

const clashSample = `
port: 7890
proxies:
  - name: "SS-示例"
    type: ss
    server: 1.2.3.4
    port: 8388
    cipher: aes-256-gcm
    password: "pw"
    plugin: obfs
    plugin-opts:
      mode: http
      host: example.com
  - name: "VM-示例"
    type: vmess
    server: b.com
    port: 443
    uuid: 11111111-2222-3333-4444-555555555555
    alterId: 0
    cipher: auto
    tls: true
    servername: b.com
    network: ws
    ws-opts:
      path: /ws
      headers:
        Host: b.com
  - name: "HY2-示例"
    type: hysteria2
    server: e.com
    port: 443
    password: hp
    obfs: salamander
    obfs-password: op
    up: "30 Mbps"
    down: 200
    sni: e.com
  - name: "SNELL-示例"
    type: snell
    server: x.com
    port: 1000
    psk: key
`;

// 类型收尾引用，避免 unused import
export type { ProxyNode };
