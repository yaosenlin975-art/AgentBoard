/**
 * [KB-GREP] `kb grep` 单测：三态退出码、JSON 结构、忽略/过滤组合、截断、异常文件、编码。
 * 设计：knowledge:8922b413-d33f-4d9b-b16f-da7393d92506
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/index.js';
import { runGrep, type GrepResult } from '../src/commands/grep.js';

interface Capture {
  out: string[];
  err: string[];
  io: { write(line: string): void; writeErr(line: string): void; readStdin(): Promise<string> };
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { write: (line) => out.push(line), writeErr: (line) => err.push(line), readStdin: async () => '' } };
}

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const c = capture();
  const code = await main(['node', 'kb', ...args], c.io);
  return { code, stdout: c.out.join(''), stderr: c.err.join('') };
}

let root = '';

function write(rel: string, content: string | Buffer): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kb-grep-'));
  write('src/a.ts', 'const x = needle;\nconst y = 0;\n// needle again\n');
  write('src/b.js', 'needle in js\n');
  write('src/sub/c.ts', 'NEEDLE upper\nneedle lower\n');
  write('node_modules/m.ts', 'needle ignored dir\n');
  write('.hidden/h.ts', 'needle hidden\n');
  write('bin.dat', Buffer.concat([Buffer.from('needle'), Buffer.from([0x00, 0x01, 0x02])]));
  write('crlf.ts', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('first\r\nneedle here\r\n')]));
  write('long.ts', `needle${'x'.repeat(5000)}\n`);
  write('literal.ts', 'a.b\naXb\n');
  write('many.ts', 'needle\nneedle\nneedle\n');
  write('big.ts', `needle ${'y'.repeat(600)}\n`);
});

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('退出码三态', () => {
  it('命中 → 0，文本输出 文件:行:列:文本', async () => {
    const r = await run(['grep', 'needle', '--path', join(root, 'src'), '--glob', 'a.ts']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('a.ts:1:11:const x = needle;');
    expect(r.stdout).toContain('a.ts:3:4:// needle again');
  });

  it('未命中 → 1，文本模式不写 stdout', async () => {
    const r = await run(['grep', 'zzz_not_exist_xx', '--path', root, '--glob', '*.ts']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
  });

  it('未命中 + --json → 1，仍输出单对象空结果', async () => {
    const r = await run(['grep', 'zzz_not_exist_xx', '--path', root, '--glob', '*.ts', '--json']);
    expect(r.code).toBe(1);
    const body = JSON.parse(r.stdout) as GrepResult;
    expect(body.matches).toEqual([]);
    expect(body.truncated).toEqual({ hit: false, reason: null });
    expect(body.stats.matches).toBe(0);
  });

  it('非法正则 → 2', async () => {
    const r = await run(['grep', '[', '--path', root]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('正则无效');
  });

  it('搜索根不存在 → 2', async () => {
    const r = await run(['grep', 'needle', '--path', join(root, 'nope')]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('搜索根不存在');
  });

  it('--max-count 非整数 → 2', async () => {
    const r = await run(['grep', 'needle', '--path', root, '--max-count', '0']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--max-count');
  });
});

describe('JSON 结构', () => {
  it('字段与 1 基行列、match 起止', async () => {
    const r = await run(['grep', 'needle', '--path', join(root, 'src'), '--glob', 'a.ts', '--json']);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout) as GrepResult;
    expect(body.pattern).toBe('needle');
    expect(body.matches.length).toBe(2);
    const first = body.matches[0]!;
    expect(first.path).toBe('a.ts');
    expect(first.line).toBe(1);
    expect(first.column).toBe(11);
    expect(first.match).toEqual({ start: 11, end: 17 });
    expect(first.context).toEqual({ before: [], after: [] });
    expect(body.stats.files_scanned).toBeGreaterThan(0);
    expect(body.truncated.hit).toBe(false);
  });

  it('--context 附带前后行', async () => {
    const r = await run(['grep', 'needle', '--path', join(root, 'src'), '--glob', 'a.ts', '--context', '1', '--json']);
    const body = JSON.parse(r.stdout) as GrepResult;
    expect(body.matches[0]!.context.after).toEqual(['const y = 0;']);
    expect(body.matches[1]!.context.before).toEqual(['const y = 0;']);
    expect(body.matches[1]!.context.after).toEqual([]);
  });
});

describe('忽略与过滤组合', () => {
  it('内置忽略目录不扫（node_modules）', async () => {
    const r = await run(['grep', 'needle', '--path', root, '--json']);
    const body = JSON.parse(r.stdout) as GrepResult;
    expect(body.matches.some((m) => m.path.startsWith('node_modules/'))).toBe(false);
    expect(body.stats.files_skipped).toBeGreaterThan(0);
  });

  it('--no-default-ignore 放开内置忽略', async () => {
    const r = await run(['grep', 'needle', '--path', root, '--glob', 'node_modules/*.ts', '--no-default-ignore', '--json']);
    const body = JSON.parse(r.stdout) as GrepResult;
    expect(body.matches.map((m) => m.path)).toEqual(['node_modules/m.ts']);
  });

  it('隐藏项默认跳过，--hidden 纳入', async () => {
    const off = await run(['grep', 'needle', '--path', root, '--json']);
    expect((JSON.parse(off.stdout) as GrepResult).matches.some((m) => m.path.includes('.hidden'))).toBe(false);
    const on = await run(['grep', 'needle', '--path', root, '--hidden', '--glob', '**/*.ts', '--json']);
    expect((JSON.parse(on.stdout) as GrepResult).matches.some((m) => m.path === '.hidden/h.ts')).toBe(true);
  });

  it('--glob 是包含过滤：给 *.ts 时 js 文件不出现', async () => {
    const r = await run(['grep', 'needle', '--path', join(root, 'src'), '--glob', '*.ts', '--json']);
    const paths = (JSON.parse(r.stdout) as GrepResult).matches.map((m) => m.path);
    expect(paths).toContain('a.ts');
    expect(paths).toContain('sub/c.ts');
    expect(paths).not.toContain('b.js');
  });

  it('--ignore 同时剪枝目录与文件：*.ts 排除后只剩 js', async () => {
    const r = await run(['grep', 'needle', '--path', join(root, 'src'), '--ignore', '*.ts', '--json']);
    const paths = (JSON.parse(r.stdout) as GrepResult).matches.map((m) => m.path);
    expect(paths).toEqual(['b.js']);
  });

  it('--glob 与 --ignore 叠加：先包含后排除', async () => {
    const r = await run(['grep', 'needle', '--path', join(root, 'src'), '--glob', '*.ts', '--ignore', 'sub/**', '--json']);
    const paths = new Set((JSON.parse(r.stdout) as GrepResult).matches.map((m) => m.path));
    expect([...paths]).toEqual(['a.ts']);
  });

  it('-i 大小写不敏感', async () => {
    const sensitive = await run(['grep', 'needle', '--path', join(root, 'src'), '--glob', 'sub/*.ts', '--json']);
    const sensitiveBody = JSON.parse(sensitive.stdout) as GrepResult;
    expect(sensitiveBody.matches.map((m) => m.line)).toEqual([2]);
    const insensitive = await run(['grep', 'needle', '--path', join(root, 'src'), '--glob', 'sub/*.ts', '-i', '--json']);
    expect((JSON.parse(insensitive.stdout) as GrepResult).matches.length).toBe(2);
  });

  it('--fixed-strings 按字面量匹配', async () => {
    const literal = await run(['grep', 'a.b', '--path', root, '--glob', 'literal.ts', '--fixed-strings', '--json']);
    expect((JSON.parse(literal.stdout) as GrepResult).matches.map((m) => m.line)).toEqual([1]);
    const regex = await run(['grep', 'a.b', '--path', root, '--glob', 'literal.ts', '--json']);
    expect((JSON.parse(regex.stdout) as GrepResult).matches.map((m) => m.line)).toEqual([1, 2]);
  });
});

