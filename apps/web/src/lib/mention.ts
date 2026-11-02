/**
 * 聊天联想输入（CHAT-MENTION）纯函数层：触发检测、模糊匹配、插入。
 *
 * 触发规则（用户已确认口径）：
 * - 只在 token 起始位置触发：`/` 或 `@` 位于文本开头，或前一个字符是空白；
 * - 触发符之后到光标之间**不能含空白/换行**（含则视为该 token 已结束，浮窗关闭）；
 * - `/` 匹配技能名，`@` 匹配当前工作区任务的标题与 id；
 * - 无匹配时调用方关闭浮窗，不阻塞输入。
 * 选中后只插入文本（`/skill-name` 或 `@任务标题`），不拼正文、不改发送链路。
 */

export type MentionKind = 'skill' | 'issue';

export interface MentionTrigger {
  kind: MentionKind;
  /** 触发符之后的查询串（可为空串：刚打出 `/` 时列出全部候选） */
  query: string;
  /** 触发符在文本中的下标 */
  start: number;
  /** 光标位置（替换区间的右端） */
  end: number;
}

export interface MentionCandidate {
  id: string;
  /** 展示文本 */
  label: string;
  /** 次要说明（描述 / 任务 id 等） */
  hint?: string;
  /** 选中后插入消息的文本 */
  insert: string;
}

const TRIGGER_CHAR: Record<string, MentionKind> = { '/': 'skill', '@': 'issue' };
const isSpace = (ch: string): boolean => ch === '' || /\s/.test(ch);

/**
 * 检测光标处的联想触发。返回 null 表示当前不处于任何联想场景（含：非 token 起始、查询串含空白）。
 */
export function detectMentionTrigger(text: string, caret: number): MentionTrigger | null {
  const pos = Math.max(0, Math.min(caret, text.length));
  // 从光标往前找最近的触发符；遇到空白即说明当前 token 不是从触发符开始
  for (let i = pos - 1; i >= 0; i -= 1) {
    const ch = text[i]!;
    if (ch === '/' || ch === '@') {
      const kind = TRIGGER_CHAR[ch]!;
      const before = i === 0 ? '' : text[i - 1]!;
      if (!isSpace(before)) return null; // 词中间的 / 或 @（如 a/b、mail@host）不触发
      return { kind, query: text.slice(i + 1, pos), start: i, end: pos };
    }
    if (/\s/.test(ch)) return null; // 遇到空白：token 起点不含触发符
    // 中文按字符继续向前找，不额外处理
  }
  return null;
}

const normalize = (s: string): string => s.toLowerCase();

export interface FuzzyScore {
  score: number;
  /** 命中的字段：label 优先，id 次之 */
  matched: 'label' | 'id';
}

/**
 * 模糊匹配打分（大小写不敏感）：
 * - 空查询 → 0 分（全部保留，保持原始顺序）；
 * - 前缀命中 → 1000 - 多余长度（越短越靠前）；
 * - 子序列命中 → 600 - 跨度惩罚（越紧凑越靠前）；
 * - 不命中 → null（过滤掉）。
 * 任务额外允许用 id 命中（拉丁 id 常用于精确定位）。
 */
export function fuzzyScore(label: string, query: string, id = ''): FuzzyScore | null {
  if (query === '') return { score: 0, matched: 'label' };
  const q = normalize(query);
  const text = normalize(label);
  if (text.startsWith(q)) return { score: 1000 - (text.length - q.length), matched: 'label' };
  const sub = subsequenceScore(text, q);
  if (sub !== null) return { score: 600 - sub, matched: 'label' };
  if (id !== '') {
    const idText = normalize(id);
    if (idText.startsWith(q)) return { score: 900 - (idText.length - q.length), matched: 'id' };
    const idSub = subsequenceScore(idText, q);
    if (idSub !== null) return { score: 500 - idSub, matched: 'id' };
  }
  return null;
}

/** 子序列命中：返回跨度惩罚（首末命中位置差 - 查询长度，越小越紧凑）；不命中返回 null */
function subsequenceScore(text: string, query: string): number | null {
  let first = -1;
  let last = -1;
  let cursor = 0;
  for (const ch of query) {
    const idx = text.indexOf(ch, cursor);
    if (idx < 0) return null;
    if (first < 0) first = idx;
    last = idx;
    cursor = idx + 1;
  }
  return last - first - (query.length - 1);
}

/** 过滤 + 排序候选（稳定：同分按 label 字典序），最多 limit 条 */
export function rankMentionCandidates(
  candidates: MentionCandidate[],
  query: string,
  limit = 8,
): MentionCandidate[] {
  const scored: Array<{ candidate: MentionCandidate; score: number }> = [];
  for (const candidate of candidates) {
    const hit = fuzzyScore(candidate.label, query, candidate.id);
    if (hit === null) continue;
    scored.push({ candidate, score: hit.score });
  }
  scored.sort((a, b) => b.score - a.score || a.candidate.label.localeCompare(b.candidate.label));
  return scored.slice(0, limit).map((s) => s.candidate);
}

/**
 * 把触发区间替换为插入文本。`/` 后补技能名、`@` 后补任务标题，其余内容原样保留。
 * 返回新文本与新光标位置（插入文本之后）。
 */
export function insertMention(
  text: string,
  trigger: Pick<MentionTrigger, 'start' | 'end'>,
  insert: string,
): { text: string; caret: number } {
  const before = text.slice(0, trigger.start);
  const after = text.slice(trigger.end);
  const nextText = `${before}${insert}${after}`;
  return { text: nextText, caret: before.length + insert.length };
}

/** 技能 → 候选（插入 `/name`） */
export function skillCandidates(skills: Array<{ name: string; description?: string | null }>): MentionCandidate[] {
  return skills
    .filter((s) => typeof s.name === 'string' && s.name.trim() !== '')
    .map((s) => ({
      id: s.name,
      label: s.name,
      ...(s.description ? { hint: s.description } : {}),
      insert: `/${s.name}`,
    }));
}

/** 任务 → 候选（插入 `@标题`） */
export function issueCandidates(
  issues: Array<{ id: string; title: string; status?: string }>,
  excludedIssueId?: string | null,
): MentionCandidate[] {
  return issues
    .filter((i) => typeof i.title === 'string' && i.title.trim() !== '' && i.id !== excludedIssueId)
    .map((i) => ({
      id: i.id,
      label: i.title,
      hint: i.id.slice(0, 8),
      insert: `@${i.title}`,
    }));
}
