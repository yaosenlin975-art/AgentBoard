/**
 * 派发 prompt 模板常量与前端渲染（设计 §5.2）。
 * 与服务端 `apps/server/src/services/dispatch.ts` 的 DISPATCH_PROMPT_TEMPLATE 逐字一致；
 * 弹窗 textarea 预填前端渲染后的全文，历史备注段由后端 dispatch.ts 自动追加（最近 10 条）。
 */

export const DISPATCH_PROMPT_TEMPLATE = `你是任务看板的执行 agent。
任务 ID：{{issue_id}}
标题：{{title}}
描述：
{{description}}
工作目录：{{workspace_path}}（你的当前工作目录即此）
规则：
1. 任务内容以 \`kb show {{issue_id}}\` 实时返回为准，开工前与关键节点重新拉取。
2. 用户在评论区的留言视为补充指令，经 \`kb show\` 读取最新评论。
3. 关键节点（开工、受阻、阶段性完成）用 \`kb comment {{issue_id}} "..."\` 写进展总结。
4. 全部完成后执行 \`kb done {{issue_id}}\`；无法完成执行 \`kb fail {{issue_id}} --reason "..."。
5. 完成前必须写一条知识页（\`kb knowledge create --slug handoff-{{issue_id}} --scope workspace --workspace {{workspace_id}} --stdin\`）：正文写本次任务的目标、关键决策与取舍、验证方式与结果、未验证项与剩余风险；不写流水账、不写变更日志式条目。同 slug 已存在时更新该页，不新建重复页。`;

export interface DispatchPromptVars {
  issue_id: string;
  title: string;
  description: string;
  workspace_path: string;
  workspace_id: string;
}

/** {{var}} 渲染；description 为空给"(空)"（与服务端行为一致） */
export function renderDispatchPrompt(template: string, vars: DispatchPromptVars): string {
  return template
    .replaceAll('{{issue_id}}', vars.issue_id)
    .replaceAll('{{title}}', vars.title)
    .replaceAll('{{description}}', vars.description.trim() === '' ? '(空)' : vars.description)
    .replaceAll('{{workspace_path}}', vars.workspace_path)
    .replaceAll('{{workspace_id}}', vars.workspace_id);
}

/** 历史备注段上限：与服务端 HISTORY_NOTE_LIMIT 一致（最近 10 条） */
export const HISTORY_NOTE_LIMIT = 10;

/**
 * 历史备注段：最近 10 条评论 ts 升序，每行 `- [author] content`；无评论返回 null（整段省略）。
 * 与服务端 dispatch.ts renderHistoryNotes 输出逐字符一致（GET comments 返回 ts 升序，slice(-10) 即最近 10 条）。
 */
export function renderHistoryNotes(
  comments: Array<{ author: string; content: string; ts: number }>,
): string | null {
  const recent = [...comments].sort((a, b) => a.ts - b.ts).slice(-HISTORY_NOTE_LIMIT);
  if (recent.length === 0) return null;
  return `## 历史备注\n${recent.map((c) => `- [${c.author}] ${c.content}`).join('\n')}`;
}

/** 该 CLI 上次使用的模型（localStorage 键）；无记录返回 null */
export function lastModelKey(cliId: string): string {
  return `agentboard.last-model.${cliId}`;
}

export function loadLastModel(cliId: string): string | null {
  return localStorage.getItem(lastModelKey(cliId));
}

export function saveLastModel(cliId: string, model: string): void {
  localStorage.setItem(lastModelKey(cliId), model);
}
