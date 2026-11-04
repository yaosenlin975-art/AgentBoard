/**
 * KB-DIFF-S 体积测量：用 200 万字符样本页造 20 个版本，量化「列表瘦身前/后」的 JSON 字节数。
 * 跑法：pnpm --filter @agentboard/server exec tsx scripts/verify/kb-diff-s-sizes.ts
 * 或：node --experimental-strip-types（本仓走 tsx）。
 */
import { writeFileSync } from 'node:fs';
import { createTestDb } from '../../apps/server/test/helpers.js';
import { createKnowledgePage, getKnowledgeRevision, listKnowledgeRevisions, reviseKnowledgePage } from '../../apps/server/src/db/repos/knowledge.js';

const scope = { scope: 'common' as const, workspace_id: null };
const SOURCE = { source_id: 'kb-diff-s', source_type: 'file' as const, locator: 'samples/size.md', captured_at: 1, content_hash: 'a'.repeat(64) };
const EVIDENCE = [{ source_id: 'kb-diff-s', locator: 'samples/size.md:1' }];
const BODY_CHARS = 2_000_000;
const REVISIONS = 20;

const db = createTestDb();
const page = createKnowledgePage(db.db, { ...scope, title: 'SIZE-SAMPLE', body_md: 'A'.repeat(BODY_CHARS), slug: 'size-sample', sources: [SOURCE], evidence: EVIDENCE, actor: 'measure' });
for (let i = 1; i < REVISIONS; i += 1) {
  reviseKnowledgePage(db.db, page.id, scope, page.revision + i - 1, { body_md: 'A'.repeat(BODY_CHARS - 1) + String.fromCharCode(66 + i), change_note: `rev${i}`, actor: 'measure' });
}

const slim = JSON.stringify({ items: listKnowledgeRevisions(db.db, page.id, scope, REVISIONS, 0) });
const full = JSON.stringify({ items: listKnowledgeRevisions(db.db, page.id, scope, REVISIONS, 0, true) });
const single = JSON.stringify(getKnowledgeRevision(db.db, page.id, 7, scope));
const result = {
  revisions: REVISIONS,
  body_chars_each: BODY_CHARS,
  slim_list_bytes: Buffer.byteLength(slim),
  full_list_bytes: Buffer.byteLength(full),
  ratio_full_over_slim: Number((Buffer.byteLength(full) / Buffer.byteLength(slim)).toFixed(1)),
  single_revision_bytes: Buffer.byteLength(single),
  single_revision_number: 7,
  first_item_keys: Object.keys(JSON.parse(slim).items[0] as Record<string, unknown>),
  first_item_has_body: Object.hasOwn(JSON.parse(slim).items[0] as Record<string, unknown>, 'body_snapshot'),
};
writeFileSync('Docs/verification/2026-11-04-kb-diff-s-sizes.json', JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
db.cleanup();
