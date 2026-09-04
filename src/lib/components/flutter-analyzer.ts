import { normalizeProjectPath } from './adapters/react-helpers';
import { sha256 } from './ranges';
import type {
  ComponentCapabilities,
  ComponentDescriptor,
  ComponentDiagnostic,
  ComponentDialect,
  ComponentFrameworkProfile,
  ComponentIndex,
  ComponentInstance,
  ComponentKind,
  ComponentPropExpression,
  ComponentSlotDescriptor,
  ComponentSlotValue,
  ComponentSourceSnapshot,
  SourceFileSnapshot,
  SourceRef,
} from './types';

/** Wire version for the host-facing Dart Analysis Server source payload. */
export const FLUTTER_ANALYZER_PROTOCOL_VERSION = 1 as const;

/** The first analyzer major whose source-range contract this adapter accepts. */
export const SUPPORTED_DART_ANALYZER_MAJOR = 3;

/** A definition record returned by the opt-in analyzer integration. */
export interface FlutterAnalyzerDefinitionRecord {
  name: string;
  localName: string;
  exportName: string | null;
  kind: Extract<ComponentKind, 'widget' | 'component'>;
  definition: SourceRef;
  props: ComponentDescriptor['props'];
  slots: ComponentSlotDescriptor[];
  diagnostics: ComponentDiagnostic[];
}

/** A source invocation record returned by the analyzer integration. */
export interface FlutterAnalyzerInstanceRecord {
  definition: SourceRef;
  invocation: SourceRef;
  route: string | null;
  props: Record<string, ComponentPropExpression>;
  slots: ComponentSlotValue[];
}

/**
 * Bounded analyzer output consumed by Ship Studio. The analyzer owns Dart
 * grammar and package resolution; Ship Studio only validates source hashes and
 * converts the result into the common immutable catalog DTO.
 */
export interface FlutterAnalyzerSnapshot {
  protocol: typeof FLUTTER_ANALYZER_PROTOCOL_VERSION;
  analyzerVersion: string;
  workspaceRoot: string;
  partial: boolean;
  diagnostics: ComponentDiagnostic[];
  components: FlutterAnalyzerDefinitionRecord[];
  instances: FlutterAnalyzerInstanceRecord[];
}

export interface FlutterAnalyzerValidation {
  status: 'valid' | 'refused';
  diagnostics: ComponentDiagnostic[];
}

