import ts from 'typescript';
import {
  applyTextEdits,
  sha256,
  utf8ByteOffsetToUtf16Offset,
  utf16OffsetToUtf8ByteOffset,
} from './ranges';
import {
  moduleSpecifierForFile,
  normalizeProjectPath,
  resolveModulePath,
} from './adapters/react-helpers';
import { staticValueToJsx } from './adapters/static-values';
import type {
  ComponentDescriptor,
  ComponentDiagnostic,
  ComponentFileMutation,
  ComponentIndex,
  ComponentInstance,
  ComponentMutationPlan,
  ComponentMutationPreview,
  ComponentSourceSnapshot,
  ComponentTextEdit,
  EditComponentPropInput,
  InsertComponentInput,
  MutationResult,
  MutationValidationInput,
  MutationValidationResult,
  SourceFileSnapshot,
  StaticValue,
} from './types';

const REACT_SCRIPT_KINDS = new Set(['.tsx', '.jsx', '.ts', '.js', '.mts', '.cts', '.mjs', '.cjs']);
export const REACT_COMPONENT_PLAN_PARSER_TOKEN = 'react-component-plan-v1';
export const REACT_NATIVE_COMPONENT_PLAN_PARSER_TOKEN = 'react-native-component-plan-v1';
export type ReactMutationDialect = 'react' | 'react-native';

export function planInsertComponent(
  input: InsertComponentInput,
  index: ComponentIndex,
  suppliedSnapshot?: ComponentSourceSnapshot
): MutationResult {
  const snapshot = suppliedSnapshot ?? input.snapshot;
  if (!snapshot)
    return refuse('missing-source', 'A source snapshot is required to plan a component placement.');
  if (snapshot.partial) {
    return refuse(
      'stale-source',
      'The source snapshot is partial, so dependency-safe component placement is disabled.'
    );
  }
  const descriptor = index.components.find((component) => component.id === input.componentId);
  if (!descriptor)
    return refuse('unsupported', 'The requested component is not present in the current index.');
  if (!descriptor.capabilities.place || descriptor.kind === 'layout') {
    return refuse(
      'not-placeable',
      'Route and layout roots are catalogued but cannot be placed as reusable components.'
    );
  }
  const target = findSnapshotFile(snapshot, input.anchor.file);
  if (!target)
    return refuse(
      'missing-source',
      `The insertion target ${input.anchor.file} is not in the source snapshot.`
    );
  if (!REACT_SCRIPT_KINDS.has(extension(target.file))) {
    return refuse(
      'unsupported',
      'The React adapter can only place into TypeScript or JavaScript source files.'
    );
  }
  const targetSource = createSourceFile(target);
  const targetRange = input.targetRange
    ? normalizeTargetRange(target, targetSource, input.targetRange)
    : findAnchorRange(targetSource, input);
  if (!targetRange)
    return refuse('missing-anchor', 'The source anchor did not match a JSX element.');
  if (targetRange.status === 'ambiguous') {
    return refuse('ambiguous-anchor', 'More than one JSX element matches the source anchor.');
  }
  if (
    normalizeProjectPath(descriptor.definition.file) === normalizeProjectPath(target.file) &&
    rangeIsWithinDefinition(
      target,
      targetRange,
      descriptor.definition.start,
      descriptor.definition.end
    )
  ) {
    return refuse(
      'dependency-cycle',
      'A component cannot be placed inside its own definition because it would render recursively.'
    );
  }
  if (input.anchor.position === 'inside' && targetRange.openingEnd === null) {
    return refuse('unsupported', 'A self-closing JSX element cannot receive a child placement.');
  }

  const desiredName =
    normalizeProjectPath(descriptor.definition.file) === normalizeProjectPath(target.file)
      ? descriptor.localName
      : descriptor.exportName === 'default'
        ? descriptor.name
        : (descriptor.exportName ?? descriptor.name);
  if (!/^[A-Z][A-Za-z0-9_$]*$/.test(desiredName)) {
    return refuse('unsupported', 'The component export does not have a valid JSX identifier.');
  }
  const propsResult = buildProps(descriptor, input.props ?? {});
  if (propsResult.status === 'refused') return propsResult;
  const importResult = resolveImportForPlacement(
    target,
    targetSource,
    descriptor,
    snapshot.files,
    index,
    desiredName
  );
  if (importResult.status === 'refused') return importResult;
  const invocationName = importResult.localName;
  const invocation = `<${invocationName}${propsText(propsResult.props)} />`;
  const placement = placementEdit(target, targetRange, input.anchor.position, invocation);
  if (!placement)
    return refuse(
      'unsupported',
      'The JSX anchor could not be edited without reprinting the source file.'
    );
  const edits: ComponentTextEdit[] = [placement];
  if (importResult.importEdit) edits.push(importResult.importEdit);
  return plannedMutation(target, edits, descriptor, 1, snapshot.revision);
}

