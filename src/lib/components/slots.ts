import ts from 'typescript';
import {
  applyTextEdits,
  sha256,
  sourceRefFromUtf16Range,
  utf8ByteOffsetToUtf16Offset,
} from './ranges';
import { normalizeProjectPath } from './adapters/react-helpers';
import type {
  ComponentFileMutation,
  ComponentIndex,
  ComponentMutationPlan,
  ComponentSourceSnapshot,
  ComponentInstance,
  EditComponentSlotInput,
  MutationResult,
  SourceFileSnapshot,
  SourceRef,
} from './types';

const STATIC_MARKUP_EXTENSIONS = new Set(['.astro', '.vue', '.svelte', '.liquid', '.html', '.htm']);

function refusal(
  code: Extract<MutationResult, { status: 'refused' }>['code'],
  message: string,
  source?: SourceRef
): Extract<MutationResult, { status: 'refused' }> {
  return {
    status: 'refused',
    code,
    message,
    diagnostics: [
      {
        code: `component-slot-${code}`,
        severity: 'warning',
        message,
        ...(source ? { source } : {}),
      },
    ],
  };
}

function snapshotFile(
  snapshot: ComponentSourceSnapshot,
  source: SourceRef
): SourceFileSnapshot | null {
  return (
    snapshot.files.find(
      (file) =>
        normalizeProjectPath(file.file) === normalizeProjectPath(source.file) &&
        file.contentHash === source.contentHash
    ) ?? null
  );
}

function slotSourceFor(instance: ComponentInstance, slotName: string): SourceRef | null {
  const sources = instance.slotSources ?? {};
  if (sources[slotName]) return sources[slotName];
  if (slotName === 'default' && sources.children) return sources.children;
  if (slotName === 'children' && sources.default) return sources.default;
  return null;
}

