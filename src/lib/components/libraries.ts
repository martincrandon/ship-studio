import { isReactSourcePath, normalizeProjectPath } from './adapters/react-helpers';
import {
  packageExportSourceFiles,
  packageManifests,
  type PackageManifestRecord,
} from './package-resolution';
import { sha256 } from './ranges';
import type {
  ComponentDescriptor,
  ComponentFileOperation,
  ComponentIndex,
  ComponentMutationPlan,
  ComponentSourceSnapshot,
} from './types';

/** Ownership of a package source is explicit and never inferred from a name. */
export type ComponentLibraryOwnership = 'project' | 'library';

export type ComponentLibraryResourceKind = 'token' | 'asset' | 'font';

/** Contract fields that were explicitly parsed from a library definition. */
export interface ComponentLibraryComponentContract {
  componentId: string;
  name: string;
  exportName: string | null;
  definitionFile: string;
  definitionHash: string;
  props: Array<{
    name: string;
    required: boolean;
    typeText: string | null;
    choices: string[] | null;
  }>;
  slots: Array<{ name: string; required: boolean; scoped: boolean }>;
  variantProps: string[];
}

/** Resource metadata is optional and is only populated by an explicit source scanner. */
export interface ComponentLibraryResource {
  kind: ComponentLibraryResourceKind;
  id: string;
  revision?: string;
}

/**
 * Metadata for a package that explicitly exports one or more indexed
 * components. All paths are project-relative and all optional values are
 * copied from package.json only when they are present there.
 */
export interface ComponentLibraryMetadata {
  id: string;
  packageName: string;
  packageRoot: string;
  version: string | null;
  repository: string | null;
  ownership: ComponentLibraryOwnership;
  exportedFiles: string[];
  componentIds: string[];
  contracts?: ComponentLibraryComponentContract[];
  resources?: ComponentLibraryResource[];
}

export type ComponentIndexWithLibraries = ComponentIndex & {
  libraries?: ComponentLibraryMetadata[];
};

export type LibraryForkRefusalCode =
  | 'missing-source'
  | 'not-library-component'
  | 'unsupported'
  | 'stale-source'
  | 'path-collision'
  | 'invalid-name'
  | 'unsafe-dependency-closure'
  | 'cross-workspace';

export interface LibraryForkInput {
  componentId: string;
  destinationFile: string;
  /** A different name is refused until a binding-aware refactor is available. */
  newName?: string;
}

export type LibraryForkResult =
  | {
      status: 'planned';
      sourceFile: string;
      destinationFile: string;
      library: ComponentLibraryMetadata;
      plan: ComponentMutationPlan;
    }
  | {
      status: 'refused';
      code: LibraryForkRefusalCode;
      message: string;
    };

export type ComponentLibraryChangeKind =
  | 'package-metadata'
  | 'added-export'
  | 'removed-export'
  | 'component-contract'
  | ComponentLibraryResourceKind;

export interface ComponentLibraryUpdateChange {
  kind: ComponentLibraryChangeKind;
  label: string;
  detail: string;
  before?: string;
  after?: string;
}

export interface ComponentLibraryUpdateDiff {
  libraryId: string;
  packageName: string;
  fromVersion: string | null;
  toVersion: string | null;
  changes: ComponentLibraryUpdateChange[];
  /** Dependency updates are reviewed metadata only; no package manager is run. */
  requiresDependencyPlan: boolean;
}

/**
 * Discover internal workspace packages whose manifest entry points resolve to
 * source files that actually export indexed components. The package manifest
 * is treated as inert data; wildcard exports, node_modules, and unresolved
 * build outputs are not expanded.
 */
