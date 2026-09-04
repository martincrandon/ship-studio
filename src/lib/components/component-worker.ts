import {
  COMPONENT_WORKER_PROTOCOL_VERSION,
  type ComponentWorkerRequest,
  type ComponentWorkerResponse,
} from './component-worker-protocol';
import {
  bindCoreComponentSelection,
  planCoreDeleteComponent,
  planCoreDuplicateComponent,
  planCoreExtractComponent,
  planCoreInsertComponent,
  planCoreRenameComponent,
  planCoreStaticPropEdit,
  planCoreStaticSlotEdit,
} from './component-worker-core';
import { validateReactMutation } from './mutation';
import { validateMarkupMutation } from './adapters/markup-utils';
import { ComponentIndexStore } from './index-store';
import { sha256 } from './ranges';
import type { ProjectType } from '@/lib/static-server';
import type {
  ComponentBinding,
  ComponentIndex,
  ComponentSourceSnapshot,
  MutationResult,
  ExtractionResult,
  RefactorResult,
} from './types';
export { COMPONENT_WORKER_PROTOCOL_VERSION } from './component-worker-protocol';
export type { ComponentWorkerRequest, ComponentWorkerResponse } from './component-worker-protocol';

let activeSnapshot: ComponentSourceSnapshot | null = null;
let activeIndex: ComponentIndex | null = null;
let indexStore: ComponentIndexStore | null = null;
let activeUsesAstroAdapter = false;
let fullComponentApiPromise: Promise<typeof import('./index')> | null = null;
const inFlightRequestIds = new Set<number>();
const cancelledRequestIds = new Set<number>();
const MAX_CANCELLED_REQUEST_IDS = 256;
// The worker endpoint can receive several messages before an async parse
// yields.  Build/update requests mutate the module-level catalog state, so
// every non-cancellation request is run through this queue.  Serializing the
// whole protocol (including bind/plan requests) also means those requests can
// never observe a catalog half-way between two published generations.
let requestQueue: Promise<void> = Promise.resolve();

function workerSuccess(
  id: number,
  result:
    | ComponentIndex
    | ComponentBinding
    | MutationResult
    | ExtractionResult
    | RefactorResult
    | null
): ComponentWorkerResponse {
  return { id, protocol: COMPONENT_WORKER_PROTOCOL_VERSION, ok: true, result };
}

function workerFailure(id: number, error: string): ComponentWorkerResponse {
  return { id, protocol: COMPONENT_WORKER_PROTOCOL_VERSION, ok: false, error };
}

function assertNotCancelled(id: number): void {
  if (!cancelledRequestIds.delete(id)) return;
  throw new Error('The component worker request was cancelled.');
}

function markCancelled(id: number): void {
  cancelledRequestIds.add(id);
  while (cancelledRequestIds.size > MAX_CANCELLED_REQUEST_IDS) {
    const oldest = cancelledRequestIds.values().next().value;
    if (oldest === undefined) break;
    cancelledRequestIds.delete(oldest);
  }
}

function requireCatalog() {
  if (!activeSnapshot || !activeIndex) {
    throw new Error('Build the component index before requesting bindings or mutations.');
  }
  return { snapshot: activeSnapshot, index: activeIndex };
}

async function validatePlan(
  result: MutationResult,
  snapshot: ComponentSourceSnapshot
): Promise<MutationResult> {
  if (result.status === 'refused') return result;
  const validation = await (async () => {
    if (result.plan.dialect === 'astro') {
      const { createAstroAdapter } = await import('./adapters/astro');
      return createAstroAdapter().validateMutationAsync({ plan: result.plan, snapshot });
    }
    return result.plan.dialect === 'react' ||
      result.plan.dialect === 'react-native' ||
      !result.plan.dialect
      ? validateReactMutation(
          { plan: result.plan, snapshot },
          result.plan.dialect === 'react-native' ? 'react-native' : 'react'
        )
      : validateMarkupMutation({ plan: result.plan, snapshot });
  })();
  if (validation.status === 'valid') return result;
  const diagnostic = validation.diagnostics[0];
  const code = (() => {
    if (diagnostic?.code === 'mutation-stale-hash') return 'stale-source' as const;
    if (diagnostic?.code === 'mutation-file-missing') return 'missing-source' as const;
    if (
      diagnostic?.code === 'mutation-invalid-range' ||
      diagnostic?.code === 'mutation-result-hash'
    ) {
      return 'invalid-range' as const;
    }
    return 'syntax-error' as const;
  })();
  return {
    status: 'refused',
    code,
    message: diagnostic?.message ?? 'The proposed component edit is invalid.',
    diagnostics: validation.diagnostics,
  };
}

