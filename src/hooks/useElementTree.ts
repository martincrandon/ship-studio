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
import {
  boundInspectionMessage,
  createInspectionTransport,
  type InspectionSurfaceTransport,
  type InspectionSignature,
  type InspectionWireNode,
} from '../lib/components/inspection-transport';
import type { EditableSurfaceTarget } from '../lib/components/editable-surface';
import type { ElementSignature } from '../lib/edit';
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
export interface ComponentSlotTreeNode {
  kind: 'slot';
  key: string;
  componentId: ComponentId;
  instanceId: ComponentInstanceId;
  slotName: string;
  required: boolean;
  sourceAvailable: boolean;
  childInstanceIds: ComponentInstanceId[];
  children: ComponentAwareTreeNode[];
}
export type ComponentAwareTreeNode = ElementTreeNode | ComponentTreeNode | ComponentSlotTreeNode;

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

/** Selection parity payload shared by the Elements panel and component canvas. */
export interface ElementTreeSelection {
  id: number | null;
  signature: ElementSignature | null;
  rect: SelectionRect | null;
  count: number;
}

type WireNode = InspectionWireNode;

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
const MAX_CANCELLED_SELECTION_REQUESTS = 16;
const reactRuntimeAdapter = createReactAdapter();

function createSelectionRequestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `selection-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

function rememberCancelledSelectionRequest(requests: Set<string>, requestId: string): void {
  requests.add(requestId);
  while (requests.size > MAX_CANCELLED_SELECTION_REQUESTS) {
    const oldest = requests.values().next().value;
    if (typeof oldest !== 'string') return;
    requests.delete(oldest);
  }
}

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

function mapInspectionSignature(
  signature: InspectionSignature | undefined
): ElementSignature | null {
  if (!signature) return null;
  return {
    tagName: signature.tagName,
    className: signature.className,
    ancestorClasses: [...signature.ancestorClasses],
    ...(signature.text ? { text: signature.text } : {}),
    ...(signature.sourceFile ? { sourceFile: signature.sourceFile } : {}),
    ...(signature.sourceLine !== undefined ? { sourceLine: signature.sourceLine } : {}),
    ...(signature.sourceColumn !== undefined ? { sourceColumn: signature.sourceColumn } : {}),
    ...(signature.domPath ? { domPath: signature.domPath } : {}),
  };
}

function sameNodeIds(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

/**
 * Stable identity for an authenticated element selection. The renderer may
 * acknowledge a tree `ss:reselect` with another `ss:select`; that acknowledgement
 * must not look like a new user selection to the workspace owner. Include the
 * bounded DOM/source identity rather than object identity so a new wire payload
 * for the same element can be recognised across the two message handlers.
 */
function selectionIdentity(id: number | null, signature: ElementSignature | null): string {
  return JSON.stringify([
    id,
    signature?.tagName ?? null,
    signature?.className ?? null,
    signature?.ancestorClasses ?? [],
    signature?.text ?? null,
    signature?.sourceFile ?? null,
    signature?.sourceLine ?? null,
    signature?.sourceColumn ?? null,
    signature?.domPath ?? null,
  ]);
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
  /** Explicit negotiated frame surface; null means Components has no frame. */
  surfaceTarget?: EditableSurfaceTarget | null;
  /** Optional owner supplied by a workspace-level Elements panel. */
  inspectionTransport?: InspectionSurfaceTransport | null;
  /** Current source index used to validate runtime owner hints. */
  componentIndex?: ComponentIndex | null;
  /** Absolute project path used to normalize development source URLs. */
  projectPath?: string;
  /** Revision-bound focus state; only exact boundaries can expand. */
  componentFocus?: ComponentFocusSession | null;
  /** Notifies an owning component inspector of direct/tree descendant selection. */
  onSelectionChange?: (selection: ElementTreeSelection | null) => void;
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
      .filter(
        (child): child is ElementTreeNode => child.kind !== 'component' && child.kind !== 'slot'
      )
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
  if (node.kind === 'slot') {
    return {
      kind: 'slot',
      key: node.key,
      componentId: node.componentId,
      instanceId: node.instanceId,
      slotName: node.slotName,
      required: node.required,
      sourceAvailable: node.sourceAvailable,
      childInstanceIds: [...node.childInstanceIds],
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
      if (child.kind !== 'component' && child.kind !== 'slot') {
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
  surfaceTarget,
  inspectionTransport = null,
  componentIndex = null,
  projectPath = '.',
  componentFocus = null,
  onSelectionChange,
}: UseElementTreeParams) {
  const transport = useMemo(
    () =>
      inspectionTransport ??
      createInspectionTransport({
        iframeRef,
        surfaceTarget,
      }),
    [iframeRef, inspectionTransport, surfaceTarget]
  );
  const surfaceActive = enabled && transport.active;
  const [tree, setTree] = useState<ElementTreeNode | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [affectedIds, setAffectedIds] = useState<number[]>([]);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  /** A request is out and the iframe hasn't answered with a snapshot yet. */
  const [awaitingTree, setAwaitingTree] = useState(surfaceActive);
  // A tree/selection message is an authenticated proof that this negotiated
  // surface is inspectable. Keep the proof keyed to the current transport so
  // a response from a previous frame can never make a replacement frame look
  // ready.
  const [inspectionReadyRevisionKey, setInspectionReadyRevisionKey] = useState<string | null>(
    null
  );
  // Re-opening the navigator always refetches — the page has moved on since the
  // snapshot we're holding. Adjusted during render rather than in an effect so the
  // first request goes out in the same commit the panel becomes visible.
  const [wasEnabled, setWasEnabled] = useState(enabled);
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    if (enabled) {
      setTree(null);
      setTruncated(false);
      setSelectedId(null);
      setAffectedIds([]);
      setAwaitingTree(true);
      setHoveredId(null);
      setInspectionReadyRevisionKey(null);
    } else {
      setAwaitingTree(false);
      setInspectionReadyRevisionKey(null);
    }
  }
  const [selectionKind, setSelectionKind] = useState<'element' | 'component'>('element');
  const [selectedComponent, setSelectedComponent] = useState<SelectedComponent | null>(null);
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const [componentFocusCandidateId, setComponentFocusCandidateId] = useState<number | null>(null);
  const [hoverCandidateSeen, setHoverCandidateSeen] = useState(false);
  const [hoverCandidateNodeId, setHoverCandidateNodeId] = useState<number | null>(null);
  const [boundSurfaceRevisionKey, setBoundSurfaceRevisionKey] = useState(transport.revisionKey);
  // A tree-row click needs one selection callback even though it pre-seeds the
  // selected node id before the renderer acknowledges it. After that first
  // callback, an identical renderer acknowledgement (notably CSS `reselect`)
  // is suppressed so it cannot feed a reselect loop through the workspace.
  const pendingTreeSelectionRef = useRef<{ nodeId: number; requestId: string } | null>(null);
  // A renderer acknowledgement may arrive after a newer canvas selection. Keep
  // the superseded request ids long enough to discard those late acknowledgements
  // without suppressing a genuine selection that happens to use the old node id.
  const cancelledTreeSelectionRequestsRef = useRef(new Set<string>());
  const lastPublishedSelectionRef = useRef<string | null>(null);
  if (boundSurfaceRevisionKey !== transport.revisionKey) {
    // Clear during the first render after a frame/session switch; an old tree
    // must never flash while the replacement surface is negotiating.
    setBoundSurfaceRevisionKey(transport.revisionKey);
    setTree(null);
    setTruncated(false);
    setSelectedId(null);
    setAffectedIds([]);
    setHoveredId(null);
    setSelectionKind('element');
    setSelectedComponent(null);
    setSelectionRect(null);
    setComponentFocusCandidateId(null);
    setHoverCandidateSeen(false);
    setHoverCandidateNodeId(null);
    setAwaitingTree(surfaceActive);
    setInspectionReadyRevisionKey(null);
  }
  const projectionRef = useRef<ReturnType<typeof projectComponentTree> | null>(null);

  useEffect(() => {
    // A frame/session/revision switch is an inspection boundary even when the
    // replacement target is already present. Clear the owner synchronously
    // before the new surface can report its first selection.
    pendingTreeSelectionRef.current = null;
    cancelledTreeSelectionRequestsRef.current.clear();
    lastPublishedSelectionRef.current = null;
    onSelectionChange?.(null);
  }, [onSelectionChange, transport.revisionKey]);

  const post = useCallback((msg: unknown) => transport.post(msg), [transport]);

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
      enabled: surfaceActive && awaitingTree,
      name: 'elementTree',
    }
  );

  useEffect(() => {
    if (!surfaceActive) return;

    // A negotiated component surface is inspectable before it is writable.
    // Activation owns only the selection/hover layer; editor hooks retain the
    // separate capability and Edit-main write gate.
    if (surfaceTarget) post({ type: 'ss:activate' });

    const onMessage = (e: MessageEvent) => {
      // SECURITY: only trust messages from the actual preview iframe (untrusted
      // project content runs inside it).
      if (!transport.accepts(e)) return;
      const d = boundInspectionMessage(e.data);
      if (!d) return;
      if (d.type === 'ss:tree' && d.tree) {
        setAwaitingTree(false);
        setInspectionReadyRevisionKey(transport.revisionKey);
        setTree(mapNode(d.tree));
        setTruncated(d.truncated);
      } else if (d.type === 'ss:treeDirty') {
        requestTree();
      } else if (d.type === 'ss:hover') {
        setHoveredId(typeof d.nodeId === 'number' ? d.nodeId : null);
      } else if (d.type === 'ss:selRect') {
        const rect = mapSelectionRect(d.rect);
        setSelectionRect(rect);
        setSelectedComponent((current) => (current ? { ...current, rect } : current));
      } else if (d.type === 'ss:select') {
        // This is accepted only after the transport has authenticated the
        // current origin/session/token/generation/frame/component envelope.
        // A valid selection is therefore enough to recover inspection when a
        // host-ready event was missed, while stale/hostile messages are still
        // rejected by transport.accepts above.
        const selectionRequestId = d.selectionRequestId;
        const cancelledRequests = cancelledTreeSelectionRequestsRef.current;
        // Generated component frames echo the request id on a tree-row ack.
        // If a newer canvas/tree selection superseded that request, discard the
        // late ack before it can alter the current selection or trigger a
        // workspace-to-renderer handoff. The id is consumed exactly once.
        if (selectionRequestId && cancelledRequests.has(selectionRequestId)) {
          cancelledRequests.delete(selectionRequestId);
          return;
        }
        setInspectionReadyRevisionKey(transport.revisionKey);
        setSelectedId(d.nodeId);
        const rect = mapSelectionRect(d.rect);
        setSelectionRect(rect);
        setAffectedIds(d.affectedNodeIds);
        const signature = mapInspectionSignature(d.signature);
        const selectionKey = selectionIdentity(d.nodeId, signature);
        const pendingTreeSelection = pendingTreeSelectionRef.current;
        const isExpectedTreeSelection =
          !!pendingTreeSelection &&
          selectionRequestId === pendingTreeSelection.requestId &&
          d.nodeId === pendingTreeSelection.nodeId;
        if (isExpectedTreeSelection) {
          pendingTreeSelectionRef.current = null;
        } else if (pendingTreeSelection) {
          // A current-surface selection without this request's id is a genuine
          // canvas/renderer event, so it wins. Any later ack for the abandoned
          // tree request is ignored by the cancelled-request set above.
          rememberCancelledSelectionRequest(cancelledRequests, pendingTreeSelection.requestId);
          pendingTreeSelectionRef.current = null;
        }
        // A missing signature is still useful for the Elements panel's visual
        // selection, but cannot participate in duplicate suppression because it
        // carries no element identity for the style/editor handoff.
        if (
          !signature ||
          isExpectedTreeSelection ||
          lastPublishedSelectionRef.current !== selectionKey
        ) {
          if (signature) lastPublishedSelectionRef.current = selectionKey;
          onSelectionChange?.({
            id: d.nodeId,
            signature,
            rect,
            count: d.count ?? 1,
          });
        }
        const component = d.component;
        const hostNodeIds = component?.hostNodeIds ?? [];
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
    const onLoad = () => {
      setHoveredId(null);
      requestTree();
    };
    iframe?.addEventListener('load', onLoad);

    return () => {
      post({ type: 'ss:treeOff' });
      if (surfaceTarget) post({ type: 'ss:deactivate' });
      window.removeEventListener('message', onMessage);
      iframe?.removeEventListener('load', onLoad);
    };
  }, [iframeRef, onSelectionChange, post, requestTree, surfaceActive, surfaceTarget, transport]);

  const selectNode = useCallback(
    (id: number) => {
      const requestId = createSelectionRequestId();
      const pending = pendingTreeSelectionRef.current;
      if (pending) {
        rememberCancelledSelectionRequest(
          cancelledTreeSelectionRequestsRef.current,
          pending.requestId
        );
      }
      pendingTreeSelectionRef.current = { nodeId: id, requestId };
      setSelectionKind('element');
      setSelectedComponent(null);
      setSelectedId(id);
      post({ type: 'ss:selectNode', id, selectionRequestId: requestId });
    },
    [post]
  );
  const hoverNode = useCallback(
    (id: number | null) => {
      // The pointer is over the Elements pane, so a previous page-side hover is
      // no longer the active visual target.
      setHoveredId(null);
      post({ type: 'ss:hoverNode', id });
    },
    [post]
  );
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

  // Stale data is kept while disabled (cheap) but never exposed. A surface key
  // mismatch is similarly hidden synchronously before the replacement snapshot.
  const surfaceVisible = surfaceActive && boundSurfaceRevisionKey === transport.revisionKey;
  const inspectionReady =
    surfaceVisible && inspectionReadyRevisionKey === transport.revisionKey;
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

  // Keep the projected tree's identity tied to the snapshot/projection. The
  // workspace publishes this value through a parent-owned Elements-panel
  // model; rebuilding it on every render makes that publication look like a
  // new model and can feed a state-update loop during launch.
  const projectedComponentTree = useMemo(
    () => (surfaceVisible && projection?.tree ? projectedNode(projection.tree) : null),
    [projection, surfaceVisible]
  );

  useEffect(() => {
    if (!enabled || !hoverCandidateSeen) return;
    hoverComponent(hoveredComponent);
  }, [enabled, hoverCandidateSeen, hoveredComponent, hoverComponent]);

  return {
    tree: surfaceVisible ? tree : null,
    componentTree: projectedComponentTree,
    componentTreeDiagnostics: surfaceVisible && projection ? projection.diagnostics : [],
    componentBoundaries: surfaceVisible && projection ? projection.boundaries : [],
    truncated: surfaceVisible ? truncated : false,
    selectedId: surfaceVisible ? selectedId : null,
    affectedIds: surfaceVisible ? affectedIds : [],
    hoveredId: surfaceVisible ? hoveredId : null,
    inspectionReady,
    selectionKind: surfaceVisible && effectiveSelectedComponent ? 'component' : 'element',
    selectedComponent: surfaceVisible ? effectiveSelectedComponent : null,
    componentFocusCandidate: surfaceVisible ? componentFocusCandidate : null,
    selectNode,
    hoverNode,
    selectComponent,
    hoverComponent,
    requestComponentFocus,
    clearComponentFocus,
    clearComponentFocusCandidate,
  };
}
