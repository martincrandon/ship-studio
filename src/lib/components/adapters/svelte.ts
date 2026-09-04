import { parse as parseSvelte } from 'svelte/compiler';
import { basenameWithoutExtension, normalizeProjectPath } from './react-helpers';
import {
  MarkupComponentAdapter,
  attrValueText,
  bodyRangeWithoutBlocks,
  findSlots,
  findTypeMembers,
  markupImports,
  propDescriptor,
  resolveMarkupModulePath,
  scriptBlockRanges,
  slotDescriptor,
  staticMarkupValue,
  type MarkupAdapterConfig,
  type MarkupDefinitionModel,
  type MarkupRange,
} from './markup-utils';
import type { ComponentCapabilities, ComponentDiagnostic, SourceFileSnapshot } from '../types';

const SVELTE_EXTENSIONS = ['.svelte'] as const;
const SVELTE_IMPORT_EXTENSIONS = ['.svelte', '.ts', '.tsx', '.js', '.jsx'] as const;

export function isSvelteSourcePath(file: string): boolean {
  return normalizeProjectPath(file).toLowerCase().endsWith('.svelte');
}

export function isSvelteRouteFile(file: string): boolean {
  const normalized = normalizeProjectPath(file);
  return (
    normalized.split('/').includes('routes') || basenameWithoutExtension(normalized).startsWith('+')
  );
}

