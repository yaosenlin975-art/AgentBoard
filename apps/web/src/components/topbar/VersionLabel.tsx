import { useServerVersion, WEB_VERSION } from '../../api/version';

/** 顶栏标题旁版本号：服务端版本（GET /api/version），不可达/加载中显示 v?；与前端版本不一致时 title 警示 */
export function VersionLabel() {
  const { data } = useServerVersion();
  const version = data?.version;
  let title = `服务端版本未知（不可达或加载中） · 前端 ${WEB_VERSION}`;
  if (version !== undefined) {
    title = `${data?.name ?? '服务端'} ${version} · 前端 ${WEB_VERSION}`;
    if (version !== WEB_VERSION) title += '\n警告：前后端版本不一致，请刷新页面；仍不一致则重新构建前端或重启服务';
  }

  return (
    <span data-testid="app-version" title={title} className="shrink-0 text-xs text-neutral-400 dark:text-neutral-500">
      {version === undefined ? 'v?' : `v${version}`}
    </span>
  );
}
