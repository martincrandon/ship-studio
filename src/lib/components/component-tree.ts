import type {
  ComponentAwareTreeNode,
  ComponentBoundary,
  ComponentBoundaryHint,
  ComponentBoundaryValidation,
  ComponentDiagnostic,
  ComponentFocusSession,
  ComponentIndex,
  ComponentTreeNodeInput,
  ComponentTreeProjection,
  ComponentTreeProjectionInput,
  RawComponentTreeNode,
  SourceRef,
} from './types';

/** The canonical shape used internally by the projection algorithm. */
interface NormalizedElement {
  id: number;
  tag: string;
  className: string;
  text: string;
  children: NormalizedElement[];
}

interface NodeLocation {
  node: NormalizedElement;
  parent: NormalizedElement | null;
  order: number;
  ancestors: number[];
}

interface IndexedBoundary extends ComponentBoundary {
  rootNodeIds: number[];
  primaryRootId: number;
}

const EMPTY_ROOT_DIAGNOSTIC: ComponentDiagnostic = {
  code: 'component-tree-empty',
  severity: 'info',
  message: 'The preview returned no DOM tree to project.',
};

/**
 * Validate a proposed runtime boundary against the immutable source index.
 *
 * The function is deliberately strict. A source-anchored frame, an
 * ambiguous binding, a missing invocation, or a stale revision is useful for
 * source navigation but is not enough to hide DOM children or enter focus.
 * `treeNodeIds` is optional so callers can validate source identity before a
 * tree arrives; the full projection always supplies it.
 */
export function validateComponentBoundary(
  hint: ComponentBoundaryHint,
  index: ComponentIndex,
  treeNodeIds?: ReadonlySet<number>
): ComponentBoundaryValidation {
  const binding = hint.binding;
  const confidence = binding?.confidence ?? hint.confidence;
  const componentId = hint.componentId ?? exactBindingValue(binding, 'componentId');
  const instanceId = hint.instanceId ?? exactBindingValue(binding, 'instanceId');
  const indexedComponent = componentId
    ? index.components.find((component) => component.id === componentId)
    : undefined;
  const indexedInstance = instanceId
    ? index.instances.find((instance) => instance.id === instanceId)
    : undefined;

  const diagnostics = [...(hint.diagnostics ?? []), ...(binding?.diagnostics ?? [])];
  if (confidence !== 'exact') {
    return refusedBoundary(
      'component-boundary-unproven',
      'Only an exact source binding can become a component boundary.',
      diagnostics,
      hint
    );
  }
  if (hint.indexRevision && hint.indexRevision !== index.revision) {
    return refusedBoundary(
      'component-boundary-stale-revision',
      'The component boundary belongs to an older component index revision.',
      diagnostics,
      hint
    );
  }
  if (!componentId || !indexedComponent) {
    return refusedBoundary(
      'component-boundary-missing-component',
      'The exact component boundary does not match a component in the current index.',
      diagnostics,
      hint
    );
  }
  if (!instanceId || !indexedInstance) {
    return refusedBoundary(
      'component-boundary-missing-instance',
      'The exact component boundary does not identify an indexed source invocation.',
      diagnostics,
      hint
    );
  }
  if (indexedInstance.componentId !== componentId) {
    return refusedBoundary(
      'component-boundary-identity-mismatch',
      'The boundary component and invocation identities do not match.',
      diagnostics,
      hint
    );
  }
  // An explicitly false capability is authoritative. Older index snapshots
  // predate this flag, so `undefined` remains compatible for read-only data.
  if (indexedComponent.capabilities.componentTreeBoundary === false) {
    return refusedBoundary(
      'component-boundary-unsupported',
      'This component dialect cannot prove Element Tree boundaries.',
      diagnostics,
      hint
    );
  }

  const expectedDefinition = indexedComponent.definition;
  const expectedInvocation = indexedInstance.invocation;
  // An exact selection binding's `source` is the selected invocation, not the
  // component definition. Keep the two source identities separate so the
  // convenience `binding` shape cannot make a valid instance look stale.
  const hintedDefinition = hint.definition;
  const hintedInvocation = hint.invocation ?? exactBindingSource(binding, expectedInvocation);
  if (hintedDefinition && !sameSourceRef(hintedDefinition, expectedDefinition)) {
    return refusedBoundary(
      'component-boundary-definition-stale',
      'The boundary definition no longer matches the indexed source range.',
      diagnostics,
      hint
    );
  }
  if (hintedInvocation && !sameSourceRef(hintedInvocation, expectedInvocation)) {
    return refusedBoundary(
      'component-boundary-invocation-stale',
      'The boundary invocation no longer matches the indexed source range.',
      diagnostics,
      hint
    );
  }

  const hostNodeIds = uniqueNodeIds(hint.hostNodeIds);
  if (hostNodeIds.length === 0) {
    return refusedBoundary(
      'component-boundary-no-host',
      'The component has no proven host nodes in the current preview.',
      diagnostics,
      hint
    );
  }
  if (hostNodeIds.some((nodeId) => !Number.isInteger(nodeId) || nodeId < 0)) {
    return refusedBoundary(
      'component-boundary-invalid-host',
      'The component boundary contains an invalid host node id.',
      diagnostics,
      hint
    );
  }
  if (treeNodeIds && hostNodeIds.some((nodeId) => !treeNodeIds.has(nodeId))) {
    return refusedBoundary(
      'component-boundary-host-not-in-tree',
      'The component boundary references a host node outside the current DOM tree.',
      diagnostics,
      hint
    );
  }

  return {
    status: 'valid',
    boundary: {
      key: hint.key?.trim() || instanceId,
      componentId,
      instanceId,
      name: indexedComponent.name,
      confidence: 'exact',
      hostNodeIds,
      definition: expectedDefinition,
      invocation: expectedInvocation,
      indexRevision: index.revision,
    },
    diagnostics,
  };
}

