import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace, deleteWorkspace } from '../src/db/repos/workspace.js';
import { initSchema } from '../src/db/schema.js';
import { createKnowledgePage, getKnowledgePage, reviseKnowledgePage, setKnowledgePageStatus, listKnowledgeRevisions } from '../src/db/repos/knowledge.js';

describe('knowledge storage', () => {
  let t: TestDb;
  let workspaceId: string;
  const source = { source_id: 'design', source_type: 'file' as const, locator: 'Docs/design.md:1', captured_at: 1, content_hash: 'a'.repeat(64) };
  const evidence = [{ source_id: 'design', locator: 'Docs/design.md:1' }];
  const scope = () => ({ scope: 'workspace' as const, workspace_id: workspaceId });
  const input = () => ({ ...scope(), slug: 'design', title: '设计', body_md: '知识内容', sources: [source], evidence, actor: 'codex' });
  beforeEach(() => { t = createTestDb(); workspaceId = createWorkspace(t.db, { name: 'A', path: 'A' }).id; });
  afterEach(() => t.cleanup());

  it('workspaceScopeRejectsMissingWorkspace', () => {
    expect(() => createKnowledgePage(t.db, { ...input(), workspace_id: undefined } as any)).toThrow();
    expect(() => createKnowledgePage(t.db, { ...input(), workspace_id: 'missing' })).toThrow();
  });
  it('commonScopeRejectsWorkspaceId', () => {
    expect(() => createKnowledgePage(t.db, { ...input(), scope: 'common' } as any)).toThrow();
    const page = createKnowledgePage(t.db, { ...input(), scope: 'common', workspace_id: null });
    expect(getKnowledgePage(t.db, page.id, { scope: 'common' })?.revision).toBe(1);
    expect(getKnowledgePage(t.db, page.id, scope())).toBeNull();
  });
  it('reviseExpectedRevisionAllowsOneWriter and immutable provenance', () => {
    const page = createKnowledgePage(t.db, input());
    expect(reviseKnowledgePage(t.db, page.id, scope(), 1, { body_md: '新内容', actor: 'dsh' }).revision).toBe(2);
    expect(() => reviseKnowledgePage(t.db, page.id, scope(), 1, { body_md: '旧写入', actor: 'codex' })).toThrowError(expect.objectContaining({ status: 409, code: 'KNOWLEDGE_REVISION_CONFLICT' }));
    const revisions = listKnowledgeRevisions(t.db, page.id, scope());
    expect(revisions.map(r => r.body_snapshot)).toEqual(['新内容', '知识内容']);
    expect(revisions[1].sources[0]).toEqual(source);
    expect(() => t.db.prepare('UPDATE knowledge_revision SET body_snapshot=? WHERE page_id=?').run('tamper', page.id)).toThrow();
  });
  it('scope isolation, idempotent migration, restricted workspace delete', () => {
    const page = createKnowledgePage(t.db, input());
    initSchema(t.db);
    expect(getKnowledgePage(t.db, page.id, scope())?.title).toBe('设计');
    const other = createWorkspace(t.db, { name: 'B', path: 'B' }).id;
    expect(getKnowledgePage(t.db, page.id, { scope: 'workspace', workspace_id: other })).toBeNull();
    expect(() => reviseKnowledgePage(t.db, page.id, { scope: 'workspace', workspace_id: other }, 1, { title: 'bad', actor: 'dsh' })).toThrowError(expect.objectContaining({ status: 404 }));
    expect(() => deleteWorkspace(t.db, workspaceId)).toThrow();
    expect(() => createKnowledgePage(t.db, input())).toThrowError(expect.objectContaining({ status: 409 }));
  });
  it('archive restore delete produce revisions and keep tombstone', () => {
    const page = createKnowledgePage(t.db, input());
    expect(setKnowledgePageStatus(t.db, page.id, scope(), 1, 'archive', 'user').status).toBe('archived');
    expect(setKnowledgePageStatus(t.db, page.id, scope(), 2, 'restore', 'user').status).toBe('active');
    expect(setKnowledgePageStatus(t.db, page.id, scope(), 3, 'delete', 'user').status).toBe('deleted');
    expect(listKnowledgeRevisions(t.db, page.id, scope()).map(r => r.change_kind)).toEqual(['delete', 'restore', 'archive', 'create']);
    expect(() => setKnowledgePageStatus(t.db, page.id, scope(), 4, 'restore', 'user')).toThrow();
    expect(createKnowledgePage(t.db, input()).id).not.toBe(page.id);
  });
  it('requires provenance and bounded UTF8 evidence; rolls back invalid edits', () => {
    for (const sources of [[], [{ ...source, content_hash: '' }], [{ ...source, snapshot: 'a'.repeat(2049) }], [{ ...source, snapshot: '中文'.repeat(400) }]]) {
      expect(() => createKnowledgePage(t.db, { ...input(), sources })).toThrow();
    }
    expect(() => createKnowledgePage(t.db, { ...input(), evidence: [] })).toThrow();
    const page = createKnowledgePage(t.db, input());
    expect(() => reviseKnowledgePage(t.db, page.id, scope(), 1, { sources: [], actor: 'codex' })).toThrow();
    expect(getKnowledgePage(t.db, page.id, scope())?.revision).toBe(1);
    expect(listKnowledgeRevisions(t.db, page.id, scope())).toHaveLength(1);
  });
  it('bounds external UTF8 snapshots and rejects local code copies in evidence', () => {
    const external = { ...source, source_type: 'url' as const, locator: 'https://example.com/reference', snapshot: 'a'.repeat(2048) };
    expect(createKnowledgePage(t.db, { ...input(), sources: [external] }).revision).toBe(1);
    expect(() => createKnowledgePage(t.db, { ...input(), slug: 'oversize', sources: [{ ...external, snapshot: '中文'.repeat(400) }] })).toThrow();
    expect(() => createKnowledgePage(t.db, { ...input(), slug: 'code-copy', evidence: [{ ...evidence[0], snapshot: 'source code' }] })).toThrow();
  });
  it('non-file sources require a captured excerpt in source or matching evidence', () => {
    const external = { ...source, source_type: 'url' as const, locator: 'https://example.com/ref' };
    expect(() => createKnowledgePage(t.db, { ...input(), sources: [external] })).toThrow();
    expect(() => createKnowledgePage(t.db, { ...input(), sources: [{ ...external, snapshot: '  ' }] })).toThrow();
    expect(createKnowledgePage(t.db, { ...input(), sources: [external], evidence: [{ ...evidence[0], snapshot: 'captured support' }] }).revision).toBe(1);
  });
});
