/** Frontend contract and Tauri wrappers for persistent Codex Chat threads. */

import { invoke } from '@tauri-apps/api/core';
import { asCommandError, formatCommandError } from './errors';
import { logger } from './logger';

export interface ChatAttachment {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'file';
  /** Set by the backend after checking an app-owned attachment record and bytes. */
  available?: boolean;
}

export type ChatItemKind =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool'
  | 'fileChange'
  | 'plan'
  | 'activity'
  | 'error';

export interface ChatItem {
  id: string;
  turnId: string | null;
  kind: ChatItemKind;
  text: string;
  status: string | null;
  attachments: ChatAttachment[];
}

export type ChatRequestKind = 'approval' | 'question' | 'elicitation';

export interface ChatRequest {
  id: string;
  method: string;
  kind: ChatRequestKind;
  title: string;
  params: Record<string, unknown>;
}

export type ChatThreadStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'interrupted'
  | 'error'
  | 'closed';

export interface ChatThread {
  id: string;
  projectId: string;
  projectPath: string;
  checkoutPath: string;
  checkoutStatus: 'unknown' | 'available' | 'missing';
  providerId: string;
  providerThreadId: string | null;
  resumeStatus: 'unknown' | 'available' | 'unavailable';
  providerStatus: 'unknown' | 'notLoaded' | 'idle' | 'active' | 'systemError';
  title: string;
  titleSource: 'draft' | 'prompt' | 'manual';
  status: ChatThreadStatus;
  turnId: string | null;
  items: ChatItem[];
  requests: ChatRequest[];
  draft: { text: string; attachments: ChatAttachment[] };
  settings: { modelId: string | null; reasoningEffort: string | null; autoAcceptMode: boolean };
  disposition: 'active' | 'settled';
  activityCursor: number;
  settledCursor: number | null;
  readCursor: number;
  latestActivityAt: number | null;
  unread: boolean;
  error: string | null;
  revision: number;
}

export interface ChatStorageStatus {
  available: boolean;
  schemaVersion: number;
  error: string | null;
}

export interface SavedChatDraft {
  draftId: string;
  projectId: string;
  checkoutPath: string;
  checkoutStatus: 'available' | 'missing';
  draft: { text: string; attachments: ChatAttachment[] };
  settings: { modelId: string | null; reasoningEffort: string | null; autoAcceptMode: boolean };
  savedAt: number;
  state: 'draft' | 'promoted';
  promotedThreadId: string | null;
}

export interface SavedChatDraftPage {
  drafts: SavedChatDraft[];
  nextOffset: number | null;
}

export interface ChatUnlinkedProject {
  id: string;
  gitCommonDir: string;
  lastPath: string;
  threadCount: number;
}

export interface ChatModel {
  id: string;
  label: string;
  description: string | null;
  isDefault: boolean;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
}

export type ChatResponse = Record<string, unknown>;

async function invokeChat<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : formatCommandError(asCommandError(error));
    logger.error(`Agent chat command '${command}' failed`, { error: message });
    throw new Error(message);
  }
}

export function listAgentChatThreads(projectPath: string): Promise<ChatThread[]> {
  return invokeChat('agent_chat_list', { projectPath });
}

export function listAgentChatDrafts(
  projectPath: string,
  checkoutPath: string,
  limit = 50,
  offset = 0
): Promise<SavedChatDraftPage> {
  return invokeChat('agent_chat_list_drafts', { projectPath, checkoutPath, limit, offset });
}

export function saveAgentChatProjectDraftCommand(
  projectPath: string,
  checkoutPath: string,
  draftId: string,
  draft: { text: string; attachments: ChatAttachment[] },
  settings: { modelId: string | null; reasoningEffort: string | null; autoAcceptMode: boolean }
): Promise<SavedChatDraft> {
  return invokeChat('agent_chat_save_project_draft', {
    projectPath,
    checkoutPath,
    draftId,
    draft,
    settings,
  });
}

export function deleteAgentChatProjectDraftCommand(
  projectPath: string,
  draftId: string
): Promise<void> {
  return invokeChat('agent_chat_delete_project_draft', { projectPath, draftId });
}

export function promoteAgentChatDraftCommand(
  projectPath: string,
  checkoutPath: string,
  draftId: string,
  providerId = 'codex'
): Promise<ChatThread> {
  return invokeChat('agent_chat_promote_draft', { projectPath, checkoutPath, draftId, providerId });
}

