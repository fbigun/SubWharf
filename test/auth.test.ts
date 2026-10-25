import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  b64decode,
  b64encode,
  clearSessionCookie,
  createSession,
  generateTotpSecret,
  getSessionId,
  hashPassword,
  sessionCookie,
  unwrapField,
  verifyPassword,
  verifyTotp,
  wrapField,
} from '../src/auth';

describe('编码工具', () => {
  it('base64 UTF-8 往返（含中文与 emoji）', () => {
    const s = 'aes-256-gcm:密码🚀';
    expect(b64decode(b64encode(s))).toBe(s);
  });

  it('base32 往返', () => {
    const buf = new Uint8Array([0, 1, 2, 250, 251, 255, 77]);
    expect([...base32Decode(base32Encode(buf))]).toEqual([...buf]);
  });

  it('base32 RFC 4648 向量（TOTP 密钥惯例不带 padding）', () => {
    expect(base32Encode(new TextEncoder().encode('foobar'))).toBe('MZXW6YTBOI');
  });
});

describe('TOTP', () => {
  // RFC 6238 附录 B 测试密钥 "12345678901234567890"（SHA-1）
  const secret = base32Encode(new TextEncoder().encode('12345678901234567890'));

  it('T=59s 的 6 位验证码为 287082', async () => {
    expect(await verifyTotp(secret, '287082', 0, 59_000)).toBe(true);
  });

  it('T=1111111109s 的 6 位验证码为 081804', async () => {
    expect(await verifyTotp(secret, '081804', 0, 1111111109_000)).toBe(true);
  });

  it('错误码与时窗外拒绝', async () => {
    expect(await verifyTotp(secret, '000000', 0, 59_000)).toBe(false);
    expect(await verifyTotp(secret, '287082', 0, 5 * 60_000)).toBe(false); // 5 分钟后，时窗外
  });

  it('随机密钥格式合法', () => {
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });
});

describe('密码哈希', () => {
  it('哈希与校验', async () => {
    const h = await hashPassword('secret-pass');
    expect(h).toMatch(/^pbkdf2\$/);
    expect(await verifyPassword('secret-pass', h)).toBe(true);
    expect(await verifyPassword('wrong-pass', h)).toBe(false);
  });

  it('相同密码每次盐不同', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });
});

describe('无状态会话', () => {
  const KEY = 'test-session-key';
  const reqWithCookie = (v: string) => new Request('https://x/', { headers: { Cookie: `sw_sess=${v}` } });

  it('签发后验签通过（不依赖任何存储）', async () => {
    const value = await createSession(KEY);
    expect(value).toMatch(/^[0-9a-f]{48}\.\d+\.[0-9a-f]{32}$/);
    expect(await getSessionId(KEY, reqWithCookie(value))).toMatch(/^[0-9a-f]{48}$/);
  });

  it('无 Cookie / 篡改签名 / 篡改时间戳均拒绝', async () => {
    expect(await getSessionId(KEY, new Request('https://x/'))).toBeNull();
    const value = await createSession(KEY);
    const [sid, ts, sig] = value.split('.');
    expect(await getSessionId(KEY, reqWithCookie(`${sid}.${ts}.deadbeef`))).toBeNull();
    expect(await getSessionId(KEY, reqWithCookie(`${sid}.${Number(ts) + 1}.${sig}`))).toBeNull();
    expect(await getSessionId(KEY, reqWithCookie(`garbage`))).toBeNull();
  });

  it('换密钥后旧会话失效（secrets 轮换即全员下线）', async () => {
    const value = await createSession(KEY);
    expect(await getSessionId('another-key', reqWithCookie(value))).toBeNull();
  });

  it('Cookie 头含过期与安全属性', () => {
    expect(sessionCookie('abc')).toBe('sw_sess=abc; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800');
    expect(clearSessionCookie()).toContain('Max-Age=0');
  });
});

describe('AES-GCM 字段加密', () => {
  const env = { WRAP_KEY: 'test-wrap-key' } as any;

  it('加解密往返', async () => {
    const plain = 'https://sub.example.com/token?sensitive=1';
    const wrapped = await wrapField(env, plain);
    expect(wrapped).toMatch(/^v1\./);
    expect(wrapped).not.toContain('sensitive');
    expect(await unwrapField(env, wrapped)).toBe(plain);
  });

  it('换密钥后解不开', async () => {
    const wrapped = await wrapField(env, 'x');
    await expect(unwrapField({ WRAP_KEY: 'other-key' } as any, wrapped)).rejects.toThrow();
  });

  it('密文格式非法时抛错', async () => {
    await expect(unwrapField(env, 'v0.bad.bad')).rejects.toThrow();
  });
});
