/**
 * 本地语音输入的共享契约（VOICE-3）。
 *
 * 手势：`pointerdown` 起 400ms 计时；期间位移 > 6px 或提前 `pointerup` → 取消（原生文字选择照常）。
 * 录音：AudioWorklet → 16kHz 单声道 Int16 分块，二进制帧上行 WS。
 * 下行：JSON `{ type: 'partial' | 'final' | 'error' | 'queued', ... }`（契约见
 *       Docs/design-2026-11-03-local-voice-input.md §识别会话，服务端 VOICE-2 未就绪时用 mock）。
 */

/** 长按阈值：按住多久开始录音（ms） */
export const LONG_PRESS_MS = 400;
/** 位移阈值：超过即视为「文字选择」，不触发录音（px） */
export const MOVE_CANCEL_PX = 6;
/** 采集采样率：与服务端约定一致 */
export const VOICE_SAMPLE_RATE = 16000;

export type VoiceErrorCode =
  | 'VOICE_MODEL_MISSING'
  | 'VOICE_PERMISSION_DENIED'
  | 'VOICE_NO_DEVICE'
  | 'VOICE_UNSUPPORTED'
  | 'VOICE_SERVER_UNAVAILABLE';

/** 三态 + 兼容错误的可读中文文案（设计 §错误态） */
export const VOICE_ERROR_TEXT: Record<VoiceErrorCode, string> = {
  VOICE_MODEL_MISSING: '还没有下载语音模型：到「设置 → 语音输入」里下载后再长按说话',
  VOICE_PERMISSION_DENIED: '麦克风权限被拒绝：在浏览器地址栏的权限设置里允许本站使用麦克风',
  VOICE_NO_DEVICE: '没有检测到麦克风：接入或启用录音设备后重试',
  VOICE_UNSUPPORTED: '当前浏览器不支持本地语音输入（需要 AudioWorklet 与 WebSocket）',
  VOICE_SERVER_UNAVAILABLE: '本地识别服务未就绪：请稍后重试（服务端语音能力未启用）',
};

/** 语言：默认跟随系统语言（navigator.language），可手动指定 */
export interface VoiceSettings {
  enabled: boolean;
  /** 'system' = 跟随 navigator.language，其余为手动指定（BCP-47） */
  language: 'system' | string;
  /** 用户选中的模型 id（由设置页下载后写入） */
  modelId: string | null;
  /** 测试/离线：不连服务端，用 mock 结果验证手势与插入链路 */
  mock: boolean;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: false,
  language: 'system',
  modelId: null,
  mock: false,
};

export function systemLanguage(): string {
  if (typeof navigator === 'undefined') return 'zh-CN';
  return navigator.language || 'zh-CN';
}

export function resolveLanguage(settings: VoiceSettings): string {
  return settings.language === 'system' ? systemLanguage() : settings.language;
}

/** 服务端下行事件 */
export type VoiceServerEvent =
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; code: VoiceErrorCode | string; message?: string }
  | { type: 'queued'; position?: number };

/** 可接入语音的文本控件选择器（date/checkbox/radio 等不算） */
export const VOICE_ELIGIBLE_SELECTOR = [
  'input[type="text"]',
  'input[type="search"]',
  'input:not([type])',
  'textarea',
  '[contenteditable="true"]',
  '[contenteditable=""]',
].join(',');

/** 元素是否是可插入语音的文本控件 */
export function isVoiceEligible(el: Element | null): el is HTMLElement {
  if (el === null) return false;
  if (!(el instanceof HTMLElement)) return false;
  if (el.matches('input[type="date"], input[type="checkbox"], input[type="radio"], input[type="number"]')) return false;
  if (el.matches('input, textarea') && (el as HTMLInputElement).disabled) return false;
  if (el.isContentEditable) return true;
  if (el.matches('input')) {
    const type = (el as HTMLInputElement).type;
    return type === 'text' || type === 'search' || type === 'email' || type === 'url' || type === '';
  }
  return el.matches('textarea');
}