export function createAgentChatThreadCommand(
  projectPath: string,
  checkoutPath: string,
  providerId = 'codex'
): Promise<ChatThread> {
  return invokeChat('agent_chat_create', { projectPath, checkoutPath, providerId });
}

export function listAgentChatModels(projectPath: string): Promise<ChatModel[]> {
  return invokeChat('agent_chat_models', { projectPath });
}

export function sendAgentChatCommand(
  projectPath: string,
  threadId: string,
  text: string,
  attachments: ChatAttachment[],
  model: string | null,
  effort: string | null,
  autoAcceptMode: boolean
): Promise<ChatThread> {
  return invokeChat('agent_chat_send', {
    projectPath,
    threadId,
    text,
    attachments,
    model,
    effort,
    autoAcceptMode,
  });
}

export function interruptAgentChatCommand(
  projectPath: string,
  threadId: string
): Promise<ChatThread> {
  return invokeChat('agent_chat_interrupt', { projectPath, threadId });
}

export function respondAgentChatCommand(
  projectPath: string,
  threadId: string,
  requestId: string,
  response: ChatResponse
): Promise<ChatThread> {
  return invokeChat('agent_chat_respond', { projectPath, threadId, requestId, response });
}

export function discardAgentChatCommand(
  projectPath: string,
  threadId: string,
  confirmed: true
): Promise<void> {
  return invokeChat('agent_chat_discard', { projectPath, threadId, confirmed });
}

export function stageAgentChatAttachmentCommand(
  projectPath: string,
  path: string
): Promise<ChatAttachment> {
  return invokeChat('agent_chat_stage_attachment', { projectPath, path });
}

export function recheckAgentChatAttachmentsCommand(
  projectPath: string,
  attachments: ChatAttachment[]
): Promise<ChatAttachment[]> {
  return invokeChat('agent_chat_recheck_attachments', { projectPath, attachments });
}

export function saveAgentChatDraftCommand(
  projectPath: string,
  threadId: string,
  draft: { text: string; attachments: ChatAttachment[] }
): Promise<ChatThread> {
  return invokeChat('agent_chat_save_draft', { projectPath, threadId, draft });
}

export function saveAgentChatSettingsCommand(
  projectPath: string,
  threadId: string,
  settings: { modelId: string | null; reasoningEffort: string | null; autoAcceptMode: boolean }
): Promise<ChatThread> {
  return invokeChat('agent_chat_save_settings', { projectPath, threadId, settings });
}

export function renameAgentChatThreadCommand(
  projectPath: string,
  threadId: string,
  title: string
): Promise<ChatThread> {
  return invokeChat('agent_chat_rename', { projectPath, threadId, title });
}

export function reopenAgentChatThreadCommand(
  projectPath: string,
  threadId: string
): Promise<ChatThread> {
  return invokeChat('agent_chat_reopen', { projectPath, threadId });
}

export function markAgentChatThreadReadCommand(
  projectPath: string,
  threadId: string
): Promise<ChatThread> {
  return invokeChat('agent_chat_mark_read', { projectPath, threadId });
}

export function settleAgentChatThreadCommand(
  projectPath: string,
  threadId: string
): Promise<ChatThread> {
  return invokeChat('agent_chat_settle', { projectPath, threadId });
}

export function resumeCheckAgentChatThreadCommand(
  projectPath: string,
  threadId: string
): Promise<ChatThread> {
  return invokeChat('agent_chat_resume_check', { projectPath, threadId });
}

export function relinkAgentChatCheckoutCommand(
  projectPath: string,
  threadId: string,
  checkoutPath: string
): Promise<ChatThread> {
  return invokeChat('agent_chat_relink_checkout', { projectPath, threadId, checkoutPath });
}

export function getAgentChatStorageStatusCommand(): Promise<ChatStorageStatus> {
  return invokeChat('agent_chat_storage_status');
}

export function listUnlinkedAgentChatProjectsCommand(): Promise<ChatUnlinkedProject[]> {
  return invokeChat('agent_chat_list_unlinked_projects');
}

export function relinkAgentChatProjectCommand(
  projectId: string,
  projectPath: string
): Promise<void> {
  return invokeChat('agent_chat_relink_project', { projectId, projectPath });
}