export async function handleComponentWorkerRequest(
  request: ComponentWorkerRequest
): Promise<ComponentWorkerResponse> {
  if (request.protocol !== COMPONENT_WORKER_PROTOCOL_VERSION) {
    return workerFailure(
      request.id,
      `Unsupported component worker protocol ${String(request.protocol)}.`
    );
  }
  if (request.type === 'cancel') {
    // Message ordering normally makes this an in-flight id, but retaining a
    // bounded tombstone also handles a cancel posted in the same turn as a
    // request before the worker begins its async parse.
    markCancelled(request.cancelId);
    return workerSuccess(request.id, null);
  }

  const response = requestQueue.then(() => processComponentWorkerRequest(request));
  requestQueue = response.then(
    () => undefined,
    () => undefined
  );
  return response;
}

async function processComponentWorkerRequest(
  request: Exclude<ComponentWorkerRequest, { type: 'cancel' }>
): Promise<ComponentWorkerResponse> {
  inFlightRequestIds.add(request.id);
  try {
    assertNotCancelled(request.id);
    if (request.type === 'build') {
      const preparedSnapshot = await prepareWorkerSnapshot(request.snapshot);
      assertNotCancelled(request.id);
      const usesAstroAdapter = snapshotHasAstro(preparedSnapshot);
      const options = await indexStoreOptions(request.projectType, usesAstroAdapter);
      assertNotCancelled(request.id);
      const nextStore = new ComponentIndexStore();
      const nextIndex = nextStore.build(preparedSnapshot, options);
      assertNotCancelled(request.id);
      // Publish the complete generation together. No host-visible ref is
      // replaced while an asynchronous parser/options load is pending.
      activeSnapshot = preparedSnapshot;
      indexStore = nextStore;
      activeUsesAstroAdapter = usesAstroAdapter;
      activeIndex = nextIndex;
      return workerSuccess(request.id, activeIndex);
    }

    if (request.type === 'update') {
      if (!activeSnapshot || !activeIndex) {
        throw new Error('Build the component index before requesting an incremental update.');
      }
      if (request.changes.length > 256) {
        throw new Error('A component update may contain at most 256 changed files.');
      }
      const previousFiles = new Map(activeSnapshot.files.map((file) => [file.file, file]));
      const snapshotFiles = new Map(request.snapshot.files.map((file) => [file.file, file]));
      const requested = new Set<string>();
      for (const change of request.changes) {
        if (!change.file || requested.has(change.file)) {
          throw new Error('The component update contains a duplicate or empty changed path.');
        }
        requested.add(change.file);
        const previous = previousFiles.get(change.file);
        const next = snapshotFiles.get(change.file);
        if (change.kind === 'deleted' ? next !== undefined : next === undefined) {
          throw new Error('The component update did not match its changed-file set.');
        }
        if (next && next.contentHash !== sha256(next.content)) {
          throw new Error(`The component update has an invalid content hash for ${change.file}.`);
        }
        if (change.kind === 'created' && previous) {
          throw new Error(
            `The component update marked an existing file as created: ${change.file}.`
          );
        }
        if (change.kind === 'changed' && !previous) {
          throw new Error(`The component update marked a new file as changed: ${change.file}.`);
        }
      }
      const preparedSnapshot = await prepareWorkerSnapshot(request.snapshot);
      assertNotCancelled(request.id);
      const usesAstroAdapter = snapshotHasAstro(preparedSnapshot);
      const options = await indexStoreOptions(request.projectType, usesAstroAdapter);
      assertNotCancelled(request.id);
      const nextStore = indexStore ?? new ComponentIndexStore();
      const nextIndex =
        usesAstroAdapter === activeUsesAstroAdapter
          ? nextStore.update(preparedSnapshot, request.changes, options)
          : nextStore.build(preparedSnapshot, options);
      assertNotCancelled(request.id);
      activeSnapshot = preparedSnapshot;
      indexStore = nextStore;
      activeIndex = nextIndex;
      activeUsesAstroAdapter = usesAstroAdapter;
      return workerSuccess(request.id, activeIndex);
    }

    const { snapshot, index } = requireCatalog();
    const fullApi = activeUsesAstroAdapter ? await loadFullComponentApi() : null;
    if (request.type === 'bind') {
      return workerSuccess(
        request.id,
        fullApi
          ? fullApi.bindComponentSelection(request.input, index)
          : bindCoreComponentSelection(request.input, index)
      );
    }
    if (request.type === 'planInsert') {
      return workerSuccess(
        request.id,
        await validatePlan(
          fullApi
            ? fullApi.planInsertComponent(request.input, index, snapshot)
            : planCoreInsertComponent(request.input, index, snapshot),
          snapshot
        )
      );
    }
    if (request.type === 'planDuplicate') {
      return workerSuccess(
        request.id,
        fullApi
          ? fullApi.planDuplicateComponent(request.input, index, snapshot)
          : planCoreDuplicateComponent(request.input, index, snapshot)
      );
    }
    if (request.type === 'planRename') {
      return workerSuccess(
        request.id,
        fullApi
          ? fullApi.planRenameComponent(request.input, index, snapshot)
          : planCoreRenameComponent(request.input, index, snapshot)
      );
    }
    if (request.type === 'planDelete') {
      return workerSuccess(
        request.id,
        fullApi
          ? fullApi.planDeleteComponent(request.input, index, snapshot)
          : planCoreDeleteComponent(request.input, index, snapshot)
      );
    }
    if (request.type === 'planSlotEdit') {
      return workerSuccess(
        request.id,
        await validatePlan(
          fullApi
            ? fullApi.planStaticSlotEdit(request.input, index, snapshot)
            : planCoreStaticSlotEdit(request.input, index, snapshot),
          snapshot
        )
      );
    }
    if (request.type === 'planExtract') {
      const result = fullApi
        ? fullApi.planExtractComponent(request.input, index, snapshot)
        : planCoreExtractComponent(request.input, index, snapshot);
      if (result.status !== 'planned') return workerSuccess(request.id, result);
      const validation = validateReactMutation({ plan: result.plan, snapshot });
      if (validation.status === 'invalid') {
        return workerSuccess(request.id, {
          status: 'refused',
          code: 'syntax-error',
          message: validation.diagnostics[0]?.message ?? 'The extraction plan is invalid.',
          diagnostics: validation.diagnostics,
        });
      }
      return workerSuccess(request.id, result);
    }
    return workerSuccess(
      request.id,
      await validatePlan(
        fullApi
          ? fullApi.planStaticPropEdit(request.input, index, snapshot)
          : planCoreStaticPropEdit(request.input, index, snapshot),
        snapshot
      )
    );
  } catch (error) {
    return workerFailure(
      request.id,
      error instanceof Error ? error.message : 'Component worker request failed.'
    );
  } finally {
    inFlightRequestIds.delete(request.id);
    cancelledRequestIds.delete(request.id);
  }
}