export function planStaticPropEdit(
  input: EditComponentPropInput,
  index: ComponentIndex,
  suppliedSnapshot?: ComponentSourceSnapshot
): MutationResult {
  const operation = input.operation ?? 'set';
  if (operation === 'set' && !input.value) {
    return refuse('unsupported', 'A static prop value is required for a set operation.');
  }
  const snapshot = suppliedSnapshot ?? input.snapshot;
  if (!snapshot)
    return refuse('missing-source', 'A source snapshot is required to edit a component prop.');
  if (snapshot.partial) {
    return refuse(
      'stale-source',
      'The source snapshot is partial, so visual component prop edits are disabled.'
    );
  }
  const instance = index.instances.find((item) => item.id === input.instanceId);
  if (!instance)
    return refuse('unsupported', 'The requested component invocation is not in the current index.');
  const descriptor = index.components.find((component) => component.id === instance.componentId);
  if (!descriptor)
    return refuse('unsupported', 'The invocation points to a missing component definition.');
  if (!descriptor.capabilities.editStaticProps) {
    return refuse(
      'unsupported',
      'Visual prop editing is disabled because this component contract is not safely editable.'
    );
  }
  const prop = descriptor.props.find((item) => item.name === input.propName);
  if (!prop)
    return refuse(
      'unknown-prop',
      `The component does not declare a prop named "${input.propName}".`
    );
  const file = findSnapshotFile(snapshot, instance.invocation.file);
  if (!file || file.contentHash !== instance.invocation.contentHash) {
    return refuse('stale-source', 'The source changed after this component index was built.');
  }
  if (operation === 'remove' && prop.required) {
    return refuse(
      'required-prop',
      `The required prop "${input.propName}" cannot be reset on a component instance.`
    );
  }
  const sourceFile = createSourceFile(file);
  const node = findInvocationNode(sourceFile, file, instance);
  if (!node)
    return refuse('stale-source', 'The indexed JSX invocation no longer matches the source file.');
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  const attribute = opening.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText(sourceFile) === input.propName
  );
  if (attribute) {
    const attributeIndex = opening.attributes.properties.indexOf(attribute);
    const overriddenBySpread = opening.attributes.properties
      .slice(attributeIndex + 1)
      .some(ts.isJsxSpreadAttribute);
    if (overriddenBySpread) {
      return refuse(
        'dynamic-expression',
        `The existing "${input.propName}" value may be overridden by a later JSX spread.`
      );
    }
  }
  if (attribute && !isStaticAttribute(attribute)) {
    return refuse(
      'dynamic-expression',
      `The existing "${input.propName}" value is dynamic and cannot be replaced safely.`
    );
  }
  if (operation === 'remove' && !attribute) {
    return refuse('no-op', `The "${input.propName}" prop is already using its default value.`);
  }
  const edit =
    operation === 'remove'
      ? removeAttribute(file, sourceFile, attribute!)
      : attribute
        ? editExistingAttribute(file, sourceFile, attribute, input.propName, input.value!)
        : insertAttribute(file, sourceFile, opening, input.propName, input.value!);
  if (!edit)
    return refuse(
      'unsupported',
      'The prop edit could not be represented as a minimal JSX text edit.'
    );
  if (edit.start === edit.end && edit.text === '') {
    return refuse('no-op', `The "${input.propName}" prop is already set to that value.`);
  }
  return plannedMutation(file, [edit], descriptor, 0, snapshot.revision);
}

