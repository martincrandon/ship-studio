import type { ProjectType } from '@/lib/static-server';
import type {
  ComponentBinding,
  ComponentIndex,
  ComponentSourceSnapshot,
  EditComponentPropInput,
  InsertComponentInput,
  MutationResult,
  SelectionBindingInput,
} from './types';
import type { ComponentWorkerRequest, ComponentWorkerResponse } from './component-worker';

type RequestWithoutId = ComponentWorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, 'id'>
    : never
  : never;

export class ComponentWorkerClient {
  private readonly worker = new Worker(new URL('./component-worker.ts', import.meta.url), {
    type: 'module',
    name: 'ship-studio-components',
  });

  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor() {
    this.worker.addEventListener('message', (event: MessageEvent<ComponentWorkerResponse>) => {
      const request = this.pending.get(event.data.id);
      if (!request) return;
      this.pending.delete(event.data.id);
      if (event.data.ok) request.resolve(event.data.result);
      else request.reject(new Error(event.data.error));
    });
    this.worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'The component index worker stopped unexpectedly.');
      this.pending.forEach((request) => request.reject(error));
      this.pending.clear();
    });
  }

  build(snapshot: ComponentSourceSnapshot, projectType: ProjectType | null) {
    return this.request<ComponentIndex>({ type: 'build', snapshot, projectType });
  }

  bind(input: SelectionBindingInput) {
    return this.request<ComponentBinding>({ type: 'bind', input });
  }

  planInsert(input: InsertComponentInput) {
    return this.request<MutationResult>({ type: 'planInsert', input });
  }

  planPropEdit(input: EditComponentPropInput) {
    return this.request<MutationResult>({ type: 'planPropEdit', input });
  }

  terminate() {
    this.worker.terminate();
    const error = new Error('The component index worker was terminated.');
    this.pending.forEach((request) => request.reject(error));
    this.pending.clear();
  }

  private request<Result>(request: RequestWithoutId): Promise<Result> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<Result>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as Result),
        reject,
      });
      try {
        this.worker.postMessage({ ...request, id } satisfies ComponentWorkerRequest);
      } catch (error) {
        this.pending.delete(id);
        reject(
          error instanceof Error ? error : new Error('Could not contact the component worker.')
        );
      }
    });
  }
}
