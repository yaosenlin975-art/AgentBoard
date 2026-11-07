/**
 * 平台能力图标徽标（ACC-UI-01 / 设计 D2；ACC-UI-PRUNE 起只留三个图标）。
 *
 * - 三个图标：capture / switch / checkin；三态 `true → ✓`、`false → ✗`、能力未取到 → `?`。
 * - **徽标上不显示 reason_code**：原因只进 `title`（tooltip）。
 * - ACC-UI-PRUNE：「技术信息」折叠块（`accounts-capability-details-*` 技术串与来源）已删。
 */
import { capabilityReasonCode, unavailableLabel, unavailableReason, type CapabilityAction, type CapabilityView } from './accountCapabilities';
import { IconCheck, IconCross, IconQuestion } from '../ui/Icon';

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
  // UNSLOP pass 3/8：三态用线性图标 + ink 分级，不再用彩色 ✓/✗/? 字形
  const reason = capability ? unavailableReason(capability, action) : null;
  const code = capability ? capabilityReasonCode(capability, action) : null;
  const title = !known
    ? `${ACTION_LABEL[action]}：能力未知（能力矩阵未取到）`
    : available
      ? `${ACTION_LABEL[action]}：可用`
      : `${ACTION_LABEL[action]}：不可用（${unavailableLabel(capability, action) ?? reason ?? '原因未知'}${code !== null && code !== 'OK' ? ` / ${code}` : ''}）`;
  const tone = !known ? 'text-ink-3' : available ? 'text-ink' : 'text-ink-3';
  return (
    <span
      data-testid={`accounts-badge-${app}-${action}`}
      data-state={!known ? 'unknown' : available ? 'available' : 'unavailable'}
      role="img"
      aria-label={title}
      title={title}
      className={`inline-flex w-4 justify-center leading-none ${tone}`}
    >
      {!known ? <IconQuestion /> : available ? <IconCheck /> : <IconCross />}
    </span>
  );
}

/** 三个能力图标（原因码只出现在 tooltip） */
export function CapabilityBadges({ app, capability }: { app: string; capability: CapabilityView | null }) {
  return (
    <span className="flex items-center gap-0.5">
      {ACTIONS.map((action) => (
        <CapabilityIcon key={action} app={app} action={action} capability={capability} />
      ))}
    </span>
  );
}
