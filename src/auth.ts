// 认证与会话：PBKDF2 密码哈希、TOTP(RFC 6238)、AES-GCM 字段加密、KV 会话。
// base64/base32 等二进制编码工具也集中在此，供 parse / render 复用。

export interface Env {
  KV: KVNamespace;
  ASSETS: Fetcher;
  SESSION_KEY: string;
  WRAP_KEY: string;
  SETUP_CODE: string;
}

export interface Profile {
  passHash: string;
  totpEnc: string; // AES-GCM 加密的 base32 TOTP 密钥
  totpVerified: boolean;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- base64 / base32 ----------

export function bytesToB64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export function b64ToBytes(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export function b64encode(s: string): string {
  return bytesToB64(enc.encode(s));
}

export function b64decode(s: string): string {
  return dec.decode(b64ToBytes(s));
}

export function b64urlEncode(s: string): string {
  return b64encode(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): string {
  let t = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  while (t.length % 4 !== 0) t += '=';
  return b64decode(t);
}

export function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(b: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const x of b) {
    value = (value << 8) | x;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of s.toUpperCase().replace(/=+$/, '')) {
    const i = B32.indexOf(c);
    if (i === -1) throw new Error('非法 base32 字符');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// ---------- 密码 ----------

// 免费版 Worker 单次请求 CPU 限 10ms，PBKDF2 迭代数受此约束；付费版可上调
export const PBKDF2_ITERATIONS = 10_000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, salt?: Uint8Array): Promise<string> {
  const s = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, s, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToB64(s)}$${bytesToB64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterStr, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'pbkdf2' || !iterStr || !saltB64 || !hashB64) return false;
  const hash = await pbkdf2(password, b64ToBytes(saltB64), Number(iterStr));
  return bytesToB64(hash) === hashB64;
}

// ---------- TOTP ----------

export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export function otpauthUri(secret: string, account = 'admin'): string {
  return `otpauth://totp/SubWharf:${encodeURIComponent(account)}?secret=${secret}&issuer=SubWharf&algorithm=SHA1&digits=6&period=30`;
}

async function totpAt(secret: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', base32Decode(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off = mac[mac.length - 1] & 0x0f;
  const code = (((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3]) % 1_000_000;
  return code.toString().padStart(6, '0');
}

export async function verifyTotp(secret: string, code: string, window = 1, nowMs = Date.now()): Promise<boolean> {
  const c = code.trim();
  if (!/^\d{6}$/.test(c)) return false;
  const step = Math.floor(nowMs / 1000 / 30);
  for (let i = -window; i <= window; i++) {
    if ((await totpAt(secret, step + i)) === c) return true;
  }
  return false;
}

// ---------- AES-GCM 字段加密（WRAP_KEY）----------

let wrapKeyCache: { src: string; key: CryptoKey } | null = null;

async function wrapKey(env: Pick<Env, 'WRAP_KEY'>): Promise<CryptoKey> {
  if (wrapKeyCache && wrapKeyCache.src === env.WRAP_KEY) return wrapKeyCache.key;
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(env.WRAP_KEY));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  wrapKeyCache = { src: env.WRAP_KEY, key };
  return key;
}

/** 订阅 URL、TOTP 密钥等敏感字段落盘前加密 */
export async function wrapField(env: Pick<Env, 'WRAP_KEY'>, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await wrapKey(env), enc.encode(plain));
  return `v1.${bytesToB64(iv)}.${bytesToB64(new Uint8Array(ct))}`;
}

export async function unwrapField(env: Pick<Env, 'WRAP_KEY'>, wrapped: string): Promise<string> {
  const [v, ivB64, ctB64] = wrapped.split('.');
  if (v !== 'v1' || !ivB64 || !ctB64) throw new Error('密文格式非法');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(ivB64) as BufferSource }, await wrapKey(env), b64ToBytes(ctB64));
  return dec.decode(pt);
}

// ---------- 会话 ----------

const SESSION_COOKIE = 'sw_sess';
const SESSION_TTL = 7 * 24 * 3600; // 7 天

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)))).slice(0, 32);
}

function parseCookie(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.get('Cookie');
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** 生成会话并写入 KV，返回形如 "sid.签名" 的 Cookie 值 */
export async function createSession(env: Env): Promise<string> {
  const sid = hex(crypto.getRandomValues(new Uint8Array(24)));
  await env.KV.put(`sess:${sid}`, JSON.stringify({ createdAt: Date.now() }), { expirationTtl: SESSION_TTL });
  return `${sid}.${await hmacHex(env.SESSION_KEY, sid)}`;
}

export function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/** 校验 Cookie 签名并确认会话仍在 KV 中，返回 sid */
export async function getSessionId(env: Env, req: Request): Promise<string | null> {
  const value = parseCookie(req)[SESSION_COOKIE];
  if (!value) return null;
  const i = value.lastIndexOf('.');
  if (i <= 0) return null;
  const sid = value.slice(0, i);
  const sig = value.slice(i + 1);
  if ((await hmacHex(env.SESSION_KEY, sid)) !== sig) return null;
  return (await env.KV.get(`sess:${sid}`)) ? sid : null;
}

export async function destroySession(env: Env, req: Request): Promise<void> {
  const value = parseCookie(req)[SESSION_COOKIE];
  if (value) await env.KV.delete(`sess:${value.split('.')[0]}`);
}

// ---------- 登录限速（5 次失败锁 15 分钟）----------

interface LoginFail {
  count: number;
  lockedUntil?: number;
}

/** 返回剩余锁定秒数，0 表示未锁定 */
export async function loginLockRemaining(env: Env): Promise<number> {
  const f = await env.KV.get<LoginFail>('login:fail', 'json');
  if (f?.lockedUntil && Date.now() < f.lockedUntil) return Math.ceil((f.lockedUntil - Date.now()) / 1000);
  return 0;
}

export async function recordLoginFail(env: Env): Promise<void> {
  const f = (await env.KV.get<LoginFail>('login:fail', 'json')) ?? { count: 0 };
  f.count += 1;
  if (f.count >= 5) f.lockedUntil = Date.now() + 15 * 60_000;
  await env.KV.put('login:fail', JSON.stringify(f), { expirationTtl: 15 * 60 });
}

export async function clearLoginFail(env: Env): Promise<void> {
  await env.KV.delete('login:fail');
}
