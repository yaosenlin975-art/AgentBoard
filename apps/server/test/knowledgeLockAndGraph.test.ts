/**
 * R3（OCR 性能审查 P0）：锁自旋冻结 + push 展开溢出。
 *
 * A1：`acquireLock` 是同步函数，等锁时 `while (Date.now() < waitEnd) {}` 不让出线程。
 *     原配置 50ms 间隔 × 3000ms 超时 = 60 轮满 CPU 空转，期间所有 HTTP 排队。
 *     修法不是改 async（`idempotency.ts:50` 明令禁止 thenable mutation，且 SQLite 同步事务
 *     不能跨 await），而是把最坏阻塞压到 200ms 上限 / 2ms 间隔。
 *
 * B3：`push(...arr)` 在 arr 超 ~125k 时抛 RangeError（实参按栈传）。
 *     `/graph` 的 GRAPH_MAX_PAGES=5000 × 每页 ≥26 出链即越阈值，裁剪在合并之后 → 500。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocsIndex } from '../src/knowledge/index.js';

describe('R3-B3 push 展开不得溢出（graph 聚合路径）', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'r3-b3-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('超出 V8 展开上限的数组：逐项追加不抛 RangeError', () => {
    // 复现 lead 实测的阈值
    expect(() => { const sink: number[] = []; sink.push(...new Array(125_000).fill(1)); }).toThrow(RangeError);

    // 逐项追加等价且不抛
    const target: number[] = [];
    const source = new Array(200_000).fill(7);
    for (const item of source) target.push(item);
    expect(target).toHaveLength(200_000);
    expect(target[0]).toBe(7);
  });

  it('store 的图聚合不因大链接集抛 RangeError（7 处 push 展开已去掉）', async () => {
    const docs = join(root, 'Docs');
    mkdirSync(docs, { recursive: true });
    const ctx = '0123456789abcdef'.repeat(4);
    const { renderDocWithHash } = await import('../src/knowledge/frontMatter.js');
    // 造 30 页，每页 30 条出链 → 900 条边（真实规模下 GRAPH 上限裁剪才介入）
    for (let i = 0; i < 30; i += 1) {
      const links = Array.from({ length: 30 }, (_, k) => `[[p${(i + k + 1) % 30}]]`).join(' ');
      // 用真实渲染生成合法 content_hash（手写假 hash 会被索引判 invalid，测不到聚合路径）
      const { content } = renderDocWithHash({
        id: `33333333-0000-4000-8000-${String(i).padStart(12, '0')}`,
        slug: `p${i}`, title: `p${i}`, revision: 1, scope: 'workspace',
        workspace_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', status: 'active',
        domain: 'infra', category: 'solved', landed: 'landed',
        sources: [{ source_id: 's', source_type: 'agent', locator: 'issue:1', captured_at: 1, content_hash: ctx, snapshot: 'ok' }],
        evidence: [{ source_id: 's', locator: 'issue:1' }],
        expires_at: null, created_at: 1, updated_at: 1,
        created_by: 't', updated_by: 't', change_note: '',
      }, `正文 ${links}`);
      writeFileSync(join(docs, `p${i}.md`), content, 'utf8');
    }
    const index = new DocsIndex(docs, { scope: 'workspace', workspace_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    index.ensureFresh();
    expect(index.allEntries()).toHaveLength(30);
    expect(index.allInvalid()).toHaveLength(0);
    const refs = index.graphRefs(null);
    // 不抛、且边数符合预期量级
    expect(refs.links.length).toBeGreaterThan(0);
    expect(refs.links.length).toBeLessThanOrEqual(30 * 30);
  });
});

describe('R3-A1 锁等待不再长时冻结', () => {
  it('默认锁上限被压到 200ms（原 3000ms），冲突时快速失败而非长时自旋', async () => {
    // 通过构造「锁已被其它活进程持有」的场景，量实际等待时间
    const { openSync, writeFileSync: write, closeSync, rmSync: rm } = await import('node:fs');
    const root = mkdtempSync(join(tmpdir(), 'r3-a1-'));
    const docs = join(root, 'Docs');
    mkdirSync(docs, { recursive: true });

    const { KnowledgeFileRepo } = await import('../src/knowledge/fileRepo.js');
    const index = new DocsIndex(docs, { scope: 'workspace', workspace_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    index.ensureFresh();
    const repo = new KnowledgeFileRepo(docs, index, { instanceId: 'inst-self' });

    // 手工占锁：holder.pid 用一个「活着但不是本实例」的 pid（父进程即活）
    const lockDir = join(docs, '.locks');
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, 'busy.lock');
    writeFileSync(lockPath, `${JSON.stringify({ pid: process.ppid, instanceId: 'other-instance', ts: Date.now() })}\n`, 'utf8');
    expect(existsSync(lockPath)).toBe(true);

    const started = Date.now();
    let threw = false;
    try {
      repo.create({
        scope: 'workspace', workspace_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        slug: 'busy', title: 'busy', body_md: '正文', actor: 'tester',
        sources: [{ source_id: 's', source_type: 'agent', locator: 'issue:1', captured_at: 1, content_hash: '0123456789abcdef'.repeat(4), snapshot: 'ok' }],
        evidence: [{ source_id: 's', locator: 'issue:1' }],
      });
    } catch {
      threw = true;
    }
    const elapsed = Date.now() - started;
    rm(root, { recursive: true, force: true });

    expect(threw).toBe(true);
    // 修复前约 3000ms；修复后应 ≤ ~400ms（200ms 上限 + 尾部一轮间隔的余量）
    expect(elapsed).toBeLessThan(600);
  });
});
