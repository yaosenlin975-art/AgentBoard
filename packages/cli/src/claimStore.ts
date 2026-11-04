/**
 * BORROW-0.3：占用代次（fence）本地持久化。
 * claim 成功 → `.agentboard/claims/<issueId>.json`（相对当前工作目录）；done/fail 成功后自动携带并清除。
 * 文件缺失/损坏按软模式处理（不带 fence），不阻塞收尾。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface StoredClaim {
  issue_id: string;
  fence: number;
  agent_id: string;
  claimed_at: number | null;
  base: string;
}

function claimFile(issueId: string): string {
  return join('.agentboard', 'claims', `${issueId}.json`);
}

/** claim 成功后落盘；目录不可写等失败由调用方决定是否告警（不影响领取本身） */
export function saveClaimedFence(claim: StoredClaim): void {
  const file = claimFile(claim.issue_id);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(claim, null, 2)}\n`, 'utf8');
}

/** 读回 fence；文件缺失/损坏/字段非法 → undefined（软模式） */
export function loadClaimedFence(issueId: string): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(claimFile(issueId), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { fence?: unknown };
    return typeof parsed.fence === 'number' && Number.isSafeInteger(parsed.fence) && parsed.fence >= 0
      ? parsed.fence
      : undefined;
  } catch {
    return undefined;
  }
}

/** 收尾成功后清除；best-effort，失败静默（下次 done 软模式重试仍可用） */
export function clearClaimedFence(issueId: string): void {
  try {
    rmSync(claimFile(issueId), { force: true });
  } catch {
    // 忽略：清理失败不影响收尾结果
  }
}
