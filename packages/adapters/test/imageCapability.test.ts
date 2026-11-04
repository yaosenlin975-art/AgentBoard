/**
 * CHAT-IMG-ADAPTER：适配器图片能力的**真实探测与真实负载**测试。
 *
 * 不 mock 结论：用 `setSpawnFn` 拦真实 spawn，喂真实 `--help` 文本（本机 codex-cli 0.166.0 /
 * opencode v2.2.5 的实测输出片段），断言 `supportsImageInput()` 由探测决定；runTurn 断言
 * argv 里真的带上图片路径，且该路径上的字节就是几百字节的真实 PNG。
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asChild, closeChild, makeAutoChild, makeFakeChild, type FakeChild } from './helpers.js';
import { setSpawnFn } from '../src/spawn.js';
import { codexAdapter } from '../src/codex.js';
import { opencodeAdapter } from '../src/opencode.js';
import { dshAdapter } from '../src/dsh.js';
import { codebuddyAdapter } from '../src/codebuddy.js';
import { helpMentionsFlag, resetImageFlagCache } from '../src/imageFlags.js';

/** 本机实测：codex-cli 0.166.0 `codex exec --help` 片段 */
const CODEX_HELP_WITH_IMAGE = [
  'Usage: codex exec [OPTIONS] [PROMPT] [COMMAND]',
  '  -i, --image <FILE>...',
  '          Optional image(s) to attach to the initial prompt',
  '      --json',
  '          Print events to stdout as JSONL',
].join('\n');

/** 本机实测：opencode v2.2.5 `opencode run --help` 片段 */
const OPENCODE_HELP_WITH_FILE = [
  'Usage: opencode run [options] [message..]',
  '  --file, -f string       File to attach to the message',
  '  --format string         Output format (default "text")',
].join('\n');

const OPENCODE_HELP_WITHOUT_FILE = [
  'Usage: opencode run [options] [message..]',
  '  --format string         Output format (default "text")',
].join('\n');

/** 真实 1×1 PNG（67 字节）+ 一个 300 字节的假 PNG（只要魔数对，验证字节流） */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_300 = Buffer.concat([TINY_PNG, Buffer.alloc(233, 0x5a)]);

