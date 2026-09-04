import { invoke } from '@tauri-apps/api/core';
import type {
  AppliedComponentMutation,
  ComponentMutationPlan,
  ComponentSourceChangeEvent,
  ComponentSourceSnapshot,
  SourceFileSnapshot,
} from './types';

export const COMPONENT_SOURCE_CHANGED_EVENT = 'component-source-changed';

/** Typed boundary for the bounded Rust component inventory. */
export function getComponentSourceSnapshot(projectPath: string) {
  return invoke<ComponentSourceSnapshot>('get_component_source_snapshot', { projectPath });
}

/** Read only paths requested by a validated worker resolution round. */
export function readComponentSourceBatch(
  projectPath: string,
  relativePaths: string[],
  expectedRevision: string
) {
  return invoke<SourceFileSnapshot[]>('read_component_source_batch', {
    projectPath,
    relativePaths,
    expectedRevision,
  });
}

/** Start the one-per-window debounced source watcher. */
export function startComponentSourceWatch(windowLabel: string, projectPath: string) {
  return invoke<void>('start_component_source_watch', { windowLabel, projectPath });
}

/** Stop the source watcher owned by a window/project session. */
export function stopComponentSourceWatch(windowLabel: string, projectPath: string) {
  return invoke<void>('stop_component_source_watch', { windowLabel, projectPath });
}

/** Apply a parser-planned, hash-guarded mutation through Rust. */
export function applyComponentMutation(projectPath: string, plan: ComponentMutationPlan) {
  return invoke<AppliedComponentMutation>('apply_component_mutation', { projectPath, plan });
}

export type { ComponentSourceChangeEvent };
