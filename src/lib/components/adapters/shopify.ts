import ts from 'typescript';
import { basenameWithoutExtension, normalizeProjectPath } from './react-helpers';
import {
  MarkupComponentAdapter,
  bodyRangeWithoutBlocks,
  markupImports,
  propDescriptor,
  resolveMarkupModulePath,
  staticMarkupValue,
  type MarkupAdapterConfig,
  type MarkupDefinitionModel,
} from './markup-utils';
import { sourceRefFromUtf16Range } from '../ranges';
import type {
  ComponentCapabilities,
  ComponentDiagnostic,
  ComponentDescriptor,
  ComponentPropDescriptor,
  SourceFileSnapshot,
  SourceRef,
  StaticValue,
} from '../types';
import type { RawJsxAttribute, RawJsxUsage } from './types';

const SHOPIFY_EXTENSIONS = ['.liquid', '.json'] as const;
const SHOPIFY_IMPORT_EXTENSIONS = ['.liquid', '.json'] as const;

export function isShopifySourcePath(file: string): boolean {
  const normalized = normalizeProjectPath(file).toLowerCase();
  return normalized.endsWith('.liquid') || normalized.endsWith('.json');
}

function themeDirectory(file: string): 'sections' | 'blocks' | 'snippets' | null {
  const segment = normalizeProjectPath(file)
    .split('/')
    .find((part) => part === 'sections' || part === 'blocks' || part === 'snippets');
  return segment === 'sections' || segment === 'blocks' || segment === 'snippets' ? segment : null;
}

function isShopifyDefinitionFile(file: string): boolean {
  return isShopifySourcePath(file) && themeDirectory(file) !== null;
}

