/**
 * P3-B：专家组视图（左侧栏下半部分入口，位于「账号管理」与「设置」之间）。
 *
 * 只读呈现服务端 P3-A 的团队快照：成员名册 + 累计用量（轮次 / tokens / 工具调用）+
 * 成本护栏进度（tokens / budget、轮次 / 上限）；点成员展开其会话的只读消息列表。
 * 写操作只有「新建专家组 / 添加成员 / 停止团队」三个入口，其余编排（派活、回传）由 lead 在聊天里完成。
 * 数据不伪造：全部来自 GET /api/teams?workspace=，WS `team_update` 到达后由 query 前缀失效刷新。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CliInfo, Session, TeamDetail, TeamMemberDetail } from '@agentboard/shared';
import { api } from '../../api/client';
import {
  useAddTeamMember,
  useCreateTeam,
  useMemberMessages,
  useStopTeam,
  useTeams,
} from '../../api/teams';
import { useAppStore } from '../../state/appStore';
import { MessageList } from '../chat/MessageList';
import type { PersonaSummary } from '../chat/SessionSettingsDialog';

const inputCls =
  'w-full rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-accent dark:border-neutral-700 dark:bg-neutral-800';

const STATUS_LABEL: Record<TeamMemberDetail['status'], string> = {
  idle: '空闲',
  working: '进行中',
  done: '已交付',
  failed: '失败',
};

const STATUS_CLS: Record<TeamMemberDetail['status'], string> = {
  idle: 'bg-surface-raised text-ink-3',
  working: 'bg-accent-soft text-accent',
  done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

export function ExpertsView() {
  const workspaceId = useAppStore((s) => s.workspaceId);
  if (workspaceId === null) {
    return (
      <div data-testid="experts-view" className="p-6 text-sm text-ink-3">
        请先在左上角选择工作区，再查看专家组。
      </div>
    );
  }
  return <ExpertsBody workspaceId={workspaceId} />;
}

function ExpertsBody({ workspaceId }: { workspaceId: string }) {
  const { data: teams, isPending, isError, error, refetch } = useTeams(workspaceId);
  const [creating, setCreating] = useState(false);

  return (
    <div data-testid="experts-view" className="mx-auto w-full max-w-5xl px-6 py-6">
      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-ink">专家组</h1>
          <p className="mt-1 text-xs text-ink-3">
            由 lead 统筹，成员各自独立会话；成员结果回传 lead，轮次与 token 用量受成本护栏约束。
          </p>
        </div>
        <button
          type="button"
          data-testid="experts-create-toggle"
          className="shrink-0 rounded border border-hairline px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-raised"
          onClick={() => setCreating((value) => !value)}
        >
          {creating ? '取消' : '新建专家组'}
        </button>
      </header>

      {creating && <CreateTeamForm workspaceId={workspaceId} onDone={() => setCreating(false)} />}

      {isPending ? (
        <div className="py-10 text-sm text-ink-3">加载中…</div>
      ) : isError ? (
        <div className="rounded-lg border border-hairline bg-surface-card p-4 text-sm text-ink-2" data-testid="experts-error">
          <p>加载专家组失败：{error instanceof Error ? error.message : '未知错误'}</p>
          <button type="button" className="mt-2 text-accent hover:underline" onClick={() => void refetch()}>
            重试
          </button>
        </div>
      ) : teams !== undefined && teams.length === 0 ? (
        <div className="rounded-lg border border-dashed border-hairline bg-surface-card p-8 text-center" data-testid="experts-empty">
          <p className="text-sm text-ink-2">还没有专家组。</p>
          <p className="mt-1 text-xs text-ink-3">
            用「新建专家组」指定一个已有会话作为 lead，再添加成员即可；lead 在聊天里用 <code>@成员名: 任务</code> 派活。
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {teams?.map((team) => (
            <TeamCard key={team.id} team={team} workspaceId={workspaceId} />
          ))}
        </div>
      )}
    </div>
  );
}

function CreateTeamForm({ workspaceId, onDone }: { workspaceId: string; onDone: () => void }) {
  const [name, setName] = useState('');
  const [leadSessionId, setLeadSessionId] = useState('');
  const { data: sessions } = useQuery({
    queryKey: ['sessions', workspaceId],
    queryFn: () => api.get<Session[]>(`/api/sessions?workspace=${encodeURIComponent(workspaceId)}`),
  });
  const create = useCreateTeam(workspaceId);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (name.trim() === '' || leadSessionId === '') return;
    create.mutate(
      { name: name.trim(), lead_session_id: leadSessionId },
      {
        onSuccess: () => {
          setName('');
          setLeadSessionId('');
          onDone();
        },
      },
    );
  };

  return (
    <form
      onSubmit={submit}
      data-testid="experts-create-form"
      className="mb-4 space-y-3 rounded-lg border border-hairline bg-surface-card p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-ink-3">
          团队名称
          <input
            className={`${inputCls} mt-1`}
            value={name}
            maxLength={50}
            placeholder="例如：通用专家组"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="block text-xs text-ink-3">
          lead 会话
          <select
            className={`${inputCls} mt-1`}
            value={leadSessionId}
            onChange={(event) => setLeadSessionId(event.target.value)}
          >
            <option value="">选择会话…</option>
            {(sessions ?? []).map((session) => (
              <option key={session.id} value={session.id}>
                {`${session.cli}${session.model === null ? '' : ` / ${session.model}`} · ${session.issue_id === null ? '自由会话' : '任务会话'} · ${session.id.slice(0, 8)}`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={create.isPending || name.trim() === '' || leadSessionId === ''}
          className="rounded bg-accent px-3 py-1.5 text-sm text-accent-ink disabled:opacity-50"
        >
          {create.isPending ? '创建中…' : '创建'}
        </button>
        {create.isError && (
          <span className="text-xs text-red-700 dark:text-red-300">
            {create.error instanceof Error ? create.error.message : '创建失败'}
          </span>
        )}
        <span className="text-xs text-ink-3">成本护栏默认每成员 20 轮、全团 200000 tokens。</span>
      </div>
    </form>
  );
}

function TeamCard({ team, workspaceId }: { team: TeamDetail; workspaceId: string }) {
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const stop = useStopTeam(team.id, workspaceId);
  const tokens = team.members.reduce((sum, member) => sum + member.usage.tokens, 0);
  const budgetPercent = Math.min(100, Math.round((tokens / team.budget_tokens) * 100));

  return (
    <section data-testid="experts-team-card" className="rounded-lg border border-hairline bg-surface-card">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-ink">{team.name}</h2>
            <span
              className={`rounded px-1.5 py-0.5 text-[11px] ${team.status === 'active' ? 'bg-accent-soft text-accent' : 'bg-surface-raised text-ink-3'}`}
              data-testid="experts-team-status"
            >
              {team.status === 'active' ? '进行中' : '已停止'}
            </span>
          </div>
          <p className="mt-1 text-xs text-ink-3">
            lead 会话 {team.lead_session_id.slice(0, 8)} · 每成员上限 {team.max_turns_per_member} 轮 · 成员 {team.members.length}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {team.status === 'active' && (
            <>
              <button
                type="button"
                data-testid="experts-add-member-toggle"
                className="rounded border border-hairline px-2.5 py-1 text-xs text-ink-2 hover:bg-surface-raised"
                onClick={() => setAdding((value) => !value)}
              >
                {adding ? '取消' : '添加成员'}
              </button>
              <button
                type="button"
                data-testid="experts-stop-team"
                disabled={stop.isPending}
                className="rounded border border-hairline px-2.5 py-1 text-xs text-ink-2 hover:bg-surface-raised disabled:opacity-50"
                onClick={() => {
                  if (window.confirm(`停止专家组「${team.name}」？成员将统一停轮，之后不能再派活。`)) {
                    stop.mutate();
                  }
                }}
              >
                停止团队
              </button>
            </>
          )}
        </div>
      </header>

      <div className="px-4 py-3">
        <div className="mb-1 flex items-center justify-between text-xs text-ink-3">
          <span>token 用量</span>
          <span>
            {tokens.toLocaleString()} / {team.budget_tokens.toLocaleString()}（{budgetPercent}%）
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded bg-surface-raised" role="progressbar" aria-valuenow={budgetPercent} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full rounded ${budgetPercent >= 100 ? 'bg-red-500' : 'bg-accent'}`} style={{ width: `${budgetPercent}%` }} />
        </div>
      </div>

      {adding && <AddMemberForm teamId={team.id} workspaceId={workspaceId} onDone={() => setAdding(false)} />}

      {stop.isError && (
        <p className="px-4 pb-2 text-xs text-red-700 dark:text-red-300">
          停止失败：{stop.error instanceof Error ? stop.error.message : '未知错误'}
        </p>
      )}

      {team.members.length === 0 ? (
        <p className="px-4 pb-4 text-xs text-ink-3" data-testid="experts-team-empty">
          暂无成员。添加成员后，lead 在聊天里写 <code>@成员名: 任务</code> 即可派活。
        </p>
      ) : (
        <ul className="divide-y divide-hairline border-t border-hairline">
          {team.members.map((member) => (
            <MemberRow
              key={member.session_id}
              member={member}
              expanded={expanded === member.session_id}
              onToggle={() => setExpanded((current) => (current === member.session_id ? null : member.session_id))}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function MemberRow({ member, expanded, onToggle }: { member: TeamMemberDetail; expanded: boolean; onToggle: () => void }) {
  const { data: messages, isPending, isError } = useMemberMessages(member.session_id, expanded);
  return (
    <li data-testid="experts-member-row">
      <button
        type="button"
        aria-expanded={expanded}
        className="grid w-full grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_72px_64px_80px_80px] items-center gap-2 px-4 py-2.5 text-left text-xs hover:bg-surface-raised"
        onClick={onToggle}
      >
        <span className="truncate text-sm text-ink">{member.agent_name}</span>
        <span className="truncate text-ink-3">{member.role}</span>
        <span>
          <span className={`rounded px-1.5 py-0.5 text-[11px] ${STATUS_CLS[member.status]}`} data-testid="experts-member-status">
            {STATUS_LABEL[member.status]}
          </span>
        </span>
        <span className="text-ink-3">{member.usage.turns} 轮</span>
        <span className="text-ink-3">{member.usage.tokens.toLocaleString()} tok</span>
        <span className="text-ink-3">{member.usage.tool_calls} 工具</span>
      </button>
      {expanded && (
        <div className="border-t border-hairline bg-surface-page px-4 py-3" data-testid="experts-member-messages">
          <p className="mb-2 text-[11px] text-ink-3">
            成员会话 {member.session_id.slice(0, 8)}（只读）
            {member.session === null ? ' · 会话已删除' : ` · ${member.session.cli}${member.session.model === null ? '' : ` / ${member.session.model}`}`}
          </p>
          {member.session === null ? (
            <p className="text-xs text-ink-3">该成员的会话记录不可用。</p>
          ) : isPending ? (
            <p className="text-xs text-ink-3">加载消息…</p>
          ) : isError ? (
            <p className="text-xs text-red-700 dark:text-red-300">消息加载失败。</p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <MessageList sessionId={member.session_id} messages={messages ?? []} streaming="" running={false} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function AddMemberForm({ teamId, workspaceId, onDone }: { teamId: string; workspaceId: string; onDone: () => void }) {
  const [agentName, setAgentName] = useState('');
  const [role, setRole] = useState('');
  const [cliId, setCliId] = useState('');
  const [personaId, setPersonaId] = useState('');
  const add = useAddTeamMember(teamId, workspaceId);
  const { data: clis } = useQuery({ queryKey: ['clis'], queryFn: () => api.get<CliInfo[]>('/api/clis') });
  const { data: personas } = useQuery({ queryKey: ['personas'], queryFn: () => api.get<PersonaSummary[]>('/api/personas'), staleTime: 30_000 });
  const installed = (clis ?? []).filter((cli) => cli.installed);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const cli = cliId !== '' ? cliId : (installed[0]?.id ?? '');
    if (agentName.trim() === '' || role.trim() === '' || cli === '') return;
    add.mutate(
      {
        agent_name: agentName.trim(),
        role: role.trim(),
        cli,
        ...(personaId === '' ? {} : { persona_id: personaId }),
      },
      {
        onSuccess: () => {
          setAgentName('');
          setRole('');
          setPersonaId('');
          onDone();
        },
      },
    );
  };

  return (
    <form onSubmit={submit} data-testid="experts-add-member-form" className="grid gap-2 border-t border-hairline px-4 py-3 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
      <input className={inputCls} placeholder="成员名（用于 @派活）" value={agentName} maxLength={30} onChange={(e) => setAgentName(e.target.value)} />
      <input className={inputCls} placeholder="角色（如：架构）" value={role} maxLength={30} onChange={(e) => setRole(e.target.value)} />
      <select className={inputCls} value={cliId} onChange={(e) => setCliId(e.target.value)}>
        <option value="">默认 CLI（第一个已安装）</option>
        {installed.map((cli) => (
          <option key={cli.id} value={cli.id}>{cli.id}</option>
        ))}
      </select>
      <select className={inputCls} value={personaId} onChange={(e) => setPersonaId(e.target.value)}>
        <option value="">不使用人设</option>
        {(personas ?? []).map((persona) => (
          <option key={persona.id} value={persona.id}>{persona.name}</option>
        ))}
      </select>
      <button
        type="submit"
        disabled={add.isPending || agentName.trim() === '' || role.trim() === ''}
        className="rounded bg-accent px-3 py-1.5 text-sm text-accent-ink disabled:opacity-50"
      >
        {add.isPending ? '添加中…' : '添加'}
      </button>
      {add.isError && (
        <p className="text-xs text-red-700 sm:col-span-5 dark:text-red-300">
          {add.error instanceof Error ? add.error.message : '添加失败'}
        </p>
      )}
    </form>
  );
}
