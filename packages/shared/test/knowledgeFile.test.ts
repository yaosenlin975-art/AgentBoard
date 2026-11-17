/**
 * K1：知识页 front matter 往返保真（hash 不被误判、CRLF 不破坏 hash）。
 *
 * 缺陷 A：parseScalar 的 `/^-?\d+$/` 抢在引号分支前，64 个 0 的 content_hash 被解析成 number 0
 *        → validateKnowledgeFileMeta 判 bad_type → 页面写入即不可读。
 * 缺陷 B：parse 把 CRLF 归一为 LF，render 不归一 → computeContentHash 在「写时正文」与「读回正文」
 *        两次调用结果不一致（stored ≠ recomp），页面写入即不可读。
 * 缺陷 C：yamlScalar 的 PLAIN_SCALAR 把 64 位 hex 判为无需引号 → 落盘无引号 → 下次 parse 走数字分支。
 */
import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_FILE_FIELD_ORDER,
  parseKnowledgeDocument,
  renderKnowledgeDocument,
  validateKnowledgeFileMeta,
  type KnowledgeFileMeta,
} from '../src/knowledgeFile.js';

const HEX_ALL_ZEROS = '0'.repeat(64);
const HEX_WITH_LETTERS = 'abcdef0123456789'.repeat(4); // 64 位，含字母
const HEX_TAIL_ZEROS = `${'a'.repeat(48)}${'0'.repeat(16)}`;

function baseMeta(overrides: Partial<KnowledgeFileMeta> = {}): KnowledgeFileMeta {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    slug: 'some-slug',
    title: '标题',
    revision: 3,
    scope: 'workspace',
    workspace_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    status: 'active',
    domain: 'infra',
    category: 'solved',
    landed: 'landed',
    sources: [
      {
        source_id: 'file:apps/server/src/index.ts',
        source_type: 'file',
        locator: 'apps/server/src/index.ts',
        captured_at: 1794555536689,
        content_hash: HEX_ALL_ZEROS,
      },
    ],
    evidence: [{ source_id: 'file:apps/server/src/index.ts', locator: 'apps/server/src/index.ts:284-301' }],
    content_hash: HEX_ALL_ZEROS,
    expires_at: null,
    created_at: 1794555500000,
    updated_at: 1794555600000,
    created_by: 'kb-cli',
    updated_by: 'kb-cli',
    change_note: '',
    ...overrides,
  };
}

/** 顶层与 sources[0] 同时写入同一个 hash */
function getFieldMeta(hash: string): KnowledgeFileMeta {
  return baseMeta({
    content_hash: hash,
    sources: [
      {
        source_id: 'file:apps/server/src/index.ts',
        source_type: 'file',
        locator: 'apps/server/src/index.ts',
        captured_at: 1794555536689,
        content_hash: hash,
      },
    ],
  });
}

