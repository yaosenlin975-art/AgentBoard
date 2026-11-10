import { createHash } from 'node:crypto';
import type { Issue, KnowledgeHint } from '@agentboard/shared';
import { CommanderError } from 'commander';
import { CliHttpError, request } from '../api.js';
import { clearClaimedFence, loadClaimedFence } from '../claimStore.js';
import type { Ctx } from '../io.js';
import { normalizeIssueRef } from '../issueRef.js';
import { closeIssueWithOwnRelease } from './lifecycle.js';

/** GIT-OBSERVABLE：服务端 done 回传的自动提交结果（同 key 重放返回首次结果） */
interface GitCommitInfo {
  status: 'committed' | 'nothing' | 'not-committed' | 'unavailable';
  reason: string | null;
  note: string | null;
  pending: string[];
}

/** 这些原因意味着「声明范围内确有改动但本次没提交」，须以非 0 退出码提醒调用方 */
const BLOCKING_COMMIT_REASONS = new Set(['NO_BASELINE', 'COMMIT_FAILED', 'ZERO_HIT', 'NO_SCOPE', 'PARALLEL_UNDECLARED']);

export interface DoneArgs {
  notes?: string;
  /** 从 stdin 读取 notes（多行、或含 `- ` 开头的行时更安全；与 --notes 二选一，stdin 优先） */
  notesStdin?: boolean;
  /** GIT-ON-DONE 提交范围声明：文件路径或目录前缀；未声明时服务端不提交任何文件（NO_SCOPE） */
  scope?: string[];
  /** 显式纳入工作区全部未提交改动（默认只提交 scope 声明的卡内文件集，卡外改动只列清单） */
  all?: boolean;
  /** 幂等请求 id：与 workspace_id 一起才能命中服务端的 owner 幂等包装；重试必须复用同一 uuid */
  requestId?: string;
  /** CLOSE-FLOW：done 成功后串行 close（待验收 → 已关闭），一步收口 */
  close?: boolean;
  /** OPT-09：一次完成收尾三件套（changelog 先写 → 可选知识页挂引用 → done） */
  closeRecord?: boolean;
  /** OPT-09：CLOSE-RECORD 的 changelog 标题（必填，与 --close-record 一起） */
  changelogTitle?: string;
  /** OPT-09：CLOSE-RECORD 的 changelog 类型：新增|修复|调整 */
  changelogType?: string;
  /** OPT-09：changelog 正文（缺省复用 notes，仍为空时写「本轮无用户可见变更」） */
  changelogBody?: string;
  /** OPT-09：已有知识页 id（只挂引用，不新建页） */
  knowledgePage?: string;
  /** ARCH-04：确认本卡不推进关联的设计页（landed=proposed 时写声明进 notes，跳过门禁） */
  designNotAdvanced?: boolean;
  /** SK-05：显式声明本次没有用户可见变更（不写 changelog），用于纯内部重构 / 仅看板操作 */
  noChangelog?: boolean;
  /** N3-10：纯看板任务显式跳过 GIT-ON-DONE（不列脏文件、不 exit 1、不提交任何文件） */
  boardOnly?: boolean;
}

