import type { ReactNode } from 'react';
import { CloseIcon, PinIcon } from '@/components/icons';
import { Button } from '../../primitives/Button';
import { IconButton } from '../../primitives/IconButton';
import { ToggleButton } from '../../primitives/ToggleButton';

/** The lifecycle states that can be observed for a selected canvas frame. */
export type StyleTabFrameStatus = 'none' | 'loading' | 'cached' | 'unsupported' | 'error' | 'live';

/** The two existing style engines that can be hosted by this tab. */
export type StyleTabEditorMode = 'tailwind' | 'css';

/** Whether the selected renderer element has an exact, revision-bound source. */
export type StyleTabSourceStatus = 'exact' | 'unproven';

/**
 * Inputs owned by the workspace and renderer hooks. This is deliberately a
 * plain data model so the state table can be tested without mounting the
 * canvas or either editor hook.
 */
export interface StyleTabStateInput {
  frameStatus: StyleTabFrameStatus;
  /** Reason returned by the renderer/readiness layer, when one exists. */
  frameReason?: string | null;
  /** A live frame may still have no selected descendant. */
  hasSelectedElement: boolean;
  /** `unproven` is also the safe default when selection has no source proof. */
  sourceStatus?: StyleTabSourceStatus;
  /** Resolver diagnostic shown for an unproven selected element. */
  sourceReason?: string | null;
  /** Null means no supported style engine is available for this live frame. */
  editorMode?: StyleTabEditorMode | null;
  /** Main-definition confirmation is the only write authority this tab sees. */
  editMainConfirmed: boolean;
  /**
   * Capability negotiated by the active renderer surface. A live frame can
   * still be inspection-only (for example while the renderer editing release
   * gate is off), so confirmation alone must never make controls interactive.
   */
  editingCapability: boolean;
  /** Honest reason supplied when the renderer explicitly withholds editing. */
  editingCapabilityReason?: string | null;
  /** Honest reason for a live frame without a supported style engine. */
  editorReason?: string | null;
}

export type StyleTabUnavailableStatus = Exclude<StyleTabFrameStatus, 'none' | 'live'>;

export interface StyleTabEmptyState {
  kind: 'empty';
  canMutate: false;
}

export interface StyleTabUnavailableState {
  kind: 'unavailable';
  status: StyleTabUnavailableStatus;
  reason: string;
  canMutate: false;
}

export interface StyleTabPromptState {
  kind: 'prompt';
  message: 'Select an element in the frame or Elements panel';
  canMutate: false;
}

export interface StyleTabReadOnlyState {
  kind: 'readonly';
  mode: StyleTabEditorMode;
  reason: string;
  canMutate: false;
}

export interface StyleTabAwaitingConfirmationState {
  kind: 'awaiting-confirmation';
  mode: StyleTabEditorMode;
  canMutate: false;
}

export interface StyleTabEditableState {
  kind: 'editable';
  mode: StyleTabEditorMode;
  canMutate: true;
}

/**
 * Explicit Style-tab state table. Keep this pure: no renderer or source
 * assumptions belong here.
 */
export type StyleTabState =
  | StyleTabEmptyState
  | StyleTabUnavailableState
  | StyleTabPromptState
  | StyleTabReadOnlyState
  | StyleTabAwaitingConfirmationState
  | StyleTabEditableState;

const DEFAULT_UNAVAILABLE_REASONS: Record<StyleTabUnavailableStatus, string> = {
  loading: 'The selected component frame is still loading.',
  cached: 'Style inspection is unavailable for a cached component frame.',
  unsupported: 'Style inspection is unavailable for this component renderer.',
  error: 'The selected component frame could not be inspected.',
};

const DEFAULT_SOURCE_REASON = 'The selected element has no exact source range yet.';
const DEFAULT_CAPABILITY_REASON =
  'This component frame is inspection-only because renderer editing is unavailable.';

