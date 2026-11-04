import type { Command } from 'commander';
import { request } from '../api.js';
import type { Ctx } from '../io.js';
import { resolveWorkspaceId } from '../workspace.js';

/** LOG02：工作区变更日志 CLI（复用 LOG01 的活动/归档 REST 与导入服务端点，不重复实现业务逻辑） */

interface ChangeLogRecord {
  id: string;
  workspace_id: string | null;
  origin_workspace_id: string;
  origin_workspace_name: string;
  origin_workspace_path: string;
  title: string;
  body_md: string;
  change_type: string;
  occurred_at: number;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
  revision: number;
  legacy_source_key: string | null;
}

interface PageResponse<T> { items: T[]; next_offset: number | null }

interface ArchivedWorkspace {
  origin_workspace_id: string;
  origin_workspace_name: string;
  origin_workspace_path: string;
  entry_count: number;
  last_occurred_at: number;
}

interface ImportEntry { source_key: string; occurred_at: number; title: string; body_md: string }
interface ImportPreview {
  workspace_id: string;
  source_path: string;
  source_sha256: string;
  entry_count: number;
  parsed: ImportEntry[];
  unparsable: { line: number; text: string }[];
  added: ImportEntry[];
  already_imported: ImportEntry[];
  conflicting: ImportEntry[];
}
interface ImportApplyResult { imported: number; receipt_id: string; source_sha256: string }
interface RetireVerdict {
  can_retire: boolean;
  reason: string;
  source_sha256: string;
  receipt: { id: string; entry_count: number; imported_at: number } | null;
  entry_count: number;
  added: ImportEntry[];
  already_imported: ImportEntry[];
  conflicting: ImportEntry[];
  unparsable: { line: number; text: string }[];
}

const TIME = (ms: number): string => {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};
const query = (params: Record<string, string | number | undefined>): string =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => [key, String(value)]),
  ).toString();

function printRecord(ctx: Ctx, record: ChangeLogRecord): void {
  const origin = record.workspace_id === null ? `（归档，原空间 ${record.origin_workspace_name}）` : '';
  ctx.io.write(`${record.id} [${record.change_type}] ${TIME(record.occurred_at)} rev:${record.revision} by:${record.updated_by}${origin}\n`);
  ctx.io.write(`${record.title}\n`);
  ctx.io.write(`${record.body_md}\n`);
}

function printPage(ctx: Ctx, page: PageResponse<ChangeLogRecord>): void {
  if (page.items.length === 0) {
    ctx.io.write('（无变更日志）\n');
  } else {
    for (const record of page.items) {
      ctx.io.write(`${record.id} [${record.change_type}] ${TIME(record.occurred_at)} rev:${record.revision} ${record.title}\n`);
    }
  }
  if (page.next_offset !== null) ctx.io.write(`下一页：--offset ${page.next_offset}\n`);
}

