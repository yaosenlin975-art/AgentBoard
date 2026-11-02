import type { AgentAdapter, RunTurnOptions } from './types.js';

/** 使用适配器已有 detect() 结果做统一版本+模型能力判断；探测失败或缺失信息按不支持处理。 */
export async function getVerifiedImageInputCliVersion(
  adapter: Pick<AgentAdapter, 'detect' | 'supportsImageInput'>,
  model: string | undefined,
): Promise<string | null> {
  try {
    const detected = await adapter.detect();
    if (!detected.installed || !detected.version || !adapter.supportsImageInput(model, detected.version)) return null;
    return detected.version;
  } catch {
    return null;
  }
}

export function assertImageInputSupported(
  opts: RunTurnOptions,
  supportsImageInput: (model: string | undefined, cliVersion?: string | null) => boolean,
): void {
  if ((opts.attachments?.length ?? 0) > 0 && !supportsImageInput(opts.model, opts.detectedCliVersion)) {
    throw new Error('IMAGE_DELIVERY_UNVERIFIED:当前 CLI/model 组合没有通过图片输入验证');
  }
}
