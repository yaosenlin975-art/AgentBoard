import type { KnowledgeEvidence, KnowledgePage, KnowledgeRevision, KnowledgeScope, KnowledgeSource } from '@agentboard/shared';
import { textWindow } from '@agentboard/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { McpConfig } from '../config.js';
import { McpError, requireAgentId, resolveWorkspaceId } from '../config.js';
import { AgentBoardApiClient } from '../apiClient.js';
import { mcpToolResultFits, mcpToolSuccess, MCP_TOOL_RESULT_LIMIT } from './result.js';
import { registerBoardTool } from './register.js';

const MAX_TOOL_RESULT_CHARS = MCP_TOOL_RESULT_LIMIT - 500;
const MAX_HISTORY = 50;
const scopeFields = { scope: z.enum(['workspace', 'common']), workspace_id: z.string().trim().min(1).optional() };
const pageIdField = { page_id: z.string().trim().min(1) };
const requestIdField = { request_id: z.string().uuid() };
const snapshotSchema = z.string().refine((value) => value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 2048, 'Evidence snapshot must be non-empty and at most 2 KiB.');
const sourceSchema = z.object({
  source_id: z.string().trim().min(1).max(2000),
  source_type: z.enum(['file', 'url', 'agent']),
  locator: z.string().trim().min(1).max(2000),
  captured_at: z.number().int().nonnegative(),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/i),
  snapshot: snapshotSchema.optional(),
}).strict();
const evidenceSchema = z.object({
  source_id: z.string().trim().min(1).max(2000),
  locator: z.string().trim().min(1).max(2000),
  snapshot: snapshotSchema.optional(),
}).strict();
const contentFields = {
  title: z.string().trim().min(1).max(300),
  body_md: z.string().min(1).max(100000),
  sources: z.array(sourceSchema).min(1).max(100),
  evidence: z.array(evidenceSchema).min(1).max(100),
  expires_at: z.number().int().nonnegative().nullable().optional(),
};
const offsetField = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const limitField = z.number().int().min(1).max(100);
const readFields = {
  ...scopeFields,
  ...pageIdField,
  include_history: z.boolean().default(false),
  history_offset: offsetField.default(0),
  history_limit: z.number().int().min(1).max(MAX_HISTORY).default(20),
  history_body_offset_chars: offsetField.optional(),
  offset_chars: offsetField.default(0),
  max_chars: z.number().int().min(1).max(40000).default(12000),
  sources_offset: offsetField.default(0),
  sources_limit: limitField.default(10),
  evidence_offset: offsetField.default(0),
  evidence_limit: limitField.default(10),
};

type ToolResponse = ReturnType<typeof mcpToolSuccess>;
type SearchItem = {
  page_id: string;
  scope: 'workspace' | 'common';
  workspace_id: string | null;
  revision: number;
  title: string;
  snippet: string;
  sources: KnowledgeSource[];
  evidence: KnowledgeEvidence[];
  score: number;
};
type KnowledgeReadInput = {
  page_id: string;
  scope: 'workspace' | 'common';
  workspace_id?: string;
  include_history: boolean;
  history_offset: number;
  history_limit: number;
  history_body_offset_chars?: number;
  offset_chars: number;
  max_chars: number;
  sources_offset: number;
  sources_limit: number;
  evidence_offset: number;
  evidence_limit: number;
};

function outputFits(response: ToolResponse): boolean {
  return mcpToolResultFits(response, MAX_TOOL_RESULT_CHARS);
}

function ensureFits(data: unknown): void {
  if (!outputFits(mcpToolSuccess(data, 'knowledge tool succeeded.'))) {
    throw new McpError('KNOWLEDGE_RESULT_TOO_LARGE', 'The knowledge response exceeds the 40,000-character limit. Reduce max_chars, history_limit, sources_limit, or evidence_limit and continue from the returned offsets.');
  }
}

