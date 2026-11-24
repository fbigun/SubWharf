// KV 桩：Map 存储，行为对齐 Cloudflare KV 的 get / put / delete / list。
// list 按前缀过滤、按键名字典序分页（cursor 为上页最后一个键名），便于重构后的分页逻辑继续可测。
interface FakeKVListPage {
  keys: { name: string; expiration?: number }[];
  list_complete: boolean;
  cursor?: string;
}

export class FakeKV {
  private readonly data = new Map<string, string>();
  private readonly failures = new Map<string, Error>();

  constructor(seed: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(seed)) this.data.set(key, JSON.stringify(value));
  }

  seed(key: string, value: unknown): this {
    this.data.set(key, JSON.stringify(value));
    return this;
  }

  /** 反序列化读取，便于断言落盘内容 */
  read<T = unknown>(key: string): T | undefined {
    const raw = this.data.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  keys(prefix = ''): string[] {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  /** 让指定键的 get 抛错，用于覆盖「未捕获异常 → 500」分支 */
  fail(key: string, message = 'KV 内部错误：具体实现细节'): this {
    this.failures.set(key, new Error(message));
    return this;
  }

  async get(key: string, type?: string): Promise<unknown> {
    const failure = this.failures.get(key);
    if (failure) throw failure;
    const raw = this.data.get(key);
    if (raw === undefined) return null;
    if (type === 'json') return JSON.parse(raw);
    if (type === 'arrayBuffer') return new TextEncoder().encode(raw).buffer;
    if (type === 'stream') return new Response(raw).body;
    return raw;
  }

  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async list(options: { prefix?: string; limit?: number; cursor?: string } = {}): Promise<FakeKVListPage> {
    const prefix = options.prefix ?? '';
    const limit = options.limit ?? 1000;
    const from = options.cursor ?? '';
    const remaining = this.keys(prefix).filter((k) => k > from);
    const page = remaining.slice(0, limit);
    const listComplete = page.length === remaining.length;
    return {
      keys: page.map((name) => ({ name })),
      list_complete: listComplete,
      cursor: listComplete ? undefined : page[page.length - 1],
    };
  }
}