function unavailableState(
  status: StyleTabUnavailableStatus,
  reason: string | null | undefined
): StyleTabUnavailableState {
  return {
    kind: 'unavailable',
    status,
    reason: reason?.trim() || DEFAULT_UNAVAILABLE_REASONS[status],
    canMutate: false,
  };
}

/**
 * Derive the Style-tab state from explicit renderer, selection, and authority
 * facts. Ordering is intentional: a frame that is not live can never expose
 * page-derived controls, and an unproven source can never become editable.
 */
export function deriveStyleTabState(input: StyleTabStateInput): StyleTabState {
  if (input.frameStatus === 'none') {
    return { kind: 'empty', canMutate: false };
  }

  if (input.frameStatus !== 'live') {
    return unavailableState(input.frameStatus, input.frameReason);
  }

  if (!input.hasSelectedElement) {
    return {
      kind: 'prompt',
      message: 'Select an element in the frame or Elements panel',
      canMutate: false,
    };
  }

  const mode = input.editorMode ?? null;
  if (!mode) {
    return unavailableState('unsupported', input.editorReason);
  }

  // This check deliberately precedes source proof and Edit-main confirmation:
  // neither a previously-confirmed session nor an exact source range can
  // grant a capability the negotiated renderer did not provide.
  if (input.editingCapability === false) {
    return {
      kind: 'readonly',
      mode,
      reason: input.editingCapabilityReason?.trim() || DEFAULT_CAPABILITY_REASON,
      canMutate: false,
    };
  }

  if (input.sourceStatus !== 'exact') {
    return {
      kind: 'readonly',
      mode,
      reason: input.sourceReason?.trim() || DEFAULT_SOURCE_REASON,
      canMutate: false,
    };
  }

  if (!input.editMainConfirmed) {
    return { kind: 'awaiting-confirmation', mode, canMutate: false };
  }

  return { kind: 'editable', mode, canMutate: true };
}

export interface StyleTabRenderContext {
  state: StyleTabState;
  /** True only for the confirmed exact-source state. */
  canMutate: boolean;
  /** Convenience inverse for callers that configure read-only editor panels. */
  readOnly: boolean;
}

type StyleTabContent = ReactNode | ((context: StyleTabRenderContext) => ReactNode);

export interface StyleTabProps extends StyleTabStateInput {
  /** Existing VisualEditorPanel or CssCascadePanel content for confirmed edits. */
  controls?: StyleTabContent;
  /** Existing panel content configured by the caller with write callbacks removed. */
  readOnlyControls?: StyleTabContent;
  /**
   * Optional render function for callers that need to pass `canMutate` into
   * existing panel wrappers. It takes precedence over the static content props.
   */
  renderControls?: (context: StyleTabRenderContext) => ReactNode;
  /** Opens the existing Edit-main confirmation flow; it never writes by itself. */
  onRequestEditMain?: () => void;
  /** Header actions used while the editor surface is waiting for a selection. */
  pinned?: boolean;
  onTogglePin?: () => void;
  onClose?: () => void;
  /** Lets an embedded editor own a diagnostic that it already renders inline. */
  showStateMessage?: boolean;
  /** Shared EditPanelShell owns the header when this is rendered in a dock. */
  showHeader?: boolean;
  className?: string;
}

function renderContent(
  content: StyleTabContent | undefined,
  context: StyleTabRenderContext
): ReactNode {
  return typeof content === 'function' ? content(context) : content;
}

function stateMessage(state: StyleTabState): string | null {
  switch (state.kind) {
    case 'empty':
      return 'Select a component frame to inspect styles.';
    case 'unavailable':
      return state.reason;
    case 'prompt':
      return state.message;
    case 'readonly':
      return state.reason;
    case 'awaiting-confirmation':
      return 'Confirm Edit main to enable style changes to this component definition.';
    case 'editable':
      return null;
  }
}

/**
 * Focused Style-tab shell. It owns presentation of the state matrix and the
 * confirmation request, while the actual Tailwind/CSS controls remain the
 * supplied existing panels.
 */