export function validateReactMutation(
  input: MutationValidationInput,
  dialect: ReactMutationDialect = 'react'
): MutationValidationResult {
  const diagnostics: ComponentDiagnostic[] = validateMutationProtocol(input.plan, dialect);
  const operations = input.plan.operations ?? [];
  if (operations.length > 0 && input.plan.files.length > 0) {
    diagnostics.push({
      code: 'mutation-mixed-operations',
      severity: 'error',
      message: 'A lifecycle component plan cannot mix operations with legacy file edits.',
    });
  }
  const edits = [
    ...input.plan.files.map((mutation) => ({ kind: 'edit' as const, mutation })),
    ...operations.flatMap((operation) =>
      operation.kind === 'edit' ? [{ kind: 'edit' as const, mutation: operation }] : []
    ),
  ];
  for (const { mutation } of edits) {
    const file = findSnapshotFile(input.snapshot, mutation.file);
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
        message: 'The mutation source hash is stale.',
        file: mutation.file,
      });
      continue;
    }
    const result = applyTextEdits(file.content, mutation.edits);
    if (result === null) {
      diagnostics.push({
        code: 'mutation-invalid-range',
        severity: 'error',
        message: 'The mutation contains overlapping or invalid UTF-8 byte ranges.',
        file: mutation.file,
      });
      continue;
    }
    if (sha256(result) !== mutation.expectedResultHash) {
      diagnostics.push({
        code: 'mutation-result-hash',
        severity: 'error',
        message: 'The mutation result hash does not match the planned source.',
        file: mutation.file,
      });
      continue;
    }
    const parsed = createSourceFile({
      ...file,
      content: result,
      contentHash: mutation.expectedResultHash,
    });
    const parseDiagnostics =
      (parsed as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
        .parseDiagnostics ?? [];
    if (parseDiagnostics.length > 0) {
      diagnostics.push({
        code: 'mutation-syntax-error',
        severity: 'error',
        message: 'The proposed source contains a syntax error.',
        file: mutation.file,
      });
    }
  }
  for (const operation of operations) {
    if (operation.kind === 'edit') continue;
    if (operation.kind === 'create') {
      const existing = findSnapshotFile(input.snapshot, operation.file);
      if (existing) {
        diagnostics.push({
          code: 'mutation-create-collision',
          severity: 'error',
          message: `The extraction destination ${operation.file} already exists.`,
          file: operation.file,
        });
        continue;
      }
      if (!operation.expectedAbsent) {
        diagnostics.push({
          code: 'mutation-create-guard',
          severity: 'error',
          message: 'A new component file must explicitly require an absent destination.',
          file: operation.file,
        });
      }
      if (
        operation.expectedResultHash !== undefined &&
        sha256(operation.contents) !== operation.expectedResultHash
      ) {
        diagnostics.push({
          code: 'mutation-result-hash',
          severity: 'error',
          message: 'The extracted component file hash does not match the planned contents.',
          file: operation.file,
        });
      }
      const parsed = createSourceFile({
        file: operation.file,
        content: operation.contents,
        contentHash: sha256(operation.contents),
      });
      const parseDiagnostics =
        (parsed as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
          .parseDiagnostics ?? [];
      if (parseDiagnostics.length > 0) {
        diagnostics.push({
          code: 'mutation-syntax-error',
          severity: 'error',
          message: 'The extracted component file contains a syntax error.',
          file: operation.file,
        });
      }
      continue;
    }
    diagnostics.push({
      code: 'mutation-unsupported-operation',
      severity: 'error',
      message: `The React mutation validator does not validate ${operation.kind} operations.`,
    });
  }
  return diagnostics.length > 0
    ? { status: 'invalid', diagnostics }
    : { status: 'valid', diagnostics: [] };
}

function validateMutationProtocol(
  plan: ComponentMutationPlan,
  dialect: ReactMutationDialect = 'react'
): ComponentDiagnostic[] {
  const hasProtocolMetadata =
    plan.dialect !== undefined ||
    plan.parserToken !== undefined ||
    plan.expectedGraphDelta !== undefined;
  const diagnostics: ComponentDiagnostic[] = [];
  if (plan.operations?.length && plan.files.length > 0) {
    diagnostics.push({
      code: 'mutation-mixed-operations',
      severity: 'error',
      message: 'Lifecycle operations cannot be mixed with legacy edit files.',
    });
  }
  if (!hasProtocolMetadata) return diagnostics;
  if (plan.dialect !== dialect) {
    diagnostics.push({
      code: 'mutation-dialect',
      severity: 'error',
      message: `The mutation plan was not produced by the ${dialect === 'react-native' ? 'React Native' : 'React'} adapter.`,
    });
  }
  const expectedParserToken =
    dialect === 'react-native'
      ? REACT_NATIVE_COMPONENT_PLAN_PARSER_TOKEN
      : REACT_COMPONENT_PLAN_PARSER_TOKEN;
  if (plan.parserToken !== expectedParserToken) {
    diagnostics.push({
      code: 'mutation-parser-token',
      severity: 'error',
      message: `The mutation plan uses an unsupported ${dialect === 'react-native' ? 'React Native' : 'React'} parser revision.`,
    });
  }
  const delta = plan.expectedGraphDelta;
  if (!delta) {
    diagnostics.push({
      code: 'mutation-graph-delta',
      severity: 'error',
      message: 'Parser-backed component plans must include an expected graph delta.',
    });
    return diagnostics;
  }
  if (
    !Number.isSafeInteger(delta.usagesBefore) ||
    !Number.isSafeInteger(delta.usagesAfter) ||
    delta.usagesBefore < 0 ||
    delta.usagesAfter < 0 ||
    delta.delta !== delta.usagesAfter - delta.usagesBefore
  ) {
    diagnostics.push({
      code: 'mutation-graph-delta',
      severity: 'error',
      message: 'The expected graph delta does not match its before/after usage counts.',
    });
  }
  if (
    !plan.operations?.length &&
    (delta.createdComponentId || delta.removedComponentId || delta.createdUsages !== undefined)
  ) {
    diagnostics.push({
      code: 'mutation-unsupported-operation',
      severity: 'error',
      message: 'Definition lifecycle graph metadata requires the lifecycle mutation path.',
    });
  }
  return diagnostics;
}

