import { useCallback, useSyncExternalStore } from 'react';
import {
  getAgentChatCaptureTarget,
  subscribeAgentChat,
  type AgentChatCaptureTarget,
} from '../lib/agentChatStore';

interface CaptureState {
  target: AgentChatCaptureTarget | null;
}

const captureStateCache = new Map<string, { signature: string; state: CaptureState }>();

function getCaptureState(projectPath: string): CaptureState {
  const target = getAgentChatCaptureTarget(projectPath);
  const state = { target };
  const signature = target
    ? JSON.stringify([
        target.kind,
        target.projectPath,
        target.checkoutPath,
        target.kind === 'thread' ? target.threadId : target.draftId,
      ])
    : 'none';
  const cached = captureStateCache.get(projectPath);
  if (cached?.signature === signature) return cached.state;
  captureStateCache.set(projectPath, { signature, state });
  return state;
}

/** Subscribe to the active draft/thread target without rerendering for transcript streams. */
export function useAgentChatCaptureState(projectPath: string) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeAgentChat(projectPath, listener),
    [projectPath]
  );
  const getSnapshot = useCallback(() => getCaptureState(projectPath), [projectPath]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
