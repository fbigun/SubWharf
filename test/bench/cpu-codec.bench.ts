// CPU 侧基准 · 编解码底噪：src/auth.ts 的 base64 实现被 parse/render 复用，是订阅链路上最底层也最热的一段。
//
// 现实现（src/auth.ts:28-36）：
//   bytesToB64: for (const x of b) s += String.fromCharCode(x)   —— 每字节一次字符串拼接
//   b64ToBytes: Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) —— 每字节一次回调
// 两者都是「每字节一个 JS 层操作」。本文件的「反事实」组用分块 String.fromCharCode.apply
// 与分块下标写回量化替代实现的收益，仅用于估算，未合入 src。
import { describe, it } from 'vitest';
import { b64decode, b64encode, b64ToBytes, bytesToB64 } from '../../src/auth';
import { benchSync, printTable, type BenchResult } from './harness';
import { b64Subscription, uriSubscription } from './fixtures';

const CHUNK = 8192;

/** 反事实 A：分块 String.fromCharCode.apply —— 避免逐字节字符串拼接 */
function bytesToB64Chunked(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += CHUNK) out += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + CHUNK, b.length)) as unknown as number[]);
  return btoa(out);
}

/** 反事实 B：分块下标写回 —— 避免 Uint8Array.from 的每字节回调 */
function b64ToBytesChunked(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bin.length);
    for (let j = i; j < end; j++) out[j] = bin.charCodeAt(j);
  }
  return out;
}

describe('bench/cpu-codec', () => {
  it('base64 编解码基线（现实现 vs 反事实分块）', () => {
    const plain500 = uriSubscription(500);
    const b64_500 = b64Subscription(500); // 140KB 量级，500 节点订阅的典型体积
    const plain100 = uriSubscription(100);
    const b64_100 = b64Subscription(100);
    const bytes500 = new TextEncoder().encode(plain500);
    const rows: BenchResult[] = [];

    rows.push(benchSync('b64ToBytes 140KB（现实现，500 节点订阅）', () => b64ToBytes(b64_500)));
    rows.push(benchSync('b64ToBytes 140KB（反事实：分块写回）', () => b64ToBytesChunked(b64_500)));
    rows.push(benchSync('b64ToBytes 28KB（现实现，100 节点订阅）', () => b64ToBytes(b64_100)));
    rows.push(benchSync('b64ToBytes 28KB（反事实：分块写回）', () => b64ToBytesChunked(b64_100)));
    rows.push(benchSync('bytesToB64 105KB（现实现）', () => bytesToB64(bytes500)));
    rows.push(benchSync('bytesToB64 105KB（反事实：分块 apply）', () => bytesToB64Chunked(bytes500)));
    rows.push(benchSync('b64encode 105KB（现实现 = encode + bytesToB64）', () => b64encode(plain500)));
    rows.push(benchSync('b64decode 140KB（现实现 = b64ToBytes + TextDecoder）', () => b64decode(b64_500)));

    printTable('cpu-codec（µs/op，node 本地，非 workerd）', rows);

    const cur = rows[0].p50Us;
    const alt = rows[1].p50Us;
    const encCur = rows[4].p50Us;
    const encAlt = rows[5].p50Us;
    console.log(
      [
        '',
        `解码 140KB：现实现 ${cur.toFixed(0)}µs → 分块 ${alt.toFixed(0)}µs，约 ${(cur / alt).toFixed(1)}× 差（省 ${(cur - alt).toFixed(0)}µs）`,
        `编码 105KB：现实现 ${encCur.toFixed(0)}µs → 分块 ${encAlt.toFixed(0)}µs，约 ${(encCur / encAlt).toFixed(1)}× 差（省 ${(encCur - encAlt).toFixed(0)}µs）`,
        '注意：反事实实现只改内存写入方式，输出字节完全一致（回归用 test/auth.test.ts 的编解码用例即可），风险主要是大数组 apply 的实参上限——分块 8KB 远低于引擎上限。',
      ].join('\n')
    );
  });
});