describe('image capability probe (CHAT-IMG-ADAPTER)', () => {
  let dir: string;
  let pngPath: string;

  beforeEach(() => {
    resetImageFlagCache();
    dir = mkdtempSync(join(tmpdir(), 'agentboard-imgadapter-'));
    pngPath = join(dir, 'tiny.png');
    writeFileSync(pngPath, PNG_300);
  });

  afterEach(() => {
    setSpawnFn(null);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const mockCli = (helpText: string) => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const children: FakeChild[] = [];
    setSpawnFn(((cmd: string, args: string[]) => {
      calls.push({ cmd, args: [...args] });
      if (cmd === 'where' || cmd === 'which') return asChild(makeAutoChild([{ source: 'stdout', text: 'C:\\mock\\bin\\cli.exe\n' }], 0));
      if (args.includes('--version')) return asChild(makeAutoChild([{ source: 'stdout', text: '0.166.0\n' }], 0));
      if (args.includes('--help')) return asChild(makeAutoChild([{ source: 'stdout', text: helpText }], 0));
      const child = makeFakeChild();
      children.push(child);
      return asChild(child);
    }) as never);
    return { calls, children };
  };

  it('helpMentionsFlag matches only real flag occurrences', () => {
    expect(helpMentionsFlag(CODEX_HELP_WITH_IMAGE, '--image')).toBe(true);
    expect(helpMentionsFlag(CODEX_HELP_WITH_IMAGE, '--images')).toBe(false);
    expect(helpMentionsFlag(OPENCODE_HELP_WITH_FILE, '--file')).toBe(true);
    expect(helpMentionsFlag(OPENCODE_HELP_WITHOUT_FILE, '--file')).toBe(false);
    expect(helpMentionsFlag('', '--file')).toBe(false);
  });

  it('codex becomes image-capable only after --help shows --image', async () => {
    mockCli(CODEX_HELP_WITH_IMAGE);
    expect(codexAdapter.supportsImageInput(undefined, '0.166.0')).toBe(false); // 未探测 → 不支持
    const detected = await codexAdapter.detect();
    expect(detected.version).toContain('0.166.0');
    expect(codexAdapter.supportsImageInput(undefined, detected.version)).toBe(true);
  });

  it('codex stays unsupported when --help lacks --image', async () => {
    mockCli('Usage: codex exec [OPTIONS] [PROMPT]\n      --json\n');
    const detected = await codexAdapter.detect();
    expect(codexAdapter.supportsImageInput(undefined, detected.version)).toBe(false);
  });

  it('opencode becomes image-capable only after run --help shows --file', async () => {
    mockCli(OPENCODE_HELP_WITH_FILE);
    const detected = await opencodeAdapter.detect();
    expect(opencodeAdapter.supportsImageInput(undefined, detected.version)).toBe(true);
  });

  it('opencode stays unsupported when run --help lacks --file', async () => {
    mockCli(OPENCODE_HELP_WITHOUT_FILE);
    const detected = await opencodeAdapter.detect();
    expect(opencodeAdapter.supportsImageInput(undefined, detected.version)).toBe(false);
  });

  it('dsh and unverified codebuddy combinations stay false', () => {
    expect(dshAdapter.supportsImageInput(undefined, '0.2.1')).toBe(false);
    // codebuddy 只在 2.179.2 + minimax-m3.1-flash 下为真
    expect(codebuddyAdapter.supportsImageInput('minimax-m3.1-flash', '2.170.0')).toBe(false);
    expect(codebuddyAdapter.supportsImageInput('other-model', '2.179.2')).toBe(false);
    expect(codebuddyAdapter.supportsImageInput('minimax-m3.1-flash', '2.179.2')).toBe(true);
  });

  it('codex runTurn passes the real image path via -i and the bytes on disk match', async () => {
    const { calls, children } = mockCli(CODEX_HELP_WITH_IMAGE);
    const detected = await codexAdapter.detect();
    const handle = codexAdapter.runTurn({
      prompt: '看图说话',
      cwd: dir,
      detectedCliVersion: detected.version,
      attachments: [{ path: pngPath, mimeType: 'image/png' }],
    });
    const events: unknown[] = [];
    handle.onEvent((event) => events.push(event));
    // runTurn 内部 await resolveSpawnForm 后才 spawn：等一拍再断言
    await new Promise((resolve) => setTimeout(resolve, 50));
    const main = children.at(-1);
    expect(main).toBeDefined();
    closeChild(main as FakeChild, 0);
    await handle.result;

    const spawnCall = calls.find((call) => call.args.includes('-i'));
    expect(spawnCall).toBeDefined();
    const imageIndex = (spawnCall as { args: string[] }).args.indexOf('-i');
    expect((spawnCall as { args: string[] }).args[imageIndex + 1]).toBe(pngPath);
    // 负载里的图片就是磁盘上那 300 字节
    const bytes = Buffer.from(await import('node:fs').then(fs => fs.readFileSync(pngPath)));
    expect(bytes.length).toBe(PNG_300.length);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(createHash('sha256').update(PNG_300).digest('hex'));
  });

  it('opencode runTurn passes the real image path via --file', async () => {
    const { calls, children } = mockCli(OPENCODE_HELP_WITH_FILE);
    const detected = await opencodeAdapter.detect();
    const handle = opencodeAdapter.runTurn({
      prompt: '看图说话',
      cwd: dir,
      detectedCliVersion: detected.version,
      attachments: [{ path: pngPath, mimeType: 'image/png' }],
    });
    handle.onEvent(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    closeChild(children.at(-1) as FakeChild, 0);
    await handle.result;
    const spawnCall = calls.find((call) => call.args.includes('--file'));
    expect(spawnCall).toBeDefined();
    const index = (spawnCall as { args: string[] }).args.indexOf('--file');
    expect((spawnCall as { args: string[] }).args[index + 1]).toBe(pngPath);
  });

  it('adapters refuse attachments when capability is not verified', async () => {
    mockCli(OPENCODE_HELP_WITHOUT_FILE);
    const detected = await opencodeAdapter.detect();
    expect(() => opencodeAdapter.runTurn({
      prompt: '看图',
      cwd: dir,
      detectedCliVersion: detected.version,
      attachments: [{ path: pngPath, mimeType: 'image/png' }],
    })).toThrow(/IMAGE_DELIVERY_UNVERIFIED/);
  });
});
