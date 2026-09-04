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
}

export type ComponentIndexWithLibraries = ComponentIndex & {
  libraries: ComponentLibraryMetadata[];
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
    libraries.push({
      id: libraryId(manifest),
      packageName: manifest.name,
      packageRoot,
      version: stringField(manifest.manifest.version),
      repository: repositoryField(manifest.manifest.repository),
      ownership: packageRoot === '.' ? 'project' : 'library',
      exportedFiles: [...reachableFiles].sort(),
      componentIds,
    });
  }
  return libraries.sort((left, right) => left.id.localeCompare(right.id));
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
      ? index.libraries
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