/**
 * Build the local review representation for a validated mutation plan. The
 * complete source stays in memory; the returned diff is intentionally compact
 * so a placement with an import and an invocation does not render an entire
 * source file in the approval dialog.
 */
export function previewComponentMutation(
  plan: ComponentMutationPlan,
  snapshot: ComponentSourceSnapshot
): ComponentMutationPreview | null {
  const files = [] as ComponentMutationPreview['files'];
  for (const mutation of plan.files) {
    const file = findSnapshotFile(snapshot, mutation.file);
    if (!file || file.contentHash !== mutation.expectedHash) return null;
    const after = applyTextEdits(file.content, mutation.edits);
    if (after === null || sha256(after) !== mutation.expectedResultHash) return null;
    const diff = mutationDiff(file.content, after, mutation.edits);
    files.push({
      file: mutation.file,
      beforeHash: mutation.expectedHash,
      afterHash: mutation.expectedResultHash,
      diff: diff.text,
      additions: diff.additions,
      deletions: diff.deletions,
    });
  }
  return { plan, files };
}

interface MutationDiff {
  text: string;
  additions: number;
  deletions: number;
}

interface PreviewLineRange {
  beforeStart: number;
  beforeEnd: number;
  afterStart: number;
  afterEnd: number;
}

const PREVIEW_CONTEXT_LINES = 2;

function mutationDiff(
  before: string,
  after: string,
  edits: readonly ComponentTextEdit[]
): MutationDiff {
  const beforeLines = previewLines(before);
  const afterLines = previewLines(after);
  const beforeStarts = lineStarts(before);
  const afterStarts = lineStarts(after);
  let shift = 0;
  const ranges: PreviewLineRange[] = [];

  for (const edit of [...edits].sort((left, right) => left.start - right.start)) {
    const beforeStart = utf8ByteOffsetToUtf16Offset(before, edit.start);
    const beforeEnd = utf8ByteOffsetToUtf16Offset(before, edit.end);
    if (beforeStart === null || beforeEnd === null) continue;
    const afterStart = beforeStart + shift;
    const afterEnd = afterStart + edit.text.length;
    ranges.push({
      beforeStart: Math.max(0, lineIndexAt(beforeStarts, beforeStart) - PREVIEW_CONTEXT_LINES),
      beforeEnd: Math.min(
        beforeLines.length,
        lineIndexAt(beforeStarts, Math.max(beforeStart, beforeEnd - 1)) + PREVIEW_CONTEXT_LINES + 1
      ),
      afterStart: Math.max(0, lineIndexAt(afterStarts, afterStart) - PREVIEW_CONTEXT_LINES),
      afterEnd: Math.min(
        afterLines.length,
        lineIndexAt(afterStarts, Math.max(afterStart, afterEnd - 1)) + PREVIEW_CONTEXT_LINES + 1
      ),
    });
    shift += edit.text.length - (beforeEnd - beforeStart);
  }

  if (ranges.length === 0) return simpleMutationDiff(beforeLines, afterLines);

  const merged = ranges
    .sort((left, right) => left.beforeStart - right.beforeStart)
    .reduce((result, range) => {
      const previous = result[result.length - 1];
      if (
        previous &&
        range.beforeStart <= previous.beforeEnd &&
        range.afterStart <= previous.afterEnd
      ) {
        previous.beforeEnd = Math.max(previous.beforeEnd, range.beforeEnd);
        previous.afterEnd = Math.max(previous.afterEnd, range.afterEnd);
      } else {
        result.push({ ...range });
      }
      return result;
    }, [] as PreviewLineRange[]);

  const lines: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const range of merged) {
    const beforeChunk = beforeLines.slice(range.beforeStart, range.beforeEnd);
    const afterChunk = afterLines.slice(range.afterStart, range.afterEnd);
    const prefix = commonLinePrefix(beforeChunk, afterChunk);
    const suffix = commonLineSuffix(beforeChunk, afterChunk, prefix);
    lines.push(
      `@@ -${range.beforeStart + 1},${beforeChunk.length} +${range.afterStart + 1},${afterChunk.length} @@`
    );
    for (const line of beforeChunk.slice(0, prefix)) lines.push(` ${line}`);
    for (const line of beforeChunk.slice(prefix, beforeChunk.length - suffix)) {
      lines.push(`-${line}`);
      deletions += 1;
    }
    for (const line of afterChunk.slice(prefix, afterChunk.length - suffix)) {
      lines.push(`+${line}`);
      additions += 1;
    }
    for (const line of beforeChunk.slice(beforeChunk.length - suffix)) lines.push(` ${line}`);
  }
  return { text: lines.join('\n'), additions, deletions };
}

