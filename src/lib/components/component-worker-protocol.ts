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

/** Increment when the worker wire shape or cancellation semantics change. */
export const COMPONENT_WORKER_PROTOCOL_VERSION = 1 as const;
type ComponentWorkerProtocol = typeof COMPONENT_WORKER_PROTOCOL_VERSION;

export type ComponentWorkerRequest =
  | {
      id: number;
      protocol: ComponentWorkerProtocol;
      type: 'build';
      snapshot: ComponentSourceSnapshot;
      projectType: ProjectType | null;
    }
  | {
      id: number;
      protocol: ComponentWorkerProtocol;
      type: 'update';
      snapshot: ComponentSourceSnapshot;
      changes: SourceFileChange[];
      projectType: ProjectType | null;
    }
  | { id: number; protocol: ComponentWorkerProtocol; type: 'bind'; input: SelectionBindingInput }
  | {
      id: number;
      protocol: ComponentWorkerProtocol;
      type: 'planInsert';
      input: InsertComponentInput;
    }
  | {
      id: number;
      protocol: ComponentWorkerProtocol;
      type: 'planPropEdit';
      input: EditComponentPropInput;
    }
  | {
      id: number;
      protocol: ComponentWorkerProtocol;
      type: 'planSlotEdit';
      input: EditComponentSlotInput;
    }
  | {
      id: number;
      protocol: ComponentWorkerProtocol;
      type: 'planExtract';
      input: ComponentExtractionInput;
    }
  | {
      id: number;
      protocol: ComponentWorkerProtocol;
      type: 'planDuplicate';
      input: DuplicateComponentInput;
    }
  | {
      id: number;
      protocol: ComponentWorkerProtocol;
      type: 'planRename';
      input: RenameComponentInput;
    }
  | {
      id: number;
      protocol: ComponentWorkerProtocol;
      type: 'planDelete';
      input: DeleteComponentInput;
    }
  | {
      id: number;
      protocol: ComponentWorkerProtocol;
      type: 'cancel';
      cancelId: number;
    };

export type ComponentWorkerResponse =
  | {
      id: number;
      protocol: ComponentWorkerProtocol;
      ok: true;
      result:
        | ComponentIndex
        | ComponentBinding
        | MutationResult
        | ExtractionResult
        | RefactorResult
        | null;
    }
  | { id: number; protocol: ComponentWorkerProtocol; ok: false; error: string };
