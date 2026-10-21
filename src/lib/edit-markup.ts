/**
 * Conservative helpers for editing a selected element's opening/closing tag.
 * They intentionally operate on the source string returned by resolveElementHtml
 * and replace only the two tag-name spans. Attributes, child markup, expressions,
 * whitespace, and quote style stay byte-for-byte unchanged.
 */

export interface MarkupTagOption {
  tag: string;
  label: string;
}

interface TagToken {
  name: string;
  sourceName: string;
  nameStart: number;
  nameEnd: number;
  end: number;
  closing: boolean;
  selfClosing: boolean;
  raw: string;
}

interface MarkupNode {
  tag: string;
  rawOpen: string;
  children: MarkupNode[];
  interactive: boolean;
  dynamicContent: boolean;
}

interface ParsedElement {
  source: string;
  root: MarkupNode;
  open: TagToken;
  close: TagToken;
  descendants: MarkupNode[];
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

const HEADING_ORDER = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
const CONTAINER_ORDER = ['div', 'section', 'article', 'nav', 'header', 'footer', 'aside', 'main'];
const EDITABLE_TAGS = [...HEADING_ORDER, 'p', 'span', ...CONTAINER_ORDER, 'a'];
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const CONTAINER_TAGS = new Set(CONTAINER_ORDER);
const INLINE_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'br',
  'cite',
  'code',
  'data',
  'del',
  'em',
  'i',
  'img',
  'ins',
  'kbd',
  'label',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
]);

const STRUCTURAL_PARENT: Record<string, ReadonlySet<string>> = {
  dd: new Set(['dl']),
  dt: new Set(['dl']),
  li: new Set(['ul', 'ol', 'menu']),
  optgroup: new Set(['select', 'datalist']),
  option: new Set(['select', 'datalist', 'optgroup']),
  tbody: new Set(['table']),
  thead: new Set(['table']),
  tfoot: new Set(['table']),
  tr: new Set(['table', 'tbody', 'thead', 'tfoot']),
  td: new Set(['tr']),
  th: new Set(['tr']),
  colgroup: new Set(['table']),
  col: new Set(['colgroup']),
  rp: new Set(['ruby']),
  rt: new Set(['ruby']),
};

const SPECIALIZED_ROOTS = new Set([
  'button',
  'canvas',
  'datalist',
  'details',
  'dialog',
  'fieldset',
  'form',
  'iframe',
  'label',
  'legend',
  'meter',
  'object',
  'optgroup',
  'option',
  'output',
  'progress',
  'select',
  'summary',
  'textarea',
  'video',
  'audio',
  'table',
  'caption',
  'colgroup',
  'col',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'ul',
  'ol',
  'menu',
  'li',
  'dl',
  'dt',
  'dd',
  'html',
  'head',
  'body',
]);

const INTERACTIVE_TAGS = new Set([
  'a',
  'audio',
  'button',
  'details',
  'embed',
  'form',
  'iframe',
  'input',
  'label',
  'select',
  'textarea',
  'video',
]);
const PHRASING_ONLY_ANCESTORS = new Set([
  ...[...INLINE_TAGS].filter((tag) => tag !== 'a'),
  'p',
  ...HEADING_ORDER,
  'button',
  'label',
]);
const STRUCTURAL_ONLY_ANCESTORS = new Set([
  'colgroup',
  'dl',
  'datalist',
  'menu',
  'ol',
  'optgroup',
  'select',
  'table',
  'tbody',
  'tfoot',
  'thead',
  'tr',
  'ul',
]);

function skipQuoted(source: string, at: number, quote: string): number | null {
  for (let index = at + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      index += 1;
    } else if (char === quote) {
      return index + 1;
    }
  }
  return null;
}

/** Skip a balanced JSX expression without treating its strings, comments, or
 *  nested object literals as markup. Returns null for an unterminated expression. */
function skipExpression(source: string, at: number): number | null {
  let depth = 1;
  let index = at + 1;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '"' || char === "'" || char === '`') {
      const after = skipQuoted(source, index, char);
      if (after === null) return null;
      index = after;
      continue;
    }
    if (char === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2);
      if (close < 0) return null;
      index = close + 2;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return null;
}