describe('K1-A 全 hex 数字串的 content_hash 必须按字符串解析', () => {
  it('顶层 content_hash 为 64 个 0：往返后仍是字符串且逐字节一致', () => {
    const meta = baseMeta({ content_hash: HEX_ALL_ZEROS });
    const parsed = parseKnowledgeDocument(renderKnowledgeDocument(meta, 'body\n'));
    expect(typeof parsed.meta.content_hash).toBe('string');
    expect(parsed.meta.content_hash).toBe(HEX_ALL_ZEROS);
  });

  it('sources[].content_hash 为 64 个 0：往返后仍是字符串且逐字节一致', () => {
    const meta = baseMeta();
    const parsed = parseKnowledgeDocument(renderKnowledgeDocument(meta, 'body\n'));
    expect(typeof parsed.meta.sources[0]!.content_hash).toBe('string');
    expect(parsed.meta.sources[0]!.content_hash).toBe(HEX_ALL_ZEROS);
  });

  it('含字母的 hex 与「前段字母后段 0」的 hex 均保持字符串', () => {
    for (const hash of [HEX_WITH_LETTERS, HEX_TAIL_ZEROS]) {
      const writesBoth = getFieldMeta(hash);
      const parsed = parseKnowledgeDocument(renderKnowledgeDocument(writesBoth, 'body\n'));
      expect(parsed.meta.content_hash).toBe(hash);
      expect(parsed.meta.sources[0]!.content_hash).toBe(hash);
    }
  });

  it('手写无引号的 64 位 hex（历史文件/外部编辑）也按字符串解析', () => {
    const doc = [
      '---',
      'id: 11111111-2222-4333-8444-555555555555',
      'slug: some-slug',
      'title: 标题',
      'revision: 3',
      'scope: workspace',
      'workspace_id: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      'status: active',
      'domain: infra',
      'category: solved',
      'landed: landed',
      'sources:',
      `  - source_id: file:x.ts`,
      `    source_type: file`,
      `    locator: x.ts`,
      `    captured_at: 1794555536689`,
      `    content_hash: ${HEX_ALL_ZEROS}`,
      'evidence:',
      `  - source_id: file:x.ts`,
      `    locator: x.ts:1-2`,
      `content_hash: ${HEX_ALL_ZEROS}`,
      'expires_at: null',
      'created_at: 1794555500000',
      'updated_at: 1794555600000',
      'created_by: kb-cli',
      'updated_by: kb-cli',
      'change_note: ""',
      '---',
      '',
      'body',
    ].join('\n');
    const parsed = parseKnowledgeDocument(doc);
    expect(typeof parsed.meta.content_hash).toBe('string');
    expect(parsed.meta.content_hash).toBe(HEX_ALL_ZEROS);
    expect(typeof parsed.meta.sources[0]!.content_hash).toBe('string');
  });

  it('裸写 64 位 hex 落盘（render 不改写格式），parse 仍解析为字符串', () => {
    const bare = renderKnowledgeDocument(getFieldMeta(HEX_ALL_ZEROS), 'body\n');
    // render 必须保持历史格式：content_hash 不加引号（加引号会改变 hash 输入字节）
    expect(bare).toContain(`content_hash: ${HEX_ALL_ZEROS}`);
    expect(bare).not.toContain(`content_hash: "${HEX_ALL_ZEROS}"`);
    expect(parseKnowledgeDocument(bare).meta.content_hash).toBe(HEX_ALL_ZEROS);
    expect(typeof parseKnowledgeDocument(bare).meta.sources[0]!.content_hash).toBe('string');
  });

  it('带引号的 hex（外部工具手写）也能解析为字符串', () => {
    const doc = renderKnowledgeDocument(getFieldMeta(HEX_ALL_ZEROS), 'body\n')
      .replace(new RegExp(`content_hash: ${HEX_ALL_ZEROS}`, 'g'), `content_hash: "${HEX_ALL_ZEROS}"`);
    expect(parseKnowledgeDocument(doc).meta.content_hash).toBe(HEX_ALL_ZEROS);
  });
});

describe('K1 真数字字段不受影响', () => {
  it('captured_at / revision / created_at / updated_at 仍解析为 number', () => {
    const parsed = parseKnowledgeDocument(renderKnowledgeDocument(baseMeta(), 'body\n'));
    expect(parsed.meta.revision).toBe(3);
    expect(parsed.meta.created_at).toBe(1794555500000);
    expect(parsed.meta.updated_at).toBe(1794555600000);
    expect(parsed.meta.sources[0]!.captured_at).toBe(1794555536689);
    expect(typeof parsed.meta.sources[0]!.captured_at).toBe('number');
  });

  it('expires_at 为数字时保持 number、为 null 时保持 null', () => {
    const withExpiry = parseKnowledgeDocument(
      renderKnowledgeDocument(baseMeta({ expires_at: 1794559999999 }), 'body\n'),
    );
    expect(withExpiry.meta.expires_at).toBe(1794559999999);
    const noExpiry = parseKnowledgeDocument(renderKnowledgeDocument(baseMeta(), 'body\n'));
    expect(noExpiry.meta.expires_at).toBeNull();
  });
});

