import type { CliAccountAppId, PublicCliAccount } from '@agentboard/shared';
import { request } from '../api.js';
import { writeListJson } from '../json.js';
import type { Ctx } from '../io.js';
import { table } from '../render.js';

/**
 * CLI-SWITCH：CLI 三来源（DeepSeek / OpenCode-Go / Codex）的账号查看与切换。
 * 默认 dry-run；只有 `--apply` 才真正写本机配置文件；输出永不含凭据明文。
 */

interface CliSwitchResultView {
  app_id: CliAccountAppId;
  account_id: string;
  status: 'dry_run' | 'switched';
  applied: boolean;
  target: string;
  field: string;
  current_identity_hint: string | null;
  target_identity_hint: string;
  already_current: boolean;
  blocked_reason_code: string | null;
}

interface CliSwitchCapabilityView {
  app_id: CliAccountAppId;
  switch: boolean;
  reason_code: string;
  reason: string | null;
}

export async function accountsList(ctx: Ctx): Promise<void> {
  const data = await request<{ items: PublicCliAccount[] }>(ctx.base, 'GET', '/api/cli-accounts');
  if (ctx.json) {
    writeListJson(ctx, data.items);
    return;
  }
  if (data.items.length === 0) {
    ctx.io.write('（无 CLI 账号）\n');
    return;
  }
  ctx.io.write(table(
    ['id', 'app', 'identity_hint', 'last_seen_at'],
    data.items.map(item => [item.id, item.app_id, item.identity_hint, String(item.last_seen_at)]),
  ));
}

export async function accountsCapabilities(ctx: Ctx): Promise<void> {
  const data = await request<{ items: CliSwitchCapabilityView[] }>(ctx.base, 'GET', '/api/cli-accounts/switch-capabilities');
  if (ctx.json) {
    writeListJson(ctx, data.items);
    return;
  }
  ctx.io.write(table(
    ['app', 'switch', 'reason_code', 'reason'],
    data.items.map(item => [item.app_id, item.switch ? 'true' : 'false', item.reason_code, item.reason ?? '-']),
  ));
}

export interface AccountSwitchArgs {
  /** 缺省 false：只输出 dry-run 计划，不写本机配置 */
  apply?: boolean;
}

export async function accountSwitch(ctx: Ctx, accountId: string, args: AccountSwitchArgs = {}): Promise<void> {
  const result = await request<CliSwitchResultView>(
    ctx.base, 'POST', `/api/cli-accounts/${encodeURIComponent(accountId)}/switch`,
    { apply: args.apply === true },
  );
  if (ctx.json) {
    ctx.io.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const lines = [
    `来源: ${result.app_id}`,
    `账号: ${result.account_id}`,
    `目标: ${result.target} 字段 ${result.field}`,
    `当前生效身份: ${result.current_identity_hint ?? '（无）'}`,
    `目标身份: ${result.target_identity_hint}`,
  ];
  if (result.status === 'dry_run') {
    lines.push(result.blocked_reason_code === null
      ? '模式: dry-run（未写入；加 --apply 才执行切换）'
      : `模式: dry-run（未写入；预检阻断 ${result.blocked_reason_code}）`);
    if (result.already_current) lines.push('说明: 该账号已是当前生效账号');
  } else if (result.already_current) {
    lines.push('结果: 该账号已是当前生效账号（未重复写入）');
  } else {
    lines.push('结果: 已写入并通过读回校验');
  }
  ctx.io.write(`${lines.join('\n')}\n`);
}