function simpleMutationDiff(beforeLines: string[], afterLines: string[]): MutationDiff {
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - suffix - 1] === afterLines[afterLines.length - suffix - 1]
  ) {
    suffix += 1;
  }
  const beforeChunk = beforeLines.slice(prefix, beforeLines.length - suffix);
  const afterChunk = afterLines.slice(prefix, afterLines.length - suffix);
  const lines = [`@@ -${prefix + 1},${beforeChunk.length} +${prefix + 1},${afterChunk.length} @@`];
  for (const line of beforeChunk) lines.push(`-${line}`);
  for (const line of afterChunk) lines.push(`+${line}`);
  return {
    text: lines.join('\n'),
    additions: afterChunk.length,
    deletions: beforeChunk.length,
  };
}

function previewLines(content: string): string[] {
  return content.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineIndexAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  const target = Math.max(0, offset);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= target) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(0, high);
}

function commonLinePrefix(before: string[], after: string[]): number {
  let count = 0;
  while (count < before.length && count < after.length && before[count] === after[count]) {
    count += 1;
  }
  return count;
}

function commonLineSuffix(before: string[], after: string[], prefix: number): number {
  let count = 0;
  while (
    count < before.length - prefix &&
    count < after.length - prefix &&
    before[before.length - count - 1] === after[after.length - count - 1]
  ) {
    count += 1;
  }
  return count;
}

interface RangeMatch {
  status: 'matched';
  start: number;
  end: number;
  openingEnd: number | null;
  closingStart: number | null;
}

interface AmbiguousRange {
  status: 'ambiguous';
}

function rangeIsWithinDefinition(
  file: SourceFileSnapshot,
  range: RangeMatch,
  definitionStart: number,
  definitionEnd: number
): boolean {
  const start = utf8ByteOffsetToUtf16Offset(file.content, definitionStart);
  const end = utf8ByteOffsetToUtf16Offset(file.content, definitionEnd);
  return start !== null && end !== null && range.start >= start && range.end <= end;
}

