/**
 * 语音输入设置（VOICE-3/4 共用）：本地持久化在 localStorage `agentboard.voice`。
 *
 * 持久化位置选择理由：语音开关/语言/所选模型是**每台机器的本地偏好**（麦克风、系统语言、本机已下模型），
 * 与工作空间无关，也不该跨设备同步；服务端只持有模型文件本身（`<data>/models`）。
 * 因此放浏览器 localStorage，跟既有 `agentboard.selected-workspace` / `agentboard.right-panel-width` 同层。
 */
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from './contract';

export const VOICE_SETTINGS_KEY = 'agentboard.voice';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sanitizeVoiceSettings(raw: unknown): VoiceSettings {
  if (!isObject(raw)) return { ...DEFAULT_VOICE_SETTINGS };
  const enabled = raw.enabled === true;
  const language = typeof raw.language === 'string' && raw.language !== '' ? raw.language : 'system';
  const modelId = typeof raw.modelId === 'string' && raw.modelId !== '' ? raw.modelId : null;
  const mock = raw.mock === true;
  return { enabled, language, modelId, mock };
}

export function loadVoiceSettings(): VoiceSettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_VOICE_SETTINGS };
  try {
    const raw = localStorage.getItem(VOICE_SETTINGS_KEY);
    return sanitizeVoiceSettings(raw === null ? null : (JSON.parse(raw) as unknown));
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS };
  }
}

export function saveVoiceSettings(settings: VoiceSettings): void {
  try {
    localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 隐私模式等场景写入失败：静默（内存态仍然生效）
  }
}