function parseTag(source: string, at: number): TagToken | null {
  if (source[at] !== '<') return null;
  let index = at + 1;
  const closing = source[index] === '/';
  if (closing) index += 1;
  const nameStart = index;
  if (!/[A-Za-z]/.test(source[index] ?? '')) return null;
  index += 1;
  while (/[A-Za-z0-9:_-]/.test(source[index] ?? '')) index += 1;
  const nameEnd = index;
  const name = source.slice(nameStart, nameEnd).toLowerCase();
  let quote = '';
  while (index < source.length) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }
    if (!closing && char === '{') {
      const after = skipExpression(source, index);
      if (after === null) return null;
      index = after;
      continue;
    }
    if (char === '>') {
      const raw = source.slice(at, index + 1);
      return {
        name,
        sourceName: source.slice(nameStart, nameEnd),
        nameStart,
        nameEnd,
        end: index + 1,
        closing,
        selfClosing: !closing && /\/\s*>$/.test(raw),
        raw,
      };
    }
    index += 1;
  }
  return null;
}

function isInteractiveNode(node: MarkupNode): boolean {
  return node.interactive || node.dynamicContent || node.children.some(isInteractiveNode);
}

function mayBeInteractiveTag(tag: string): boolean {
  return INTERACTIVE_TAGS.has(tag) || tag.includes('-') || tag.includes(':');
}

function attributesOf(openTag: string): { names: string[] } {
  const nameMatch = /^<[A-Za-z][A-Za-z0-9:_-]*/.exec(openTag);
  if (!nameMatch) return { names: [] };
  const names: string[] = [];
  let index = nameMatch[0].length;
  while (index < openTag.length) {
    while (/\s/.test(openTag[index] ?? '')) index += 1;
    if (index >= openTag.length || openTag[index] === '>' || openTag[index] === '/') break;
    if (openTag[index] === '{') {
      const after = skipExpression(openTag, index);
      if (after === null) break;
      index = after;
      continue;
    }
    const attrStart = index;
    while (index < openTag.length && !/[\s=/>]/.test(openTag[index])) index += 1;
    if (index === attrStart) {
      index += 1;
      continue;
    }
    const attrName = openTag.slice(attrStart, index).toLowerCase();
    names.push(attrName);
    while (/\s/.test(openTag[index] ?? '')) index += 1;
    if (openTag[index] !== '=') continue;
    index += 1;
    while (/\s/.test(openTag[index] ?? '')) index += 1;
    const quote = openTag[index];
    if (quote === '"' || quote === "'") {
      const after = skipQuoted(openTag, index, quote);
      if (after === null) break;
      index = after;
    } else if (openTag[index] === '{') {
      const after = skipExpression(openTag, index);
      if (after === null) break;
      index = after;
    } else {
      while (index < openTag.length && !/[\s>]/.test(openTag[index])) index += 1;
    }
  }
  return { names };
}

