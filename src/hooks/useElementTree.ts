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

import { useCallback, useEffect, useState, type RefObject } from 'react';
import { usePolling } from './usePolling';
import type { ComponentId, ComponentInstanceId, SourceRef } from '../lib/components/types';

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

/** One element in the raw snapshot, mapped from the compact wire format. */
export interface ElementTreeNode {
  /** Omitted by legacy callers; mapped wire nodes always set this discriminator. */
  kind?: 'element';
  id: number;
  tag: string;
  /** The element's class attribute (truncated iframe-side). */
  cls: string;
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
}

interface WireNode {
  i: number;
  t: string;
  c: string;
  x: string;
  k: WireNode[];
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

function boundedString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, RUNTIME_STRING_CAP)
    : null;
}

function boundedNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
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
  return {
    kind: 'element',
    id: n.i,
    tag: n.t,
    cls: n.c,
    text: n.x,
    ownerHints,
    runtimeKey,
    children: (n.k ?? []).map(mapNode),
  };
}

interface UseElementTreeParams {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  /** Fetch + track the tree only while the navigator is visible. */
  enabled: boolean;
}

export function useElementTree({ iframeRef, enabled }: UseElementTreeParams) {
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
      } else if (d.type === 'ss:select') {
        setSelectedId(typeof d.nodeId === 'number' ? d.nodeId : null);
        setAffectedIds(
          Array.isArray(d.affectedNodeIds)
            ? d.affectedNodeIds.filter((id): id is number => typeof id === 'number')
            : []
        );
        const component = d.component;
        const hostNodeIds = Array.isArray(component?.hostNodeIds)
          ? component.hostNodeIds.filter((id): id is number => typeof id === 'number')
          : [];
        if (
          d.selectionKind === 'component' &&
          typeof component?.key === 'string' &&
          component.confidence === 'exact'
        ) {
          setSelectionKind('component');
          setSelectedComponent({
            key: component.key.slice(0, RUNTIME_STRING_CAP),
            componentId:
              typeof component.componentId === 'string' ? component.componentId : undefined,
            instanceId:
              typeof component.instanceId === 'string' ? component.instanceId : undefined,
            name: typeof component.name === 'string' ? component.name.slice(0, 160) : undefined,
            hostNodeIds,
            confidence: 'exact',
          });
        } else {
          setSelectionKind('element');
          setSelectedComponent(null);
        }
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

  const selectNode = useCallback((id: number) => post({ type: 'ss:selectNode', id }), [post]);
  const hoverNode = useCallback((id: number | null) => post({ type: 'ss:hoverNode', id }), [post]);
  const selectComponent = useCallback(
    (node: ComponentTreeNode) =>
      post({
        type: 'ss:selectComponent',
        key: node.key,
        componentId: node.componentId,
        instanceId: node.instanceId,
        name: node.name,
        confidence: node.confidence,
        hostNodeIds: node.hostNodeIds,
      }),
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
            }
          : { type: 'ss:hoverComponent', hostNodeIds: [] }
      ),
    [post]
  );
  const requestComponentFocus = useCallback(
    (node: Pick<ComponentTreeNode, 'key' | 'componentId' | 'instanceId' | 'confidence'>) =>
      post({
        type: 'ss:componentFocusRequest',
        key: node.key,
        componentId: node.componentId,
        instanceId: node.instanceId,
        confidence: node.confidence,
      }),
    [post]
  );

  // Stale data is kept while disabled (cheap) but never exposed.
  return {
    tree: enabled ? tree : null,
    truncated,
    selectedId: enabled ? selectedId : null,
    affectedIds: enabled ? affectedIds : [],
    selectionKind: enabled ? selectionKind : 'element',
    selectedComponent: enabled ? selectedComponent : null,
    selectNode,
    hoverNode,
    selectComponent,
    hoverComponent,
    requestComponentFocus,
  };
}
