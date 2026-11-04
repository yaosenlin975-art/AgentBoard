import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers.js';
import { createWorkspace } from '../src/db/repos/workspace.js';
import { createKnowledgePage, reviseKnowledgePage, setKnowledgePageStatus } from '../src/db/repos/knowledge.js';
import { searchKnowledge } from '../src/db/repos/knowledgeSearch.js';

describe('knowledge search', () => {
  let t: TestDb;
  let a: string;
  let b: string;
  const sources = [{ source_id: 's', source_type: 'agent' as const, locator: 'issue:1', captured_at: 1, content_hash: 'a'.repeat(64), snapshot: 'verified' }];
  const evidence = [{ source_id: 's', locator: 'issue:1' }];
  const create = (workspace_id: string | null, slug: string, title = '存储', body_md = '缓存失效后 WAL checkpoint') => createKnowledgePage(t.db, { domain: 'knowledge', scope: workspace_id ? 'workspace' : 'common', workspace_id, slug, title, body_md, actor: 'codex', sources, evidence } as any);
  beforeEach(() => { t = createTestDb(); a = createWorkspace(t.db, { name: 'A', path: 'A' }).id; b = createWorkspace(t.db, { name: 'B', path: 'B' }).id; });
  afterEach(() => t.cleanup());
  it('ftsTrigramCapabilityGate', () => {
    t.db.exec("CREATE VIRTUAL TABLE temp.kb_fts USING fts5(body, tokenize='trigram')");
    t.db.prepare('INSERT INTO temp.kb_fts(body) VALUES (?)').run('缓存失效后重新建立倒排索引');
    for (const query of ['缓存失效', '失效后']) expect(t.db.prepare('SELECT * FROM temp.kb_fts WHERE kb_fts MATCH ?').all(query)).toHaveLength(1);
  });
  it('searchChineseFragmentUsesTrigram; English and provenance retained', () => {
    const page = create(a, 'storage');
    for (const query of ['缓存失效', '失效后', 'WAL checkpoint']) {
      const rows = searchKnowledge(t.db, { workspace_id: a, scope: 'both', query });
      expect(rows.map(r => r.page_id)).toEqual([page.id]);
      expect(rows[0].sources).toEqual(sources);
    }
  });
  it('searchShortChineseUsesLiteralLikeEscape and operator literals', () => {
    create(a, 'cache', '缓存', 'a!%_b');
    for (const query of ['缓存', '!%', '%_', '!%_']) expect(searchKnowledge(t.db, { scope: 'workspace', workspace_id: a, query })).toHaveLength(1);
    for (const query of ['zz', '" OR "', 'NEAR(cache)', 'xxx*']) expect(searchKnowledge(t.db, { scope: 'workspace', workspace_id: a, query })).toHaveLength(0);
  });
  it('searchBothFiltersWorkspace and explicit common', () => {
    const local = create(a, 'a'); const common = create(null, 'shared'); create(b, 'b');
    expect(searchKnowledge(t.db, { scope: 'both', workspace_id: a, query: '缓存' }).map(r => r.page_id)).toEqual([local.id, common.id]);
    expect(searchKnowledge(t.db, { scope: 'common', query: '缓存' }).map(r => r.page_id)).toEqual([common.id]);
    expect(() => searchKnowledge(t.db, { scope: 'both', query: '缓存' })).toThrow();
    expect(() => searchKnowledge(t.db, { scope: 'common', workspace_id: a, query: '缓存' })).toThrow();
  });
  it('index update and lifecycle are atomic; excludes expired archived deleted', () => {
    const page = create(a, 'edit'); const scope = { scope: 'workspace' as const, workspace_id: a };
    reviseKnowledgePage(t.db, page.id, scope, 1, { body_md: '新的索引', actor: 'codex' });
    expect(searchKnowledge(t.db, { ...scope, query: '缓存' })).toHaveLength(0);
    expect(searchKnowledge(t.db, { ...scope, query: '新的索引' })).toHaveLength(1);
    setKnowledgePageStatus(t.db, page.id, scope, 2, 'archive', 'user');
    expect(searchKnowledge(t.db, { ...scope, query: '新的索引' })).toHaveLength(0);
    setKnowledgePageStatus(t.db, page.id, scope, 3, 'restore', 'user');
    reviseKnowledgePage(t.db, page.id, scope, 4, { expires_at: 10, actor: 'codex' });
    expect(searchKnowledge(t.db, { ...scope, query: '新的索引', now: 10 })).toHaveLength(0);
    expect(searchKnowledge(t.db, { ...scope, query: '新的索引', now: 9 })).toHaveLength(1);
    setKnowledgePageStatus(t.db, page.id, scope, 5, 'delete', 'user');
    expect(searchKnowledge(t.db, { ...scope, query: '新的索引', now: 9 })).toHaveLength(0);
  });
  it('limit and query validation', () => {
    for (let i = 0; i < 7; i++) create(a, `item-${i}`);
    expect(searchKnowledge(t.db, { scope: 'workspace', workspace_id: a, query: '缓存' })).toHaveLength(5);
    for (const query of ['', ' ', 'x'.repeat(501)]) expect(() => searchKnowledge(t.db, { scope: 'workspace', workspace_id: a, query })).toThrow();
    expect(() => searchKnowledge(t.db, { scope: 'workspace', workspace_id: a, query: '缓存', limit: 21 })).toThrow();
  });
});