async function prepareWorkerSnapshot(
  snapshot: ComponentSourceSnapshot
): Promise<ComponentSourceSnapshot> {
  if (!snapshotHasAstro(snapshot)) return snapshot;
  const { validateAstroDocument } = await import('./astro-parser');
  const astroFiles = snapshot.files.filter((file) => file.file.toLowerCase().endsWith('.astro'));
  const parserDiagnostics = (
    await Promise.all(astroFiles.map((file) => validateAstroDocument(file)))
  ).flat();
  return parserDiagnostics.length === 0
    ? snapshot
    : { ...snapshot, diagnostics: [...snapshot.diagnostics, ...parserDiagnostics] };
}

function snapshotHasAstro(snapshot: ComponentSourceSnapshot): boolean {
  return snapshot.files.some((file) => file.file.toLowerCase().endsWith('.astro'));
}

async function loadFullComponentApi() {
  fullComponentApiPromise ??= import('./index');
  return fullComponentApiPromise;
}

async function indexStoreOptions(projectType: ProjectType | null, useAstroAdapter: boolean) {
  if (!useAstroAdapter) return { projectType };
  const api = await loadFullComponentApi();
  return { projectType, adapters: api.createComponentAdapters() };
}

interface WorkerEndpoint {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<ComponentWorkerRequest>) => void
  ): void;
  postMessage(message: ComponentWorkerResponse): void;
}

const workerEndpoint = globalThis as unknown as WorkerEndpoint;
if (typeof globalThis.addEventListener === 'function') {
  workerEndpoint.addEventListener('message', (event) => {
    void handleComponentWorkerRequest(event.data).then((response) =>
      workerEndpoint.postMessage(response)
    );
  });
}
