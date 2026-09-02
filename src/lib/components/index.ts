import { createReactAdapter } from './adapters/react';
import { sha256 } from './ranges';
import type {
  ComponentAdapter,
  DialectDetection,
  GraphContext,
  ParseContext,
} from './adapters/types';
import type { ProjectType } from '@/lib/static-server';
import type {
  ComponentBinding,
  ComponentCapabilities,
  ComponentDialect,
  ComponentFrameworkProfile,
  ComponentIndex,
  ComponentSourceSnapshot,
  EditComponentPropInput,
  InsertComponentInput,
  MutationResult,
  SelectionBindingInput,
} from './types';
import {
  planInsertComponent as planReactInsert,
  planStaticPropEdit as planReactPropEdit,
} from './mutation';

export interface BuildComponentIndexOptions {
  projectType?: ProjectType | null;
  adapters?: readonly ComponentAdapter[];
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
  const adapters = options.adapters?.length ? options.adapters : [createReactAdapter()];
  const detections = adapters.map((adapter) => ({
    adapter,
    detection: adapter.detect({ files: snapshot.files, projectType: options.projectType }),
  }));
  const detected = detections.filter(({ detection }) => detection.detected);
  const profile = profileForSnapshot(snapshot, options.projectType ?? null, detections);
  const components = [] as ComponentIndex['components'];
  const instances = [] as ComponentIndex['instances'];
  const importEdges = [] as ComponentIndex['importEdges'];
  const diagnostics = [...snapshot.diagnostics, ...profile.diagnostics];
  for (const { adapter } of detected) {
    const adapterFiles = snapshot.files.filter((file) => adapter.accepts(file.file));
    const parsed = adapterFiles.map((file) =>
      adapter.parseFile(file, {
        workspaceRoot: snapshot.workspaceRoot,
        knownFiles: snapshot.files,
      } satisfies ParseContext)
    );
    const graph = adapter.buildUsageGraph(parsed, {
      workspaceRoot: snapshot.workspaceRoot,
      files: parsed,
      revision: snapshot.revision,
    } satisfies GraphContext);
    components.push(...graph.components);
    instances.push(...graph.instances);
    importEdges.push(...graph.importEdges);
    diagnostics.push(...graph.diagnostics);
  }
  return {
    revision:
      snapshot.revision ||
      sha256(snapshot.files.map((file) => `${file.file}:${file.contentHash}`).join('\n')),
    partial:
      snapshot.partial ||
      diagnostics.some(
        (diagnostic) => diagnostic.severity === 'warning' || diagnostic.severity === 'error'
      ),
    profile,
    components,
    instances,
    importEdges,
    diagnostics,
  };
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
  return planReactInsert(input, index, snapshot);
}

/** Plan a minimal edit to an existing statically-authored JSX prop. */
export function planStaticPropEdit(
  input: EditComponentPropInput,
  index: ComponentIndex,
  snapshot?: ComponentSourceSnapshot
): MutationResult {
  return planReactPropEdit(input, index, snapshot);
}

export function adapterForInput(
  input: SelectionBindingInput,
  index: ComponentIndex
): ComponentAdapter | null {
  const renderer = input.candidates?.find(
    (candidate) => candidate.renderer !== 'unknown'
  )?.renderer;
  const dialect = renderer ?? index.profile.primaryDialect;
  if (dialect === 'react') return createReactAdapter();
  return null;
}

function profileForSnapshot(
  snapshot: ComponentSourceSnapshot,
  projectType: ProjectType | null,
  detections: readonly { adapter: ComponentAdapter; detection: DialectDetection }[]
): ComponentFrameworkProfile {
  const detected = detections.filter(({ detection }) => detection.detected);
  const diagnostics = detections.flatMap(({ detection }) => detection.diagnostics);
  const dialects = detected.map(({ adapter }) => adapter.dialect);
  const primaryDialect = dialects.includes('react') ? 'react' : (dialects[0] ?? null);
  const capabilities = emptyCapabilities();
  for (const { adapter } of detected) {
    const placeable = adapter.dialect === 'react';
    capabilities[adapter.dialect] = reactCapabilities(placeable);
  }
  return {
    projectType,
    primaryDialect,
    dialects,
    workspaceRoot: snapshot.workspaceRoot,
    capabilities,
    diagnostics,
  };
}

function emptyCapabilities(): Record<ComponentDialect, ComponentCapabilities> {
  const disabled: ComponentCapabilities = {
    catalog: false,
    usageGraph: false,
    definitionBinding: false,
    instanceBinding: false,
    place: false,
    editStaticProps: false,
    editSlots: false,
    editMain: false,
    componentTreeBoundary: false,
    focusedVisualEditing: false,
    duplicateDefinition: false,
    renameDefinition: false,
    deleteDefinition: false,
    extract: false,
    isolatedPreview: false,
  };
  return {
    react: { ...disabled },
    astro: { ...disabled },
    vue: { ...disabled },
    svelte: { ...disabled },
    shopify: { ...disabled },
    'web-component': { ...disabled },
    'react-native': { ...disabled },
    flutter: { ...disabled },
  };
}

function reactCapabilities(placeable: boolean): ComponentCapabilities {
  return {
    catalog: true,
    usageGraph: true,
    definitionBinding: true,
    instanceBinding: true,
    place: placeable,
    editStaticProps: placeable,
    editSlots: false,
    editMain: true,
    componentTreeBoundary: true,
    focusedVisualEditing: false,
    duplicateDefinition: false,
    renameDefinition: false,
    deleteDefinition: false,
    extract: false,
    isolatedPreview: false,
  };
}
