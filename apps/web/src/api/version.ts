/**
 * 版本展示数据源（顶栏 VersionLabel 与设置弹窗共用）：
 * 服务端版本取 GET /api/version；前端版本取本包 package.json（构建期内联，仅打包 version 字段）。
 */
import { useQuery } from '@tanstack/react-query';
import { version as webVersion } from '../../package.json';
import { api } from './client';

export interface ServerVersion {
  name: string;
  version: string;
}

/** 前端构建版本（apps/web/package.json） */
export const WEB_VERSION: string = webVersion;

/** 服务端版本：进程生命周期内不变，长缓存；失败/加载中 data 为 undefined，由调用方显示占位 */
export function useServerVersion() {
  return useQuery({
    queryKey: ['version'],
    queryFn: () => api.get<ServerVersion>('/api/version'),
    staleTime: Infinity,
  });
}
