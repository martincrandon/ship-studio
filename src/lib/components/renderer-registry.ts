import type {
  ComponentDescriptor,
  ComponentIndex,
  ComponentDialect,
  ComponentSourceSnapshot,
  ComponentRenderRoot,
  SourceFileSnapshot,
} from './types';
import type { ComponentIndexWithLibraries } from './libraries';

/** A registry entry is data for a reviewed host; it is never evaluated here. */
export interface RendererRegistryEntry {
  componentId: string;
  modulePath: string;
  exportName: string;
  exportKind: 'default' | 'named';
  sourceFile: string;
  sourceRevision: string;
  clientModule: boolean;
  /** Parser-proven intrinsic root used by the renderer inspector when present. */
  renderRoot?: ComponentRenderRoot;
  supported: boolean;
  reason?: string;
}

export interface RendererRegistryResult {
  protocolVersion: 2;
  sourceRevision: string;
  entries: RendererRegistryEntry[];
  supportedComponentIds: string[];
  rejected: Array<{ componentId: string; reason: string }>;
}

/** The small reviewed document consumed by the native session manager. */
export interface RendererRegistryDocument {
  sourceRevision: string;
  componentRevisions: Record<string, string>;
}

export interface RendererRegistryBuildOptions {
  /** The revision currently known by the caller, when it has one. */
  currentSourceRevision?: string;
  /** Optional source files used to verify definition hashes before codegen. */
  sourceFiles?: readonly SourceFileSnapshot[];
}

const RENDERABLE_DIALECTS: ReadonlySet<ComponentDialect> = new Set(['react']);
const MAX_REGISTRY_ENTRIES = 200;

function isSafeProjectRelativePath(file: string): boolean {
  return (
    file.length > 0 &&
    file.length <= 512 &&
    !file.startsWith('/') &&
    !file.includes('\\') &&
    !file.split('/').some((segment) => segment === '..' || segment === '')
  );
}