export function registerChangelogCommands(program: Command, context: () => Ctx): void {
  const changelog = program.command('changelog').description('工作区变更日志（活动工作区缺省按 cwd 解析，可用 --workspace 覆盖；归档读取需 --origin-workspace-id）');

  /** B：活动命令的 --workspace 可省略——缺省按 cwd 解析（与 list-tasks 同一解析器），显式值仍覆盖 */
  async function activeWorkspace(ctx: Ctx, value: string | undefined): Promise<string> {
    return resolveWorkspaceId(ctx.base, value === undefined || value.trim() === '' ? undefined : value);
  }
  const entriesPath = (workspaceId: string): string => `/api/workspaces/${encodeURIComponent(workspaceId)}/changelog`;
  const normalizeType = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const normalized = value.trim();
    if (!['新增', '修复', '调整', '历史'].includes(normalized)) throw new Error('类型只能是 新增|修复|调整|历史（历史仅由导入写入）');
    return normalized;
  };
  /** 正文：--body 与 --stdin 二选一 */
  async function bodyOf(ctx: Ctx, opts: { body?: string; stdin?: boolean }): Promise<string | undefined> {
    if (opts.stdin && opts.body !== undefined) throw new Error('正文 --body 与 --stdin 二选一，不能同时使用');
    if (opts.stdin) return ctx.io.readStdin();
    return opts.body;
  }

  changelog
    .command('list')
    .description('列出当前工作区变更日志（按发生时间倒序）')
    .option('--workspace <id|名>', '工作空间 id 或名称（缺省按 cwd 解析）')
    .option('--type <类型>', '新增|修复|调整|历史')
    .option('--query <text>', '标题/正文字面子串搜索')
    .option('--offset <n>', '分页偏移', '0')
    .option('--limit <n>', '分页数量', '50')
    .action(async (opts: { workspace: string; type?: string; query?: string; offset: string; limit: string }) => {
      const ctx = context();
      const workspaceId = await activeWorkspace(ctx, opts.workspace);
      const suffix = query({ change_type: normalizeType(opts.type), q: opts.query, offset: opts.offset, limit: opts.limit });
      const page = await request<PageResponse<ChangeLogRecord>>(ctx.base, 'GET', `${entriesPath(workspaceId)}?${suffix}`);
      if (ctx.json) ctx.io.write(`${JSON.stringify(page, null, 2)}\n`);
      else printPage(ctx, page);
    });

  changelog
    .command('show <id>')
    .description('查看单条变更日志')
    .option('--workspace <id|名>', '工作空间 id 或名称（缺省按 cwd 解析）')
    .action(async (id: string, opts: { workspace: string }) => {
      const ctx = context();
      const workspaceId = await activeWorkspace(ctx, opts.workspace);
      const record = await request<ChangeLogRecord>(ctx.base, 'GET', `${entriesPath(workspaceId)}/${encodeURIComponent(id)}`);
      if (ctx.json) ctx.io.write(`${JSON.stringify(record, null, 2)}\n`);
      else printRecord(ctx, record);
    });

  changelog
    .command('create')
    .description('新增变更日志（正文用 --body 或 --stdin；历史类型仅供导入）')
    .option('--workspace <id|名>', '工作空间 id 或名称（缺省按 cwd 解析）')
    .requiredOption('--title <title>', '标题')
    .requiredOption('--type <类型>', '新增|修复|调整')
    .option('--body <text>', '正文（Markdown）')
    .option('--stdin', '从 UTF-8 stdin 读取正文')
    .option('--occurred-at <ms>', '发生时间（Unix 毫秒，缺省当前时间）')
    .option('--request-id <uuid>', '幂等请求 id；重试时复用')
    .action(async (opts: { workspace: string; title: string; type: string; body?: string; stdin?: boolean; occurredAt?: string; requestId?: string }) => {
      const ctx = context();
      const workspaceId = await activeWorkspace(ctx, opts.workspace);
      const bodyMd = await bodyOf(ctx, opts);
      if (bodyMd === undefined || bodyMd.trim() === '') throw new Error('缺少正文：用 --body 或 --stdin 提供');
      const record = await request<ChangeLogRecord>(
        ctx.base,
        'POST',
        entriesPath(workspaceId),
        {
          title: opts.title,
          body_md: bodyMd,
          change_type: normalizeType(opts.type),
          ...(opts.occurredAt === undefined ? {} : { occurred_at: Number(opts.occurredAt) }),
          actor: ctx.agentId,
        },
        opts.requestId,
      );
      if (ctx.json) ctx.io.write(`${JSON.stringify(record, null, 2)}\n`);
      else printRecord(ctx, record);
    });

  changelog
    .command('update <id>')
    .description('修改变更日志（CAS：必须带当前 --expected-revision）')
    .option('--workspace <id|名>', '工作空间 id 或名称（缺省按 cwd 解析）')
    .requiredOption('--expected-revision <n>', '当前 revision（服务端 CAS）')
    .option('--title <title>', '新标题')
    .option('--type <类型>', '新类型：新增|修复|调整')
    .option('--body <text>', '新正文（Markdown）')
    .option('--stdin', '从 UTF-8 stdin 读取新正文')
    .option('--occurred-at <ms>', '新发生时间（Unix 毫秒）')
    .option('--request-id <uuid>', '幂等请求 id；重试时复用')
    .action(async (id: string, opts: { workspace: string; expectedRevision: string; title?: string; type?: string; body?: string; stdin?: boolean; occurredAt?: string; requestId?: string }) => {
      const ctx = context();
      const workspaceId = await activeWorkspace(ctx, opts.workspace);
      const bodyMd = await bodyOf(ctx, opts);
      const patch: Record<string, unknown> = {
        expected_revision: Number(opts.expectedRevision),
        actor: ctx.agentId,
      };
      if (opts.title !== undefined) patch.title = opts.title;
      if (opts.type !== undefined) patch.change_type = normalizeType(opts.type);
      if (bodyMd !== undefined) patch.body_md = bodyMd;
      if (opts.occurredAt !== undefined) patch.occurred_at = Number(opts.occurredAt);
      if (Object.keys(patch).length === 2) throw new Error('至少提供一个可修改字段：--title / --type / --body / --stdin / --occurred-at');
      const record = await request<ChangeLogRecord>(ctx.base, 'PATCH', `${entriesPath(workspaceId)}/${encodeURIComponent(id)}`, patch, opts.requestId);
      if (ctx.json) ctx.io.write(`${JSON.stringify(record, null, 2)}\n`);
      else printRecord(ctx, record);
    });

  changelog
    .command('delete <id>')
    .description('删除单条变更日志（CAS：必须带当前 --expected-revision）')
    .option('--workspace <id|名>', '工作空间 id 或名称（缺省按 cwd 解析）')
    .requiredOption('--expected-revision <n>', '当前 revision（服务端 CAS）')
    .option('--request-id <uuid>', '幂等请求 id；重试时复用')
    .action(async (id: string, opts: { workspace: string; expectedRevision: string; requestId?: string }) => {
      const ctx = context();
      const workspaceId = await activeWorkspace(ctx, opts.workspace);
      await request<void>(ctx.base, 'DELETE', `${entriesPath(workspaceId)}/${encodeURIComponent(id)}`, {
        expected_revision: Number(opts.expectedRevision),
        actor: ctx.agentId,
      }, opts.requestId);
      if (ctx.json) ctx.io.write(`${JSON.stringify({ deleted: true, id }, null, 2)}\n`);
      else ctx.io.write(`已删除变更日志: ${id}\n`);
    });

  changelog
    .command('archived-workspaces')
    .description('列出仍有变更日志的已移除工作区（只读）')
    .option('--offset <n>', '分页偏移', '0')
    .option('--limit <n>', '分页数量', '50')
    .action(async (opts: { offset: string; limit: string }) => {
      const ctx = context();
      const page = await request<PageResponse<ArchivedWorkspace>>(
        ctx.base,
        'GET',
        `/api/changelog/archived-workspaces?${query({ offset: opts.offset, limit: opts.limit })}`,
      );
      if (ctx.json) {
        ctx.io.write(`${JSON.stringify(page, null, 2)}\n`);
        return;
      }
      if (page.items.length === 0) ctx.io.write('（无归档变更日志）\n');
      for (const item of page.items) {
        ctx.io.write(`${item.origin_workspace_id} ${item.origin_workspace_name} ${item.entry_count} 条 最近 ${TIME(item.last_occurred_at)} ${item.origin_workspace_path}\n`);
      }
      if (page.next_offset !== null) ctx.io.write(`下一页：--offset ${page.next_offset}\n`);
    });

  changelog
    .command('list-archived')
    .description('读取指定已移除工作区的日志（只读；必须显式 --origin-workspace-id）')
    .requiredOption('--origin-workspace-id <id>', '已移除工作区原 id')
    .option('--type <类型>', '新增|修复|调整|历史')
    .option('--query <text>', '标题/正文字面子串搜索')
    .option('--offset <n>', '分页偏移', '0')
    .option('--limit <n>', '分页数量', '50')
    .action(async (opts: { originWorkspaceId: string; type?: string; query?: string; offset: string; limit: string }) => {
      const ctx = context();
      const suffix = query({ change_type: normalizeType(opts.type), q: opts.query, offset: opts.offset, limit: opts.limit });
      const page = await request<PageResponse<ChangeLogRecord>>(
        ctx.base,
        'GET',
        `/api/changelog/archived-workspaces/${encodeURIComponent(opts.originWorkspaceId)}/entries?${suffix}`,
      );
      if (ctx.json) ctx.io.write(`${JSON.stringify(page, null, 2)}\n`);
      else printPage(ctx, page);
    });

  changelog
    .command('show-archived <id>')
    .description('查看归档日志详情（只读；必须显式 --origin-workspace-id）')
    .requiredOption('--origin-workspace-id <id>', '已移除工作区原 id')
    .action(async (id: string, opts: { originWorkspaceId: string }) => {
      const ctx = context();
      const record = await request<ChangeLogRecord>(
        ctx.base,
        'GET',
        `/api/changelog/archived-workspaces/${encodeURIComponent(opts.originWorkspaceId)}/entries/${encodeURIComponent(id)}`,
      );
      if (ctx.json) ctx.io.write(`${JSON.stringify(record, null, 2)}\n`);
      else printRecord(ctx, record);
    });

  // ---- 旧 Docs/CHANGELOG.md 迁移：preview → apply → verify-retire（只读校验，不删除文件）----
  const imprt = changelog.command('import').description('旧 Docs/CHANGELOG.md 受控导入（preview 拿 SHA → 人工确认 → apply）');

  imprt
    .command('preview')
    .description('只读预览：返回源 SHA-256、解析/新增/已导入/不一致条目（不写库）')
    .requiredOption('--workspace <id|名>', '导入目标工作空间 id 或名称')
    .requiredOption('--source <path>', '旧 CHANGELOG.md 路径（必须位于所选工作空间目录内）')
    .action(async (opts: { workspace: string; source: string }) => {
      const ctx = context();
      const workspaceId = await activeWorkspace(ctx, opts.workspace);
      const preview = await request<ImportPreview>(ctx.base, 'POST', `${entriesPath(workspaceId)}/import/preview`, {
        source_path: opts.source,
        actor: ctx.agentId,
      });
      if (ctx.json) {
        ctx.io.write(`${JSON.stringify(preview, null, 2)}\n`);
        return;
      }
      ctx.io.write(`源文件: ${preview.source_path}\nSHA-256: ${preview.source_sha256}\n`);
      ctx.io.write(`条目: 解析 ${preview.entry_count} / 新增 ${preview.added.length} / 已导入 ${preview.already_imported.length} / 不一致 ${preview.conflicting.length} / 无法解析 ${preview.unparsable.length}\n`);
      for (const entry of preview.added) ctx.io.write(`[新增] ${TIME(entry.occurred_at)} ${entry.title}\n`);
      for (const entry of preview.already_imported) ctx.io.write(`[已导入] ${TIME(entry.occurred_at)} ${entry.title}\n`);
      for (const entry of preview.conflicting) ctx.io.write(`[不一致] ${TIME(entry.occurred_at)} ${entry.title}\n`);
      for (const item of preview.unparsable) ctx.io.write(`[无法解析] 行 ${item.line}: ${item.text}\n`);
      if (preview.added.length > 0) {
        ctx.io.write(`确认后执行：kb changelog import apply --workspace ${workspaceId} --source "${preview.source_path}" --sha ${preview.source_sha256}\n`);
      }
    });

  imprt
    .command('apply')
    .description('应用导入（必须绑定 preview 返回的 --sha；源文件变化或存在冲突时拒绝）')
    .requiredOption('--workspace <id|名>', '导入目标工作空间 id 或名称')
    .requiredOption('--source <path>', '旧 CHANGELOG.md 路径')
    .requiredOption('--sha <sha256>', 'preview 返回的源文件 SHA-256')
    .option('--request-id <uuid>', '幂等请求 id；重试时复用')
    .action(async (opts: { workspace: string; source: string; sha: string; requestId?: string }) => {
      const ctx = context();
      const workspaceId = await activeWorkspace(ctx, opts.workspace);
      const result = await request<ImportApplyResult>(
        ctx.base,
        'POST',
        `${entriesPath(workspaceId)}/import/apply`,
        { source_path: opts.source, preview_sha256: opts.sha, actor: ctx.agentId },
        opts.requestId,
      );
      if (ctx.json) ctx.io.write(`${JSON.stringify(result, null, 2)}\n`);
      else ctx.io.write(`导入完成：新增 ${result.imported} 条，回执 ${result.receipt_id}，源 SHA-256 ${result.source_sha256}\n`);
    });

  changelog
    .command('verify-retire')
    .description('退役前只读复核：仅当源 SHA 与成功导入回执一致且全部条目已对账时报告可退役（不删除文件）')
    .requiredOption('--workspace <id|名>', '工作空间 id 或名称')
    .requiredOption('--source <path>', '旧 CHANGELOG.md 路径')
    .action(async (opts: { workspace: string; source: string }) => {
      const ctx = context();
      const workspaceId = await activeWorkspace(ctx, opts.workspace);
      const verdict = await request<RetireVerdict>(ctx.base, 'POST', `${entriesPath(workspaceId)}/import/verify-retire`, {
        source_path: opts.source,
      });
      if (ctx.json) ctx.io.write(`${JSON.stringify(verdict, null, 2)}\n`);
      else {
        ctx.io.write(`可退役: ${verdict.can_retire ? '是' : '否'}\n`);
        ctx.io.write(`原因: ${verdict.reason}\n`);
        ctx.io.write(`源 SHA-256: ${verdict.source_sha256}\n`);
        ctx.io.write(`回执: ${verdict.receipt === null ? '无' : `${verdict.receipt.id}（${verdict.receipt.entry_count} 条）`}\n`);
        ctx.io.write(`对账: 新增 ${verdict.added.length} / 已导入 ${verdict.already_imported.length} / 不一致 ${verdict.conflicting.length} / 无法解析 ${verdict.unparsable.length}\n`);
      }
      if (!verdict.can_retire) throw new Error(`不可退役：${verdict.reason}`);
    });
}
