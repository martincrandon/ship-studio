/**
 * Element tree (read-only navigator) for the visual editor.
 *
 * Talks to the proxy-injected select script over the same postMessage
 * protocol the editor uses: requests a lightweight DOM snapshot
 * (`ss:requestTree` → `ss:tree`), refetches when the page mutates
 * (`ss:treeDirty`, debounced iframe-side), and selects/hovers elements by
 * ephemeral node id (`ss:selectNode` / `ss:hoverNode`). Selecting a node runs
 * the exact same selection path as clicking it on the canvas, so the edit
 * panel populates identically; canvas clicks carry a `nodeId` back so the
 * tree row highlights in sync.
 *
 * @module hooks/useElementTree
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { usePolling } from './usePolling';
import { createReactAdapter } from '../lib/components/adapters/react';
import { projectComponentTree } from '../lib/components/component-tree';
import { normalizeRuntimeSourcePath } from '../lib/components/adapters/react-helpers';
import { collectNextServerComponentBoundaries } from '../lib/components/adapters/next-server-provenance';
import type {
  ComponentBoundary,
  ComponentBoundaryHint,
  ComponentId,
  ComponentIndex,
  ComponentInstanceId,
  ComponentAwareTreeNode as IndexedComponentAwareTreeNode,
  ComponentFocusSession,
  RawComponentTreeNode,
  RuntimeSourceFrame,
  SourceRef,
} from '../lib/components/types';

/** A bounded, development-only React owner hint from the preview bridge.
 *
 * These values are deliberately kept separate from component identity. The
 * component index must validate them before a component boundary is projected
 * into the tree or a component write is enabled.
 */
export interface RuntimeOwnerHint {
  renderer: 'react';
  file: string | null;
  line: number | null;
  column: number | null;
  symbolHint: string | null;
  runtimeKey: string | null;
}

/** A component boundary already validated by the component index. */
export interface ComponentTreeNode {
  kind: 'component';
  key: string;
  componentId: ComponentId;
  instanceId: ComponentInstanceId;
  name: string;
  confidence: 'exact';
  hostNodeIds: number[];
  definition: SourceRef;
  invocation: SourceRef;
  children: ComponentAwareTreeNode[];
}

/** The identity-only payload needed to repaint/focus a validated boundary. */
export type ComponentFocusRequest = Pick<
  ComponentTreeNode,
  'key' | 'componentId' | 'instanceId' | 'confidence' | 'hostNodeIds' | 'name'
>;

/** One element in the raw snapshot, mapped from the compact wire format. */
export interface ElementTreeNode {
  /** Omitted by legacy callers; mapped wire nodes always set this discriminator. */
  kind?: 'element';
  id: number;
  tag: string;
  /** The element's class attribute (truncated iframe-side). */
  cls: string;
  /** The authored HTML id, when the preview bridge can provide one. */
  idAttr?: string;
  /** Direct text content snippet (children's text not included). */
  text: string;
  /** Runtime data is a bounded hint, never a component identity claim. */
  ownerHints?: RuntimeOwnerHint[];
  runtimeKey?: string | null;
  children: ComponentAwareTreeNode[];
}

/** A tree projection may replace validated component boundaries with virtual rows. */
export type ComponentAwareTreeNode = ElementTreeNode | ComponentTreeNode;

export interface SelectedComponent {
  key: string;
  componentId?: ComponentId;
  instanceId?: ComponentInstanceId;
  name?: string;
  hostNodeIds: number[];
  confidence: 'exact';
  rect: SelectionRect | null;
}

export interface SelectionRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface WireNode {
  i: number;
  t: string;
  c: string;
  x: string;
  k: WireNode[];
  /** Authored HTML id, when present. */
  a?: string;
  /** Bounded React owner-chain hints; the preview never treats these as authority. */
  o?: WireOwnerHint[];
  /** The current host fiber key, when React exposes one in development mode. */
  r?: string | null;
}

interface WireOwnerHint {
  renderer?: unknown;
  file?: unknown;
  line?: unknown;
  column?: unknown;
  symbolHint?: unknown;
  runtimeKey?: unknown;
}

