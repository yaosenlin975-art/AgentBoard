/**
 * 长按语音输入（VOICE-3）：**唯一实现点**。
 *
 * 不做「逐个输入框包一层」——全站 40+ 个 input/textarea/contenteditable 逐个包装会重复实现手势、
 * 也容易漏。这里在 document 上以 capture 阶段做委托：pointerdown 命中可接入的文本控件时启动手势，
 * 400ms 未拖动才 getUserMedia；松手/Escape 结束并把 final 文本插到光标处。
 *
 * 接入范围、阈值、错误文案见 lib/voice/contract.ts 与设计文档 §长按手势 / §错误态。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  LONG_PRESS_MS,
  VOICE_ERROR_TEXT,
  isVoiceEligible,
  resolveLanguage,
  type VoiceErrorCode,
  type VoiceSettings,
} from '../../lib/voice/contract';
import { IDLE_GESTURE, gestureDown, gestureEnd, gestureMove, gestureTick, type GestureState } from '../../lib/voice/gesture';
import { VoiceHint, VoiceMicWave } from './VoiceFeedback';
import { insertVoiceText } from '../../lib/voice/insertText';
import { startVoiceSession, VoiceInputError, type VoiceSessionHandle } from '../../lib/voice/recorder';
import { loadVoiceSettings, saveVoiceSettings } from '../../lib/voice/settings';

type Status = 'idle' | 'listening';

/** 语音设置（VOICE-4 的设置页也用这个 hook，保证同一份持久化） */
export function useVoiceSettings(): {
  settings: VoiceSettings;
  update: (patch: Partial<VoiceSettings>) => void;
} {
  const [settings, setSettings] = useState<VoiceSettings>(() => loadVoiceSettings());
  const update = useCallback((patch: Partial<VoiceSettings>) => {
    setSettings((current: VoiceSettings) => {
      const next: VoiceSettings = { ...current, ...patch };
      saveVoiceSettings(next);
      return next;
    });
  }, []);
  return { settings, update };
}

export interface VoiceDebug {
  getUserMediaCalls: number;
  lastText: string | null;
  lastError: VoiceErrorCode | string | null;
  lastCaret: number | null;
}

/** 供 CDP/测试读取的运行计数（挂 window 上，便于真机取证） */
function noteDebug(patch: Partial<VoiceDebug>): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { __voiceDebug?: VoiceDebug };
  w.__voiceDebug = {
    getUserMediaCalls: w.__voiceDebug?.getUserMediaCalls ?? 0,
    lastText: w.__voiceDebug?.lastText ?? null,
    lastError: w.__voiceDebug?.lastError ?? null,
    lastCaret: w.__voiceDebug?.lastCaret ?? null,
    ...patch,
  };
}

/**
 * VOICE-UI-2：可铺开到文本控件上的 props 工厂。
 *
 * 默认路径是 `VoiceInputProvider` 在 document 上做 capture 委托（`input[type=text|search]`、
 * `textarea`、`contenteditable` 全自动生效，聊天输入框 / 新建任务标题描述 / 知识库搜索 /
 * 详情评论框都在其中）。工厂用于两类场景：
 * 1. 需要**显式声明**「这个控件支持长按语音」的组件（可读性/测试锚点）；
 * 2. 将来出现委托覆盖不到的控件（例如 shadow DOM / 富文本编辑器）。
 *
 * 只做「标记 + 阻止长按期间弹右键菜单」，不抢点击/聚焦/拖选/IME：
 * - 不调 `preventDefault`（否则会破坏聚焦与文本拖选）；
 * - 仅在已进入 recording/pending 阶段时对 `contextmenu` 做一次 `preventDefault`。
 */
export interface VoiceLongPressProps {
  'data-voice-input': 'true';
  onContextMenu: (event: React.MouseEvent) => void;
}

