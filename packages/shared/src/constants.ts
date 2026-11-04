export const PRODUCT_NAME = 'AgentBoard';
export const CLI_NAME = 'kb';
export const AGENT_IDS = ['codebuddy', 'codex', 'opencode', 'dsh'] as const;
export const MAX_DISPATCH_IMAGE_COUNT = 5;
export const MAX_DISPATCH_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_DISPATCH_SELECTED_ID_COUNT = 100;

/** 额度来源清单（顺序即界面展示顺序，ACC-KB-A4 单一事实源） */
import type { QuotaSourceId } from './types.js';

export const QUOTA_SOURCE_IDS: readonly QuotaSourceId[] = ['deepseek', 'opencode_go', 'codex'];

/** 额度来源的中文标签（服务端不拼 UI 文案，前端与 CLI 共用同一份） */
export const QUOTA_SOURCE_LABEL: Record<QuotaSourceId, string> = {
  deepseek: 'DeepSeek 余额',
  opencode_go: 'OpenCode Go 套餐余量',
  codex: 'Codex 额度窗口',
};