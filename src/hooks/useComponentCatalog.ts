import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { ProjectType } from '@/lib/static-server';
import { useAsyncState } from './useAsyncState';
import { useInvoke } from './useInvoke';
import { ComponentWorkerClient } from '../lib/components/component-worker-client';
import { previewComponentMutation } from '../lib/components/mutation';
import {
  COMPONENT_SOURCE_CHANGED_EVENT,
  readComponentSourceBatch,
  startComponentSourceWatch,
  stopComponentSourceWatch,
} from '../lib/components/client';
import { sha256 } from '../lib/components/ranges';
import { getWindowLabel } from '../lib/window';
import { logger } from '../lib/logger';
import type {
  AppliedComponentMutation,
  ComponentBinding,
  ComponentIndex,
  ComponentInstance,
  ComponentMutationPlan,
  ComponentMutationPreview,
  ComponentExtractionPlan,
  ComponentExtractionPreview,
  ComponentRefactorPlan,
  ComponentRefactorPreview,
  ComponentSourceChangeEvent,
  ComponentSourceSnapshot,
  DeleteComponentInput,
  DuplicateComponentInput,
  ExtractComponentInput,
  ExtractionResult,
  InsertComponentInput,
  MutationResult,
  RenameComponentInput,
  RefactorResult,
  SelectionBindingInput,
  SourceFileChange,
  SourceFileSnapshot,
  StaticValue,
} from '../lib/components/types';

export type ComponentMutationOutcome =
  | { status: 'applied'; changedFiles: string[] }
  | { status: 'preview'; preview: ComponentMutationPreview }
  | Extract<MutationResult, { status: 'refused' }>
  | { status: 'failed'; message: string };

export type ComponentRefactorOutcome =
  | { status: 'applied'; changedFiles: string[] }
  | { status: 'preview'; preview: ComponentRefactorPreview }
  | Extract<RefactorResult, { status: 'refused' }>
  | { status: 'failed'; message: string };

export type ComponentExtractionOutcome =
  | {
      status: 'needs-approval';
      proposal: Extract<ExtractionResult, { status: 'needs-approval' }>['proposal'];
    }
  | { status: 'preview'; preview: ComponentExtractionPreview }
  | Extract<ExtractionResult, { status: 'refused' }>
  | { status: 'applied'; changedFiles: string[] }
  | { status: 'failed'; message: string };

interface UseComponentCatalogOptions {
  projectPath: string;
  projectType: ProjectType | null | undefined;
  enabled: boolean;
}

function rustPlan(plan: ComponentMutationPlan) {
  return {
    files: plan.files,
    expectedRevision: plan.expectedRevision,
    ...(plan.operations ? { operations: plan.operations } : {}),
    ...(plan.dialect ? { dialect: plan.dialect } : {}),
    ...(plan.parserToken ? { parserToken: plan.parserToken } : {}),
    ...(plan.expectedGraphDelta ? { expectedGraphDelta: plan.expectedGraphDelta } : {}),
  };
}

function sourceChangesBetween(
  before: ComponentSourceSnapshot,
  after: ComponentSourceSnapshot,
  hintedFiles: readonly string[]
): SourceFileChange[] {
  const beforeByFile = new Map(before.files.map((file) => [file.file, file]));
  const afterByFile = new Map(after.files.map((file) => [file.file, file]));
  const candidateFiles = hintedFiles.length
    ? new Set(hintedFiles)
    : new Set([...beforeByFile.keys(), ...afterByFile.keys()]);
  const changes: SourceFileChange[] = [];
  for (const file of [...candidateFiles].sort()) {
    const previous = beforeByFile.get(file);
    const next = afterByFile.get(file);
    if (next && next.contentHash !== previous?.contentHash) {
      changes.push({
        file,
        content: next.content,
        contentHash: next.contentHash,
        kind: previous ? 'changed' : 'created',
      });
    } else if (previous && !next) {
      changes.push({ file, content: '', contentHash: sha256(''), kind: 'deleted' });
    }
  }
  return changes;
}

