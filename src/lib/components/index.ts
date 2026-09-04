import { createReactAdapter } from './adapters/react';
import { createAstroAdapter } from './adapters/astro';
import { createVueAdapter } from './adapters/vue';
import { createSvelteAdapter } from './adapters/svelte';
import { createShopifyAdapter } from './adapters/shopify';
import { createWebComponentAdapter } from './adapters/web-components';
import { createReactNativeAdapter } from './adapters/react-native';
import { ComponentIndexStore } from './index-store';
import type { ComponentAdapter } from './adapters/types';
import type { ProjectType } from '@/lib/static-server';
import type {
  ComponentBinding,
  ComponentIndex,
  ComponentSourceSnapshot,
  DeleteComponentInput,
  DuplicateComponentInput,
  RenameComponentInput,
  EditComponentPropInput,
  EditComponentSlotInput,
  ComponentExtractionInput,
  ExtractionResult,
  InsertComponentInput,
  MutationResult,
  RefactorResult,
  SelectionBindingInput,
} from './types';
import { planStaticSlotEdit as planSlot } from './slots';
import { planStructuredSlotEdit as planStructuredSlot } from './slots';
import { planExtractComponent as planExtract } from './extraction';
import {
  planInsertComponent as planReactInsert,
  planStaticPropEdit as planReactPropEdit,
} from './mutation';
import { planDuplicateComponent as planReactDuplicate } from './refactors';
import { planDeleteComponent as planReactDelete } from './refactors';
import { planRenameComponent as planReactRename } from './refactors';

export { previewComponentMutation, REACT_COMPONENT_PLAN_PARSER_TOKEN } from './mutation';
export { planStructuredSlotEdit, populateSlotChildren } from './slots';
export {
  discoverComponentLibraries,
  libraryForComponent,
  planLibraryFork,
  withComponentLibraries,
} from './libraries';
export type {
  ComponentIndexWithLibraries,
  ComponentLibraryMetadata,
  ComponentLibraryOwnership,
  LibraryForkInput,
  LibraryForkRefusalCode,
  LibraryForkResult,
} from './libraries';

export { usageReportForResolution } from './usage';

export interface BuildComponentIndexOptions {
  projectType?: ProjectType | null;
  adapters?: readonly ComponentAdapter[];
}

/**
 * Construct the complete adapter set for source-only callers. The worker does
 * not use this eager list: it loads this module lazily only for Astro
 * snapshots, keeping the optional compiler/WASM runtime out of the normal
 * React/Next worker startup path.
 */
export function createComponentAdapters(): readonly ComponentAdapter[] {
  return [
    createReactAdapter(),
    createAstroAdapter(),
    createVueAdapter(),
    createSvelteAdapter(),
    createShopifyAdapter(),
    createWebComponentAdapter(),
    createReactNativeAdapter(),
  ];
}

/**
 * Pure, non-executing source index build. The adapter receives only source
 * snapshots and returns serializable DTOs; compiler ASTs never leave this call
 * (or the worker that calls it).
 */
export function buildComponentIndex(
  snapshot: ComponentSourceSnapshot,
  options: BuildComponentIndexOptions = {}
): ComponentIndex {
  return new ComponentIndexStore().build(snapshot, {
    ...options,
    adapters: options.adapters?.length ? options.adapters : createComponentAdapters(),
  });
}

/** Bind a runtime/source candidate to the current immutable index. */
export function bindComponentSelection(
  input: SelectionBindingInput,
  index: ComponentIndex
): ComponentBinding {
  const adapter = adapterForInput(input, index);
  return adapter
    ? adapter.bindSelection(input, index)
    : {
        confidence: 'none',
        candidates: [],
        diagnostics: [
          {
            code: 'components-no-adapter',
            severity: 'info',
            message: 'No component adapter matches the selection source.',
          },
        ],
      };
}

/** Plan a minimal React JSX insertion from a source or exact-range anchor. */
export function planInsertComponent(
  input: InsertComponentInput,
  index: ComponentIndex,
  snapshot?: ComponentSourceSnapshot
): MutationResult {
  const component = index.components.find((item) => item.id === input.componentId);
  const adapter = component ? adapterForDialect(component.dialect) : null;
  if (adapter && component?.dialect !== 'react') {
    return adapter.planInsert({ ...input, snapshot: snapshot ?? input.snapshot }, index);
  }
  return planReactInsert(input, index, snapshot);
}

/** Plan a minimal edit to an existing statically-authored JSX prop. */
export function planStaticPropEdit(
  input: EditComponentPropInput,
  index: ComponentIndex,
  snapshot?: ComponentSourceSnapshot
): MutationResult {
  const instance = index.instances.find((item) => item.id === input.instanceId);
  const component = index.components.find((item) => item.id === instance?.componentId);
  const adapter = component ? adapterForDialect(component.dialect) : null;
  if (adapter && component?.dialect !== 'react') {
    return adapter.planPropEdit({ ...input, snapshot: snapshot ?? input.snapshot }, index);
  }
  return planReactPropEdit(input, index, snapshot);
}

