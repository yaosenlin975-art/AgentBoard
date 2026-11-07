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
  /** D7：服务端返回附件类别（web 上传通道仍只发图片）；可选以兼容旧快照/测试夹具 */
  kind?: 'image' | 'file';
  size_bytes: number;
  status: 'staged';
  expires_at: number;
  download_url: string;
}

/** D7：详情附件路径索引行——固定 URL 指向 workspace 下载端点，不新增 markdown scheme */
export interface IssueAttachmentListItem {
  id: string;
  file_name: string;
  kind: 'image' | 'file';
  size_bytes: number;
  url: string;
}

export interface IssueAttachmentListPage {
  items: IssueAttachmentListItem[];
  next_offset: number | null;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * 普通 REST 请求超时：15s。三端都应有超时（MCP 客户端取 10s），web 首屏会串行发多条查询，
 * 留更宽松的余量；服务进程存活但不回包时按超时报错，不再永久 loading。
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * 上传超时：60s。上传要读本地大图 + 服务端落盘，时间尺度与普通 GET 不同，不能共用 15s；
 * 仍必须有上限，否则服务端卡死时上传按钮永久转圈。
 */
export const UPLOAD_TIMEOUT_MS = 60_000;

export const TIMEOUT_MESSAGE = '服务无响应，请稍后重试';

/**
 * 超时映射为 ApiError(code='TIMEOUT', status=0)：status=0 与服务端 HTTP 错误（≥400）可区分。
 * 用竞速而非把 AbortSignal 传给 fetch：超时到点即解除 loading 是目标；底层连接交给浏览器/网关回收。
 */
async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const request = fetch(input, init);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 超时先返回后，迟到的失败不再冒泡成 unhandled rejection
  request.catch(() => {});
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ApiError(TIMEOUT_MESSAGE, 'TIMEOUT', 0)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function request<T>(method: Method, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const res = await fetchWithTimeout(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json', ...extraHeaders } : extraHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }, REQUEST_TIMEOUT_MS);
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
  const res = await fetchWithTimeout(`/api/workspaces/${encodeURIComponent(workspaceId)}/attachments`, {
    method: 'POST',
    headers,
    body,
  }, UPLOAD_TIMEOUT_MS);

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
