/**
 * REST fetch 封装：错误统一取 `{ error: { code, message } }` 抛 ApiError；
 * DELETE 等端点返回 204 时返回 undefined。
 */
export interface ApiErrorPayload {
  code: string;
  message: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // 非 JSON 响应按空处理，错误分支给出兜底 message
  }

  if (!res.ok) {
    const err = (data as { error?: ApiErrorPayload } | null)?.error;
    throw new ApiError(
      err?.message ?? `请求失败（HTTP ${res.status}）`,
      err?.code ?? 'UNKNOWN',
      res.status,
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>('GET', path),
  post: <T>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown): Promise<T> => request<T>('PATCH', path, body),
  del: <T>(path: string): Promise<T> => request<T>('DELETE', path),
};
