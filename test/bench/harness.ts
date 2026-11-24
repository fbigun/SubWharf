// 微基准核心：区间采样 + 中位数。
// workerd 的 performance.now() 只有毫秒精度（本机实测 1ms 粒度），单次 op 在 0.1–3ms 量级
// 直接测就是一堆 0/1，故每个采样点内跑 batch 次再除以 batch，把分辨率提到微秒级。
// 输出单位统一 µs/op，方便和 10ms CPU 预算直接对账。

export interface BenchResult {
  name: string;
  /** 每采样点内重复次数 */
  batch: number;
  samples: number;
  p50Us: number;
  minUs: number;
  meanUs: number;
}

export interface BenchOptions {
  /** 固定 batch；缺省按首次试跑自动估算，使单采样点落在 2–15ms */
  batch?: number;
  samples?: number;
  warmup?: number;
}

const now = () => performance.now();

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];

const round2 = (v: number) => Math.round(v * 100) / 100;

function summarize(name: string, batch: number, sampleMs: number[]): BenchResult {
  const perOp = sampleMs.map((ms) => (ms * 1000) / batch).sort((a, b) => a - b);
  return {
    name,
    batch,
    samples: perOp.length,
    p50Us: round2(percentile(perOp, 0.5)),
    minUs: round2(perOp[0]),
    meanUs: round2(perOp.reduce((a, b) => a + b, 0) / perOp.length),
  };
}

/** 单次采样：执行 batch 次 op 的总耗时（ms） */
function runBatch(op: () => void, batch: number): number {
  const t0 = now();
  for (let i = 0; i < batch; i++) op();
  return now() - t0;
}

function estimateBatch(op: () => void): number {
  // 先单次试跑三次取最快值，避免首跑 JIT/冷缓存把 batch 估得过小
  let best = Infinity;
  for (let i = 0; i < 3; i++) best = Math.min(best, runBatch(op, 1));
  const targetMs = 4;
  return Math.max(1, Math.min(400, Math.round(targetMs / Math.max(best, 0.002))));
}

export function benchSync(name: string, op: () => void, opts: BenchOptions = {}): BenchResult {
  const warmup = opts.warmup ?? 3;
  const samples = opts.samples ?? 15;
  for (let i = 0; i < warmup; i++) op();
  const batch = opts.batch ?? estimateBatch(op);
  const sampleMs: number[] = [];
  for (let i = 0; i < samples; i++) sampleMs.push(runBatch(op, batch));
  return summarize(name, batch, sampleMs);
}

/** 异步基准：保留真实 await 语义（微任务/定时器），用于 KV 桩这类 I/O 侧测量 */
export async function benchAsync(name: string, op: () => Promise<void>, opts: BenchOptions = {}): Promise<BenchResult> {
  const warmup = opts.warmup ?? 2;
  const samples = opts.samples ?? (opts.batch ?? 1) > 1 ? 9 : 9;
  for (let i = 0; i < warmup; i++) await op();
  const batch = opts.batch ?? 1;
  const sampleMs: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t0 = now();
    for (let k = 0; k < batch; k++) await op();
    sampleMs.push(now() - t0);
  }
  return summarize(name, batch, sampleMs);
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const padL = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

/** 表格化打印：列宽按内容自适应，便于直接贴进文档 */
export function printTable(title: string, rows: BenchResult[], note?: string): void {
  const head = ['case', 'p50µs', 'minµs', 'meanµs', 'batch', 'samples'];
  const body = rows.map((r) => [r.name, r.p50Us.toFixed(2), r.minUs.toFixed(2), r.meanUs.toFixed(2), String(r.batch), String(r.samples)]);
  const all = [head, ...body];
  const widths = head.map((_, i) => Math.max(...all.map((row) => row[i].length)));
  const line = (row: string[]) => row.map((c, i) => (i === 0 ? pad(c, widths[i]) : padL(c, widths[i]))).join('  ');
  console.log(`\n### ${title}`);
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of body) console.log(line(row));
  if (note) console.log(note);
}

/** 简单汇总行：把多次测量换算成「一次请求内 N 个节点的总 µs」 */
export const totalUs = (r: BenchResult, times: number): string => (r.p50Us * times).toFixed(1);