function knowledgeScope(config: McpConfig, scope: 'workspace' | 'common', workspaceId?: string): KnowledgeScope {
  if (scope === 'common') {
    if (workspaceId !== undefined) throw new McpError('INVALID_ARGUMENT', 'Common knowledge must omit workspace_id.');
    return { scope: 'common' };
  }
  return { scope: 'workspace', workspace_id: resolveWorkspaceId(config, workspaceId) };
}

function searchScope(config: McpConfig, scope: 'workspace' | 'common' | 'both', workspaceId?: string): { scope: 'workspace' | 'common' | 'both'; workspace_id?: string } {
  if (scope === 'common') {
    if (workspaceId !== undefined) throw new McpError('INVALID_ARGUMENT', 'Common knowledge must omit workspace_id.');
    return { scope: 'common' };
  }
  return { scope, workspace_id: resolveWorkspaceId(config, workspaceId) };
}

function pageArray<T>(items: T[], offset: number, limit: number): { items: T[]; next_offset: number | null; total: number } {
  const selected = items.slice(offset, offset + limit);
  return {
    items: selected,
    next_offset: offset + selected.length < items.length ? offset + selected.length : null,
    total: items.length,
  };
}

/** /knowledge/pages 与 /knowledge/find-source 的列表行（服务端已附 link/link_info） */
type KnowledgeListRow = {
  id: string;
  scope: 'workspace' | 'common';
  workspace_id: string | null;
  slug: string;
  title: string;
  status: string;
  revision: number;
  category?: string | null;
  landed?: string | null;
  domain?: string | null;
  expires_at: number | null;
  updated_at: number;
  link?: string;
};

/** 列表摘要：只保留浏览所需字段，丢掉正文/引用渲染串，保证 100 条也能塞进 40k 上限 */
function pageSummary(row: KnowledgeListRow): Record<string, unknown> {
  return {
    id: row.id,
    scope: row.scope,
    workspace_id: row.workspace_id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    revision: row.revision,
    category: row.category ?? null,
    landed: row.landed ?? null,
    domain: row.domain ?? null,
    expires_at: row.expires_at,
    updated_at: row.updated_at,
    ...(row.link !== undefined ? { link: row.link } : {}),
  };
}

const MAX_LIST_LIMIT = 100;
const MAX_FIND_SOURCE_ITEMS = 100;

function mutationSummary(page: KnowledgePage): Record<string, unknown> {
  let low = 0;
  let high = Math.min(12000, Array.from(page.body_md).length);
  let best: Record<string, unknown> | undefined;
  while (low <= high) {
    const size = Math.floor((low + high) / 2);
    const window = textWindow(page.body_md, 0, size);
    const data = {
      id: page.id,
      scope: page.scope,
      workspace_id: page.workspace_id,
      slug: page.slug,
      title: page.title,
      status: page.status,
      revision: page.revision,
      expires_at: page.expires_at,
      body_md: window.content,
      body_truncated: window.truncated,
      next_offset_chars: window.next_offset_chars,
      sources_count: page.sources.length,
      evidence_count: page.evidence.length,
      read_tool: 'read_knowledge',
    };
    if (outputFits(mcpToolSuccess(data, 'knowledge tool succeeded.'))) {
      best = data;
      low = size + 1;
    } else high = size - 1;
  }
  if (!best) throw new McpError('KNOWLEDGE_RESULT_TOO_LARGE', 'The knowledge write succeeded, but its bounded result could not be returned. Read the page by ID before retrying.');
  return best;
}

