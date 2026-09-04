import ts from 'typescript';
import {
  applyTextEdits,
  sha256,
  sourceRefFromUtf16Range,
  utf16OffsetToUtf8ByteOffset,
  utf8ByteOffsetToUtf16Offset,
} from './ranges';
import { normalizeProjectPath } from './adapters/react-helpers';
import { planInsertComponent } from './mutation';
import { staticValueToJsx } from './adapters/static-values';
import type {
  ComponentFileMutation,
  ComponentIndex,
  ComponentDescriptor,
  ComponentMutationPlan,
  ComponentSourceSnapshot,
  ComponentInstance,
  EditComponentSlotInput,
  MutationResult,
  SourceFileSnapshot,
  SourceRef,
  StaticValue,
} from './types';

/**
 * Attach only direct, source-proven component children to each authored slot.
 * This is deliberately a pure projection over already-indexed instances: it
 * does not scan or execute project code and never treats a dynamic child as
 * editable structure.
 */
export function populateSlotChildren(
  instances: readonly ComponentInstance[],
  components: readonly ComponentDescriptor[] = []
): ComponentInstance[] {
  const next: ComponentInstance[] = instances.map((instance) => ({
    ...instance,
    slots: instance.slots.map((slot) => ({
      ...slot,
      ...(slot.children ? { children: [...slot.children] } : {}),
    })),
  }));
  const byId = new Map(next.map((instance) => [instance.id, instance]));
  const containing = new Map<string, string>();
  for (const parent of next) {
    for (const slot of parent.slots) {
      const range = parent.slotSources?.[slot.name];
      if (!range) continue;
      const candidates = next.filter(
        (child) =>
          child.id !== parent.id &&
          normalizeProjectPath(child.invocation.file) === normalizeProjectPath(range.file) &&
          child.invocation.contentHash === range.contentHash &&
          child.invocation.start >= range.start &&
          child.invocation.end <= range.end
      );
      const direct = candidates.filter(
        (child) =>
          !candidates.some(
            (other) =>
              other.id !== child.id &&
              other.invocation.start <= child.invocation.start &&
              other.invocation.end >= child.invocation.end &&
              (other.invocation.start < child.invocation.start ||
                other.invocation.end > child.invocation.end)
          )
      );
      if (direct.length === 0) continue;
      const current = byId.get(parent.id);
      if (!current) continue;
      const existingSlot = current.slots.find((candidate) => candidate.name === slot.name);
      if (existingSlot) {
        existingSlot.children = direct.map((child) => ({
          instanceId: child.id,
          componentId: child.componentId,
          name:
            components.find((component) => component.id === child.componentId)?.name ??
            child.componentId,
          invocation: child.invocation,
        }));
      }
      for (const child of direct) {
        if (!containing.has(child.id)) containing.set(child.id, parent.componentId);
      }
    }
  }
  return next.map((instance) => ({
    ...instance,
    containingComponentId: instance.containingComponentId ?? containing.get(instance.id) ?? null,
  }));
}

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
  const operation = input.operation ?? 'replace';
  if (operation !== 'replace') {
    return planStructuredSlotEdit(input, index, suppliedSnapshot);
  }
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
  if (input.replacementSource === undefined) {
    return refusal('unsupported', 'A replacement source is required for a slot replace operation.');
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

/**
 * Plan a structured slot operation from exact indexed children. Insertions
 * delegate to the existing placement planner for React so imports and graph
 * deltas retain their normal guarded semantics. Other markup dialects only
 * permit same-file placement, where no import guess is required.
 */
export function planStructuredSlotEdit(
  input: EditComponentSlotInput,
  index: ComponentIndex,
  suppliedSnapshot?: ComponentSourceSnapshot
): MutationResult {
  const snapshot = suppliedSnapshot ?? input.snapshot;
  if (!snapshot) return refusal('missing-source', 'A source snapshot is required to edit a slot.');
  if (snapshot.partial || index.partial)
    return refusal('stale-source', 'The source graph is partial, so slot composition is disabled.');
  const parent = index.instances.find((candidate) => candidate.id === input.instanceId);
  const parentComponent = index.components.find(
    (candidate) => candidate.id === parent?.componentId
  );
  if (!parent || !parentComponent)
    return refusal('missing-source', 'The component slot instance is not indexed.');
  if (!parentComponent.capabilities.editSlots)
    return refusal(
      'unsupported',
      `Slot composition is not enabled for ${parentComponent.dialect}.`
    );
  const slot = parent.slots.find((candidate) => candidate.name === input.slotName);
  const slotSource =
    parent.slotSources?.[input.slotName] ??
    (input.slotName === 'default' ? parent.slotSources?.children : undefined) ??
    (input.slotName === 'children' ? parent.slotSources?.default : undefined);
  if (!slot || !slotSource)
    return refusal('missing-slot', `The ${input.slotName} slot has no exact static source range.`);
  const file = snapshot.files.find(
    (candidate) =>
      normalizeProjectPath(candidate.file) === normalizeProjectPath(slotSource.file) &&
      candidate.contentHash === slotSource.contentHash
  );
  if (!file) return refusal('stale-source', 'The slot source changed after the catalog was built.');
  const slotStart = utf8ByteOffsetToUtf16Offset(file.content, slotSource.start);
  const slotEnd = utf8ByteOffsetToUtf16Offset(file.content, slotSource.end);
  if (slotStart === null || slotEnd === null || slotEnd < slotStart)
    return refusal(
      'invalid-range',
      'The indexed slot source range is no longer valid.',
      slotSource
    );
  const body = file.content.slice(slotStart, slotEnd);
  if (!validateStaticReplacement(body, file))
    return refusal(
      'dynamic-slot',
      'This slot contains dynamic markup or expressions, so structured composition is read-only.',
      slotSource
    );

  if (input.operation === 'insert') {
    return planSlotInsert(input, index, snapshot, parent, parentComponent, slot, file, slotStart);
  }

  const children = directSlotChildren(parent, slot, index);
  if (!input.childInstanceId) return refusal('missing-slot', 'A slot child must be selected.');
  const child = children.find((candidate) => candidate.id === input.childInstanceId);
  if (!child)
    return refusal(
      'missing-slot',
      'The selected slot child is not an exact direct child of this slot.'
    );
  const childStart = utf8ByteOffsetToUtf16Offset(file.content, child.invocation.start);
  const childEnd = utf8ByteOffsetToUtf16Offset(file.content, child.invocation.end);
  if (childStart === null || childEnd === null || childStart < slotStart || childEnd > slotEnd)
    return refusal(
      'stale-source',
      'The indexed slot child source range is stale.',
      child.invocation
    );
  if (input.operation === 'remove') {
    const edit = removeRangeWithWhitespace(file, childStart, childEnd);
    return structuredMutation(file, edit, index, parentComponent.dialect, child.componentId, -1);
  }

  if (input.operation !== 'reorder')
    return refusal('unsupported', `Unsupported slot operation "${String(input.operation)}".`);
  const before = input.beforeChildInstanceId
    ? children.find((candidate) => candidate.id === input.beforeChildInstanceId)
    : undefined;
  if (before && before.id === child.id)
    return refusal('no-op', 'The slot child is already in that position.');
  const sourceChildren = children
    .map((candidate) => {
      const start = utf8ByteOffsetToUtf16Offset(file.content, candidate.invocation.start);
      const end = utf8ByteOffsetToUtf16Offset(file.content, candidate.invocation.end);
      return start === null || end === null
        ? null
        : { candidate, start, end, text: file.content.slice(start, end) };
    })
    .filter(
      (item): item is { candidate: ComponentInstance; start: number; end: number; text: string } =>
        !!item
    );
  if (sourceChildren.length !== children.length)
    return refusal(
      'stale-source',
      'One or more slot children no longer has an exact source range.'
    );
  const nonChildren = sourceChildren
    .reduce((found, item) => found.replace(item.text, ''), body)
    .trim();
  if (nonChildren) {
    return refusal(
      'unsupported',
      'Reordering is available only when the slot contains direct component children and whitespace.'
    );
  }
  const ordered = sourceChildren.map((item) => item.candidate.id);
  const fromIndex = ordered.indexOf(child.id);
  if (fromIndex < 0) return refusal('stale-source', 'The selected slot child is stale.');
  ordered.splice(fromIndex, 1);
  const toIndex = before ? ordered.indexOf(before.id) : ordered.length;
  if (toIndex < 0) return refusal('stale-source', 'The target slot child is stale.');
  ordered.splice(toIndex, 0, child.id);
  const leading = body.match(/^\s*/)?.[0] ?? '';
  const trailing = body.match(/\s*$/)?.[0] ?? '';
  const separator = body.includes('\n') ? (body.match(/\n[ \t]*/)?.[0] ?? '\n') : ' ';
  const byId = new Map(sourceChildren.map((item) => [item.candidate.id, item.text]));
  const replacement = `${leading}${ordered.map((id) => byId.get(id) ?? '').join(separator)}${trailing}`;
  if (replacement === body) return refusal('no-op', 'The slot children are already in that order.');
  const edit = {
    start: utf16OffsetToUtf8ByteOffset(file.content, slotStart),
    end: utf16OffsetToUtf8ByteOffset(file.content, slotEnd),
    text: replacement,
  };
  return structuredMutation(file, edit, index, parentComponent.dialect, child.componentId, 0);
}

function planSlotInsert(
  input: EditComponentSlotInput,
  index: ComponentIndex,
  snapshot: ComponentSourceSnapshot,
  parent: ComponentInstance,
  parentComponent: ComponentIndex['components'][number],
  slot: ComponentInstance['slots'][number],
  file: SourceFileSnapshot,
  slotStart: number
): MutationResult {
  if (!input.componentId)
    return refusal('unknown-prop', 'A component definition must be selected for slot insertion.');
  const childComponent = index.components.find((candidate) => candidate.id === input.componentId);
  if (!childComponent || childComponent.dialect !== parentComponent.dialect)
    return refusal(
      'unsupported',
      'A slot can only contain an indexed component from the same dialect.'
    );
  if (!childComponent.capabilities.place)
    return refusal('not-placeable', 'The selected component is not safe to place in a slot.');
  const propsResult = structuredProps(childComponent, input.props ?? {});
  if (propsResult.status === 'refused') return propsResult;
  const children = directSlotChildren(parent, slot, index);
  const before = input.beforeChildInstanceId
    ? children.find((candidate) => candidate.id === input.beforeChildInstanceId)
    : undefined;
  if (input.beforeChildInstanceId && !before)
    return refusal('missing-slot', 'The requested slot insertion target is no longer indexed.');
  const invocationFile = snapshot.files.find(
    (candidate) =>
      normalizeProjectPath(candidate.file) === normalizeProjectPath(parent.invocation.file) &&
      candidate.contentHash === parent.invocation.contentHash
  );
  if (!invocationFile) return refusal('stale-source', 'The component invocation source is stale.');
  const invocation = renderStructuredInvocation(childComponent, propsResult.props);
  // React can use the regular placement planner, which also resolves imports.
  if (parentComponent.dialect === 'react') {
    const target = before ?? (children.length ? children[children.length - 1] : parent);
    const targetText = sourceTextForRange(invocationFile, target.invocation);
    if (!targetText) return refusal('stale-source', 'The slot insertion target source is stale.');
    return planInsertComponent(
      {
        kind: 'insert',
        componentId: childComponent.id,
        anchor: {
          file: target.invocation.file,
          line: target.invocation.line,
          column: target.invocation.column,
          html: targetText,
          position: before ? 'before' : children.length ? 'after' : 'inside',
        },
        props: propsResult.props,
        targetRange: {
          start: target.invocation.start,
          end: target.invocation.end,
        },
        snapshot,
      },
      index,
      snapshot
    );
  }
  if (normalizeProjectPath(childComponent.definition.file) !== normalizeProjectPath(file.file))
    return refusal(
      'unsupported',
      `Cross-file ${parentComponent.dialect} slot insertion is read-only until its import serializer is proven.`
    );
  const targetStart = before
    ? utf8ByteOffsetToUtf16Offset(file.content, before.invocation.start)
    : children.length
      ? utf8ByteOffsetToUtf16Offset(file.content, children[children.length - 1].invocation.end)
      : slotStart;
  if (targetStart === null) return refusal('stale-source', 'The slot insertion target is stale.');
  const text = before || children.length ? ` ${invocation}` : invocation;
  const edit = {
    start: utf16OffsetToUtf8ByteOffset(file.content, targetStart),
    end: utf16OffsetToUtf8ByteOffset(file.content, targetStart),
    text,
  };
  return structuredMutation(file, edit, index, parentComponent.dialect, childComponent.id, 1);
}

function directSlotChildren(
  parent: ComponentInstance,
  slot: ComponentInstance['slots'][number],
  index: ComponentIndex
): ComponentInstance[] {
  if (slot.children?.length) {
    const byId = new Map(index.instances.map((instance) => [instance.id, instance]));
    return slot.children.flatMap((child) => {
      const instance = byId.get(child.instanceId);
      return instance ? [instance] : [];
    });
  }
  const source = parent.slotSources?.[slot.name];
  if (!source) return [];
  const candidates = index.instances.filter(
    (child) =>
      child.id !== parent.id &&
      normalizeProjectPath(child.invocation.file) === normalizeProjectPath(source.file) &&
      child.invocation.contentHash === source.contentHash &&
      child.invocation.start >= source.start &&
      child.invocation.end <= source.end
  );
  return candidates.filter(
    (child) =>
      !candidates.some(
        (other) =>
          other.id !== child.id &&
          other.invocation.start <= child.invocation.start &&
          other.invocation.end >= child.invocation.end &&
          (other.invocation.start < child.invocation.start ||
            other.invocation.end > child.invocation.end)
      )
  );
}

function structuredProps(
  descriptor: ComponentIndex['components'][number],
  explicit: Record<string, StaticValue>
):
  | { status: 'ok'; props: Record<string, StaticValue> }
  | Extract<MutationResult, { status: 'refused' }> {
  const known = new Set(descriptor.props.map((prop) => prop.name));
  for (const name of Object.keys(explicit)) {
    if (!known.has(name))
      return refusal('unknown-prop', `The component does not declare "${name}".`);
  }
  for (const prop of descriptor.props) {
    if (prop.required && prop.defaultValue === null && explicit[prop.name] === undefined)
      return refusal('required-prop', `The required prop "${prop.name}" needs an explicit value.`);
  }
  return { status: 'ok', props: explicit };
}

function renderStructuredInvocation(
  component: ComponentIndex['components'][number],
  props: Record<string, StaticValue>
): string {
  const attributes = Object.entries(props)
    .map(([name, value]) => {
      if (value.kind === 'boolean' && value.value) return ` ${name}`;
      return ` ${name}=${staticValueToJsx(value)}`;
    })
    .join('');
  return component.dialect === 'web-component'
    ? `<${component.name}${attributes}></${component.name}>`
    : `<${component.localName}${attributes} />`;
}

function sourceTextForRange(file: SourceFileSnapshot, source: SourceRef): string | null {
  const start = utf8ByteOffsetToUtf16Offset(file.content, source.start);
  const end = utf8ByteOffsetToUtf16Offset(file.content, source.end);
  return start === null || end === null ? null : file.content.slice(start, end);
}

function removeRangeWithWhitespace(file: SourceFileSnapshot, start: number, end: number) {
  let adjustedStart = start;
  let adjustedEnd = end;
  while (adjustedStart > 0 && /[ \t]/.test(file.content[adjustedStart - 1] ?? ''))
    adjustedStart -= 1;
  while (adjustedEnd < file.content.length && /[ \t]/.test(file.content[adjustedEnd] ?? ''))
    adjustedEnd += 1;
  return {
    start: utf16OffsetToUtf8ByteOffset(file.content, adjustedStart),
    end: utf16OffsetToUtf8ByteOffset(file.content, adjustedEnd),
    text: '',
  };
}

function structuredMutation(
  file: SourceFileSnapshot,
  edit: { start: number; end: number; text: string },
  index: ComponentIndex,
  dialect: ComponentIndex['components'][number]['dialect'],
  componentId: string,
  graphDelta: number
): MutationResult {
  const component = index.components.find((candidate) => candidate.id === componentId);
  if (!component)
    return refusal('missing-source', 'The slot child component is no longer indexed.');
  const after = applyTextEdits(file.content, [edit]);
  if (after === null)
    return refusal(
      'invalid-range',
      'The slot operation does not preserve UTF-8 source boundaries.'
    );
  if (after === file.content)
    return refusal('no-op', 'The slot already has the requested structure.');
  const mutation: ComponentFileMutation = {
    file: normalizeProjectPath(file.file),
    expectedHash: file.contentHash,
    expectedResultHash: sha256(after),
    edits: [edit],
  };
  const plan: ComponentMutationPlan = {
    files: [mutation],
    expectedRevision: index.revision,
    ...(dialect === 'react'
      ? {
          dialect: 'react' as const,
          parserToken: 'react-component-plan-v1',
          expectedGraphDelta: {
            componentId: component.id,
            usagesBefore: component.usageCount,
            usagesAfter: component.usageCount + graphDelta,
            delta: graphDelta,
          },
        }
      : { dialect }),
  };
  return { status: 'planned', plan };
}

/** Build a source ref for UI callers that receive a byte range from a preview resolver. */
export function slotSourceRef(file: SourceFileSnapshot, start: number, end: number): SourceRef {
  const utf16Start = utf8ByteOffsetToUtf16Offset(file.content, start) ?? 0;
  const utf16End = utf8ByteOffsetToUtf16Offset(file.content, end) ?? utf16Start;
  return sourceRefFromUtf16Range(file.file, file.content, file.contentHash, utf16Start, utf16End);
}