const RUNTIME_HINT_CAP = 8;
const RUNTIME_STRING_CAP = 240;
const reactRuntimeAdapter = createReactAdapter();

function boundedString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, RUNTIME_STRING_CAP) : null;
}

function boundedNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function mapSelectionRect(value: unknown): SelectionRect | null {
  if (!value || typeof value !== 'object') return null;
  const rect = value as Record<string, unknown>;
  const numbers = ['top', 'left', 'width', 'height'].map((key) => rect[key]);
  if (numbers.some((number) => typeof number !== 'number' || !Number.isFinite(number))) {
    return null;
  }
  return {
    top: numbers[0] as number,
    left: numbers[1] as number,
    width: Math.max(0, numbers[2] as number),
    height: Math.max(0, numbers[3] as number),
  };
}

function sameNodeIds(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function mapOwnerHint(hint: WireOwnerHint): RuntimeOwnerHint | null {
  if (hint.renderer !== 'react' && hint.renderer !== undefined) return null;
  const file = boundedString(hint.file);
  const line = boundedNumber(hint.line);
  const column = boundedNumber(hint.column);
  const symbolHint = boundedString(hint.symbolHint);
  const runtimeKey = boundedString(hint.runtimeKey);
  if (!file && !line && !column && !symbolHint && !runtimeKey) return null;
  return { renderer: 'react', file, line, column, symbolHint, runtimeKey };
}

function mapNode(n: WireNode): ElementTreeNode {
  const ownerHints = Array.isArray(n.o)
    ? n.o.slice(0, RUNTIME_HINT_CAP).flatMap((hint) => {
        const mapped = mapOwnerHint(hint);
        return mapped ? [mapped] : [];
      })
    : [];
  const runtimeKey = boundedString(n.r) ?? ownerHints[0]?.runtimeKey ?? null;
  const node: ElementTreeNode = {
    id: n.i,
    tag: n.t,
    cls: n.c,
    text: n.x,
    children: (n.k ?? []).map(mapNode),
  };
  // Keep the legacy raw-tree shape compact when the preview cannot provide
  // React development metadata. The optional fields are only meaningful when
  // a runtime hint was actually returned.
  if (ownerHints.length) node.ownerHints = ownerHints;
  const idAttr = boundedString(n.a);
  if (idAttr) node.idAttr = idAttr;
  if (runtimeKey) node.runtimeKey = runtimeKey;
  return node;
}

interface UseElementTreeParams {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  /** Fetch + track the tree only while the navigator is visible. */
  enabled: boolean;
  /** Current source index used to validate runtime owner hints. */
  componentIndex?: ComponentIndex | null;
  /** Absolute project path used to normalize development source URLs. */
  projectPath?: string;
  /** Revision-bound focus state; only exact boundaries can expand. */
  componentFocus?: ComponentFocusSession | null;
}

function sourceHashForFile(index: ComponentIndex, file: string): string | null {
  return (
    index.instances.find((instance) => instance.invocation.file === file)?.invocation.contentHash ??
    index.components.find((component) => component.definition.file === file)?.definition
      .contentHash ??
    null
  );
}

function toRawTree(node: ElementTreeNode): RawComponentTreeNode {
  return {
    id: node.id,
    tag: node.tag,
    cls: node.cls,
    text: node.text,
    idAttr: node.idAttr,
    children: node.children
      .filter((child): child is ElementTreeNode => child.kind !== 'component')
      .map(toRawTree),
  };
}

function projectedNode(node: IndexedComponentAwareTreeNode): ComponentAwareTreeNode {
  if (node.kind === 'component') {
    return {
      kind: 'component',
      key: node.key,
      componentId: node.componentId,
      instanceId: node.instanceId,
      name: node.name,
      confidence: node.confidence,
      hostNodeIds: [...node.hostNodeIds],
      definition: node.definition,
      invocation: node.invocation,
      children: node.children.map(projectedNode),
    };
  }
  return {
    kind: 'element',
    id: node.nodeId,
    tag: node.tag,
    cls: node.className,
    text: node.text,
    children: node.children.map(projectedNode),
  };
}

function componentNodeFromBoundary(boundary: ComponentBoundary): ComponentTreeNode {
  return {
    kind: 'component',
    key: boundary.key,
    componentId: boundary.componentId,
    instanceId: boundary.instanceId,
    name: boundary.name,
    confidence: boundary.confidence,
    hostNodeIds: [...boundary.hostNodeIds],
    definition: boundary.definition,
    invocation: boundary.invocation,
    children: [],
  };
}

function collectBoundaryHints(
  root: ElementTreeNode,
  index: ComponentIndex,
  projectPath: string
): ComponentBoundaryHint[] {
  const exactByInstance = new Map<string, ComponentBoundaryHint>();
  const unproven: ComponentBoundaryHint[] = [];
  const parentByNodeId = new Map<number, number | null>();
  const walk = (node: ElementTreeNode) => {
    if (!parentByNodeId.has(node.id)) parentByNodeId.set(node.id, null);
    for (const owner of node.ownerHints ?? []) {
      if (!owner.file || !owner.line) continue;
      const file = normalizeRuntimeSourcePath(owner.file, projectPath, index.profile.workspaceRoot);
      const sourceHash = sourceHashForFile(index, file);
      const candidate: RuntimeSourceFrame = {
        renderer: owner.renderer,
        file,
        line: owner.line,
        column: owner.column ?? 1,
        symbolHint: owner.symbolHint,
        runtimeKey: owner.runtimeKey,
      };
      const binding = reactRuntimeAdapter.bindSelection(
        { candidates: [candidate], sourceHash },
        index
      );
      if (binding.confidence === 'exact' && binding.componentId && binding.instanceId) {
        const existing = exactByInstance.get(binding.instanceId);
        if (existing) {
          existing.hostNodeIds = [...new Set([...existing.hostNodeIds, node.id])];
        } else {
          exactByInstance.set(binding.instanceId, {
            key: binding.instanceId,
            componentId: binding.componentId,
            instanceId: binding.instanceId,
            confidence: 'exact',
            hostNodeIds: [node.id],
            binding,
            indexRevision: index.revision,
          });
        }
      } else if (binding.confidence === 'sourceAnchored' || binding.confidence === 'ambiguous') {
        // An unproven claim blocks an exact claim on the same host. This is
        // deliberately conservative: a partially-known runtime owner chain
        // must never hide DOM children by accident.
        unproven.push({
          confidence: binding.confidence,
          hostNodeIds: [node.id],
          binding,
          indexRevision: index.revision,
        });
      }
    }
    for (const child of node.children) {
      if (child.kind !== 'component') {
        if (!parentByNodeId.has(child.id)) parentByNodeId.set(child.id, node.id);
        walk(child);
      }
    }
  };
  walk(root);
  const rootHosts = (hostNodeIds: readonly number[]) => {
    const hostSet = new Set(hostNodeIds);
    return hostNodeIds.filter((nodeId) => {
      let parent = parentByNodeId.get(nodeId) ?? null;
      while (parent !== null) {
        if (hostSet.has(parent)) return false;
        parent = parentByNodeId.get(parent) ?? null;
      }
      return true;
    });
  };
  return [
    ...Array.from(exactByInstance.values(), (boundary) => ({
      ...boundary,
      hostNodeIds: rootHosts(boundary.hostNodeIds),
    })),
    ...unproven,
  ];
}

function componentSelectionColor(): string {
  if (typeof document === 'undefined') return '';
  const styles = getComputedStyle(document.documentElement);
  return (
    styles.getPropertyValue('--color-green-700').trim() ||
    styles.getPropertyValue('--accent-component').trim() ||
    styles.getPropertyValue('--accent-active').trim()
  );
}

export function useElementTree({
  iframeRef,
  enabled,
  componentIndex = null,
  projectPath = '.',
  componentFocus = null,
}: UseElementTreeParams) {
  const [tree, setTree] = useState<ElementTreeNode | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [affectedIds, setAffectedIds] = useState<number[]>([]);
  /** A request is out and the iframe hasn't answered with a snapshot yet. */
  const [awaitingTree, setAwaitingTree] = useState(enabled);
  // Re-opening the navigator always refetches — the page has moved on since the
  // snapshot we're holding. Adjusted during render rather than in an effect so the
  // first request goes out in the same commit the panel becomes visible.
  const [wasEnabled, setWasEnabled] = useState(enabled);
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    if (enabled) setAwaitingTree(true);
  }
  const [selectionKind, setSelectionKind] = useState<'element' | 'component'>('element');
  const [selectedComponent, setSelectedComponent] = useState<SelectedComponent | null>(null);
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const [componentFocusCandidateId, setComponentFocusCandidateId] = useState<number | null>(null);
  const [hoverCandidateSeen, setHoverCandidateSeen] = useState(false);
  const [hoverCandidateNodeId, setHoverCandidateNodeId] = useState<number | null>(null);
  const projectionRef = useRef<ReturnType<typeof projectComponentTree> | null>(null);

  const post = useCallback(
    (msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, '*'),
    [iframeRef]
  );

  /** Ask for a snapshot: the poll below owns the actual posting, so a request that
   *  goes unanswered is retried on one schedule instead of several. */
  const requestTree = useCallback(() => setAwaitingTree(true), []);

  // The injected script may not be listening yet (first paint, a full HMR reload),
  // so a request can land before anyone can answer it. Retry until a snapshot
  // arrives — every unanswered attempt backs the interval off (0.5s → 4s) instead
  // of hammering the iframe at a fixed 500ms for as long as the panel is open.
  usePolling(
    () => {
      post({ type: 'ss:requestTree' });
      // Rejecting is what drives the backoff: the request is only "answered" by an
      // `ss:tree` message, which stops the poll by clearing `awaitingTree`.
      return Promise.reject(new Error('No element tree snapshot yet'));
    },
    {
      intervalMs: 500,
      maxIntervalMs: 4000,
      enabled: enabled && awaitingTree,
      name: 'elementTree',
    }
  );

  useEffect(() => {
    if (!enabled) return;

    const onMessage = (e: MessageEvent) => {
      // SECURITY: only trust messages from the actual preview iframe (untrusted
      // project content runs inside it).
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as
        | {
            type?: string;
            tree?: WireNode;
            truncated?: boolean;
            nodeId?: number;
            affectedNodeIds?: number[];
            selectionKind?: 'element' | 'component';
            rect?: unknown;
            focusCandidateNodeId?: unknown;
            hoverCandidateNodeId?: unknown;
            component?: {
              key?: unknown;
              componentId?: unknown;
              instanceId?: unknown;
              name?: unknown;
              confidence?: unknown;
              hostNodeIds?: unknown;
            };
          }
        | undefined;
      if (!d || typeof d.type !== 'string') return;
      if (d.type === 'ss:tree' && d.tree) {
        setAwaitingTree(false);
        setTree(mapNode(d.tree));
        setTruncated(!!d.truncated);
      } else if (d.type === 'ss:treeDirty') {
        requestTree();
      } else if (d.type === 'ss:selRect') {
        const rect = mapSelectionRect(d.rect);
        setSelectionRect(rect);
        setSelectedComponent((current) => (current ? { ...current, rect } : current));
      } else if (d.type === 'ss:select') {
        setSelectedId(typeof d.nodeId === 'number' ? d.nodeId : null);
        const rect = mapSelectionRect(d.rect);
        setSelectionRect(rect);
        setAffectedIds(
          Array.isArray(d.affectedNodeIds)
            ? d.affectedNodeIds.filter(
                (id): id is number => typeof id === 'number' && Number.isInteger(id) && id >= 0
              )
            : []
        );
        const component = d.component;
        const hostNodeIds = Array.isArray(component?.hostNodeIds)
          ? component.hostNodeIds.filter(
              (id): id is number => typeof id === 'number' && Number.isInteger(id) && id >= 0
            )
          : [];
        const boundary =
          d.selectionKind === 'component' && typeof component?.key === 'string'
            ? projectionRef.current?.boundaries.find(
                (candidate) =>
                  candidate.key === component.key &&
                  component.componentId === candidate.componentId &&
                  component.instanceId === candidate.instanceId &&
                  sameNodeIds(hostNodeIds, candidate.hostNodeIds)
              )
            : null;
        if (boundary && component?.confidence === 'exact') {
          setSelectionKind('component');
          setSelectedComponent({
            key: boundary.key,
            componentId: boundary.componentId,
            instanceId: boundary.instanceId,
            name: boundary.name,
            hostNodeIds: [...boundary.hostNodeIds],
            confidence: 'exact',
            rect,
          });
        } else {
          setSelectionKind('element');
          setSelectedComponent(null);
        }
      } else if (d.type === 'ss:componentFocusCandidate') {
        setComponentFocusCandidateId(
          typeof d.focusCandidateNodeId === 'number' &&
            Number.isInteger(d.focusCandidateNodeId) &&
            d.focusCandidateNodeId >= 0
            ? d.focusCandidateNodeId
            : null
        );
      } else if (d.type === 'ss:hoverCandidate') {
        setHoverCandidateSeen(true);
        setHoverCandidateNodeId(
          typeof d.hoverCandidateNodeId === 'number' &&
            Number.isInteger(d.hoverCandidateNodeId) &&
            d.hoverCandidateNodeId >= 0
            ? d.hoverCandidateNodeId
            : null
        );
      }
    };
    window.addEventListener('message', onMessage);

    // A full page reload re-initializes the injected script (treeOn resets),
    // so re-request on iframe load to keep the navigator alive across HMR
    // full-reloads and manual refreshes.
    const iframe = iframeRef.current;
    const onLoad = () => requestTree();
    iframe?.addEventListener('load', onLoad);

    return () => {
      post({ type: 'ss:treeOff' });
      window.removeEventListener('message', onMessage);
      iframe?.removeEventListener('load', onLoad);
    };
  }, [enabled, post, requestTree, iframeRef]);

  const selectNode = useCallback(
    (id: number) => {
      setSelectionKind('element');
      setSelectedComponent(null);
      setSelectedId(id);
      post({ type: 'ss:selectNode', id });
    },
    [post]
  );
  const hoverNode = useCallback((id: number | null) => post({ type: 'ss:hoverNode', id }), [post]);
  const selectComponent = useCallback(
    (node: ComponentTreeNode) => {
      setSelectionKind('component');
      setSelectedComponent({
        key: node.key,
        componentId: node.componentId,
        instanceId: node.instanceId,
        name: node.name,
        hostNodeIds: [...node.hostNodeIds],
        confidence: node.confidence,
        rect: null,
      });
      post({
        type: 'ss:selectComponent',
        key: node.key,
        componentId: node.componentId,
        instanceId: node.instanceId,
        name: node.name,
        confidence: node.confidence,
        hostNodeIds: node.hostNodeIds,
        color: componentSelectionColor(),
      });
    },
    [post]
  );
  const hoverComponent = useCallback(
    (node: ComponentTreeNode | null) =>
      post(
        node
          ? {
              type: 'ss:hoverComponent',
              key: node.key,
              hostNodeIds: node.hostNodeIds,
              color: componentSelectionColor(),
            }
          : { type: 'ss:hoverComponent', hostNodeIds: [], color: componentSelectionColor() }
      ),
    [post]
  );
  const requestComponentFocus = useCallback(
    (node: ComponentFocusRequest) =>
      post({
        type: 'ss:componentFocusRequest',
        key: node.key,
        componentId: node.componentId,
        instanceId: node.instanceId,
        confidence: node.confidence,
        name: node.name,
        hostNodeIds: node.hostNodeIds,
        color: componentSelectionColor(),
      }),
    [post]
  );
  const clearComponentFocus = useCallback(
    () => post({ type: 'ss:componentFocusExit', color: componentSelectionColor() }),
    [post]
  );
  const clearComponentFocusCandidate = useCallback(() => {
    setComponentFocusCandidateId(null);
  }, []);

  const projection = useMemo(() => {
    if (!tree || !componentIndex) return null;
    const runtimeBoundaries = collectBoundaryHints(tree, componentIndex, projectPath);
    const runtimeExactInstances = new Set(
      runtimeBoundaries.flatMap((boundary) =>
        boundary.confidence === 'exact' && boundary.instanceId ? [boundary.instanceId] : []
      )
    );
    return projectComponentTree({
      tree: toRawTree(tree),
      boundaries: [
        ...runtimeBoundaries,
        ...collectNextServerComponentBoundaries(toRawTree(tree), componentIndex, {
          excludedInstanceIds: runtimeExactInstances,
        }),
      ],
      index: componentIndex,
      focus: componentFocus,
      truncated,
    });
  }, [componentFocus, componentIndex, projectPath, truncated, tree]);
  useEffect(() => {
    projectionRef.current = projection;
  }, [projection]);

  // A canvas click still travels through the legacy `ss:select` path. If its
  // primary host is one of the already-validated boundary roots, promote that
  // selection back to the same semantic component state used by the tree.
  const projectedSelectedComponent = useMemo<SelectedComponent | null>(() => {
    if (selectionKind !== 'element' || selectedId == null || !projection) return null;
    const boundary = projection.boundaries.find((candidate) =>
      candidate.hostNodeIds.includes(selectedId)
    );
    if (!boundary) return null;
    return {
      key: boundary.key,
      componentId: boundary.componentId,
      instanceId: boundary.instanceId,
      name: boundary.name,
      hostNodeIds: [...boundary.hostNodeIds],
      confidence: 'exact',
      rect: selectionRect,
    };
  }, [projection, selectedId, selectionKind, selectionRect]);

  // Repaint a validated canvas selection with the component treatment. The
  // proxy cannot decide this from React internals alone, so this message is
  // sent only after the host-side projection has proven the boundary.
  useEffect(() => {
    if (!enabled || !projectedSelectedComponent) return;
    post({
      type: 'ss:selectComponent',
      key: projectedSelectedComponent.key,
      componentId: projectedSelectedComponent.componentId,
      instanceId: projectedSelectedComponent.instanceId,
      name: projectedSelectedComponent.name,
      confidence: projectedSelectedComponent.confidence,
      hostNodeIds: projectedSelectedComponent.hostNodeIds,
      color: componentSelectionColor(),
    });
  }, [enabled, post, projectedSelectedComponent]);

  const effectiveSelectedComponent = selectedComponent ?? projectedSelectedComponent;
  const componentFocusCandidate = useMemo(() => {
    if (componentFocusCandidateId == null || !projection) return null;
    const boundary = projection.boundaries.find((candidate) =>
      candidate.hostNodeIds.includes(componentFocusCandidateId)
    );
    return boundary ? componentNodeFromBoundary(boundary) : null;
  }, [componentFocusCandidateId, projection]);
  const hoveredComponent = useMemo(() => {
    if (!hoverCandidateSeen || hoverCandidateNodeId == null || !projection) return null;
    const boundary = projection.boundaries.find((candidate) =>
      candidate.hostNodeIds.includes(hoverCandidateNodeId)
    );
    return boundary ? componentNodeFromBoundary(boundary) : null;
  }, [hoverCandidateNodeId, hoverCandidateSeen, projection]);

  useEffect(() => {
    if (!enabled || !hoverCandidateSeen) return;
    hoverComponent(hoveredComponent);
  }, [enabled, hoverCandidateSeen, hoveredComponent, hoverComponent]);

  // Stale data is kept while disabled (cheap) but never exposed.
  return {
    tree: enabled ? tree : null,
    componentTree: enabled && projection?.tree ? projectedNode(projection.tree) : null,
    componentTreeDiagnostics: enabled && projection ? projection.diagnostics : [],
    componentBoundaries: enabled && projection ? projection.boundaries : [],
    truncated,
    selectedId: enabled ? selectedId : null,
    affectedIds: enabled ? affectedIds : [],
    selectionKind: enabled && effectiveSelectedComponent ? 'component' : 'element',
    selectedComponent: enabled ? effectiveSelectedComponent : null,
    componentFocusCandidate: enabled ? componentFocusCandidate : null,
    selectNode,
    hoverNode,
    selectComponent,
    hoverComponent,
    requestComponentFocus,
    clearComponentFocus,
    clearComponentFocusCandidate,
  };
}
