// 基准专用配置：默认 `vitest run` 只抓 **/*.test.ts，看不到 *.bench.ts。
// 单独跑：npx vitest run --config vitest.bench.config.ts
// 基准不进 CI 全量测试（机器差异会误报），只做本地/手动回归。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/bench/**/*.bench.ts'],
    // 基准是纯计算/桩 I/O，不并发跑，避免 CPU 争抢污染测量
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: ['default'],
  },
});