/** Plan a static default/named slot edit through the owning dialect contract. */
export function planStaticSlotEdit(
  input: EditComponentSlotInput,
  index: ComponentIndex,
  snapshot?: ComponentSourceSnapshot
): MutationResult {
  const instance = index.instances.find((item) => item.id === input.instanceId);
  const component = index.components.find((item) => item.id === instance?.componentId);
  if (!component) {
    return planSlot(input, index, snapshot);
  }
  const adapter = adapterForDialect(component.dialect);
  if (adapter?.planSlotEdit) {
    return adapter.planSlotEdit({ ...input, snapshot: snapshot ?? input.snapshot }, index);
  }
  return planSlot({ ...input, snapshot: snapshot ?? input.snapshot }, index, snapshot);
}

/** Plan a structured insert/remove/reorder in a source-proven slot. */
export function planComponentSlotComposition(
  input: EditComponentSlotInput,
  index: ComponentIndex,
  snapshot?: ComponentSourceSnapshot
): MutationResult {
  return input.operation && input.operation !== 'replace'
    ? planStructuredSlot(input, index, snapshot)
    : planStaticSlotEdit(input, index, snapshot);
}

/** Plan a two-round, explicitly approved React extraction. */
export function planExtractComponent(
  input: ComponentExtractionInput,
  index: ComponentIndex,
  snapshot?: ComponentSourceSnapshot
): ExtractionResult {
  return planExtract({ ...input, snapshot: snapshot ?? input.snapshot }, index, snapshot);
}

/** Plan a reviewed React definition duplicate; other dialects remain read-only. */
export function planDuplicateComponent(
  input: DuplicateComponentInput,
  index: ComponentIndex,
  snapshot?: ComponentSourceSnapshot
): RefactorResult {
  const component = index.components.find((item) => item.id === input.componentId);
  if (component?.dialect !== 'react') {
    return {
      status: 'refused',
      code: 'unsupported',
      message: 'Definition duplication is currently available for React components only.',
      diagnostics: [
        {
          code: 'refactor-unsupported',
          severity: 'info',
          message: 'Definition duplication is currently available for React components only.',
        },
      ],
    };
  }
  return planReactDuplicate(input, index, snapshot);
}

/** Plan a reviewed React named-export rename; other dialects remain read-only. */
export function planRenameComponent(
  input: RenameComponentInput,
  index: ComponentIndex,
  snapshot?: ComponentSourceSnapshot
): RefactorResult {
  const component = index.components.find((item) => item.id === input.componentId);
  if (component?.dialect !== 'react') {
    return {
      status: 'refused',
      code: 'unsupported',
      message: 'Definition renaming is currently available for React components only.',
      diagnostics: [
        {
          code: 'refactor-unsupported',
          severity: 'info',
          message: 'Definition renaming is currently available for React components only.',
        },
      ],
    };
  }
  return planReactRename(input, index, snapshot);
}

/** Plan a reviewed React named-export delete; other dialects remain read-only. */
export function planDeleteComponent(
  input: DeleteComponentInput,
  index: ComponentIndex,
  snapshot?: ComponentSourceSnapshot
): RefactorResult {
  const component = index.components.find((item) => item.id === input.componentId);
  if (component?.dialect !== 'react') {
    return {
      status: 'refused',
      code: 'unsupported',
      message: 'Definition deletion is currently available for React components only.',
      diagnostics: [
        {
          code: 'refactor-unsupported',
          severity: 'info',
          message: 'Definition deletion is currently available for React components only.',
        },
      ],
    };
  }
  return planReactDelete(input, index, snapshot);
}

export function adapterForInput(
  input: SelectionBindingInput,
  index: ComponentIndex
): ComponentAdapter | null {
  const renderer = input.candidates?.find(
    (candidate) => candidate.renderer !== 'unknown'
  )?.renderer;
  const dialect = renderer ?? index.profile.primaryDialect;
  return dialect && dialect !== 'unknown' ? adapterForDialect(dialect) : null;
}

function adapterForDialect(
  dialect: NonNullable<ComponentIndex['profile']['primaryDialect']>
): ComponentAdapter | null {
  switch (dialect) {
    case 'react':
      return createReactAdapter();
    case 'astro':
      return createAstroAdapter();
    case 'vue':
      return createVueAdapter();
    case 'svelte':
      return createSvelteAdapter();
    case 'shopify':
      return createShopifyAdapter();
    case 'web-component':
      return createWebComponentAdapter();
    case 'react-native':
      return createReactNativeAdapter();
    case 'flutter':
      return null;
  }
}