export function svelteCapabilities(): ComponentCapabilities {
  return {
    catalog: true,
    usageGraph: true,
    definitionBinding: true,
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

function scriptRanges(file: SourceFileSnapshot): MarkupRange[] {
  return scriptBlockRanges(file.content, 'script');
}

function templateRanges(file: SourceFileSnapshot): MarkupRange[] {
  return bodyRangeWithoutBlocks(file.content, ['script', 'style']);
}

function typeControl(
  typeText: string | null,
  choices: ReturnType<typeof staticMarkupValue>[] | null
): 'text' | 'number' | 'boolean' | 'select' | 'readonly' {
  if (choices) return 'select';
  if (/boolean/i.test(typeText ?? '')) return 'boolean';
  if (/number/i.test(typeText ?? '')) return 'number';
  if (/string/i.test(typeText ?? '')) return 'text';
  return 'readonly';
}

function parseSvelteProps(file: SourceFileSnapshot): ReturnType<typeof findTypeMembers> {
  const props = new Map<string, ReturnType<typeof propDescriptor>>();
  const add = (items: ReturnType<typeof findTypeMembers>) => {
    for (const item of items) if (!props.has(item.name)) props.set(item.name, item);
  };
  add(findTypeMembers(file, file.content, 'Props'));

  for (const range of scriptRanges(file)) {
    const body = file.content.slice(range.start, range.end);
    for (const match of body.matchAll(
      /\bexport\s+let\s+([A-Za-z_$][\w$]*)(?:\s*:\s*([^=;]+))?(?:\s*=\s*([^;]+))?/g
    )) {
      if (match.index === undefined || !match[1]) continue;
      const typeText = match[2]?.trim() ?? null;
      const defaultText = match[3]?.trim();
      const choices =
        typeText && /^(['"]).*\1(?:\s*\|\s*(['"]).*\2)*$/.test(typeText)
          ? typeText
              .split('|')
              .map((value) => ({ kind: 'string' as const, value: value.trim().slice(1, -1) }))
          : null;
      const start = range.start + match.index;
      add([
        propDescriptor(file, match[1], start, start + match[0].length, {
          required: !defaultText,
          typeText,
          defaultValue: defaultText ? staticMarkupValue(defaultText) : null,
          choices,
          control: typeControl(typeText, choices),
        }),
      ]);
    }

    const propsMatch =
      /\b(?:let|const)\s*\{([\s\S]*?)\}\s*(?::\s*[A-Za-z_$][\w$]*)?\s*=\s*\$props\s*\(\s*\)/.exec(
        body
      );
    if (propsMatch && propsMatch.index !== undefined) {
      const members = propsMatch[1] ?? '';
      const memberStart = range.start + propsMatch.index + propsMatch[0].indexOf(members);
      for (const member of members.split(',')) {
        const match = /^\s*([A-Za-z_$][\w$]*)(?:\s*=\s*([^,]+))?/.exec(member);
        if (!match || !match[1]) continue;
        const offset = memberStart + members.indexOf(member);
        add([
          propDescriptor(file, match[1], offset, offset + member.length, {
            required: !match[2],
            defaultValue: match[2] ? staticMarkupValue(match[2]) : null,
            control: 'readonly',
          }),
        ]);
      }
    }
  }
  return [...props.values()];
}

function parseSvelteSlots(file: SourceFileSnapshot): ReturnType<typeof findSlots> {
  const slots = findSlots(
    file,
    templateRanges(file),
    /<slot(?:\s+name\s*=\s*["']([^"']+)["'])?[^>]*>/gi
  );
  for (const match of file.content.matchAll(/\{#snippet\s+([A-Za-z_$][\w$]*)/g)) {
    if (match.index === undefined || !match[1]) continue;
    slots.push(slotDescriptor(file, match[1], match.index, match.index + match[0].length));
  }
  if (file.content.includes('{@render children')) {
    slots.push(
      slotDescriptor(
        file,
        'default',
        file.content.indexOf('{@render children'),
        file.content.indexOf('{@render children') + 18
      )
    );
  }
  return [...new Map(slots.map((slot) => [slot.name, slot])).values()];
}

function definition(file: SourceFileSnapshot): MarkupDefinitionModel | null {
  if (!isSvelteSourcePath(file.file) || isSvelteRouteFile(file.file)) return null;
  const name = basenameWithoutExtension(file.file);
  return {
    name,
    kind: name.toLowerCase() === 'layout' ? 'layout' : 'component',
    props: parseSvelteProps(file),
    slots: parseSvelteSlots(file),
  };
}

function diagnostics(file: SourceFileSnapshot): ComponentDiagnostic[] {
  try {
    parseSvelte(file.content);
    return [];
  } catch (error) {
    const value = error as { message?: string; start?: number; end?: number };
    const start = typeof value.start === 'number' ? value.start : undefined;
    const end =
      typeof value.end === 'number' ? value.end : start === undefined ? undefined : start + 1;
    return [
      {
        code: 'svelte-parse',
        severity: 'error',
        message: value.message ?? String(error),
        file: file.file,
        ...(start !== undefined && end !== undefined
          ? { source: propDescriptor(file, '__diagnostic__', start, end).source }
          : {}),
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
  dialect: 'svelte',
  extensions: SVELTE_EXTENSIONS,
  isDefinitionFile: (file) => isSvelteSourcePath(file) && !isSvelteRouteFile(file),
  definition,
  templateRanges,
  isComponentTag: (tagName) => !tagName.startsWith('svelte:') && /^[A-Z]/.test(tagName),
  parseImports: (file) => markupImports(file, scriptRanges(file), SVELTE_IMPORT_EXTENSIONS),
  resolveModule: (fromFile, specifier, files) =>
    resolveMarkupModulePath(fromFile, specifier, files, SVELTE_IMPORT_EXTENSIONS),
  capabilities: svelteCapabilities(),
  parserToken: 'svelte-component-plan-v1',
  compilerDiagnostics: diagnostics,
  renderInvocation: (component, props) => {
    const attributes = Object.entries(props)
      .map(([name, value]) => ` ${renderAttribute(name, value)}`)
      .join('');
    return `<${component.localName}${attributes} />`;
  },
  renderImport: (localName, specifier) => `import ${localName} from '${specifier}';`,
  formatPropValue: (_file, _name, value) => renderValue(value),
  insertionPoint: (file) => scriptRanges(file)[0]?.start ?? 0,
  renderAttribute,
};

/** Svelte/SvelteKit source adapter; DOM boundaries remain read-only until a runtime bridge exists. */
export class SvelteComponentAdapter extends MarkupComponentAdapter {
  readonly dialect = 'svelte' as const;

  constructor() {
    super(config);
  }
}

export function createSvelteAdapter(): SvelteComponentAdapter {
  return new SvelteComponentAdapter();
}