/**
 * Project a raw Element Tree and all runtime boundary hints in one pure
 * batch. No filesystem, DOM, adapter, or framework code is touched here.
 *
 * Outside focus, exact component rows are opaque (`children: []`). A focus
 * session expands its current boundary and every exact ancestor, allowing a
 * nested component to remain visible as an opaque row until it is focused.
 */
export function projectComponentTree(input: ComponentTreeProjectionInput): ComponentTreeProjection {
  const diagnostics: ComponentDiagnostic[] = [];
  const normalizedRoot = input.tree ? normalizeNode(input.tree) : null;
  if (!normalizedRoot) {
    diagnostics.push(EMPTY_ROOT_DIAGNOSTIC);
    return emptyProjection(input.index, input.truncated, diagnostics);
  }

  const locations = collectLocations(normalizedRoot, diagnostics);
  const nodeIds = new Set(locations.keys());
  const hints = input.boundaries ?? input.bindings ?? [];
  const indexedBoundaries: IndexedBoundary[] = [];
  const blockedHostIds = new Set<number>();

  // An ambiguous claim sharing a host with an exact claim makes the complete
  // host association unsafe. A source-anchored definition frame is expected
  // in a React owner chain next to an exact invocation frame, so it must not
  // veto the stronger, independently validated claim.
  for (const hint of hints) {
    if (hint.confidence === 'ambiguous' || hint.binding?.confidence === 'ambiguous') {
      for (const hostNodeId of uniqueNodeIds(hint.hostNodeIds)) blockedHostIds.add(hostNodeId);
    }
  }

  const seenInstanceIds = new Map<string, ComponentBoundaryHint>();
  for (const hint of hints) {
    const validation = validateComponentBoundary(hint, input.index, nodeIds);
    diagnostics.push(...validation.diagnostics);
    if (validation.status !== 'valid' || !validation.boundary) continue;
    const boundary = validation.boundary;
    const previous = seenInstanceIds.get(boundary.instanceId);
    if (previous) {
      diagnostics.push({
        code: 'component-boundary-duplicate-instance',
        severity: 'warning',
        message: 'More than one host mapping was supplied for the same component invocation.',
      });
      for (const hostNodeId of boundary.hostNodeIds) blockedHostIds.add(hostNodeId);
      continue;
    }
    seenInstanceIds.set(boundary.instanceId, hint);
    if (boundary.hostNodeIds.some((nodeId) => blockedHostIds.has(nodeId))) {
      diagnostics.push({
        code: 'component-boundary-ambiguous-host',
        severity: 'warning',
        message: 'The component host is also claimed by an unproven or ambiguous boundary.',
      });
      continue;
    }
    const rootNodeIds = boundary.hostNodeIds.filter((nodeId) => {
      const location = locations.get(nodeId);
      return (
        !!location &&
        !boundary.hostNodeIds.some(
          (otherNodeId) => otherNodeId !== nodeId && isDescendant(nodeId, otherNodeId, locations)
        )
      );
    });
    if (rootNodeIds.length !== boundary.hostNodeIds.length) {
      diagnostics.push({
        code: 'component-boundary-overlapping-roots',
        severity: 'warning',
        message: 'A multi-root component boundary contains nested host roots and was refused.',
      });
      continue;
    }
    const primaryRootId = rootNodeIds.reduce((best, nodeId) =>
      (locations.get(nodeId)?.order ?? Number.MAX_SAFE_INTEGER) <
      (locations.get(best)?.order ?? Number.MAX_SAFE_INTEGER)
        ? nodeId
        : best
    );
    indexedBoundaries.push({ ...boundary, rootNodeIds, primaryRootId });
  }

  const byHostId = new Map<number, IndexedBoundary>();
  const blockedBoundaryKeys = new Set<string>();
  for (const boundary of indexedBoundaries) {
    let conflict = false;
    for (const hostNodeId of boundary.hostNodeIds) {
      const previous = byHostId.get(hostNodeId);
      if (previous && previous.instanceId !== boundary.instanceId) {
        blockedBoundaryKeys.add(previous.key);
        blockedBoundaryKeys.add(boundary.key);
        conflict = true;
        diagnostics.push({
          code: 'component-boundary-conflicting-host',
          severity: 'warning',
          message: 'Two exact component boundaries claim the same rendered host node.',
        });
      }
      byHostId.set(hostNodeId, boundary);
    }
    if (conflict) blockedBoundaryKeys.add(boundary.key);
  }

  const boundaries = indexedBoundaries.filter((boundary) => !blockedBoundaryKeys.has(boundary.key));
  const activeFocus = resolveProjectionFocus(input.focus, input.index, boundaries, diagnostics);
  const focusIds = new Set(
    activeFocus
      ? [activeFocus.instanceId, ...activeFocus.ancestry.map((level) => level.instanceId)]
      : []
  );
  const visibleBoundaries = new Map<string, IndexedBoundary>();
  for (const boundary of boundaries) visibleBoundaries.set(boundary.instanceId, boundary);
  const boundaryByPrimaryRoot = new Map<number, IndexedBoundary>();
  const secondaryRoots = new Set<number>();
  for (const boundary of boundaries) {
    boundaryByPrimaryRoot.set(boundary.primaryRootId, boundary);
    for (const rootNodeId of boundary.rootNodeIds) {
      if (rootNodeId !== boundary.primaryRootId) secondaryRoots.add(rootNodeId);
    }
  }

  const renderChildren = (nodes: readonly NormalizedElement[]): ComponentAwareTreeNode[] => {
    const rendered: ComponentAwareTreeNode[] = [];
    for (const node of nodes) {
      if (secondaryRoots.has(node.id)) continue;
      const boundary = boundaryByPrimaryRoot.get(node.id);
      if (boundary) {
        rendered.push(renderBoundary(boundary));
        continue;
      }
      rendered.push({
        kind: 'element',
        nodeId: node.id,
        tag: node.tag,
        className: node.className,
        text: node.text,
        children: renderChildren(node.children),
      });
    }
    return rendered;
  };

  const renderBoundary = (boundary: IndexedBoundary): ComponentAwareTreeNode => {
    const expanded = focusIds.has(boundary.instanceId);
    const children = expanded
      ? renderChildren(
          boundary.rootNodeIds.flatMap(
            (rootNodeId) => locations.get(rootNodeId)?.node.children ?? []
          )
        )
      : [];
    return {
      kind: 'component',
      key: boundary.key,
      componentId: boundary.componentId,
      instanceId: boundary.instanceId,
      name: boundary.name,
      confidence: 'exact',
      hostNodeIds: [...boundary.hostNodeIds],
      definition: boundary.definition,
      invocation: boundary.invocation,
      children,
    };
  };

  // `visibleBoundaries` is intentionally materialized above even though the
  // renderer is keyed by root. It makes the invariant explicit and catches a
  // malformed focus ancestry without ever projecting an unknown instance.
  for (const instanceId of focusIds) {
    if (instanceId && !visibleBoundaries.has(instanceId)) {
      diagnostics.push({
        code: 'component-focus-boundary-not-visible',
        severity: 'info',
        message: 'A focused component boundary is not present in the current preview tree.',
      });
    }
  }

  const tree = {
    kind: 'element' as const,
    nodeId: normalizedRoot.id,
    tag: normalizedRoot.tag,
    className: normalizedRoot.className,
    text: normalizedRoot.text,
    children: renderChildren(normalizedRoot.children),
  } satisfies ComponentAwareTreeNode;
  return {
    tree,
    root: tree,
    revision: input.index.revision,
    truncated: !!input.truncated,
    boundaries: boundaries.map(stripInternalBoundary),
    diagnostics,
  };
}

