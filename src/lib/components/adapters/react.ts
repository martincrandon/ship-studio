import { planInsertComponent, planStaticPropEdit, validateReactMutation } from '../mutation';
import { sourceTextForRef } from '../ranges';
import { planDuplicateComponent } from '../refactors';
import { planDeleteComponent, planRenameComponent } from '../refactors';
import { planStaticSlotEdit } from '../slots';
import { projectComponentTree } from '../component-tree';
import { parseReactFile } from './react-parser';
import { isReactSourcePath, normalizeProjectPath, resolveModulePath } from './react-helpers';
import { resolvePackageModulePath } from '../package-resolution';
import type {
  ComponentAdapter,
  AdapterGraph,
  DetectionContext,
  GraphContext,
  ParseContext,
  ParsedComponentFile,
  RawImportEdge,
  ResolveContext,
  ResolvedImportEdge,
  InsertComponentInputWithContext,
  EditComponentPropInputWithContext,
  EditComponentSlotInputWithContext,
  DuplicateComponentInputWithContext,
  DeleteComponentInputWithContext,
  RenameComponentInputWithContext,
} from './types';
import type {
  ComponentBinding,
  ComponentDescriptor,
  ComponentDiagnostic,
  ComponentImportEdge,
  ComponentIndex,
  ComponentInstance,
  ComponentSourceSnapshot,
  MutationValidationInput,
  MutationValidationResult,
  MutationResult,
  RefactorResult,
  SelectionBindingInput,
  SourceFileSnapshot,
  SourceRef,
  StaticExpression,
  DynamicExpression,
  UnsetExpression,
} from '../types';

export class ReactComponentAdapter implements ComponentAdapter {
  readonly dialect = 'react' as const;

