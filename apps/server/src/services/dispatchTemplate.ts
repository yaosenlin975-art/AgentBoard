/**
 * ARCH-05：派发 prompt 模板外置与启动期校验。
 *
 * 解析顺序（启动期一次，运行期不重新读盘）：
 * 1. env `AGENTBOARD_DISPATCH_PROMPT`：模板文件路径，优先于数据目录默认文件；
 * 2. 数据目录下的 `dispatch-prompt.md`（数据目录 = configDir()，默认 `%APPDATA%\AgentBoard`）；
 * 3. 不存在（或 env 指向的文件不存在）→ 内置默认模板（逐字等于改造前的 DISPATCH_PROMPT_TEMPLATE）。
 *
 * 文件存在但缺必需占位符 → 抛错，启动失败（不静默回退默认值）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 内置默认派发模板（逐字保留改造前内容；`{{var}}` 由 renderPrompt 渲染） */
export const DEFAULT_DISPATCH_PROMPT_TEMPLATE = `你是任务看板的执行 agent。
任务 ID：{{issue_id}}
标题：{{title}}
描述：
{{description}}
工作目录：{{workspace_path}}（你的当前工作目录即此）
规则：
1. 任务内容以 \`kb show {{issue_id}}\` 实时返回为准，开工前与关键节点重新拉取。
2. 用户在评论区的留言视为补充指令，经 \`kb show\` 读取最新评论。
3. 关键节点（开工、受阻、阶段性完成）用 \`kb comment {{issue_id}} "..."\` 写进展总结。
4. 全部完成后执行 \`kb done {{issue_id}}\`；无法完成执行 \`kb fail {{issue_id}} --reason "..."\`。
5. 有可复用结论（踩坑、验证方法、接口事实、口径裁决）时写或更新一条工作区知识页（\`kb knowledge create --scope workspace --workspace {{workspace_id}} --domain knowledge --stdin\`；\`--domain\` 必填，取值 accounts|knowledge|board|chat|ui|infra，按任务所属域替换，不确定用 knowledge）：正文写可复用的设计与坑，不写进度与流水账；同主题已存在时用 \`kb knowledge revise\` 更新，不新建重复页。无可复用结论时在 \`kb done --notes\` 声明原因。`;

/** 数据目录下的模板文件名 */
export const DISPATCH_PROMPT_FILE_NAME = 'dispatch-prompt.md';

/** env 覆盖：模板文件路径（优先于数据目录默认文件） */
export const DISPATCH_PROMPT_ENV = 'AGENTBOARD_DISPATCH_PROMPT';

/**
 * 必需占位符：取自内置模板实际用到的 `{{...}}`。模板缺任一即拒绝启动。
 * 新增模板变量时须同步 renderPrompt（services/dispatch.ts）与本文档清单。
 */
export const REQUIRED_PLACEHOLDERS = ['{{issue_id}}', '{{title}}', '{{description}}', '{{workspace_path}}', '{{workspace_id}}'] as const;

/** 合法占位符完整清单（= renderPrompt 支持的全部替换项） */
export const KNOWN_PLACEHOLDERS = [...REQUIRED_PLACEHOLDERS] as const;

export interface LoadedDispatchPromptTemplate {
  /** 实际生效的模板正文（不含 BOM） */
  template: string;
  /** file = 读自文件；default = 内置默认 */
  source: 'file' | 'default';
  /** 候选文件路径（source=default 时也给出，便于排障） */
  path: string;
  /** 非致命提示（如 env 指向的文件不存在、回落内置默认） */
  warning?: string;
}

export interface LoadDispatchPromptTemplateOptions {
  /** 环境变量来源（缺省 process.env；测试注入） */
  env?: NodeJS.ProcessEnv;
  /** 数据目录（生产传 configDir()） */
  dataDir: string;
}

function readAndValidate(path: string): LoadedDispatchPromptTemplate {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `派发 prompt 模板读取失败：${path}（${error instanceof Error ? error.message : String(error)}）`,
      { cause: error },
    );
  }
  // 约定 UTF-8 无 BOM；带 BOM 时剥掉，避免首个占位符前出现不可见字符
  const template = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const missing = REQUIRED_PLACEHOLDERS.filter((placeholder) => !template.includes(placeholder));
  if (missing.length > 0) {
    throw new Error(`派发 prompt 模板缺少必需占位符：${missing.join(', ')}（文件：${path}）`);
  }
  return { template, source: 'file', path };
}

/**
 * 解析并校验派发模板。文件存在但坏（缺占位符/读取失败）→ 抛错；文件不存在 → 内置默认。
 */
export function loadDispatchPromptTemplate(options: LoadDispatchPromptTemplateOptions): LoadedDispatchPromptTemplate {
  const env = options.env ?? process.env;
  const override = (env[DISPATCH_PROMPT_ENV] ?? '').trim();
  if (override !== '') {
    const path = resolve(override);
    if (!existsSync(path)) {
      return {
        template: DEFAULT_DISPATCH_PROMPT_TEMPLATE,
        source: 'default',
        path,
        warning: `${DISPATCH_PROMPT_ENV} 指向的模板文件不存在，使用内置默认模板：${path}`,
      };
    }
    return readAndValidate(path);
  }
  const defaultPath = join(options.dataDir, DISPATCH_PROMPT_FILE_NAME);
  if (!existsSync(defaultPath)) {
    return { template: DEFAULT_DISPATCH_PROMPT_TEMPLATE, source: 'default', path: defaultPath };
  }
  return readAndValidate(defaultPath);
}
