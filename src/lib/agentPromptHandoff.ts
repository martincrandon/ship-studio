/** Result of placing an explicit-review prompt in the selected agent surface. */
export type AgentPromptHandoffResult = 'terminal' | 'chat-draft' | false;
export const CHAT_PROMPT_STAGED_MESSAGE = 'Prompt added to Chat draft. Review it, then press Send.';

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