/** OPT-09：从 done 的 request-id 派生 changelog 幂等键（同一重试复用，不与 done 的 key 撞车） */
function derivedRequestId(base: string, purpose: string): string {
  const hex = createHash('sha256').update(`${base}:${purpose}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** OPT-09：--close-record 的参数前置校验（fail fast，不产生任何写入） */
function validateCloseRecord(args: DoneArgs): { title: string; type: string } {
  if (args.closeRecord !== true) {
    if (args.changelogTitle !== undefined || args.changelogType !== undefined
      || args.changelogBody !== undefined || args.knowledgePage !== undefined) {
      throw new Error('--changelog-title / --type / --changelog-body / --knowledge-page 必须与 --close-record 一起使用');
    }
    return { title: '', type: '' };
  }
  const title = (args.changelogTitle ?? '').trim();
  if (title === '') throw new Error('--close-record 需要 --changelog-title <标题>');
  const type = (args.changelogType ?? '').trim();
  if (!['新增', '修复', '调整'].includes(type)) throw new Error('--close-record 的 --type 只能是 新增|修复|调整');
  return { title, type };
}

/** ARCH-04：只对真实任务 id（UUID）启用设计门禁；非 UUID 引用保持旧行为 */
const ISSUE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface KnowledgePageRow {
  id: string;
  slug: string;
  title: string;
  scope: 'common' | 'workspace';
  workspace_id: string | null;
  revision: number;
  status: string;
  category?: string | null;
  landed?: string | null;
}

interface KnowledgePageDetail extends KnowledgePageRow {
  sources?: Array<{ source_id?: string | null; locator?: string | null }>;
  evidence?: Array<{ source_id?: string | null; locator?: string | null }>;
}

interface PendingDesignPage {
  id: string;
  slug: string;
  revision: number;
}

/** ARCH-04：列出 active 知识页（common + 当前工作区），按 offset 翻页 */
async function listActiveKnowledgePages(ctx: Ctx, workspaceId: string): Promise<KnowledgePageRow[]> {
  const pages: KnowledgePageRow[] = [];
  let offset = 0;
  for (;;) {
    const query = new URLSearchParams({
      scope: 'both', workspace_id: workspaceId, status: 'active', limit: '100', offset: String(offset),
    });
    const result = await request<{ items: KnowledgePageRow[]; next_offset: number | null }>(
      ctx.base, 'GET', `/api/knowledge/pages?${query}`,
    );
    pages.push(...result.items);
    if (result.next_offset === null || result.next_offset <= offset) return pages;
    offset = result.next_offset;
  }
}

/** 本卡 + 父链（设计页常挂在父设计卡上，如 issue:<父卡 id>）；循环保护 */
async function loadIssueChain(ctx: Ctx, issueId: string, known?: Issue): Promise<Issue[]> {
  const chain: Issue[] = [];
  const seen = new Set<string>();
  let current = known ?? await request<Issue>(ctx.base, 'GET', `/api/issues/${encodeURIComponent(issueId)}`);
  while (!seen.has(current.id) && chain.length < 32) {
    chain.push(current);
    seen.add(current.id);
    if (current.parent_issue_id === null) break;
    current = await request<Issue>(ctx.base, 'GET', `/api/issues/${encodeURIComponent(current.parent_issue_id)}`);
  }
  return chain;
}

/** 当前 revision 的 sources / evidence 是否精确引用了这批 issue（约定 `issue:<uuid>`） */
function referencesIssues(page: KnowledgePageDetail, refs: Set<string>): boolean {
  const entries = [...(page.sources ?? []), ...(page.evidence ?? [])];
  return entries.some(entry =>
    [entry.source_id, entry.locator].some(value => typeof value === 'string' && refs.has(value.toLowerCase())),
  );
}

/**
 * ARCH-04：找出「关联本卡（含父链）且仍为 proposed 的 active design 页」。
 * 只读：列表接口取元数据，候选页再取详情核对 sources/evidence；不改 landed、不写库。
 */
async function findPendingDesignPages(ctx: Ctx, issueId: string, known?: Issue): Promise<PendingDesignPage[]> {
  if (!ISSUE_UUID_RE.test(issueId)) return [];
  const chain = await loadIssueChain(ctx, issueId, known);
  const workspaceId = chain[0]!.workspace_id;
  const refs = new Set(chain.map(issue => `issue:${issue.id}`.toLowerCase()));
  const candidates = (await listActiveKnowledgePages(ctx, workspaceId)).filter(page =>
    page.category === 'design' && page.landed === 'proposed' && page.status === 'active',
  );
  const pending: PendingDesignPage[] = [];
  for (const page of candidates) {
    const query = page.scope === 'common'
      ? new URLSearchParams({ scope: 'common' })
      : new URLSearchParams({ scope: 'workspace', workspace_id: page.workspace_id ?? workspaceId });
    const detail = await request<KnowledgePageDetail>(
      ctx.base, 'GET', `/api/knowledge/pages/${encodeURIComponent(page.id)}?${query}`,
    ).catch((error: unknown) => {
      // 列表与详情之间被归档/删除：跳过该页，不阻塞收尾
      if (error instanceof CliHttpError && (error.status === 404 || error.status === 410)) return null;
      throw error;
    });
    if (detail !== null && referencesIssues(detail, refs)) {
      pending.push({ id: page.id, slug: page.slug, revision: detail.revision ?? page.revision });
    }
  }
  return pending;
}

/** ARCH-04：门禁报错文案——每个页 id 都给出两个合法选项 */
function designGateMessage(issueId: string, pages: PendingDesignPage[]): string {
  const lines = pages.map(page =>
    `  - ${page.id}（${page.slug}，rev ${page.revision}）\n` +
    `    选项 1：kb knowledge revise ${page.id} --landed landed|partial --expected-revision ${page.revision} ...\n` +
    `    选项 2：kb done ${issueId} ... --design-not-advanced`,
  );
  return `设计页未回改：本卡（含父链）关联了仍为 proposed 的设计页，done 未执行\n${lines.join('\n')}`;
}

export async function done(ctx: Ctx, id: string, args: DoneArgs): Promise<void> {
  // CLI-02：允许 ≥8 位前缀；fence 与接口都用解析后的真实 id
  const target = await normalizeIssueRef(ctx, id);
  const issueId = target.id;
  const body: {
    agent_id: string; notes?: string; scope_paths?: string[]; workspace_id?: string; fence?: number;
    client?: 'cli' | 'mcp'; changelog_ack?: boolean; board_only?: boolean;
  } = { agent_id: ctx.agentId };
  // SK-05：agent 入口恒带 client，服务端据此启用变更日志门禁；--close-record 已先写日志、--no-changelog 显式声明无变更
  if (args.closeRecord === true && args.noChangelog === true) {
    throw new Error('--close-record 与 --no-changelog 不能同时使用：前者会先写变更日志，后者声明没有变更日志');
  }
  // N3-10：纯看板任务不提交文件；与显式提交范围互斥（避免静默忽略）
  if (args.boardOnly === true && ((args.scope?.length ?? 0) > 0 || args.all === true)) {
    throw new Error('--board-only 与 --scope / --all 不能同时使用：纯看板任务不提交任何文件');
  }
  body.client = 'cli';
  body.changelog_ack = args.closeRecord === true || args.noChangelog === true;
  if (args.boardOnly === true) body.board_only = true;
  /** 一次收尾里 issue 详情最多取一次（workspace_id / 父链 / 设计页门禁共用） */
  let issueDetail: Issue | undefined = target.issue;
  const loadIssue = async (): Promise<Issue> => {
    issueDetail ??= await request<Issue>(ctx.base, 'GET', `/api/issues/${encodeURIComponent(issueId)}`);
    return issueDetail;
  };
  // BORROW-0.3：本地有 claim 记录就自动带 fence（软模式：无记录不带，服务端放行）
  const storedFence = loadClaimedFence(issueId);
  if (storedFence !== undefined) body.fence = storedFence;
  if (args.notesStdin === true) {
    const text = (await ctx.io.readStdin()).replace(/\r\n/g, '\n');
    body.notes = text.endsWith('\n') ? text.slice(0, -1) : text;
  } else if (args.notes !== undefined) {
    // CLI-UX：多行 notes 里以 "- " 开头的行会被 shell 当成额外参数（实测 `too many arguments for 'done'`）
    if (/\n\s*- /.test(args.notes)) {
      ctx.io.writeErr('警告：--notes 含以 "- " 开头的行，可能被 shell 拆成额外参数；建议改用 --notes-stdin（从标准输入读取）\n');
    }
    body.notes = args.notes;
  }
  if (args.scope !== undefined && args.scope.length > 0) {
    /**
     * SCOPE-GUARD：PowerShell 会把 `--scope a,b` 的逗号串拆开、甚至合并成一个含空格的参数（"a b"）。
     * 含空格的值既可能是真实文件名、也可能是被拆坏的多个路径，静默再拆一次有风险 → 只报警不猜。
     */
    const suspicious = args.scope.filter(item => /\s/.test(item));
    if (suspicious.length > 0) {
      ctx.io.writeErr(
        `警告：--scope 值含空格（${suspicious.map(item => JSON.stringify(item)).join('、')}），` +
        '可能是 PowerShell 把逗号串拆开/合并了。请为每个路径重复传参：--scope a --scope b\n',
      );
    }
    body.scope_paths = args.scope;
  }
  if (args.all === true) {
    // GIT-ON-DONE：声明工作区根（`.`）＝显式纳入卡外未提交改动；默认不纳入
    body.scope_paths = [...(body.scope_paths ?? []), '.'];
  }
  if (args.requestId !== undefined) {
    // 服务端要求幂等 owner 操作提供 workspace_id；只在显式传 --request-id 时才多这一次解析
    body.workspace_id = (await loadIssue()).workspace_id;
  }
  // OPT-09：--close-record 先校验参数 → 校验知识页（只读）→ 写 changelog → 再 done；
  // changelog/知识页任一步失败都在 done 之前中止，避免「卡 done 了但 changelog 没写」
  const { title: changelogTitle, type: changelogType } = validateCloseRecord(args);
  // ARCH-04：done 前置门禁——关联设计页仍为 proposed 时必须先回改或显式声明不推进；
  // 判定阶段只读，失败时 done / changelog 都未执行。
  let designDeclaration: string | null = null;
  if (ISSUE_UUID_RE.test(issueId)) {
    const currentIssue = await loadIssue();
    const pendingDesignPages = await findPendingDesignPages(ctx, issueId, currentIssue);
    if (pendingDesignPages.length > 0) {
      if (args.designNotAdvanced !== true) throw new Error(designGateMessage(issueId, pendingDesignPages));
      designDeclaration = `设计页：本卡不推进设计（${pendingDesignPages.map(page => page.id).join('、')}）`;
    }
  }
  let closeRecordInfo: { changelog_id: string; knowledge_id: string | null } | null = null;
  if (args.closeRecord === true) {
    const current = await loadIssue();
    const workspaceId = current.workspace_id;
    // SK-05：归属本卡（用服务端返回的全长 UUID，短前缀不能直接当 issue_id），普通 done 的门禁也能识别
    const changelogIssueId = current.id;
    let knowledgeId: string | null = null;
    if (args.knowledgePage !== undefined) {
      const resolved = await request<{ id: string }>(
        ctx.base, 'GET',
        `/api/knowledge/resolve?${new URLSearchParams({ scope: 'both', workspace_id: workspaceId, ref: args.knowledgePage })}`,
      ).catch((error) => {
        ctx.io.writeErr(`close-record 中止：知识页 ${args.knowledgePage} 不可解析，done 未执行\n`);
        throw error;
      });
      knowledgeId = resolved.id;
    }
    const record = await request<{ id: string }>(
      ctx.base, 'POST', `/api/workspaces/${encodeURIComponent(workspaceId)}/changelog`,
      {
        title: changelogTitle,
        body_md: args.changelogBody ?? body.notes ?? '本轮无用户可见变更',
        change_type: changelogType,
        actor: ctx.agentId,
        // SK-05：归属本卡，普通 done 的门禁也能识别这条日志
        issue_id: changelogIssueId,
      },
      args.requestId === undefined ? undefined : derivedRequestId(args.requestId, 'changelog'),
    ).catch((error) => {
      ctx.io.writeErr('close-record 中止：changelog 未创建，done 未执行\n');
      throw error;
    });
    closeRecordInfo = { changelog_id: record.id, knowledge_id: knowledgeId };
    const line = `close-record: changelog=${record.id} knowledge=${knowledgeId ?? '（未提供）'}`;
    body.notes = body.notes === undefined ? line : `${body.notes}\n\n${line}`;
  }
  if (designDeclaration !== null) {
    body.notes = body.notes === undefined ? designDeclaration : `${body.notes}\n\n${designDeclaration}`;
  }
  const issue = await request<Issue & { knowledge_hint?: KnowledgeHint | null; git_commit?: GitCommitInfo | null }>(
    ctx.base, 'POST', `/api/issues/${encodeURIComponent(issueId)}/done`, body, args.requestId,
  ).catch((error) => {
    if (closeRecordInfo !== null) {
      ctx.io.writeErr(`close-record 部分完成：changelog 已创建（${closeRecordInfo.changelog_id}）；done 未执行\n`);
    }
    throw error;
  });
  // OPT-08：完成结果以服务端返回的最新状态为准；状态不符直接报错，不打印「已完成」
  if (issue.status !== '待验收') {
    throw new Error(`完成后状态异常：期望「待验收」，服务端返回「${issue.status}」（任务 ${issue.id}）`);
  }
  clearClaimedFence(issueId);

  const gitCommit = issue.git_commit ?? null;
  /** not-committed 且不是「仅提示」类原因 → 需要非 0 退出码（done 本身已生效） */
  const commitBlocked = gitCommit !== null
    && gitCommit.status === 'not-committed'
    && BLOCKING_COMMIT_REASONS.has(gitCommit.reason ?? '');

  /** 打印 done 结果（JSON 模式只输出单个 JSON 文档） */
  const printDone = (): void => {
    if (ctx.json) {
      ctx.io.write(`${JSON.stringify(closeRecordInfo === null ? issue : { ...issue, close_record: closeRecordInfo }, null, 2)}\n`);
      return;
    }
    ctx.io.write(`已完成: ${issue.id}\n状态: ${issue.status}（占用已释放，notes 落评论流）\n`);
    ctx.io.write(`占用者: ${issue.claimed_by ?? '（未占用）'}\n`);
    if (closeRecordInfo !== null) {
      ctx.io.write(`收尾记录: changelog=${closeRecordInfo.changelog_id} knowledge=${closeRecordInfo.knowledge_id ?? '（未提供）'}\n`);
    }
    // 软提醒：建议而非错误，不加 ERROR 前缀、不影响退出码
    if (issue.knowledge_hint?.message) ctx.io.write(`提示: ${issue.knowledge_hint.message}\n`);
  };
  /** 自动提交结果不是 committed/nothing/skipped 时落 stderr（reason + 补救命令都在 note 里） */
  const warnCommit = (): void => {
    // N4-02：skipped（BOARD_ONLY）是成功的显式跳过，不是「未知原因」的失败
    if (gitCommit === null || gitCommit.status === 'committed' || gitCommit.status === 'nothing' || gitCommit.status === 'skipped') return;
    ctx.io.writeErr(`自动提交未完成：${gitCommit.note ?? '未知原因'}\n`);
  };

  // CLOSE-FLOW：done 成功后串行 close；两阶段分别报错，已成功的 done 不回滚、也不重复执行
  if (args.close === true) {
    if (commitBlocked) {
      // 不 close：卡一旦关闭就没法再用 done 触发自动提交，补救命令只能靠人工执行
      printDone();
      warnCommit();
      ctx.io.writeErr(`已跳过 close（避免未提交的卡被关闭后无法用 done 补救）；修复后执行：kb close ${issue.id}\n`);
      throw new CommanderError(1, 'agentboard.done.commit', '');
    }
    const outcome = await closeIssueWithOwnRelease(ctx, issue.id)
      .catch(error => {
        ctx.io.writeErr('done 阶段已完成（状态已进入待验收，占用已释放）；close 阶段失败：\n');
        throw error;
      });
    const closed = outcome.issue;
    if (ctx.json) {
      ctx.io.write(`${JSON.stringify(closeRecordInfo === null ? { done: issue, close: closed } : { done: issue, close: closed, close_record: closeRecordInfo }, null, 2)}\n`);
      warnCommit();
      return;
    }
    ctx.io.write(`已完成: ${issue.id}\n状态: ${issue.status}（占用已释放，notes 落评论流）\n`);
    ctx.io.write(`占用者: ${issue.claimed_by ?? '（未占用）'}\n`);
    if (closeRecordInfo !== null) {
      ctx.io.write(`收尾记录: changelog=${closeRecordInfo.changelog_id} knowledge=${closeRecordInfo.knowledge_id ?? '（未提供）'}\n`);
    }
    if (issue.knowledge_hint?.message) ctx.io.write(`提示: ${issue.knowledge_hint.message}\n`);
    if (outcome.released) ctx.io.write('已释放自有占用后关闭\n');
    ctx.io.write(`已关闭: ${closed.id}\n状态: ${closed.status}（done → close 一步收口）\n`);
    warnCommit();
    return;
  }

  printDone();
  warnCommit();
  if (commitBlocked) throw new CommanderError(1, 'agentboard.done.commit', '');
}
