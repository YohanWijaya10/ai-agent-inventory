const DEFAULT_TIMEOUT_MS = 15000;

export type FetchJsonOptions = {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  headers?: Record<string, string>;
  cache?: RequestCache;
};

export class FetchJsonError extends Error {
  status?: number;
  url?: string;
  constructor(message: string, opts?: { status?: number; url?: string }) {
    super(message);
    this.name = 'FetchJsonError';
    this.status = opts?.status;
    this.url = opts?.url;
  }
}

export async function fetchJson<T = unknown>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 2, retryDelayMs = 400, headers = {}, cache } = options;

  let attempt = 0;
  let lastErr: unknown;

  while (attempt <= retries) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined as any;
    const id = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json', ...headers },
        signal: controller?.signal,
        cache
      } as RequestInit);
      if (id) clearTimeout(id as any);
      if (!res.ok) {
        const text = await safeText(res);
        throw new FetchJsonError(`Request failed: ${res.status}`, { status: res.status, url });
      }
      const data = (await res.json()) as T;
      return data;
    } catch (err: any) {
      lastErr = err;
      // Only retry on network/timeouts
      const isAbort = err?.name === 'AbortError';
      const isNetwork = !('status' in (err || {}));
      if (attempt === retries || (!isAbort && !isNetwork)) {
        if (id) clearTimeout(id as any);
        if (err instanceof FetchJsonError) throw err;
        throw new FetchJsonError(err?.message || 'Network error', { url });
      }
      // backoff
      await new Promise((r) => setTimeout(r, retryDelayMs * Math.pow(2, attempt)));
      attempt += 1;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Unknown fetch error');
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}

export const BASE_DATA_API = 'https://serverless-twg8.vercel.app';
export const DATA_PROXY = '/data';