function findAnchorRange(
  sourceFile: ts.SourceFile,
  input: InsertComponentInput
): RangeMatch | AmbiguousRange | null {
  const exactCandidates: RangeMatch[] = [];
  const fuzzyCandidates: RangeMatch[] = [];
  const expected = input.anchor.html.trim();
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const start = node.getStart(sourceFile);
      const end = node.end;
      const startPosition = sourceFile.getLineAndCharacterOfPosition(start);
      const endPosition = sourceFile.getLineAndCharacterOfPosition(Math.max(start, end - 1));
      const anchorLine = input.anchor.line - 1;
      if (anchorLine >= startPosition.line && anchorLine <= endPosition.line) {
        const anchorPosition =
          input.anchor.column && input.anchor.column > 0
            ? sourceFile.getPositionOfLineAndCharacter(anchorLine, input.anchor.column - 1)
            : null;
        const matchesColumn =
          anchorPosition === null ||
          (anchorPosition >= start &&
            anchorPosition < end &&
            sourceFile.getLineAndCharacterOfPosition(anchorPosition).line === anchorLine);
        const text = node.getText(sourceFile);
        const matchesText =
          expected.length === 0 || text.includes(expected) || expected.includes(text);
        if (matchesText && matchesColumn) {
          const match: RangeMatch = {
            status: 'matched',
            start,
            end,
            openingEnd: ts.isJsxElement(node) ? node.openingElement.end : null,
            closingStart: ts.isJsxElement(node) ? node.closingElement.getStart(sourceFile) : null,
          };
          if (expected.length === 0 || text === expected) exactCandidates.push(match);
          else fuzzyCandidates.push(match);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const candidates = exactCandidates.length > 0 ? exactCandidates : fuzzyCandidates;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return { status: 'ambiguous' };
  return null;
}

function normalizeTargetRange(
  file: SourceFileSnapshot,
  sourceFile: ts.SourceFile,
  range: NonNullable<InsertComponentInput['targetRange']>
): RangeMatch | null {
  const start = utf8ByteOffsetToUtf16Offset(file.content, range.start);
  const end = utf8ByteOffsetToUtf16Offset(file.content, range.end);
  if (start === null || end === null || end < start) return null;
  const matches: RangeMatch[] = [];
  const visit = (node: ts.Node) => {
    if (matches.length > 0) return;
    if (
      (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.getStart(sourceFile) === start &&
      node.end === end
    ) {
      matches.push({
        status: 'matched',
        start,
        end,
        openingEnd: ts.isJsxElement(node) ? node.openingElement.end : null,
        closingStart: ts.isJsxElement(node) ? node.closingElement.getStart(sourceFile) : null,
      });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const matched = matches[0];
  if (!matched) return null;
  const suppliedOpening =
    range.openingEnd === undefined
      ? null
      : utf8ByteOffsetToUtf16Offset(file.content, range.openingEnd);
  const suppliedClosing =
    range.closingStart === undefined
      ? null
      : utf8ByteOffsetToUtf16Offset(file.content, range.closingStart);
  if (
    (range.openingEnd !== undefined && suppliedOpening !== matched.openingEnd) ||
    (range.closingStart !== undefined && suppliedClosing !== matched.closingStart)
  ) {
    return null;
  }
  return matched;
}

function placementEdit(
  file: SourceFileSnapshot,
  range: RangeMatch,
  position: InsertComponentInput['anchor']['position'],
  invocation: string
): ComponentTextEdit | null {
  const newline = file.content.includes('\r\n') ? '\r\n' : '\n';
  const lineStart = file.content.lastIndexOf('\n', range.start - 1) + 1;
  const indent = file.content.slice(lineStart, range.start).match(/^[ \t]*/)?.[0] ?? '';
  if (position === 'inside') {
    if (range.openingEnd === null || range.closingStart === null) return null;
    const between = file.content.slice(range.openingEnd, range.closingStart);
    if (between.includes('\n')) {
      const childIndent = inferChildIndent(
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
  const afterText = `${newline}${indent}${invocation}`;
  return {
    start: utf16OffsetToUtf8ByteOffset(file.content, range.end),
    end: utf16OffsetToUtf8ByteOffset(file.content, range.end),
    text: afterText,
  };
}

function inferChildIndent(
  content: string,
  openingEnd: number,
  closingStart: number,
  parentIndent: string
): string {
  const between = content.slice(openingEnd, closingStart);
  const line = between.split('\n').find((item) => /\S/.test(item));
  if (line) return line.match(/^[ \t]*/)?.[0] ?? `${parentIndent}  `;
  return `${parentIndent}  `;
}

function buildProps(
  descriptor: ComponentDescriptor,
  explicit: Record<string, StaticValue>
):
  | { status: 'ok'; props: Record<string, StaticValue> }
  | Extract<MutationResult, { status: 'refused' }> {
  const known = new Set(descriptor.props.map((prop) => prop.name));
  for (const name of Object.keys(explicit)) {
    if (!known.has(name))
      return refuse('unknown-prop', `The component does not declare a prop named "${name}".`);
  }
  for (const prop of descriptor.props) {
    if (prop.required && prop.defaultValue === null && explicit[prop.name] === undefined) {
      return refuse(
        'required-prop',
        `The required prop "${prop.name}" needs an explicit value before placement.`
      );
    }
  }
  return { status: 'ok', props: explicit };
}

function propsText(props: Record<string, StaticValue>): string {
  return Object.entries(props)
    .map(([name, value]) => ` ${jsxAttribute(name, value)}`)
    .join('');
}

function jsxAttribute(name: string, value: StaticValue, quote = '"'): string {
  if (value.kind === 'boolean' && value.value) return name;
  return `${name}=${staticValueToJsx(value, quote)}`;
}

interface ImportPlacement {
  status: 'ok';
  localName: string;
  importEdit: ComponentTextEdit | null;
}

function resolveImportForPlacement(
  target: SourceFileSnapshot,
  sourceFile: ts.SourceFile,
  descriptor: ComponentDescriptor,
  files: readonly SourceFileSnapshot[],
  index: ComponentIndex,
  desiredName: string
): ImportPlacement | Extract<MutationResult, { status: 'refused' }> {
  const definitionFile = normalizeProjectPath(descriptor.definition.file);
  const targetFile = normalizeProjectPath(target.file);
  if (definitionFile === targetFile)
    return { status: 'ok', localName: desiredName, importEdit: null };
  if (hasDependencyPath(index, definitionFile, targetFile)) {
    return refuse('dependency-cycle', 'Placing this component would introduce an import cycle.');
  }
  const importDeclarations = sourceFile.statements.filter(ts.isImportDeclaration);
  const topLevelNames = topLevelBindingNames(sourceFile);
  for (const declaration of importDeclarations) {
    if (!ts.isStringLiteral(declaration.moduleSpecifier)) continue;
    const resolution = resolveModulePath(target.file, declaration.moduleSpecifier.text, files);
    if (resolution.file !== definitionFile) continue;
    const clause = declaration.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (descriptor.exportName === 'default' && clause.name) {
      return { status: 'ok', localName: clause.name.text, importEdit: null };
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      const match = clause.namedBindings.elements.find(
        (element) =>
          !element.isTypeOnly &&
          (element.propertyName?.text ?? element.name.text) === descriptor.exportName
      );
      if (match) return { status: 'ok', localName: match.name.text, importEdit: null };
    }
    if (
      clause.namedBindings &&
      ts.isNamespaceImport(clause.namedBindings) &&
      descriptor.exportName
    ) {
      return {
        status: 'ok',
        localName: `${clause.namedBindings.name.text}.${descriptor.exportName}`,
        importEdit: null,
      };
    }
  }
  if (topLevelNames.has(desiredName)) {
    return refuse(
      'symbol-collision',
      `The JSX name "${desiredName}" is already bound in ${target.file}.`
    );
  }
  const sourceSpecifier = moduleSpecifierForFile(target.file, definitionFile, files);
  const quote = importDeclarations.some((declaration) =>
    declaration.getText(sourceFile).includes("'")
  )
    ? "'"
    : '"';
  const importText =
    descriptor.exportName === 'default'
      ? `import ${desiredName} from ${quote}${sourceSpecifier}${quote};`
      : `import { ${descriptor.exportName ?? desiredName} } from ${quote}${sourceSpecifier}${quote};`;
  const insertion = importInsertionOffset(sourceFile);
  const newline = target.content.includes('\r\n') ? '\r\n' : '\n';
  return {
    status: 'ok',
    localName: desiredName,
    importEdit: {
      start: utf16OffsetToUtf8ByteOffset(target.content, insertion),
      end: utf16OffsetToUtf8ByteOffset(target.content, insertion),
      text: `${insertion > 0 ? newline : ''}${importText}${newline}`,
    },
  };
}

function topLevelBindingNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) names.add(clause.name.text);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        names.add(clause.namedBindings.name.text);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) names.add(element.name.text);
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text);
    }
  }
  return names;
}

function importInsertionOffset(sourceFile: ts.SourceFile): number {
  let insertion = 0;
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement))
      insertion = statement.end;
    else if (
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression) &&
      insertion === 0
    )
      insertion = statement.end;
    else if (insertion > 0) break;
  }
  return insertion;
}