/** Alias with an explicit batch-oriented name for worker/bridge callers. */
export const projectComponentTreeBatch = projectComponentTree;

/** Alias retained for callers that describe the operation as a projection. */
export const projectComponentAwareTree = projectComponentTree;

function normalizeNode(node: ComponentTreeNodeInput): NormalizedElement | null {
  const candidate = node as Partial<RawComponentTreeNode> &
    Partial<Extract<ComponentTreeNodeInput, { nodeId: number }>>;
  const id = 'nodeId' in node ? candidate.nodeId : candidate.id;
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) return null;
  const children = Array.isArray(candidate.children)
    ? candidate.children.flatMap((child) => {
        const normalized = normalizeNode(child);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    id,
    tag: typeof candidate.tag === 'string' ? candidate.tag : 'unknown',
    className:
      'className' in node && typeof candidate.className === 'string'
        ? candidate.className
        : typeof candidate.cls === 'string'
          ? candidate.cls
          : '',
    text: typeof candidate.text === 'string' ? candidate.text : '',
    children,
  };
}

function collectLocations(
  root: NormalizedElement,
  diagnostics: ComponentDiagnostic[]
): Map<number, NodeLocation> {
  const locations = new Map<number, NodeLocation>();
  let order = 0;
  const walk = (node: NormalizedElement, parent: NormalizedElement | null, ancestors: number[]) => {
    if (locations.has(node.id)) {
      diagnostics.push({
        code: 'component-tree-duplicate-node-id',
        severity: 'warning',
        message: 'The preview tree contains duplicate node ids; component projection is partial.',
      });
      return;
    }
    locations.set(node.id, { node, parent, order, ancestors });
    order += 1;
    const nextAncestors = [...ancestors, node.id];
    for (const child of node.children) walk(child, node, nextAncestors);
  };
  walk(root, null, []);
  return locations;
}