function parseJsxFragment(body: string, fileName: string): ts.JsxFragment | null {
  const source = ts.createSourceFile(
    `${fileName}.slot.tsx`,
    `const __slot = <>${body}</>;`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let fragment: ts.JsxFragment | null = null;
  const parseDiagnostics =
    (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ??
    [];
  const visit = (node: ts.Node) => {
    if (fragment) return;
    if (ts.isJsxFragment(node)) fragment = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (parseDiagnostics.length) {
    return null;
  }
  return fragment;
}

function isStaticJsxNode(node: ts.Node): boolean {
  if (ts.isJsxText(node)) return true;
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
    const opening = ts.isJsxElement(node) ? node.openingElement : node;
    for (const attribute of opening.attributes.properties) {
      if (!ts.isJsxAttribute(attribute) || attribute.initializer === undefined) continue;
      if (ts.isStringLiteral(attribute.initializer)) continue;
      if (
        ts.isJsxExpression(attribute.initializer) &&
        attribute.initializer.expression &&
        isStaticExpression(attribute.initializer.expression)
      ) {
        continue;
      }
      return false;
    }
    return allChildrenStatic(node);
  }
  if (ts.isJsxExpression(node)) {
    return !node.expression || isStaticExpression(node.expression);
  }
  if (ts.isJsxOpeningElement(node) || ts.isJsxClosingElement(node)) {
    return true;
  }
  return allChildrenStatic(node);
}

function allChildrenStatic(node: ts.Node): boolean {
  let staticChildren = true;
  ts.forEachChild(node, (child) => {
    if (!isStaticJsxNode(child)) staticChildren = false;
  });
  return staticChildren;
}

function isStaticExpression(expression: ts.Expression): boolean {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(expression)) {
    return (
      (expression.operator === ts.SyntaxKind.PlusToken ||
        expression.operator === ts.SyntaxKind.MinusToken) &&
      isStaticExpression(expression.operand)
    );
  }
  return false;
}

function isStaticMarkupBody(body: string): boolean {
  if (!body.trim()) return true;
  // Liquid/Vue/Svelte control blocks and template expressions carry scope that
  // a slot replacement cannot prove without executing the framework compiler.
  if (/[{][{%#/@]|[{][{]/.test(body) || /{%|{{|}}|#(?:if|each|await)\b/.test(body)) return false;
  if (/<\s*(?:script|style)\b/i.test(body)) return false;
  return true;
}

function validateStaticReplacement(body: string, file: SourceFileSnapshot): boolean {
  const extension = `.${file.file.split('.').pop()?.toLowerCase() ?? ''}`;
  if (STATIC_MARKUP_EXTENSIONS.has(extension)) return isStaticMarkupBody(body);
  const fragment = parseJsxFragment(body, file.file);
  return !!fragment && fragment.children.every((child) => isStaticJsxNode(child));
}

function completePlan(
  mutation: ComponentFileMutation,
  index: ComponentIndex,
  instance: ComponentInstance,
  dialect: ComponentIndex['components'][number]['dialect']
): ComponentMutationPlan {
  const plan: ComponentMutationPlan = {
    files: [mutation],
    dialect,
    expectedRevision: index.revision,
  };
  if (dialect === 'react') {
    const component = index.components.find((item) => item.id === instance.componentId);
    if (component) {
      plan.parserToken = 'react-component-plan-v1';
      plan.expectedGraphDelta = {
        componentId: component.id,
        usagesBefore: component.usageCount,
        usagesAfter: component.usageCount,
        delta: 0,
      };
    }
  }
  return plan;
}

/**
 * Plan a source-anchored static slot replacement. This intentionally edits
 * only a proven children range; it never reconstructs an invocation or moves
 * a dynamic expression across a component boundary.
 */
export function planStaticSlotEdit(
  input: EditComponentSlotInput,
  index: ComponentIndex,
  suppliedSnapshot?: ComponentSourceSnapshot
): MutationResult {
  const snapshot = suppliedSnapshot ?? input.snapshot;
  if (!snapshot) return refusal('missing-source', 'A source snapshot is required to edit a slot.');
  if (snapshot.partial || index.partial) {
    return refusal('stale-source', 'The source graph is partial, so slot editing is disabled.');
  }
  const instance = index.instances.find((candidate) => candidate.id === input.instanceId);
  const component = index.components.find((candidate) => candidate.id === instance?.componentId);
  if (!instance || !component)
    return refusal('missing-source', 'The component slot instance is not indexed.');
  if (!component.capabilities.editSlots) {
    return refusal(
      'unsupported',
      `Static slot editing is not enabled for ${component.dialect} components.`
    );
  }
  const source = slotSourceFor(instance, input.slotName);
  if (!source) {
    return refusal(
      'missing-slot',
      `The ${input.slotName} slot does not have an exact static source range in this instance.`,
      instance.invocation
    );
  }
  const file = snapshotFile(snapshot, source);
  if (!file)
    return refusal('stale-source', 'The slot source changed after the catalog was built.', source);
  const start = utf8ByteOffsetToUtf16Offset(file.content, source.start);
  const end = utf8ByteOffsetToUtf16Offset(file.content, source.end);
  if (start === null || end === null || end <= start) {
    return refusal('invalid-range', 'The indexed slot source range is no longer valid.', source);
  }
  const current = file.content.slice(start, end);
  if (!validateStaticReplacement(current, file)) {
    return refusal(
      'dynamic-slot',
      'This slot contains dynamic markup or expressions, so Ship Studio will not rewrite it as static content.',
      source
    );
  }
  if (!validateStaticReplacement(input.replacementSource, file)) {
    return refusal(
      'dynamic-slot',
      'Slot replacements must be static text/markup without loops, conditions, or dynamic expressions.',
      source
    );
  }
  const leadingWhitespace = current.match(/^\s*/)?.[0] ?? '';
  const trailingWhitespace = current.match(/\s*$/)?.[0] ?? '';
  const replacementBody = input.replacementSource.trim();
  const replacement = `${leadingWhitespace}${replacementBody}${trailingWhitespace}`;
  if (current === replacement)
    return refusal('no-op', 'The slot already has that content.', source);
  const edit = {
    start: source.start,
    end: source.end,
    text: replacement,
  };
  const after = applyTextEdits(file.content, [edit]);
  if (after === null)
    return refusal(
      'invalid-range',
      'The slot edit does not preserve UTF-8 source boundaries.',
      source
    );
  const mutation: ComponentFileMutation = {
    file: file.file,
    expectedHash: file.contentHash,
    expectedResultHash: sha256(after),
    edits: [edit],
  };
  return { status: 'planned', plan: completePlan(mutation, index, instance, component.dialect) };
}

/** Build a source ref for UI callers that receive a byte range from a preview resolver. */
export function slotSourceRef(file: SourceFileSnapshot, start: number, end: number): SourceRef {
  const utf16Start = utf8ByteOffsetToUtf16Offset(file.content, start) ?? 0;
  const utf16End = utf8ByteOffsetToUtf16Offset(file.content, end) ?? utf16Start;
  return sourceRefFromUtf16Range(file.file, file.content, file.contentHash, utf16Start, utf16End);
}
