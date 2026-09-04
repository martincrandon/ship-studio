import type { ProjectType } from '@/lib/static-server';
import { createReactAdapter } from './adapters/react';
import { createVueAdapter } from './adapters/vue';
import { createSvelteAdapter } from './adapters/svelte';
import { createShopifyAdapter } from './adapters/shopify';
import { createWebComponentAdapter } from './adapters/web-components';
import { createReactNativeAdapter } from './adapters/react-native';
import type {
  ComponentAdapter,
  DialectDetection,
  GraphContext,
  ParseContext,
  ParsedComponentFile,
} from './adapters/types';
import { normalizeProjectPath } from './adapters/react-helpers';
import { isInternalPackageSpecifier, packageSourceCandidates } from './package-resolution';
import { withComponentLibraries } from './libraries';
import { sha256 } from './ranges';
import type {
  ComponentCapabilities,
  ComponentDialect,
  ComponentFrameworkProfile,
  ComponentIndex,
  ComponentSourceSnapshot,
  SourceFileChange,
  SourceFileSnapshot,
} from './types';

export interface ComponentIndexStoreOptions {
  projectType?: ProjectType | null;
  adapters?: readonly ComponentAdapter[];
}

interface ParsedCacheEntry {
  contentHash: string;
  parsed: ParsedComponentFile;
}

/**
 * Owns the worker-local parsed-file cache for one project session.
 *
 * The cache is intentionally not serializable: TypeScript ASTs remain inside
 * the worker. Updates invalidate only changed/deleted files (or the whole
 * cache when the detected adapter set changes), then rebuild the graph from a
 * complete set of parsed files before publishing the next immutable index.
 */
export class ComponentIndexStore {
  private readonly parsed = new Map<string, ParsedCacheEntry>();
  private snapshot: ComponentSourceSnapshot | null = null;
  private index: ComponentIndex | null = null;
  private projectType: ProjectType | null = null;
  private adapterSignature = '';
  private parseCount = 0;

  /** Useful for worker diagnostics and focused cache tests; never serialized. */
  get parsedFileCount() {
    return this.parsed.size;
  }

  /** Number of parser invocations in this worker session. */
  get totalParseCount() {
    return this.parseCount;
  }

  build(snapshot: ComponentSourceSnapshot, options: ComponentIndexStoreOptions = {}) {
    this.parsed.clear();
    this.snapshot = null;
    this.index = null;
    this.projectType = options.projectType ?? null;
    this.adapterSignature = '';
    return this.rebuild(snapshot, options);
  }

  update(
    snapshot: ComponentSourceSnapshot,
    changes: readonly SourceFileChange[],
    options: ComponentIndexStoreOptions = {}
  ) {
    if (!this.snapshot || !this.index) return this.build(snapshot, options);

    const adapters = resolveAdapters(options.adapters);
    const nextSignature = detectionSignature(adapters, snapshot, options.projectType ?? null);
    if (
      nextSignature !== this.adapterSignature ||
      (options.projectType ?? null) !== this.projectType
    ) {
      this.parsed.clear();
    } else {
      const invalidatedFiles = new Set(changes.map((change) => normalizeProjectPath(change.file)));
      if (invalidatedFiles.size === 0) {
        for (const [file, previous] of this.snapshot.files.map(
          (entry) => [normalizeProjectPath(entry.file), entry] as const
        )) {
          const next = snapshot.files.find((entry) => normalizeProjectPath(entry.file) === file);
          if (!next || next.contentHash !== previous.contentHash) invalidatedFiles.add(file);
        }
      }
      for (const key of this.parsed.keys()) {
        const separator = key.indexOf('::');
        const file = separator >= 0 ? key.slice(separator + 2) : key;
        if (invalidatedFiles.has(file)) this.parsed.delete(key);
      }
    }
    return this.rebuild(snapshot, { ...options, adapters });
  }

