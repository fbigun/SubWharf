// ASSETS 桩：Workers Static Assets 的 Fetcher 替身，返回固定页体并记录收到的请求。
export class FakeAssets {
  readonly requests: Request[] = [];

  constructor(private readonly body = '<!doctype html><title>SubWharf 面板</title>') {}

  async fetch(req: Request): Promise<Response> {
    this.requests.push(req);
    return new Response(this.body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}
