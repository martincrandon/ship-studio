import ts from 'typescript';
import type { ComponentCapabilities, ComponentKind, SourceFileSnapshot } from '../types';

export const REACT_SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
]);

export function normalizeProjectPath(file: string): string {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/') || '.';
}

/** Normalize a React development stack URL to the project's indexed path. */
export function normalizeRuntimeSourcePath(
  source: string,
  projectRoot: string,
  workspaceRoot = '.'
): string {
  let path = source.trim().replace(/\\/g, '/');
  let rootRelativeUrl = false;
  try {
    const url = new URL(path);
    rootRelativeUrl =
      url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'webpack-internal:';
    path = url.pathname;
    if (path.startsWith('/@fs/')) {
      path = path.slice('/@fs'.length);
      rootRelativeUrl = false;
    }
  } catch {
    path = path.replace(/[?#].*$/, '');
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the original encoded path; an invalid escape cannot be decoded.
  }

  const normalizedRoot = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
  if (path === normalizedRoot) return '.';
  if (path.startsWith(`${normalizedRoot}/`)) {
    return normalizeProjectPath(path.slice(normalizedRoot.length + 1));
  }

  const relative = normalizeProjectPath(path.replace(/^\/+/, ''));
  const workspace = normalizeProjectPath(workspaceRoot);
  if (rootRelativeUrl && workspace !== '.' && !relative.startsWith(`${workspace}/`)) {
    return normalizeProjectPath(`${workspace}/${relative}`);
  }
  return relative;
}

export function isReactSourcePath(file: string): boolean {
  const normalized = normalizeProjectPath(file);
  if (/\.d\.(?:ts|mts|cts)$/.test(normalized) || normalized.includes('/node_modules/')) {
    return false;
  }
  const dot = normalized.lastIndexOf('.');
  return dot >= 0 && REACT_SOURCE_EXTENSIONS.has(normalized.slice(dot));
}

export function isPascalCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9_$]*$/.test(name);
}

export function componentKindForFile(file: string, name: string): ComponentKind {
  const base = basenameWithoutExtension(file).toLowerCase();
  if (base === 'layout' || base === 'template') return 'layout';
  if (isRouteSpecialFile(file)) return 'layout';
  return name.endsWith('Section') ? 'section' : 'component';
}

export function isRouteSpecialFile(file: string): boolean {
  const normalized = normalizeProjectPath(file);
  const segments = normalized.split('/');
  const base = basenameWithoutExtension(normalized).toLowerCase();
  const inPages = segments.some((part) => part === 'pages');
  const inApp = segments.some((part) => part === 'app' || part === 'src/app');
  if (inPages) return true;
  if (!inApp) return base === 'page' || base === 'layout' || base === 'template';
  return new Set([
    'page',
    'layout',
    'template',
    'error',
    'loading',
    'not-found',
    'global-error',
    'default',
    'route',
  ]).has(base);
}

export function isNonPlaceableComponent(file: string, name: string): boolean {
  return isRouteSpecialFile(file) || /(?:Provider|Context|Boundary)$/.test(name);
}

export function componentCapabilities(
  placeable: boolean,
  renameable = placeable,
  deletable = renameable
): ComponentCapabilities {
  return {
    catalog: true,
    usageGraph: true,
    definitionBinding: true,
    instanceBinding: true,
    place: placeable,
    editStaticProps: placeable,
    editSlots: placeable,
    editMain: true,
    componentTreeBoundary: true,
    focusedVisualEditing: true,
    duplicateDefinition: placeable,
    renameDefinition: renameable,
    deleteDefinition: deletable,
    extract: placeable,
    isolatedPreview: false,
  };
}

export function basenameWithoutExtension(file: string): string {
  const base = normalizeProjectPath(file).split('/').pop() ?? file;
  return base.replace(/\.[^.]+$/, '');
}

export function resolveModulePath(
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
    ...Array.from(REACT_SOURCE_EXTENSIONS, (extension) => `${base}${extension}`),
    ...Array.from(REACT_SOURCE_EXTENSIONS, (extension) => `${base}/index${extension}`),
  ];
  const fileSet = new Set(files.map((file) => normalizeProjectPath(file.file)));
  const match = candidates.find((candidate) => fileSet.has(normalizeProjectPath(candidate)));
  return match
    ? { status: 'resolved', file: normalizeProjectPath(match) }
    : { status: 'unresolved', file: null };
}

export function moduleSpecifierForFile(
  fromFile: string,
  toFile: string,
  _files: readonly SourceFileSnapshot[]
): string {
  const fromParts = normalizeProjectPath(fromFile).split('/');
  fromParts.pop();
  const target = normalizeProjectPath(toFile).split('/');
  while (fromParts.length > 0 && target.length > 0 && fromParts[0] === target[0]) {
    fromParts.shift();
    target.shift();
  }
  const relative = `${'../'.repeat(fromParts.length)}${target.join('/')}`;
  const withoutExtension = relative.replace(/\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/, '');
  const indexPattern = /\/index$/;
  const result = withoutExtension.replace(indexPattern, '') || '.';
  return result.startsWith('.') ? result : `./${result}`;
}

export function jsxTagText(tag: ts.JsxTagNameExpression): string {
  if (ts.isIdentifier(tag)) return tag.text;
  if (ts.isPropertyAccessExpression(tag))
    return `${jsxTagText(tag.expression as ts.JsxTagNameExpression)}.${tag.name.text}`;
  if (ts.isJsxNamespacedName(tag)) return `${tag.namespace.text}:${tag.name.text}`;
  return tag.getText();
}

export function jsxRootIdentifier(tag: ts.JsxTagNameExpression): string | null {
  if (ts.isIdentifier(tag)) return tag.text;
  if (ts.isPropertyAccessExpression(tag)) {
    return ts.isIdentifier(tag.expression) ? tag.expression.text : null;
  }
  return null;
}

export function isIntrinsicJsxTag(tag: ts.JsxTagNameExpression): boolean {
  return ts.isIdentifier(tag) && /^[a-z]/.test(tag.text);
}

export function isStaticAssetProp(name: string): boolean {
  return /^(?:src|href|poster|image|icon|avatar|background|logo|thumbnail)$/i.test(name);
}