const MAX_SOURCE_RESOLUTION_ROUNDS = 3;

/** Start a watcher while preserving cleanup that wins during async startup. */
export async function startComponentWatcherWithCleanup(input: {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isDisposed: () => boolean;
}): Promise<boolean> {
  await input.start();
  if (input.isDisposed()) {
    await input.stop();
    return false;
  }
  return true;
}

function mergeSupplementalSources(
  snapshot: ComponentSourceSnapshot,
  supplemental: ReadonlyMap<string, SourceFileSnapshot>
) {
  if (supplemental.size === 0) return snapshot;
  const files = new Map(snapshot.files.map((file) => [file.file, file]));
  for (const [file, source] of supplemental) {
    if (!files.has(file)) files.set(file, source);
  }
  return {
    ...snapshot,
    files: [...files.values()].sort((left, right) => left.file.localeCompare(right.file)),
  };
}

function indexWithNeedSourcesDiagnostic(
  index: ComponentIndex,
  code: string,
  message: string
): ComponentIndex {
  return {
    ...index,
    partial: true,
    needSources: undefined,
    diagnostics: [...index.diagnostics, { code, severity: 'warning', message }],
  };
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
  const supplementalSourcesRef = useRef(new Map<string, SourceFileSnapshot>());
  const indexRef = useRef<ComponentIndex | null>(null);
  const applyErrorRef = useRef<Error | null>(null);
  const mutationInFlightRef = useRef(false);
  const pendingMutationRef = useRef<ComponentMutationPreview | null>(null);
  const pendingRefactorRef = useRef<ComponentRefactorPlan | null>(null);
  const pendingExtractionRef = useRef<ComponentExtractionPlan | null>(null);
  const refreshSequenceRef = useRef(0);
  const [planningMutation, setPlanningMutation] = useState(false);
  const [pendingMutation, setPendingMutation] = useState<ComponentMutationPreview | null>(null);
  const [pendingRefactor, setPendingRefactor] = useState<ComponentRefactorPreview | null>(null);
  const [pendingExtraction, setPendingExtraction] = useState<ComponentExtractionPreview | null>(
    null
  );

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

  const clearPendingMutation = useCallback(() => {
    pendingMutationRef.current = null;
    setPendingMutation(null);
  }, []);

  const clearPendingRefactor = useCallback(() => {
    pendingRefactorRef.current = null;
    setPendingRefactor(null);
  }, []);

  const clearPendingExtraction = useCallback(() => {
    pendingExtractionRef.current = null;
    setPendingExtraction(null);
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

  const refresh = useCallback(
    async (hintedFiles: readonly string[] = []) => {
      const sequence = refreshSequenceRef.current + 1;
      refreshSequenceRef.current = sequence;
      const snapshot = await loadSnapshot({ projectPath });
      if (!snapshot || sequence !== refreshSequenceRef.current) return null;
      const previousSnapshot = snapshotRef.current;
      let workingSnapshot = mergeSupplementalSources(snapshot, supplementalSourcesRef.current);
      let changes = previousSnapshot
        ? sourceChangesBetween(previousSnapshot, workingSnapshot, hintedFiles)
        : [];
      let nextIndex =
        previousSnapshot && changes.length > 0
          ? await getWorker().update(workingSnapshot, changes, projectType ?? null)
          : await buildIndex(workingSnapshot, projectType ?? null);
      if (sequence !== refreshSequenceRef.current) return null;
      const requestedInRevision = new Set<string>();
      let resolutionRounds = 0;
      for (
        ;
        nextIndex?.needSources?.length && resolutionRounds < MAX_SOURCE_RESOLUTION_ROUNDS;
        resolutionRounds += 1
      ) {
        const requested = [...new Set(nextIndex.needSources)].sort();
        if (requested.length === 0 || requested.some((file) => requestedInRevision.has(file))) {
          nextIndex = indexWithNeedSourcesDiagnostic(
            nextIndex,
            'component-need-sources-repeated',
            'The component index repeated an internal source request; unresolved package sources remain read-only.'
          );
          break;
        }
        for (const file of requested) requestedInRevision.add(file);
        if (requested.length > 64) {
          nextIndex = indexWithNeedSourcesDiagnostic(
            nextIndex,
            'component-need-sources-limit',
            'The component index requested too many internal source files in one refresh.'
          );
          break;
        }
        let loaded: SourceFileSnapshot[];
        try {
          loaded = await readComponentSourceBatch(projectPath, requested, snapshot.revision);
        } catch (error) {
          if (sequence !== refreshSequenceRef.current) return null;
          nextIndex = indexWithNeedSourcesDiagnostic(
            nextIndex,
            'component-need-sources-read-failed',
            error instanceof Error
              ? error.message
              : 'The internal component source batch could not be read safely.'
          );
          break;
        }
        if (sequence !== refreshSequenceRef.current) return null;
        if (loaded.some((source) => !requestedInRevision.has(source.file))) {
          nextIndex = indexWithNeedSourcesDiagnostic(
            nextIndex,
            'component-need-sources-unrequested',
            'The source batch returned a file the worker did not request.'
          );
          break;
        }
        for (const source of loaded) supplementalSourcesRef.current.set(source.file, source);
        const beforeRound = workingSnapshot;
        workingSnapshot = mergeSupplementalSources(snapshot, supplementalSourcesRef.current);
        changes = sourceChangesBetween(beforeRound, workingSnapshot, requested);
        if (changes.length === 0) {
          nextIndex = indexWithNeedSourcesDiagnostic(
            nextIndex,
            'component-need-sources-unresolved',
            'The requested internal package sources were not available in the project.'
          );
          break;
        }
        nextIndex = await getWorker().update(workingSnapshot, changes, projectType ?? null);
        if (sequence !== refreshSequenceRef.current) return null;
      }
      if (nextIndex?.needSources?.length) {
        nextIndex = indexWithNeedSourcesDiagnostic(
          nextIndex,
          'component-need-sources-round-limit',
          `The component index could not complete its bounded internal source resolution rounds (${MAX_SOURCE_RESOLUTION_ROUNDS}).`
        );
      }
      if (!nextIndex || sequence !== refreshSequenceRef.current) return null;
      // Do not publish host refs until every bounded source-resolution round
      // and the final supersession check have completed.  An older refresh
      // may have finished its worker request after a newer refresh started;
      // in that case it must not replace either the snapshot or index refs.
      snapshotRef.current = workingSnapshot;
      indexRef.current = nextIndex;
      return nextIndex;
    },
    [buildIndex, getWorker, loadSnapshot, projectPath, projectType]
  );

  useEffect(() => {
    refreshSequenceRef.current += 1;
    snapshotRef.current = null;
    supplementalSourcesRef.current.clear();
    indexRef.current = null;
    clearPendingMutation();
    clearPendingRefactor();
    clearPendingExtraction();
    resetSnapshot();
    resetIndex();
  }, [
    clearPendingExtraction,
    clearPendingMutation,
    clearPendingRefactor,
    projectPath,
    resetIndex,
    resetSnapshot,
  ]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let started = false;
    let unlisten: (() => void) | null = null;
    const windowLabel = getWindowLabel();

    void (async () => {
      try {
        unlisten = await listen<ComponentSourceChangeEvent>(
          COMPONENT_SOURCE_CHANGED_EVENT,
          (event) => {
            const payload = event.payload;
            if (disposed || payload.projectPath !== projectPath) return;
            if (snapshotRef.current?.revision === payload.revision) return;
            void refresh(payload.changedFiles);
          }
        );
        if (disposed) {
          unlisten();
          unlisten = null;
          return;
        }
        started = await startComponentWatcherWithCleanup({
          start: () => startComponentSourceWatch(windowLabel, projectPath),
          stop: () => stopComponentSourceWatch(windowLabel, projectPath),
          isDisposed: () => disposed,
        });
      } catch (error) {
        if (!disposed) {
          logger.warn(
            '[Components] Source watcher unavailable; explicit refresh remains available',
            {
              projectPath,
              error: error instanceof Error ? error.message : String(error),
            }
          );
        }
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
      unlisten = null;
      if (started) void stopComponentSourceWatch(windowLabel, projectPath);
    };
  }, [enabled, projectPath, refresh]);

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
      if (
        pendingMutationRef.current ||
        pendingRefactorRef.current ||
        pendingExtractionRef.current
      ) {
        return {
          status: 'failed',
          message: 'Review or cancel the pending component source changes first.',
        };
      }
      mutationInFlightRef.current = true;
      setPlanningMutation(true);
      try {
        const result = await getWorker().planInsert({ ...input, kind: 'insert' });
        if (result.status === 'refused') return result;
        const snapshot = snapshotRef.current;
        const preview = snapshot ? previewComponentMutation(result.plan, snapshot) : null;
        if (!preview) {
          return {
            status: 'failed',
            message: 'The component source preview is no longer current. Refresh and try again.',
          };
        }
        pendingMutationRef.current = preview;
        setPendingMutation(preview);
        return { status: 'preview', preview };
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
    [getWorker]
  );

  const confirmMutation = useCallback(async (): Promise<ComponentMutationOutcome> => {
    const pending = pendingMutationRef.current;
    if (!pending) {
      return { status: 'failed', message: 'There is no pending component source change to apply.' };
    }
    if (mutationInFlightRef.current) {
      return { status: 'failed', message: 'Another component edit is still being applied.' };
    }
    mutationInFlightRef.current = true;
    setPlanningMutation(true);
    try {
      const outcome = await applyPlannedMutation({ status: 'planned', plan: pending.plan });
      clearPendingMutation();
      return outcome;
    } catch (error) {
      clearPendingMutation();
      return {
        status: 'failed',
        message: error instanceof Error ? error.message : 'Component source edit failed.',
      };
    } finally {
      mutationInFlightRef.current = false;
      setPlanningMutation(false);
    }
  }, [applyPlannedMutation, clearPendingMutation]);

  const cancelMutation = useCallback(() => {
    if (mutationInFlightRef.current) return;
    clearPendingMutation();
  }, [clearPendingMutation]);

  const duplicate = useCallback(
    async (
      input: Omit<DuplicateComponentInput, 'kind' | 'snapshot'>
    ): Promise<ComponentRefactorOutcome> => {
      if (!indexRef.current || !snapshotRef.current) {
        return { status: 'failed', message: 'The component catalog is not ready yet.' };
      }
      if (mutationInFlightRef.current) {
        return { status: 'failed', message: 'Another component edit is still being applied.' };
      }
      if (
        pendingMutationRef.current ||
        pendingRefactorRef.current ||
        pendingExtractionRef.current
      ) {
        return {
          status: 'failed',
          message: 'Review or cancel the pending component source changes first.',
        };
      }
      mutationInFlightRef.current = true;
      setPlanningMutation(true);
      try {
        const result = await getWorker().planDuplicate({ ...input, kind: 'duplicate' });
        if (result.status === 'refused') return result;
        const preview = result.plan.preview;
        pendingRefactorRef.current = result.plan;
        setPendingRefactor(preview);
        return { status: 'preview', preview };
      } catch (error) {
        return {
          status: 'failed',
          message: error instanceof Error ? error.message : 'Component duplication failed.',
        };
      } finally {
        mutationInFlightRef.current = false;
        setPlanningMutation(false);
      }
    },
    [getWorker]
  );

  const rename = useCallback(
    async (
      input: Omit<RenameComponentInput, 'kind' | 'snapshot'>
    ): Promise<ComponentRefactorOutcome> => {
      if (!indexRef.current || !snapshotRef.current) {
        return { status: 'failed', message: 'The component catalog is not ready yet.' };
      }
      if (mutationInFlightRef.current) {
        return { status: 'failed', message: 'Another component edit is still being applied.' };
      }
      if (
        pendingMutationRef.current ||
        pendingRefactorRef.current ||
        pendingExtractionRef.current
      ) {
        return {
          status: 'failed',
          message: 'Review or cancel the pending component source changes first.',
        };
      }
      mutationInFlightRef.current = true;
      setPlanningMutation(true);
      try {
        const result = await getWorker().planRename({ ...input, kind: 'rename' });
        if (result.status === 'refused') return result;
        const preview = result.plan.preview;
        pendingRefactorRef.current = result.plan;
        setPendingRefactor(preview);
        return { status: 'preview', preview };
      } catch (error) {
        return {
          status: 'failed',
          message: error instanceof Error ? error.message : 'Component rename failed.',
        };
      } finally {
        mutationInFlightRef.current = false;
        setPlanningMutation(false);
      }
    },
    [getWorker]
  );

  const deleteComponent = useCallback(
    async (
      input: Omit<DeleteComponentInput, 'kind' | 'snapshot'>
    ): Promise<ComponentRefactorOutcome> => {
      if (!indexRef.current || !snapshotRef.current) {
        return { status: 'failed', message: 'The component catalog is not ready yet.' };
      }
      if (mutationInFlightRef.current) {
        return { status: 'failed', message: 'Another component edit is still being applied.' };
      }
      if (
        pendingMutationRef.current ||
        pendingRefactorRef.current ||
        pendingExtractionRef.current
      ) {
        return {
          status: 'failed',
          message: 'Review or cancel the pending component source changes first.',
        };
      }
      mutationInFlightRef.current = true;
      setPlanningMutation(true);
      try {
        const result = await getWorker().planDelete({ ...input, kind: 'delete' });
        if (result.status === 'refused') return result;
        const preview = result.plan.preview;
        pendingRefactorRef.current = result.plan;
        setPendingRefactor(preview);
        return { status: 'preview', preview };
      } catch (error) {
        return {
          status: 'failed',
          message: error instanceof Error ? error.message : 'Component deletion failed.',
        };
      } finally {
        mutationInFlightRef.current = false;
        setPlanningMutation(false);
      }
    },
    [getWorker]
  );

  const confirmRefactor = useCallback(async (): Promise<ComponentRefactorOutcome> => {
    const pending = pendingRefactorRef.current;
    if (!pending) {
      return { status: 'failed', message: 'There is no pending component refactor to apply.' };
    }
    if (mutationInFlightRef.current) {
      return { status: 'failed', message: 'Another component edit is still being applied.' };
    }
    mutationInFlightRef.current = true;
    setPlanningMutation(true);
    try {
      const outcome = await applyPlannedMutation({ status: 'planned', plan: pending });
      clearPendingRefactor();
      if (outcome.status === 'applied') {
        const delta = pending.expectedGraphDelta;
        const refreshedIndex = indexRef.current;
        if (delta && refreshedIndex) {
          const original = refreshedIndex.components.find(
            (component) => component.id === delta.componentId
          );
          const created = delta.createdComponentId
            ? refreshedIndex.components.find(
                (component) => component.id === delta.createdComponentId
              )
            : null;
          const removedOriginal = delta.removedComponentId === delta.componentId;
          if (
            (removedOriginal
              ? original !== undefined
              : !original || original.usageCount !== delta.usagesAfter) ||
            (delta.createdComponentId &&
              (!created || created.usageCount !== (delta.createdUsages ?? 0)))
          ) {
            return {
              status: 'failed',
              message:
                'The component source changed, but the refreshed catalog did not confirm the expected definition graph.',
            };
          }
        }
        return outcome;
      }
      if (outcome.status === 'failed') return outcome;
      if (outcome.status === 'refused') {
        return { status: 'failed', message: outcome.message };
      }
      return {
        status: 'failed',
        message: 'The component refactor still needs review before it can be applied.',
      };
    } catch (error) {
      clearPendingRefactor();
      return {
        status: 'failed',
        message: error instanceof Error ? error.message : 'Component refactor failed.',
      };
    } finally {
      mutationInFlightRef.current = false;
      setPlanningMutation(false);
    }
  }, [applyPlannedMutation, clearPendingRefactor]);

  const cancelRefactor = useCallback(() => {
    if (mutationInFlightRef.current) return;
    clearPendingRefactor();
  }, [clearPendingRefactor]);

  const editProp = useCallback(
    async (
      instance: ComponentInstance,
      propName: string,
      value: StaticValue | null
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
      if (
        pendingMutationRef.current ||
        pendingRefactorRef.current ||
        pendingExtractionRef.current
      ) {
        return {
          status: 'failed',
          message: 'Review or cancel the pending component source changes first.',
        };
      }
      mutationInFlightRef.current = true;
      setPlanningMutation(true);
      try {
        const result = await getWorker().planPropEdit({
          kind: 'prop',
          instanceId: instance.id,
          propName,
          ...(value === null
            ? { operation: 'remove' as const }
            : { operation: 'set' as const, value }),
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

  const editSlot = useCallback(
    async (
      instance: ComponentInstance,
      slotName: string,
      replacementSource: string
    ): Promise<ComponentMutationOutcome> => {
      if (!indexRef.current || !snapshotRef.current) {
        return {
          status: 'failed',
          message: 'The component catalog is not ready yet.',
        };
      }
      if (mutationInFlightRef.current) {
        return { status: 'failed', message: 'Another component edit is still being applied.' };
      }
      if (
        pendingMutationRef.current ||
        pendingRefactorRef.current ||
        pendingExtractionRef.current
      ) {
        return {
          status: 'failed',
          message: 'Review or cancel the pending component source changes first.',
        };
      }
      mutationInFlightRef.current = true;
      setPlanningMutation(true);
      try {
        const result = await getWorker().planSlotEdit({
          kind: 'slot',
          instanceId: instance.id,
          slotName,
          replacementSource,
        });
        return await applyPlannedMutation(result);
      } catch (error) {
        return {
          status: 'failed',
          message: error instanceof Error ? error.message : 'The component slot edit failed.',
        };
      } finally {
        mutationInFlightRef.current = false;
        setPlanningMutation(false);
      }
    },
    [applyPlannedMutation, getWorker]
  );

  const extract = useCallback(
    async (
      input: Omit<ExtractComponentInput, 'kind' | 'snapshot'>
    ): Promise<ComponentExtractionOutcome> => {
      if (!indexRef.current || !snapshotRef.current) {
        return { status: 'failed', message: 'The component catalog is not ready yet.' };
      }
      if (mutationInFlightRef.current) {
        return { status: 'failed', message: 'Another component edit is still being applied.' };
      }
      if (
        pendingMutationRef.current ||
        pendingRefactorRef.current ||
        pendingExtractionRef.current
      ) {
        return {
          status: 'failed',
          message: 'Review or cancel the pending component source changes first.',
        };
      }
      mutationInFlightRef.current = true;
      setPlanningMutation(true);
      try {
        const result = await getWorker().planExtract({ ...input, kind: 'extract' });
        if (result.status === 'needs-approval' || result.status === 'refused') return result;
        pendingExtractionRef.current = result.plan;
        setPendingExtraction(result.plan.preview);
        return { status: 'preview', preview: result.plan.preview };
      } catch (error) {
        return {
          status: 'failed',
          message: error instanceof Error ? error.message : 'Component extraction failed.',
        };
      } finally {
        mutationInFlightRef.current = false;
        setPlanningMutation(false);
      }
    },
    [getWorker]
  );

  const inline = useCallback(
    async (instance: ComponentInstance): Promise<ComponentExtractionOutcome> => {
      if (!indexRef.current || !snapshotRef.current) {
        return { status: 'failed', message: 'The component catalog is not ready yet.' };
      }
      if (mutationInFlightRef.current) {
        return { status: 'failed', message: 'Another component edit is still being applied.' };
      }
      if (
        pendingMutationRef.current ||
        pendingRefactorRef.current ||
        pendingExtractionRef.current
      ) {
        return {
          status: 'failed',
          message: 'Review or cancel the pending component source changes first.',
        };
      }
      mutationInFlightRef.current = true;
      setPlanningMutation(true);
      try {
        const result = await getWorker().planExtract({ kind: 'inline', instanceId: instance.id });
        if (result.status === 'needs-approval' || result.status === 'refused') return result;
        pendingExtractionRef.current = result.plan;
        setPendingExtraction(result.plan.preview);
        return { status: 'preview', preview: result.plan.preview };
      } catch (error) {
        return {
          status: 'failed',
          message: error instanceof Error ? error.message : 'Inline component transform failed.',
        };
      } finally {
        mutationInFlightRef.current = false;
        setPlanningMutation(false);
      }
    },
    [getWorker]
  );

  const confirmExtraction = useCallback(async (): Promise<ComponentExtractionOutcome> => {
    const pending = pendingExtractionRef.current;
    if (!pending) {
      return { status: 'failed', message: 'There is no pending component extraction to apply.' };
    }
    if (mutationInFlightRef.current) {
      return { status: 'failed', message: 'Another component edit is still being applied.' };
    }
    mutationInFlightRef.current = true;
    setPlanningMutation(true);
    try {
      const outcome = await applyPlannedMutation({ status: 'planned', plan: pending });
      clearPendingExtraction();
      if (outcome.status === 'applied') {
        const delta = pending.expectedGraphDelta;
        const refreshedIndex = indexRef.current;
        if (delta && refreshedIndex) {
          const original = refreshedIndex.components.find(
            (component) => component.id === delta.componentId
          );
          const created = delta.createdComponentId
            ? refreshedIndex.components.find(
                (component) => component.id === delta.createdComponentId
              )
            : null;
          if (
            !original ||
            original.usageCount !== delta.usagesAfter ||
            (delta.createdComponentId &&
              (!created || created.usageCount !== (delta.createdUsages ?? 0)))
          ) {
            return {
              status: 'failed',
              message:
                'The extraction changed source, but the refreshed catalog did not confirm the expected definition graph.',
            };
          }
        }
        return outcome;
      }
      if (outcome.status === 'failed') return outcome;
      return {
        status: 'failed',
        message: 'The component extraction still needs review before it can be applied.',
      };
    } catch (error) {
      clearPendingExtraction();
      return {
        status: 'failed',
        message: error instanceof Error ? error.message : 'Component extraction failed.',
      };
    } finally {
      mutationInFlightRef.current = false;
      setPlanningMutation(false);
    }
  }, [applyPlannedMutation, clearPendingExtraction]);

  const cancelExtraction = useCallback(() => {
    if (mutationInFlightRef.current) return;
    clearPendingExtraction();
  }, [clearPendingExtraction]);

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
    pendingMutation,
    pendingRefactor,
    pendingExtraction,
    confirmMutation,
    cancelMutation,
    duplicate,
    rename,
    deleteComponent,
    confirmRefactor,
    cancelRefactor,
    refresh,
    place,
    editProp,
    editSlot,
    extract,
    inline,
    confirmExtraction,
    cancelExtraction,
    bindSelection,
  };
}