export function shopifyCapabilities(): ComponentCapabilities {
  return {
    catalog: true,
    usageGraph: true,
    definitionBinding: true,
    // Snippet render sites have no stable DOM identity in a Shopify preview.
    instanceBinding: false,
    place: true,
    editStaticProps: true,
    editSlots: true,
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

function sourceRef(file: SourceFileSnapshot, start: number, end: number): SourceRef {
  return sourceRefFromUtf16Range(file.file, file.content, file.contentHash, start, end);
}

function schemaBounds(content: string): { start: number; end: number; body: string } | null {
  const match = /{%\s*schema\s*%}([\s\S]*?){%\s*endschema\s*%}/i.exec(content);
  if (!match || match.index === undefined) return null;
  const body = match[1] ?? '';
  return {
    start: match.index + match[0].indexOf(body),
    end: match.index + match[0].indexOf(body) + body.length,
    body,
  };
}

function schemaData(file: SourceFileSnapshot): {
  value: Record<string, unknown> | null;
  diagnostics: ComponentDiagnostic[];
} {
  const bounds = schemaBounds(file.content);
  if (!bounds) return { value: null, diagnostics: [] };
  try {
    const value = JSON.parse(bounds.body) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Shopify schema must be a JSON object.');
    return { value: value as Record<string, unknown>, diagnostics: [] };
  } catch (error) {
    return {
      value: null,
      diagnostics: [
        {
          code: 'shopify-invalid-schema',
          severity: 'error',
          message: error instanceof Error ? error.message : 'Shopify schema JSON is invalid.',
          file: file.file,
          source: sourceRef(file, bounds.start, bounds.end),
        },
      ],
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function schemaProp(
  file: SourceFileSnapshot,
  bounds: NonNullable<ReturnType<typeof schemaBounds>>,
  setting: Record<string, unknown>
): ComponentPropDescriptor | null {
  const id = typeof setting.id === 'string' ? setting.id : null;
  if (!id) return null;
  const idMatch = new RegExp(`"id"\\s*:\\s*"${id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}"`).exec(
    bounds.body
  );
  const start = idMatch?.index === undefined ? bounds.start : bounds.start + idMatch.index;
  const end = idMatch?.index === undefined ? bounds.end : start + idMatch[0].length;
  const type = typeof setting.type === 'string' ? setting.type : null;
  const options = Array.isArray(setting.options) ? setting.options : [];
  const choices: StaticValue[] = options.flatMap<StaticValue>((option): StaticValue[] => {
    const record = asRecord(option);
    if (typeof record?.value === 'string')
      return [{ kind: 'string' as const, value: record.value }];
    if (typeof record?.value === 'number')
      return [{ kind: 'number' as const, value: record.value }];
    return [];
  });
  const defaultValue = staticMarkupValue(JSON.stringify(setting.default ?? null));
  return propDescriptor(file, id, start, end, {
    required: false,
    typeText: type,
    defaultValue: defaultValue?.kind === 'null' ? null : defaultValue,
    choices: choices.length ? choices : null,
    control:
      type === 'select' || type === 'radio'
        ? 'select'
        : type === 'checkbox'
          ? 'boolean'
          : type === 'number' || type === 'range'
            ? 'number'
            : type === 'image_picker'
              ? 'asset'
              : 'text',
  });
}

function definition(file: SourceFileSnapshot): MarkupDefinitionModel | null {
  if (!isShopifyDefinitionFile(file.file)) return null;
  const directory = themeDirectory(file.file);
  if (!directory) return null;
  const parsed = schemaData(file);
  const schema = parsed.value;
  const settings = Array.isArray(schema?.settings) ? schema.settings : [];
  const props = settings.flatMap((setting) => {
    const record = asRecord(setting);
    const prop = record ? schemaProp(file, schemaBounds(file.content)!, record) : null;
    return prop ? [prop] : [];
  });
  const slots =
    Array.isArray(schema?.blocks) || /content_for\s+['"]blocks['"]/.test(file.content)
      ? [
          {
            name: 'blocks',
            required: false,
            scoped: false,
            source: sourceRef(
              file,
              schemaBounds(file.content)?.start ?? 0,
              schemaBounds(file.content)?.end ?? file.content.length
            ),
          },
        ]
      : [];
  return {
    name: basenameWithoutExtension(file.file),
    kind: directory === 'sections' ? 'section' : directory === 'blocks' ? 'block' : 'snippet',
    props,
    slots,
    diagnostics: parsed.diagnostics,
  };
}

function liquidValue(value: StaticValue): string {
  if (value.kind === 'string') return JSON.stringify(value.value);
  if (value.kind === 'number' || value.kind === 'boolean') return String(value.value);
  if (value.kind === 'null') return 'nil';
  return JSON.stringify(
    value.kind === 'array'
      ? value.value.map((item) => (item.kind === 'string' ? item.value : item.value))
      : value.value
  );
}

function liquidAttributes(
  file: SourceFileSnapshot,
  bodyStart: number,
  body: string
): RawJsxAttribute[] {
  const attributes: RawJsxAttribute[] = [];
  const pattern = /([A-Za-z_][\w-]*)\s*:\s*("[^"]*"|'[^']*'|[^,\s%]+)/g;
  for (const match of body.matchAll(pattern)) {
    if (match.index === undefined || !match[1] || !match[2]) continue;
    const relative = match[0].indexOf(match[2]);
    const valueStart = bodyStart + match.index + relative;
    const valueEnd = valueStart + match[2].length;
    const value = staticMarkupValue(match[2]);
    attributes.push({
      name: match[1],
      source: sourceRef(file, bodyStart + match.index, bodyStart + match.index + match[0].length),
      valueSource: sourceRef(file, valueStart, valueEnd),
      expressionText: value ? null : match[2],
      staticValue: value,
      dynamicReason: value ? null : 'Liquid variables and filters are dynamic.',
    });
  }
  return attributes;
}

function liquidUsages(file: SourceFileSnapshot): RawJsxUsage[] {
  const usages: RawJsxUsage[] = [];
  if (file.file.toLowerCase().endsWith('.json')) {
    for (const match of file.content.matchAll(/"type"\s*:\s*"([^"/]+)"/g)) {
      if (match.index === undefined || !match[1]) continue;
      const end = match.index + match[0].length;
      usages.push({
        tagName: `section:${match[1]}`,
        localName: `section:${match[1]}`,
        namespaceName: null,
        invocation: sourceRef(file, match.index, end),
        attributes: [],
        childrenSource: null,
        containingLocalName: null,
        node: ts.createSourceFile(
          file.file,
          file.content,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JSON
        ) as unknown as ts.JsxElement,
      });
    }
    return usages;
  }
  const pattern = /{%\s*(render|include|section)\s+["']([^"']+)["']([^%]*?)%}/gi;
  for (const match of file.content.matchAll(pattern)) {
    if (match.index === undefined || !match[1] || !match[2]) continue;
    const full = match[0];
    const kind = match[1].toLowerCase() === 'section' ? 'section' : 'snippet';
    const name = match[2];
    const bodyStart = match.index + full.indexOf(match[3] ?? '');
    usages.push({
      tagName: `${kind}:${name}`,
      localName: `${kind}:${name}`,
      namespaceName: null,
      invocation: sourceRef(file, match.index, match.index + full.length),
      attributes: liquidAttributes(file, bodyStart, match[3] ?? ''),
      childrenSource: null,
      containingLocalName: null,
      node: ts.createSourceFile(
        file.file,
        file.content,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      ) as unknown as ts.JsxElement,
    });
  }
  return usages;
}

function resolveGlobalTag(
  tagName: string,
  files: readonly import('./types').ParsedComponentFile[]
): ComponentDescriptor | null {
  const [kind, rawName] = tagName.split(':', 2);
  if (!rawName) return null;
  return (
    files
      .flatMap((file) => file.components.map((component) => component.descriptor))
      .find(
        (component) =>
          component.name.toLowerCase() === rawName.toLowerCase() &&
          ((kind === 'section' && component.kind === 'section') ||
            (kind === 'snippet' && component.kind === 'snippet'))
      ) ?? null
  );
}

const config: MarkupAdapterConfig = {
  dialect: 'shopify',
  extensions: SHOPIFY_EXTENSIONS,
  isDefinitionFile: isShopifyDefinitionFile,
  definition,
  templateRanges: (file) => bodyRangeWithoutBlocks(file.content, ['schema']),
  isComponentTag: () => false,
  parseUsages: (file) => liquidUsages(file),
  resolveGlobalTag,
  parseImports: (file) => markupImports(file, [], SHOPIFY_IMPORT_EXTENSIONS),
  resolveModule: (fromFile, specifier, files) =>
    resolveMarkupModulePath(fromFile, specifier, files, SHOPIFY_IMPORT_EXTENSIONS),
  capabilities: shopifyCapabilities(),
  parserToken: 'shopify-component-plan-v1',
  renderInvocation: (component, props) => {
    const values = Object.entries(props)
      .map(([name, value]) => `${name}: ${liquidValue(value)}`)
      .join(', ');
    const suffix = values ? `, ${values}` : '';
    return component.kind === 'section'
      ? `{% section '${component.name}' %}`
      : `{% render '${component.name}'${suffix} %}`;
  },
  // Shopify theme components are addressed by render/section names, not imports.
  renderImport: () => '',
  formatPropValue: (_file, _name, value) => liquidValue(value),
  insertionPoint: () => 0,
  renderAttribute: (name, value) => `${name}: ${liquidValue(value)}`,
};

/** Shopify Liquid sections, blocks, snippets, and JSON template references. */
export class ShopifyComponentAdapter extends MarkupComponentAdapter {
  readonly dialect = 'shopify' as const;

  constructor() {
    super(config);
  }
}

export function createShopifyAdapter(): ShopifyComponentAdapter {
  return new ShopifyComponentAdapter();
}