function parseElement(source: string): ParsedElement | null {
  let first = 0;
  while (/\s/.test(source[first] ?? '') && first < source.length) first += 1;
  const open = parseTag(source, first);
  // A capitalized JSX name can be a component whose rendered tag differs from
  // its source name. Never rewrite it based on a coincidental DOM tag match.
  if (
    !open ||
    open.closing ||
    open.selfClosing ||
    open.sourceName !== open.name ||
    VOID_TAGS.has(open.name)
  ) {
    return null;
  }
  const root: MarkupNode = {
    tag: open.name,
    rawOpen: open.raw,
    children: [],
    interactive: false,
    dynamicContent: false,
  };
  const rootAttrs = attributesOf(open.raw);
  root.interactive =
    mayBeInteractiveTag(root.tag) ||
    rootAttrs.names.some(
      (name) => name === 'tabindex' || name === 'contenteditable' || name === 'usemap'
    );
  const stack: MarkupNode[] = [root];
  const descendants: MarkupNode[] = [];
  let index = open.end;

  while (index < source.length) {
    if (source.startsWith('<!--', index)) {
      const close = source.indexOf('-->', index + 4);
      if (close < 0) return null;
      index = close + 3;
      continue;
    }
    if (source[index] === '{') {
      const after = skipExpression(source, index);
      if (after === null) return null;
      stack[stack.length - 1].dynamicContent = true;
      index = after;
      continue;
    }
    if (source[index] !== '<') {
      index += 1;
      continue;
    }
    if (source.startsWith('<>', index) || source.startsWith('</>', index)) return null;
    const token = parseTag(source, index);
    if (!token) {
      // Unknown markup can contain a closing tag the scanner cannot safely pair.
      if (source.startsWith('</', index) || source.startsWith('<!', index)) return null;
      index += 1;
      continue;
    }
    if (token.sourceName !== token.name) return null;
    if (token.closing) {
      const top = stack[stack.length - 1];
      if (!top || top.tag !== token.name) return null;
      stack.pop();
      if (stack.length === 0) {
        const tail = source.slice(token.end);
        if (tail.trim()) return null;
        return { source, root, open, close: token, descendants };
      }
      index = token.end;
      continue;
    }

    if (stack.length === 0) return null;
    if (VOID_TAGS.has(token.name) || token.selfClosing) {
      const attrs = attributesOf(token.raw);
      const child: MarkupNode = {
        tag: token.name,
        rawOpen: token.raw,
        children: [],
        interactive:
          mayBeInteractiveTag(token.name) ||
          attrs.names.some(
            (name) => name === 'tabindex' || name === 'contenteditable' || name === 'usemap'
          ),
        dynamicContent: false,
      };
      stack[stack.length - 1].children.push(child);
      descendants.push(child);
      index = token.end;
      continue;
    }

    const attrs = attributesOf(token.raw);
    const child: MarkupNode = {
      tag: token.name,
      rawOpen: token.raw,
      children: [],
      interactive:
        mayBeInteractiveTag(token.name) ||
        attrs.names.some(
          (name) => name === 'tabindex' || name === 'contenteditable' || name === 'usemap'
        ),
      dynamicContent: false,
    };
    stack[stack.length - 1].children.push(child);
    descendants.push(child);
    stack.push(child);
    index = token.end;
  }
  return null;
}

function requiredParentAllows(parentTag: string, children: MarkupNode[]): boolean {
  return children.every((child) => {
    const parents = STRUCTURAL_PARENT[child.tag];
    return !parents || parents.has(parentTag);
  });
}

function isPhrasingTree(node: MarkupNode): boolean {
  return (
    !node.dynamicContent &&
    node.children.every((child) => INLINE_TAGS.has(child.tag) && isPhrasingTree(child))
  );
}

function tagLabel(tag: string): string {
  if (HEADING_TAGS.has(tag)) return tag.toUpperCase();
  if (tag === 'p') return 'Paragraph';
  if (tag === 'span') return 'Text / span';
  if (CONTAINER_TAGS.has(tag)) return tag === 'div' ? 'Div' : tag[0].toUpperCase() + tag.slice(1);
  if (tag === 'a') return 'Link block';
  return tag;
}

function candidateOrder(current: string): string[] {
  let related: string[];
  if (HEADING_TAGS.has(current)) {
    related = [
      ...HEADING_ORDER.filter((tag) => tag !== current),
      'p',
      'span',
      ...CONTAINER_ORDER,
      'a',
    ];
  } else if (CONTAINER_TAGS.has(current)) {
    related = [
      ...CONTAINER_ORDER.filter((tag) => tag !== current),
      'p',
      ...HEADING_ORDER,
      'span',
      'a',
    ];
  } else if (current === 'p') {
    related = [...HEADING_ORDER, 'span', ...CONTAINER_ORDER, 'a'];
  } else if (current === 'span') {
    related = ['p', ...HEADING_ORDER, ...CONTAINER_ORDER, 'a'];
  } else {
    related = ['p', ...HEADING_ORDER, 'span', ...CONTAINER_ORDER];
  }
  return [current, ...related.filter((tag) => tag !== current)];
}

/**
 * Return the source tag-name change, preserving every other source byte. The
 * scanner pairs the selected root with its own closing tag, including nested
 * same-name elements, and refuses malformed or unsupported markup.
 */
export function replaceMarkupTagName(
  source: string,
  currentTag: string,
  nextTag: string
): string | null {
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(nextTag)) return null;
  const parsed = parseElement(source);
  const current = currentTag.toLowerCase();
  if (!parsed || parsed.root.tag !== current || parsed.open.name !== current) return null;
  if (nextTag.toLowerCase() === current) return source;
  return (
    source.slice(0, parsed.open.nameStart) +
    nextTag +
    source.slice(parsed.open.nameEnd, parsed.close.nameStart) +
    nextTag +
    source.slice(parsed.close.nameEnd)
  );
}

