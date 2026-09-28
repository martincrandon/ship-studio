/**
 * Renderer flags are enabled only for adapters with a reviewed host contract.
 * First use still requires explicit project-scoped consent: enabling a flag
 * never writes a route or executes project code before the user reviews the
 * generated host paths. Later ephemeral sessions may start automatically
 * while that versioned consent remains current.
 */
export const COMPONENT_WORKSPACE_ENABLED = true;
export const COMPONENT_RENDERER_FLAGS = {
  react: false,
  nextAppRouter: true,
  nextPagesRouter: true,
  vite: false,
  // The shared stage is only eligible for the v2 host contract. Legacy
  // sessions continue through the bounded per-frame iframe path below.
  stage: false,
  // The editing release gate is enabled only for the reviewed Next hosts.
  // ComponentsWorkspace requests it from the Next renderer session after the
  // parser-proven inspector capability is available; all other adapters stay
  // catalog-only because their renderer gates remain off.
  editing: true,
} as const;

export interface ComponentRendererFlags {
  react: boolean;
  nextAppRouter: boolean;
  nextPagesRouter: boolean;
  vite: boolean;
  stage: boolean;
  editing: boolean;
}

/** Enables the shared project-runtime canvas only for its reviewed host contract. */
export function componentRendererStageEnabled(
  flags: Pick<ComponentRendererFlags, 'stage'>,
  integrationVersion: string
): boolean {
  return flags.stage && integrationVersion === 'next-host-v2';
}

/** Editing is a separate release gate from renderer availability. */
export function componentRendererEditingEnabled(
  flags: Pick<ComponentRendererFlags, 'editing'>,
  rendererInspectorAvailable: boolean
): boolean {
  return flags.editing && rendererInspectorAvailable;
}

export const COMPONENT_TELEMETRY_EVENTS = [
  'component_workspace_opened',
  'component_canvas_scope_changed',
  'component_canvas_layout_changed',
  'component_renderer_session_started',
  'component_renderer_session_failed',
  'component_renderer_frame_ready',
  'component_renderer_frame_error',
  'component_edit_main_started',
] as const;

/** Only bounded, non-sensitive dimensions may be sent to analytics. */
export function componentTelemetryBucket(value: number): string {
  if (value <= 0) return '0';
  if (value <= 6) return '1-6';
  if (value <= 25) return '7-25';
  if (value <= 100) return '26-100';
  return '100+';
}
