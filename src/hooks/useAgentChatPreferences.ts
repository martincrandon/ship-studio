import { useCallback, useEffect, useState } from 'react';
import {
  AGENT_CHAT_VIEW_PREFERENCE_CHANGED_EVENT,
  getDefaultAgentChatView,
  getPreferredAgentWorkspaceView,
  getProjectAgentChatViewOverride,
  setActiveAgentWorkspaceView,
  clearActiveAgentWorkspaceView,
  isProjectAgentChatViewPreferenceKey,
  setDefaultAgentChatView,
  setProjectAgentChatViewOverride,
  type AgentChatViewPreferenceChange,
  type AgentWorkspaceView,
} from '../lib/agentChatPreferences';

/** React view of the app default and optional per-project Agent panel choice. */
export function useAgentChatPreferences(projectPath: string | null = null) {
  const [, setRevision] = useState(0);
  const [activeView, setActiveView] = useState(() => ({
    projectPath,
    view: getPreferredAgentWorkspaceView(projectPath),
  }));
  const preferredView = getPreferredAgentWorkspaceView(projectPath);
  if (activeView.projectPath !== projectPath) {
    setActiveView({ projectPath, view: preferredView });
  }

  const refresh = useCallback(() => setRevision((revision) => revision + 1), []);
  useEffect(() => {
    const onPreferenceChange = (event: Event) => {
      const detail = (event as CustomEvent<AgentChatViewPreferenceChange>).detail;
      if (detail.projectPath === null || detail.projectPath === projectPath) refresh();
      if (detail.projectPath !== null && detail.projectPath === projectPath) {
        const nextView = getPreferredAgentWorkspaceView(projectPath);
        setActiveAgentWorkspaceView(projectPath, nextView);
        setActiveView({ projectPath, view: nextView });
      }
    };
    const onStorage = (event: StorageEvent) => {
      const isProjectChange =
        projectPath !== null && isProjectAgentChatViewPreferenceKey(event.key, projectPath);
      if (event.key === 'shipstudio.agentChat.defaultView' || isProjectChange) {
        refresh();
        if (projectPath && isProjectChange) {
          const nextView = getPreferredAgentWorkspaceView(projectPath);
          setActiveAgentWorkspaceView(projectPath, nextView);
          setActiveView({ projectPath, view: nextView });
        }
      }
    };

    window.addEventListener(AGENT_CHAT_VIEW_PREFERENCE_CHANGED_EVENT, onPreferenceChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(AGENT_CHAT_VIEW_PREFERENCE_CHANGED_EVENT, onPreferenceChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [projectPath, refresh]);

  useEffect(() => {
    if (projectPath) {
      setActiveAgentWorkspaceView(projectPath, getPreferredAgentWorkspaceView(projectPath));
    }
    return () => {
      if (projectPath) clearActiveAgentWorkspaceView(projectPath);
    };
  }, [projectPath]);

  const defaultView = getDefaultAgentChatView();
  const projectView = projectPath ? getProjectAgentChatViewOverride(projectPath) : null;
  const view = activeView.projectPath === projectPath ? activeView.view : preferredView;

  const saveDefaultView = useCallback((next: AgentWorkspaceView) => {
    return setDefaultAgentChatView(next);
  }, []);
  const saveProjectView = useCallback(
    (next: AgentWorkspaceView | null) => {
      if (!projectPath) return false;
      const saved = setProjectAgentChatViewOverride(projectPath, next);
      const nextView = next ?? getDefaultAgentChatView();
      setActiveAgentWorkspaceView(projectPath, nextView);
      setActiveView({ projectPath, view: nextView });
      return saved;
    },
    [projectPath]
  );
  const useDefaultView = useCallback(() => saveProjectView(null), [saveProjectView]);

  return {
    defaultView,
    projectView,
    view,
    isUsingDefault: projectView === null,
    setDefaultView: saveDefaultView,
    setProjectView: saveProjectView,
    useDefaultView,
    isChatSelected: view === 'chat',
  };
}