function resolveProjectionFocus(
  focus: ComponentFocusSession | null | undefined,
  index: ComponentIndex,
  boundaries: readonly IndexedBoundary[],
  diagnostics: ComponentDiagnostic[]
): ComponentFocusSession | null {
  if (!focus) return null;
  if (focus.indexRevision !== index.revision) {
    diagnostics.push({
      code: 'component-focus-stale-revision',
      severity: 'warning',
      message: 'Focused component editing is suspended until the current index is re-entered.',
    });
    return null;
  }
  const levels = [
    ...focus.ancestry,
    {
      componentId: focus.componentId,
      instanceId: focus.instanceId,
      name: focus.name,
      hostNodeIds: focus.hostNodeIds,
      definition: focus.definition,
      invocation: focus.invocation,
      indexRevision: focus.indexRevision,
    },
  ];
  for (const level of levels) {
    const component = index.components.find((item) => item.id === level.componentId);
    const instance = index.instances.find((item) => item.id === level.instanceId);
    const boundary = boundaries.find((item) => item.instanceId === level.instanceId);
    if (
      !component ||
      !instance ||
      instance.componentId !== component.id ||
      !boundary ||
      !sameSourceRef(level.definition, component.definition) ||
      !sameSourceRef(level.invocation, instance.invocation) ||
      !sameNodeIdSet(level.hostNodeIds, boundary.hostNodeIds)
    ) {
      diagnostics.push({
        code: 'component-focus-stale-source',
        severity: 'warning',
        message: 'Focused component source or host identity is no longer valid.',
      });
      return null;
    }
  }
  return focus;
}

