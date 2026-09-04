import { useMemo } from 'react';
import {
  createComponentFocusContext,
  withFocusedChild,
  type ComponentFocusContext,
} from '../lib/components/focus';
import type { ComponentFocusSession, ComponentIndex, SourceRef } from '../lib/components/types';

interface Params {
  index: ComponentIndex | null;
  session: ComponentFocusSession | null;
  routeKey: string | null;
  selectedChild?: SourceRef | null;
}

/** Builds the short-lived, revision-bound DTO used by focused write paths. */
export function useComponentBinding({
  index,
  session,
  routeKey,
  selectedChild = null,
}: Params): ComponentFocusContext | null {
  return useMemo(() => {
    const context = createComponentFocusContext(session, index, selectedChild);
    if (!context || context.routeKey !== routeKey) return null;
    return withFocusedChild(context, selectedChild);
  }, [index, routeKey, selectedChild, session]);
}
