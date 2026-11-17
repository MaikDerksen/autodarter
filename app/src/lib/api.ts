let baseUrl = '';
let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

export class ApiError extends Error {
  status: number;
  /** The full error body (e.g. { error, code: 'board_busy', activeMatch, canForce }). */
  data: Record<string, unknown>;
  constructor(message: string, status: number, data: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export function configureApi(opts: { baseUrl?: string; token?: string | null; onUnauthorized?: () => void }) {
  if (opts.baseUrl !== undefined) baseUrl = opts.baseUrl.replace(/\/+$/, '');
  if (opts.token !== undefined) token = opts.token;
  if (opts.onUnauthorized) onUnauthorized = opts.onUnauthorized;
}

export function getApiBase() {
  return baseUrl;
}

export function wsUrl(path: string): string {
  let base = baseUrl;
  if (!base && typeof window !== 'undefined' && window.location) base = window.location.origin;
  return base.replace(/^http/, 'ws') + path;
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(baseUrl + path, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError('Server nicht erreichbar', 0);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized?.();
    const body = (json ?? {}) as Record<string, unknown>;
    throw new ApiError(typeof body.error === 'string' ? body.error : `Fehler ${res.status}`, res.status, body);
  }
  return json as T;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
