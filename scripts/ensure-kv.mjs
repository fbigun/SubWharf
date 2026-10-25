// 幂等确保 KV namespace 存在，并把 id 回写 wrangler.jsonc（CI 与本地首次部署共用）。
// wrangler 认 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID 环境变量。
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const TITLE = 'KV';

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

function findNamespace() {
  const list = JSON.parse(run('npx wrangler kv namespace list --json'));
  return Array.isArray(list) ? list.find((ns) => ns.title === TITLE) : null;
}

let ns = findNamespace();
if (!ns) {
  console.log(`未找到 title 为 ${TITLE} 的 namespace，创建中…`);
  run('npx wrangler kv namespace create KV');
  ns = findNamespace();
}
if (!ns) throw new Error('KV namespace 创建后仍未找到，请检查凭据');

const cfg = readFileSync('wrangler.jsonc', 'utf8');
const next = cfg.replace(/("binding"\s*:\s*"KV"\s*,\s*"id"\s*:\s*")[^"]*(")/, `$1${ns.id}$2`);
if (next === cfg && !cfg.includes(ns.id)) throw new Error('wrangler.jsonc 中未找到 KV id 占位，请检查格式');
writeFileSync('wrangler.jsonc', next);
console.log(`KV namespace 就绪：${ns.id}${cfg.includes(ns.id) ? '（与配置一致，未改动）' : '（已回写 wrangler.jsonc）'}`);
