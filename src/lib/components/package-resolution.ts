import { normalizeProjectPath, REACT_SOURCE_EXTENSIONS } from './adapters/react-helpers';
import type { ComponentDiagnostic, SourceFileSnapshot } from './types';

const PACKAGE_MANIFEST = 'package.json';
const ENTRY_FIELDS = ['types', 'typings', 'module', 'main', 'source'] as const;
const CONDITION_ORDER = ['types', 'import', 'require', 'default', 'browser'] as const;

export interface PackageManifestRecord {
  name: string;
  file: SourceFileSnapshot;
  root: string;
  manifest: Record<string, unknown>;
}

export interface PackageModuleResolution {
  status: 'resolved' | 'unresolved' | 'external';
  file: string | null;
  diagnostics: ComponentDiagnostic[];
}

/**
 * Read package metadata as data only. This deliberately ignores package
 * scripts and config files: the component index must never execute project
 * code to resolve an import.
 */
export function packageManifests(files: readonly SourceFileSnapshot[]) {
  const manifests: PackageManifestRecord[] = [];
  for (const file of files) {
    if (normalizeProjectPath(file.file).split('/').pop() !== PACKAGE_MANIFEST) continue;
    let manifest: unknown;
    try {
      manifest = JSON.parse(file.content);
    } catch {
      continue;
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) continue;
    const name = (manifest as Record<string, unknown>).name;
    if (typeof name !== 'string' || !name.trim()) continue;
    manifests.push({
      name,
      file,
      root: normalizeProjectPath(file.file).replace(/\/package\.json$/, '') || '.',
      manifest: manifest as Record<string, unknown>,
    });
  }
  return manifests.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Resolve a bare package import against package manifests and files already
 * supplied to the worker. The result is conservative: wildcard exports and
 * executable/config-based aliases remain unresolved with a diagnostic.
 */
export function resolvePackageModulePath(
  specifier: string,
  files: readonly SourceFileSnapshot[]
): PackageModuleResolution {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return { status: 'external', file: null, diagnostics: [] };
  }
  const parsed = splitPackageSpecifier(specifier);
  if (!parsed) return { status: 'external', file: null, diagnostics: [] };
  const manifest = packageManifests(files).find((entry) => entry.name === parsed.packageName);
  if (!manifest) return { status: 'external', file: null, diagnostics: [] };
  const targets = entryTargets(manifest.manifest, parsed.subpath);
  if (targets.length === 0) {
    return {
      status: 'unresolved',
      file: null,
      diagnostics: [
        {
          code: 'package-entry-unsupported',
          severity: 'warning',
          message: `The internal package "${parsed.packageName}" has no statically readable entry for this import.`,
          file: manifest.file.file,
          source: undefined,
        },
      ],
    };
  }
  const fileSet = new Set(files.map((file) => normalizeProjectPath(file.file)));
  const candidates = targets.flatMap((target) => sourceCandidates(manifest.root, target));
  const match = candidates.find((candidate) => fileSet.has(candidate));
  return {
    status: match ? 'resolved' : 'unresolved',
    file: match ?? null,
    diagnostics: match
      ? []
      : [
          {
            code: 'package-source-not-loaded',
            severity: 'warning',
            message: `The internal package "${parsed.packageName}" entry is not in the current source snapshot.`,
            file: manifest.file.file,
          },
        ],
  };
}

/**
 * Return a small, deterministic request set for an unresolved internal
 * package import. Explicit file extensions are preferred. Extensionless
 * entries use the conventional TypeScript source entry first; the Rust batch
 * reader may return an empty result when that candidate does not exist, which
 * the caller turns into a bounded unresolved diagnostic.
 */
export function packageSourceCandidates(
  specifier: string,
  files: readonly SourceFileSnapshot[]
): string[] {
  const parsed = splitPackageSpecifier(specifier);
  if (!parsed) return [];
  const manifest = packageManifests(files).find((entry) => entry.name === parsed.packageName);
  if (!manifest) return [];
  return unique(
    entryTargets(manifest.manifest, parsed.subpath).flatMap((target) => {
      const candidates = sourceCandidates(manifest.root, target);
      return candidates.length > 0 ? [candidates[0]] : [];
    })
  ).slice(0, 8);
}

export function isInternalPackageSpecifier(
  specifier: string,
  files: readonly SourceFileSnapshot[]
) {
  const parsed = splitPackageSpecifier(specifier);
  return !!parsed && packageManifests(files).some((entry) => entry.name === parsed.packageName);
}

function splitPackageSpecifier(specifier: string) {
  const parts = specifier.split('/');
  if (!parts[0] || (parts[0].startsWith('@') && !parts[1])) return null;
  const packageName = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (!packageName) return null;
  return { packageName, subpath: parts.slice(packageName.startsWith('@') ? 2 : 1).join('/') };
}

function entryTargets(manifest: Record<string, unknown>, subpath: string): string[] {
  const exports = manifest.exports;
  if (exports !== undefined) {
    const exportTarget = exportTargetFor(exports, subpath ? `./${subpath}` : '.');
    return exportTarget ? [exportTarget] : [];
  }
  if (subpath) return [subpath];
  return ENTRY_FIELDS.flatMap((field) => {
    const value = manifest[field];
    return typeof value === 'string' ? [value] : [];
  });
}

function exportTargetFor(value: unknown, requestedKey: string): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const target = exportTargetFor(candidate, requestedKey);
      if (target) return target;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (requestedKey in record) return exportTargetFor(record[requestedKey], requestedKey);
  if (Object.keys(record).some((key) => key.startsWith('.'))) {
    // Wildcard exports are not expanded: doing so without package metadata
    // would turn a bounded request into a directory probe.
    return null;
  }
  for (const condition of CONDITION_ORDER) {
    const target = exportTargetFor(record[condition], requestedKey);
    if (target) return target;
  }
  return null;
}

function sourceCandidates(root: string, target: string) {
  const normalizedTarget = target.replace(/^\.\//, '');
  if (!normalizedTarget || normalizedTarget.includes('\\')) return [];
  const base = normalizeProjectPath(`${root}/${normalizedTarget}`);
  const extension = extensionOf(base);
  if (extension && REACT_SOURCE_EXTENSIONS.has(extension)) return [base];
  if (extension) return [];
  return [
    `${base}.tsx`,
    `${base}.ts`,
    `${base}.jsx`,
    `${base}.js`,
    `${base}/index.tsx`,
    `${base}/index.ts`,
    `${base}/index.jsx`,
    `${base}/index.js`,
  ].map(normalizeProjectPath);
}

function extensionOf(file: string) {
  const dot = file.lastIndexOf('.');
  const slash = file.lastIndexOf('/');
  return dot > slash ? file.slice(dot) : '';
}

function unique(values: string[]) {
  return [...new Set(values)];
}
