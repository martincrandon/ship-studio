import type { ProjectType } from '@/lib/static-server';
import type {
  ComponentBinding,
  ComponentIndex,
  ComponentSourceSnapshot,
  SourceFileChange,
  DeleteComponentInput,
  DuplicateComponentInput,
  RenameComponentInput,
  EditComponentPropInput,
  EditComponentSlotInput,
  ComponentExtractionInput,
  InsertComponentInput,
  ExtractionResult,
  MutationResult,
  RefactorResult,
  SelectionBindingInput,
} from './types';
import {
  COMPONENT_WORKER_PROTOCOL_VERSION,
  type ComponentWorkerRequest,
  type ComponentWorkerResponse,
} from './component-worker-protocol';

type RequestWithoutId = ComponentWorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Request extends { type: 'cancel' }
      ? never
      : Omit<Request, 'id' | 'protocol'>
    : never
  : never;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup?: () => void;
};

export class ComponentWorkerClient {
  private readonly worker = new Worker(new URL('./component-worker.ts', import.meta.url), {
    type: 'module',
    name: 'ship-studio-components',
  });

  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor() {
    this.worker.addEventListener('message', (event: MessageEvent<ComponentWorkerResponse>) => {
      const request = this.pending.get(event.data.id);
      if (!request) return;
      this.pending.delete(event.data.id);
      request.cleanup?.();
      if (event.data.protocol !== COMPONENT_WORKER_PROTOCOL_VERSION) {
        request.reject(new Error('The component index worker returned an unsupported protocol.'));
        return;
      }
      if (event.data.ok) request.resolve(event.data.result);
      else request.reject(new Error(event.data.error));
    });
    this.worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'The component index worker stopped unexpectedly.');
      this.pending.forEach((request) => {
        request.cleanup?.();
        request.reject(error);
      });
      this.pending.clear();
    });
  }

  build(snapshot: ComponentSourceSnapshot, projectType: ProjectType | null, signal?: AbortSignal) {
    return this.request<ComponentIndex>({ type: 'build', snapshot, projectType }, signal);
  }

  update(
    snapshot: ComponentSourceSnapshot,
    changes: SourceFileChange[],
    projectType: ProjectType | null,
    signal?: AbortSignal
  ) {
    return this.request<ComponentIndex>({ type: 'update', snapshot, changes, projectType }, signal);
  }

  bind(input: SelectionBindingInput, signal?: AbortSignal) {
    return this.request<ComponentBinding>({ type: 'bind', input }, signal);
  }

  planInsert(input: InsertComponentInput, signal?: AbortSignal) {
    return this.request<MutationResult>({ type: 'planInsert', input }, signal);
  }

  planPropEdit(input: EditComponentPropInput, signal?: AbortSignal) {
    return this.request<MutationResult>({ type: 'planPropEdit', input }, signal);
  }

  planSlotEdit(input: EditComponentSlotInput, signal?: AbortSignal) {
    return this.request<MutationResult>({ type: 'planSlotEdit', input }, signal);
  }

  planExtract(input: ComponentExtractionInput, signal?: AbortSignal) {
    return this.request<ExtractionResult>({ type: 'planExtract', input }, signal);
  }

  planDuplicate(input: DuplicateComponentInput, signal?: AbortSignal) {
    return this.request<RefactorResult>({ type: 'planDuplicate', input }, signal);
  }

  planRename(input: RenameComponentInput, signal?: AbortSignal) {
    return this.request<RefactorResult>({ type: 'planRename', input }, signal);
  }

  planDelete(input: DeleteComponentInput, signal?: AbortSignal) {
    return this.request<RefactorResult>({ type: 'planDelete', input }, signal);
  }

  /** Ask the worker to stop an in-flight async parse/index request. */
  cancel(requestId: number) {
    const id = this.nextId;
    this.nextId += 1;
    try {
      this.worker.postMessage({
        id,
        protocol: COMPONENT_WORKER_PROTOCOL_VERSION,
        type: 'cancel',
        cancelId: requestId,
      } satisfies ComponentWorkerRequest);
    } catch {
      // The original request is already rejected by the caller; termination
      // or a closed worker should not turn cancellation into a second error.
    }
  }

  terminate() {
    this.worker.terminate();
    const error = new Error('The component index worker was terminated.');
    this.pending.forEach((request) => {
      request.cleanup?.();
      request.reject(error);
    });
    this.pending.clear();
  }

  private request<Result>(request: RequestWithoutId, signal?: AbortSignal): Promise<Result> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<Result>((resolve, reject) => {
      const abortError = () => new Error('The component worker request was cancelled.');
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(abortError());
        this.cancel(id);
      };
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      this.pending.set(id, {
        resolve: (value) => resolve(value as Result),
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.worker.postMessage({
          ...request,
          id,
          protocol: COMPONENT_WORKER_PROTOCOL_VERSION,
        } satisfies ComponentWorkerRequest);
      } catch (error) {
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        reject(
          error instanceof Error ? error : new Error('Could not contact the component worker.')
        );
      }
    });
  }
}
