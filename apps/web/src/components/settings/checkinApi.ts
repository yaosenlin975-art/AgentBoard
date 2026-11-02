/**
 * 签到批次的前端调用层（ACC-09）。
 * 只有创建批次这一处绕开 api client：`409 CHECKIN_BATCH_IN_PROGRESS` 的 `details.batch_id`
 * 会被 `api/client.ts` 丢弃，而界面必须展示已有批次 id。待 client 支持 details 后改为 `api.post` 并删除本文件。
 * 其余调用（查批次、取消、批次 operation 列表）走 api client。
 */
import type { AccountOperation, CheckinBatch, ManagedAppId } from '@agentboard/shared';
import { api } from '../../api/client';

export type BatchCreateOutcome =
  | { kind: 'created'; batch: CheckinBatch; replayed: boolean }
  | { kind: 'conflict'; code: string; message: string; batchId: string | null }
  | { kind: 'error'; code: string; message: string };

export interface BatchCancelResult {
  batch_id: string;
  cancelled: string[];
  running: string[];
}

export async function createCheckinBatch(
  input: { app_id: ManagedAppId; account_ids: string[] },
  idempotencyKey: string,
): Promise<BatchCreateOutcome> {
  let res: Response;
  try {
    res = await fetch('/api/checkin-runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    });
  } catch (error) {
    return { kind: 'error', code: 'NETWORK', message: error instanceof Error ? error.message : '网络错误' };
  }
  const data = (await res.json().catch(() => null)) as
    | { batch: CheckinBatch; replayed?: boolean }
    | { error: { code: string; message: string; details?: { batch_id?: string } } }
    | null;
  if (!res.ok) {
    const err = (data as { error?: { code: string; message: string; details?: { batch_id?: string } } } | null)?.error;
    const code = err?.code ?? 'UNKNOWN';
    const message = err?.message ?? `请求失败（HTTP ${res.status}）`;
    if (code === 'CHECKIN_BATCH_IN_PROGRESS') {
      const batchId = err?.details?.batch_id ?? null;
      return { kind: 'conflict', code, message, batchId: typeof batchId === 'string' ? batchId : null };
    }
    return { kind: 'error', code, message };
  }
  const payload = data as { batch: CheckinBatch; replayed?: boolean };
  return { kind: 'created', batch: payload.batch, replayed: payload.replayed === true };
}

export const fetchCheckinBatch = (batchId: string): Promise<CheckinBatch> =>
  api.get<CheckinBatch>(`/api/checkin-runs/${encodeURIComponent(batchId)}`);

export const cancelCheckinBatch = (batchId: string): Promise<BatchCancelResult> =>
  api.post<BatchCancelResult>(`/api/checkin-runs/${encodeURIComponent(batchId)}/cancel`, {});

export const fetchBatchOperations = (batchId: string): Promise<AccountOperation[]> =>
  api.get<AccountOperation[]>(`/api/account-operations?batch_id=${encodeURIComponent(batchId)}`);
