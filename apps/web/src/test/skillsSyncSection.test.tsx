/**
 * SKILLS-SYNC 设置分区（真端点 + msw 桩）：
 * 覆盖：目标清单渲染（状态徽标 / 同物理目录提示 / 来源目录禁用）、
 * 勾选后复制提交体、409 冲突三选（备份后覆盖重提）、移除调用与结果渲染。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { SkillsSyncSection } from '../components/settings/SkillsSyncSection';
import { useAppStore } from '../state/appStore';
import { server } from './server';

interface ProbeTarget {
  id: string;
  label: string;
  path: string;
  resolved_path: string | null;
  exists: boolean;
  creatable: boolean;
  shared_with: string[];
  is_source: boolean;
  status: 'synced' | 'stale' | 'never' | 'unavailable';
  skills_present: number;
  synced_at: string | null;
}

const TARGETS: ProbeTarget[] = [
  {
    id: 'agents', label: '通用技能库 ~/.agents/skills', path: 'C:\\Users\\x\\.agents\\skills', resolved_path: 'C:\\Users\\x\\.agents\\skills',
    exists: true, creatable: false, shared_with: ['cursor'], is_source: false, status: 'synced', skills_present: 8, synced_at: '2026-11-10T03:20:00.000Z',
  },
  {
    id: 'cursor', label: 'Cursor ~/.cursor/skills-cursor', path: 'C:\\Users\\x\\.cursor\\skills-cursor', resolved_path: 'C:\\Users\\x\\.agents\\skills',
    exists: true, creatable: false, shared_with: ['agents'], is_source: false, status: 'synced', skills_present: 8, synced_at: '2026-11-10T03:20:00.000Z',
  },
  {
    id: 'claude', label: 'Claude Code ~/.claude/skills', path: 'C:\\Users\\x\\.claude\\skills', resolved_path: null,
    exists: false, creatable: true, shared_with: [], is_source: false, status: 'never', skills_present: 0, synced_at: null,
  },
  {
    id: 'qoder', label: 'Qoder ~/.qoder/skills', path: 'C:\\Users\\x\\.qoder\\skills', resolved_path: 'C:\\Users\\x\\.qoder\\skills',
    exists: true, creatable: false, shared_with: [], is_source: false, status: 'stale', skills_present: 1, synced_at: null,
  },
  {
    id: 'workspace', label: '当前工作区 .agentboard/skills', path: 'D:\\ws\\.agentboard\\skills', resolved_path: 'D:\\ws\\.agentboard\\skills',
    exists: true, creatable: false, shared_with: [], is_source: true, status: 'synced', skills_present: 8, synced_at: null,
  },
];

const PROBE = {
  source: { root: 'D:\\WorkSpaces\\任务看板\\skills', skill_count: 8, file_count: 57, hash: 'abc' },
  targets: TARGETS,
};

function mockProbe(): void {
  server.use(http.get('/api/settings/skills-sync/targets', () => HttpResponse.json(PROBE)));
}

function renderSection(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SkillsSyncSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ workspaceId: 'ws-1' });
  mockProbe();
});

describe('SKILLS-SYNC 分区', () => {
  it('渲染目标清单：状态徽标 / 同物理目录提示 / 来源目录禁用', async () => {
    renderSection();
    expect(await screen.findByTestId('settings-skills-sync-source')).toHaveTextContent('skills');
    expect(screen.getByTestId('skills-sync-status-agents')).toHaveTextContent('已同步');
    expect(screen.getByTestId('skills-sync-status-claude')).toHaveTextContent('未同步');
    expect(screen.getByTestId('skills-sync-status-qoder')).toHaveTextContent('有差异 · 1/8');
    expect(screen.getByTestId('skills-sync-shared-agents')).toHaveTextContent('Cursor');
    // 来源目录不可勾选、不给移除入口
    expect(screen.getByTestId('skills-sync-check-workspace')).toBeDisabled();
    expect(screen.queryByTestId('skills-sync-remove-workspace')).toBeNull();
    // 已同步目标显示同步时间与移除按钮
    expect(screen.getByTestId('skills-sync-remove-agents')).toBeInTheDocument();
  });

  it('勾选两个目标复制：提交体含 target_ids，结果区展示写入数量', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post('/api/settings/skills-sync', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({
          results: [
            { target_id: 'claude', path: 'C:\\Users\\x\\.claude\\skills', action: 'copied', backup_dir: null, skills: [{ name: 'handoff', files: 13, bytes: 100, status: 'copied' }], errors: [] },
            { target_id: 'qoder', path: 'C:\\Users\\x\\.qoder\\skills', action: 'copied', backup_dir: null, skills: [{ name: 'handoff', files: 13, bytes: 100, status: 'overwritten' }], errors: [] },
          ],
          summary: { targets: 2, copied: 2, skipped: 0, errors: 0, total_files: 26 },
        });
      }),
    );
    renderSection();
    await userEvent.click(await screen.findByTestId('skills-sync-check-claude'));
    await userEvent.click(screen.getByTestId('skills-sync-check-qoder'));
    await userEvent.click(screen.getByTestId('skills-sync-copy'));
    expect(await screen.findByTestId('skills-sync-result')).toHaveTextContent('写入 26 个文件');
    expect(bodies).toEqual([{ target_ids: ['claude', 'qoder'], workspace_id: 'ws-1' }]);
    expect(screen.getByTestId('skills-sync-result-claude')).toHaveTextContent('写入 1 个技能');
  });

  it('409 冲突：显示三选，选「备份后覆盖」重提 conflict=backup', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post('/api/settings/skills-sync', async ({ request }) => {
        const body = (await request.json()) as { conflict?: string };
        bodies.push(body);
        if (body.conflict === undefined) {
          return HttpResponse.json(
            { error: { code: 'SKILLS_SYNC_CONFLICT', message: '目标已存在同名技能', details: { conflicts: [{ target_id: 'qoder', skill: 'using-agentboard', reason: '内容不一致' }] } } },
            { status: 409 },
          );
        }
        return HttpResponse.json({
          results: [{ target_id: 'qoder', path: 'C:\\Users\\x\\.qoder\\skills', action: 'copied', backup_dir: 'C:\\Users\\x\\.qoder\\skills\\.agentboard-backup-1', skills: [{ name: 'handoff', files: 13, bytes: 100, status: 'backup_overwritten' }], errors: [] }],
          summary: { targets: 1, copied: 1, skipped: 0, errors: 0, total_files: 13 },
        });
      }),
    );
    renderSection();
    await userEvent.click(await screen.findByTestId('skills-sync-check-qoder'));
    await userEvent.click(screen.getByTestId('skills-sync-copy'));
    const conflict = await screen.findByTestId('skills-sync-conflict');
    expect(conflict).toHaveTextContent('using-agentboard');
    await userEvent.click(screen.getByTestId('skills-sync-conflict-backup'));
    await waitFor(() => expect(screen.queryByTestId('skills-sync-conflict')).toBeNull());
    expect(bodies).toEqual([
      { target_ids: ['qoder'], workspace_id: 'ws-1' },
      { target_ids: ['qoder'], conflict: 'backup', workspace_id: 'ws-1' },
    ]);
    expect(screen.getByTestId('skills-sync-result-qoder')).toHaveTextContent('备份');
  });

  it('移除：调用 DELETE 并清空结果区', async () => {
    const deletes: string[] = [];
    server.use(
      http.delete('/api/settings/skills-sync/:targetId', ({ params }) => {
        deletes.push(String(params.targetId));
        return HttpResponse.json({ target_id: 'agents', path: 'C:\\Users\\x\\.agents\\skills', removed: ['handoff'], errors: [], also_cleared: ['cursor'], state_cleared: true });
      }),
    );
    renderSection();
    await userEvent.click(await screen.findByTestId('skills-sync-remove-agents'));
    await waitFor(() => expect(deletes).toEqual(['agents']));
    expect(screen.queryByTestId('skills-sync-error')).toBeNull();
  });
});