describe('K1-B 正文换行的往返行为', () => {
  it('LF 正文逐字节保真', () => {
    const body = '第一行\n第二行\n';
    const parsed = parseKnowledgeDocument(renderKnowledgeDocument(baseMeta(), body));
    expect(parsed.body_md).toBe(body);
  });

  it('孤立 CR 正文逐字节保真（parse 只归一 CRLF，不动孤立 CR）', () => {
    const body = 'AAA\rBBB\n';
    const parsed = parseKnowledgeDocument(renderKnowledgeDocument(baseMeta(), body));
    expect(parsed.body_md).toBe(body);
  });

  it('CRLF 正文：读回为 LF（历史文件兼容口径）', () => {
    const body = 'AAA\r\nBBB\r\n';
    const parsed = parseKnowledgeDocument(renderKnowledgeDocument(baseMeta(), body));
    expect(parsed.body_md).toBe('AAA\nBBB\n');
  });

  it('历史 CRLF 文件仍能解析（不因归一破坏字段识别）', () => {
    const doc = renderKnowledgeDocument(baseMeta(), 'AAA\nBBB\n').replace(/\n/g, '\r\n');
    const parsed = parseKnowledgeDocument(doc);
    expect(parsed.meta.slug).toBe('some-slug');
    expect(parsed.body_md).toBe('AAA\nBBB\n');
  });
});

describe('K1 字段顺序与契约不变', () => {
  it('render 的顶层字段顺序仍等于 KNOWLEDGE_FILE_FIELD_ORDER', () => {
    const content = renderKnowledgeDocument(baseMeta(), 'body\n');
    const head = content.slice(0, content.indexOf('\n---\n'));
    const keys = head
      .split('\n')
      .slice(1)
      .filter((line) => /^[A-Za-z_]/.test(line))
      .map((line) => line.slice(0, line.indexOf(':')));
    expect(keys).toEqual([...KNOWLEDGE_FILE_FIELD_ORDER]);
  });

  it('同一 meta+body 重复渲染逐字节一致（幂等）', () => {
    const meta = baseMeta();
    expect(renderKnowledgeDocument(meta, 'body\n')).toBe(renderKnowledgeDocument(meta, 'body\n'));
  });
});

describe('K1-D 向后兼容护栏：render 字节格式不得改变', () => {
  // content_hash 的唯一职责是检测外部编辑，算法必须对既有落盘格式稳定。
  // computeContentHash 只 omit 顶层 content_hash，sources[].content_hash 仍在 hash 输入里，
  // 所以任何 render 格式改动（如给 hex 加引号）都会把所有历史文件判成「被外部编辑」。
  it('历史格式文档（裸写 hex）parse 后 render 回写必须逐字节一致', () => {
    const legacyDoc = [
      '---',
      'id: 11111111-2222-4333-8444-555555555555',
      'slug: some-slug',
      'title: legacy-title',
      'revision: 3',
      'scope: workspace',
      'workspace_id: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      'status: active',
      'domain: infra',
      'category: solved',
      'landed: landed',
      'sources:',
      '  - source_id: s1',
      '    source_type: file',
      '    locator: x.ts',
      '    captured_at: 1794555536689',
      `    content_hash: ${HEX_WITH_LETTERS}`,
      'evidence:',
      '  - source_id: s1',
      '    locator: x.ts',
      `content_hash: ${HEX_ALL_ZEROS}`,
      'expires_at: null',
      'created_at: 1794555500000',
      'updated_at: 1794555600000',
      'created_by: kb-cli',
      'updated_by: kb-cli',
      'change_note: ""',
      '---',
      '',
      '正文',
    ].join('\n');
    const parsed = parseKnowledgeDocument(legacyDoc);
    expect(renderKnowledgeDocument(parsed.meta, parsed.body_md)).toBe(legacyDoc);
  });

  it('render 输出不含任何被加引号的 content_hash', () => {
    expect(renderKnowledgeDocument(getFieldMeta(HEX_WITH_LETTERS), 'body\n')).not.toMatch(/content_hash: "/);
    expect(renderKnowledgeDocument(getFieldMeta(HEX_ALL_ZEROS), 'body\n')).not.toMatch(/content_hash: "/);
  });
});
