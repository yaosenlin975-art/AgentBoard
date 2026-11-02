import type { Db } from '../connection.js';

/** Add the self-relation without rebuilding the pinned issue table. */
export function migrateTaskHierarchy(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(issue)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'parent_issue_id')) {
    db.exec('ALTER TABLE issue ADD COLUMN parent_issue_id TEXT REFERENCES issue(id) ON DELETE RESTRICT');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS issue_parent_order
      ON issue(workspace_id,parent_issue_id,sort_order,created_at,id);
    CREATE TRIGGER IF NOT EXISTS issue_parent_same_workspace_insert
      BEFORE INSERT ON issue
      WHEN new.parent_issue_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM issue parent WHERE parent.id=new.parent_issue_id AND parent.workspace_id=new.workspace_id
      )
      BEGIN SELECT RAISE(ABORT,'issue parent workspace mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS issue_parent_same_workspace_update
      BEFORE UPDATE OF parent_issue_id,workspace_id ON issue
      WHEN new.parent_issue_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM issue parent WHERE parent.id=new.parent_issue_id AND parent.workspace_id=new.workspace_id
      )
      BEGIN SELECT RAISE(ABORT,'issue parent workspace mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS issue_parent_no_cycle_update
      BEFORE UPDATE OF parent_issue_id ON issue
      WHEN new.parent_issue_id IS NOT NULL AND EXISTS (
        WITH RECURSIVE descendants(id) AS (
          SELECT id FROM issue WHERE id=new.id
          UNION
          SELECT child.id FROM issue child JOIN descendants parent ON child.parent_issue_id=parent.id
        )
        SELECT 1 FROM descendants WHERE id=new.parent_issue_id
      )
      BEGIN SELECT RAISE(ABORT,'issue parent cycle'); END;
  `);
}
