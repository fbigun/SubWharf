// 测试用 Env：KV / ASSETS 用桩，secrets 用固定值，其余保持与生产 Env 同形。
import type { Env } from '../../src/auth';
import { FakeAssets } from './assets';
import { FakeKV } from './kv';

export const TEST_SECRETS = {
  SESSION_KEY: 'test-session-key',
  WRAP_KEY: 'test-wrap-key',
  SETUP_CODE: 'test-setup-code',
} as const;

export interface TestEnv extends Env {
  kv: FakeKV;
  assets: FakeAssets;
}

export function makeEnv(seed: Record<string, unknown> = {}): TestEnv {
  const kv = new FakeKV(seed);
  const assets = new FakeAssets();
  return {
    KV: kv as unknown as KVNamespace,
    ASSETS: assets as unknown as Fetcher,
    ...TEST_SECRETS,
    kv,
    assets,
  };
}
