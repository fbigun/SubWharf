// RFC 6238 验证码生成器（测试侧预言机）：按当前时间算 6 位码，供登录/绑定用例造合法验证码。
import { base32Decode } from '../../src/auth';

export async function totpCode(secret: string, nowMs = Date.now(), periodSec = 30): Promise<string> {
  const counter = Math.floor(nowMs / 1000 / periodSec);
  const key = await crypto.subtle.importKey('raw', base32Decode(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, [
    'sign',
  ]);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off = mac[mac.length - 1] & 0x0f;
  const code = (((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3]) % 1_000_000;
  return code.toString().padStart(6, '0');
}