function exactBindingValue<T extends 'componentId' | 'instanceId'>(
  binding: ComponentBoundaryHint['binding'],
  key: T
): T extends 'componentId' ? string | null : string | null {
  if (!binding || !('confidence' in binding) || binding.confidence !== 'exact') return null;
  return (
    key === 'componentId' ? binding.componentId : (binding.instanceId ?? null)
  ) as T extends 'componentId' ? string | null : string | null;
}

function exactBindingSource(
  binding: ComponentBoundaryHint['binding'],
  fallback: SourceRef
): SourceRef | null {
  if (!binding || binding.confidence !== 'exact') return null;
  return binding.source ?? fallback;
}

function refusedBoundary(
  code: string,
  message: string,
  existing: readonly ComponentDiagnostic[],
  hint: ComponentBoundaryHint
): ComponentBoundaryValidation {
  return {
    status: 'refused',
    diagnostics: [
      ...existing,
      {
        code,
        severity: 'warning',
        message,
        source: hint.invocation ?? hint.definition ?? undefined,
      },
    ],
  };
}

function sameSourceRef(left: SourceRef, right: SourceRef): boolean {
  return (
    left.file === right.file &&
    left.start === right.start &&
    left.end === right.end &&
    left.contentHash === right.contentHash
  );
}

function uniqueNodeIds(nodeIds: readonly number[]): number[] {
  return [...new Set(nodeIds)].filter((nodeId) => typeof nodeId === 'number');
}

function isDescendant(
  descendantId: number,
  ancestorId: number,
  locations: ReadonlyMap<number, NodeLocation>
): boolean {
  return locations.get(descendantId)?.ancestors.includes(ancestorId) ?? false;
}

function sameNodeIdSet(left: readonly number[], right: readonly number[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((nodeId) => rightSet.has(nodeId));
}

function stripInternalBoundary(boundary: IndexedBoundary): ComponentBoundary {
  return {
    key: boundary.key,
    componentId: boundary.componentId,
    instanceId: boundary.instanceId,
    name: boundary.name,
    confidence: boundary.confidence,
    hostNodeIds: [...boundary.hostNodeIds],
    definition: boundary.definition,
    invocation: boundary.invocation,
    indexRevision: boundary.indexRevision,
  };
}

function emptyProjection(
  index: ComponentIndex,
  truncated: boolean | undefined,
  diagnostics: ComponentDiagnostic[]
): ComponentTreeProjection {
  return {
    tree: null,
    root: null,
    revision: index.revision,
    truncated: !!truncated,
    boundaries: [],
    diagnostics,
  };
}
