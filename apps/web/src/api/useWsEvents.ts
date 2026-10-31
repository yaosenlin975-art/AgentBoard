import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { connectWs } from './ws';
import { useAppStore } from '../state/appStore';

/** App 生命周期内建立 WS 连接并做 react-query invalidation */
export function useWsEvents(): void {
  const queryClient = useQueryClient();
  const setWsStatus = useAppStore((s) => s.setWsStatus);

  useEffect(() => {
    return connectWs({ queryClient, onStatus: setWsStatus });
  }, [queryClient, setWsStatus]);
}
