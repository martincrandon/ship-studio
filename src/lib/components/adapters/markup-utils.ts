import ts from 'typescript';
import { applyTextEdits, sha256, sourceRefFromUtf16Range, sourceTextForRef } from '../ranges';
import { staticValueFromExpression, staticValueToJsx } from './static-values';
import { basenameWithoutExtension, normalizeProjectPath } from './react-helpers';
import { planStaticSlotEdit } from '../slots';
import type {
  AdapterGraph,
  ComponentAdapter,
  DetectionContext,
  EditComponentPropInputWithContext,
  EditComponentSlotInputWithContext,
  GraphContext,
  InsertComponentInputWithContext,
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
  ComponentDescriptor,
  ComponentDiagnostic,
  ComponentIndex,
  ComponentInstance,
  ComponentImportEdge,
  ComponentPropDescriptor,
  ComponentSlotDescriptor,
  ComponentTextEdit,
  MutationResult,
  MutationValidationInput,
  MutationValidationResult,
  SelectionBindingInput,
  SourceFileSnapshot,
  ComponentSourceSnapshot,
  SourceRef,
  StaticExpression,
  StaticValue,
  UnsetExpression,
  DynamicExpression,
} from '../types';

/** A half-open UTF-16 range used only while parsing a markup document. */
export interface MarkupRange {
  start: number;
  end: number;
}

export interface MarkupDefinitionModel {
  name: string;
  kind: ComponentDescriptor['kind'];
  props: ComponentPropDescriptor[];
  slots: ComponentSlotDescriptor[];
  diagnostics?: ComponentDiagnostic[];
}

export interface MarkupAdapterConfig {
  dialect: ComponentAdapter['dialect'];
  extensions: readonly string[];
  isDefinitionFile(file: string): boolean;
  definition(file: SourceFileSnapshot): MarkupDefinitionModel | null;
  templateRanges(file: SourceFileSnapshot): readonly MarkupRange[];
  isComponentTag(tagName: string, file: SourceFileSnapshot): boolean;
  /** Optional target for tags which do not use a local import (Shopify/custom elements). */
  resolveGlobalTag?(
    tagName: string,
    files: readonly ParsedComponentFile[]
  ): ComponentDescriptor | null;
  /** Optional syntax-specific usage scanner for non-HTML invocation forms. */
  parseUsages?(file: SourceFileSnapshot, ranges: readonly MarkupRange[]): RawJsxUsage[];
  parseImports(file: SourceFileSnapshot): RawImportEdge[];
  resolveModule(
    fromFile: string,
    specifier: string,
    files: readonly SourceFileSnapshot[]
  ): { status: 'resolved' | 'unresolved' | 'external'; file: string | null };
  capabilities: ComponentCapabilities;
  parserToken?: string;
  compilerDiagnostics?(file: SourceFileSnapshot): ComponentDiagnostic[];
  renderInvocation(descriptor: ComponentDescriptor, props: Record<string, StaticValue>): string;
  renderImport(localName: string, specifier: string): string;
  formatPropValue(file: SourceFileSnapshot, name: string, value: StaticValue): string;
  insertionPoint(file: SourceFileSnapshot): number;
  /** Markup-level attribute insertion, used when a prop was previously unset. */
  renderAttribute(name: string, value: StaticValue): string;
  normalizeTagName?(tagName: string): string;
}

interface OpeningTag {
  tagName: string;
  start: number;
  end: number;
  nameEnd: number;
  selfClosing: boolean;
  attributes: RawJsxAttribute[];
  closeStart: number | null;
  closeEnd: number | null;
}

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function isIdentifierChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_$:.-]/.test(char);
}

function ref(file: SourceFileSnapshot, start: number, end: number): SourceRef {
  return sourceRefFromUtf16Range(file.file, file.content, file.contentHash, start, end);
}

