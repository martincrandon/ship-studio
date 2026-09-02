import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectType } from '@/lib/static-server';
import { useAsyncState } from './useAsyncState';
import { useInvoke } from './useInvoke';
import { ComponentWorkerClient } from '../lib/components/component-worker-client';
import type {
  AppliedComponentMutation,
  ComponentBinding,
  ComponentIndex,
  ComponentInstance,
  ComponentMutationPlan,
  ComponentSourceSnapshot,
  InsertComponentInput,
  MutationResult,
  SelectionBindingInput,
  StaticValue,
} from '../lib/components/types';

export type ComponentMutationOutcome =
  | { status: 'applied'; changedFiles: string[] }
  | Extract<MutationResult, { status: 'refused' }>
  | { status: 'failed'; message: string };

interface UseComponentCatalogOptions {
  projectPath: string;
  projectType: ProjectType | null | undefined;
  enabled: boolean;
}

function rustPlan(plan: ComponentMutationPlan) {
  return { files: plan.files, expectedRevision: plan.expectedRevision };
}

/**
 * Owns the Components feature's immutable source snapshot, worker index, and
 * guarded mutation round-trip. Project code is parsed as text and is never
 * imported or executed by Ship Studio.
 */
export function useComponentCatalog({
  projectPath,
  projectType,
  enabled,
}: UseComponentCatalogOptions) {
  const workerRef = useRef<ComponentWorkerClient | null>(null);
  const snapshotRef = useRef<ComponentSourceSnapshot | null>(null);
  const indexRef = useRef<ComponentIndex | null>(null);
  const applyErrorRef = useRef<Error | null>(null);
  const mutationInFlightRef = useRef(false);
  const refreshSequenceRef = useRef(0);
  const [planningMutation, setPlanningMutation] = useState(false);

  const {
    execute: loadSnapshot,
    reset: resetSnapshot,
    isLoading: snapshotLoading,
    error: snapshotError,
  } = useInvoke<ComponentSourceSnapshot>('get_component_source_snapshot', { latestOnly: true });
  const { execute: applyMutation, isLoading: applyLoading } = useInvoke<AppliedComponentMutation>(
    'apply_component_mutation',
    {
      onError: (error) => {
        applyErrorRef.current = error;
      },
    }
  );

  const getWorker = useCallback(() => {
    workerRef.current ??= new ComponentWorkerClient();
    return workerRef.current;
  }, []);

  const {
    data: index,
    execute: buildIndex,
    reset: resetIndex,
    isLoading: indexLoading,
    error: indexError,
  } = useAsyncState<ComponentIndex, [ComponentSourceSnapshot, ProjectType | null]>(
    (snapshot, type) => getWorker().build(snapshot, type),
    { latestOnly: true }
  );

  const refresh = useCallback(async () => {
    const sequence = refreshSequenceRef.current + 1;
    refreshSequenceRef.current = sequence;
    const snapshot = await loadSnapshot({ projectPath });
    if (!snapshot || sequence !== refreshSequenceRef.current) return null;
    snapshotRef.current = snapshot;
    const nextIndex = await buildIndex(snapshot, projectType ?? null);
    if (!nextIndex || sequence !== refreshSequenceRef.current) return null;
    indexRef.current = nextIndex;
    return nextIndex;
  }, [buildIndex, loadSnapshot, projectPath, projectType]);

  useEffect(() => {
    refreshSequenceRef.current += 1;
    snapshotRef.current = null;
    indexRef.current = null;
    resetSnapshot();
    resetIndex();
  }, [projectPath, resetIndex, resetSnapshot]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  useEffect(
    () => () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    },
    []
  );

  const applyPlannedMutation = useCallback(
    async (result: MutationResult): Promise<ComponentMutationOutcome> => {
      if (result.status === 'refused') return result;
      applyErrorRef.current = null;
      const applied = await applyMutation({
        projectPath,
        plan: rustPlan(result.plan),
      });
      if (!applied) {
        return {
          status: 'failed',
          message:
            (applyErrorRef.current as Error | null)?.message ??
            'The component source edit could not be applied. Refresh the catalog and try again.',
        };
      }
      await refresh();
      return { status: 'applied', changedFiles: applied.changedFiles };
    },
    [applyMutation, projectPath, refresh]
  );

  const place = useCallback(
    async (
      input: Omit<InsertComponentInput, 'kind' | 'snapshot'>
    ): Promise<ComponentMutationOutcome> => {
      if (!indexRef.current || !snapshotRef.current) {
        return {
          status: 'failed',
          message: 'The component catalog is not ready yet.',
        } satisfies ComponentMutationOutcome;
      }
      if (mutationInFlightRef.current) {
        return { status: 'failed', message: 'Another component edit is still being applied.' };
      }
      mutationInFlightRef.current = true;
      setPlanningMutation(true);
      try {
        const result = await getWorker().planInsert({ ...input, kind: 'insert' });
        return await applyPlannedMutation(result);
      } catch (error) {
        return {
          status: 'failed',
          message: error instanceof Error ? error.message : 'Component placement failed.',
        };
      } finally {
        mutationInFlightRef.current = false;
        setPlanningMutation(false);
      }
    },
    [applyPlannedMutation, getWorker]
  );

  const editProp = useCallback(
    async (
      instance: ComponentInstance,
      propName: string,
      value: StaticValue
    ): Promise<ComponentMutationOutcome> => {
      if (!indexRef.current || !snapshotRef.current) {
        return {
          status: 'failed',
          message: 'The component catalog is not ready yet.',
        } satisfies ComponentMutationOutcome;
      }
      if (mutationInFlightRef.current) {
        return { status: 'failed', message: 'Another component edit is still being applied.' };
      }
      mutationInFlightRef.current = true;
      setPlanningMutation(true);
      try {
        const result = await getWorker().planPropEdit({
          kind: 'prop',
          instanceId: instance.id,
          propName,
          value,
        });
        return await applyPlannedMutation(result);
      } catch (error) {
        return {
          status: 'failed',
          message: error instanceof Error ? error.message : 'The component prop edit failed.',
        };
      } finally {
        mutationInFlightRef.current = false;
        setPlanningMutation(false);
      }
    },
    [applyPlannedMutation, getWorker]
  );

  const bindSelection = useCallback(
    async (input: SelectionBindingInput): Promise<ComponentBinding | null> => {
      if (!indexRef.current) return null;
      try {
        return await getWorker().bind(input);
      } catch {
        return null;
      }
    },
    [getWorker]
  );

  indexRef.current = index;

  return {
    index,
    loading: snapshotLoading || indexLoading,
    error: indexError?.message ?? snapshotError?.message ?? null,
    mutationBusy: planningMutation || applyLoading,
    refresh,
    place,
    editProp,
    bindSelection,
  };
}
