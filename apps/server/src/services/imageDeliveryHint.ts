/**
 * CHAT-IMG-ADAPTER：`IMAGE_DELIVERY_UNVERIFIED` 的**可执行**文案。
 *
 * 400 只说「当前 CLI/model 组合没有通过图片输入验证」用户无从下手：不同适配器要动作完全不同
 * （升级 codebuddy / 升级 codex / 升级 opencode / 换执行方式）。这里按适配器给一句话指路。
 */
export interface ImageDeliveryHintInput {
  cliId: string;
  displayName: string;
  detectedVersion: string | null;
  model?: string;
}

export function imageDeliveryHint(input: ImageDeliveryHintInput): string {
  const version = input.detectedVersion ?? '未探测到版本';
  switch (input.cliId) {
    case 'codebuddy':
      return `当前执行方式是 ${input.displayName} ${version}（model=${input.model ?? '默认'}）：`
        + '图片输入要求 codebuddy 2.179.2 且 model=minimax-m3.1-flash，请升级 codebuddy 或换用 codex / opencode';
    case 'codex':
      return `当前执行方式是 ${input.displayName} ${version}：`
        + '`codex exec --help` 里没有 `--image`，请升级 codex-cli（0.166.0 实测支持 `-i, --image <FILE>...`）后重试';
    case 'opencode':
      return `当前执行方式是 ${input.displayName} ${version}：`
        + '`opencode run --help` 里没有 `--file`，请升级 opencode（v2.2.5 实测支持 `--file, -f`）后重试';
    case 'dsh':
      return `当前执行方式是 ${input.displayName}：本机 dsh 只有 asar 打包形态、无法实测图片入参，暂不支持图片，请改用 codex / opencode / codebuddy`;
    default:
      return `当前执行方式 ${input.displayName}（${version}）不支持图片输入，请改用 codex / opencode / codebuddy`;
  }
}
