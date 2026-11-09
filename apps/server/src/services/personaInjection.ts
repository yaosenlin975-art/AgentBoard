/**
 * P1-C：persona 的 L2 标记块注入服务（personaInjection='file' 时走这里，不走 CLI flag）。
 *
 * 目标文件按 adapter id 映射：codebuddy → CODEBUDDY.md、claude 系 → CLAUDE.md、其余 → AGENTS.md；
 * 文件落在工作区根（workdir）。块边界：
 *   <!-- BEGIN AGENTBOARD-SESSION:<sessionId> -->
 *   <persona 正文（经 sanitize）>
 *   <!-- END AGENTBOARD-SESSION:<sessionId> -->
 * 同一会话重复 apply 原位替换（不叠加）；rollback 精确移除本会话块，移除后文件为空则删文件
 * （空文件只可能是本服务创建——文件里有其它内容时剩余部分原样保留）。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** adapter id → 工作区根标记块文件名 */
export function personaBlockFileFor(adapterId: string): string {
  const id = adapterId.toLowerCase();
  if (id === 'codebuddy') return 'CODEBUDDY.md';
  if (id.startsWith('claude')) return 'CLAUDE.md';
  return 'AGENTS.md';
}

/**
 * persona 正文 sanitizer：剥掉内容里的 `<!--` / `-->` 与行首 `</`（防逃逸出会话块边界），其余原样。
 * 剥除可能拼出新边界序列（如 `<!-` + `--`），循环剥到不再出现为止。
 */
export function sanitizePersonaBody(body: string): string {
  let out = body;
  while (out.includes('<!--') || out.includes('-->')) {
    out = out.split('<!--').join('').split('-->').join('');
  }
  return out
    .split('\n')
    .map((line) => (line.startsWith('</') ? line.slice(2) : line))
    .join('\n');
}

function blockMarkers(sessionId: string): { begin: string; end: string } {
  return {
    begin: `<!-- BEGIN AGENTBOARD-SESSION:${sessionId} -->`,
    end: `<!-- END AGENTBOARD-SESSION:${sessionId} -->`,
  };
}

/** 工作区根标记块文件的绝对路径（按会话的 cli 映射文件名） */
export function personaBlockPathFor(session: { cli: string }, workdir: string): string {
  return join(workdir, personaBlockFileFor(session.cli));
}

export interface PersonaBlockInput {
  id: string;
  body: string;
}

/**
 * 写/替换本会话的 persona 标记块：文件不存在 → 创建；已有同 id 块 → 原位替换；
 * 其余内容（含其它会话的块）原样保留。
 */
export function applyPersonaBlock(session: { id: string; cli: string }, persona: PersonaBlockInput, workdir: string): void {
  const filePath = personaBlockPathFor(session, workdir);
  const { begin, end } = blockMarkers(session.id);
  const block = `${begin}\n${sanitizePersonaBody(persona.body)}\n${end}`;
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';

  let next: string;
  const beginIdx = existing.indexOf(begin);
  const endIdx = beginIdx >= 0 ? existing.indexOf(end, beginIdx) : -1;
  if (beginIdx >= 0 && endIdx >= 0) {
    // 原位替换本会话块（end 之后残留同一 begin 的旧块视为损坏数据，只替换第一对）
    next = existing.slice(0, beginIdx) + block + existing.slice(endIdx + end.length);
  } else {
    next = existing === '' ? block : `${existing.endsWith('\n') ? existing : `${existing}\n`}${block}`;
  }
  writeFileSync(filePath, next.endsWith('\n') || next === '' ? next : `${next}\n`, 'utf8');
}

/**
 * 精确移除本会话的标记块：只删 begin..end（含）这一段，其余内容不动；
 * 移除后剩余内容为空白 → 删文件（该文件只承载过本块）。无块/文件不存在 → 原样返回。
 */
export function rollbackPersonaBlock(session: { id: string; cli: string }, workdir: string): void {
  const filePath = personaBlockPathFor(session, workdir);
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, 'utf8');
  const { begin, end } = blockMarkers(session.id);
  const beginIdx = content.indexOf(begin);
  if (beginIdx < 0) return;
  const endIdx = content.indexOf(end, beginIdx);
  if (endIdx < 0) return;
  const remaining = content.slice(0, beginIdx) + content.slice(endIdx + end.length);
  if (remaining.trim() === '') {
    rmSync(filePath);
    return;
  }
  writeFileSync(filePath, remaining, 'utf8');
}
