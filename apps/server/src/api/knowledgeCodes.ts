/**
 * KB-CR-2：知识域错误码单点定义（P3）。
 * 对外码值逐字节不变（快照口径），只收敛定义位置；新增错误码只改这里。
 */
export const KnowledgeErrorCode = {
  NOT_FOUND: 'KNOWLEDGE_NOT_FOUND',
  REVISION_CONFLICT: 'KNOWLEDGE_REVISION_CONFLICT',
  REVISION_NOT_FOUND: 'KNOWLEDGE_REVISION_NOT_FOUND',
  DELETED: 'KNOWLEDGE_DELETED',
  EXISTS: 'KNOWLEDGE_EXISTS',
  REF_AMBIGUOUS: 'KNOWLEDGE_REF_AMBIGUOUS',
  SCOPE_FORBIDDEN: 'KNOWLEDGE_SCOPE_FORBIDDEN',
  STATE_CONFLICT: 'KNOWLEDGE_STATE_CONFLICT',
  UNAVAILABLE: 'KNOWLEDGE_UNAVAILABLE',
  /** P2-01：外部编辑/跨进程写冲突（写前 content_hash 比对或锁等待超时）；CLI 409 → exit 2 */
  FILE_CONFLICT: 'KNOWLEDGE_FILE_CONFLICT',
  /** K3：文件存在但 front matter/校验失败（区别于「不存在」与「属于别的范围」）；CLI 映射为非 0 退出 */
  INVALID: 'KNOWLEDGE_INVALID',
  /** P2-02：export-legacy 目标文件冲突（已存在且内容不同；已备份后暂停，不静默覆盖）；CLI 409 → exit 2 */
  EXPORT_CONFLICT: 'KNOWLEDGE_EXPORT_CONFLICT',
  /** P2-02：export-legacy 写后回读校验失败（正文/front matter 与源行不一致，零丢失红线被破坏） */
  EXPORT_VERIFY_FAILED: 'KNOWLEDGE_EXPORT_VERIFY_FAILED',
} as const;
