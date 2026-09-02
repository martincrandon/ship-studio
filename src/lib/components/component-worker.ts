import type { ProjectType } from '@/lib/static-server';
import {
  bindComponentSelection,
  buildComponentIndex,
  planInsertComponent,
  planStaticPropEdit,
} from './index';
import { validateReactMutation } from './mutation';
import type {
  ComponentBinding,
  ComponentIndex,
  ComponentSourceSnapshot,
  EditComponentPropInput,
  InsertComponentInput,
  MutationResult,
  SelectionBindingInput,
} from './types';

export type ComponentWorkerRequest =
  | {
      id: number;
      type: 'build';
      snapshot: ComponentSourceSnapshot;
      projectType: ProjectType | null;
    }
  | { id: number; type: 'bind'; input: SelectionBindingInput }
  | { id: number; type: 'planInsert'; input: InsertComponentInput }
  | { id: number; type: 'planPropEdit'; input: EditComponentPropInput };

export type ComponentWorkerResponse =
  | { id: number; ok: true; result: ComponentIndex | ComponentBinding | MutationResult }
  | { id: number; ok: false; error: string };

let activeSnapshot: ComponentSourceSnapshot | null = null;
let activeIndex: ComponentIndex | null = null;

function requireCatalog() {
  if (!activeSnapshot || !activeIndex) {
    throw new Error('Build the component index before requesting bindings or mutations.');
  }
  return { snapshot: activeSnapshot, index: activeIndex };
}

function validatePlan(result: MutationResult, snapshot: ComponentSourceSnapshot): MutationResult {
  if (result.status === 'refused') return result;
  const validation = validateReactMutation({ plan: result.plan, snapshot });
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

export function handleComponentWorkerRequest(
  request: ComponentWorkerRequest
): ComponentWorkerResponse {
  try {
    if (request.type === 'build') {
      activeSnapshot = request.snapshot;
      activeIndex = buildComponentIndex(request.snapshot, { projectType: request.projectType });
      return { id: request.id, ok: true, result: activeIndex };
    }

    const { snapshot, index } = requireCatalog();
    if (request.type === 'bind') {
      return {
        id: request.id,
        ok: true,
        result: bindComponentSelection(request.input, index),
      };
    }
    if (request.type === 'planInsert') {
      return {
        id: request.id,
        ok: true,
        result: validatePlan(planInsertComponent(request.input, index, snapshot), snapshot),
      };
    }
    return {
      id: request.id,
      ok: true,
      result: validatePlan(planStaticPropEdit(request.input, index, snapshot), snapshot),
    };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : 'Component worker request failed.',
    };
  }
}

interface WorkerEndpoint {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<ComponentWorkerRequest>) => void
  ): void;
  postMessage(message: ComponentWorkerResponse): void;
}

const workerEndpoint = globalThis as unknown as WorkerEndpoint;
workerEndpoint.addEventListener('message', (event) => {
  workerEndpoint.postMessage(handleComponentWorkerRequest(event.data));
});
