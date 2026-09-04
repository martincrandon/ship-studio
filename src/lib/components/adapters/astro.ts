import ts from 'typescript';
import {
  applyTextEdits,
  sha256,
  sourceRefFromUtf16Range,
  sourceTextForRef,
  utf16OffsetToUtf8ByteOffset,
  utf8ByteOffsetToUtf16Offset,
} from '../ranges';
import { basenameWithoutExtension, isStaticAssetProp, normalizeProjectPath } from './react-helpers';
import { resolvePackageModulePath } from '../package-resolution';
import {
  ASTRO_COMPONENT_PLAN_PARSER_TOKEN,
  astroCompilerDiagnostics,
  parseAstroDocument,
} from '../astro-parser';
import { literalChoices, staticValueFromExpression, staticValueToJsx } from './static-values';
import type {
  AdapterGraph,
  ComponentAdapter,
  DetectionContext,
  GraphContext,
  InsertComponentInputWithContext,
  EditComponentPropInputWithContext,
  ParseContext,
  ParsedComponentFile,
  RawImportEdge,
  RawJsxAttribute,
  RawJsxUsage,
  ResolveContext,
  ResolvedImportEdge,
} from './types';
import type {
  ComponentBinding,
  ComponentCapabilities,
  ComponentFileMutation,
  ComponentTextEdit,
  ComponentDescriptor,
  ComponentDiagnostic,
  ComponentIndex,
  ComponentInstance,
  ComponentImportEdge,
  ComponentPropDescriptor,
  ComponentSlotDescriptor,
  ComponentTreeProjection,
  InsertComponentInput,
  MutationResult,
  MutationValidationInput,
  MutationValidationResult,
  SelectionBindingInput,
  SourceFileSnapshot,
  SourceRef,
  StaticValue,
  DynamicExpression,
  StaticExpression,
  UnsetExpression,
} from '../types';

const ASTRO_EXTENSION = '.astro';

export function astroCapabilities(): ComponentCapabilities {
  return {
    catalog: true,
    usageGraph: true,
    definitionBinding: true,
    // Astro does not expose stable rendered invocation identity, so exact
    // instance binding remains false. Source-row-selected prop edits are still
    // safe because they carry the invocation's complete source hash/range.
    instanceBinding: false,
    place: true,
    editStaticProps: true,
    editSlots: false,
    editMain: true,
    componentTreeBoundary: false,
    focusedVisualEditing: false,
    duplicateDefinition: false,
    renameDefinition: false,
    deleteDefinition: false,
    extract: false,
    isolatedPreview: false,
  };
}

export function isAstroSourcePath(file: string): boolean {
  return normalizeProjectPath(file).toLowerCase().endsWith(ASTRO_EXTENSION);
}

/** Astro routes are page-owned source, not reusable catalog definitions. */
export function isAstroRouteFile(file: string): boolean {
  const normalized = normalizeProjectPath(file);
  const segments = normalized.split('/');
  return segments.some((segment) => segment === 'pages' || segment === 'src/pages');
}

export function isAstroLayoutFile(file: string): boolean {
  const normalized = normalizeProjectPath(file);
  const segments = normalized.split('/');
  return (
    segments.includes('layouts') || basenameWithoutExtension(normalized).toLowerCase() === 'layout'
  );
}

export class AstroComponentAdapter implements ComponentAdapter {
  readonly dialect = 'astro' as const;
  readonly capabilities = astroCapabilities();

  detect(context: DetectionContext) {
    const detected = context.files.some((file) => isAstroSourcePath(file.file));
    return {
      detected,
      confidence: detected ? ('high' as const) : ('low' as const),
      diagnostics: detected
        ? []
        : [
            {
              code: 'astro-no-files',
              severity: 'info' as const,
              message: 'No Astro source files were found in the source snapshot.',
            },
          ],
    };
  }

  accepts(path: string): boolean {
    return isAstroSourcePath(path);
  }

