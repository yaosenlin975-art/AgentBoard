/**
 * CHAT-IMG-ADAPTER：CLI 图片能力的**真实探测**（不靠猜、不写死 true）。
 *
 * 做法：`detect()` 时跑一次 `<cmd> <subcommand> --help`，在 help 文本里找图片相关 flag
 * （codex `--image`、opencode `--file`），把结果按 `<adapter>:<version>` 缓存；
 * `supportsImageInput()` 是同步接口，只读缓存——**没探测到就当不支持**，绝不默认 true。
 */
const flags = new Map<string, boolean>();

/** 纯函数：help 文本里是否出现某个 flag（含 `-i, --image` 这种简写合并形式） */
export function helpMentionsFlag(helpText: string, flag: string): boolean {
  if (helpText.trim() === '') return false;
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,])${escaped}([\\s,<]|$)`, 'm').test(helpText);
}

export function rememberImageFlag(key: string, supported: boolean): void {
  flags.set(key, supported);
}

export function cachedImageFlag(key: string): boolean {
  return flags.get(key) === true;
}

/** 测试用：清空缓存 */
export function resetImageFlagCache(): void {
  flags.clear();
}

export function imageFlagKey(adapterId: string, cliVersion: string | null | undefined): string {
  return `${adapterId}:${cliVersion ?? ''}`;
}
