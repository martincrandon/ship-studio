import { getAgentWorkspaceView } from './agentChatPreferences';
import { stagePrompt } from './agentChatStore';

/** Result of placing an explicit-review prompt in the selected agent surface. */
export type AgentPromptHandoffResult = 'terminal' | 'chat-draft' | false;
export const CHAT_PROMPT_STAGED_MESSAGE = 'Prompt added to Chat draft. Review it, then press Send.';

/** Deliver a prompt to the selected Chat draft or Terminal and report an unavailable target. */
export function handoffPromptToSelectedAgent(
  projectPath: string | null,
  text: string,
  pasteToActiveTerminal: (text: string) => boolean,
  showInfo: (message: string, type: 'info') => void
): AgentPromptHandoffResult {
  if (projectPath && getAgentWorkspaceView(projectPath) === 'chat') {
    if (stagePrompt(projectPath, text)) return 'chat-draft';
    showInfo('The Chat draft is unavailable. The prompt was not sent to Terminal.', 'info');
    return false;
  }
  if (pasteToActiveTerminal(text)) return 'terminal';
  showInfo('The selected Terminal agent is unavailable. The prompt was not sent.', 'info');
  return false;
}

/** Bind the selected-agent handoff to the live project-path ref. */
export function createSelectedAgentHandoff(
  projectPathRef: { current: string | null },
  pasteToActiveTerminal: (text: string) => boolean,
  showInfo: (message: string, type: 'info') => void
): (text: string) => AgentPromptHandoffResult {
  return (text) =>
    handoffPromptToSelectedAgent(projectPathRef.current, text, pasteToActiveTerminal, showInfo);
}

const chatDraftRevealListeners = new Set<() => void>();

/** Ask the open workspace to reveal Chat so a newly staged prompt can be reviewed. */
export function requestChatDraftReview(): void {
  chatDraftRevealListeners.forEach((listener) => listener());
}

export function subscribeChatDraftReview(listener: () => void): () => void {
  chatDraftRevealListeners.add(listener);
  return () => chatDraftRevealListeners.delete(listener);
}

/** Pick an accurate success message for the destination that accepted a prompt. */
export function promptHandoffSuccessMessage(
  result: AgentPromptHandoffResult | void,
  terminalMessage: string,
  chatMessage: string
): string | null {
  if (result === false) return null;
  return result === 'chat-draft' ? chatMessage : terminalMessage;
}
