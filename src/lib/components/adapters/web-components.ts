import { normalizeProjectPath } from './react-helpers';
import {
  MarkupComponentAdapter,
  attrValueText,
  findSlots,
  markupImports,
  propDescriptor,
  resolveMarkupModulePath,
  type MarkupAdapterConfig,
  type MarkupDefinitionModel,
} from './markup-utils';
import type { ParsedComponentFile } from './types';
import type {
  ComponentCapabilities,
  ComponentDescriptor,
  SourceFileSnapshot,
  StaticValue,
} from '../types';

const WEB_COMPONENT_EXTENSIONS = ['.html', '.htm', '.js', '.ts', '.mjs', '.cjs'] as const;
const WEB_IMPORT_EXTENSIONS = ['.html', '.htm', '.js', '.ts', '.mjs', '.cjs'] as const;

export function isWebComponentSourcePath(file: string): boolean {
  return WEB_COMPONENT_EXTENSIONS.some((extension) =>
    normalizeProjectPath(file).toLowerCase().endsWith(extension)
  );
}

function registration(
  file: SourceFileSnapshot
): { tagName: string; sourceStart: number; sourceEnd: number } | null {
  const match = /customElements\.define\s*\(\s*['"]([a-z][\w.-]*-[\w.-]+)['"]/i.exec(file.content);
  if (!match || match.index === undefined || !match[1]) return null;
  return { tagName: match[1], sourceStart: match.index, sourceEnd: match.index + match[0].length };
}

function isDefinitionFile(file: string, content?: string): boolean {
  return isWebComponentSourcePath(file) && !!content;
}

export function webComponentCapabilities(): ComponentCapabilities {
  return {
    catalog: true,
    usageGraph: true,
    definitionBinding: true,
    instanceBinding: false,
    place: true,
    editStaticProps: true,
    editSlots: true,
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

function templateRanges(file: SourceFileSnapshot) {
  return file.file.toLowerCase().endsWith('.html') || file.file.toLowerCase().endsWith('.htm')
    ? [{ start: 0, end: file.content.length }]
    : [];
}

function definition(file: SourceFileSnapshot): MarkupDefinitionModel | null {
  const found = registration(file);
  if (!found) return null;
  const observed =
    /observedAttributes\s*(?:=|\(\s*\)\s*\{)[\s\S]*?\[([^\]]*)\]/m.exec(file.content)?.[1] ?? '';
  const props = [...observed.matchAll(/['"]([^'"]+)['"]/g)].flatMap((match) => {
    if (match.index === undefined || !match[1]) return [];
    const start =
      found.sourceStart + Math.max(0, file.content.slice(found.sourceStart).indexOf(match[0]));
    return [propDescriptor(file, match[1], start, start + match[0].length, { control: 'text' })];
  });
  const slots = findSlots(
    file,
    templateRanges(file),
    /<slot(?:\s+name\s*=\s*["']([^"']+)["'])?[^>]*>/gi
  );
  return {
    name: found.tagName,
    kind: 'custom-element',
    props,
    slots,
  };
}

function resolveGlobalTag(
  tagName: string,
  files: readonly ParsedComponentFile[]
): ComponentDescriptor | null {
  return (
    files
      .flatMap((file) => file.components.map((component) => component.descriptor))
      .find((component) => component.name.toLowerCase() === tagName.toLowerCase()) ?? null
  );
}

function renderValue(value: StaticValue): string {
  if (value.kind === 'boolean') return value.value ? '' : '"false"';
  return attrValueText(value);
}

function renderAttribute(name: string, value: StaticValue): string {
  return value.kind === 'boolean' && value.value ? name : `${name}=${renderValue(value)}`;
}

const config: MarkupAdapterConfig = {
  dialect: 'web-component',
  extensions: WEB_COMPONENT_EXTENSIONS,
  isDefinitionFile: (file) => isDefinitionFile(file, undefined),
  definition,
  templateRanges,
  isComponentTag: (tagName) => tagName.includes('-') && !tagName.includes(':'),
  resolveGlobalTag,
  parseImports: (file) => markupImports(file, [], WEB_IMPORT_EXTENSIONS),
  resolveModule: (fromFile, specifier, files) =>
    resolveMarkupModulePath(fromFile, specifier, files, WEB_IMPORT_EXTENSIONS),
  capabilities: webComponentCapabilities(),
  parserToken: 'web-component-plan-v1',
  renderInvocation: (component, props) => {
    const attributes = Object.entries(props)
      .map(([name, value]) => ` ${renderAttribute(name, value)}`)
      .join('');
    return `<${component.name}${attributes}></${component.name}>`;
  },
  renderImport: (_localName, specifier) => `import '${specifier}';`,
  formatPropValue: (_file, _name, value) => renderValue(value),
  insertionPoint: () => 0,
  renderAttribute,
};

/** Native custom-element adapter. Registration is required before a tag enters the catalog. */
export class WebComponentAdapter extends MarkupComponentAdapter {
  readonly dialect = 'web-component' as const;

  constructor() {
    super({
      ...config,
      // The shared config callback receives only a path. The adapter performs
      // the content-aware registration check before parsing definitions.
      isDefinitionFile: () => false,
    });
  }

  detect(context: import('./types').DetectionContext) {
    const detected = context.files.some(
      (file) => isWebComponentSourcePath(file.file) && !!registration(file)
    );
    return {
      detected,
      confidence: detected ? ('high' as const) : ('low' as const),
      diagnostics: detected
        ? []
        : [
            {
              code: 'web-component-no-registration',
              severity: 'info' as const,
              message: 'No customElements.define registration was found in the source snapshot.',
            },
          ],
    };
  }

  parseFile(file: SourceFileSnapshot, context: import('./types').ParseContext) {
    const adapter = new MarkupComponentAdapter({
      ...config,
      isDefinitionFile: () => !!registration(file),
    });
    return adapter.parseFile(file, context);
  }
}

export function createWebComponentAdapter(): WebComponentAdapter {
  return new WebComponentAdapter();
}