  parseFile(file: SourceFileSnapshot, _context: ParseContext): ParsedComponentFile {
    const sourceFile = ts.createSourceFile(
      file.file,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const frontmatter = findFrontmatter(file.content);
    const templateRanges = astroTemplateRanges(file.content, frontmatter);
    const routeFile = isAstroRouteFile(file.file);
    const props = routeFile ? [] : parseAstroProps(file, frontmatter);
    const slots = routeFile ? [] : parseAstroSlots(file, templateRanges);
    const component = routeFile ? null : createAstroDefinition(file, props, slots);
    const components = component ? [component] : [];

    return {
      snapshot: file,
      sourceFile,
      components,
      imports: parseAstroImports(file, frontmatter),
      usages: templateRanges.flatMap((range) => parseAstroUsages(file, range)),
      exports: component
        ? new Map<string, string>([['default', component.localName]])
        : new Map<string, string>(),
      reExports: [],
      diagnostics: [],
    };
  }

  resolveImport(edge: RawImportEdge, context: ResolveContext): ResolvedImportEdge {
    const files = context.files.map((file) => file.snapshot);
    const sourceFiles = context.sourceFiles ?? files;
    const resolution = edge.source.startsWith('.')
      ? { ...resolveAstroModulePath(edge.fromFile, edge.source, sourceFiles), diagnostics: [] }
      : resolvePackageModulePath(edge.source, sourceFiles);
    const resolutionDiagnostics: ComponentDiagnostic[] = resolution.diagnostics;
    const diagnostics: ComponentDiagnostic[] = resolutionDiagnostics.map((diagnostic) => ({
      ...diagnostic,
      source: diagnostic.source ?? edge.sourceRef,
    }));
    if (resolution.status === 'unresolved' && diagnostics.length === 0) {
      diagnostics.push({
        code: 'astro-unresolved-import',
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
    const descriptorByFile = new Map(
      descriptors.map((descriptor) => [
        normalizeProjectPath(descriptor.definition.file),
        descriptor,
      ])
    );
    const resolvedImports = new Map<string, ResolvedImportEdge>();
    const importEdges: ComponentImportEdge[] = [];

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
    }

    const instances: ComponentInstance[] = [];
    const diagnostics: ComponentDiagnostic[] = files.flatMap((file) => file.diagnostics);
    for (const file of files) {
      for (const usage of file.usages) {
        const target = resolveAstroUsageTarget(
          file,
          usage,
          byFile,
          descriptorByFile,
          resolvedImports
        );
        if (!target) continue;

        const props: Record<string, StaticExpression | DynamicExpression | UnsetExpression> = {};
        for (const attribute of usage.attributes) {
          const source = attribute.valueSource ?? attribute.source;
          if (attribute.staticValue) {
            props[attribute.name] = { kind: 'static', value: attribute.staticValue, source };
          } else {
            props[attribute.name] = {
              kind: 'dynamic',
              text: attribute.expressionText ?? attribute.source.file,
              reason: attribute.dynamicReason ?? 'Unsupported Astro attribute value.',
              source,
            };
          }
        }

        const instance: ComponentInstance = {
          id: instanceId(target.id, usage.invocation),
          componentId: target.id,
          invocation: usage.invocation,
          containingComponentId: null,
          route: isAstroRouteFile(file.snapshot.file) ? file.snapshot.file : null,
          props,
          slots: usage.childrenSource
            ? [
                {
                  name: 'default',
                  value: null,
                  sourceText:
                    sourceTextForRef(file.snapshot.content, usage.childrenSource) ?? undefined,
                },
              ]
            : [],
          ...(usage.childrenSource
            ? {
                slotSources: {
                  default: {
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

    return { components: descriptors, instances, importEdges, diagnostics };
  }

  bindSelection(input: SelectionBindingInput, index: ComponentIndex): ComponentBinding {
    const candidates = input.candidates?.length
      ? input.candidates
      : input.file && input.line
        ? [
            {
              renderer: 'astro' as const,
              file: input.file,
              line: input.line,
              column: input.column ?? 1,
              symbolHint: input.symbolHint ?? null,
              runtimeKey: null,
            },
          ]
        : [];
    const matches: { componentId: string; source: SourceRef }[] = [];

    for (const candidate of candidates) {
      if (candidate.renderer !== 'astro' && candidate.renderer !== 'unknown') continue;
      const candidateHash = astroSourceHash(index, candidate.file);
      if (input.sourceHash && input.sourceHash !== candidateHash) continue;

      for (const instance of index.instances) {
        if (
          normalizeProjectPath(instance.invocation.file) !== normalizeProjectPath(candidate.file)
        ) {
          continue;
        }
        if (candidate.line !== instance.invocation.line) continue;
        const component = index.components.find((item) => item.id === instance.componentId);
        if (component && symbolMatches(component, candidate.symbolHint)) {
          matches.push({ componentId: component.id, source: component.definition });
        }
      }

      for (const component of index.components) {
        if (
          normalizeProjectPath(component.definition.file) !== normalizeProjectPath(candidate.file)
        ) {
          continue;
        }
        if (candidate.line < component.definition.line) continue;
        if (!symbolMatches(component, candidate.symbolHint)) continue;
        matches.push({ componentId: component.id, source: component.definition });
      }
    }

    const uniqueMatches = uniqueBindings(matches);
    if (uniqueMatches.length === 1) {
      const match = uniqueMatches[0];
      return {
        confidence: 'sourceAnchored',
        componentId: match.componentId,
        source: match.source,
        candidates: [
          {
            componentId: match.componentId,
            source: match.source,
            confidence: 'sourceAnchored',
          },
        ],
        diagnostics: [
          {
            code: 'astro-instance-unproven',
            severity: 'info',
            message:
              'Astro source is anchored to the component definition, but the rendered node is not tied to one exact invocation.',
          },
        ],
      };
    }
    if (uniqueMatches.length > 1) {
      return {
        confidence: 'ambiguous',
        candidates: uniqueMatches.map((match) => ({
          componentId: match.componentId,
          source: match.source,
          confidence: 'sourceAnchored' as const,
        })),
        diagnostics: [
          {
            code: 'astro-ambiguous-definition',
            severity: 'warning',
            message: 'More than one Astro component definition matches the source candidate.',
          },
        ],
      };
    }
    return {
      confidence: 'none',
      candidates: [],
      diagnostics: [
        {
          code: 'astro-no-binding',
          severity: 'info',
          message: 'The Astro source candidate did not match the current component index.',
        },
      ],
    };
  }

  planInsert(input: InsertComponentInputWithContext, index: ComponentIndex): MutationResult {
    return planAstroInsert(input, index);
  }

  planPropEdit(input: EditComponentPropInputWithContext, index: ComponentIndex): MutationResult {
    return planAstroPropEdit(input, index);
  }

  validateMutation(_input: MutationValidationInput): MutationValidationResult {
    return validateAstroMutationSync(_input);
  }

  /** The browser compiler is async because its WASM instance is async-loaded. */
  async validateMutationAsync(input: MutationValidationInput): Promise<MutationValidationResult> {
    const sync = validateAstroMutationSync(input);
    if (sync.status === 'invalid') return sync;
    const diagnostics: ComponentDiagnostic[] = [];
    for (const mutation of input.plan.files) {
      const file = input.snapshot.files.find(
        (candidate) => normalizeProjectPath(candidate.file) === normalizeProjectPath(mutation.file)
      );
      if (!file) continue;
      const after = applyTextEdits(file.content, mutation.edits);
      if (after === null) continue;
      const result = await parseAstroDocument(after);
      diagnostics.push(
        ...astroCompilerDiagnostics({ ...file, content: after }, result.diagnostics)
      );
    }
    return diagnostics.some((diagnostic) => diagnostic.severity === 'error')
      ? { status: 'invalid', diagnostics }
      : { status: 'valid', diagnostics };
  }

  projectTree(
    _input: import('../types').ComponentTreeProjectionInput,
    _index: ComponentIndex
  ): ComponentTreeProjection {
    return {
      tree: null,
      root: null,
      revision: _index.revision,
      truncated: false,
      boundaries: [],
      diagnostics: [
        {
          code: 'astro-component-tree-unsupported',
          severity: 'info',
          message: 'Astro runtime component boundaries are not available without an exact bridge.',
        },
      ],
    };
  }
}

interface FrontmatterBounds {
  bodyStart: number;
  bodyEnd: number;
  closeEnd: number;
}

interface TemplateRange {
  start: number;
  end: number;
}

function createAstroDefinition(
  file: SourceFileSnapshot,
  props: ComponentPropDescriptor[],
  slots: ComponentSlotDescriptor[]
) {
  const localName = basenameWithoutExtension(file.file);
  const definition = sourceRefFromUtf16Range(
    file.file,
    file.content,
    file.contentHash,
    0,
    file.content.length
  );
  const capabilities = astroCapabilities();
  const descriptor: ComponentDescriptor = {
    id: `astro:${normalizeProjectPath(file.file)}#default`,
    dialect: 'astro',
    kind: isAstroLayoutFile(file.file) ? 'layout' : 'component',
    name: localName,
    localName,
    exportName: 'default',
    description: null,
    definition,
    props,
    slots,
    variantProps: [],
    usageCount: 0,
    capabilities,
    diagnostics: [],
  };
  return {
    localName,
    exportName: 'default',
    descriptor,
    declaration: ts.createSourceFile(
      file.file,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    ),
    props,
    capabilities,
    isDefault: true,
  };
}

interface AstroPropSeed {
  name: string;
  required: boolean;
  typeNode?: ts.TypeNode;
  defaultValue: StaticValue | null;
  sourceStart: number;
  sourceEnd: number;
}

/**
 * Read the two explicit Astro prop contracts that can be edited safely:
 * `interface Props`/`type Props = { ... }` and destructuring from
 * `Astro.props`. The frontmatter is parsed as TypeScript, but the source
 * offsets are always translated back to the original `.astro` document.
 */
function parseAstroProps(
  file: SourceFileSnapshot,
  frontmatter: FrontmatterBounds | null
): ComponentPropDescriptor[] {
  if (!frontmatter) return [];
  const body = file.content.slice(frontmatter.bodyStart, frontmatter.bodyEnd);
  const sourceFile = ts.createSourceFile(
    `${file.file}.frontmatter.ts`,
    body,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const seeds = new Map<string, AstroPropSeed>();
  const add = (seed: AstroPropSeed) => {
    const existing = seeds.get(seed.name);
    if (!existing) {
      seeds.set(seed.name, seed);
      return;
    }
    existing.typeNode ||= seed.typeNode;
    existing.defaultValue ??= seed.defaultValue;
    existing.required &&= seed.required;
    existing.sourceStart = Math.min(existing.sourceStart, seed.sourceStart);
    existing.sourceEnd = Math.max(existing.sourceEnd, seed.sourceEnd);
  };

  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === 'Props') {
      for (const member of statement.members) {
        if (!ts.isPropertySignature(member) || !member.name) continue;
        const name = astroPropertyName(member.name, sourceFile);
        if (!name) continue;
        add({
          name,
          required: !member.questionToken,
          typeNode: member.type,
          defaultValue: null,
          sourceStart: member.getStart(sourceFile),
          sourceEnd: member.end,
        });
      }
    }
    if (
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === 'Props' &&
      ts.isTypeLiteralNode(statement.type)
    ) {
      for (const member of statement.type.members) {
        if (!ts.isPropertySignature(member) || !member.name) continue;
        const name = astroPropertyName(member.name, sourceFile);
        if (!name) continue;
        add({
          name,
          required: !member.questionToken,
          typeNode: member.type,
          defaultValue: null,
          sourceStart: member.getStart(sourceFile),
          sourceEnd: member.end,
        });
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isObjectBindingPattern(declaration.name) ||
        !isAstroPropsExpression(declaration.initializer)
      )
        continue;
      for (const element of declaration.name.elements) {
        if (!ts.isBindingElement(element) || element.dotDotDotToken) continue;
        const name = astroBindingName(element, sourceFile);
        if (!name) continue;
        const defaultValue = element.initializer
          ? staticValueFromExpression(element.initializer)
          : null;
        add({
          name,
          required: !element.initializer,
          typeNode: undefined,
          defaultValue,
          sourceStart: element.getStart(sourceFile),
          sourceEnd: element.end,
        });
      }
    }
  }

  return [...seeds.values()].map((seed) => {
    const typeText = seed.typeNode?.getText(sourceFile) ?? null;
    const choices = literalChoices(seed.typeNode);
    let control: ComponentPropDescriptor['control'] = 'readonly';
    if (choices) control = 'select';
    else if (typeText && /boolean/i.test(typeText)) control = 'boolean';
    else if (typeText && /(?:number|bigint)/i.test(typeText)) control = 'number';
    else if (typeText && /string/i.test(typeText))
      control = isStaticAssetProp(seed.name) ? 'asset' : 'text';
    return {
      name: seed.name,
      required: seed.required && seed.defaultValue === null,
      typeText,
      defaultValue: seed.defaultValue,
      choices,
      control,
      source: sourceRefFromUtf16Range(
        file.file,
        file.content,
        file.contentHash,
        frontmatter.bodyStart + seed.sourceStart,
        frontmatter.bodyStart + seed.sourceEnd
      ),
      diagnostics: [],
    } satisfies ComponentPropDescriptor;
  });
}

function astroPropertyName(name: ts.PropertyName, sourceFile: ts.SourceFile): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.getText(sourceFile).replace(/^['"]|['"]$/g, '');
  }
  return null;
}

function astroBindingName(element: ts.BindingElement, sourceFile: ts.SourceFile): string | null {
  if (element.propertyName) return astroPropertyName(element.propertyName, sourceFile);
  return ts.isIdentifier(element.name) ? element.name.text : null;
}

function isAstroPropsExpression(expression: ts.Expression | undefined): boolean {
  return (
    !!expression &&
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === 'props' &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'Astro'
  );
}

function parseAstroSlots(
  file: SourceFileSnapshot,
  ranges: readonly TemplateRange[]
): ComponentSlotDescriptor[] {
  const slots = new Map<string, ComponentSlotDescriptor>();
  const pattern = /<slot\b([^>]*?)(?:\/?>)/gi;
  for (const range of ranges) {
    const template = file.content.slice(range.start, range.end);
    for (const match of template.matchAll(pattern)) {
      const tagText = match[0];
      const name = /\bname\s*=\s*(["'])([^"']+)\1/i.exec(tagText)?.[2] ?? 'default';
      const start = range.start + (match.index ?? 0);
      const end = start + tagText.length;
      if (!slots.has(name)) {
        slots.set(name, {
          name,
          required: false,
          scoped: /\blet:/i.test(tagText),
          source: sourceRefFromUtf16Range(file.file, file.content, file.contentHash, start, end),
        });
      }
    }
  }
  return [...slots.values()];
}

function findFrontmatter(content: string): FrontmatterBounds | null {
  const opening = /^(?:\uFEFF)?[ \t]*---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!opening) return null;
  const bodyStart = opening[0].length;
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(content.slice(bodyStart));
  if (!closing) return null;
  const bodyEnd = bodyStart + closing.index;
  return { bodyStart, bodyEnd, closeEnd: bodyEnd + closing[0].length };
}

function astroTemplateRanges(
  content: string,
  frontmatter: FrontmatterBounds | null
): TemplateRange[] {
  if (!frontmatter) return [{ start: 0, end: content.length }];
  return [{ start: frontmatter.closeEnd, end: content.length }];
}

function parseAstroImports(
  file: SourceFileSnapshot,
  frontmatter: FrontmatterBounds | null
): RawImportEdge[] {
  if (!frontmatter) return [];
  const body = file.content.slice(frontmatter.bodyStart, frontmatter.bodyEnd);
  const edges: RawImportEdge[] = [];
  const fromPattern = /\bimport[ \t]+([^;\n]+?)[ \t]+from[ \t]+(['"])([^'"]+)\2/g;
  for (const match of body.matchAll(fromPattern)) {
    const clause = match[1]?.trim() ?? '';
    if (/^type\b/.test(clause)) continue;
    const source = match[3] ?? '';
    const sourceOffset = frontmatter.bodyStart + (match.index ?? 0) + match[0].lastIndexOf(source);
    const sourceRef = sourceRefFromUtf16Range(
      file.file,
      file.content,
      file.contentHash,
      sourceOffset,
      sourceOffset + source.length
    );
    edges.push(...importEdgesForClause(file.file, source, sourceRef, clause));
  }
  const sideEffectPattern = /\bimport[ \t]+(['"])([^'"]+)\1/g;
  for (const match of body.matchAll(sideEffectPattern)) {
    const source = match[2] ?? '';
    const sourceOffset = frontmatter.bodyStart + (match.index ?? 0) + match[0].lastIndexOf(source);
    const sourceRef = sourceRefFromUtf16Range(
      file.file,
      file.content,
      file.contentHash,
      sourceOffset,
      sourceOffset + source.length
    );
    if (!edges.some((edge) => edge.sourceRef.start === sourceRef.start)) {
      edges.push({
        fromFile: file.file,
        source,
        importedName: null,
        localName: null,
        isDefault: false,
        isNamespace: false,
        sourceRef,
      });
    }
  }
  return edges;
}

function importEdgesForClause(
  fromFile: string,
  source: string,
  sourceRef: SourceRef,
  clause: string
): RawImportEdge[] {
  const edges: RawImportEdge[] = [];
  const add = (
    localName: string | null,
    importedName: string | null,
    isDefault: boolean,
    isNamespace: boolean
  ) => {
    edges.push({
      fromFile,
      source,
      importedName,
      localName,
      isDefault,
      isNamespace,
      sourceRef,
    });
  };

  const namedStart = clause.indexOf('{');
  const namespaceMatch = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
  const beforeNamed =
    namedStart >= 0 ? clause.slice(0, namedStart).replace(/,\s*$/, '').trim() : clause;
  if (beforeNamed && !namespaceMatch && !beforeNamed.startsWith('{')) {
    add(beforeNamed, 'default', true, false);
  }
  if (namespaceMatch?.[1]) add(namespaceMatch[1], '*', false, true);
  if (namedStart >= 0) {
    const namedEnd = clause.lastIndexOf('}');
    const named = namedEnd > namedStart ? clause.slice(namedStart + 1, namedEnd) : '';
    for (const item of named.split(',')) {
      const cleaned = item.trim().replace(/^type\s+/, '');
      if (!cleaned) continue;
      const [importedName, localName = importedName] = cleaned.split(/\s+as\s+/);
      if (importedName) add(localName, importedName, false, false);
    }
  }
  if (!edges.length) add(null, null, false, false);
  return edges;
}

function parseAstroUsages(file: SourceFileSnapshot, range: TemplateRange): RawJsxUsage[] {
  const template = file.content.slice(range.start, range.end);
  const usages: RawJsxUsage[] = [];
  const tagPattern = /<([A-Z][A-Za-z0-9_.:-]*)(?=[\s/>])[^>]*?>/g;
  for (const match of template.matchAll(tagPattern)) {
    const localOffset = match.index ?? 0;
    if (insideIgnoredTemplateBlock(template, localOffset)) continue;
    const tagName = match[1] ?? '';
    const absoluteStart = range.start + localOffset;
    const openingEnd = absoluteStart + match[0].length;
    const children = match[0].trimEnd().endsWith('/>')
      ? null
      : findAstroChildrenRange(template, localOffset + match[0].length, tagName);
    const invocation = sourceRefFromUtf16Range(
      file.file,
      file.content,
      file.contentHash,
      absoluteStart,
      children ? range.start + children.end : openingEnd
    );
    const sourceFile = ts.createSourceFile(
      `${file.file}.component.tsx`,
      `<${tagName} />`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const node = findSyntheticJsxNode(sourceFile);
    if (!node) continue;
    usages.push({
      tagName,
      localName: tagName.split('.')[0] ?? tagName,
      namespaceName: tagName.includes('.') ? (tagName.split('.')[0] ?? null) : null,
      invocation,
      attributes: parseAstroAttributes(file, absoluteStart, match[0], tagName),
      childrenSource: children
        ? sourceRefFromUtf16Range(
            file.file,
            file.content,
            file.contentHash,
            range.start + children.childrenStart,
            range.start + children.childrenEnd
          )
        : null,
      containingLocalName: null,
      node,
    });
  }
  return usages;
}

interface AstroChildrenRange {
  childrenStart: number;
  childrenEnd: number;
  end: number;
}

/** Find a matching closing tag for the bounded source scanner. */
function findAstroChildrenRange(
  template: string,
  searchStart: number,
  tagName: string
): AstroChildrenRange | null {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<\\/?${escaped}(?=[\\s/>])[^>]*?>`, 'gi');
  pattern.lastIndex = searchStart;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template))) {
    const text = match[0];
    if (text.startsWith('</')) {
      depth -= 1;
      if (depth === 0) {
        return {
          childrenStart: searchStart,
          childrenEnd: match.index,
          end: match.index + text.length,
        };
      }
    } else if (!text.trimEnd().endsWith('/>')) {
      depth += 1;
    }
  }
  return null;
}

function parseAstroAttributes(
  file: SourceFileSnapshot,
  tagStart: number,
  tagText: string,
  tagName: string
): RawJsxAttribute[] {
  const nameOffset = tagText.indexOf(tagName) + tagName.length;
  const body = tagText.slice(nameOffset, Math.max(nameOffset, tagText.length - 1));
  const attributes: RawJsxAttribute[] = [];
  const attributePattern =
    /([:@A-Za-z_$][\w$.:!-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^{}]*)\}))?/g;
  for (const match of body.matchAll(attributePattern)) {
    const name = match[1];
    if (!name || name === '/') continue;
    const relativeStart = nameOffset + (match.index ?? 0);
    const rawLength = match[0].length;
    const source = sourceRefFromUtf16Range(
      file.file,
      file.content,
      file.contentHash,
      tagStart + relativeStart,
      tagStart + relativeStart + rawLength
    );
    const quotedValue = match[2] ?? match[3];
    const expression = match[4];
    const valueSource =
      quotedValue !== undefined
        ? sourceRefFromUtf16Range(
            file.file,
            file.content,
            file.contentHash,
            tagStart + relativeStart + match[0].indexOf(quotedValue),
            tagStart + relativeStart + match[0].indexOf(quotedValue) + quotedValue.length
          )
        : expression !== undefined
          ? sourceRefFromUtf16Range(
              file.file,
              file.content,
              file.contentHash,
              tagStart + relativeStart + match[0].indexOf(expression),
              tagStart + relativeStart + match[0].indexOf(expression) + expression.length
            )
          : null;
    const staticValue =
      quotedValue !== undefined
        ? { kind: 'string' as const, value: quotedValue }
        : expression !== undefined
          ? staticAstroValue(expression)
          : { kind: 'boolean' as const, value: true };
    attributes.push({
      name,
      source,
      valueSource,
      expressionText: expression?.trim() ?? null,
      staticValue,
      dynamicReason:
        expression !== undefined && !staticValue
          ? 'Astro expressions are dynamic unless they are losslessly static literals.'
          : null,
    });
  }
  return attributes;
}

function staticAstroValue(expression: string): StaticValue | null {
  const trimmed = expression.trim();
  if (!trimmed) return null;
  if (trimmed === 'true') return { kind: 'boolean', value: true };
  if (trimmed === 'false') return { kind: 'boolean', value: false };
  if (trimmed === 'null') return { kind: 'null', value: null };
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) {
    const value = Number(trimmed);
    return Number.isFinite(value) ? { kind: 'number', value } : null;
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return { kind: 'string', value: trimmed.slice(1, -1) };
  }
  return null;
}

function insideIgnoredTemplateBlock(template: string, offset: number): boolean {
  const openingPattern = /<(script|style)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = openingPattern.exec(template))) {
    const endTag = `</${match[1]}>`;
    const end = template.toLowerCase().indexOf(endTag.toLowerCase(), match.index + match[0].length);
    if (end < 0) return offset > match.index;
    if (offset > match.index && offset < end + endTag.length) return true;
  }
  return false;
}

function findSyntheticJsxNode(
  sourceFile: ts.SourceFile
): ts.JsxElement | ts.JsxSelfClosingElement | null {
  let found: ts.JsxElement | ts.JsxSelfClosingElement | null = null;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function resolveAstroUsageTarget(
  file: ParsedComponentFile,
  usage: RawJsxUsage,
  byFile: Map<string, ParsedComponentFile>,
  descriptorByFile: Map<string, ComponentDescriptor>,
  resolvedImports: Map<string, ResolvedImportEdge>
): ComponentDescriptor | null {
  const importEdge = file.imports.find((edge) => {
    if (usage.namespaceName) return edge.isNamespace && edge.localName === usage.namespaceName;
    return edge.localName === usage.localName;
  });
  if (!importEdge) return null;
  const resolved = resolvedImports.get(importKey(importEdge));
  if (!resolved?.toFile) return null;
  const targetFile = byFile.get(normalizeProjectPath(resolved.toFile));
  if (!targetFile) return null;
  if (usage.namespaceName) return null;
  return descriptorByFile.get(normalizeProjectPath(targetFile.snapshot.file)) ?? null;
}

function resolveAstroModulePath(
  fromFile: string,
  specifier: string,
  files: readonly SourceFileSnapshot[]
): { status: 'resolved' | 'unresolved' | 'external'; file: string | null } {
  if (!specifier.startsWith('.')) return { status: 'external', file: null };
  const fromParts = normalizeProjectPath(fromFile).split('/');
  fromParts.pop();
  const base = normalizeProjectPath([...fromParts, specifier].join('/'));
  const candidates = [
    base,
    `${base}.astro`,
    `${base}/index.astro`,
    `${base}.tsx`,
    `${base}.jsx`,
    `${base}.ts`,
    `${base}.js`,
  ];
  const fileSet = new Set(files.map((file) => normalizeProjectPath(file.file)));
  const match = candidates.find((candidate) => fileSet.has(normalizeProjectPath(candidate)));
  return match
    ? { status: 'resolved', file: normalizeProjectPath(match) }
    : { status: 'unresolved', file: null };
}

function importKey(edge: RawImportEdge): string {
  return `${edge.fromFile}:${edge.sourceRef.start}:${edge.localName ?? ''}`;
}

function instanceId(componentId: string, source: SourceRef): string {
  return `${componentId}@${normalizeProjectPath(source.file)}:${source.start}`;
}

function symbolMatches(component: ComponentDescriptor, symbol: string | null): boolean {
  if (!symbol) return true;
  return (
    component.name === symbol || component.localName === symbol || component.exportName === symbol
  );
}

function astroSourceHash(index: ComponentIndex, file: string): string | null {
  const normalized = normalizeProjectPath(file);
  return (
    index.instances.find(
      (instance) => normalizeProjectPath(instance.invocation.file) === normalized
    )?.invocation.contentHash ??
    index.components.find(
      (component) => normalizeProjectPath(component.definition.file) === normalized
    )?.definition.contentHash ??
    null
  );
}

function uniqueBindings(items: { componentId: string; source: SourceRef }[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.componentId}:${item.source.file}:${item.source.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface AstroAnchorRange {
  status: 'matched';
  start: number;
  end: number;
  openingEnd: number;
  closingStart: number | null;
}

interface AstroAnchorAmbiguous {
  status: 'ambiguous';
}

/**
 * Locate a rendered-element anchor without reprinting the Astro document.
 * The compiler owns syntax validation; this scanner only chooses an exact
 * source insertion point and refuses when the line/selector is ambiguous.
 */
function findAstroAnchorRange(
  file: SourceFileSnapshot,
  input: InsertComponentInputWithContext
): AstroAnchorRange | AstroAnchorAmbiguous | null {
  const supplied = input.targetRange ? normalizeAstroTargetRange(file, input.targetRange) : null;
  if (input.targetRange && supplied) return supplied;
  if (input.targetRange) return null;

  const frontmatter = findFrontmatter(file.content);
  const ranges = astroTemplateRanges(file.content, frontmatter);
  const exact: AstroAnchorRange[] = [];
  const fuzzy: AstroAnchorRange[] = [];
  const expected = input.anchor.html.trim();
  for (const range of ranges) {
    const template = file.content.slice(range.start, range.end);
    const tagPattern = /<([A-Za-z][A-Za-z0-9_.:-]*)(?=[\s/>])[^>]*?>/g;
    for (const match of template.matchAll(tagPattern)) {
      const localStart = match.index ?? 0;
      if (insideIgnoredTemplateBlock(template, localStart)) continue;
      const start = range.start + localStart;
      const openingEnd = start + match[0].length;
      const tagName = match[1] ?? '';
      const startLine = file.content.slice(0, start).split('\n').length;
      const endLine = file.content.slice(0, Math.max(start, openingEnd - 1)).split('\n').length;
      if (input.anchor.line < startLine || input.anchor.line > endLine) continue;
      if (input.anchor.column && input.anchor.column > 0) {
        const lineStart = file.content.lastIndexOf('\n', start - 1) + 1;
        const columnOffset = lineStart + input.anchor.column - 1;
        if (columnOffset < start || columnOffset >= openingEnd) continue;
      }
      const matchesText = astroAnchorTextMatches(expected, tagName, match[0]);
      if (!matchesText) continue;
      const closing = findAstroClosingTag(file.content, openingEnd, tagName);
      const candidate: AstroAnchorRange = {
        status: 'matched',
        start,
        end: closing?.end ?? openingEnd,
        openingEnd,
        closingStart: closing?.start ?? null,
      };
      if (expected.length === 0 || match[0].trim() === expected) exact.push(candidate);
      else fuzzy.push(candidate);
    }
  }
  const candidates = exact.length > 0 ? exact : fuzzy;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return { status: 'ambiguous' };
  return null;
}

function normalizeAstroTargetRange(
  file: SourceFileSnapshot,
  range: NonNullable<InsertComponentInput['targetRange']>
): AstroAnchorRange | null {
  const start = utf8ByteOffsetToUtf16Offset(file.content, range.start);
  const end = utf8ByteOffsetToUtf16Offset(file.content, range.end);
  if (start === null || end === null || end < start) return null;
  const opening = findAstroOpeningAt(file.content, start, end);
  if (!opening) return null;
  const closing = findAstroClosingTag(file.content, opening.end, opening.tagName);
  const actualEnd = closing?.end ?? opening.end;
  if (actualEnd !== end) return null;
  const suppliedOpening =
    range.openingEnd === undefined
      ? null
      : utf8ByteOffsetToUtf16Offset(file.content, range.openingEnd);
  const suppliedClosing =
    range.closingStart === undefined
      ? null
      : utf8ByteOffsetToUtf16Offset(file.content, range.closingStart);
  if (
    (range.openingEnd !== undefined && suppliedOpening !== opening.end) ||
    (range.closingStart !== undefined && suppliedClosing !== (closing?.start ?? null))
  ) {
    return null;
  }
  return {
    status: 'matched',
    start,
    end: actualEnd,
    openingEnd: opening.end,
    closingStart: closing?.start ?? null,
  };
}

function astroAnchorTextMatches(expected: string, tagName: string, opening: string): boolean {
  if (!expected || opening.includes(expected) || tagName === expected) return true;
  const selector = expected.match(/^([A-Za-z][A-Za-z0-9:_-]*)?(?:\.([A-Za-z0-9_-]+))+$/);
  if (!selector) return false;
  if (selector[1] && selector[1] !== tagName) return false;
  const classValue = /\bclass(?:Name)?\s*=\s*(["'])([^"']*)\1/i.exec(opening)?.[2] ?? '';
  const classes = new Set(classValue.split(/\s+/).filter(Boolean));
  return [...expected.matchAll(/\.([A-Za-z0-9_-]+)/g)].every((match) => classes.has(match[1]));
}

interface AstroClosingTag {
  start: number;
  end: number;
}

function findAstroClosingTag(
  content: string,
  searchStart: number,
  tagName: string
): AstroClosingTag | null {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<\\/?${escaped}(?=[\\s/>])[^>]*?>`, 'gi');
  pattern.lastIndex = searchStart;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    const text = match[0];
    if (text.startsWith('</')) {
      depth -= 1;
      if (depth === 0) return { start: match.index, end: match.index + text.length };
    } else if (!text.trimEnd().endsWith('/>')) {
      depth += 1;
    }
  }
  return null;
}

interface AstroOpeningRange {
  tagName: string;
  start: number;
  end: number;
}

function findAstroOpeningAt(
  content: string,
  start: number,
  limit = content.length
): AstroOpeningRange | null {
  const match = /^<([A-Za-z][A-Za-z0-9_.:-]*)\b/.exec(content.slice(start));
  if (!match) return null;
  let quote: string | null = null;
  let expressionDepth = 0;
  for (let index = start + match[0].length; index < Math.min(limit, content.length); index += 1) {
    const character = content[index];
    if (quote) {
      if (character === quote && content[index - 1] !== '\\') quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') expressionDepth += 1;
    else if (character === '}' && expressionDepth > 0) expressionDepth -= 1;
    else if (character === '>' && expressionDepth === 0) {
      return { tagName: match[1], start, end: index + 1 };
    }
  }
  return null;
}

function planAstroInsert(
  input: InsertComponentInputWithContext,
  index: ComponentIndex
): MutationResult {
  const snapshot = input.snapshot;
  if (!snapshot)
    return astroRefuse('missing-source', 'A source snapshot is required for Astro placement.');
  if (snapshot.partial)
    return astroRefuse(
      'stale-source',
      'The Astro source snapshot is partial, so placement is disabled.'
    );
  const descriptor = index.components.find((component) => component.id === input.componentId);
  if (!descriptor)
    return astroRefuse('unsupported', 'The requested Astro component is not indexed.');
  if (
    descriptor.dialect !== 'astro' ||
    !descriptor.capabilities.place ||
    descriptor.kind === 'layout'
  ) {
    return astroRefuse(
      'not-placeable',
      'Only native Astro component definitions are placeable; layouts and foreign islands remain read-only.'
    );
  }
  const target = snapshot.files.find(
    (file) => normalizeProjectPath(file.file) === normalizeProjectPath(input.anchor.file)
  );
  if (!target || !isAstroSourcePath(target.file))
    return astroRefuse('unsupported', 'Astro placement requires a `.astro` source target.');
  const anchor = findAstroAnchorRange(target, input);
  if (!anchor)
    return astroRefuse('missing-anchor', 'The Astro source anchor did not match an element.');
  if (anchor.status === 'ambiguous')
    return astroRefuse(
      'ambiguous-anchor',
      'More than one Astro element matches the source anchor.'
    );
  if (normalizeProjectPath(descriptor.definition.file) === normalizeProjectPath(target.file))
    return astroRefuse(
      'dependency-cycle',
      'A component cannot be placed inside its own Astro definition.'
    );
  if (input.anchor.position === 'inside' && anchor.closingStart === null)
    return astroRefuse(
      'unsupported',
      'A self-closing Astro element cannot receive a child placement.'
    );

  const propsResult = astroBuildProps(descriptor, input.props ?? {});
  if (propsResult.status === 'refused') return propsResult;
  const importResult = resolveAstroImportForPlacement(target, descriptor, snapshot.files, index);
  if (importResult.status === 'refused') return importResult;
  const invocation = `<${importResult.localName}${astroPropsText(propsResult.props)} />`;
  const placement = astroPlacementEdit(target, anchor, input.anchor.position, invocation);
  if (!placement)
    return astroRefuse('unsupported', 'The Astro anchor could not be edited minimally.');
  const edits = [placement];
  if (importResult.importEdit) edits.push(importResult.importEdit);
  return plannedAstroMutation(target, edits, descriptor, 1, snapshot.revision);
}

function planAstroPropEdit(
  input: EditComponentPropInputWithContext,
  index: ComponentIndex
): MutationResult {
  const snapshot = input.snapshot;
  if (!snapshot)
    return astroRefuse('missing-source', 'A source snapshot is required for Astro prop editing.');
  if (snapshot.partial)
    return astroRefuse(
      'stale-source',
      'The Astro source snapshot is partial, so prop editing is disabled.'
    );
  const instance = index.instances.find((item) => item.id === input.instanceId);
  if (!instance) return astroRefuse('unsupported', 'The requested Astro usage is not indexed.');
  const descriptor = index.components.find((item) => item.id === instance.componentId);
  if (!descriptor || descriptor.dialect !== 'astro')
    return astroRefuse('unsupported', 'The usage does not point to a native Astro component.');
  if (!descriptor.capabilities.editStaticProps)
    return astroRefuse('unsupported', 'This Astro component contract is not safely editable.');
  const prop = descriptor.props.find((item) => item.name === input.propName);
  if (!prop)
    return astroRefuse('unknown-prop', `The Astro component does not declare "${input.propName}".`);
  const file = snapshot.files.find(
    (candidate) =>
      normalizeProjectPath(candidate.file) === normalizeProjectPath(instance.invocation.file)
  );
  if (!file || file.contentHash !== instance.invocation.contentHash)
    return astroRefuse('stale-source', 'The Astro invocation source hash is stale.');
  const start = utf8ByteOffsetToUtf16Offset(file.content, instance.invocation.start);
  const end = utf8ByteOffsetToUtf16Offset(file.content, instance.invocation.end);
  if (start === null || end === null)
    return astroRefuse('invalid-range', 'The Astro invocation range is invalid.');
  const opening = findAstroOpeningAt(file.content, start, end);
  if (!opening)
    return astroRefuse('stale-source', 'The Astro invocation no longer matches its source range.');
  const attributes = astroAttributeRanges(file.content, opening);
  const existing = attributes.find((attribute) => attribute.name === input.propName);
  const current = existing?.staticValue ?? (existing ? null : undefined);
  if (existing && current === null)
    return astroRefuse(
      'dynamic-expression',
      `The existing "${input.propName}" Astro value is dynamic.`
    );
  if (
    existing &&
    current !== null &&
    current !== undefined &&
    staticValuesEqual(current, input.value)
  )
    return astroRefuse('no-op', `The "${input.propName}" prop is already set to that value.`);
  const edit = existing
    ? {
        start: utf16OffsetToUtf8ByteOffset(file.content, existing.start),
        end: utf16OffsetToUtf8ByteOffset(file.content, existing.end),
        text: astroAttributeText(input.propName, input.value, existing.quote ?? '"'),
      }
    : {
        start: utf16OffsetToUtf8ByteOffset(
          file.content,
          opening.end - (file.content[opening.end - 2] === '/' ? 2 : 1)
        ),
        end: utf16OffsetToUtf8ByteOffset(
          file.content,
          opening.end - (file.content[opening.end - 2] === '/' ? 2 : 1)
        ),
        text: `${file.content[opening.end - (file.content[opening.end - 2] === '/' ? 2 : 1) - 1]?.trim() ? ' ' : ''}${astroAttributeText(input.propName, input.value)}`,
      };
  return plannedAstroMutation(file, [edit], descriptor, 0, snapshot.revision);
}

interface AstroAttributeRange {
  name: string;
  start: number;
  end: number;
  quote: string | null;
  staticValue: StaticValue | null;
}

function astroAttributeRanges(content: string, opening: AstroOpeningRange): AstroAttributeRange[] {
  const tagText = content.slice(opening.start, opening.end);
  const nameOffset = tagText.indexOf(opening.tagName) + opening.tagName.length;
  const body = tagText.slice(nameOffset, Math.max(nameOffset, tagText.length - 1));
  const attributes: AstroAttributeRange[] = [];
  const pattern = /([:@A-Za-z_$][\w$.:!-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^{}]*)\}))?/g;
  for (const match of body.matchAll(pattern)) {
    const name = match[1];
    if (!name || name === '/') continue;
    const start = opening.start + nameOffset + (match.index ?? 0);
    const quoted = match[2] ?? match[3];
    const expression = match[4];
    attributes.push({
      name,
      start,
      end: start + match[0].length,
      quote: match[2] !== undefined ? '"' : match[3] !== undefined ? "'" : null,
      staticValue:
        quoted !== undefined
          ? { kind: 'string', value: quoted }
          : expression !== undefined
            ? staticAstroValue(expression)
            : { kind: 'boolean', value: true },
    });
  }
  return attributes;
}

function staticValuesEqual(left: StaticValue, right: StaticValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function astroBuildProps(
  descriptor: ComponentDescriptor,
  explicit: Record<string, StaticValue>
):
  | { status: 'ok'; props: Record<string, StaticValue> }
  | Extract<MutationResult, { status: 'refused' }> {
  const known = new Set(descriptor.props.map((prop) => prop.name));
  for (const name of Object.keys(explicit)) {
    if (!known.has(name))
      return astroRefuse('unknown-prop', `The Astro component does not declare "${name}".`);
  }
  for (const prop of descriptor.props) {
    if (prop.required && explicit[prop.name] === undefined) {
      return astroRefuse(
        'required-prop',
        `The required Astro prop "${prop.name}" needs an explicit value.`
      );
    }
  }
  return { status: 'ok', props: explicit };
}

function astroPropsText(props: Record<string, StaticValue>): string {
  return Object.entries(props)
    .map(([name, value]) => ` ${astroAttributeText(name, value)}`)
    .join('');
}

function astroAttributeText(name: string, value: StaticValue, quote = '"'): string {
  if (!/^[A-Za-z_$][\w$:-]*$/.test(name)) return `${name}=${staticValueToJsx(value, quote)}`;
  if (value.kind === 'boolean' && value.value) return name;
  return `${name}=${staticValueToJsx(value, quote)}`;
}

interface AstroImportPlacement {
  status: 'ok';
  localName: string;
  importEdit: ComponentTextEdit | null;
}

function resolveAstroImportForPlacement(
  target: SourceFileSnapshot,
  descriptor: ComponentDescriptor,
  files: readonly SourceFileSnapshot[],
  index: ComponentIndex
): AstroImportPlacement | Extract<MutationResult, { status: 'refused' }> {
  const definitionFile = normalizeProjectPath(descriptor.definition.file);
  if (definitionFile === normalizeProjectPath(target.file)) {
    return { status: 'ok', localName: descriptor.localName, importEdit: null };
  }
  if (hasAstroDependencyPath(index, definitionFile, target.file))
    return astroRefuse(
      'dependency-cycle',
      'Placing this Astro component would introduce an import cycle.'
    );
  const frontmatter = findFrontmatter(target.content);
  const existingImports = parseAstroImports(target, frontmatter);
  for (const edge of existingImports) {
    const resolution = edge.source.startsWith('.')
      ? resolveAstroModulePath(target.file, edge.source, files)
      : { status: 'external' as const, file: null };
    if (resolution.file !== definitionFile) continue;
    if (edge.localName) return { status: 'ok', localName: edge.localName, importEdit: null };
  }
  const desiredName = descriptor.localName;
  if (astroTopLevelBindingNames(target, frontmatter).has(desiredName))
    return astroRefuse(
      'symbol-collision',
      `The Astro name "${desiredName}" is already bound in ${target.file}.`
    );
  const specifier = astroModuleSpecifierForFile(target.file, definitionFile);
  const quote = existingImports.some((edge) => {
    const start = edge.sourceRef.start;
    const end = edge.sourceRef.end;
    const sourceStart = utf8ByteOffsetToUtf16Offset(target.content, start);
    const sourceEnd = utf8ByteOffsetToUtf16Offset(target.content, end);
    return sourceStart !== null && sourceEnd !== null && target.content[sourceStart - 1] === "'";
  })
    ? "'"
    : '"';
  const importText = `import ${desiredName} from ${quote}${specifier}${quote};`;
  const newline = target.content.includes('\r\n') ? '\r\n' : '\n';
  if (frontmatter) {
    const body = target.content.slice(frontmatter.bodyStart, frontmatter.bodyEnd);
    const prefix = body.length > 0 && !body.endsWith(newline) ? newline : '';
    const insertion = frontmatter.bodyEnd;
    return {
      status: 'ok',
      localName: desiredName,
      importEdit: {
        start: utf16OffsetToUtf8ByteOffset(target.content, insertion),
        end: utf16OffsetToUtf8ByteOffset(target.content, insertion),
        text: `${prefix}${importText}${newline}`,
      },
    };
  }
  const insertion = target.content.startsWith('\uFEFF') ? 1 : 0;
  return {
    status: 'ok',
    localName: desiredName,
    importEdit: {
      start: utf16OffsetToUtf8ByteOffset(target.content, insertion),
      end: utf16OffsetToUtf8ByteOffset(target.content, insertion),
      text: `---${newline}${importText}${newline}---${newline}`,
    },
  };
}

function astroTopLevelBindingNames(
  file: SourceFileSnapshot,
  frontmatter: FrontmatterBounds | null
): Set<string> {
  const names = new Set<string>();
  if (!frontmatter) return names;
  for (const edge of parseAstroImports(file, frontmatter)) {
    if (edge.localName) names.add(edge.localName);
  }
  const body = file.content.slice(frontmatter.bodyStart, frontmatter.bodyEnd);
  const pattern = /\b(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of body.matchAll(pattern)) if (match[1]) names.add(match[1]);
  return names;
}

function astroModuleSpecifierForFile(fromFile: string, toFile: string): string {
  const from = normalizeProjectPath(fromFile).split('/');
  from.pop();
  const target = normalizeProjectPath(toFile).split('/');
  while (from.length > 0 && target.length > 0 && from[0] === target[0]) {
    from.shift();
    target.shift();
  }
  const relative = `${'../'.repeat(from.length)}${target.join('/')}`;
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function hasAstroDependencyPath(index: ComponentIndex, from: string, to: string): boolean {
  if (normalizeProjectPath(from) === normalizeProjectPath(to)) return false;
  const edges = new Map<string, string[]>();
  for (const edge of index.importEdges) {
    if (!edge.toFile) continue;
    edges.set(edge.fromFile, [
      ...(edges.get(edge.fromFile) ?? []),
      normalizeProjectPath(edge.toFile),
    ]);
  }
  const queue = [normalizeProjectPath(from)];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of edges.get(current) ?? []) {
      if (next === normalizeProjectPath(to)) return true;
      queue.push(next);
    }
  }
  return false;
}

function astroPlacementEdit(
  file: SourceFileSnapshot,
  range: AstroAnchorRange,
  position: InsertComponentInput['anchor']['position'],
  invocation: string
): ComponentTextEdit | null {
  const newline = file.content.includes('\r\n') ? '\r\n' : '\n';
  const lineStart = file.content.lastIndexOf('\n', range.start - 1) + 1;
  const indent = file.content.slice(lineStart, range.start).match(/^[ \t]*/)?.[0] ?? '';
  if (position === 'inside') {
    if (range.closingStart === null) return null;
    const between = file.content.slice(range.openingEnd, range.closingStart);
    if (between.includes('\n')) {
      const childIndent = inferAstroChildIndent(
        file.content,
        range.openingEnd,
        range.closingStart,
        indent
      );
      return {
        start: utf16OffsetToUtf8ByteOffset(file.content, range.openingEnd),
        end: utf16OffsetToUtf8ByteOffset(file.content, range.openingEnd),
        text: `${newline}${childIndent}${invocation}${newline}${indent}`,
      };
    }
    return {
      start: utf16OffsetToUtf8ByteOffset(file.content, range.openingEnd),
      end: utf16OffsetToUtf8ByteOffset(file.content, range.openingEnd),
      text: ` ${invocation} `,
    };
  }
  if (position === 'before') {
    return {
      start: utf16OffsetToUtf8ByteOffset(file.content, range.start),
      end: utf16OffsetToUtf8ByteOffset(file.content, range.start),
      text: `${invocation}${newline}${indent}`,
    };
  }
  return {
    start: utf16OffsetToUtf8ByteOffset(file.content, range.end),
    end: utf16OffsetToUtf8ByteOffset(file.content, range.end),
    text: `${newline}${indent}${invocation}`,
  };
}

function inferAstroChildIndent(
  content: string,
  openingEnd: number,
  closingStart: number,
  parentIndent: string
): string {
  const line = content
    .slice(openingEnd, closingStart)
    .split('\n')
    .find((item) => /\S/.test(item));
  return line?.match(/^[ \t]*/)?.[0] ?? `${parentIndent}  `;
}

function plannedAstroMutation(
  file: SourceFileSnapshot,
  edits: ComponentTextEdit[],
  descriptor: ComponentDescriptor,
  graphDelta: number,
  revision: string
): MutationResult {
  const sorted = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);
  const result = applyTextEdits(file.content, sorted);
  if (result === null)
    return astroRefuse('invalid-range', 'The Astro edits overlap or split a UTF-8 code point.');
  if (result === file.content)
    return astroRefuse('no-op', 'The requested Astro change is already present.');
  const mutation: ComponentFileMutation = {
    file: normalizeProjectPath(file.file),
    expectedHash: file.contentHash,
    expectedResultHash: sha256(result),
    edits: sorted,
  };
  return {
    status: 'planned',
    plan: {
      files: [mutation],
      dialect: 'astro',
      parserToken: ASTRO_COMPONENT_PLAN_PARSER_TOKEN,
      expectedRevision: revision,
      expectedGraphDelta: {
        componentId: descriptor.id,
        usagesBefore: descriptor.usageCount,
        usagesAfter: descriptor.usageCount + graphDelta,
        delta: graphDelta,
      },
    },
  };
}

function validateAstroMutationSync(input: MutationValidationInput): MutationValidationResult {
  const diagnostics: ComponentDiagnostic[] = [];
  if (
    input.plan.dialect !== 'astro' ||
    input.plan.parserToken !== ASTRO_COMPONENT_PLAN_PARSER_TOKEN
  ) {
    diagnostics.push({
      code: 'astro-mutation-protocol',
      severity: 'error',
      message: 'The mutation plan does not use the supported Astro parser protocol.',
    });
  }
  if (input.plan.operations?.length) {
    diagnostics.push({
      code: 'astro-mutation-operation',
      severity: 'error',
      message: 'Astro lifecycle operations are not enabled by this adapter.',
    });
  }
  for (const mutation of input.plan.files) {
    const file = input.snapshot.files.find(
      (candidate) => normalizeProjectPath(candidate.file) === normalizeProjectPath(mutation.file)
    );
    if (!file) {
      diagnostics.push({
        code: 'mutation-file-missing',
        severity: 'error',
        message: `Mutation file ${mutation.file} is not in the source snapshot.`,
        file: mutation.file,
      });
      continue;
    }
    if (file.contentHash !== mutation.expectedHash) {
      diagnostics.push({
        code: 'mutation-stale-hash',
        severity: 'error',
        message: 'The Astro mutation source hash is stale.',
        file: mutation.file,
      });
      continue;
    }
    const result = applyTextEdits(file.content, mutation.edits);
    if (result === null || sha256(result) !== mutation.expectedResultHash) {
      diagnostics.push({
        code: 'mutation-invalid-range',
        severity: 'error',
        message: 'The Astro mutation result does not match its expected source hash.',
        file: mutation.file,
      });
      continue;
    }
    if (findFrontmatter(result) === null && /^\uFEFF?[ \t]*---(?:\r?\n|$)/.test(result)) {
      diagnostics.push({
        code: 'astro-frontmatter-invalid',
        severity: 'error',
        message: 'The proposed Astro source has an unterminated frontmatter fence.',
        file: mutation.file,
      });
    }
  }
  return diagnostics.length > 0
    ? { status: 'invalid', diagnostics }
    : { status: 'valid', diagnostics: [] };
}

function astroRefuse(
  code: Extract<MutationResult, { status: 'refused' }>['code'],
  message: string
): Extract<MutationResult, { status: 'refused' }> {
  return {
    status: 'refused',
    code,
    message,
    diagnostics: [{ code: `astro-mutation-${code}`, severity: 'warning', message }],
  };
}

export function createAstroAdapter(): AstroComponentAdapter {
  return new AstroComponentAdapter();
}