export function discoverComponentLibraries(
  snapshot: ComponentSourceSnapshot,
  components: readonly ComponentDescriptor[],
  importEdges: ComponentIndex['importEdges'] = []
): ComponentLibraryMetadata[] {
  const manifests = packageManifests(snapshot.files);
  const libraries: ComponentLibraryMetadata[] = [];
  for (const manifest of manifests) {
    const exportedFiles = packageExportSourceFiles(manifest, snapshot.files);
    if (exportedFiles.length === 0) continue;
    const reachableFiles = packageExportClosure(exportedFiles, importEdges, manifest.root);
    const componentIds = components
      .filter((component) => reachableFiles.has(normalizeProjectPath(component.definition.file)))
      .map((component) => component.id)
      .sort();
    if (componentIds.length === 0) continue;

    const packageRoot = normalizeProjectPath(manifest.root);
    const contracts = components
      .filter((component) => reachableFiles.has(normalizeProjectPath(component.definition.file)))
      .map(componentContract)
      .sort((left, right) => left.componentId.localeCompare(right.componentId));
    libraries.push({
      id: libraryId(manifest),
      packageName: manifest.name,
      packageRoot,
      version: stringField(manifest.manifest.version),
      repository: repositoryField(manifest.manifest.repository),
      ownership: packageRoot === '.' ? 'project' : 'library',
      exportedFiles: [...reachableFiles].sort(),
      componentIds,
      contracts,
    });
  }
  return libraries.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Compare two explicitly saved library snapshots. A missing previous snapshot
 * is intentionally not treated as an update; callers must establish a
 * baseline before showing update claims.
 */
export function compareComponentLibrary(
  previous: ComponentLibraryMetadata,
  current: ComponentLibraryMetadata
): ComponentLibraryUpdateDiff {
  const changes: ComponentLibraryUpdateChange[] = [];
  if (previous.version !== current.version) {
    changes.push({
      kind: 'package-metadata',
      label: 'Package version',
      detail: `${previous.version ?? 'unknown'} → ${current.version ?? 'unknown'}`,
      before: previous.version ?? undefined,
      after: current.version ?? undefined,
    });
  }
  if (previous.repository !== current.repository) {
    changes.push({
      kind: 'package-metadata',
      label: 'Source repository',
      detail: `${previous.repository ?? 'unknown'} → ${current.repository ?? 'unknown'}`,
      before: previous.repository ?? undefined,
      after: current.repository ?? undefined,
    });
  }

  const previousContracts = new Map(
    (previous.contracts ?? []).map((contract) => [contract.componentId, contract])
  );
  const currentContracts = new Map(
    (current.contracts ?? []).map((contract) => [contract.componentId, contract])
  );
  const removed = [...previousContracts.values()].filter(
    (contract) => !currentContracts.has(contract.componentId)
  );
  const added = [...currentContracts.values()].filter(
    (contract) => !previousContracts.has(contract.componentId)
  );

  for (const contract of removed) {
    changes.push({
      kind: 'removed-export',
      label: 'Removed export',
      detail: contract.name,
      before: contract.name,
    });
  }
  for (const contract of added) {
    changes.push({
      kind: 'added-export',
      label: 'Added export',
      detail: contract.name,
      after: contract.name,
    });
  }

  for (const contract of current.contracts ?? []) {
    const before = previousContracts.get(contract.componentId);
    if (!before || JSON.stringify(contract) === JSON.stringify(before)) continue;
    changes.push({
      kind: 'component-contract',
      label: 'Component contract',
      detail: `${contract.name} props, slots, or variants changed`,
    });
  }

  const previousResources = previous.resources ?? [];
  const currentResources = current.resources ?? [];
  const previousResourceRevisions = new Map(
    previousResources.map((resource) => [`${resource.kind}:${resource.id}`, resource.revision])
  );
  for (const resource of currentResources) {
    const key = `${resource.kind}:${resource.id}`;
    if (previousResourceRevisions.get(key) === resource.revision) continue;
    const before = previousResources.find(
      (candidate) => `${candidate.kind}:${candidate.id}` === key
    );
    changes.push({
      kind: resource.kind,
      label: `${resource.kind[0].toUpperCase()}${resource.kind.slice(1)} resource`,
      detail: resource.id,
      before: before?.revision,
      after: resource.revision,
    });
  }
  const currentResourceKeys = new Set(
    currentResources.map((resource) => `${resource.kind}:${resource.id}`)
  );
  for (const resource of previousResources) {
    const key = `${resource.kind}:${resource.id}`;
    if (currentResourceKeys.has(key)) continue;
    changes.push({
      kind: resource.kind,
      label: `Removed ${resource.kind} resource`,
      detail: resource.id,
      before: resource.revision,
    });
  }

  return {
    libraryId: current.id,
    packageName: current.packageName,
    fromVersion: previous.version,
    toVersion: current.version,
    changes,
    requiresDependencyPlan: previous.version !== current.version,
  };
}

/** Attach library metadata without changing the source-derived component DTOs. */
export function withComponentLibraries(
  index: ComponentIndex,
  snapshot: ComponentSourceSnapshot
): ComponentIndexWithLibraries {
  return {
    ...index,
    libraries: discoverComponentLibraries(snapshot, index.components, index.importEdges),
  };
}

export function libraryForComponent(
  index: ComponentIndex | ComponentIndexWithLibraries,
  componentId: string,
  snapshot?: ComponentSourceSnapshot
): ComponentLibraryMetadata | null {
  const libraries =
    'libraries' in index
      ? (index.libraries ?? [])
      : snapshot
        ? discoverComponentLibraries(snapshot, index.components, index.importEdges)
        : [];
  return libraries.find((library) => library.componentIds.includes(componentId)) ?? null;
}

/**
 * Plan a reviewed local fork for the first safe library slice. It supports a
 * directly named React source with no relative imports, so copying it beside
 * project code cannot silently break its dependency closure. The caller still
 * sends the returned create-only plan through the normal hash/path guarded
 * mutation command after user approval.
 */
export function planLibraryFork(
  input: LibraryForkInput,
  index: ComponentIndex | ComponentIndexWithLibraries,
  snapshot: ComponentSourceSnapshot
): LibraryForkResult {
  const component = index.components.find((candidate) => candidate.id === input.componentId);
  const library = libraryForComponent(index, input.componentId, snapshot);
  if (!component || !library || library.ownership !== 'library') {
    return {
      status: 'refused',
      code: 'not-library-component',
      message: 'Only a component owned by a validated workspace library can be forked.',
    };
  }
  if (component.dialect !== 'react' || component.exportName !== component.localName) {
    return {
      status: 'refused',
      code: 'unsupported',
      message: 'Local library forks currently require a directly named React export.',
    };
  }

  const sourceFile = snapshot.files.find(
    (file) => normalizeProjectPath(file.file) === normalizeProjectPath(component.definition.file)
  );
  if (!sourceFile) {
    return {
      status: 'refused',
      code: 'missing-source',
      message: `The library source ${component.definition.file} is not in the current snapshot.`,
    };
  }
  if (sourceFile.contentHash !== component.definition.contentHash) {
    return {
      status: 'refused',
      code: 'stale-source',
      message: 'The library source changed after the component catalog was built.',
    };
  }
  if (!isReactSourcePath(sourceFile.file)) {
    return {
      status: 'refused',
      code: 'unsupported',
      message: 'The local fork planner requires a TypeScript or JavaScript React source file.',
    };
  }

  // Import-edge DTOs intentionally retain source locations rather than raw
  // specifier text. Re-check the copied file itself for relative imports so a
  // fork cannot silently move a dependency whose closure we did not review.
  if (/(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"]\.\.?\//.test(sourceFile.content)) {
    return {
      status: 'refused',
      code: 'unsafe-dependency-closure',
      message:
        'This library component has relative source imports. Forking is paused until its complete dependency closure can be reviewed.',
    };
  }

  const newName = (input.newName ?? component.localName).trim();
  if (newName !== component.localName) {
    return {
      status: 'refused',
      code: 'unsupported',
      message:
        'Renaming a fork is disabled until a binding-aware source refactor can update internal references safely.',
    };
  }

  const destinationFile = normalizeProjectPath(input.destinationFile);
  if (destinationFile === '.' || destinationFile !== input.destinationFile.replace(/^\.\//, '')) {
    return {
      status: 'refused',
      code: 'cross-workspace',
      message: 'The fork destination must be a normalized project-relative path.',
    };
  }
  if (destinationFile === normalizeProjectPath(sourceFile.file)) {
    return {
      status: 'refused',
      code: 'cross-workspace',
      message: 'A library fork destination must be outside the owning package source.',
    };
  }
  const packageRoot = normalizeProjectPath(library.packageRoot);
  if (packageRoot !== '.' && destinationFile.startsWith(`${packageRoot}/`)) {
    return {
      status: 'refused',
      code: 'cross-workspace',
      message: 'A local fork destination must be outside the owning library package.',
    };
  }
  if (!isReactSourcePath(destinationFile)) {
    return {
      status: 'refused',
      code: 'unsupported',
      message: 'The fork destination must use a supported React source extension.',
    };
  }
  const destinationBase = destinationFile.slice(destinationFile.lastIndexOf('/') + 1);
  const destinationExtension = destinationBase.slice(destinationBase.lastIndexOf('.'));
  if (destinationBase.slice(0, -destinationExtension.length) !== newName) {
    return {
      status: 'refused',
      code: 'invalid-name',
      message: `The fork filename must be ${newName}${destinationExtension}.`,
    };
  }
  if (snapshot.files.some((file) => normalizeProjectPath(file.file) === destinationFile)) {
    return {
      status: 'refused',
      code: 'path-collision',
      message: `The fork destination ${destinationFile} already exists in the source snapshot.`,
    };
  }

  const contents = sourceFile.content;
  const operation: ComponentFileOperation = {
    kind: 'create',
    file: destinationFile,
    expectedAbsent: true,
    contents,
    expectedResultHash: sha256(contents),
  };
  return {
    status: 'planned',
    sourceFile: sourceFile.file,
    destinationFile,
    library,
    plan: {
      files: [],
      operations: [operation],
      expectedRevision: snapshot.revision,
      warnings: [
        {
          code: 'library-fork-detaches-updates',
          severity: 'info',
          message: `This fork is local to the project and will not receive future updates from ${library.packageName}.`,
        },
      ],
    },
  };
}

function packageExportClosure(
  entryFiles: readonly string[],
  importEdges: ComponentIndex['importEdges'],
  packageRoot: string
): Set<string> {
  const normalizedRoot = normalizeProjectPath(packageRoot);
  const reachable = new Set(entryFiles.map(normalizeProjectPath));
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of importEdges) {
      const fromFile = normalizeProjectPath(edge.fromFile);
      if (!reachable.has(fromFile) || !edge.toFile) continue;
      const target = normalizeProjectPath(edge.toFile);
      if (normalizedRoot !== '.' && !target.startsWith(`${normalizedRoot}/`)) continue;
      if (!reachable.has(target)) {
        reachable.add(target);
        changed = true;
      }
    }
  }
  return reachable;
}

function libraryId(manifest: PackageManifestRecord) {
  return `package:${normalizeProjectPath(manifest.root)}:${manifest.name}`;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function repositoryField(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return stringField((value as Record<string, unknown>).url);
}

function componentContract(component: ComponentDescriptor): ComponentLibraryComponentContract {
  return {
    componentId: component.id,
    name: component.name,
    exportName: component.exportName,
    definitionFile: normalizeProjectPath(component.definition.file),
    definitionHash: component.definition.contentHash,
    props: component.props.map((prop) => ({
      name: prop.name,
      required: prop.required,
      typeText: prop.typeText,
      choices: prop.choices?.map((choice) => JSON.stringify(choice)) ?? null,
    })),
    slots: component.slots.map((slot) => ({
      name: slot.name,
      required: slot.required,
      scoped: slot.scoped,
    })),
    variantProps: [...component.variantProps],
  };
}
