/**
 * KB-DEL（N-03）：移除工作区时，连带硬删该空间**已软删**（`status='deleted'`）的知识页与其历史。
 *
 * 为什么必须硬删：`knowledge_page.workspace_id` 是 `REFERENCES workspace(id) ON DELETE RESTRICT`，
 * 服务连接又开了 `PRAGMA foreign_keys = ON`，所以只要该空间还残留任何页面行（哪怕 `status='deleted'`、
 * 在列表/搜索/图里全都不可见），`DELETE FROM workspace` 就会被外键直接拒绝。
 * 而 N-03 的现场恰恰是「页已软删、delete-space 仍报 409」：占用口径排除软删页之后，
 * 这些行必须由本模块带走，否则拒绝消失、500 取而代之。
 *
 * 安全边界（三条都不可放宽）：
 * 1. 只碰 `status='deleted'` 的行；`active` / `archived` 由 `routes.ts` 的前置判据 409 拒绝，永远不进这里；
 * 2. 只在显式确认的 DELETE 上发生：`kb delete-space` 缺 `--yes` 时根本不发请求（CLI 先回显再非 0 退出）；
 * 3. 计数必须回显：调用方把 `{ pages, revisions }` 写进响应头 `X-Knowledge-Purged` 与服务日志。
 *
 * 实现口径：
 * - `knowledge_revision` 上有不可变历史触发器（`BEFORE DELETE … RAISE(ABORT)`），必须先摘后建；
 *   建回用 `sqlite_master` 里的**原始 SQL**，不在此重抄定义，避免与 migrations 漂移；
 * - 删除顺序 revision → 页面：`knowledge_revision.page_id` 是 RESTRICT，反了会撞外键；
 * - `knowledge_fts` 没有 AFTER DELETE 触发器，不手动清就留幽灵条目（搜索靠 JOIN 页面过滤才不会命中，
 *   但索引会一直长大），所以按同一批 page id 显式删；
 * - `knowledge_link`（source CASCADE / target SET NULL）与 `knowledge_attachment`（CASCADE）由外键自动带走。
 */
import type { Db } from '../db/connection.js';
import { deleteWorkspace } from '../db/repos/workspace.js';

/** 历史不可变触发器名（与 db/migrations/knowledge.ts 一致） */
const IMMUTABLE_HISTORY_TRIGGERS = ['knowledge_revision_no_update', 'knowledge_revision_no_delete'] as const;

export interface PurgedKnowledgeCounts {
  pages: number;
  revisions: number;
}

/** 只读计数：该空间已软删的页与这些页的全部历史 revision（purge 前后都可用它核对） */
export function countDeletedKnowledgeForWorkspace(db: Db, workspaceId: string): PurgedKnowledgeCounts {
  const q = (sql: string): number => (db.prepare(sql).get(workspaceId) as { n: number }).n;
  return {
    pages: q("SELECT COUNT(*) AS n FROM knowledge_page WHERE scope='workspace' AND workspace_id=? AND status='deleted'"),
    revisions: q(
      `SELECT COUNT(*) AS n FROM knowledge_revision r JOIN knowledge_page p ON p.id = r.page_id
        WHERE p.scope='workspace' AND p.workspace_id=? AND p.status='deleted'`,
    ),
  };
}

/**
 * 单事务完成「硬删软删知识 → 删空间行」；任一步抛错整体回滚（触发器的 DROP 也一起回滚，不会留下无保护结构）。
 * 空间不存在时 `deleteWorkspace` 抛 404，事务回滚，软删页原样保留。
 */
export function deleteWorkspaceRemovingDeletedKnowledge(db: Db, workspaceId: string): PurgedKnowledgeCounts {
  const run = db.transaction((): PurgedKnowledgeCounts => {
    const counts = countDeletedKnowledgeForWorkspace(db, workspaceId);
    if (counts.pages > 0) {
      const originalSql = new Map<string, string | null>(IMMUTABLE_HISTORY_TRIGGERS.map(name => [
        name,
        (db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string | null }).sql,
      ]));
      for (const name of IMMUTABLE_HISTORY_TRIGGERS) db.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
      try {
        const deletedPageIds = `SELECT id FROM knowledge_page WHERE scope='workspace' AND workspace_id=? AND status='deleted'`;
        db.prepare(`DELETE FROM knowledge_revision WHERE page_id IN (${deletedPageIds})`).run(workspaceId);
        db.prepare(`DELETE FROM knowledge_fts WHERE page_id IN (${deletedPageIds})`).run(workspaceId);
        db.prepare(`DELETE FROM knowledge_page WHERE scope='workspace' AND workspace_id=? AND status='deleted'`).run(workspaceId);
      } finally {
        // 按 sqlite_master 原文建回；建不回来即抛错让事务整体回滚，绝不留「没有历史保护」的库
        for (const name of IMMUTABLE_HISTORY_TRIGGERS) {
          const sql = originalSql.get(name);
          if (sql !== undefined && sql !== null) db.exec(sql);
        }
      }
    }
    deleteWorkspace(db, workspaceId);
    return counts;
  });
  return run.immediate();
}
