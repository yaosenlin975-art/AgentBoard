/**
 * P1-C：persona L2 标记块服务单测（services/personaInjection.ts）。
 * 覆盖：文件名映射、sanitizer、apply 幂等重写（原位替换不叠加、其它内容保留）、
 * rollback 精确移除（删本会话块保留他人块、删空文件、无块/无文件空操作）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyPersonaBlock,
  personaBlockFileFor,
  personaBlockPathFor,
  rollbackPersonaBlock,
  sanitizePersonaBody,
} from '../src/services/personaInjection.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'agentboard-block-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

const sessionA = { id: 'session-aaa', cli: 'codebuddy' };
const sessionB = { id: 'session-bbb', cli: 'codebuddy' };

function blockOf(sessionId: string, body: string): string {
  return `<!-- BEGIN AGENTBOARD-SESSION:${sessionId} -->\n${body}\n<!-- END AGENTBOARD-SESSION:${sessionId} -->`;
}

describe('personaBlockFileFor', () => {
  it('codebuddy → CODEBUDDY.md；claude 系 → CLAUDE.md；其余 → AGENTS.md', () => {
    expect(personaBlockFileFor('codebuddy')).toBe('CODEBUDDY.md');
    expect(personaBlockFileFor('claude')).toBe('CLAUDE.md');
    expect(personaBlockFileFor('claude-code')).toBe('CLAUDE.md');
    expect(personaBlockFileFor('codex')).toBe('AGENTS.md');
    expect(personaBlockFileFor('opencode')).toBe('AGENTS.md');
    expect(personaBlockFileFor('dsh')).toBe('AGENTS.md');
  });
});

describe('sanitizePersonaBody', () => {
  it('剥掉 <!-- 与 -->（循环剥到不再出现）与行首 </，其余原样', () => {
    expect(sanitizePersonaBody('普通 正文')).toBe('普通 正文');
    expect(sanitizePersonaBody('a<!--b-->c')).toBe('abc');
    // 剥除后拼接出新的边界序列也要被继续剥掉
    expect(sanitizePersonaBody('<!-<!---->-->-')).not.toContain('<!--');
    expect(sanitizePersonaBody('行一\n</div>\n</span 保持')).toBe('行一\ndiv>\nspan 保持');
    expect(sanitizePersonaBody('行内 </tag> 保留')).toBe('行内 </tag> 保留');
  });
});

describe('applyPersonaBlock', () => {
  it('文件不存在 → 创建并写入带边界的块', () => {
    applyPersonaBlock(sessionA, { id: 'p1', body: '你是审查者' }, workdir);
    const filePath = personaBlockPathFor(sessionA, workdir);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe(`${blockOf('session-aaa', '你是审查者')}\n`);
  });

  it('同会话重复 apply 原位替换（不叠加），sanitizer 生效', () => {
    applyPersonaBlock(sessionA, { id: 'p1', body: '第一版' }, workdir);
    applyPersonaBlock(sessionA, { id: 'p1', body: '第二版 <!-- 逃逸 -->\n</script' }, workdir);
    const content = readFileSync(personaBlockPathFor(sessionA, workdir), 'utf8');
    // `<!--`/`-->` 剥除后留空位（前后空格保留）；行首 `</script` 剥成 `script`
    expect(content).toBe(`${blockOf('session-aaa', '第二版  逃逸 \nscript')}\n`);
    expect(content.match(/BEGIN AGENTBOARD-SESSION:session-aaa/g)).toHaveLength(1);
    expect(content.match(/END AGENTBOARD-SESSION:session-aaa/g)).toHaveLength(1);
  });

  it('多会话块共存；apply 会话 B 不影响会话 A 的块', () => {
    applyPersonaBlock(sessionA, { id: 'p1', body: 'A 正文' }, workdir);
    applyPersonaBlock(sessionB, { id: 'p2', body: 'B 正文' }, workdir);
    const content = readFileSync(personaBlockPathFor(sessionA, workdir), 'utf8');
    expect(content).toContain(blockOf('session-aaa', 'A 正文'));
    expect(content).toContain(blockOf('session-bbb', 'B 正文'));
    applyPersonaBlock(sessionA, { id: 'p1', body: 'A 新正文' }, workdir);
    const after = readFileSync(personaBlockPathFor(sessionA, workdir), 'utf8');
    expect(after).toContain(blockOf('session-aaa', 'A 新正文'));
    expect(after).toContain(blockOf('session-bbb', 'B 正文'));
  });

  it('既有非空文件追加块并保留原内容；既有块外的同文本不动', () => {
    mkdirSync(workdir, { recursive: true });
    writeFileSync(personaBlockPathFor(sessionA, workdir), '# 项目说明\n\n原有内容', 'utf8');
    applyPersonaBlock(sessionA, { id: 'p1', body: '注入正文' }, workdir);
    const content = readFileSync(personaBlockPathFor(sessionA, workdir), 'utf8');
    expect(content.startsWith('# 项目说明\n\n原有内容\n')).toBe(true);
    expect(content).toContain(blockOf('session-aaa', '注入正文'));
  });
});

describe('rollbackPersonaBlock', () => {
  it('精确移除本会话块，保留前置内容与其它会话块', () => {
    applyPersonaBlock(sessionA, { id: 'p1', body: 'A 正文' }, workdir);
    applyPersonaBlock(sessionB, { id: 'p2', body: 'B 正文' }, workdir);
    rollbackPersonaBlock(sessionA, workdir);
    const content = readFileSync(personaBlockPathFor(sessionA, workdir), 'utf8');
    expect(content).not.toContain('AGENTBOARD-SESSION:session-aaa');
    expect(content).toContain(blockOf('session-bbb', 'B 正文'));
  });

  it('文件因此为空 → 删文件；无块 / 文件不存在 → 空操作', () => {
    applyPersonaBlock(sessionA, { id: 'p1', body: 'A 正文' }, workdir);
    const filePath = personaBlockPathFor(sessionA, workdir);
    rollbackPersonaBlock(sessionA, workdir);
    expect(existsSync(filePath)).toBe(false);

    // 无块：文件原样保留
    writeFileSync(filePath, '# 保留', 'utf8');
    rollbackPersonaBlock(sessionA, workdir);
    expect(readFileSync(filePath, 'utf8')).toBe('# 保留');

    // 文件不存在：不抛错
    rmSync(filePath);
    expect(() => rollbackPersonaBlock(sessionA, workdir)).not.toThrow();
  });

  it('rollback 会话 B 不动会话 A 的块', () => {
    applyPersonaBlock(sessionA, { id: 'p1', body: 'A 正文' }, workdir);
    applyPersonaBlock(sessionB, { id: 'p2', body: 'B 正文' }, workdir);
    rollbackPersonaBlock(sessionB, workdir);
    const content = readFileSync(personaBlockPathFor(sessionA, workdir), 'utf8');
    expect(content).toContain(blockOf('session-aaa', 'A 正文'));
    expect(content).not.toContain('AGENTBOARD-SESSION:session-bbb');
  });
});
