/** Workspace view preferences for the optional Codex Chat surface. */

export type AgentWorkspaceView = 'terminal' | 'chat';

export const AGENT_CHAT_VIEW_PREFERENCE_CHANGED_EVENT =
  'shipstudio:agent-chat-view-preference-changed';

const DEFAULT_VIEW_KEY = 'shipstudio.agentChat.defaultView';
const PROJECT_VIEW_PREFIX = 'shipstudio.agentChat.projectView:';
const activeProjectViews = new Map<string, AgentWorkspaceView>();

export interface AgentChatViewPreferenceChange {
  projectPath: string | null;
}

function isAgentWorkspaceView(value: string | null): value is AgentWorkspaceView {
  return value === 'terminal' || value === 'chat';
}

function projectViewKey(projectPath: string): string {
  return `${PROJECT_VIEW_PREFIX}${encodeURIComponent(projectPath)}`;
}

export function isProjectAgentChatViewPreferenceKey(
  key: string | null,
  projectPath: string
): boolean {
  return key === projectViewKey(projectPath);
}

/** Resolve the persisted preference without considering this window's active view. */
export function getPreferredAgentWorkspaceView(projectPath: string | null): AgentWorkspaceView {
  if (projectPath) {
    const override = getProjectAgentChatViewOverride(projectPath);
    if (override) return override;
  }
  return getDefaultAgentChatView();
}

/** Keep app-level actions routed to the view the mounted workspace actually shows. */
export function setActiveAgentWorkspaceView(projectPath: string, view: AgentWorkspaceView): void {
  activeProjectViews.set(projectPath, view);
}

/** Forget a workspace's session choice when it unmounts, so reopening uses current defaults. */
export function clearActiveAgentWorkspaceView(
  projectPath: string,
  expectedView?: AgentWorkspaceView
): void {
  if (expectedView && activeProjectViews.get(projectPath) !== expectedView) return;
  activeProjectViews.delete(projectPath);
}

function readView(key: string): AgentWorkspaceView | null {
  try {
    const value = localStorage.getItem(key);
    return isAgentWorkspaceView(value) ? value : null;
  } catch {
    return null;
  }
}

function notifyPreferenceChange(projectPath: string | null): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<AgentChatViewPreferenceChange>(AGENT_CHAT_VIEW_PREFERENCE_CHANGED_EVENT, {
      detail: { projectPath },
    })
  );
}

/** The app-wide default starts at Terminal until the user changes it in Settings. */
export function getDefaultAgentChatView(): AgentWorkspaceView {
  return readView(DEFAULT_VIEW_KEY) ?? 'terminal';
}

/** Save and broadcast the app-wide default view to every open window. */
export function setDefaultAgentChatView(view: AgentWorkspaceView): boolean {
  try {
    localStorage.setItem(DEFAULT_VIEW_KEY, view);
  } catch {
    return false;
  }
  notifyPreferenceChange(null);
  return true;
}

/** Return a project's explicit override, or null when it follows the app default. */
export function getProjectAgentChatViewOverride(projectPath: string): AgentWorkspaceView | null {
  return readView(projectViewKey(projectPath));
}

/** Save or remove the project override and broadcast it to open windows. */
export function setProjectAgentChatViewOverride(
  projectPath: string,
  view: AgentWorkspaceView | null
): boolean {
  try {
    if (view) localStorage.setItem(projectViewKey(projectPath), view);
    else localStorage.removeItem(projectViewKey(projectPath));
  } catch {
    return false;
  }
  notifyPreferenceChange(projectPath);
  return true;
}

/** Resolve the view for a project without needing a mounted React hook. */
export function getAgentWorkspaceView(projectPath: string | null): AgentWorkspaceView {
  return projectPath
    ? (activeProjectViews.get(projectPath) ?? getPreferredAgentWorkspaceView(projectPath))
    : getDefaultAgentChatView();
}
