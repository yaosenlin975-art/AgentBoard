/**
 * 平台能力图标徽标（ACC-UI-01 / 设计 D2）。
 *
 * - 三个图标：capture / switch / checkin；三态 `true → ✓`、`false → ✗`、能力未取到 → `?`。
 * - **徽标上不显示 reason_code**：原因只进 `title`（tooltip）与「技术信息」`<details>`。
 * - 保留既有 testid 契约：`accounts-capability-${app}`（技术串，含 `捕获 X · 切换 Y · 签到 Z`）与
 *   `accounts-capability-source-${app}`（来源），便于既有断言与排障继续工作。
 */
import type { AccountCapability } from '@agentboard/shared';
import { SOURCE_LABEL, capabilityReasonCode, unavailableLabel, unavailableReason, type CapabilityAction, type CapabilityView } from './accountCapabilities';

const ACTIONS: CapabilityAction[] = ['capture', 'switch', 'checkin'];
const ACTION_LABEL: Record<CapabilityAction, string> = { capture: '捕获', switch: '切换', checkin: '签到' };

/** 单个维度图标：可用 ✓ / 不可用 ✗ / 未知 ? */
export function CapabilityIcon({
  app,
  action,
  capability,
}: {
  app: string;
  action: CapabilityAction;
  capability: CapabilityView | null;
}) {
  const known = capability !== null;
  const available = capability ? capability[action] === true : false;
  const icon = !known ? '?' : available ? '✓' : '✗';
  const reason = capability ? unavailableReason(capability, action) : null;
  const code = capability ? capabilityReasonCode(capability, action) : null;
  const title = !known
    ? `${ACTION_LABEL[action]}：能力未知（能力矩阵未取到）`
    : available
      ? `${ACTION_LABEL[action]}：可用`
      : `${ACTION_LABEL[action]}：不可用（${unavailableLabel(capability, action) ?? reason ?? '原因未知'}${code !== null && code !== 'OK' ? ` / ${code}` : ''}）`;
  const tone = !known ? 'text-neutral-400' : available ? 'text-emerald-600 dark:text-emerald-400' : 'text-neutral-400 dark:text-neutral-500';
  return (
    <span
      data-testid={`accounts-badge-${app}-${action}`}
      data-state={!known ? 'unknown' : available ? 'available' : 'unavailable'}
      role="img"
      aria-label={title}
      title={title}
      className={`inline-flex w-4 justify-center text-xs font-semibold leading-none ${tone}`}
    >
      {icon}
    </span>
  );
}

/** 三个图标 + 收起在 `<details>` 里的技术串（原因码只出现在 tooltip 与这里） */
export function CapabilityBadges({ app, capability }: { app: string; capability: CapabilityView | null }) {
  return (
    <span className="flex items-center gap-0.5">
      {ACTIONS.map((action) => (
        <CapabilityIcon key={action} app={app} action={action} capability={capability} />
      ))}
      <details data-testid={`accounts-capability-details-${app}`} className="ml-1 text-[11px] text-neutral-400 dark:text-neutral-500">
        <summary className="cursor-pointer select-none text-[11px]">技术信息</summary>
        <span data-testid={`accounts-capability-${app}`} className="block font-mono">
          {capability
            ? `捕获 ${capability.capture ? 'OK' : capabilityReasonCode(capability, 'capture')} · 切换 ${capability.switch ? 'OK' : capabilityReasonCode(capability, 'switch')} · 签到 ${capability.checkin ? 'OK' : capabilityReasonCode(capability, 'checkin')}`
            : '捕获 ? · 切换 ? · 签到 ?'}
        </span>
        <span data-testid={`accounts-capability-source-${app}`} className="block">
          来源：{capability ? SOURCE_LABEL[capability.source as AccountCapability['source']] : '能力未知'}
        </span>
      </details>
    </span>
  );
}
