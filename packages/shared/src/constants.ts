export const PRODUCT_NAME = 'AgentBoard';
export const CLI_NAME = 'kb';
export const AGENT_IDS = ['codebuddy', 'codex', 'opencode', 'dsh'] as const;
export const MAX_DISPATCH_IMAGE_COUNT = 5;
export const MAX_DISPATCH_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_DISPATCH_SELECTED_ID_COUNT = 100;

/**
 * 额度来源清单（顺序即界面展示顺序，ACC-KB-A4 单一事实源）。
 *
 * ACC-KB-B5S：来源扩到 **8 个，分两组，不要混为一谈**——
 * - `cli`（3）：`deepseek` / `opencode_go` / `codex`，读的是本机 CLI 的余额或本地额度快照；
 * - `platform`（5）：`workbuddy` / `minimax` / `trae` / `qoder_cn` / `zcode`，读的是桌面/网页账号侧的积分或套餐余量。
 * 两组数据不同源、不同单位，UI 必须分组展示，否则会被误读成重复来源。
 */
import type { QuotaSourceId } from './types.js';

export const QUOTA_SOURCE_GROUP: Record<QuotaSourceId, 'cli' | 'platform'> = {
  deepseek: 'cli',
  opencode_go: 'cli',
  codex: 'cli',
  workbuddy: 'platform',
  minimax: 'platform',
  trae: 'platform',
  qoder_cn: 'platform',
  zcode: 'platform',
};

/** 分组展示元数据（顺序：CLI 额度在前，平台账号在后） */
export const QUOTA_GROUPS: readonly { id: 'cli' | 'platform'; label: string; sources: readonly QuotaSourceId[] }[] = [
  { id: 'cli', label: 'CLI 额度', sources: ['deepseek', 'opencode_go', 'codex'] },
  { id: 'platform', label: '平台账号额度', sources: ['workbuddy', 'minimax', 'trae', 'qoder_cn', 'zcode'] },
];

export const QUOTA_SOURCE_IDS: readonly QuotaSourceId[] = [...QUOTA_GROUPS[0]!.sources, ...QUOTA_GROUPS[1]!.sources];

/** 额度来源的中文标签（服务端不拼 UI 文案，前端与 CLI 共用同一份） */
export const QUOTA_SOURCE_LABEL: Record<QuotaSourceId, string> = {
  deepseek: 'DeepSeek 余额',
  opencode_go: 'OpenCode Go 套餐余量',
  codex: 'Codex 额度窗口',
  workbuddy: 'WorkBuddy 积分',
  minimax: 'MiniMax 套餐余量',
  trae: 'Trae 积分',
  qoder_cn: 'Qoder CN 额度',
  zcode: 'ZCode 额度',
};

// ---- 跨端契约冻结常量（BORROW-0.1 单一事实源：租约/fence/依赖关系/知识短 ID 全部引用这里，各端禁止手写字面量）----

/** claim 租约时长（毫秒）：BORROW-0.2 原子领取的过期窗口。 */
export const CLAIM_LEASE_MS = 900000;

/** claim fence 头名：BORROW-0.2 原子领取的乐观并发控制头。 */
export const CLAIM_FENCE_HEADER = 'x-claim-fence';

/** 任务依赖关系全集（kb dep 语义；服务端校验与 CLI 展示共用）。 */
export const DEPENDENCY_RELATIONS = ['blocks', 'related', 'duplicate'] as const;

/** 知识页短 ID 长度（resolve 查询与导出回退展示共用）。 */
export const KNOWLEDGE_SHORT_ID_LEN = 8;