/**
 * Offer only conservative native text/container conversions. Unknown, void,
 * structural, and specialized roots keep their current tag as their sole option.
 * The current option is always first, even when the source is read-only or
 * malformed, so the panel can show the exact selected tag truthfully.
 */
export function compatibleMarkupTags(
  source: string | null,
  currentTag: string,
  ancestorTags: string[] = []
): MarkupTagOption[] {
  const current = currentTag.toLowerCase();
  if (!current) return [];
  const currentOption = { tag: current, label: tagLabel(current) };
  if (!source || !EDITABLE_TAGS.includes(current)) return [currentOption];

  const parsed = parseElement(source);
  if (
    !parsed ||
    parsed.root.tag !== current ||
    SPECIALIZED_ROOTS.has(current) ||
    VOID_TAGS.has(current) ||
    !requiredParentAllows(current, parsed.root.children)
  ) {
    return [currentOption];
  }

  const rootAttrs = attributesOf(parsed.open.raw);
  const hasLinkSemantics = current === 'a' && rootAttrs.names.includes('href');
  const containsInteractive =
    parsed.root.dynamicContent || parsed.descendants.some(isInteractiveNode);
  const normalizedAncestors = ancestorTags.map((tag) => tag.toLowerCase());
  const parentTag = normalizedAncestors[normalizedAncestors.length - 1];
  const phrasingContext = normalizedAncestors.some((ancestor) =>
    PHRASING_ONLY_ANCESTORS.has(ancestor)
  );
  const interactiveAncestor = normalizedAncestors.some((ancestor) =>
    INTERACTIVE_TAGS.has(ancestor)
  );
  if (interactiveAncestor && parsed.root.interactive) return [currentOption];
  if (parentTag && STRUCTURAL_ONLY_ANCESTORS.has(parentTag)) return [currentOption];
  const ordered = candidateOrder(current);
  const options = [currentOption];

  for (const candidate of ordered.slice(1)) {
    if (!requiredParentAllows(candidate, parsed.root.children)) continue;
    if (candidate === 'a') {
      if (normalizedAncestors.includes('a') || interactiveAncestor || containsInteractive) continue;
      if (phrasingContext && !isPhrasingTree(parsed.root)) continue;
    } else if (hasLinkSemantics) {
      // Keeping a real hyperlink's href attribute on a non-link would preserve
      // bytes while silently removing the behavior the source explicitly chose.
      continue;
    }
    if (candidate === 'p' || HEADING_TAGS.has(candidate) || candidate === 'span') {
      if (!isPhrasingTree(parsed.root)) continue;
    }
    if (
      (candidate === 'p' || HEADING_TAGS.has(candidate) || CONTAINER_TAGS.has(candidate)) &&
      phrasingContext
    ) {
      continue;
    }
    if (candidate === 'main' && normalizedAncestors.includes('main')) {
      continue;
    }
    if (
      (candidate === 'header' || candidate === 'footer') &&
      normalizedAncestors.some((ancestor) => ancestor === 'header' || ancestor === 'footer')
    ) {
      continue;
    }
    options.push({ tag: candidate, label: tagLabel(candidate) });
  }
  return options;
}

/** Direct text values are the only safe Settings text-field writes. The existing
 *  backend can preserve inline markup, but a single text field cannot preserve
 *  nested formatting or JSX expressions when the user replaces its value. */
export function directTextReason(sourceText: string): string | null {
  if (sourceText.includes('<')) {
    return 'Text with nested markup can’t be edited safely here.';
  }
  if (sourceText.includes('{') || sourceText.includes('}')) {
    return 'This text contains JSX syntax or an expression and can’t be edited safely here.';
  }
  return null;
}

/** Decode HTML/JSX character references for the user-facing field while keeping
 *  the resolver's raw source span separately as the write drift baseline. */
export function decodeTextEntities(sourceText: string): string {
  if (typeof document === 'undefined') return sourceText;
  const decoder = document.createElement('textarea');
  decoder.innerHTML = sourceText;
  return decoder.value;
}

/** Encode user-entered characters so they remain direct text in HTML, Astro, and
 *  JSX source. In particular, braces and angle brackets never become expressions
 *  or nested markup when the write reaches the source file. */
export function encodeDirectTextForSource(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/{/g, '&#123;')
    .replace(/}/g, '&#125;');
}
