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

export interface AttachmentUploadResult {
  id: string;
  workspace_id: string;
  file_name: string;
  mime_type: 'image/png' | 'image/jpeg' | 'image/webp';
  size_bytes: number;
  status: 'staged';
  expires_at: number;
  download_url: string;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json', ...extraHeaders } : extraHeaders,
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

async function uploadAttachment(workspaceId: string, file: File, mimeType: AttachmentUploadResult['mime_type']): Promise<AttachmentUploadResult> {
  const headers: Record<string, string> = { 'Content-Type': mimeType };
  // Fetch only accepts byte-safe header values. Unicode names remain in the local draft label;
  // the server will use its safe default filename for persisted metadata.
  if (/^[\x20-\x7e]+$/.test(file.name)) headers['X-File-Name'] = file.name;
  const body = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error('图片读取失败'));
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'));
    reader.readAsArrayBuffer(file);
  });
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/attachments`, {
    method: 'POST',
    headers,
    body,
  });

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON errors use the same fallback as the regular REST helper.
  }
  if (!res.ok) {
    const err = (data as { error?: ApiErrorPayload } | null)?.error;
    throw new ApiError(
      err?.message ?? `请求失败（HTTP ${res.status}）`,
      err?.code ?? 'UNKNOWN',
      res.status,
    );
  }
  return data as AttachmentUploadResult;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>('GET', path),
  post: <T>(path: string, body?: unknown, options?: { headers?: Record<string, string> }): Promise<T> => request<T>('POST', path, body, options?.headers),
  put: <T>(path: string, body?: unknown): Promise<T> => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown): Promise<T> => request<T>('PATCH', path, body),
  del: <T>(path: string): Promise<T> => request<T>('DELETE', path),
  /** DELETE 带 JSON body（变更日志 CAS 删除用）；新增导出，既有 `del` 语义不变 */
  delWithBody: <T>(path: string, body: unknown): Promise<T> => request<T>('DELETE', path, body),
  uploadAttachment,
};
