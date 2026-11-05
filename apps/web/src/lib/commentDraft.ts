/**
 * I-04：评论草稿按任务存 localStorage（刷新/关面板后重开可恢复）。
 * 读写都做容错：隐私模式或脏数据一律退化成「无草稿」，不影响评论区可用性。
 */
const PREFIX = 'agentboard.comment-draft:';

function key(issueId: string): string {
  return `${PREFIX}${issueId}`;
}

export function readCommentDraft(issueId: string): string {
  try {
    return localStorage.getItem(key(issueId)) ?? '';
  } catch {
    return '';
  }
}

export function writeCommentDraft(issueId: string, draft: string): void {
  try {
    if (draft === '') localStorage.removeItem(key(issueId));
    else localStorage.setItem(key(issueId), draft);
  } catch {
    // 存不了就只保留内存态，不抛错
  }
}
