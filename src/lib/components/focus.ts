import type { Resolution, TextResolution } from '../edit';
import { normalizeProjectPath } from './adapters/react-helpers';
import type {
  ComponentFocusLevel,
  ComponentFocusSession,
  ComponentIndex,
  ComponentDiagnostic,
  SourceRef,
} from './types';

/** The bounded context shared by focused editors and preview-agent tooling. */
export interface ComponentFocusContext {
  indexRevision: string;
  routeKey: string | null;
  componentId: string;
  instanceId: string;
  name: string;
  definition: SourceRef;
  invocation: SourceRef;
  ancestry: ComponentFocusLevel[];
  capabilities: {
    editMain: boolean;
    focusedVisualEditing: boolean;
  };
  /** Number of indexed invocations that will receive a definition edit. */
  usageCount: number;
  /** Explicitly tells consumers that a definition edit is shared. */
  affectsAllUsages: true;
  /** Exact selected child source range, when one has been proven. */
  selectedChild: SourceRef | null;
}

export type FocusTargetRefusalCode =
  | 'no-focus'
  | 'stale-revision'
  | 'stale-route'
  | 'stale-source'
  | 'outside-definition'
  | 'missing-range'
  | 'ambiguous-target'
  | 'unsupported';

export interface FocusTargetValidation {
  status: 'valid' | 'refused';
  source?: SourceRef;
  code?: FocusTargetRefusalCode;
  diagnostic?: ComponentDiagnostic;
}

function diagnostic(code: FocusTargetRefusalCode, message: string): ComponentDiagnostic {
  return { code: `component-focus-${code}`, severity: 'warning', message };
}

function sameSourceRef(left: SourceRef, right: SourceRef): boolean {
  return (
    normalizeProjectPath(left.file) === normalizeProjectPath(right.file) &&
    left.start === right.start &&
    left.end === right.end &&
    left.contentHash === right.contentHash
  );
}

/** Return a context only when the session still matches the current index. */
export function createComponentFocusContext(
  session: ComponentFocusSession | null,
  index: ComponentIndex | null,
  selectedChild: SourceRef | null = null
): ComponentFocusContext | null {
  if (!session || !index || session.indexRevision !== index.revision) return null;
  const component = index.components.find((item) => item.id === session.componentId);
  const instance = index.instances.find((item) => item.id === session.instanceId);
  if (
    !component ||
    !instance ||
    instance.componentId !== component.id ||
    !sameSourceRef(session.definition, component.definition) ||
    !sameSourceRef(session.invocation, instance.invocation)
  ) {
    return null;
  }

  const child =
    selectedChild && isSourceRefInside(component.definition, selectedChild) ? selectedChild : null;
  return {
    indexRevision: index.revision,
    routeKey: session.routeKey,
    componentId: component.id,
    instanceId: instance.id,
    name: component.name,
    definition: component.definition,
    invocation: instance.invocation,
    ancestry: session.ancestry.map(copyLevel),
    capabilities: {
      editMain: component.capabilities.editMain,
      focusedVisualEditing: component.capabilities.focusedVisualEditing,
    },
    usageCount: index.instances.filter((item) => item.componentId === component.id).length,
    affectsAllUsages: true,
    selectedChild: child,
  };
}

/** Add or clear the current exact child target without widening the context. */
export function withFocusedChild(
  context: ComponentFocusContext | null,
  selectedChild: SourceRef | null
): ComponentFocusContext | null {
  if (!context) return null;
  return {
    ...context,
    selectedChild:
      selectedChild && isSourceRefInside(context.definition, selectedChild) ? selectedChild : null,
  };
}

/** Convert the class resolver's optional source provenance into the shared range DTO. */
export function sourceRefFromResolution(
  resolution: Resolution | null | undefined
): SourceRef | null {
  if (resolution?.status !== 'resolved') return null;
  const { source_start: start, source_end: end, source_hash: contentHash } = resolution;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    (start as number) < 0 ||
    (end as number) <= (start as number) ||
    typeof contentHash !== 'string' ||
    contentHash.length === 0
  ) {
    return null;
  }
  return {
    file: normalizeProjectPath(resolution.file),
    start: start as number,
    end: end as number,
    line: resolution.line,
    column: resolution.column,
    contentHash,
  };
}