function hasDependencyPath(index: ComponentIndex, from: string, to: string): boolean {
  if (from === to) return false;
  const edges = new Map<string, string[]>();
  for (const edge of index.importEdges) {
    if (edge.toFile)
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

function isStaticAttribute(attribute: ts.JsxAttribute): boolean {
  if (!attribute.initializer) return true;
  if (ts.isStringLiteral(attribute.initializer)) return true;
  return (
    ts.isJsxExpression(attribute.initializer) &&
    !!attribute.initializer.expression &&
    staticExpression(attribute.initializer.expression)
  );
}

function staticExpression(expression: ts.Expression): boolean {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return staticExpression(expression.expression);
  }
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    ts.isNumericLiteral(expression)
  )
    return true;
  if (
    [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
      expression.kind
    )
  )
    return true;
  if (ts.isPrefixUnaryExpression(expression)) return staticExpression(expression.operand);
  if (ts.isArrayLiteralExpression(expression))
    return expression.elements.every(
      (element) => ts.isExpression(element) && staticExpression(element)
    );
  if (ts.isObjectLiteralExpression(expression))
    return expression.properties.every(
      (property) => ts.isPropertyAssignment(property) && staticExpression(property.initializer)
    );
  return false;
}

function editExistingAttribute(
  file: SourceFileSnapshot,
  sourceFile: ts.SourceFile,
  attribute: ts.JsxAttribute,
  name: string,
  value: StaticValue
): ComponentTextEdit | null {
  if (!attribute.initializer) {
    if (value.kind === 'boolean' && value.value) return { start: 0, end: 0, text: '' };
    return {
      start: utf16OffsetToUtf8ByteOffset(file.content, attribute.getStart(sourceFile)),
      end: utf16OffsetToUtf8ByteOffset(file.content, attribute.end),
      text: jsxAttribute(name, value),
    };
  }
  if (value.kind === 'boolean' && value.value) {
    return {
      start: utf16OffsetToUtf8ByteOffset(file.content, attribute.getStart(sourceFile)),
      end: utf16OffsetToUtf8ByteOffset(file.content, attribute.end),
      text: name,
    };
  }
  if (ts.isStringLiteral(attribute.initializer)) {
    const quote = attribute.initializer.getText(sourceFile).startsWith("'") ? "'" : '"';
    const rendered =
      value.kind === 'string' ? staticValueToJsx(value, quote) : staticValueToJsx(value);
    return {
      start: utf16OffsetToUtf8ByteOffset(file.content, attribute.initializer.getStart(sourceFile)),
      end: utf16OffsetToUtf8ByteOffset(file.content, attribute.initializer.end),
      text: rendered,
    };
  }
  if (ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) {
    const rendered =
      value.kind === 'string'
        ? JSON.stringify(value.value)
        : staticValueToJsx(value).replace(/^\{|\}$/g, '');
    return {
      start: utf16OffsetToUtf8ByteOffset(
        file.content,
        attribute.initializer.expression.getStart(sourceFile)
      ),
      end: utf16OffsetToUtf8ByteOffset(file.content, attribute.initializer.expression.end),
      text: rendered,
    };
  }
  return null;
}

