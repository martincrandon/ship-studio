import { invoke } from '@tauri-apps/api/core';
import type { ComponentCanvasDocument } from './canvas';
import {
  adaptCanvasDocument,
  serializeCanvasDocument,
  type CanvasDocumentAdapterResult,
  type CanvasDocumentV2,
} from './canvas-document';
import type { RendererSessionDescriptor } from './renderer-session';

interface CanvasWriteQueue {
  tail: Promise<void>;
}

// Tauri commands may overlap even when callers use the same project path. Keep
// the ordering guarantee at the storage boundary so every canvas writer in the
// frontend shares one queue, including callers that outlive a React component.
const canvasWriteQueues = new Map<string, CanvasWriteQueue>();

function enqueueCanvasWrite(projectPath: string, document: unknown): Promise<void> {
  const queue = canvasWriteQueues.get(projectPath) ?? { tail: Promise.resolve() };
  const write = queue.tail.then(
    () =>
      invoke('set_component_canvas_document', {
        projectPath,
        document,
      }).then(() => undefined),
    () =>
      invoke('set_component_canvas_document', {
        projectPath,
        document,
      }).then(() => undefined)
  );
  // Keep the queue usable after a failed write while preserving the rejection
  // for the caller that owns this particular write.
  queue.tail = write.catch(() => undefined);
  canvasWriteQueues.set(projectPath, queue);
  return write;
}

/** Waits for all canvas writes already queued for one project. */
export function flushComponentCanvasWrites(projectPath: string): Promise<void> {
  return canvasWriteQueues.get(projectPath)?.tail ?? Promise.resolve();
}

export interface ComponentRendererCapabilities {
  liveFrame: boolean;
  snapshots: boolean;
  accessibility: boolean;
  editing: boolean;
}

export interface PrepareComponentRendererSessionRequest {
  allowedOrigin: string;
  baseUrl: string;
  requestedComponentIds: string[];
  capabilities: ComponentRendererCapabilities;
}

export interface ComponentRendererSession {
  protocolVersion: 2;
  sessionId: string;
  capabilityToken: string;
  projectIdentity: string;
  allowedOrigin: string;
  baseUrl: string;
  dataEndpoint: string;
  generation: number;
  supportedComponentIds: string[];
  sourceRevisions: Record<string, string>;
  capabilities: ComponentRendererCapabilities;
}

export function toRendererSessionDescriptor(
  session: ComponentRendererSession
): RendererSessionDescriptor {
  return {
    protocolVersion: session.protocolVersion,
    sessionId: session.sessionId,
    capabilityToken: session.capabilityToken,
    allowedOrigin: session.allowedOrigin,
    baseUrl: session.baseUrl,
    dataEndpoint: session.dataEndpoint,
    generation: session.generation,
    projectIdentity: session.projectIdentity,
    supportedComponentIds: session.supportedComponentIds,
    sourceRevisions: session.sourceRevisions,
    capabilities: session.capabilities,
  };
}

export interface RendererFramePresentation {
  widthMode: string;
  width: number | null;
  height: string;
  background: string;
  breakpoint: string | null;
  locale: string | null;
}

export interface PublishComponentRendererFrameRequest {
  sessionId: string;
  capabilityToken: string;
  payload: {
    protocolVersion: 2;
    projectIdentity: string;
    sessionId: string;
    frameId: string;
    componentId: string;
    componentRevision: string;
    generation: number;
    props: unknown;
    slots: Record<string, string>;
    presentation: RendererFramePresentation;
  };
}

export interface InstallComponentRendererHostRequest {
  sessionId: string;
  capabilityToken: string;
  consentVersion: string;
  files: Array<{
    relativePath: string;
    contents: string;
    kind: 'route' | 'client-shell' | 'registry' | 'loading';
  }>;
}

export interface InstallComponentRendererRegistryRequest {
  consentVersion: string;
  sourceRevision: string;
  componentRevisions: Record<string, string>;
}

export interface ComponentRendererConsent {
  integrationVersion: string;
  approvedAt: number;
}

export const COMPONENT_RENDERER_INTEGRATION_VERSION = 'next-host-v2';

export async function getComponentRendererConsent(
  projectPath: string
): Promise<ComponentRendererConsent | null> {
  return invoke<ComponentRendererConsent | null>('get_component_renderer_consent', { projectPath });
}

export async function grantComponentRendererConsent(
  projectPath: string
): Promise<ComponentRendererConsent> {
  return invoke<ComponentRendererConsent>('grant_component_renderer_consent', { projectPath });
}

export async function revokeComponentRendererConsent(projectPath: string): Promise<void> {
  await invoke('revoke_component_renderer_consent', { projectPath });
}

/** Project-scoped persistence through `.shipstudio/project.json`. */
export async function readComponentCanvasDocument(projectPath: string): Promise<unknown> {
  return invoke('get_component_canvas_document', { projectPath });
}

/** Reads and validates the optional scene extensions at the storage boundary. */
export async function readAdaptedComponentCanvasDocument(
  projectPath: string
): Promise<CanvasDocumentAdapterResult> {
  return adaptCanvasDocument(await readComponentCanvasDocument(projectPath));
}

export async function writeComponentCanvasDocument(
  projectPath: string,
  document: ComponentCanvasDocument
): Promise<void> {
  const adapted = adaptCanvasDocument(document).document;
  await enqueueCanvasWrite(projectPath, serializeCanvasDocument(adapted));
}

/** Explicit v2-typed alias for callers that already own an adapted document. */
export async function writeAdaptedComponentCanvasDocument(
  projectPath: string,
  document: CanvasDocumentV2
): Promise<void> {
  await writeComponentCanvasDocument(projectPath, document);
}

export async function prepareComponentRendererSession(
  projectPath: string,
  request: PrepareComponentRendererSessionRequest
): Promise<ComponentRendererSession> {
  return invoke('prepare_component_renderer_session', { projectPath, request });
}

export async function stopComponentRendererSession(
  projectPath: string,
  sessionId: string
): Promise<boolean> {
  return invoke('stop_component_renderer_session', { projectPath, sessionId });
}

export async function publishComponentRendererFrame(
  projectPath: string,
  request: PublishComponentRendererFrameRequest
): Promise<void> {
  await invoke('publish_component_renderer_frame', { projectPath, request });
}

export async function installComponentRendererHost(
  projectPath: string,
  request: InstallComponentRendererHostRequest
): Promise<unknown> {
  return invoke('install_component_renderer_host', { projectPath, request });
}

export async function installComponentRendererRegistry(
  projectPath: string,
  request: InstallComponentRendererRegistryRequest
): Promise<void> {
  await invoke('install_component_renderer_registry', { projectPath, request });
}

export async function recoverComponentRendererSession(
  projectPath: string
): Promise<{ removed: string[]; preservedModified: string[] }> {
  return invoke('recover_component_renderer_session', { projectPath });
}

export async function cleanupComponentRendererSession(
  projectPath: string,
  sessionId: string
): Promise<{ removed: string[]; preservedModified: string[] }> {
  return invoke('cleanup_component_renderer_session', { projectPath, sessionId });
}