function resolveReadPage(page: KnowledgePage, input: KnowledgeReadInput, bodyMaxChars: number, selectedHistory: KnowledgeRevision[], historyNextOffset: number | null): Record<string, unknown> {
  const pageBody = textWindow(page.body_md, input.offset_chars, bodyMaxChars);
  const pageSources = pageArray(page.sources, input.sources_offset, input.sources_limit);
  const pageEvidence = pageArray(page.evidence, input.evidence_offset, input.evidence_limit);
  const history = selectedHistory.map((revision) => {
    const bodyWindow = textWindow(revision.body_snapshot, input.history_body_offset_chars ?? 0, input.max_chars);
    const sources = pageArray(revision.sources, input.sources_offset, input.sources_limit);
    const evidence = pageArray(revision.evidence, input.evidence_offset, input.evidence_limit);
    return {
      ...revision,
      body_snapshot: bodyWindow.content,
      body_snapshot_truncated: bodyWindow.truncated,
      next_body_snapshot_offset_chars: bodyWindow.next_offset_chars,
      sources: sources.items,
      sources_total: sources.total,
      sources_next_offset: sources.next_offset,
      evidence: evidence.items,
      evidence_total: evidence.total,
      evidence_next_offset: evidence.next_offset,
    };
  });
  return {
    page: {
      ...page,
      body_md: pageBody.content,
      sources: pageSources.items,
      evidence: pageEvidence.items,
    },
    truncated: pageBody.truncated,
    next_offset_chars: pageBody.next_offset_chars,
    sources_total: pageSources.total,
    sources_next_offset: pageSources.next_offset,
    evidence_total: pageEvidence.total,
    evidence_next_offset: pageEvidence.next_offset,
    history: { items: history, next_offset: historyNextOffset },
    history_next_offset: historyNextOffset,
  };
}

async function readKnowledge(
  input: KnowledgeReadInput,
  config: McpConfig,
  api: AgentBoardApiClient,
): Promise<Record<string, unknown>> {
  if (input.history_body_offset_chars !== undefined && (!input.include_history || input.history_limit !== 1)) {
    throw new McpError('INVALID_ARGUMENT', 'history_body_offset_chars requires include_history=true and history_limit=1.');
  }
  const scope = knowledgeScope(config, input.scope, input.workspace_id);
  const scopeQuery = scope.scope === 'common'
    ? { scope: 'common' }
    : { scope: 'workspace', workspace_id: scope.workspace_id };
  const page = await api.get<KnowledgePage>(`/knowledge/pages/${encodeURIComponent(input.page_id)}`, scopeQuery, 'KNOWLEDGE_UNAVAILABLE');
  let revisions: KnowledgeRevision[] = [];
  let apiNextOffset: number | null = null;
  if (input.include_history) {
    const history = await api.get<{ items: KnowledgeRevision[]; next_offset: number | null }>(
      `/knowledge/pages/${encodeURIComponent(input.page_id)}/revisions`,
      { ...scopeQuery, offset: input.history_offset, limit: input.history_limit },
      'KNOWLEDGE_UNAVAILABLE',
    );
    revisions = history.items;
    apiNextOffset = history.next_offset;
  }

  const build = (bodyMaxChars: number, selected: KnowledgeRevision[]) => {
    const nextOffset = selected.length < revisions.length
      ? input.history_offset + selected.length
      : apiNextOffset;
    return resolveReadPage(page, input, bodyMaxChars, selected, nextOffset);
  };
  let selected: KnowledgeRevision[] = [];
  let data = build(input.max_chars, selected);
  if (!outputFits(mcpToolSuccess(data, 'knowledge tool succeeded.'))) {
    let found = false;
    let low = 0;
    let high = input.max_chars;
    while (low <= high) {
      const size = Math.floor((low + high) / 2);
      const candidate = build(size, []);
      if (outputFits(mcpToolSuccess(candidate, 'knowledge tool succeeded.'))) {
        data = candidate;
        low = size + 1;
        found = true;
      } else high = size - 1;
    }
    if (!found) throw new McpError('KNOWLEDGE_RESULT_TOO_LARGE', 'Page metadata and the requested source/evidence windows exceed the 40,000-character limit. Reduce sources_limit or evidence_limit and continue from their offsets.');
  }

  if (input.include_history && revisions.length) {
    let accepted = 0;
    for (let count = 1; count <= revisions.length; count++) {
      const candidate = build(input.max_chars, revisions.slice(0, count));
      if (!outputFits(mcpToolSuccess(candidate, 'knowledge tool succeeded.'))) break;
      data = candidate;
      selected = revisions.slice(0, count);
      accepted = count;
    }
    if (accepted === 0) {
      let low = 0;
      let high = input.max_chars;
      let best: Record<string, unknown> | undefined;
      while (low <= high) {
        const size = Math.floor((low + high) / 2);
        const candidate = build(size, revisions.slice(0, 1));
        if (outputFits(mcpToolSuccess(candidate, 'knowledge tool succeeded.'))) {
          best = candidate;
          low = size + 1;
        } else high = size - 1;
      }
      if (!best) throw new McpError('KNOWLEDGE_RESULT_TOO_LARGE', 'The first requested history revision exceeds the 40,000-character limit. Reduce source/evidence limits or use a smaller history page.');
      data = best;
      selected = revisions.slice(0, 1);
    }
  }
  ensureFits(data);
  return data;
}

