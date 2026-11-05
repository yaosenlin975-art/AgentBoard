/**
 * BORROW-3.2：知识深链解析。
 * 三种入口：`/k/:id`、`/k/:id/:slug`（slug 只做可读性，任意值忽略）、`?kb=<id>`。
 * id 为权威；解析结果交 resolve API（支持完整 id 与短 id 前缀）。
 */
export interface KnowledgeDeepLink {
  /** 深链目标页引用（完整 id 或短 id 前缀） */
  pageId: string;
}

export function parseKnowledgeDeepLink(href: string): KnowledgeDeepLink | null {
  let pathname: string;
  let search: string;
  try {
    const url = new URL(href);
    pathname = url.pathname;
    search = url.search;
  } catch {
    return null;
  }
  const m = /^\/k\/([^/]+)(?:\/.*)?$/.exec(pathname);
  const rawId = m?.[1];
  if (rawId !== undefined) {
    try {
      return { pageId: decodeURIComponent(rawId) };
    } catch {
      return { pageId: rawId };
    }
  }
  const kb = new URLSearchParams(search).get('kb');
  if (kb !== null && kb.trim() !== '') return { pageId: kb.trim() };
  return null;
}
