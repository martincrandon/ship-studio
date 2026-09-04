import { useCallback, useEffect, useMemo, useState } from 'react';
import { validateComponentBoundary } from '../lib/components/component-tree';
import type {
  ComponentBoundary,
  ComponentDiagnostic,
  ComponentFocusLevel,
  ComponentFocusRefusalCode,
  ComponentFocusSession,
  ComponentFocusTransition,
  ComponentIndex,
} from '../lib/components/types';
import type { ComponentTreeNode } from './useElementTree';

interface Params {
  index: ComponentIndex | null;
  /** Opaque route identity supplied by the preview host, when available. */
  routeKey?: string | null;
  enabled?: boolean;
  /**
   * Confirms that a nested row is inside the current projected component.
   * The fallback host overlap check is retained for standalone callers that
   * do not have the projected tree available.
   */
  isWithinFocusedBoundary?: (node: ComponentTreeNode, focused: ComponentFocusSession) => boolean;
}

export interface ComponentFocusCrumb {
  key: string;
  name: string;
}

function levelFromNode(node: ComponentTreeNode, indexRevision: string): ComponentFocusLevel {
  return {
    componentId: node.componentId,
    instanceId: node.instanceId,
    name: node.name,
    hostNodeIds: [...node.hostNodeIds],
    definition: node.definition,
    invocation: node.invocation,
    indexRevision,
  };
}

function levelFromSession(session: ComponentFocusSession): ComponentFocusLevel {
  return {
    componentId: session.componentId,
    instanceId: session.instanceId,
    name: session.name,
    hostNodeIds: [...session.hostNodeIds],
    definition: session.definition,
    invocation: session.invocation,
    indexRevision: session.indexRevision,
  };
}

function levelFromBoundary(boundary: ComponentBoundary): ComponentFocusLevel {
  return {
    componentId: boundary.componentId,
    instanceId: boundary.instanceId,
    name: boundary.name,
    hostNodeIds: [...boundary.hostNodeIds],
    definition: boundary.definition,
    invocation: boundary.invocation,
    indexRevision: boundary.indexRevision,
  };
}

function refusal(
  code: ComponentFocusRefusalCode,
  diagnostics: ComponentDiagnostic[] = []
): ComponentFocusTransition {
  return { status: 'refused', code, diagnostics };
}

function refusalCode(diagnostics: readonly ComponentDiagnostic[]): ComponentFocusRefusalCode {
  const code = diagnostics.length ? diagnostics[diagnostics.length - 1]?.code : undefined;
  if (code === 'component-boundary-stale-revision') return 'stale-revision';
  if (
    code === 'component-boundary-definition-stale' ||
    code === 'component-boundary-invocation-stale'
  ) {
    return 'stale-source';
  }
  if (code === 'component-boundary-missing-component') return 'missing-component';
  if (code === 'component-boundary-missing-instance') return 'missing-instance';
  if (code === 'component-boundary-identity-mismatch') return 'identity-mismatch';
  if (code === 'component-boundary-invalid-host' || code === 'component-boundary-no-host') {
    return 'invalid-host';
  }
  return 'not-exact';
}

/**
 * Owns the revision-bound component focus session used by the Element Tree.
 * The hook accepts only a component row produced by the validated projection;
 * it never turns a source-anchored selection into a focusable boundary.
 */