describe('截断与上限（不算错误）', () => {
  it('--max-matches 截断：truncated 如实反映，退出码 0', async () => {
    const r = await run(['grep', 'needle', '--path', root, '--glob', '*.ts', '--max-matches', '1', '--json']);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout) as GrepResult;
    expect(body.matches.length).toBe(1);
    expect(body.truncated).toEqual({ hit: true, reason: 'max_matches' });
    expect(r.stderr).toContain('--max-matches');
  });

  it('--max-count 限制单文件条数', async () => {
    const r = await run(['grep', 'needle', '--path', root, '--glob', 'many.ts', '--max-count', '1', '--json']);
    expect((JSON.parse(r.stdout) as GrepResult).matches.length).toBe(1);
  });

  it('超时截断不算错误：runGrep 返回 timeout 标志且不抛', () => {
    let calls = 0;
    const run1 = runGrep(
      { root, pattern: 'needle', timeoutMs: 1000 },
      { now: () => (calls++ === 0 ? 0 : 10_000) },
    );
    expect(run1.result.truncated).toEqual({ hit: true, reason: 'timeout' });
    expect(run1.warnings.join('')).toContain('--timeout');
  });

  it('--max-file-size 跳过超限文件（不计命中）', async () => {
    const r = await run(['grep', 'needle', '--path', root, '--glob', 'big.ts', '--max-file-size', '10', '--json']);
    expect(r.code).toBe(1);
    const body = JSON.parse(r.stdout) as GrepResult;
    expect(body.matches).toEqual([]);
    expect(body.stats.files_skipped).toBe(1);
  });
});

