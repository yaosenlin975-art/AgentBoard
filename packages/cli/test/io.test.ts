/**
 * K2：stdin 归一 CRLF。
 *
 * PowerShell 管道（`Get-Content -Raw | kb …`）会在末尾注入 `\r\n`（实测 21 字节文件 → 收到 23 字节，尾部 `行。\n\r\n`）。
 * CRLF 进入 body_md 后，parseKnowledgeDocument 的 `\r\n → \n` 归一使回读少 1 字节 → content_hash 不保真。
 * stdin 是文本正文的传输通道，CRLF/LF 差异属传输层噪声，统一归一为 LF。
 * 孤立 CR 不归一（它在正文里可能有意义，且实测往返本来就保真）。
 */
import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { readAllStdin } from '../src/io.js';

function feed(chunks: Array<string | Buffer>): Promise<string> {
  const stream = Readable.from(chunks);
  return readAllStdin(stream);
}

describe('K2 readAllStdin 换行归一', () => {
  it('CRLF → LF', async () => {
    expect(await feed(['a\r\nb'])).toBe('a\nb');
  });

  it('已是 LF 的内容逐字节不变（幂等）', async () => {
    expect(await feed(['a\nb'])).toBe('a\nb');
  });

  it('孤立 CR 不被归一', async () => {
    expect(await feed(['a\rb'])).toBe('a\rb');
  });

  it('BOM 剥离且 CRLF 归一同时生效', async () => {
    expect(await feed(['\uFEFFa\r\nb'])).toBe('a\nb');
  });

  it('空输入 → 空字符串', async () => {
    expect(await feed([])).toBe('');
  });

  it('PowerShell 管道尾注入形态（末尾 \\n\\r\\n）：不留 \\r，尾部为 \\n\\n', async () => {
    // 真实 PowerShell 管道：文件 "行。\n" 经管道后变 "行。\n\r\n"
    // 归一 CRLF 后 "行。\n\n"：只去掉 \r，不吞换行（吞换行是启发式，会破坏有意义的尾部空行）。
    // 关键是 hash 稳定：写入与回读用同一份 body，stored === recomp 成立。
    const out = await feed(['# T\n\n正文一行。\n\r\n']);
    expect(out).toBe('# T\n\n正文一行。\n\n');
    expect(out.includes('\r')).toBe(false);
  });

  it('多分片跨 chunk 的 CRLF 也被归一（不能只在 chunk 边界内替换）', async () => {
    expect(await feed(['a\r', '\nb'])).toBe('a\nb');
  });

  it('混合内容：CRLF 归一、孤立 CR 保留、末尾无多余字符', async () => {
    expect(await feed(['L1\r\nL2\rL3\r\n'])).toBe('L1\nL2\rL3\n');
  });
});