function skipQuotedOrExpression(content: string, from: number, quote?: string): number {
  if (quote) {
    for (let index = from; index < content.length; index += 1) {
      if (content[index] === quote && content[index - 1] !== '\\') return index + 1;
    }
    return content.length;
  }
  let depth = 1;
  let activeQuote = '';
  for (let index = from; index < content.length; index += 1) {
    const char = content[index];
    if (activeQuote) {
      if (char === activeQuote && content[index - 1] !== '\\') activeQuote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      activeQuote = char;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return content.length;
}

function findOpeningTagEnd(content: string, from: number): number | null {
  let activeQuote = '';
  let braces = 0;
  for (let index = from; index < content.length; index += 1) {
    const char = content[index];
    if (activeQuote) {
      if (char === activeQuote && content[index - 1] !== '\\') activeQuote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      activeQuote = char;
    } else if (char === '{') {
      braces += 1;
    } else if (char === '}' && braces > 0) {
      braces -= 1;
    } else if (char === '>' && braces === 0) {
      return index + 1;
    }
  }
  return null;
}

function staticExpression(value: string): StaticValue | null {
  const source = ts.createSourceFile(
    'component-prop.ts',
    `const value = (${value});`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const declaration = source.statements[0];
  if (!declaration || !ts.isVariableStatement(declaration)) return null;
  const initializer = declaration.declarationList.declarations[0]?.initializer;
  return initializer ? staticValueFromExpression(initializer) : null;
}

function parseMarkupAttributes(
  file: SourceFileSnapshot,
  content: string,
  nameEnd: number,
  tagEnd: number
): RawJsxAttribute[] {
  const attributes: RawJsxAttribute[] = [];
  let index = nameEnd;
  while (index < tagEnd - 1) {
    while (index < tagEnd - 1 && /\s/.test(content[index] ?? '')) index += 1;
    if (index >= tagEnd - 1 || content[index] === '/') break;
    const attributeStart = index;
    while (index < tagEnd - 1 && isIdentifierChar(content[index])) index += 1;
    if (index === attributeStart) {
      index += 1;
      continue;
    }
    const name = content.slice(attributeStart, index);
    while (index < tagEnd - 1 && /\s/.test(content[index] ?? '')) index += 1;
    let valueSource: SourceRef | null = null;
    let expressionText: string | null = null;
    let staticValue: StaticValue | null = { kind: 'boolean', value: true };
    let dynamicReason: string | null = null;
    if (content[index] === '=') {
      index += 1;
      while (index < tagEnd - 1 && /\s/.test(content[index] ?? '')) index += 1;
      const valueStart = index;
      if (content[index] === '"' || content[index] === "'") {
        const quote = content[index];
        index = skipQuotedOrExpression(content, index + 1, quote);
        valueSource = ref(file, valueStart, index);
        staticValue = {
          kind: 'string',
          value: content.slice(valueStart + 1, Math.max(valueStart + 1, index - 1)),
        };
        if (/^(?::|v-bind:)/i.test(name)) {
          expressionText = content
            .slice(valueStart + 1, Math.max(valueStart + 1, index - 1))
            .trim();
          staticValue = staticExpression(expressionText);
          if (!staticValue) dynamicReason = 'The binding expression is not a static literal.';
        }
      } else if (content[index] === '{') {
        index = skipQuotedOrExpression(content, index + 1);
        valueSource = ref(file, valueStart, index);
        expressionText = content.slice(valueStart + 1, Math.max(valueStart + 1, index - 1)).trim();
        staticValue = staticExpression(expressionText);
        if (!staticValue) dynamicReason = 'The binding expression is not a static literal.';
      } else {
        while (index < tagEnd - 1 && !/\s/.test(content[index] ?? '')) index += 1;
        valueSource = ref(file, valueStart, index);
        staticValue = staticExpression(content.slice(valueStart, index));
        if (!staticValue) {
          staticValue = { kind: 'string', value: content.slice(valueStart, index) };
        }
      }
    }
    const source = ref(file, attributeStart, index);
    attributes.push({
      name,
      source,
      valueSource,
      expressionText,
      staticValue,
      dynamicReason,
    });
  }
  return attributes;
}

function findClosingTag(
  content: string,
  tagName: string,
  from: number,
  limit: number
): { start: number; end: number } | null {
  const opening = new RegExp(
    `<\\s*${tagName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}(?:\\s|/?>)`,
    'gi'
  );
  const closing = new RegExp(
    `<\\/\\s*${tagName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*>`,
    'gi'
  );
  let depth = 1;
  let cursor = from;
  while (cursor < limit) {
    opening.lastIndex = cursor;
    closing.lastIndex = cursor;
    const nextOpening = opening.exec(content);
    const nextClosing = closing.exec(content);
    if (!nextClosing || (nextOpening && nextOpening.index < nextClosing.index)) {
      if (!nextOpening) return null;
      const openEnd = findOpeningTagEnd(content, nextOpening.index + 1);
      if (!openEnd) return null;
      if (!content.slice(nextOpening.index, openEnd).trimEnd().endsWith('/>')) depth += 1;
      cursor = openEnd;
      continue;
    }
    depth -= 1;
    if (depth === 0)
      return { start: nextClosing.index, end: nextClosing.index + nextClosing[0].length };
    cursor = nextClosing.index + nextClosing[0].length;
  }
  return null;
}

function scanOpeningTags(
  file: SourceFileSnapshot,
  range: MarkupRange,
  predicate: (tagName: string) => boolean
): OpeningTag[] {
  const content = file.content;
  const result: OpeningTag[] = [];
  let cursor = range.start;
  while (cursor < range.end) {
    const start = content.indexOf('<', cursor);
    if (start < 0 || start >= range.end) break;
    if (content.startsWith('<!--', start)) {
      cursor = content.indexOf('-->', start + 4);
      cursor = cursor < 0 ? range.end : cursor + 3;
      continue;
    }
    if (content[start + 1] === '/' || content[start + 1] === '!' || content[start + 1] === '?') {
      cursor = start + 2;
      continue;
    }
    const nameMatch = /^<\s*([A-Za-z][A-Za-z0-9:._-]*)/.exec(content.slice(start, range.end));
    if (!nameMatch) {
      cursor = start + 1;
      continue;
    }
    const tagName = nameMatch[1];
    const nameEnd = start + nameMatch[0].length;
    const end = findOpeningTagEnd(content, nameEnd);
    if (!end || end > range.end) break;
    cursor = end;
    if (!predicate(tagName)) continue;
    const selfClosing =
      content.slice(start, end).trimEnd().endsWith('/>') || VOID_TAGS.has(tagName.toLowerCase());
    const close = selfClosing ? null : findClosingTag(content, tagName, end, range.end);
    result.push({
      tagName,
      start,
      end,
      nameEnd,
      selfClosing,
      attributes: parseMarkupAttributes(file, content, nameEnd, end),
      closeStart: close?.start ?? null,
      closeEnd: close?.end ?? null,
    });
  }
  return result;
}

/**
 * Find named slot bodies without interpreting framework expressions. The
 * adapter already proved the surrounding invocation as markup; this helper
 * only returns ranges for explicit `slot="name"`, Vue `#name`/`v-slot:name`,
 * and Svelte-compatible template forms. Dynamic slot names are deliberately
 * omitted so the mutation planner can fail closed.
 */
function namedSlotSources(file: SourceFileSnapshot, range: MarkupRange): Record<string, SourceRef> {
  const result: Record<string, SourceRef> = {};
  const tags = scanOpeningTags(file, range, () => true);
  for (const tag of tags) {
    const slotAttribute = tag.attributes.find((attribute) => attribute.name === 'slot');
    const slotName =
      slotAttribute?.staticValue?.kind === 'string' ? slotAttribute.staticValue.value.trim() : '';
    if (slotName && !tag.selfClosing && tag.closeStart !== null) {
      result[slotName] = ref(file, tag.end, tag.closeStart);
    }
    if (tag.tagName.toLowerCase() !== 'template') continue;
    const source = file.content.slice(tag.start, tag.end);
    const named = /(?:#|v-slot:)([A-Za-z_$][\w-]*)/.exec(source)?.[1];
    if (named && !tag.selfClosing && tag.closeStart !== null) {
      result[named] = ref(file, tag.end, tag.closeStart);
    }
  }
  return result;
}

export function parseMarkupFile(
  file: SourceFileSnapshot,
  _context: ParseContext,
  config: MarkupAdapterConfig
): ParsedComponentFile {
  const sourceFile = ts.createSourceFile(
    file.file,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const model = config.isDefinitionFile(file.file) ? config.definition(file) : null;
  const definition = model ? makeDefinition(file, model, config) : null;
  const templateRanges = config.templateRanges(file);
  const markupUsages = templateRanges
    .flatMap((range) =>
      scanOpeningTags(file, range, (tagName) => config.isComponentTag(tagName, file))
    )
    .map((tag) => {
      const end = tag.closeEnd ?? tag.end;
      const childrenStart = tag.closeStart ?? tag.end;
      const hasChildren = childrenStart > tag.end;
      const localName = config.normalizeTagName?.(tag.tagName) ?? tag.tagName;
      const named = hasChildren
        ? namedSlotSources(file, { start: tag.end, end: childrenStart })
        : {};
      const slotSources =
        Object.keys(named).length > 0
          ? named
          : hasChildren
            ? { default: ref(file, tag.end, childrenStart) }
            : {};
      return {
        tagName: tag.tagName,
        localName,
        namespaceName: null,
        invocation: ref(file, tag.start, end),
        attributes: tag.attributes,
        childrenSource: hasChildren ? ref(file, tag.end, childrenStart) : null,
        ...(Object.keys(slotSources).length > 0 ? { slotSources } : {}),
        containingLocalName: null,
        node: sourceFile as unknown as ts.JsxElement,
      } satisfies RawJsxUsage;
    });
  const usages = [...markupUsages, ...(config.parseUsages?.(file, templateRanges) ?? [])];
  const diagnostics = [
    ...(model?.diagnostics ?? []),
    ...(config.compilerDiagnostics?.(file) ?? []),
  ];
  return {
    snapshot: file,
    sourceFile,
    components: definition ? [definition] : [],
    imports: config.parseImports(file),
    usages,
    exports: definition
      ? new Map<string, string>([['default', definition.localName]])
      : new Map<string, string>(),
    reExports: [],
    diagnostics,
  };
}

function makeDefinition(
  file: SourceFileSnapshot,
  model: MarkupDefinitionModel,
  config: MarkupAdapterConfig
) {
  const definition = ref(file, 0, file.content.length);
  const descriptor: ComponentDescriptor = {
    id: `${config.dialect}:${normalizeProjectPath(file.file)}#default`,
    dialect: config.dialect,
    kind: model.kind,
    name: model.name,
    localName: model.name,
    exportName: 'default',
    description: null,
    definition,
    props: model.props,
    slots: model.slots,
    variantProps: [],
    usageCount: 0,
    capabilities: config.capabilities,
    diagnostics: model.diagnostics ?? [],
  };
  return {
    localName: model.name,
    exportName: 'default',
    descriptor,
    declaration: ts.createSourceFile(
      file.file,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    ),
    props: model.props,
    capabilities: config.capabilities,
    isDefault: true,
  };
}

function importKey(edge: RawImportEdge): string {
  return `${normalizeProjectPath(edge.fromFile)}:${edge.sourceRef.start}:${edge.localName ?? ''}`;
}

function resolveUsageTarget(
  file: ParsedComponentFile,
  usage: RawJsxUsage,
  byFile: Map<string, ParsedComponentFile>,
  descriptorsByFile: Map<string, ComponentDescriptor>,
  resolvedImports: Map<string, ResolvedImportEdge>,
  files: readonly ParsedComponentFile[],
  config: MarkupAdapterConfig
): ComponentDescriptor | null {
  const importEdge = file.imports.find((edge) => edge.localName === usage.localName);
  if (importEdge) {
    const resolved = resolvedImports.get(importKey(importEdge));
    const target = resolved?.toFile ? byFile.get(normalizeProjectPath(resolved.toFile)) : null;
    if (target) return descriptorsByFile.get(normalizeProjectPath(target.snapshot.file)) ?? null;
  }
  return config.resolveGlobalTag?.(usage.tagName, files) ?? null;
}

export function buildMarkupUsageGraph(
  files: ParsedComponentFile[],
  context: GraphContext,
  config: MarkupAdapterConfig
): AdapterGraph {
  const byFile = new Map(files.map((file) => [normalizeProjectPath(file.snapshot.file), file]));
  const descriptors = files.flatMap((file) =>
    file.components.map((component) => component.descriptor)
  );
  const descriptorsByFile = new Map(
    descriptors.map((descriptor) => [normalizeProjectPath(descriptor.definition.file), descriptor])
  );
  const resolvedImports = new Map<string, ResolvedImportEdge>();
  const importEdges: ComponentImportEdge[] = [];
  const diagnostics: ComponentDiagnostic[] = files.flatMap((file) => file.diagnostics);

  for (const file of files) {
    for (const raw of file.imports) {
      const resolved = config.resolveModule(
        raw.fromFile,
        raw.source,
        context.sourceFiles ?? files.map((item) => item.snapshot)
      );
      const edge: ResolvedImportEdge = {
        ...raw,
        toFile: resolved.file,
        status: resolved.status,
        diagnostics:
          resolved.status === 'unresolved'
            ? [
                {
                  code: `${config.dialect}-unresolved-import`,
                  severity: 'warning',
                  message: `Could not resolve the import "${raw.source}" from ${raw.fromFile}.`,
                  file: raw.fromFile,
                  source: raw.sourceRef,
                },
              ]
            : [],
      };
      resolvedImports.set(importKey(raw), edge);
      importEdges.push({
        fromFile: raw.fromFile,
        toFile: edge.toFile,
        importedName: raw.importedName,
        localName: raw.localName,
        source: raw.sourceRef,
        status: edge.status,
        diagnostics: edge.diagnostics,
      });
    }
  }

  const instances: ComponentInstance[] = [];
  for (const file of files) {
    for (const usage of file.usages) {
      const target = resolveUsageTarget(
        file,
        usage,
        byFile,
        descriptorsByFile,
        resolvedImports,
        files,
        config
      );
      if (!target) {
        if (usage.localName && !/^(?:slot|svelte:|template$)/i.test(usage.localName)) {
          diagnostics.push({
            code: `${config.dialect}-unresolved-usage`,
            severity: 'warning',
            message: `Could not resolve ${usage.tagName} to an indexed component definition.`,
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
          props[attribute.name.replace(/^(?::|@|v-bind:|bind:)/i, '')] = {
            kind: 'static',
            value: attribute.staticValue,
            source,
          };
        } else {
          props[attribute.name.replace(/^(?::|@|v-bind:|bind:)/i, '')] = {
            kind: 'dynamic',
            text: attribute.expressionText ?? attribute.source.file,
            reason: attribute.dynamicReason ?? 'The attribute value is dynamic.',
            source,
          };
        }
      }
      const slotSources =
        usage.slotSources ?? (usage.childrenSource ? { default: usage.childrenSource } : {});
      const slotEntries = Object.entries(slotSources);
      instances.push({
        id: `${target.id}@${normalizeProjectPath(usage.invocation.file)}:${usage.invocation.start}`,
        componentId: target.id,
        invocation: usage.invocation,
        containingComponentId: null,
        route: null,
        props,
        slots: slotEntries.map(([name, source]) => ({
          name,
          value: null,
          sourceText: sourceTextForRef(file.snapshot.content, source) ?? undefined,
        })),
        ...(slotEntries.length
          ? {
              slotSources: Object.fromEntries(
                slotEntries.map(([name, source]) => [
                  name,
                  {
                    ...source,
                    text: sourceTextForRef(file.snapshot.content, source) ?? undefined,
                  },
                ])
              ),
            }
          : {}),
      });
      target.usageCount += 1;
    }
  }
  return { components: descriptors, instances, importEdges, diagnostics };
}

function sourceHashForCandidate(index: ComponentIndex, file: string): string | null {
  return (
    index.instances.find(
      (instance) => normalizeProjectPath(instance.invocation.file) === normalizeProjectPath(file)
    )?.invocation.contentHash ??
    index.components.find(
      (component) => normalizeProjectPath(component.definition.file) === normalizeProjectPath(file)
    )?.definition.contentHash ??
    null
  );
}

export function bindMarkupSelection(
  input: SelectionBindingInput,
  index: ComponentIndex,
  config: MarkupAdapterConfig
): ComponentBinding {
  const candidates = input.candidates?.length
    ? input.candidates.filter(
        (candidate) => candidate.renderer === config.dialect || candidate.renderer === 'unknown'
      )
    : input.file && input.line
      ? [
          {
            renderer: config.dialect,
            file: input.file,
            line: input.line,
            column: input.column ?? 1,
            symbolHint: input.symbolHint ?? null,
            runtimeKey: null,
          },
        ]
      : [];
  const matches = index.instances.flatMap((instance) => {
    const component = index.components.find((candidate) => candidate.id === instance.componentId);
    if (!component) return [];
    return candidates
      .filter(
        (candidate) =>
          normalizeProjectPath(candidate.file) === normalizeProjectPath(instance.invocation.file) &&
          candidate.line === instance.invocation.line &&
          (!candidate.symbolHint ||
            component.name === candidate.symbolHint ||
            component.id.endsWith(`#${candidate.symbolHint}`)) &&
          (!input.sourceHash || input.sourceHash === sourceHashForCandidate(index, candidate.file))
      )
      .map(() => ({ component, instance }));
  });
  const unique = [...new Map(matches.map((match) => [match.instance.id, match])).values()];
  if (unique.length === 1) {
    const { component } = unique[0];
    return {
      confidence: 'sourceAnchored',
      componentId: component.id,
      source: component.definition,
      candidates: [
        { componentId: component.id, source: component.definition, confidence: 'sourceAnchored' },
      ],
      diagnostics: [
        {
          code: `${config.dialect}-instance-unproven`,
          severity: 'info',
          message: `The ${config.dialect} source usage is known, but the rendered node is not tied to an exact runtime instance.`,
        },
      ],
    };
  }
  if (unique.length > 1) {
    return {
      confidence: 'ambiguous',
      candidates: unique.map(({ component, instance }) => ({
        componentId: component.id,
        instanceId: instance.id,
        source: instance.invocation,
        confidence: 'sourceAnchored' as const,
      })),
      diagnostics: [
        {
          code: `${config.dialect}-ambiguous-instance`,
          severity: 'warning',
          message: `More than one ${config.dialect} usage matches the source candidate.`,
        },
      ],
    };
  }
  return {
    confidence: 'none',
    candidates: [],
    diagnostics: [
      {
        code: `${config.dialect}-no-binding`,
        severity: 'info',
        message: `The source candidate did not match the ${config.dialect} component index.`,
      },
    ],
  };
}

function mutationRefusal(
  code: Extract<MutationResult, { status: 'refused' }>['code'],
  message: string
): Extract<MutationResult, { status: 'refused' }> {
  return {
    status: 'refused',
    code,
    message,
    diagnostics: [{ code: `component-mutation-${code}`, severity: 'warning', message }],
  };
}

function fileMutation(
  file: SourceFileSnapshot,
  edits: ComponentTextEdit[]
): {
  file: string;
  expectedHash: string;
  expectedResultHash: string;
  edits: ComponentTextEdit[];
} | null {
  const after = applyTextEdits(file.content, edits);
  if (after === null) return null;
  return {
    file: file.file,
    expectedHash: file.contentHash,
    expectedResultHash: sha256(after),
    edits,
  };
}

function snapshotFile(
  snapshot: ComponentSourceSnapshot | undefined,
  file: string
): SourceFileSnapshot | undefined {
  return snapshot?.files.find(
    (candidate) => normalizeProjectPath(candidate.file) === normalizeProjectPath(file)
  );
}

function planGenericPropEdit(
  input: EditComponentPropInputWithContext,
  index: ComponentIndex,
  config: MarkupAdapterConfig
): MutationResult {
  const instance = index.instances.find((candidate) => candidate.id === input.instanceId);
  const component = index.components.find((candidate) => candidate.id === instance?.componentId);
  const snapshot = snapshotFile(input.snapshot, instance?.invocation.file ?? '');
  if (!instance || !component || !snapshot)
    return mutationRefusal(
      'missing-source',
      'The component usage source is not available in the current snapshot.'
    );
  if (!component.capabilities.editStaticProps)
    return mutationRefusal(
      'unsupported',
      `Static prop editing is not enabled for ${config.dialect} components.`
    );
  const prop = component.props.find((candidate) => candidate.name === input.propName);
  if (!prop)
    return mutationRefusal(
      'unknown-prop',
      `The component does not declare a prop named "${input.propName}".`
    );
  const expression = instance.props[input.propName];
  if (expression?.kind === 'dynamic')
    return mutationRefusal(
      'dynamic-expression',
      `The ${input.propName} value is dynamic and cannot be edited safely.`
    );
  const edits: ComponentTextEdit[] = [];
  if (expression?.kind === 'static') {
    const start = expression.source.start;
    const end = expression.source.end;
    const sourceStart = Math.max(0, start);
    const sourceEnd = Math.max(sourceStart, end);
    edits.push({
      start: sourceStart,
      end: sourceEnd,
      text: config.formatPropValue(snapshot, input.propName, input.value),
    });
  } else {
    const openEnd = snapshot.content.indexOf(
      '>',
      byteOffsetToUtf16(snapshot.content, instance.invocation.start)
    );
    if (openEnd < 0)
      return mutationRefusal(
        'invalid-range',
        'The component opening tag could not be located in the current source.'
      );
    const insertAt = byteOffsetToUtf16(snapshot.content, openEnd);
    edits.push({
      start: utf16ToByte(snapshot.content, insertAt),
      end: utf16ToByte(snapshot.content, insertAt),
      text: ` ${config.renderAttribute(input.propName, input.value)}`,
    });
  }
  const mutation = fileMutation(snapshot, edits);
  if (!mutation)
    return mutationRefusal('invalid-range', 'The component prop source range is no longer valid.');
  return { status: 'planned', plan: { files: [mutation], expectedRevision: index.revision } };
}

function byteOffsetToUtf16(content: string, byteOffset: number): number {
  const encoded = new TextEncoder().encode(content);
  const safe = Math.max(0, Math.min(byteOffset, encoded.length));
  return new TextDecoder('utf-8', { fatal: false }).decode(encoded.slice(0, safe)).length;
}

function utf16ToByte(content: string, offset: number): number {
  return new TextEncoder().encode(content.slice(0, Math.max(0, offset))).length;
}

function planGenericInsert(
  input: InsertComponentInputWithContext,
  index: ComponentIndex,
  config: MarkupAdapterConfig
): MutationResult {
  const component = index.components.find((candidate) => candidate.id === input.componentId);
  const snapshot = snapshotFile(input.snapshot, input.anchor.file);
  if (!component || !snapshot)
    return mutationRefusal(
      'missing-source',
      'The component or insertion source is not available in the current snapshot.'
    );
  if (!component.capabilities.place)
    return mutationRefusal(
      'not-placeable',
      `Placement is not enabled for ${config.dialect} components.`
    );
  const anchorStart = snapshot.content.indexOf(input.anchor.html);
  if (anchorStart < 0)
    return mutationRefusal('missing-anchor', 'The selected source anchor is no longer present.');
  if (snapshot.content.indexOf(input.anchor.html, anchorStart + input.anchor.html.length) >= 0)
    return mutationRefusal(
      'ambiguous-anchor',
      'The selected source anchor appears more than once.'
    );
  let insertion = anchorStart;
  if (input.anchor.position === 'after') insertion = anchorStart + input.anchor.html.length;
  if (input.anchor.position === 'inside') {
    const openEnd = snapshot.content.indexOf('>', anchorStart);
    if (openEnd < 0)
      return mutationRefusal(
        'invalid-range',
        'The selected source anchor has no complete opening tag.'
      );
    insertion = openEnd + 1;
  }
  const invocation = config.renderInvocation(component, input.props ?? {});
  const newline = snapshot.content.includes('\r\n') ? '\r\n' : '\n';
  const edits: ComponentTextEdit[] = [
    {
      start: utf16ToByte(snapshot.content, insertion),
      end: utf16ToByte(snapshot.content, insertion),
      text: `${newline}${invocation}`,
    },
  ];
  const allFiles: ReturnType<typeof fileMutation>[] = [];
  const targetMutation = fileMutation(snapshot, edits);
  if (!targetMutation)
    return mutationRefusal('invalid-range', 'The insertion range is no longer valid.');
  allFiles.push(targetMutation);
  if (normalizeProjectPath(component.definition.file) !== normalizeProjectPath(snapshot.file)) {
    const specifier = relativeMarkupSpecifier(snapshot.file, component.definition.file);
    const hasImport = new RegExp(`(?:from\\s+|import\\s*)["']${escapeRegExp(specifier)}["']`).test(
      snapshot.content
    );
    if (!hasImport) {
      const importText = config.renderImport(component.localName, specifier);
      if (importText) {
        const at = config.insertionPoint(snapshot);
        // Merge target/import edits in one file so the write remains atomic.
        allFiles.splice(
          0,
          1,
          fileMutation(snapshot, [
            ...edits,
            {
              start: utf16ToByte(snapshot.content, at),
              end: utf16ToByte(snapshot.content, at),
              text: `${importText}${newline}`,
            },
          ])
        );
        if (!allFiles[0])
          return mutationRefusal(
            'invalid-range',
            'The placement source edits overlap or became invalid.'
          );
      }
    }
  }
  return {
    status: 'planned',
    plan: {
      files: allFiles.filter((file): file is NonNullable<typeof file> => !!file),
      expectedRevision: index.revision,
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function relativeMarkupSpecifier(fromFile: string, toFile: string): string {
  const from = normalizeProjectPath(fromFile).split('/');
  from.pop();
  const target = normalizeProjectPath(toFile).split('/');
  while (from.length && target.length && from[0] === target[0]) {
    from.shift();
    target.shift();
  }
  const result = `${'../'.repeat(from.length)}${target.join('/')}`.replace(
    /\.(?:vue|svelte|liquid|html)$/i,
    ''
  );
  return result.startsWith('.') ? result : `./${result}`;
}

export function validateMarkupMutation(input: MutationValidationInput): MutationValidationResult {
  const diagnostics: ComponentDiagnostic[] = [];
  if (input.plan.expectedRevision !== input.snapshot.revision) {
    diagnostics.push({
      code: 'mutation-stale-revision',
      severity: 'warning',
      message: 'The component source revision changed before the edit was validated.',
    });
  }
  for (const mutation of input.plan.files) {
    const file = input.snapshot.files.find(
      (candidate) => normalizeProjectPath(candidate.file) === normalizeProjectPath(mutation.file)
    );
    if (!file) {
      diagnostics.push({
        code: 'mutation-file-missing',
        severity: 'warning',
        message: `The source file ${mutation.file} is not in the current snapshot.`,
      });
      continue;
    }
    if (file.contentHash !== mutation.expectedHash) {
      diagnostics.push({
        code: 'mutation-stale-hash',
        severity: 'warning',
        message: `The source file ${mutation.file} changed before the component edit was applied.`,
      });
      continue;
    }
    const after = applyTextEdits(file.content, mutation.edits);
    if (after === null || sha256(after) !== mutation.expectedResultHash) {
      diagnostics.push({
        code: 'mutation-invalid-range',
        severity: 'warning',
        message: `The planned source range for ${mutation.file} is invalid.`,
      });
    }
  }
  return diagnostics.length
    ? { status: 'invalid', diagnostics }
    : { status: 'valid', diagnostics: [] };
}

export class MarkupComponentAdapter implements ComponentAdapter {
  readonly dialect: ComponentAdapter['dialect'];
  readonly capabilities: ComponentCapabilities;
  private readonly config: MarkupAdapterConfig;

  constructor(config: MarkupAdapterConfig) {
    this.config = config;
    this.dialect = config.dialect;
    this.capabilities = config.capabilities;
  }

  detect(context: DetectionContext) {
    const detected = context.files.some(
      (file) =>
        this.config.extensions.some((extension) => file.file.toLowerCase().endsWith(extension)) &&
        this.config.isDefinitionFile(file.file)
    );
    return {
      detected,
      confidence: detected ? ('high' as const) : ('low' as const),
      diagnostics: detected
        ? []
        : [
            {
              code: `${this.dialect}-no-files`,
              severity: 'info' as const,
              message: `No ${this.dialect} component source files were found in the snapshot.`,
            },
          ],
    };
  }

  accepts(path: string): boolean {
    return this.config.extensions.some((extension) => path.toLowerCase().endsWith(extension));
  }

  parseFile(file: SourceFileSnapshot, context: ParseContext): ParsedComponentFile {
    return parseMarkupFile(file, context, this.config);
  }

  resolveImport(edge: RawImportEdge, context: ResolveContext): ResolvedImportEdge {
    const resolution = this.config.resolveModule(
      edge.fromFile,
      edge.source,
      context.sourceFiles ?? context.files.map((file) => file.snapshot)
    );
    return { ...edge, toFile: resolution.file, status: resolution.status, diagnostics: [] };
  }

  buildUsageGraph(files: ParsedComponentFile[], context: GraphContext): AdapterGraph {
    return buildMarkupUsageGraph(files, context, this.config);
  }

  bindSelection(input: SelectionBindingInput, index: ComponentIndex): ComponentBinding {
    return bindMarkupSelection(input, index, this.config);
  }

  projectTree(input: import('../types').ComponentTreeProjectionInput, index: ComponentIndex) {
    return {
      tree: null,
      root: null,
      revision: index.revision,
      truncated: !!input.truncated,
      boundaries: [],
      diagnostics: [
        {
          code: `${this.dialect}-component-tree-unsupported`,
          severity: 'info' as const,
          message: `Exact ${this.dialect} runtime component boundaries are not available in the web preview bridge.`,
        },
      ],
    };
  }

  planInsert(input: InsertComponentInputWithContext, index: ComponentIndex): MutationResult {
    return planGenericInsert(input, index, this.config);
  }

  planPropEdit(input: EditComponentPropInputWithContext, index: ComponentIndex): MutationResult {
    return planGenericPropEdit(input, index, this.config);
  }

  planSlotEdit(input: EditComponentSlotInputWithContext, index: ComponentIndex): MutationResult {
    return planStaticSlotEdit(input, index, input.snapshot);
  }

  validateMutation(input: MutationValidationInput): MutationValidationResult {
    return validateMarkupMutation(input);
  }
}

/** Build a source ref for a prop descriptor while keeping parser offsets UTF-8 safe. */
export function propRef(file: SourceFileSnapshot, start: number, end: number): SourceRef {
  return ref(file, start, end);
}

export function propDescriptor(
  file: SourceFileSnapshot,
  name: string,
  start: number,
  end: number,
  options: Partial<
    Pick<ComponentPropDescriptor, 'required' | 'typeText' | 'defaultValue' | 'choices' | 'control'>
  > = {}
): ComponentPropDescriptor {
  const required = options.required ?? false;
  return {
    name,
    required,
    typeText: options.typeText ?? null,
    defaultValue: options.defaultValue ?? null,
    choices: options.choices ?? null,
    control: options.control ?? 'readonly',
    source: ref(file, start, end),
    diagnostics: [],
  };
}

export function slotDescriptor(
  file: SourceFileSnapshot,
  name: string,
  start: number,
  end: number,
  scoped = false
): ComponentSlotDescriptor {
  return { name, required: false, scoped, source: ref(file, start, end) };
}

export function markupImports(
  file: SourceFileSnapshot,
  scriptRanges: readonly MarkupRange[],
  _extensions: readonly string[]
): RawImportEdge[] {
  const ranges = scriptRanges.length ? scriptRanges : [{ start: 0, end: file.content.length }];
  const edges: RawImportEdge[] = [];
  const importPattern = /import\s+(?!type\s)([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  for (const range of ranges) {
    const source = file.content.slice(range.start, range.end);
    for (const match of source.matchAll(importPattern)) {
      const matchStart = range.start + (match.index ?? 0);
      const clause = match[1]?.trim() ?? '';
      const sourceText = match[2] ?? '';
      const sourceOffset = file.content.indexOf(sourceText, matchStart);
      const named = clause.match(/\{([\s\S]*)\}/)?.[1];
      const bindings = named
        ? named.split(',').flatMap((part) => {
            const [imported, local] = part.trim().split(/\s+as\s+/);
            return imported
              ? [{ importedName: imported.trim(), localName: (local ?? imported).trim() }]
              : [];
          })
        : [];
      const namespaceBinding = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)/)?.[1]
        ? [{ importedName: '*', localName: clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)/)![1] }]
        : [];
      const defaultName = clause.match(/^([A-Za-z_$][\w$]*)/)?.[1];
      const defaultBinding =
        defaultName && !clause.startsWith('{') && !clause.startsWith('*')
          ? [{ importedName: 'default', localName: defaultName }]
          : [];
      for (const binding of [...defaultBinding, ...namespaceBinding, ...bindings]) {
        edges.push({
          fromFile: file.file,
          source: sourceText,
          importedName: binding.importedName,
          localName: binding.localName,
          isDefault: binding.importedName === 'default',
          isNamespace: binding.importedName === '*',
          sourceRef: ref(file, sourceOffset, sourceOffset + sourceText.length),
        });
      }
    }
  }
  return edges;
}

/** Resolve extensionless local imports without consulting the project's toolchain. */
export function resolveMarkupModulePath(
  fromFile: string,
  specifier: string,
  files: readonly SourceFileSnapshot[],
  extensions: readonly string[]
): { status: 'resolved' | 'unresolved' | 'external'; file: string | null } {
  if (!specifier.startsWith('.')) return { status: 'external', file: null };
  const fromParts = normalizeProjectPath(fromFile).split('/');
  fromParts.pop();
  const base = normalizeProjectPath([...fromParts, specifier].join('/'));
  const candidates = [
    base,
    ...extensions.flatMap((extension) => [`${base}${extension}`, `${base}/index${extension}`]),
  ];
  const fileSet = new Set(files.map((file) => normalizeProjectPath(file.file)));
  const match = candidates.find((candidate) => fileSet.has(normalizeProjectPath(candidate)));
  return match
    ? { status: 'resolved', file: normalizeProjectPath(match) }
    : { status: 'unresolved', file: null };
}

export function scriptBlockRanges(content: string, tag: string): MarkupRange[] {
  const ranges: MarkupRange[] = [];
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  for (const match of content.matchAll(pattern)) {
    const fullStart = match.index ?? 0;
    const body = match[1] ?? '';
    const start = fullStart + match[0].indexOf(body);
    ranges.push({ start, end: start + body.length });
  }
  return ranges;
}

export function bodyRangeWithoutBlocks(content: string, blocks: readonly string[]): MarkupRange[] {
  const excluded: MarkupRange[] = [];
  for (const block of blocks) excluded.push(...scriptBlockRanges(content, block));
  excluded.sort((left, right) => left.start - right.start);
  const ranges: MarkupRange[] = [];
  let cursor = 0;
  for (const range of excluded) {
    if (range.start > cursor) ranges.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < content.length) ranges.push({ start: cursor, end: content.length });
  return ranges;
}

export function basenameDefinition(file: string): string {
  return basenameWithoutExtension(file).replace(/[^A-Za-z0-9_$-]/g, '');
}

export function attrValueText(value: StaticValue, quote = '"'): string {
  return staticValueToJsx(value, quote);
}

/** Parse a literal expression used by a dialect-specific usage scanner. */
export function staticMarkupValue(value: string): StaticValue | null {
  return staticExpression(value.trim());
}

export function findTypeMembers(
  file: SourceFileSnapshot,
  source: string,
  typeName: string
): ComponentPropDescriptor[] {
  const pattern = new RegExp(
    `(?:interface|type)\\s+${escapeRegExp(typeName)}\\s*(?:=\\s*)?\\{([\\s\\S]*?)\\}`,
    'm'
  );
  const match = pattern.exec(source);
  if (!match || match.index === undefined) return [];
  const bodyStart = match.index + match[0].indexOf(match[1]);
  const result: ComponentPropDescriptor[] = [];
  const memberPattern = /([A-Za-z_$][\w$-]*)(\?)?\s*:\s*([^;\n,]+)/g;
  for (const member of match[1].matchAll(memberPattern)) {
    const name = member[1];
    if (!name || member.index === undefined) continue;
    const typeText = member[3]?.trim() ?? null;
    const choices = typeText
      ? typeText
          .split('|')
          .map((part) => part.trim())
          .every((part) => /^['"][^'"]*['"]$/.test(part))
        ? typeText
            .split('|')
            .map((part) => ({ kind: 'string' as const, value: part.trim().slice(1, -1) }))
        : null
      : null;
    const control: ComponentPropDescriptor['control'] = choices
      ? 'select'
      : /boolean/i.test(typeText ?? '')
        ? 'boolean'
        : /number/i.test(typeText ?? '')
          ? 'number'
          : /string/i.test(typeText ?? '')
            ? 'text'
            : 'readonly';
    result.push(
      propDescriptor(
        file,
        name,
        bodyStart + member.index,
        bodyStart + member.index + member[0].length,
        { required: !member[2], typeText, choices, control }
      )
    );
  }
  return result;
}

export function findSlots(
  file: SourceFileSnapshot,
  ranges: readonly MarkupRange[],
  slotPattern: RegExp
): ComponentSlotDescriptor[] {
  const result: ComponentSlotDescriptor[] = [];
  for (const range of ranges) {
    const content = file.content.slice(range.start, range.end);
    for (const match of content.matchAll(slotPattern)) {
      const name = match[1] || 'default';
      const offset = range.start + (match.index ?? 0);
      result.push(slotDescriptor(file, name, offset, offset + match[0].length, false));
    }
  }
  return [...new Map(result.map((slot) => [slot.name, slot])).values()];
}
