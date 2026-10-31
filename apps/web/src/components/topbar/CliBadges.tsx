import { useQuery } from '@tanstack/react-query';
import { AGENT_IDS, type CliInfo } from '@agentboard/shared';
import { api } from '../../api/client';
import { Badge } from '../ui/Badge';

/** 四家 CLI 徽标：已装绿点（悬停显示版本号），未装灰 */
export function CliBadges() {
  const { data } = useQuery({
    queryKey: ['clis'],
    queryFn: () => api.get<CliInfo[]>('/api/clis'),
  });
  const byId = new Map((data ?? []).map((c) => [c.id, c]));

  return (
    <div className="flex items-center gap-1.5" aria-label="CLI 状态">
      {AGENT_IDS.map((id) => {
        const cli = byId.get(id);
        const installed = cli?.installed === true;
        const label = cli?.displayName ?? id;
        const title = installed ? `${label} ${cli?.version ?? ''}`.trim() : `${label} 未安装`;
        return (
          <Badge key={id} tone={installed ? 'green' : 'gray'} title={title}>
            <span
              data-installed={installed}
              aria-hidden="true"
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                installed ? 'bg-green-500' : 'bg-neutral-400 dark:bg-neutral-600'
              }`}
            />
            <span>{label}</span>
          </Badge>
        );
      })}
    </div>
  );
}
