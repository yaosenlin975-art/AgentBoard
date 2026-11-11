/**
 * spawn 结果到失败文案的映射（【MAC-TRIAL-B04】）。
 *
 * 背景：pnpm 不在 PATH 时 spawnSync 返回 error=ENOENT、status=null，
 * 旧实现只看 status，报出无法归因的「退出码 null」。这里把 error 放在首位判断。
 *
 * @param {string} cmd 被执行的命令名
 * @param {{ error?: { code?: string; message?: string } | null, status?: number | null }} result spawnSync 返回值
 * @returns {string | null} 失败文案；成功返回 null
 */
export function spawnFailure(cmd, result) {
  const error = result?.error;
  if (error) {
    if (error.code === 'ENOENT') return `${cmd} 不在 PATH（ENOENT）`;
    return `${cmd} 启动失败：${error.code || error.message || '未知错误'}`;
  }
  if (result?.status !== 0) return `${cmd} 退出码 ${result?.status}`;
  return null;
}
