// 全局 fetch 桩：只放行显式登记的 URL；未登记直接抛错，避免测试意外访问网络。
import { vi } from 'vitest';

export type FetchRoute = (url: string, init?: RequestInit) => Response | Promise<Response>;

export function stubFetch(routes: Record<string, FetchRoute>) {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return route(url, init);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

export const okText = (body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status: 200, headers });
