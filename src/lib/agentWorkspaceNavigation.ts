export type AgentWorkspaceNavigationTarget =
  | { kind: 'chat-thread'; threadId: string }
  | { kind: 'chat-draft'; draftId: string; checkoutPath: string }
  | { kind: 'terminal-tab'; sessionId: string };

export interface AgentWorkspaceNavigationRequest {
  id: number;
  projectPath: string;
  target: AgentWorkspaceNavigationTarget;
  expiresAt: number;
}

const REQUEST_LIFETIME_MS = 60_000;
const requests = new Map<string, AgentWorkspaceNavigationRequest>();
let nextRequestId = 0;

/** Hold one exact target while the existing project-open flow changes projects. */
export function requestAgentWorkspaceNavigation(
  projectPath: string,
  target: AgentWorkspaceNavigationTarget
): AgentWorkspaceNavigationRequest {
  const request: AgentWorkspaceNavigationRequest = {
    id: ++nextRequestId,
    projectPath,
    target,
    expiresAt: Date.now() + REQUEST_LIFETIME_MS,
  };
  requests.set(projectPath, request);
  return request;
}

export function getAgentWorkspaceNavigationRequest(
  projectPath: string
): AgentWorkspaceNavigationRequest | null {
  const request = requests.get(projectPath);
  if (!request) return null;
  if (request.expiresAt <= Date.now()) {
    requests.delete(projectPath);
    return null;
  }
  return request;
}

/** Clear only the request that was applied; a newer click stays queued. */
export function completeAgentWorkspaceNavigation(projectPath: string, requestId: number): void {
  if (requests.get(projectPath)?.id === requestId) requests.delete(projectPath);
}