/** Source-only capabilities until a Widget Inspector bridge proves a host. */
export function flutterSourceCapabilities(): ComponentCapabilities {
  return {
    catalog: true,
    usageGraph: true,
    definitionBinding: true,
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
}

/**
 * Validate analyzer output against the current immutable source snapshot.
 * Analyzer locations are evidence only when their complete file hash and
 * UTF-8 byte range still match the snapshot Ship Studio is displaying.
 */
export function validateFlutterAnalyzerSnapshot(
  analyzer: FlutterAnalyzerSnapshot,
  source: ComponentSourceSnapshot
): FlutterAnalyzerValidation {
  const diagnostics = [...analyzer.diagnostics];
  if (analyzer.protocol !== FLUTTER_ANALYZER_PROTOCOL_VERSION) {
    diagnostics.push({
      code: 'flutter-analyzer-protocol',
      severity: 'error',
      message: `Unsupported Flutter analyzer protocol ${String(analyzer.protocol)}.`,
    });
  }
  const major = Number(analyzer.analyzerVersion.match(/^(\d+)\./)?.[1] ?? NaN);
  if (major !== SUPPORTED_DART_ANALYZER_MAJOR) {
    diagnostics.push({
      code: 'flutter-analyzer-version',
      severity: 'error',
      message: `Dart analyzer ${analyzer.analyzerVersion} is outside the supported ${SUPPORTED_DART_ANALYZER_MAJOR}.x range.`,
    });
  }
  if (normalizeProjectPath(analyzer.workspaceRoot) !== normalizeProjectPath(source.workspaceRoot)) {
    diagnostics.push({
      code: 'flutter-analyzer-workspace',
      severity: 'error',
      message: 'The analyzer workspace does not match the current source snapshot.',
    });
  }
  const sourceFiles = new Map(
    source.files.map((file) => [normalizeProjectPath(file.file), file] as const)
  );
  const seenDefinitions = new Set<string>();
  for (const [index, record] of analyzer.components.entries()) {
    const label = `component ${index + 1}`;
    diagnostics.push(...validateSourceRef(record.definition, sourceFiles, label));
    for (const prop of record.props) {
      diagnostics.push(...validateSourceRef(prop.source, sourceFiles, `${label} prop`));
    }
    for (const slot of record.slots) {
      diagnostics.push(...validateSourceRef(slot.source, sourceFiles, `${label} slot`));
    }
    const key = definitionKey(record.definition);
    if (seenDefinitions.has(key)) {
      diagnostics.push({
        code: 'flutter-analyzer-duplicate-definition',
        severity: 'error',
        message: `The analyzer returned the same Flutter definition more than once (${label}).`,
      });
    }
    seenDefinitions.add(key);
    if (!record.name || !record.localName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(record.localName)) {
      diagnostics.push({
        code: 'flutter-analyzer-invalid-name',
        severity: 'error',
        message: `The analyzer returned an invalid Flutter declaration name for ${label}.`,
      });
    }
  }
  for (const [index, record] of analyzer.instances.entries()) {
    const label = `instance ${index + 1}`;
    diagnostics.push(...validateSourceRef(record.definition, sourceFiles, `${label} definition`));
    diagnostics.push(...validateSourceRef(record.invocation, sourceFiles, `${label} invocation`));
    for (const prop of Object.values(record.props)) {
      if (prop && prop.kind !== 'unset') {
        diagnostics.push(...validateSourceRef(prop.source, sourceFiles, `${label} prop`));
      }
    }
    for (const slot of record.slots) {
      const value = slot.value;
      if (value && value.kind !== 'unset') {
        diagnostics.push(...validateSourceRef(value.source, sourceFiles, `${label} slot`));
      }
    }
    if (!seenDefinitions.has(definitionKey(record.definition))) {
      diagnostics.push({
        code: 'flutter-analyzer-unresolved-instance',
        severity: 'warning',
        message: `The analyzer returned an invocation whose definition was not catalogued (${label}).`,
      });
    }
  }
  const refused = diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  return { status: refused ? 'refused' : 'valid', diagnostics };
}

/**
 * Convert validated analyzer output into a common index. This is intentionally
 * an explicit entry point rather than a fallback Dart parser: callers must
 * obtain the records from the Dart analyzer service first.
 */
export function buildFlutterComponentIndex(
  source: ComponentSourceSnapshot,
  analyzer: FlutterAnalyzerSnapshot
): ComponentIndex {
  const validation = validateFlutterAnalyzerSnapshot(analyzer, source);
  const capabilities = flutterSourceCapabilities();
  const profile = flutterProfile(source, capabilities, validation.diagnostics);
  if (validation.status === 'refused') {
    return {
      revision: source.revision || revisionForSource(source.files),
      partial: true,
      profile,
      components: [],
      instances: [],
      importEdges: [],
      diagnostics: validation.diagnostics,
    };
  }

  const components: ComponentDescriptor[] = analyzer.components.map((record) => ({
    id: flutterComponentId(record.definition, record.name),
    dialect: 'flutter',
    kind: record.kind,
    name: record.name,
    localName: record.localName,
    exportName: record.exportName,
    description: null,
    definition: normalizeSourceRef(record.definition),
    props: record.props,
    slots: record.slots,
    variantProps: [],
    usageCount: 0,
    capabilities,
    diagnostics: record.diagnostics,
  }));
  const componentByDefinition = new Map(
    components.map((component) => [definitionKey(component.definition), component] as const)
  );
  const instances: ComponentInstance[] = [];
  for (const [index, record] of analyzer.instances.entries()) {
    const component = componentByDefinition.get(definitionKey(record.definition));
    if (!component) continue;
    const invocation = normalizeSourceRef(record.invocation);
    instances.push({
      id: `${component.id}@${invocation.file}:${invocation.start}:${index}`,
      componentId: component.id,
      invocation,
      containingComponentId: null,
      route: record.route,
      props: record.props,
      slots: record.slots,
    });
  }
  const usageCounts = new Map<string, number>();
  for (const instance of instances) {
    usageCounts.set(instance.componentId, (usageCounts.get(instance.componentId) ?? 0) + 1);
  }
  for (const component of components) component.usageCount = usageCounts.get(component.id) ?? 0;
  return {
    revision: source.revision || revisionForSource(source.files),
    partial: source.partial || analyzer.partial,
    profile,
    components,
    instances,
    importEdges: [],
    diagnostics: validation.diagnostics,
  };
}

export function flutterComponentId(definition: SourceRef, name: string): string {
  return `flutter:${normalizeProjectPath(definition.file)}#${name}`;
}

function flutterProfile(
  source: ComponentSourceSnapshot,
  capabilities: ComponentCapabilities,
  diagnostics: ComponentDiagnostic[]
): ComponentFrameworkProfile {
  const disabled = emptyCapabilities();
  disabled.flutter = capabilities;
  return {
    projectType: 'flutter',
    primaryDialect: 'flutter',
    dialects: ['flutter'],
    capabilities: disabled,
    diagnostics: [...source.diagnostics, ...diagnostics],
    workspaceRoot: source.workspaceRoot,
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

function validateSourceRef(
  reference: SourceRef,
  sourceFiles: ReadonlyMap<string, SourceFileSnapshot>,
  label: string
): ComponentDiagnostic[] {
  const diagnostics: ComponentDiagnostic[] = [];
  const rawParts = reference.file.replace(/\\/g, '/').split('/');
  const file = normalizeProjectPath(reference.file);
  const snapshot = sourceFiles.get(file);
  if (
    rawParts.some((part) => part === '..') ||
    !snapshot ||
    !file.toLowerCase().endsWith('.dart')
  ) {
    diagnostics.push({
      code: 'flutter-analyzer-source-file',
      severity: 'error',
      message: `The analyzer ${label} does not point to a tracked Dart source file.`,
      file,
    });
    return diagnostics;
  }
  if (
    snapshot.contentHash !== reference.contentHash ||
    sha256(snapshot.content) !== reference.contentHash
  ) {
    diagnostics.push({
      code: 'flutter-analyzer-stale-source',
      severity: 'error',
      message: `The analyzer ${label} belongs to a different source hash.`,
      file,
    });
  }
  const byteLength = new TextEncoder().encode(snapshot.content).byteLength;
  if (
    !Number.isInteger(reference.start) ||
    !Number.isInteger(reference.end) ||
    reference.start < 0 ||
    reference.end <= reference.start ||
    reference.end > byteLength ||
    !Number.isInteger(reference.line) ||
    reference.line < 1 ||
    !Number.isInteger(reference.column) ||
    reference.column < 1
  ) {
    diagnostics.push({
      code: 'flutter-analyzer-source-range',
      severity: 'error',
      message: `The analyzer returned an invalid UTF-8 source range for ${label}.`,
      file,
    });
  }
  return diagnostics;
}

function normalizeSourceRef(reference: SourceRef): SourceRef {
  return { ...reference, file: normalizeProjectPath(reference.file) };
}

function definitionKey(reference: SourceRef): string {
  return `${normalizeProjectPath(reference.file)}:${reference.start}:${reference.end}:${reference.contentHash}`;
}

function revisionForSource(files: readonly SourceFileSnapshot[]): string {
  return sha256(
    files.map((file) => `${normalizeProjectPath(file.file)}:${file.contentHash}`).join('\n')
  );
}
