/**
 * P3-B：专家团 API 客户端与 hooks。
 *
 * 服务端端点见 `Docs/api.md` §22（P3-A 落地）。WS `team_update` 的失效规则在 `api/ws.ts`：
 * 前缀 `['teams']` 覆盖全部工作区的团列表，`['team', id]` 精确失效单团详情。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Message, TeamDetail } from '@agentboard/shared';
import { api } from './client';

export const teamsKey = (workspaceId: string) => ['teams', workspaceId] as const;
export const teamKey = (teamId: string) => ['team', teamId] as const;

export interface CreateTeamInput {
  name: string;
  lead_session_id: string;
  max_turns_per_member?: number;
  budget_tokens?: number;
}

export interface AddTeamMemberInput {
  cli: string;
  role: string;
  agent_name: string;
  persona_id?: string;
  model?: string;
}

/** 按工作区列团（含成员快照）；workspaceId 为 null 时不发请求 */
export function useTeams(workspaceId: string | null) {
  return useQuery({
    queryKey: teamsKey(workspaceId ?? ''),
    queryFn: () => api.get<TeamDetail[]>(`/api/teams?workspace=${encodeURIComponent(workspaceId ?? '')}`),
    enabled: workspaceId !== null,
    staleTime: 15_000,
  });
}

export function useCreateTeam(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTeamInput) => api.post<TeamDetail>('/api/teams', { ...input, workspace_id: workspaceId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: teamsKey(workspaceId) });
    },
  });
}

export function useAddTeamMember(teamId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AddTeamMemberInput) => api.post<TeamDetail>(`/api/teams/${teamId}/members`, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: teamsKey(workspaceId) });
      await queryClient.invalidateQueries({ queryKey: teamKey(teamId) });
    },
  });
}

export function useStopTeam(teamId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<TeamDetail>(`/api/teams/${teamId}/stop`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: teamsKey(workspaceId) });
      await queryClient.invalidateQueries({ queryKey: teamKey(teamId) });
    },
  });
}

/** 成员会话消息（只读展开用；staleTime 短，WS team_update 不进这里，靠切展开重取） */
export function useMemberMessages(sessionId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['member-messages', sessionId ?? ''],
    queryFn: () => api.get<Message[]>(`/api/sessions/${sessionId ?? ''}/messages`),
    enabled: enabled && sessionId !== null,
    staleTime: 5_000,
  });
}