function normalizeProjectPath(file: string): string {
  const parts: string[] = [];
  for (const segment of file.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

function modulePathCandidates(fromFile: string, moduleSpecifier: string): string[] {
  if (!moduleSpecifier.startsWith('.')) return [];
  const fromParts = normalizeProjectPath(fromFile).split('/');
  fromParts.pop();
  const base = normalizeProjectPath([...fromParts, moduleSpecifier].join('/'));
  return [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    `${base}.jsx`,
    `${base}.js`,
    `${base}/index.tsx`,
    `${base}/index.ts`,
    `${base}/index.jsx`,
    `${base}/index.js`,
  ];
}

function definitionKey(component: ComponentDescriptor): string {
  return [
    normalizeProjectPath(component.definition.file),
    component.definition.start,
    component.definition.end,
    component.localName,
  ].join(':');
}

function hasAmbiguousExport(
  component: ComponentDescriptor,
  exportNamesByDefinition: ReadonlyMap<string, ReadonlySet<string>>
): boolean {
  if (component.rendererSafety?.ambiguousExport) return true;
  return (exportNamesByDefinition.get(definitionKey(component))?.size ?? 0) > 1;
}

function hasUnresolvedReExport(
  component: ComponentDescriptor,
  index: ComponentIndex | ComponentIndexWithLibraries
): boolean {
  const definitionFile = normalizeProjectPath(component.definition.file);
  return index.importEdges.some((edge) => {
    if (
      (edge.kind !== 're-export' && edge.moduleSpecifier === undefined) ||
      (edge.status !== 'unresolved' && edge.status !== 'ambiguous')
    ) {
      return false;
    }
    if (normalizeProjectPath(edge.fromFile) === definitionFile) return true;
    return (
      edge.moduleSpecifier !== undefined &&
      modulePathCandidates(edge.fromFile, edge.moduleSpecifier).includes(definitionFile)
    );
  });
}

function nonSerializableRequiredProp(component: ComponentDescriptor): string | null {
  const prop = component.props.find((candidate) => {
    if (!candidate.required || candidate.name === 'children') return false;
    if (candidate.control === 'readonly') return true;
    if (candidate.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return true;
    return /=>|\b(?:Function|ReactNode|ReactElement|JSX\.Element|Date|File|HTMLElement)\b/.test(
      candidate.typeText ?? ''
    );
  });
  return prop?.name ?? null;
}

function rejection(component: ComponentDescriptor, reason: string) {
  return { componentId: component.id, reason };
}

function registryEntry(
  component: ComponentDescriptor,
  sourceRevision: string,
  supported: boolean,
  reason?: string
): RendererRegistryEntry {
  const exportName = component.exportName ?? component.localName;
  return {
    componentId: component.id,
    modulePath: `./${component.definition.file}`,
    exportName,
    exportKind: exportName === 'default' ? 'default' : 'named',
    sourceFile: component.definition.file,
    sourceRevision,
    clientModule: component.isClientModule === true,
    ...(component.renderRoot ? { renderRoot: component.renderRoot } : {}),
    supported,
    ...(reason ? { reason } : {}),
  };
}

/**
 * Builds a deterministic, data-only registry from parser-proven definitions.
 * The eventual Next/Vite host may turn these entries into imports, but this
 * function never imports, evaluates, or accepts a caller-supplied module path.
 */
export function buildRendererRegistry(
  index: ComponentIndex | ComponentIndexWithLibraries,
  snapshot: Pick<ComponentSourceSnapshot, 'revision'>,
  dialect: ComponentDialect = 'react',
  options: RendererRegistryBuildOptions = {}
): RendererRegistryResult {
  const components = [...index.components].sort((left, right) => left.id.localeCompare(right.id));
  const entries: RendererRegistryEntry[] = [];
  const rejected: Array<{ componentId: string; reason: string }> = [];
  const exportNamesByDefinition = new Map<string, Set<string>>();
  for (const component of components) {
    const key = definitionKey(component);
    const names = exportNamesByDefinition.get(key) ?? new Set<string>();
    if (component.exportName) names.add(component.exportName);
    exportNamesByDefinition.set(key, names);
  }
  const staleRevision =
    options.currentSourceRevision !== undefined &&
    (options.currentSourceRevision !== index.revision ||
      options.currentSourceRevision !== snapshot.revision);

  for (const component of components.slice(0, MAX_REGISTRY_ENTRIES)) {
    let reason: string | undefined;
    const sourceFile = options.sourceFiles?.find(
      (file) => normalizeProjectPath(file.file) === normalizeProjectPath(component.definition.file)
    );
    if (staleRevision) {
      reason = 'The component index and source snapshot revisions are stale or mismatched.';
    } else if (
      options.sourceFiles &&
      sourceFile?.contentHash !== component.definition.contentHash
    ) {
      reason = 'The component definition changed after indexing; refresh the component catalog.';
    } else if (options.sourceFiles && !sourceFile) {
      reason = 'The component definition is not present in the current source snapshot.';
    } else if (!RENDERABLE_DIALECTS.has(component.dialect) || component.dialect !== dialect) {
      reason = `Renderer adapter does not support the ${component.dialect} dialect.`;
    } else if (hasAmbiguousExport(component, exportNamesByDefinition)) {
      reason =
        'The component has ambiguous default/named export access and cannot be imported safely.';
    } else if (component.exportName === null) {
      reason = 'The component export is ambiguous or unresolved.';
    } else if (component.rendererSafety?.dynamicImport) {
      reason =
        'The component definition contains a dynamic import and is not safe for static codegen.';
    } else if (hasUnresolvedReExport(component, index)) {
      reason = 'A re-export needed by this component is unresolved or ambiguous.';
    } else if (!isSafeProjectRelativePath(component.definition.file)) {
      reason = 'The component definition path is not a safe project-relative path.';
    } else if (component.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      reason = 'The component has parser errors and cannot enter the renderer registry.';
    } else if (!component.capabilities.catalog) {
      reason = 'The component is not parser-proven for catalog rendering.';
    } else {
      const propName = nonSerializableRequiredProp(component);
      if (propName) {
        reason = `Required prop "${propName}" is not representable as a static renderer value (non-serializable).`;
      } else if (component.slots.some((slot) => slot.scoped)) {
        reason =
          'Scoped slots require runtime values and are not supported by the static renderer.';
      }
    }

    const entry = registryEntry(component, snapshot.revision, !reason, reason);
    entries.push(entry);
    if (reason) rejected.push(rejection(component, reason));
  }

  for (const component of components.slice(MAX_REGISTRY_ENTRIES)) {
    const reason = 'The renderer registry is bounded at 200 components.';
    rejected.push(rejection(component, reason));
  }

  return {
    protocolVersion: 2,
    sourceRevision: snapshot.revision,
    entries,
    supportedComponentIds: entries
      .filter((entry) => entry.supported)
      .map((entry) => entry.componentId),
    rejected,
  };
}

/** Serialize only the bounded allowlist metadata; module paths stay in generated host code. */
export function serializeRendererRegistry(registry: RendererRegistryResult): string {
  const componentRevisions = Object.fromEntries(
    registry.entries
      .filter((entry) => entry.supported)
      .sort((left, right) => left.componentId.localeCompare(right.componentId))
      .map((entry) => [entry.componentId, entry.sourceRevision])
  );
  return JSON.stringify(
    {
      sourceRevision: registry.sourceRevision,
      componentRevisions,
    } satisfies RendererRegistryDocument,
    null,
    2
  );
}