function removeAttribute(
  file: SourceFileSnapshot,
  sourceFile: ts.SourceFile,
  attribute: ts.JsxAttribute
): ComponentTextEdit {
  let start = attribute.getStart(sourceFile);
  const end = attribute.end;
  // Consume the separator before a same-line attribute so reset does not
  // leave a dangling double-space. Keep newlines intact for readable JSX.
  if (start > 0 && /[ \t]/.test(file.content[start - 1] ?? '')) start -= 1;
  return {
    start: utf16OffsetToUtf8ByteOffset(file.content, start),
    end: utf16OffsetToUtf8ByteOffset(file.content, end),
    text: '',
  };
}

function insertAttribute(
  file: SourceFileSnapshot,
  sourceFile: ts.SourceFile,
  opening: ts.JsxOpeningLikeElement,
  name: string,
  value: StaticValue
): ComponentTextEdit | null {
  const text = opening.getText(sourceFile);
  const closeOffset = text.endsWith('/>') ? opening.end - 2 : opening.end - 1;
  if (closeOffset < opening.getStart(sourceFile)) return null;
  return {
    start: utf16OffsetToUtf8ByteOffset(file.content, closeOffset),
    end: utf16OffsetToUtf8ByteOffset(file.content, closeOffset),
    text: ` ${jsxAttribute(name, value)}`,
  };
}

function findInvocationNode(
  sourceFile: ts.SourceFile,
  file: SourceFileSnapshot,
  instance: ComponentInstance
): ts.JsxElement | ts.JsxSelfClosingElement | null {
  const start = utf8ByteOffsetToUtf16Offset(file.content, instance.invocation.start);
  const end = utf8ByteOffsetToUtf16Offset(file.content, instance.invocation.end);
  if (start === null || end === null) return null;
  let found: ts.JsxElement | ts.JsxSelfClosingElement | null = null;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.getStart(sourceFile) === start &&
      node.end === end
    )
      found = node;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function plannedMutation(
  file: SourceFileSnapshot,
  edits: ComponentTextEdit[],
  descriptor: ComponentDescriptor,
  graphDelta: number,
  revision: string
): MutationResult {
  const sorted = mergeAdjacentInsertions(
    [...edits].sort((left, right) => left.start - right.start || left.end - right.end)
  );
  const result = applyTextEdits(file.content, sorted);
  if (result === null)
    return refuse('invalid-range', 'The planned source edits overlap or split a UTF-8 code point.');
  if (result === file.content)
    return refuse('no-op', 'The requested component change is already present in the source.');
  const mutation: ComponentFileMutation = {
    file: normalizeProjectPath(file.file),
    expectedHash: file.contentHash,
    expectedResultHash: sha256(result),
    edits: sorted,
  };
  const plan: ComponentMutationPlan = {
    files: [mutation],
    dialect: 'react',
    parserToken: REACT_COMPONENT_PLAN_PARSER_TOKEN,
    expectedRevision: revision,
    expectedGraphDelta: {
      componentId: descriptor.id,
      usagesBefore: descriptor.usageCount,
      usagesAfter: descriptor.usageCount + graphDelta,
      delta: graphDelta,
    },
  };
  return { status: 'planned', plan };
}

function mergeAdjacentInsertions(edits: ComponentTextEdit[]): ComponentTextEdit[] {
  const merged: ComponentTextEdit[] = [];
  for (const edit of edits) {
    const previous = merged[merged.length - 1];
    if (previous && previous.start === edit.start && previous.end === edit.end) {
      const importFirst = edit.text.startsWith('import ') && !previous.text.startsWith('import ');
      previous.text = importFirst ? `${edit.text}${previous.text}` : `${previous.text}${edit.text}`;
    } else {
      merged.push({ ...edit });
    }
  }
  return merged;
}

function findSnapshotFile(
  snapshot: ComponentSourceSnapshot,
  file: string
): SourceFileSnapshot | null {
  const normalized = normalizeProjectPath(file);
  return (
    snapshot.files.find((candidate) => normalizeProjectPath(candidate.file) === normalized) ?? null
  );
}

function createSourceFile(file: SourceFileSnapshot): ts.SourceFile {
  return ts.createSourceFile(
    file.file,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file.file)
  );
}

function scriptKind(file: string): ts.ScriptKind {
  const extension = extensionOf(file);
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.jsx') return ts.ScriptKind.JSX;
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function extension(file: string): string {
  return extensionOf(file);
}

function extensionOf(file: string): string {
  const dot = file.lastIndexOf('.');
  return dot < 0 ? '' : file.slice(dot).toLowerCase();
}

function refuse(
  code: Extract<MutationResult, { status: 'refused' }>['code'],
  message: string
): Extract<MutationResult, { status: 'refused' }> {
  return {
    status: 'refused',
    code,
    message,
    diagnostics: [{ code: `mutation-${code}`, severity: 'warning', message }],
  };
}