export function voiceLongPressProps(): VoiceLongPressProps {
  return {
    'data-voice-input': 'true',
    onContextMenu: (event: React.MouseEvent) => {
      // 长按录音期间浏览器会弹右键菜单：只在这种状态下拦一次，正常右键不受影响
      const debug = (window as unknown as { __voiceDebug?: VoiceDebug }).__voiceDebug;
      if (debug?.lastText !== undefined && (debug.lastError === null || debug.lastError === undefined)) return;
      event.preventDefault();
    },
  };
}
export function VoiceInputProvider({ children }: { children?: React.ReactNode }) {
  const { settings } = useVoiceSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const gestureRef = useRef<GestureState>(IDLE_GESTURE);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const sessionRef = useRef<VoiceSessionHandle | null>(null);
  /** 松手早于会话就绪：就绪后立刻收尾并插入，避免丢结果/漏停 */
  const stopRequestedRef = useRef(false);
  /** VOICE-CANCEL：会话就绪前就点了取消 → 拿到会话后直接停掉，不进入 listening */
  const cancelRequestedRef = useRef(false);
  const [status, setStatus] = useState<Status>('idle');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // VOICE-UI-3：音波用 rAF 逐帧读最新电平（不依赖每次 setState 的节奏）
  const levelRef = useRef(0);
  levelRef.current = level;
  const readLevel = useCallback(() => levelRef.current, []);
  /** STT 开启且已选到模型才给聚焦提示（关闭/无模型 → 不显示） */
  const hintEnabled = settings.enabled && settings.modelId !== null;

  const clearTimer = (): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const finish = useCallback(async (): Promise<void> => {
    clearTimer();
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session === null) {
      // 会话还在起（getUserMedia/Worklet 未就绪）就松手了：标记，等 begin 完成后立即收尾
      stopRequestedRef.current = gestureRef.current.phase === 'recording' || stopRequestedRef.current;
      return;
    }
    setStatus('idle');
    setLevel(0);
    if (session === null) return;
    try {
      const text = await session.stop();
      const el = targetRef.current;
      if (el !== null && el.isConnected && text.trim() !== '') {
        const result = insertVoiceText(el, text);
        noteDebug({ lastText: text, lastCaret: result.caret, lastError: null });
      }
    } catch (e) {
      const code: VoiceErrorCode | string = e instanceof VoiceInputError ? e.code : 'VOICE_UNSUPPORTED';
      noteDebug({ lastError: code });
      setError(VOICE_ERROR_TEXT[code as VoiceErrorCode] ?? String(e));
    }
  }, []);

  /**
   * VOICE-CANCEL：放弃本次录音（误触发 / 点关闭 / Esc）。
   * 停会话并丢弃识别结果，不插入任何文本；同时释放麦克风与电平定时器。
   */
  const cancel = useCallback(async (): Promise<void> => {
    clearTimer();
    stopRequestedRef.current = false;
    const session = sessionRef.current;
    sessionRef.current = null;
    // 只有「会话还没起来」时才需要留标记，让 begin 拿到会话后自行停掉；已有会话则直接停
    cancelRequestedRef.current = session === null;
    gestureRef.current = IDLE_GESTURE;
    const withTick = session as unknown as { __tick?: ReturnType<typeof setInterval> } | null;
    if (withTick?.__tick !== undefined) clearInterval(withTick.__tick);
    setStatus('idle');
    setLevel(0);
    if (session !== null) {
      try {
        // stop() 会停止采集并关闭 AudioWorklet/MediaStream；返回值按取消处理丢弃
        await session.stop();
      } catch {
        // 取消路径不弹错误：目标就是安静退出
      }
    }
  }, []);

  const begin = useCallback(async (): Promise<void> => {
    const el = targetRef.current;
    if (el === null) return;
    const current = settingsRef.current;
    try {
      const session = await startVoiceSession({
        language: resolveLanguage(current),
        modelId: current.modelId,
        // mock：设置里开启，或用 URL 参数 ?voiceMock=1（便于真机验证手势/插入链路而不下载模型）
        mock: current.mock || new URLSearchParams(location.search).get('voiceMock') === '1',
        mediaDevices: navigator.mediaDevices,
      });
      sessionRef.current = session;
      // VOICE-CANCEL：会话起来前已点关闭 / Esc → 直接停掉，不进入 listening，也不插入文本
      if (cancelRequestedRef.current) {
        cancelRequestedRef.current = false;
        sessionRef.current = null;
        try {
          await session.stop();
        } catch {
          // 取消路径静默
        }
        return;
      }
      if (stopRequestedRef.current) {
        stopRequestedRef.current = false;
        noteDebug({ getUserMediaCalls: ((window as unknown as { __voiceDebug?: VoiceDebug }).__voiceDebug?.getUserMediaCalls ?? 0) + 1 });
        void finish();
        return;
      }
      noteDebug({ getUserMediaCalls: ((window as unknown as { __voiceDebug?: VoiceDebug }).__voiceDebug?.getUserMediaCalls ?? 0) + 1 });
      setStatus('listening');
      const tick = setInterval(() => setLevel(session.level()), 80);
      timerRef.current = null;
      (session as unknown as { __tick?: ReturnType<typeof setInterval> }).__tick = tick;
    } catch (e) {
      const code = e instanceof VoiceInputError ? e.code : 'VOICE_UNSUPPORTED';
      noteDebug({ lastError: code });
      setError(VOICE_ERROR_TEXT[code as VoiceErrorCode] ?? String(e));
      setStatus('idle');
    }
  }, []);

  useEffect(() => {
    const stopLevelTimer = (): void => {
      const session = sessionRef.current as unknown as { __tick?: ReturnType<typeof setInterval> } | null;
      if (session?.__tick !== undefined) clearInterval(session.__tick);
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (!settingsRef.current.enabled) return; // 开关关闭：完全不介入
      if (event.button !== 0) return;
      const el = event.target instanceof Element ? event.target.closest('input, textarea, [contenteditable="true"], [contenteditable=""]') : null;
      if (!isVoiceEligible(el)) return;
      targetRef.current = el;
      stopRequestedRef.current = false;
      cancelRequestedRef.current = false;
      gestureRef.current = gestureDown(event.clientX, event.clientY, performance.now());
      clearTimer();
      timerRef.current = setTimeout(() => {
        const transition = gestureTick(gestureRef.current, performance.now());
        gestureRef.current = transition.state;
        if (transition.startRecording) void begin();
      }, LONG_PRESS_MS);
    };

    const onPointerMove = (event: PointerEvent): void => {
      const transition = gestureMove(gestureRef.current, event.clientX, event.clientY);
      if (transition.state.phase === 'idle' && gestureRef.current.phase === 'pending') clearTimer();
      gestureRef.current = transition.state;
    };

    const onPointerUp = (): void => {
      const wasRecording = gestureRef.current.phase === 'recording';
      const transition = gestureEnd(gestureRef.current);
      gestureRef.current = transition.state;
      clearTimer();
      if (transition.stopRecording || wasRecording) {
        stopLevelTimer();
        void finish();
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (gestureRef.current.phase === 'idle' && sessionRef.current === null) return;
      // VOICE-CANCEL：Esc 是「放弃本次录音」，不是「说完了」——停会话且不插入任何文本
      stopLevelTimer();
      void cancel();
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerUp, true);
    // VOICE-UI-2：指针移出可拖动范围也要取消（否则「拖出去再松手」会残留 pending 计时）
    const onPointerLeave = (event: PointerEvent): void => {
      if (gestureRef.current.phase === 'idle') return;
      const related = event.relatedTarget;
      if (related instanceof Node && related.nodeType === Node.TEXT_NODE) return;
      const wasRecording = gestureRef.current.phase === 'recording';
      gestureRef.current = IDLE_GESTURE;
      clearTimer();
      if (wasRecording) {
        // VOICE-CANCEL：指针移出输入框即视为放弃本次录音（误触发的常见形态），不插入文本
        stopLevelTimer();
        void cancel();
      }
    };
    document.addEventListener('pointerleave', onPointerLeave, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', onPointerUp, true);
      document.removeEventListener('pointerleave', onPointerLeave, true);
      document.removeEventListener('keydown', onKeyDown, true);
      clearTimer();
      stopLevelTimer();
    };
  }, [begin, cancel, finish]);

  // 错误提示 3.5s 自动收起
  useEffect(() => {
    if (error === null) return;
    const timer = setTimeout(() => setError(null), 3500);
    return () => clearTimeout(timer);
  }, [error]);

  const overlay = (
    <>
      {status === 'listening' && (
        <div
          data-testid="voice-listening"
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-lg border border-hairline bg-surface-card px-3 py-2 text-xs text-ink shadow-lg"
        >
          <span className="font-medium">正在听…</span>
          <VoiceMicWave active={status === 'listening'} getLevel={readLevel} />
          <span data-testid="voice-level" className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-raised">
            <span className="block h-full rounded-full bg-accent transition-[width] duration-100" style={{ width: `${Math.round(level * 100)}%` }} />
          </span>
          <span className="text-ink-3">松手结束</span>
          {/* VOICE-CANCEL：误触发/想放弃时点这里立刻退出；Esc 同样生效 */}
          <button
            type="button"
            data-testid="voice-cancel"
            aria-label="取消录音"
            title="取消录音（Esc）"
            onClick={() => void cancel()}
            className="ml-1 flex h-5 w-5 items-center justify-center rounded text-ink-3 hover:bg-surface-raised hover:text-ink"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}
      {/* VOICE-UI-3：聚焦提示（STT 开启且模型可用时） */}
      <VoiceHint enabled={hintEnabled} />
      {error !== null && (
        <div
          data-testid="voice-error"
          role="alert"
          className="fixed bottom-6 left-1/2 z-[60] max-w-md -translate-x-1/2 rounded-lg border border-hairline bg-surface-card px-3 py-2 text-xs text-ink shadow-lg"
        >
          {error}
        </div>
      )}
    </>
  );

  return (
    <>
      {children}
      {typeof document === 'undefined' ? null : createPortal(overlay, document.body)}
    </>
  );
}