export function registerKnowledgeTools(server: McpServer, config: McpConfig, api: AgentBoardApiClient): void {
  // CR2-8：注册样板收敛到 registerBoardTool；这里只剩知识域的 40k 体积闸
  const register = (name: string, description: string, inputSchema: z.ZodObject<any>, run: (input: any) => Promise<unknown>, readOnly = true) =>
    registerBoardTool(server, {
      name,
      description,
      inputSchema,
      readOnly,
      onResult: (data, summary) => {
        const response = mcpToolSuccess(data, summary);
        if (!mcpToolResultFits(response)) throw new McpError('KNOWLEDGE_RESULT_TOO_LARGE', 'The knowledge response exceeds the 40,000-character limit. Reduce the requested page sizes and continue from the returned offsets.');
        return response;
      },
    }, run);

  register('search_knowledge', 'Search knowledge in common, one workspace, or that workspace plus common.', z.object({
    ...scopeFields,
    scope: z.enum(['common', 'workspace', 'both']),
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(20).default(5),
  }).strict(), async ({ scope, workspace_id, query, limit }) => {
    const effective = searchScope(config, scope, workspace_id);
    const items = await api.get<SearchItem[]>('/knowledge/search', { q: query, limit, ...effective }, 'KNOWLEDGE_UNAVAILABLE');
    return {
      items: items.map(({ page_id, ...item }) => ({
        id: page_id,
        ...item,
        sources: item.sources.slice(0, 1).map(({ source_id, source_type, locator }) => ({ source_id, source_type, locator })),
        sources_total: item.sources.length,
        sources_next_offset: item.sources.length > 1 ? 1 : null,
        evidence: item.evidence.slice(0, 1).map(({ source_id, locator }) => ({ source_id, locator })),
        evidence_total: item.evidence.length,
        evidence_next_offset: item.evidence.length > 1 ? 1 : null,
      })),
    };
  });

  register('list_knowledge', 'List knowledge pages as bounded metadata summaries (no body) in common, one workspace, or that workspace plus common.', z.object({
    ...scopeFields,
    scope: z.enum(['common', 'workspace', 'both']).default('workspace'),
    status: z.enum(['active', 'archived', 'deleted', 'all']).default('active'),
    include_expired: z.boolean().default(false),
    offset: offsetField.default(0),
    limit: z.number().int().min(1).max(MAX_LIST_LIMIT).default(20),
  }).strict(), async ({ scope, workspace_id, status, include_expired, offset, limit }) => {
    const effective = searchScope(config, scope, workspace_id);
    const listing = await api.get<{ items: KnowledgeListRow[]; next_offset: number | null }>('/knowledge/pages', {
      scope: effective.scope,
      workspace_id: effective.workspace_id,
      status,
      include_expired: include_expired ? 'true' : 'false',
      offset,
      limit,
    }, 'KNOWLEDGE_UNAVAILABLE');
    return {
      scope: effective.scope,
      workspace_id: effective.workspace_id ?? null,
      items: listing.items.map(pageSummary),
      next_offset: listing.next_offset,
    };
  });

  register('find_knowledge_sources', 'Find knowledge pages whose current sources reference a file path, content hash, or source id.', z.object({
    ...scopeFields,
    scope: z.enum(['common', 'workspace', 'both']).default('both'),
    path: z.string().trim().min(1).max(2000),
  }).strict(), async ({ scope, workspace_id, path }) => {
    const effective = searchScope(config, scope, workspace_id);
    const found = await api.get<{ path: string; items: KnowledgeListRow[] }>('/knowledge/find-source', {
      path,
      scope: effective.scope,
      workspace_id: effective.workspace_id,
    }, 'KNOWLEDGE_UNAVAILABLE');
    const items = found.items.slice(0, MAX_FIND_SOURCE_ITEMS).map(pageSummary);
    return {
      path: found.path,
      total: found.items.length,
      items,
      truncated: found.items.length > items.length,
    };
  });

  register('read_knowledge', 'Read one knowledge page with codepoint windows, paged sources/evidence, and optional paged history.', z.object(readFields).strict(), async (input) => {
    return readKnowledge(input as KnowledgeReadInput, config, api);
  });

  register('create_knowledge', 'Create a knowledge page in the explicitly selected scope.', z.object({
    ...scopeFields,
    ...contentFields,
    slug: z.string().trim().min(1).max(200),
    change_note: z.string().max(2000).optional(),
    ...requestIdField,
  }).strict(), async ({ scope: rawScope, workspace_id, title, body_md, sources, evidence, expires_at, slug, change_note, request_id }) => {
    const scope = knowledgeScope(config, rawScope, workspace_id);
    const actor = requireAgentId(config);
    const page = await api.mutate<KnowledgePage>('POST', '/knowledge/pages', {
      ...scope, title, body_md, sources, evidence, slug, actor,
      ...(expires_at !== undefined ? { expires_at } : {}),
      ...(change_note !== undefined ? { change_note } : {}),
    }, request_id, undefined, 'KNOWLEDGE_UNAVAILABLE');
    return mutationSummary(page);
  }, false);

  register('revise_knowledge', 'Revise a knowledge page using expected_revision compare-and-swap.', z.object({
    ...scopeFields,
    ...pageIdField,
    ...z.object(contentFields).partial().shape,
    change_note: z.string().max(2000).optional(),
    expected_revision: z.number().int().positive(),
    ...requestIdField,
  }).strict().refine((input) => ['title', 'body_md', 'sources', 'evidence', 'expires_at'].some((key) => input[key as keyof typeof input] !== undefined), {
    message: 'At least one knowledge field must be provided.',
  }), async ({ scope: rawScope, workspace_id, page_id, expected_revision, change_note, request_id, ...patch }) => {
    const scope = knowledgeScope(config, rawScope, workspace_id);
    const actor = requireAgentId(config);
    const page = await api.mutate<KnowledgePage>('PUT', `/knowledge/pages/${encodeURIComponent(page_id)}`, {
      ...scope, ...patch, expected_revision, actor, ...(change_note !== undefined ? { change_note } : {}),
    }, request_id, 'KNOWLEDGE_REVISION_CONFLICT', 'KNOWLEDGE_UNAVAILABLE');
    return mutationSummary(page);
  }, false);

  const registerAction = (name: 'archive_knowledge' | 'restore_knowledge', action: 'archive' | 'restore') => {
    register(name, `${action === 'archive' ? 'Archive' : 'Restore'} a knowledge page using expected_revision compare-and-swap.`, z.object({
      ...scopeFields,
      ...pageIdField,
      expected_revision: z.number().int().positive(),
      ...requestIdField,
    }).strict(), async ({ scope: rawScope, workspace_id, page_id, expected_revision, request_id }) => {
      const scope = knowledgeScope(config, rawScope, workspace_id);
      const actor = requireAgentId(config);
      const page = await api.mutate<KnowledgePage>('POST', `/knowledge/pages/${encodeURIComponent(page_id)}/actions`, {
        ...scope, action, expected_revision, actor,
      }, request_id, 'KNOWLEDGE_REVISION_CONFLICT', 'KNOWLEDGE_UNAVAILABLE');
      return mutationSummary(page);
    }, false);
  };
  registerAction('archive_knowledge', 'archive');
  registerAction('restore_knowledge', 'restore');
}
