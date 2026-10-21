/**
 * Everything that hands work to the workspace's agent tabs from outside the
 * workspace: an Inbox finding sent to an agent, and remote access starting or
 * closing an agent from a phone.
 *
 * Both need the same three things App owns — which view is showing, the
 * current project, and the terminal bundle — so they're wired once here
 * rather than one by one in App.
 *
 * @module hooks/useAgentDeliveries
 */

import type { Project } from '../lib/project';
import type { ToastAction, ToastOptions, ToastType } from './useToasts';
import { useFindingHandoff } from './useWorkflowHandoff';
import { useRemoteAgentControl } from './useRemoteAgentControl';

type Terminals = Parameters<typeof useFindingHandoff>[1] &
  Parameters<typeof useRemoteAgentControl>[2];

export function useAgentDeliveries(
  inWorkspace: boolean,
  currentProject: Project | null,
  terminals: Terminals,
  showToast: (
    message: string,
    type?: ToastType,
    action?: ToastAction,
    options?: ToastOptions
  ) => void,
  openProject: (project: Project) => void | Promise<void>
): void {
  const currentPath = currentProject?.path ?? null;
  // "Send to agent" from the Inbox — see hooks/useWorkflowHandoff. Null while
  // off-workspace: the Inbox link keeps the hot project current, so the flip
  // back to 'workspace' is what re-arms delivery of a second finding.
  useFindingHandoff(inWorkspace ? currentPath : null, terminals, showToast);
  // Remote access's start_agent / close_agent — see hooks/useRemoteAgentControl.
  useRemoteAgentControl(currentPath, inWorkspace, terminals, openProject);
}