/** Convert the text resolver's optional source provenance into the same DTO. */
export function sourceRefFromTextResolution(
  resolution: TextResolution | null | undefined
): SourceRef | null {
  if (resolution?.status !== 'resolved') return null;
  const { source_start: start, source_end: end, source_hash: contentHash } = resolution;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    (start as number) < 0 ||
    (end as number) <= (start as number) ||
    typeof contentHash !== 'string' ||
    contentHash.length === 0
  ) {
    return null;
  }
  return {
    file: normalizeProjectPath(resolution.file),
    start: start as number,
    end: end as number,
    line: resolution.line,
    column: resolution.column,
    contentHash,
  };
}

/** Check that an exact source range remains inside the focused definition. */
export function isSourceRefInside(container: SourceRef, candidate: SourceRef): boolean {
  return (
    normalizeProjectPath(container.file) === normalizeProjectPath(candidate.file) &&
    container.contentHash === candidate.contentHash &&
    Number.isInteger(candidate.start) &&
    Number.isInteger(candidate.end) &&
    candidate.start >= container.start &&
    candidate.end <= container.end &&
    candidate.end > candidate.start
  );
}

/** Validate a source target immediately before a focused write. */
export function validateFocusedSourceTarget(
  context: ComponentFocusContext | null,
  source: SourceRef | null,
  currentRevision?: string | null,
  currentRoute?: string | null
): FocusTargetValidation {
  if (!context) {
    return {
      status: 'refused',
      code: 'no-focus',
      diagnostic: diagnostic('no-focus', 'No component is focused.'),
    };
  }
  if (currentRevision && currentRevision !== context.indexRevision) {
    return {
      status: 'refused',
      code: 'stale-revision',
      diagnostic: diagnostic(
        'stale-revision',
        'The component index changed while this component was focused. Refresh and re-enter focus.'
      ),
    };
  }
  if (currentRoute !== undefined && currentRoute !== context.routeKey) {
    return {
      status: 'refused',
      code: 'stale-route',
      diagnostic: diagnostic(
        'stale-route',
        'The preview route changed while this component was focused. Re-enter component focus.'
      ),
    };
  }
  if (!context.capabilities.focusedVisualEditing) {
    return {
      status: 'refused',
      code: 'unsupported',
      diagnostic: diagnostic(
        'unsupported',
        'This component adapter cannot prove a definition target for focused editing.'
      ),
    };
  }
  if (!source) {
    return {
      status: 'refused',
      code: 'missing-range',
      diagnostic: diagnostic(
        'missing-range',
        'Ship Studio could not prove the selected child source range inside this component definition.'
      ),
    };
  }
  if (!isSourceRefInside(context.definition, source)) {
    return {
      status: 'refused',
      code: 'outside-definition',
      diagnostic: diagnostic(
        'outside-definition',
        'The selected source range is outside the focused component definition. The edit was not applied.'
      ),
    };
  }
  return { status: 'valid', source };
}

/** A compact, non-sensitive status block for the Agent preview bridge. */
export function formatFocusContextForAgent(context: ComponentFocusContext | null): string {
  if (!context) return 'Component focus: inactive.';
  const child = context.selectedChild
    ? `${context.selectedChild.file}:${context.selectedChild.line}`
    : 'no exact child source target yet';
  return [
    'Component focus: active.',
    `Definition: ${context.definition.file} (source hash ${context.definition.contentHash}).`,
    `Component id: ${context.componentId}; focused instance: ${context.instanceId}.`,
    `Definition edits affect all ${context.usageCount} indexed usage(s).`,
    `Selected child source: ${child}.`,
    'Focused writes must target the proven definition range; never infer an invocation or guessed file/range.',
  ].join('\n');
}

function copyLevel(level: ComponentFocusLevel): ComponentFocusLevel {
  return {
    ...level,
    hostNodeIds: [...level.hostNodeIds],
  };
}