export function StyleTab({
  controls,
  readOnlyControls,
  renderControls,
  onRequestEditMain,
  pinned = false,
  onTogglePin,
  onClose,
  showStateMessage = true,
  showHeader = true,
  className,
  ...input
}: StyleTabProps) {
  const state = deriveStyleTabState(input);
  const context: StyleTabRenderContext = {
    state,
    canMutate: state.canMutate,
    readOnly: !state.canMutate,
  };
  const content = renderControls
    ? renderControls(context)
    : state.kind === 'readonly' || state.kind === 'awaiting-confirmation'
      ? renderContent(readOnlyControls, context)
      : state.kind === 'editable'
        ? renderContent(controls, context)
        : null;
  const message = stateMessage(state);
  const isBusy = state.kind === 'unavailable' && state.status === 'loading';
  const panelTitle = input.editorMode === 'css' ? 'CSS' : 'Edit';
  const hasEditorSurface =
    !!content &&
    (state.kind === 'readonly' ||
      state.kind === 'awaiting-confirmation' ||
      state.kind === 'editable');

  return (
    <div
      className={className}
      data-testid="component-inspector-style-tab"
      data-style-tab-state={state.kind}
      data-style-tab-mode={'mode' in state ? state.mode : undefined}
      aria-readonly={state.canMutate ? undefined : true}
    >
      {showHeader && !hasEditorSurface && (
        <div className="ss-edit-panel__header" data-dockable-drag-handle>
          <span className="ss-edit-panel__title">{panelTitle}</span>
          {(onTogglePin || onClose) && (
            <span className="ss-edit-panel__header-actions">
              {onTogglePin && (
                <ToggleButton
                  variant="ghost"
                  size="compact"
                  className="button--icon-only panel-pin-toggle"
                  onClick={onTogglePin}
                  title={pinned ? 'Unpin — float over the preview' : 'Pin to the window'}
                  aria-label={
                    pinned ? `Unpin ${panelTitle} panel` : `Pin ${panelTitle} panel to the window`
                  }
                  pressed={pinned}
                  leftIcon={<PinIcon size={13} />}
                />
              )}
              {onClose && (
                <IconButton
                  variant="ghost"
                  size="compact"
                  aria-label={`Close ${panelTitle} panel`}
                  title={`Close ${panelTitle} panel`}
                  icon={<CloseIcon size={14} />}
                  onClick={onClose}
                />
              )}
            </span>
          )}
        </div>
      )}
      {showStateMessage && message && (
        <p
          className="components-workspace__panel-note"
          role={state.kind === 'unavailable' && state.status !== 'loading' ? 'alert' : 'status'}
          aria-busy={isBusy}
          data-testid={
            state.kind === 'unavailable'
              ? 'component-inspector-style-tab-unavailable-reason'
              : 'component-inspector-style-tab-message'
          }
        >
          {message}
        </p>
      )}
      {state.kind === 'awaiting-confirmation' && onRequestEditMain && (
        <Button
          variant="secondary"
          size="compact"
          data-testid="component-inspector-style-tab-edit-main"
          onClick={onRequestEditMain}
        >
          Edit main component
        </Button>
      )}
      {state.kind === 'readonly' && (
        <div
          className="ss-edit-panel__content-host"
          data-testid="component-inspector-style-tab-readonly"
          aria-readonly="true"
        >
          {content}
        </div>
      )}
      {state.kind === 'awaiting-confirmation' && content && (
        <div
          className="ss-edit-panel__content-host"
          data-testid="component-inspector-style-tab-awaiting-controls"
          aria-readonly="true"
        >
          {content}
        </div>
      )}
      {state.kind === 'editable' && (
        <div className="ss-edit-panel__content-host" data-testid="component-inspector-style-tab-controls">
          {content}
        </div>
      )}
    </div>
  );
}

/** Descriptive alias for workspace callers that prefer the component role in its name. */
export const ComponentInspectorStyleTab = StyleTab;