describe('二进制与编码', () => {
  it('二进制（前 8 KiB 含 NUL）默认跳过', async () => {
    const r = await run(['grep', 'needle', '--path', root, '--glob', 'bin.dat', '--json']);
    expect(r.code).toBe(1);
    const body = JSON.parse(r.stdout) as GrepResult;
    expect(body.matches).toEqual([]);
    expect(body.stats.files_skipped).toBe(1);
  });

  it('--binary list 仅在路径命中模式时列出（text 为空）', async () => {
    const hit = await run(['grep', 'bin', '--path', root, '--glob', 'bin.dat', '--binary', 'list', '--json']);
    expect(hit.code).toBe(0);
    const body = JSON.parse(hit.stdout) as GrepResult;
    expect(body.matches.length).toBe(1);
    expect(body.matches[0]!.text).toBe('');
    const miss = await run(['grep', 'needle', '--path', root, '--glob', 'bin.dat', '--binary', 'list', '--json']);
    expect(miss.code).toBe(1);
  });

  it('BOM 剥离 + CRLF 去 \\r，行号不偏移', async () => {
    const r = await run(['grep', 'needle', '--path', root, '--glob', 'crlf.ts', '--json']);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout) as GrepResult;
    expect(body.matches.length).toBe(1);
    expect(body.matches[0]!.line).toBe(2);
    expect(body.matches[0]!.column).toBe(1);
    expect(body.matches[0]!.text).toBe('needle here');
    expect(body.matches[0]!.text.includes('\r')).toBe(false);
  });

  it('^ 锚点不被 BOM 破坏', async () => {
    const r = await run(['grep', '^first$', '--path', root, '--glob', 'crlf.ts', '--json']);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as GrepResult).matches[0]!.line).toBe(1);
  });

  it('超长行截断展示但不抛异常', async () => {
    const r = await run(['grep', 'needle', '--path', root, '--glob', 'long.ts', '--json']);
    expect(r.code).toBe(0);
    const text = (JSON.parse(r.stdout) as GrepResult).matches[0]!.text;
    expect(text.length).toBeLessThanOrEqual(4001);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('异常文件不中断整轮', () => {
  it('EACCES/EBUSY：读失败计入 files_skipped，其余文件照常命中', () => {
    const locked = join(root, 'src', 'a.ts');
    const run1 = runGrep(
      { root: join(root, 'src'), pattern: 'needle', globs: ['*.ts'] },
      {
        readFile: (path) => {
          if (path === locked) {
            const err = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException;
            err.code = 'EBUSY';
            throw err;
          }
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          return Buffer.from('needle elsewhere\n');
        },
      },
    );
    expect(run1.result.matches.some((m) => m.path === 'a.ts')).toBe(false);
    expect(run1.result.matches.some((m) => m.path === 'sub/c.ts')).toBe(true);
    expect(run1.result.stats.files_skipped).toBe(1);
    expect(run1.warnings.join('')).toContain('无权限或被占用');
  });

  it('符号链接不跟随（不抛环错误）', async () => {
    let linked = false;
    try {
      symlinkSync(join(root, 'src'), join(root, 'loop-link'), 'junction');
      linked = true;
    } catch {
      linked = false;
    }
    if (!linked) return;
    const r = await run(['grep', 'needle', '--path', root, '--json']);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as GrepResult).matches.some((m) => m.path.startsWith('loop-link/'))).toBe(false);
  });
});

describe('--help', () => {
  it('参数与语义说明完整', async () => {
    const r = await run(['grep', '--help']);
    expect(r.code).toBe(0);
    for (const token of ['--path', '--glob', '--ignore', '--no-default-ignore', '--hidden', '--fixed-strings',
      '--max-matches', '--max-file-size', '--timeout', '--binary', '不读 .gitignore', '退出码（本地命令例外）']) {
      expect(r.stdout).toContain(token);
    }
  });
});
