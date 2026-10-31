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
4. 全部完成后执行 \`kb done {{issue_id}}\`；无法完成执行 \`kb fail {{issue_id}} --reason "..."。`;

export interface DispatchPromptVars {
  issue_id: string;
  title: string;
  description: string;
  workspace_path: string;
}

/** {{var}} 渲染；description 为空给"(空)"（与服务端行为一致） */
export function renderDispatchPrompt(template: string, vars: DispatchPromptVars): string {
  return template
    .replaceAll('{{issue_id}}', vars.issue_id)
    .replaceAll('{{title}}', vars.title)
    .replaceAll('{{description}}', vars.description.trim() === '' ? '(空)' : vars.description)
    .replaceAll('{{workspace_path}}', vars.workspace_path);
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