export function useComponentFocus({
  index,
  routeKey = null,
  enabled = true,
  isWithinFocusedBoundary,
}: Params) {
  const [session, setSession] = useState<ComponentFocusSession | null>(null);

  // Keep a route-stable session visible while its index revision is stale so the
  // host can attempt one exact identity rebind. The shared focus context still
  // refuses to enable writes until that rebind succeeds against the new index.
  const activeSession = enabled && session?.routeKey === routeKey ? session : null;

  useEffect(() => {
    if (!enabled || (session && session.routeKey !== routeKey)) {
      // Route/lifecycle changes invalidate the in-memory focus session.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSession(null);
    }
  }, [enabled, routeKey, session]);

  const enter = useCallback(
    (node: ComponentTreeNode): ComponentFocusTransition => {
      if (!enabled || !index) return refusal('no-index');
      if (node.confidence !== 'exact') return refusal('not-exact');
      if (activeSession && activeSession.routeKey !== routeKey) return refusal('route-changed');
      if (activeSession && activeSession.indexRevision !== index.revision) {
        return refusal('stale-revision');
      }

      const validation = validateComponentBoundary(
        {
          key: node.key,
          componentId: node.componentId,
          instanceId: node.instanceId,
          confidence: node.confidence,
          hostNodeIds: node.hostNodeIds,
          definition: node.definition,
          invocation: node.invocation,
          indexRevision: index.revision,
        },
        index
      );
      if (validation.status !== 'valid' || !validation.boundary) {
        return refusal(refusalCode(validation.diagnostics), validation.diagnostics);
      }

      if (
        activeSession &&
        (isWithinFocusedBoundary
          ? !isWithinFocusedBoundary(node, activeSession)
          : !node.hostNodeIds.some((nodeId) => activeSession.hostNodeIds.includes(nodeId)))
      ) {
        return refusal('not-focused', [
          {
            code: 'component-focus-outside-boundary',
            severity: 'warning',
            message: 'The nested component is outside the current focused boundary.',
          },
        ]);
      }

      const next: ComponentFocusSession = {
        ...levelFromNode(node, index.revision),
        ancestry: activeSession ? [...activeSession.ancestry, levelFromSession(activeSession)] : [],
        routeKey,
      };
      setSession(next);
      return { status: activeSession ? 'changed' : 'entered', session: next };
    },
    [activeSession, enabled, index, isWithinFocusedBoundary, routeKey]
  );

  const focusParent = useCallback((): ComponentFocusTransition => {
    if (!activeSession) return refusal('not-focused');
    if (index && activeSession.indexRevision !== index.revision) {
      return refusal('stale-revision');
    }
    const ancestry = activeSession.ancestry;
    if (ancestry.length === 0) {
      setSession(null);
      return { status: 'changed', session: null };
    }
    const parent = ancestry[ancestry.length - 1];
    const next: ComponentFocusSession = { ...parent, ancestry: ancestry.slice(0, -1), routeKey };
    setSession(next);
    return { status: 'changed', session: next };
  }, [activeSession, index, routeKey]);

  /** Rebind the current level to the same indexed instance after HMR changes its host roots. */
  const rebind = useCallback(
    (
      node: ComponentTreeNode,
      currentBoundaries: readonly ComponentBoundary[] = []
    ): ComponentFocusTransition => {
      if (!activeSession || !enabled || !index) return refusal('not-focused');
      if (node.confidence !== 'exact') return refusal('not-exact');
      if (
        node.componentId !== activeSession.componentId ||
        node.instanceId !== activeSession.instanceId ||
        node.key !== activeSession.instanceId
      ) {
        return refusal('identity-mismatch');
      }
      const validation = validateComponentBoundary(
        {
          key: node.key,
          componentId: node.componentId,
          instanceId: node.instanceId,
          confidence: node.confidence,
          hostNodeIds: node.hostNodeIds,
          definition: node.definition,
          invocation: node.invocation,
          indexRevision: index.revision,
        },
        index
      );
      if (validation.status !== 'valid' || !validation.boundary) {
        return refusal(refusalCode(validation.diagnostics), validation.diagnostics);
      }
      const ancestry: ComponentFocusLevel[] = [];
      for (const level of activeSession.ancestry) {
        const currentBoundary = currentBoundaries.find(
          (boundary) => boundary.instanceId === level.instanceId
        );
        if (!currentBoundary) {
          return refusal('missing-instance', [
            {
              code: 'component-focus-ancestor-missing',
              severity: 'warning',
              message: 'A focused ancestor no longer has an exact rendered boundary.',
            },
          ]);
        }
        const ancestorValidation = validateComponentBoundary(
          {
            key: currentBoundary.key,
            componentId: currentBoundary.componentId,
            instanceId: currentBoundary.instanceId,
            confidence: currentBoundary.confidence,
            hostNodeIds: currentBoundary.hostNodeIds,
            definition: currentBoundary.definition,
            invocation: currentBoundary.invocation,
            indexRevision: index.revision,
          },
          index
        );
        if (ancestorValidation.status !== 'valid' || !ancestorValidation.boundary) {
          return refusal(
            refusalCode(ancestorValidation.diagnostics),
            ancestorValidation.diagnostics
          );
        }
        ancestry.push(levelFromBoundary(ancestorValidation.boundary));
      }
      const next: ComponentFocusSession = {
        ...levelFromNode(node, index.revision),
        ancestry,
        routeKey,
      };
      setSession(next);
      return { status: 'changed', session: next };
    },
    [activeSession, enabled, index, routeKey]
  );

  const exit = useCallback((): ComponentFocusTransition => {
    if (!activeSession) return refusal('not-focused');
    setSession(null);
    return { status: 'changed', session: null };
  }, [activeSession]);

  const path = useMemo<ComponentFocusCrumb[]>(
    () =>
      activeSession
        ? [...activeSession.ancestry, activeSession].map((level) => ({
            key: level.instanceId,
            name: level.name,
          }))
        : [],
    [activeSession]
  );

  return {
    session: activeSession,
    path,
    enter,
    focusParent,
    rebind,
    exit,
  };
}
