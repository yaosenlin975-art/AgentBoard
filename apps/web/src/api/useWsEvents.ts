import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { connectWs } from './ws';
import { emitWsEvent } from './wsBus';
import { useAppStore } from '../state/appStore';

/** App 生命周期内建立 WS 连接：react-query invalidation + 灌入进程内事件总线（聊天流式消费） */
export function useWsEvents(): void {
  const queryClient = useQueryClient();
  const setWsStatus = useAppStore((s) => s.setWsStatus);

  useEffect(() => {
    return connectWs({ queryClient, onEvent: emitWsEvent, onStatus: setWsStatus });
  }, [queryClient, setWsStatus]);
}