  detect(context: DetectionContext) {
    if (context.projectType === 'reactnative') {
      return {
        detected: false,
        confidence: 'low' as const,
        diagnostics: [
          {
            code: 'react-skipped-react-native',
            severity: 'info' as const,
            message:
              'React web indexing is skipped for React Native projects; the native adapter owns JSX source.',
          },
        ],
      };
    }
    const reactFiles = context.files.filter((file) => isReactSourcePath(file.file));
    const detected = reactFiles.some(
      (file) =>
        (/\.(?:tsx|jsx)$/i.test(file.file) &&
          /<[A-Za-z][A-Za-z0-9_.:-]*(?:\s|\/?>)/.test(file.content)) ||
        /(?:from\s+['"]react['"]|require\(['"]react['"]\)|React\.createElement\s*\()/.test(
          file.content
        )
    );
    return {
      detected,
      confidence: detected ? ('high' as const) : ('low' as const),
      diagnostics: detected
        ? []
        : [
            {
              code: 'react-no-jsx',
              severity: 'info' as const,
              message: 'No exported React JSX components were found in the source snapshot.',
            },
          ],
    };
  }

  accepts(path: string): boolean {
    return isReactSourcePath(path);
  }

  parseFile(file: SourceFileSnapshot, context: ParseContext): ParsedComponentFile {
    return parseReactFile(file, context.knownFiles);
  }

  resolveImport(edge: RawImportEdge, context: ResolveContext): ResolvedImportEdge {
    const files = context.files.map((file) => file.snapshot);
    const sourceFiles = context.sourceFiles ?? files;
    const resolution = edge.source.startsWith('.')
      ? { ...resolveModulePath(edge.fromFile, edge.source, sourceFiles), diagnostics: [] }
      : resolvePackageModulePath(edge.source, sourceFiles);
    const resolutionDiagnostics: ComponentDiagnostic[] = resolution.diagnostics;
    const diagnostics: ComponentDiagnostic[] = resolutionDiagnostics.map((diagnostic) => ({
      ...diagnostic,
      source: diagnostic.source ?? edge.sourceRef,
    }));
    if (resolution.status === 'unresolved' && diagnostics.length === 0) {
      diagnostics.push({
        code: 'react-unresolved-import',
        severity: 'warning',
        message: `Could not resolve the import "${edge.source}" from ${edge.fromFile}.`,
        file: edge.fromFile,
        source: edge.sourceRef,
      });
    }
    return { ...edge, toFile: resolution.file, status: resolution.status, diagnostics };
  }

  buildUsageGraph(files: ParsedComponentFile[], context: GraphContext): AdapterGraph {
    const byFile = new Map(files.map((file) => [normalizeProjectPath(file.snapshot.file), file]));
    const descriptors = files.flatMap((file) =>
      file.components.map((component) => component.descriptor)
    );
    const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
    const descriptorByFileLocal = new Map<string, ComponentDescriptor>();
    for (const file of files) {
      for (const component of file.components) {
        descriptorByFileLocal.set(
          `${normalizeProjectPath(file.snapshot.file)}#${component.localName}`,
          component.descriptor
        );
      }
    }
    const importEdges: ComponentImportEdge[] = [];
    const resolvedImports = new Map<string, ResolvedImportEdge>();
    for (const file of files) {
      for (const raw of file.imports) {
        const resolved = this.resolveImport(raw, {
          workspaceRoot: context.workspaceRoot,
          files,
          sourceFiles: context.sourceFiles,
        });
        resolvedImports.set(importKey(raw), resolved);
        importEdges.push({
          fromFile: raw.fromFile,
          toFile: resolved.toFile,
          importedName: raw.importedName,
          localName: raw.localName,
          source: raw.sourceRef,
          status: resolved.status,
          diagnostics: resolved.diagnostics,
        });
      }
      for (const raw of file.reExports) {
        const resolved = this.resolveImport(raw, {
          workspaceRoot: context.workspaceRoot,
          files,
          sourceFiles: context.sourceFiles,
        });
        importEdges.push({
          fromFile: raw.fromFile,
          toFile: resolved.toFile,
          importedName: raw.importedName,
          localName: raw.localName,
          source: raw.sourceRef,
          status: resolved.status,
          diagnostics: resolved.diagnostics,
        });
      }
    }

    const instances: ComponentInstance[] = [];
    const diagnostics: ComponentDiagnostic[] = files.flatMap((file) => file.diagnostics);
    for (const file of files) {
      for (const usage of file.usages) {
        const target = resolveUsageTarget(
          file,
          usage.localName,
          usage.namespaceName,
          usage.tagName,
          byFile,
          descriptorByFileLocal,
          resolvedImports,
          files
        );
        if (!target) {
          const importEdge = file.imports.find((edge) => {
            if (usage.namespaceName)
              return edge.isNamespace && edge.localName === usage.namespaceName;
            return edge.localName === usage.localName;
          });
          const importStatus = importEdge
            ? resolvedImports.get(importKey(importEdge))?.status
            : undefined;
          // Package/framework components such as next/link are intentionally
          // outside the project index. They are not evidence of an incomplete
          // project graph and must not produce one warning per JSX occurrence.
          if (importStatus !== 'external' && usage.localName && /^[A-Z]/.test(usage.localName)) {
            diagnostics.push({
              code: 'react-unresolved-usage',
              severity: 'warning',
              message: `Could not resolve JSX component "${usage.tagName}" to an indexed export.`,
              file: file.snapshot.file,
              source: usage.invocation,
            });
          }
          continue;
        }
        const props: Record<string, StaticExpression | DynamicExpression | UnsetExpression> = {};
        for (const prop of target.props) props[prop.name] = { kind: 'unset' };
        for (const attribute of usage.attributes) {
          const source = attribute.valueSource ?? attribute.source;
          if (attribute.staticValue) {
            props[attribute.name] = { kind: 'static', value: attribute.staticValue, source };
          } else {
            props[attribute.name] = {
              kind: 'dynamic',
              text: attribute.expressionText ?? attribute.source.file,
              reason: attribute.dynamicReason ?? 'Unsupported JSX attribute value.',
              source,
            };
          }
        }
        const slots = usage.childrenSource
          ? [
              {
                name: 'children',
                value: null,
                sourceText:
                  sourceTextForRef(file.snapshot.content, usage.childrenSource) ?? undefined,
              },
            ]
          : [];
        const instance: ComponentInstance = {
          id: instanceId(target.id, usage.invocation),
          componentId: target.id,
          invocation: usage.invocation,
          containingComponentId: usage.containingLocalName
            ? (descriptorByFileLocal.get(
                `${normalizeProjectPath(file.snapshot.file)}#${usage.containingLocalName}`
              )?.id ?? null)
            : null,
          route: null,
          props,
          slots,
          ...(usage.childrenSource
            ? {
                slotSources: {
                  children: {
                    ...usage.childrenSource,
                    text:
                      sourceTextForRef(file.snapshot.content, usage.childrenSource) ?? undefined,
                  },
                },
              }
            : {}),
        };
        instances.push(instance);
        target.usageCount += 1;
      }
    }
    for (const descriptor of descriptors) descriptorById.set(descriptor.id, descriptor);
    return { components: descriptors, instances, importEdges, diagnostics };
  }

  bindSelection(input: SelectionBindingInput, index: ComponentIndex): ComponentBinding {
    const candidates = input.candidates?.length
      ? input.candidates
      : input.file && input.line
        ? [
            {
              renderer: 'react' as const,
              file: input.file,
              line: input.line,
              column: input.column ?? 1,
              symbolHint: input.symbolHint ?? null,
              runtimeKey: null,
            },
          ]
        : [];
    const exact: { componentId: string; instanceId: string; source: SourceRef }[] = [];
    const anchored: { componentId: string; source: SourceRef }[] = [];
    for (const candidate of candidates) {
      if (candidate.renderer !== 'react' && candidate.renderer !== 'unknown') continue;
      if (input.sourceHash && input.sourceHash !== candidateSourceHash(index, candidate.file))
        continue;
      for (const instance of index.instances) {
        if (!sameSourceFile(instance.invocation.file, candidate.file)) continue;
        if (!lineInRange(candidate.line, instance.invocation.line, instance.invocation.end))
          continue;
        if (
          candidate.symbolHint &&
          !symbolMatches(index, instance.componentId, candidate.symbolHint)
        )
          continue;
        if (input.sourceHash && candidate.symbolHint) {
          exact.push({
            componentId: instance.componentId,
            instanceId: instance.id,
            source: instance.invocation,
          });
        } else {
          // A devtools line hint can identify the source component, but it
          // cannot prove one exact JSX invocation without a matching source
          // revision and symbol. Keep source navigation available while
          // withholding instance mutations.
          anchored.push({ componentId: instance.componentId, source: instance.invocation });
        }
      }
      for (const component of index.components) {
        if (!sameSourceFile(component.definition.file, candidate.file)) continue;
        if (!lineInRange(candidate.line, component.definition.line, component.definition.end))
          continue;
        if (candidate.symbolHint && !symbolMatches(index, component.id, candidate.symbolHint))
          continue;
        anchored.push({ componentId: component.id, source: component.definition });
      }
    }
    const uniqueExact = uniqueCandidates(exact);
    if (uniqueExact.length === 1) {
      const item = uniqueExact[0];
      return {
        confidence: 'exact',
        componentId: item.componentId,
        instanceId: item.instanceId,
        source: item.source,
        candidates: [
          {
            componentId: item.componentId,
            instanceId: item.instanceId,
            source: item.source,
            confidence: 'exact',
          },
        ],
        diagnostics: [],
      };
    }
    if (uniqueExact.length > 1) {
      return {
        confidence: 'ambiguous',
        candidates: uniqueExact.map((item) => ({
          componentId: item.componentId,
          instanceId: item.instanceId,
          source: item.source,
          confidence: 'exact' as const,
        })),
        diagnostics: [
          {
            code: 'react-ambiguous-instance',
            severity: 'warning',
            message: 'More than one component invocation matches the source candidate.',
          },
        ],
      };
    }
    const uniqueAnchored = uniqueCandidates(anchored);
    if (uniqueAnchored.length === 1) {
      const item = uniqueAnchored[0];
      return {
        confidence: 'sourceAnchored',
        componentId: item.componentId,
        source: item.source,
        candidates: [
          { componentId: item.componentId, source: item.source, confidence: 'sourceAnchored' },
        ],
        diagnostics: [
          {
            code: 'react-instance-unproven',
            severity: 'info',
            message:
              'The definition is known, but this rendered node is not tied to one exact invocation.',
          },
        ],
      };
    }
    if (uniqueAnchored.length > 1) {
      return {
        confidence: 'ambiguous',
        candidates: uniqueAnchored.map((item) => ({
          componentId: item.componentId,
          source: item.source,
          confidence: 'sourceAnchored' as const,
        })),
        diagnostics: [
          {
            code: 'react-ambiguous-definition',
            severity: 'warning',
            message: 'More than one component definition matches the source candidate.',
          },
        ],
      };
    }
    return {
      confidence: 'none',
      candidates: [],
      diagnostics: [
        {
          code: 'react-no-binding',
          severity: 'info',
          message: 'The source candidate did not match the current component index.',
        },
      ],
    };
  }

  projectTree(input: import('../types').ComponentTreeProjectionInput, index: ComponentIndex) {
    return projectComponentTree({ ...input, index });
  }

  planInsert(input: InsertComponentInputWithContext, index: ComponentIndex): MutationResult {
    return planInsertComponent(input, index, input.snapshot);
  }

  planPropEdit(input: EditComponentPropInputWithContext, index: ComponentIndex): MutationResult {
    return planStaticPropEdit(input, index, input.snapshot);
  }

  planSlotEdit(input: EditComponentSlotInputWithContext, index: ComponentIndex): MutationResult {
    return planStaticSlotEdit(input, index, input.snapshot);
  }

  planDuplicate(input: DuplicateComponentInputWithContext, index: ComponentIndex): RefactorResult {
    return planDuplicateComponent(input, index, input.snapshot);
  }

  planRename(input: RenameComponentInputWithContext, index: ComponentIndex): RefactorResult {
    return planRenameComponent(input, index, input.snapshot);
  }

  planDelete(input: DeleteComponentInputWithContext, index: ComponentIndex): RefactorResult {
    return planDeleteComponent(input, index, input.snapshot);
  }

  validateMutation(input: MutationValidationInput): MutationValidationResult {
    return validateReactMutation(input);
  }
}

function importKey(edge: RawImportEdge): string {
  return `${edge.fromFile}:${edge.sourceRef.start}:${edge.localName ?? ''}`;
}

function resolveUsageTarget(
  file: ParsedComponentFile,
  localName: string | null,
  namespaceName: string | null,
  tagName: string,
  byFile: Map<string, ParsedComponentFile>,
  descriptorByFileLocal: Map<string, ComponentDescriptor>,
  resolvedImports: Map<string, ResolvedImportEdge>,
  files: readonly ParsedComponentFile[]
): ComponentDescriptor | null {
  if (!localName) return null;
  const direct = descriptorByFileLocal.get(
    `${normalizeProjectPath(file.snapshot.file)}#${localName}`
  );
  if (direct) return direct;
  const importEdge = file.imports.find((edge) => {
    if (namespaceName) return edge.isNamespace && edge.localName === namespaceName;
    return edge.localName === localName;
  });
  if (!importEdge) return null;
  const resolved = resolvedImports.get(importKey(importEdge));
  if (!resolved?.toFile) return null;
  const target = byFile.get(normalizeProjectPath(resolved.toFile));
  if (!target) return null;
  const exportedName = namespaceName
    ? tagName.split('.').slice(1).join('.')
    : (importEdge.importedName ?? 'default');
  return resolveExportDescriptor(
    target,
    exportedName,
    byFile,
    descriptorByFileLocal,
    files,
    new Set()
  );
}

function resolveExportDescriptor(
  file: ParsedComponentFile,
  exportName: string,
  byFile: Map<string, ParsedComponentFile>,
  descriptorByFileLocal: Map<string, ComponentDescriptor>,
  files: readonly ParsedComponentFile[],
  seen: Set<string>
): ComponentDescriptor | null {
  const visitKey = `${file.snapshot.file}#${exportName}`;
  if (seen.has(visitKey)) return null;
  seen.add(visitKey);
  const local = file.exports.get(exportName);
  if (local) {
    const descriptor = descriptorByFileLocal.get(
      `${normalizeProjectPath(file.snapshot.file)}#${local}`
    );
    if (descriptor) return descriptor;
  }
  for (const edge of file.reExports) {
    const exportedName = edge.localName ?? edge.importedName;
    if (edge.importedName !== '*' && exportedName !== exportName) continue;
    if (edge.importedName === '*' && exportName === 'default') continue;
    const resolution = resolveModulePath(
      file.snapshot.file,
      edge.source,
      files.map((item) => item.snapshot)
    );
    if (!resolution.file) continue;
    const target = byFile.get(normalizeProjectPath(resolution.file));
    if (!target) continue;
    if (edge.importedName === '*') {
      const descriptor = resolveExportDescriptor(
        target,
        exportName,
        byFile,
        descriptorByFileLocal,
        files,
        seen
      );
      if (descriptor) return descriptor;
    } else {
      const descriptor = resolveExportDescriptor(
        target,
        edge.importedName ?? 'default',
        byFile,
        descriptorByFileLocal,
        files,
        seen
      );
      if (descriptor) return descriptor;
    }
  }
  return null;
}

function instanceId(componentId: string, source: SourceRef): string {
  return `${componentId}@${normalizeProjectPath(source.file)}:${source.start}`;
}

function sameSourceFile(left: string, right: string): boolean {
  return normalizeProjectPath(left) === normalizeProjectPath(right);
}

function lineInRange(line: number, startLine: number, _end: number): boolean {
  return line === startLine;
}

function symbolMatches(index: ComponentIndex, componentId: string, symbol: string): boolean {
  const component = index.components.find((item) => item.id === componentId);
  return (
    !!component &&
    (component.name === symbol ||
      component.exportName === symbol ||
      component.id.endsWith(`#${symbol}`))
  );
}

function candidateSourceHash(index: ComponentIndex, file: string): string | null {
  const instance = index.instances.find((item) => sameSourceFile(item.invocation.file, file));
  if (instance) return instance.invocation.contentHash;
  return (
    index.components.find((item) => sameSourceFile(item.definition.file, file))?.definition
      .contentHash ?? null
  );
}

function uniqueCandidates<
  T extends { componentId: string; source: SourceRef; instanceId?: string },
>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.componentId}:${item.instanceId ?? ''}:${item.source.file}:${item.source.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function createReactAdapter(): ReactComponentAdapter {
  return new ReactComponentAdapter();
}

export type ReactSourceSnapshot = ComponentSourceSnapshot;