  private rebuild(snapshot: ComponentSourceSnapshot, options: ComponentIndexStoreOptions) {
    const adapters = resolveAdapters(options.adapters);
    const detections = adapters.map((adapter) => ({
      adapter,
      detection: adapter.detect({ files: snapshot.files, projectType: options.projectType }),
    }));
    const detected = detections.filter(({ detection }) => detection.detected);
    const profile = profileForSnapshot(snapshot, options.projectType ?? null, detections);
    const components: ComponentIndex['components'] = [];
    const instances: ComponentIndex['instances'] = [];
    const importEdges: ComponentIndex['importEdges'] = [];
    const diagnostics = [...snapshot.diagnostics, ...profile.diagnostics];

    for (const { adapter } of detected) {
      const adapterFiles = snapshot.files.filter((file) => adapter.accepts(file.file));
      const parsed = adapterFiles.map((file) =>
        this.parseCached(adapter, file, snapshot.files, snapshot.workspaceRoot)
      );
      const graph = adapter.buildUsageGraph(parsed, {
        workspaceRoot: snapshot.workspaceRoot,
        files: parsed,
        revision: snapshot.revision,
        sourceFiles: snapshot.files,
      } satisfies GraphContext);
      components.push(...graph.components);
      instances.push(...graph.instances);
      importEdges.push(...graph.importEdges);
      diagnostics.push(...graph.diagnostics);
    }

    const needSources = collectNeedSources(
      detected.flatMap(({ adapter }) =>
        snapshot.files
          .filter((file) => adapter.accepts(file.file))
          .map(
            (file) =>
              this.parsed.get(`${adapter.dialect}::${normalizeProjectPath(file.file)}`)?.parsed
          )
          .filter((file): file is ParsedComponentFile => !!file)
      ),
      snapshot.files,
      diagnostics
    );

    const baseIndex: ComponentIndex = {
      revision:
        snapshot.revision ||
        sha256(snapshot.files.map((file) => `${file.file}:${file.contentHash}`).join('\n')),
      partial:
        snapshot.partial ||
        diagnostics.some(
          (diagnostic) => diagnostic.severity === 'warning' || diagnostic.severity === 'error'
        ),
      ...(needSources.length > 0 ? { needSources } : {}),
      profile,
      components,
      instances,
      importEdges,
      diagnostics,
    };
    const index = withComponentLibraries(baseIndex, snapshot);
    this.snapshot = snapshot;
    this.index = index;
    this.projectType = options.projectType ?? null;
    this.adapterSignature = detectionSignature(adapters, snapshot, options.projectType ?? null);
    return index;
  }

  private parseCached(
    adapter: ComponentAdapter,
    file: SourceFileSnapshot,
    knownFiles: readonly SourceFileSnapshot[],
    workspaceRoot: string
  ) {
    const key = `${adapter.dialect}::${normalizeProjectPath(file.file)}`;
    const cached = this.parsed.get(key);
    if (cached?.contentHash === file.contentHash) return cached.parsed;
    const parsed = adapter.parseFile(file, {
      workspaceRoot,
      knownFiles,
    } satisfies ParseContext);
    this.parsed.set(key, { contentHash: file.contentHash, parsed });
    this.parseCount += 1;
    return parsed;
  }
}

const MAX_NEED_SOURCES = 64;

function collectNeedSources(
  files: readonly ParsedComponentFile[],
  sourceFiles: readonly SourceFileSnapshot[],
  diagnostics: ComponentIndex['diagnostics']
) {
  const knownFiles = new Set(sourceFiles.map((file) => normalizeProjectPath(file.file)));
  const requested = new Set<string>();
  for (const file of files) {
    for (const edge of [...file.imports, ...file.reExports]) {
      if (!isInternalPackageSpecifier(edge.source, sourceFiles)) continue;
      for (const candidate of packageSourceCandidates(edge.source, sourceFiles)) {
        if (knownFiles.has(candidate)) continue;
        requested.add(candidate);
      }
    }
  }
  const result = [...requested].sort();
  if (result.length > MAX_NEED_SOURCES) {
    diagnostics.push({
      code: 'need-sources-limit',
      severity: 'warning',
      message: `Internal package resolution requested more than ${MAX_NEED_SOURCES} files; the remainder was refused.`,
    });
    return result.slice(0, MAX_NEED_SOURCES);
  }
  return result;
}

function resolveAdapters(adapters?: readonly ComponentAdapter[]) {
  return adapters?.length ? adapters : createCoreComponentAdapters();
}

/**
 * Adapters that can be loaded without the optional Astro compiler/WASM
 * runtime. The worker uses this set for the common React/Next path and only
 * loads the Astro adapter when a snapshot actually contains `.astro` files.
 */
export function createCoreComponentAdapters(): readonly ComponentAdapter[] {
  return [
    createReactAdapter(),
    createVueAdapter(),
    createSvelteAdapter(),
    createShopifyAdapter(),
    createWebComponentAdapter(),
    createReactNativeAdapter(),
  ];
}

function detectionSignature(
  adapters: readonly ComponentAdapter[],
  snapshot: ComponentSourceSnapshot,
  projectType: ProjectType | null
) {
  return adapters
    .map((adapter) => {
      const detection = adapter.detect({ files: snapshot.files, projectType });
      return `${adapter.dialect}:${detection.detected ? '1' : '0'}`;
    })
    .join('|');
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
    capabilities[adapter.dialect] =
      adapter.capabilities ?? reactCapabilities(adapter.dialect === 'react');
  }
  return {
    projectType,
    primaryDialect,
    dialects,
    capabilities,
    workspaceRoot: snapshot.workspaceRoot,
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
    focusedVisualEditing: true,
    duplicateDefinition: placeable,
    renameDefinition: placeable,
    deleteDefinition: placeable,
    extract: false,
    isolatedPreview: false,
  };
}
