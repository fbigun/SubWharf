import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  b64decode,
  b64encode,
  b64ToBytes,
  b64urlDecode,
  b64urlEncode,
  bytesToB64,
  clearSessionCookie,
  createSession,
  generateTotpSecret,
  getSessionId,
  hashPassword,
  sessionCookie,
  timingSafeEqual,
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

// ---------- base64 分块实现 vs 逐字节参考实现的差分测试 ----------
// src/auth.ts 的 bytesToB64 / b64ToBytes 为省 CPU 改成了 8KB 分块（B64_CHUNK）。
// 下面两份是改造前的逐字节写法，作为参考实现长期留在用例里：谁再动分块逻辑，
// 「输出必须与逐字节实现逐字节一致」这条会当场打红。
//
// 为什么不只断言往返相等：编码端漏掉最后一块、解码端错位一格，往返都可能自洽，
// 但产物与参考实现不同——只有差分抓得住。

/** 参考实现：改造前的 bytesToB64（每字节一次字符串拼接） */
function refBytesToB64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/** 参考实现：改造前的 b64ToBytes（每字节一次 JS 回调） */
function refB64ToBytes(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** 参考实现版的 b64urlDecode：补 = 之后交给逐字节参考解码 */
function refB64urlToBytes(s: string): Uint8Array {
  let t = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  while (t.length % 4 !== 0) t += '=';
  return refB64ToBytes(t);
}

/** 构造确定性字节序列，不引用任何真实订阅内容 */
function seqBytes(n: number): Uint8Array {
  return new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
}

describe('base64 分块实现差分', () => {
  // 与 src/auth.ts 的 B64_CHUNK 对齐：边界前后各一才算覆盖到分块拼接的接缝
  const CHUNK = 8192;
  const corpus: { name: string; bytes: Uint8Array }[] = [
    { name: '空', bytes: new Uint8Array(0) },
    { name: '1 字节 0x00', bytes: new Uint8Array([0]) },
    { name: '1 字节 0xff', bytes: new Uint8Array([0xff]) },
    { name: '3 字节（btoa 无 padding）', bytes: seqBytes(3) },
    { name: `${CHUNK - 1} 字节（分块边界 - 1）`, bytes: seqBytes(CHUNK - 1) },
    { name: `${CHUNK} 字节（分块边界）`, bytes: seqBytes(CHUNK) },
    { name: `${CHUNK + 1} 字节（分块边界 + 1）`, bytes: seqBytes(CHUNK + 1) },
    { name: `${CHUNK * 2} 字节（两块整）`, bytes: seqBytes(CHUNK * 2) },
    { name: `${CHUNK * 2 + 1} 字节（两块 + 1）`, bytes: seqBytes(CHUNK * 2 + 1) },
    { name: '105KB', bytes: seqBytes(105 * 1024) },
    { name: '140KB', bytes: seqBytes(140 * 1024) },
    { name: `全 0（${CHUNK} 字节）`, bytes: new Uint8Array(CHUNK) },
    { name: `全 0xff（${CHUNK + 1} 字节）`, bytes: new Uint8Array(CHUNK + 1).fill(0xff) },
    { name: 'UTF-8 中文与 emoji', bytes: new TextEncoder().encode('aes-256-gcm:密码🚀 中文 café') },
  ];

  it('编码：分块实现与逐字节参考实现完全一致', () => {
    for (const { name, bytes } of corpus) {
      const got = bytesToB64(bytes);
      const want = refBytesToB64(bytes);
      expect(got, `编码不一致：${name}（${bytes.length} 字节）`).toBe(want);
      // 两份实现一起写错的可能性虽低，仍锁一遍格式合法
      expect(got, `编码产物不是合法 base64：${name}`).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    }
  });

  it('解码：分块实现与逐字节参考实现完全一致', () => {
    for (const { name, bytes } of corpus) {
      const b64 = refBytesToB64(bytes);
      const got = b64ToBytes(b64);
      expect([...got], `解码不一致：${name}（${b64.length} 字符）`).toEqual([...refB64ToBytes(b64)]);
      expect([...got], `解码结果不等于原文：${name}`).toEqual([...bytes]);
    }
  });

  it('带 byteOffset 的视图同样一致（subarray 分块不能被偏移带歪）', () => {
    const backing = seqBytes(CHUNK + 17);
    const views = [
      backing.subarray(8),
      backing.subarray(3, 3 + (CHUNK - 1)),
      backing.subarray(16, 16 + (CHUNK + 1)),
      backing.subarray(backing.length), // 空视图
    ];
    for (const view of views) {
      expect(bytesToB64(view), `视图编码不一致：len=${view.length}`).toBe(refBytesToB64(view));
      expect([...b64ToBytes(refBytesToB64(view))], `视图解码不一致：len=${view.length}`).toEqual([...refB64ToBytes(refBytesToB64(view))]);
    }
  });

  it('解码结果无 8 位截断（覆盖全部 256 个字节值）', () => {
    const all = new Uint8Array(256 * 33).map((_, i) => i & 0xff);
    const back = b64ToBytes(refBytesToB64(all));
    expect([...back]).toEqual([...all]);
    expect([...back]).toEqual([...refB64ToBytes(refBytesToB64(all))]);
    expect(bytesToB64(back)).toBe(refBytesToB64(all));
  });

  it('非 4 倍长度 base64（b64urlDecode 补 = 的路径）与参考实现一致', () => {
    // 去掉 padding 后长度 mod 4 可能为 2 或 3；atob 直接吃这种串也合法，
    // b64urlDecode 则是补 '=' 后调用 b64ToBytes——两条路径都过一遍差分。
    const sources = [
      'abcd', // 4 字节 → 无 padding 长度 mod 4 = 2
      'abcde', // 5 字节 → mod 4 = 3
      '中文🚀', // UTF-8 10 字节 → mod 4 = 2
      '中文🚀a', // UTF-8 11 字节 → mod 4 = 3
      new TextDecoder().decode(seqBytes(CHUNK - 1)), // 分块边界前的大输入走同一路径
    ];
    const mods = new Set<number>();
    for (const src of sources) {
      const unpadded = b64urlEncode(src).replace(/=+$/, '');
      const mod = unpadded.length % 4;
      expect([2, 3], `语料未覆盖 mod 2/3：${src.length} 字节 → mod ${mod}`).toContain(mod);
      mods.add(mod);
      // 路径 1：b64urlDecode 把 -/_ 换回 +// 并补 '=' 后解码
      expect(b64urlDecode(unpadded), `补 = 路径解码不一致：${src.length} 字节`).toBe(
        new TextDecoder().decode(refB64urlToBytes(unpadded))
      );
      // 路径 2：标准字母表、不带 '=' 的串直接喂 b64ToBytes（atob 正常接受 mod 4 = 2/3）
      const stdUnpadded = refBytesToB64(new TextEncoder().encode(src)).replace(/=+$/, '');
      expect([...b64ToBytes(stdUnpadded)], `未补 = 直接解码不一致：${src.length} 字节`).toEqual([...refB64ToBytes(stdUnpadded)]);
    }
    expect([...mods].sort()).toEqual([2, 3]);
  });

  it('非法输入：两份实现抛同样的错（不静默返回空）', () => {
    const bad = ['!!!!', 'a', 'AAAAA', '中文', '@@@@', 'AAAAAA=', 'AA==AA==', 'YWJj!!!'];
    const catchErr = (fn: () => unknown): Error | null => {
      try {
        fn();
        return null;
      } catch (e) {
        return e as Error;
      }
    };
    for (const s of bad) {
      const got = catchErr(() => b64ToBytes(s));
      const want = catchErr(() => refB64ToBytes(s));
      expect(got, `应抛错却没有抛：${JSON.stringify(s)}`).not.toBeNull();
      expect(want, `参考实现没有抛错（语料无效）：${JSON.stringify(s)}`).not.toBeNull();
      expect(got?.name, `错误类型不一致：${JSON.stringify(s)}`).toBe(want?.name);
      expect(got?.message, `错误消息不一致：${JSON.stringify(s)}`).toBe(want?.message);
    }
    // 空串是合法输入，不该被当成非法
    expect(b64ToBytes('').length).toBe(0);
    expect(bytesToB64(new Uint8Array(0))).toBe('');
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

describe('常数时间比较', () => {
  it('相等为 true，内容或长度不等为 false', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('中文🚀', '中文🚀')).toBe(true);
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
