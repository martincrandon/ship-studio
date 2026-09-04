/**
 * Worker-safe component operations for the non-Astro dialects.
 *
 * Keep this module free of the Astro adapter. It is imported by the worker's
 * hot path so React/Next projects can build their source index in a packaged
 * WebKit view without loading the optional Astro compiler/WASM module. The
 * full public API remains in `index.ts`; the worker loads it lazily when an
 * Astro source file is actually present.
 */

import { createReactAdapter } from './adapters/react';
import { createVueAdapter } from './adapters/vue';
import { createSvelteAdapter } from './adapters/svelte';
import { createShopifyAdapter } from './adapters/shopify';
import { createWebComponentAdapter } from './adapters/web-components';
import { createReactNativeAdapter } from './adapters/react-native';
import type { ComponentAdapter } from './adapters/types';
import { planStaticSlotEdit as planSlot } from './slots';
import { planExtractComponent as planExtract } from './extraction';
import {
  planInsertComponent as planReactInsert,
  planStaticPropEdit as planReactPropEdit,
} from './mutation';
import { planDuplicateComponent as planReactDuplicate } from './refactors';
import { planDeleteComponent as planReactDelete } from './refactors';
import { planRenameComponent as planReactRename } from './refactors';
import type {
  ComponentBinding,
  ComponentIndex,
  ComponentSourceSnapshot,
  DeleteComponentInput,
  DuplicateComponentInput,
  EditComponentPropInput,
  EditComponentSlotInput,
  ComponentExtractionInput,
  ExtractionResult,
  InsertComponentInput,
  MutationResult,
  RefactorResult,
  RenameComponentInput,
  SelectionBindingInput,
} from './types';

export function bindCoreComponentSelection(
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

export function planCoreInsertComponent(
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

export function planCoreStaticPropEdit(
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

export function planCoreStaticSlotEdit(
  input: EditComponentSlotInput,
  index: ComponentIndex,
  snapshot?: ComponentSourceSnapshot
): MutationResult {
  const instance = index.instances.find((item) => item.id === input.instanceId);
  const component = index.components.find((item) => item.id === instance?.componentId);
  if (!component) return planSlot(input, index, snapshot);
  const adapter = adapterForDialect(component.dialect);
  if (adapter?.planSlotEdit) {
    return adapter.planSlotEdit({ ...input, snapshot: snapshot ?? input.snapshot }, index);
  }
  return planSlot({ ...input, snapshot: snapshot ?? input.snapshot }, index, snapshot);
}

export function planCoreExtractComponent(
  input: ComponentExtractionInput,
  index: ComponentIndex,
  snapshot?: ComponentSourceSnapshot
): ExtractionResult {
  return planExtract({ ...input, snapshot: snapshot ?? input.snapshot }, index, snapshot);
}

export function planCoreDuplicateComponent(
  input: DuplicateComponentInput,
  index: ComponentIndex,
  snapshot?: ComponentSourceSnapshot
): RefactorResult {
  const component = index.components.find((item) => item.id === input.componentId);
  if (component?.dialect !== 'react') {
    return unsupportedRefactor('duplication');
  }
  return planReactDuplicate(input, index, snapshot);
}

export function planCoreRenameComponent(
  input: RenameComponentInput,
  index: ComponentIndex,
  snapshot?: ComponentSourceSnapshot
): RefactorResult {
  const component = index.components.find((item) => item.id === input.componentId);
  if (component?.dialect !== 'react') return unsupportedRefactor('renaming');
  return planReactRename(input, index, snapshot);
}

export function planCoreDeleteComponent(
  input: DeleteComponentInput,
  index: ComponentIndex,
  snapshot?: ComponentSourceSnapshot
): RefactorResult {
  const component = index.components.find((item) => item.id === input.componentId);
  if (component?.dialect !== 'react') return unsupportedRefactor('deletion');
  return planReactDelete(input, index, snapshot);
}

export function coreAdapterForInput(
  input: SelectionBindingInput,
  index: ComponentIndex
): ComponentAdapter | null {
  const renderer = input.candidates?.find(
    (candidate) => candidate.renderer !== 'unknown'
  )?.renderer;
  const dialect = renderer ?? index.profile.primaryDialect;
  return dialect && dialect !== 'unknown' ? adapterForDialect(dialect) : null;
}

function adapterForInput(
  input: SelectionBindingInput,
  index: ComponentIndex
): ComponentAdapter | null {
  return coreAdapterForInput(input, index);
}

function adapterForDialect(
  dialect: NonNullable<ComponentIndex['profile']['primaryDialect']>
): ComponentAdapter | null {
  switch (dialect) {
    case 'react':
      return createReactAdapter();
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
    case 'astro':
    case 'flutter':
      return null;
  }
}

function unsupportedRefactor(operation: string): RefactorResult {
  const message = `Definition ${operation} is currently available for React components only.`;
  return {
    status: 'refused',
    code: 'unsupported',
    message,
    diagnostics: [{ code: 'refactor-unsupported', severity: 'info', message }],
  };
}
