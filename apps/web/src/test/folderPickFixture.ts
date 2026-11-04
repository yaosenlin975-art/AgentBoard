/** FOLDER-PICK 用例共用的 msw 夹具：存储信息最小可渲染数据 + pick-folder 返回值。 */
import { HttpResponse, http } from 'msw';

export const STORAGE_INFO_FIXTURE = {
  db_path: 'C:\\Users\\31633\\AppData\\Roaming\\AgentBoard\\agentboard.db',
  db_path_source: 'default',
  attachments_dir: 'C:\\Users\\31633\\AppData\\Roaming\\AgentBoard\\attachments',
  usage: { db_bytes: 1024, wal_bytes: 0, shm_bytes: 0, attachments_bytes: 0, total_bytes: 1024 },
  usage_truncated: false,
  migration_estimate: { issues: 3, attachments: 1, bytes: 2048 },
} as const;

/** POST /api/system/pick-folder：返回给定路径（null = 用户取消） */
export const pickHandler = (path: string | null) =>
  http.post('/api/system/pick-folder', () => HttpResponse.json({ path }));
