import { parse as parseVue } from '@vue/compiler-sfc';
import { basenameWithoutExtension, normalizeProjectPath } from './react-helpers';
import {
  MarkupComponentAdapter,
  attrValueText,
  findSlots,
  findTypeMembers,
  markupImports,
  propDescriptor,
  resolveMarkupModulePath,
  scriptBlockRanges,
  staticMarkupValue,
  type MarkupAdapterConfig,
  type MarkupDefinitionModel,
  type MarkupRange,
} from './markup-utils';
import type { ComponentCapabilities, ComponentDiagnostic, SourceFileSnapshot } from '../types';

const VUE_EXTENSIONS = ['.vue'] as const;
const VUE_IMPORT_EXTENSIONS = ['.vue', '.ts', '.tsx', '.js', '.jsx'] as const;

/** Vue's template compiler keeps the SFC boundary authoritative. */
export function isVueSourcePath(file: string): boolean {
  return normalizeProjectPath(file).toLowerCase().endsWith('.vue');
}

export function isVueRouteFile(file: string): boolean {
  const normalized = normalizeProjectPath(file);
  const segments = normalized.split('/');
  const base = basenameWithoutExtension(normalized).toLowerCase();
  return segments.includes('pages') || base === 'index' || base.startsWith('+');
}

export function vueCapabilities(): ComponentCapabilities {
  return {
    catalog: true,
    usageGraph: true,
    definitionBinding: true,
    // Vue's compiled DOM does not retain a stable source invocation marker.
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

function templateRanges(file: SourceFileSnapshot): MarkupRange[] {
  return scriptBlockRanges(file.content, 'template');
}

function scriptRanges(file: SourceFileSnapshot): MarkupRange[] {
  return scriptBlockRanges(file.content, 'script');
}

function typeBodyProps(file: SourceFileSnapshot, body: string, bodyStart: number) {
  const result = [];
  const memberPattern = /([A-Za-z_$][\w$-]*)(\?)?\s*:\s*([^;\n,}]+)/g;
  for (const member of body.matchAll(memberPattern)) {
    if (member.index === undefined || !member[1]) continue;
    const typeText = member[3]?.trim() ?? null;
    const choices =
      typeText && /^(['"]).*\1(?:\s*\|\s*(['"]).*\2)*$/.test(typeText)
        ? typeText
            .split('|')
            .map((value) => ({ kind: 'string' as const, value: value.trim().slice(1, -1) }))
        : null;
    result.push(
      propDescriptor(
        file,
        member[1],
        bodyStart + member.index,
        bodyStart + member.index + member[0].length,
        {
          required: !member[2],
          typeText,
          choices,
          control: choices
            ? 'select'
            : /boolean/i.test(typeText ?? '')
              ? 'boolean'
              : /number/i.test(typeText ?? '')
                ? 'number'
                : /string/i.test(typeText ?? '')
                  ? 'text'
                  : 'readonly',
        }
      )
    );
  }
  return result;
}

function parseObjectProps(
  file: SourceFileSnapshot,
  source: string,
  expression: RegExp
): ReturnType<typeof typeBodyProps> {
  const match = expression.exec(source);
  if (!match || match.index === undefined) return [];
  const body = match[1] ?? '';
  const bodyStart = match.index + match[0].indexOf(body);
  const props = [];
  const propertyPattern = /([A-Za-z_$][\w$-]*)\s*:\s*(\{[^{}]*\}|[A-Za-z_$][\w$]*(?:\.\w+)*)/g;
  for (const property of body.matchAll(propertyPattern)) {
    if (property.index === undefined || !property[1]) continue;
    const valueText = property[2] ?? '';
    const defaultMatch = /\bdefault\s*:\s*([^,}]+)/.exec(valueText);
    const defaultValue = defaultMatch ? staticMarkupValue(defaultMatch[1]) : null;
    props.push(
      propDescriptor(
        file,
        property[1],
        bodyStart + property.index,
        bodyStart + property.index + property[0].length,
        {
          required: !valueText.startsWith('{'),
          typeText: valueText,
          defaultValue,
          control: /Boolean/.test(valueText)
            ? 'boolean'
            : /Number/.test(valueText)
              ? 'number'
              : 'text',
        }
      )
    );
  }
  return props;
}

function parseVueProps(file: SourceFileSnapshot): ReturnType<typeof findTypeMembers> {
  const props = new Map<string, ReturnType<typeof propDescriptor>>();
  const add = (items: ReturnType<typeof findTypeMembers>) => {
    for (const item of items) if (!props.has(item.name)) props.set(item.name, item);
  };
  add(findTypeMembers(file, file.content, 'Props'));

  for (const match of file.content.matchAll(/defineProps\s*<\s*([^>]+)\s*>/g)) {
    const typeText = match[1]?.trim() ?? '';
    if (!typeText) continue;
    if (/^[A-Za-z_$][\w$]*$/.test(typeText)) {
      add(findTypeMembers(file, file.content, typeText));
    } else if (typeText.startsWith('{') && match.index !== undefined) {
      const bodyStart = match.index + match[0].indexOf(typeText) + 1;
      add(typeBodyProps(file, typeText.slice(1, -1), bodyStart));
    }
  }
  add(parseObjectProps(file, file.content, /defineProps\s*\(\s*\{([\s\S]*?)\}\s*\)/g));
  add(parseObjectProps(file, file.content, /\bprops\s*:\s*\{([\s\S]*?)\}\s*,?/g));
  return [...props.values()];
}

function parseVueSlots(file: SourceFileSnapshot): ReturnType<typeof findSlots> {
  return findSlots(file, templateRanges(file), /<slot(?:\s+name\s*=\s*["']([^"']+)["'])?[^>]*>/gi);
}

function definition(file: SourceFileSnapshot): MarkupDefinitionModel | null {
  if (!isVueSourcePath(file.file) || isVueRouteFile(file.file)) return null;
  return {
    name: basenameWithoutExtension(file.file),
    kind: basenameWithoutExtension(file.file).toLowerCase() === 'layout' ? 'layout' : 'component',
    props: parseVueProps(file),
    slots: parseVueSlots(file),
  };
}

function diagnostics(file: SourceFileSnapshot): ComponentDiagnostic[] {
  try {
    const result = parseVue(file.content, { filename: file.file });
    return result.errors.map((error, index) => {
      const value = error as unknown as {
        message?: string;
        loc?: { start?: { offset?: number }; end?: { offset?: number } };
      };
      const start = value.loc?.start?.offset;
      const end = value.loc?.end?.offset ?? (typeof start === 'number' ? start + 1 : undefined);
      return {
        code: `vue-sfc-${index + 1}`,
        severity: 'error' as const,
        message: value.message ?? String(error),
        file: file.file,
        ...(typeof start === 'number' && typeof end === 'number'
          ? { source: { ...propDescriptor(file, '__diagnostic__', start, end).source } }
          : {}),
      };
    });
  } catch (error) {
    return [
      {
        code: 'vue-sfc-parse',
        severity: 'error',
        message: error instanceof Error ? error.message : String(error),
        file: file.file,
      },
    ];
  }
}

function renderValue(value: import('../types').StaticValue): string {
  return attrValueText(value);
}

function renderAttribute(name: string, value: import('../types').StaticValue): string {
  return value.kind === 'boolean' && value.value ? name : `${name}=${renderValue(value)}`;
}

const config: MarkupAdapterConfig = {
  dialect: 'vue',
  extensions: VUE_EXTENSIONS,
  isDefinitionFile: (file) => isVueSourcePath(file) && !isVueRouteFile(file),
  definition,
  templateRanges,
  isComponentTag: (tagName) => /^[A-Z]/.test(tagName) || tagName.includes('-'),
  parseImports: (file) => markupImports(file, scriptRanges(file), VUE_IMPORT_EXTENSIONS),
  resolveModule: (fromFile, specifier, files) =>
    resolveMarkupModulePath(fromFile, specifier, files, VUE_IMPORT_EXTENSIONS),
  capabilities: vueCapabilities(),
  parserToken: 'vue-component-plan-v1',
  compilerDiagnostics: diagnostics,
  renderInvocation: (component, props) => {
    const attributes = Object.entries(props)
      .map(([name, value]) => ` ${renderAttribute(name, value)}`)
      .join('');
    return `<${component.localName}${attributes} />`;
  },
  renderImport: (localName, specifier) => `import ${localName} from '${specifier}';`,
  formatPropValue: (_file, _name, value) => renderValue(value),
  insertionPoint: (file) => {
    const range = scriptRanges(file)[0];
    return range?.start ?? 0;
  },
  renderAttribute,
  normalizeTagName: (tagName) =>
    tagName.includes('-')
      ? tagName
          .split('-')
          .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ''))
          .join('')
      : tagName,
};

/** Vue/Nuxt source adapter. Runtime DOM boundaries remain intentionally read-only. */
export class VueComponentAdapter extends MarkupComponentAdapter {
  readonly dialect = 'vue' as const;

  constructor() {
    super(config);
  }
}

export function createVueAdapter(): VueComponentAdapter {
  return new VueComponentAdapter();
}
