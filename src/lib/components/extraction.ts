import ts from 'typescript';
import {
  applyTextEdits,
  sha256,
  utf16OffsetToUtf8ByteOffset,
  utf8ByteOffsetToUtf16Offset,
} from './ranges';
import {
  basenameWithoutExtension,
  isPascalCase,
  normalizeProjectPath,
} from './adapters/react-helpers';
import type {
  ComponentDescriptor,
  ComponentExtractionFilePreview,
  ComponentExtractionPlan,
  ComponentExtractionPreview,
  ComponentExtractionProposal,
  ComponentFileOperation,
  ComponentIndex,
  ComponentSourceSnapshot,
  ComponentExtractionInput,
  ExtractComponentInput,
  ExtractionResult,
  InlineSimpleComponentInput,
  SourceFileSnapshot,
  SourceRef,
} from './types';

const REACT_SOURCE_EXTENSIONS = new Set(['.tsx', '.jsx']);
const RESERVED_NAMES = new Set([
  'Component',
  'Fragment',
  'React',
  'Suspense',
  'StrictMode',
  'Profiler',
]);
const BUILTIN_NAMES = new Set([
  'Array',
  'Boolean',
  'Date',
  'Error',
  'JSON',
  'Math',
  'Number',
  'Object',
  'Promise',
  'RegExp',
  'String',
  'Symbol',
  'BigInt',
  'Intl',
  'undefined',
  'NaN',
  'Infinity',
  'console',
  'document',
  'window',
]);

interface ImportBinding {
  localNames: Set<string>;
  statement: string;
  source: string;
  typeOnly: boolean;
}

interface AnalyzedSelection {
  file: SourceFileSnapshot;
  sourceFile: ts.SourceFile;
  node: ts.JsxElement | ts.JsxSelfClosingElement;
  containingComponent: ComponentDescriptor;
  freeNames: string[];
  imports: ImportBinding[];
  propTypes: Map<string, string>;
  clientBoundary: boolean;
}

function extractionRefusal(
  code: Extract<ExtractionResult, { status: 'refused' }>['code'],
  message: string,
  source?: SourceRef
): Extract<ExtractionResult, { status: 'refused' }> {
  return {
    status: 'refused',
    code,
    message,
    diagnostics: [
      {
        code: `component-extraction-${code}`,
        severity: 'warning',
        message,
        ...(source ? { source } : {}),
      },
    ],
  };
}

function sourceFileFor(
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

function createSourceFile(file: SourceFileSnapshot): ts.SourceFile {
  return ts.createSourceFile(
    file.file,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    file.file.toLowerCase().endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JSX
  );
}

function sourceRange(source: SourceRef, content: string): { start: number; end: number } | null {
  const start = utf8ByteOffsetToUtf16Offset(content, source.start);
  const end = utf8ByteOffsetToUtf16Offset(content, source.end);
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

function exactJsxNode(
  sourceFile: ts.SourceFile,
  range: { start: number; end: number }
): ts.JsxElement | ts.JsxSelfClosingElement | null {
  let found: ts.JsxElement | ts.JsxSelfClosingElement | null = null;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.getStart(sourceFile) === range.start &&
      node.end === range.end
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function exactNodeAtRange(
  sourceFile: ts.SourceFile,
  range: { start: number; end: number }
): ts.Node | null {
  let found: ts.Node | null = null;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (node.getStart(sourceFile) === range.start && node.end === range.end) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function functionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function containingFunction(node: ts.Node): ts.Node | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (functionLike(current)) return current;
    current = current.parent;
  }
  return null;
}

function isUnsafeControlFlow(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  const unsafe = (candidate: ts.Node): boolean => {
    if (
      ts.isForStatement(candidate) ||
      ts.isForInStatement(candidate) ||
      ts.isForOfStatement(candidate) ||
      ts.isWhileStatement(candidate) ||
      ts.isDoStatement(candidate) ||
      ts.isIfStatement(candidate) ||
      ts.isSwitchStatement(candidate) ||
      ts.isTryStatement(candidate) ||
      ts.isCatchClause(candidate) ||
      ts.isConditionalExpression(candidate) ||
      ts.isArrowFunction(candidate) ||
      ts.isFunctionExpression(candidate)
    ) {
      return true;
    }
    if (ts.isBinaryExpression(candidate)) {
      return (
        candidate.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        candidate.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        candidate.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      );
    }
    if (
      ts.isCallExpression(candidate) &&
      candidate.arguments.some(
        (argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
      )
    ) {
      return true;
    }
    if (ts.isJsxSpreadAttribute(candidate)) {
      return true;
    }
    return false;
  };

  let current: ts.Node | undefined = node.parent;
  while (current && !functionLike(current)) {
    if (unsafe(current)) return true;
    current = current.parent;
  }
  if (
    current &&
    (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
    ts.isCallExpression(current.parent) &&
    current.parent.arguments.some((argument) => argument === current)
  ) {
    return true;
  }
  let descendantUnsafe = false;
  const visit = (candidate: ts.Node) => {
    if (descendantUnsafe) return;
    if (candidate !== node && unsafe(candidate)) {
      descendantUnsafe = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  // A source file is consulted here so the guard stays explicit when this
  // routine is used from a future parser-backed adapter; it is not used to
  // infer any project runtime state.
  void sourceFile;
  return descendantUnsafe;
}

function importBindings(sourceFile: ts.SourceFile): ImportBinding[] {
  return sourceFile.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      return [];
    }
    const clause = statement.importClause;
    const localNames = new Set<string>();
    if (clause?.name) localNames.add(clause.name.text);
    if (clause?.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings))
        localNames.add(clause.namedBindings.name.text);
      else {
        for (const element of clause.namedBindings.elements) localNames.add(element.name.text);
      }
    }
    return [
      {
        localNames,
        statement: statement.getText(sourceFile),
        source: statement.moduleSpecifier.text,
        typeOnly: clause?.isTypeOnly ?? false,
      },
    ];
  });
}

function isJsxTagOrAttributeName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isJsxAttribute(parent) && parent.name === node) return true;
  if (ts.isJsxOpeningElement(parent) && parent.tagName === node) return true;
  if (ts.isJsxClosingElement(parent) && parent.tagName === node) return true;
  if (ts.isJsxSelfClosingElement(parent) && parent.tagName === node) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  return false;
}

function isJsxTagName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isJsxOpeningElement(parent) && parent.tagName === node) ||
    (ts.isJsxClosingElement(parent) && parent.tagName === node) ||
    (ts.isJsxSelfClosingElement(parent) && parent.tagName === node)
  );
}

function bindingNames(node: ts.BindingName): string[] {
  if (ts.isIdentifier(node)) return [node.text];
  return node.elements.flatMap((element) => {
    if (ts.isOmittedExpression(element)) return [];
    return bindingNames(element.name);
  });
}

function namesDeclaredInside(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (candidate: ts.Node) => {
    if (candidate !== node) {
      if (ts.isVariableDeclaration(candidate))
        bindingNames(candidate.name).forEach((name) => names.add(name));
      if (ts.isParameter(candidate))
        bindingNames(candidate.name).forEach((name) => names.add(name));
      if (ts.isFunctionDeclaration(candidate) && candidate.name) names.add(candidate.name.text);
      if (ts.isClassDeclaration(candidate) && candidate.name) names.add(candidate.name.text);
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return names;
}

function collectReferencedNames(node: ts.Node): string[] {
  const declared = namesDeclaredInside(node);
  const names = new Set<string>();
  const visit = (candidate: ts.Node) => {
    if (ts.isIdentifier(candidate)) {
      if (isJsxTagName(candidate)) {
        if (/^[A-Z]/.test(candidate.text) && !declared.has(candidate.text)) {
          names.add(candidate.text);
        }
      } else if (!isJsxTagOrAttributeName(candidate) && !declared.has(candidate.text)) {
        names.add(candidate.text);
      }
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return [...names].filter((name) => !BUILTIN_NAMES.has(name)).sort();
}

function inferTypeFromInitializer(initializer: ts.Expression | undefined): string | null {
  if (!initializer) return null;
  if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer))
    return 'string';
  if (ts.isNumericLiteral(initializer)) return 'number';
  if (
    initializer.kind === ts.SyntaxKind.TrueKeyword ||
    initializer.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return 'boolean';
  }
  if (ts.isArrayLiteralExpression(initializer)) return 'readonly unknown[]';
  return null;
}

function inferredPropTypes(
  sourceFile: ts.SourceFile,
  names: readonly string[]
): Map<string, string> {
  const result = new Map<string, string>();
  const wanted = new Set(names);
  const visit = (node: ts.Node) => {
    if (ts.isParameter(node)) {
      if (ts.isIdentifier(node.name) && wanted.has(node.name.text)) {
        result.set(node.name.text, node.type?.getText(sourceFile) ?? 'any');
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
          if (wanted.has(element.name.text)) {
            const propertyName = element.propertyName?.getText(sourceFile) ?? element.name.text;
            const type =
              node.type && ts.isTypeLiteralNode(node.type)
                ? node.type.members.find((member) => {
                    const name = member.name;
                    return !!name && ts.isIdentifier(name) && name.text === propertyName;
                  })
                : null;
            result.set(
              element.name.text,
              type && ts.isPropertySignature(type)
                ? (type.type?.getText(sourceFile) ?? 'any')
                : 'any'
            );
          }
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      wanted.has(node.name.text)
    ) {
      result.set(
        node.name.text,
        node.type?.getText(sourceFile) ?? inferTypeFromInitializer(node.initializer) ?? 'any'
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

function hasUseClientDirective(sourceFile: ts.SourceFile): boolean {
  const first = sourceFile.statements[0];
  return (
    !!first &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === 'use client'
  );
}

function sourceRefInside(container: SourceRef, source: SourceRef): boolean {
  return (
    normalizeProjectPath(container.file) === normalizeProjectPath(source.file) &&
    container.contentHash === source.contentHash &&
    source.start >= container.start &&
    source.end <= container.end
  );
}

function findContainingComponent(
  index: ComponentIndex,
  source: SourceRef
): ComponentDescriptor | null {
  return (
    index.components
      .filter((component) => sourceRefInside(component.definition, source))
      .sort(
        (left, right) =>
          left.definition.end -
          left.definition.start -
          (right.definition.end - right.definition.start)
      )[0] ?? null
  );
}

function analyzeSelection(
  input: ExtractComponentInput,
  index: ComponentIndex,
  snapshot: ComponentSourceSnapshot
): ExtractionResult | AnalyzedSelection {
  if (snapshot.partial || index.partial) {
    return extractionRefusal(
      'partial-snapshot',
      'The source graph is partial, so extraction is disabled until the catalog is complete.',
      input.source
    );
  }
  const file = sourceFileFor(snapshot, input.source);
  if (!file) {
    return extractionRefusal(
      'stale-source',
      'The selected source range is stale. Refresh the component catalog and select it again.',
      input.source
    );
  }
  const extension = `.${file.file.split('.').pop()?.toLowerCase() ?? ''}`;
  if (!REACT_SOURCE_EXTENSIONS.has(extension)) {
    return extractionRefusal(
      'unsupported',
      'Component extraction currently requires an exact TSX or JSX source selection.',
      input.source
    );
  }
  const range = sourceRange(input.source, file.content);
  if (!range) {
    return extractionRefusal(
      'invalid-range',
      'The selected source range is not valid UTF-8.',
      input.source
    );
  }
  const sourceFile = createSourceFile(file);
  const node = exactJsxNode(sourceFile, range);
  if (!node) {
    return extractionRefusal(
      'invalid-range',
      'The selection does not cover exactly one JSX element. Select one complete element and try again.',
      input.source
    );
  }
  if (!containingFunction(node)) {
    return extractionRefusal(
      'dynamic-scope',
      'The selected JSX is not inside a component function, so its scope cannot be preserved safely.',
      input.source
    );
  }
  if (isUnsafeControlFlow(node, sourceFile)) {
    return extractionRefusal(
      'dynamic-scope',
      'Selections inside conditionals, loops, callbacks, or dynamic JSX scopes are not extractable yet.',
      input.source
    );
  }
  const containingComponent = findContainingComponent(index, input.source);
  if (!containingComponent) {
    return extractionRefusal(
      'unsupported',
      'The selected JSX is not inside an indexed React component definition.',
      input.source
    );
  }
  const references = collectReferencedNames(node);
  const imports = importBindings(sourceFile);
  const importedNames = new Set(imports.flatMap((item) => [...item.localNames]));
  const freeNames = references.filter((name) => !importedNames.has(name));
  const selectedImports = imports.filter(
    (item) => !item.typeOnly && [...item.localNames].some((name) => references.includes(name))
  );
  return {
    file,
    sourceFile,
    node,
    containingComponent,
    freeNames,
    imports: selectedImports,
    propTypes: inferredPropTypes(sourceFile, freeNames),
    clientBoundary: hasUseClientDirective(sourceFile),
  };
}

function validateNameAndDestination(
  input: ExtractComponentInput,
  analyzed: AnalyzedSelection,
  snapshot: ComponentSourceSnapshot
): ExtractedValidation | ExtractedValidationError {
  const name = input.componentName.trim();
  if (!isPascalCase(name) || RESERVED_NAMES.has(name)) {
    return {
      code: 'invalid-name',
      message: 'The extracted component name must be a new PascalCase JSX identifier.',
    };
  }
  const destination = normalizeProjectPath(input.destinationFile);
  if (destination === '.' || destination !== input.destinationFile.replace(/^\.\//, '')) {
    return {
      code: 'invalid-range',
      message: 'The extraction destination must be a normalized project-relative path.',
    };
  }
  const extension = `.${analyzed.file.file.split('.').pop()?.toLowerCase() ?? ''}`;
  if (!destination.endsWith(extension) || basenameWithoutExtension(destination) !== name) {
    return {
      code: 'invalid-name',
      message: `The destination filename must be ${name}${extension}.`,
    };
  }
  const sourceDirectory = normalizeProjectPath(analyzed.file.file)
    .split('/')
    .slice(0, -1)
    .join('/');
  const destinationDirectory = destination.split('/').slice(0, -1).join('/');
  if (sourceDirectory !== destinationDirectory) {
    return {
      code: 'unsupported',
      message:
        'The first extraction keeps relative imports safe by creating the new file beside the selected source.',
    };
  }
  if (snapshot.files.some((file) => normalizeProjectPath(file.file) === destination)) {
    return {
      code: 'path-collision',
      message: `The extraction destination ${destination} already exists.`,
    };
  }
  if (
    analyzed.freeNames.includes(name) ||
    analyzed.imports.some((item) => item.localNames.has(name))
  ) {
    return {
      code: 'symbol-collision',
      message: `The extracted component name ${name} conflicts with a selected dependency.`,
    };
  }
  return { name, destination };
}

type ExtractedValidation = { name: string; destination: string };
type ExtractedValidationError = {
  code: Extract<ExtractionResult, { status: 'refused' }>['code'];
  message: string;
};

function proposalFor(
  input: ExtractComponentInput,
  analyzed: AnalyzedSelection,
  validated: ExtractedValidation
): ComponentExtractionProposal {
  return {
    operation: 'extract',
    componentName: validated.name,
    destinationFile: validated.destination,
    source: input.source,
    proposedPropNames: analyzed.freeNames,
    preservedImports: analyzed.imports.map((item) => item.source).sort(),
    diagnostics: analyzed.freeNames.map((name) => ({
      code: 'component-extraction-prop-approval',
      severity: 'info' as const,
      message: `The free variable ${name} must be approved as an extracted prop.`,
      source: input.source,
    })),
  };
}

function renderPropsType(
  name: string,
  props: readonly string[],
  types: ReadonlyMap<string, string>,
  extension: string
): string {
  if (props.length === 0 || extension === '.jsx') return '';
  const lines = props.map((prop) => `  ${prop}: ${types.get(prop) ?? 'any'};`);
  return [
    '/* eslint-disable @typescript-eslint/no-explicit-any -- extracted boundary keeps untyped caller values lossless. */',
    `export type ${name}Props = {`,
    ...lines,
    '};',
    '',
  ].join('\n');
}

function renderExtractedFile(
  analyzed: AnalyzedSelection,
  name: string,
  props: readonly string[]
): string {
  const extension = `.${analyzed.file.file.split('.').pop()?.toLowerCase() ?? ''}`;
  const importText = analyzed.imports.map((item) => item.statement).join('\n');
  const directive = analyzed.clientBoundary
    ? (analyzed.sourceFile.statements[0]?.getText(analyzed.sourceFile) ?? "'use client';")
    : '';
  const prefix = [
    directive,
    importText,
    renderPropsType(name, props, analyzed.propTypes, extension),
  ]
    .filter(Boolean)
    .join('\n');
  const signature =
    props.length === 0
      ? `export function ${name}()`
      : extension === '.tsx'
        ? `export function ${name}({ ${props.join(', ')} }: ${name}Props)`
        : `export function ${name}({ ${props.join(', ')} })`;
  const selectedText = analyzed.file.content.slice(
    analyzed.node.getStart(analyzed.sourceFile),
    analyzed.node.end
  );
  return `${prefix ? `${prefix}\n` : ''}${signature} {\n  return (\n${selectedText}\n  );\n}\n`;
}

function importInsertionOffset(sourceFile: ts.SourceFile): number {
  let offset = 0;
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      offset = statement.end;
      continue;
    }
    if (
      offset === 0 &&
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression)
    ) {
      offset = statement.end;
      continue;
    }
    if (offset > 0) break;
  }
  return offset;
}

function relativeImport(fromFile: string, toFile: string): string {
  const from = normalizeProjectPath(fromFile).split('/');
  from.pop();
  const target = normalizeProjectPath(toFile).split('/');
  while (from.length && target.length && from[0] === target[0]) {
    from.shift();
    target.shift();
  }
  const withoutExtension = target.join('/').replace(/\.(?:tsx|jsx)$/i, '');
  const result = `${'../'.repeat(from.length)}${withoutExtension}`;
  return result.startsWith('.') ? result : `./${result}`;
}

function componentPreviewFile(
  file: string,
  operation: ComponentFileOperation['kind'],
  before: string | null,
  after: string | null
): ComponentExtractionFilePreview {
  return {
    file,
    operation,
    beforeHash: before === null ? null : sha256(before),
    afterHash: after === null ? null : sha256(after),
    ...(before === null ? {} : { before }),
    ...(after === null ? {} : { after }),
  };
}

function planExtraction(
  input: ExtractComponentInput,
  analyzed: AnalyzedSelection,
  validated: ExtractedValidation,
  snapshot: ComponentSourceSnapshot,
  approvedPropNames: string[]
): ExtractionResult {
  const proposed = analyzed.freeNames;
  const approved = [...new Set(approvedPropNames)].sort();
  if (
    approved.length !== proposed.length ||
    approved.some((name, index) => name !== proposed[index])
  ) {
    return extractionRefusal(
      'missing-prop-approval',
      `Approve every proposed prop exactly once before extraction: ${proposed.join(', ') || 'none'}.`,
      input.source
    );
  }
  const extracted = renderExtractedFile(analyzed, validated.name, approved);
  const target = analyzed.file;
  const invocation = `<${validated.name}${approved.map((name) => ` ${name}={${name}}`).join('')} />`;
  const sourceStart = utf16OffsetToUtf8ByteOffset(
    target.content,
    analyzed.node.getStart(analyzed.sourceFile)
  );
  const sourceEnd = utf16OffsetToUtf8ByteOffset(target.content, analyzed.node.end);
  const importAt = importInsertionOffset(analyzed.sourceFile);
  const newline = target.content.includes('\r\n') ? '\r\n' : '\n';
  const edits = [
    {
      start: sourceStart,
      end: sourceEnd,
      text: invocation,
    },
    {
      start: utf16OffsetToUtf8ByteOffset(target.content, importAt),
      end: utf16OffsetToUtf8ByteOffset(target.content, importAt),
      text: `${newline}import { ${validated.name} } from '${relativeImport(target.file, validated.destination)}';`,
    },
  ].sort((left, right) => left.start - right.start || left.end - right.end);
  const after = applyTextEdits(target.content, edits);
  if (after === null || after === target.content) {
    return extractionRefusal(
      'invalid-range',
      'The extraction source edits overlap or are no longer valid.',
      input.source
    );
  }
  const parsedAfter = createSourceFile({ ...target, content: after, contentHash: sha256(after) });
  const parseDiagnostics =
    (parsedAfter as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
      .parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    return extractionRefusal(
      'syntax-error',
      'The proposed extraction would create invalid JSX/TypeScript.',
      input.source
    );
  }
  const parsedExtracted = createSourceFile({
    file: validated.destination,
    content: extracted,
    contentHash: sha256(extracted),
  });
  const extractedDiagnostics =
    (parsedExtracted as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
      .parseDiagnostics ?? [];
  if (extractedDiagnostics.length > 0) {
    return extractionRefusal(
      'syntax-error',
      'The extracted component source is not valid JSX/TypeScript.',
      input.source
    );
  }
  const original = analyzed.containingComponent;
  const graphDelta = {
    componentId: original.id,
    usagesBefore: original.usageCount,
    usagesAfter: original.usageCount,
    delta: 0,
    createdComponentId: `react:${validated.destination}#${validated.name}`,
    createdUsages: 1,
  };
  const editMutation = {
    kind: 'edit' as const,
    file: target.file,
    expectedHash: target.contentHash,
    expectedResultHash: sha256(after),
    edits,
  };
  const createOperation = {
    kind: 'create' as const,
    file: validated.destination,
    expectedAbsent: true as const,
    contents: extracted,
    expectedResultHash: sha256(extracted),
  };
  const preview: ComponentExtractionPreview = {
    operation: 'extract',
    componentName: validated.name,
    destinationFile: validated.destination,
    proposedPropNames: proposed,
    preservedImports: analyzed.imports.map((item) => item.source).sort(),
    affectedFiles: [target.file, validated.destination].sort(),
    files: [
      componentPreviewFile(target.file, 'edit', target.content, after),
      componentPreviewFile(validated.destination, 'create', null, extracted),
    ].sort((left, right) => left.file.localeCompare(right.file)),
    graphDelta,
  };
  const plan: ComponentExtractionPlan = {
    files: [],
    operations: [editMutation, createOperation],
    dialect: 'react',
    parserToken: 'react-component-plan-v1',
    expectedRevision: snapshot.revision,
    expectedGraphDelta: graphDelta,
    operation: 'extract',
    preview,
  };
  return { status: 'planned', plan };
}

function staticInlineJsx(node: ts.Node): boolean {
  if (ts.isJsxText(node)) return true;
  if (ts.isJsxExpression(node)) {
    const expression = node.expression;
    return (
      !expression ||
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression) ||
      ts.isNumericLiteral(expression) ||
      expression.kind === ts.SyntaxKind.TrueKeyword ||
      expression.kind === ts.SyntaxKind.FalseKeyword ||
      expression.kind === ts.SyntaxKind.NullKeyword
    );
  }
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
    const opening = ts.isJsxElement(node) ? node.openingElement : node;
    if (!ts.isIdentifier(opening.tagName) || !/^[a-z]/.test(opening.tagName.text)) return false;
    for (const attribute of opening.attributes.properties) {
      if (!ts.isJsxAttribute(attribute)) return false;
      if (attribute.initializer === undefined || ts.isStringLiteral(attribute.initializer))
        continue;
      if (
        ts.isJsxExpression(attribute.initializer) &&
        attribute.initializer.expression &&
        (ts.isStringLiteral(attribute.initializer.expression) ||
          ts.isNoSubstitutionTemplateLiteral(attribute.initializer.expression) ||
          ts.isNumericLiteral(attribute.initializer.expression) ||
          attribute.initializer.expression.kind === ts.SyntaxKind.TrueKeyword ||
          attribute.initializer.expression.kind === ts.SyntaxKind.FalseKeyword ||
          attribute.initializer.expression.kind === ts.SyntaxKind.NullKeyword)
      ) {
        continue;
      }
      return false;
    }
    return ts.isJsxSelfClosingElement(node) || node.children.every(staticInlineJsx);
  }
  return false;
}

function returnedStaticJsx(definition: ts.Node): ts.JsxElement | ts.JsxSelfClosingElement | null {
  let functionLike: ts.FunctionLikeDeclaration | null = null;
  if (
    ts.isFunctionDeclaration(definition) ||
    ts.isFunctionExpression(definition) ||
    ts.isArrowFunction(definition)
  ) {
    functionLike = definition;
  } else if (ts.isVariableDeclaration(definition) && definition.initializer) {
    let initializer: ts.Expression = definition.initializer;
    while (
      ts.isCallExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      (initializer.expression.text === 'memo' || initializer.expression.text === 'forwardRef') &&
      initializer.arguments.length === 1
    ) {
      initializer = initializer.arguments[0];
    }
    if (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer)) {
      functionLike = initializer;
    }
  }
  if (!functionLike || functionLike.parameters.length > 0) return null;
  const body = functionLike.body;
  if (!body) return null;
  if (ts.isJsxElement(body) || ts.isJsxSelfClosingElement(body)) {
    return staticInlineJsx(body) ? body : null;
  }
  if (!ts.isBlock(body) || body.statements.length !== 1) return null;
  const statement = body.statements[0];
  if (!ts.isReturnStatement(statement) || !statement.expression) return null;
  const returned = statement.expression;
  if (!ts.isJsxElement(returned) && !ts.isJsxSelfClosingElement(returned)) return null;
  return staticInlineJsx(returned) ? returned : null;
}

function planInlineSimpleComponent(
  input: InlineSimpleComponentInput,
  index: ComponentIndex,
  snapshot: ComponentSourceSnapshot
): ExtractionResult {
  if (snapshot.partial || index.partial) {
    return extractionRefusal(
      'partial-snapshot',
      'The source graph is partial, so inlining is disabled until the catalog is complete.'
    );
  }
  const instance = index.instances.find((candidate) => candidate.id === input.instanceId);
  const component = index.components.find((candidate) => candidate.id === instance?.componentId);
  if (!instance || !component) {
    return extractionRefusal('missing-source', 'The component instance is no longer indexed.');
  }
  if (component.dialect !== 'react' || !component.capabilities.extract) {
    return extractionRefusal(
      'unsupported',
      'Inline simple component is currently supported only for proven React definitions.',
      instance.invocation
    );
  }
  if (component.props.length > 0 || component.slots.length > 0) {
    return extractionRefusal(
      'dynamic-expression',
      'A component with props or slots cannot be inlined without changing its boundary semantics.',
      instance.invocation
    );
  }
  if (
    normalizeProjectPath(component.definition.file) !==
    normalizeProjectPath(instance.invocation.file)
  ) {
    return extractionRefusal(
      'unsupported',
      'Inline simple component is limited to a local definition and invocation in the same source file.',
      instance.invocation
    );
  }
  const file = sourceFileFor(snapshot, instance.invocation);
  const definitionFile = sourceFileFor(snapshot, component.definition);
  if (!file || !definitionFile) {
    return extractionRefusal(
      'stale-source',
      'The component source changed after the catalog was built.',
      instance.invocation
    );
  }
  const invocationRange = sourceRange(instance.invocation, file.content);
  const definitionRange = sourceRange(component.definition, definitionFile.content);
  if (!invocationRange || !definitionRange) {
    return extractionRefusal(
      'invalid-range',
      'The component source range is no longer valid.',
      instance.invocation
    );
  }
  const sourceFile = createSourceFile(file);
  const definitionSourceFile = createSourceFile(definitionFile);
  const invocationNode = exactJsxNode(sourceFile, invocationRange);
  const definitionNode = exactNodeAtRange(definitionSourceFile, definitionRange);
  if (!invocationNode || !definitionNode) {
    return extractionRefusal(
      'invalid-range',
      'The exact component invocation or definition could not be recovered.',
      instance.invocation
    );
  }
  const returned = returnedStaticJsx(definitionNode);
  if (!returned) {
    return extractionRefusal(
      'dynamic-expression',
      'Only a local, parameterless component with one static intrinsic JSX root can be inlined.',
      component.definition
    );
  }
  const replacement = returned.getText(definitionSourceFile);
  const start = utf16OffsetToUtf8ByteOffset(file.content, invocationNode.getStart(sourceFile));
  const end = utf16OffsetToUtf8ByteOffset(file.content, invocationNode.end);
  const after = applyTextEdits(file.content, [{ start, end, text: replacement }]);
  if (after === null || after === file.content) {
    return extractionRefusal(
      'invalid-range',
      'The inline source edit is no longer valid.',
      instance.invocation
    );
  }
  const parsedAfter = createSourceFile({ ...file, content: after, contentHash: sha256(after) });
  const parseDiagnostics =
    (parsedAfter as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
      .parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    return extractionRefusal(
      'syntax-error',
      'The inline transform would create invalid JSX/TypeScript.',
      instance.invocation
    );
  }
  const graphDelta = {
    componentId: component.id,
    usagesBefore: component.usageCount,
    usagesAfter: Math.max(0, component.usageCount - 1),
    delta: -1,
  };
  const mutation: ComponentFileOperation & { kind: 'edit' } = {
    kind: 'edit',
    file: file.file,
    expectedHash: file.contentHash,
    expectedResultHash: sha256(after),
    edits: [{ start, end, text: replacement }],
  };
  const preview: ComponentExtractionPreview = {
    operation: 'inline',
    componentName: component.name,
    destinationFile: component.definition.file,
    proposedPropNames: [],
    preservedImports: [],
    affectedFiles: [file.file],
    files: [componentPreviewFile(file.file, 'edit', file.content, after)],
    graphDelta,
  };
  return {
    status: 'planned',
    plan: {
      files: [mutation],
      dialect: 'react',
      parserToken: 'react-component-plan-v1',
      expectedRevision: snapshot.revision,
      expectedGraphDelta: graphDelta,
      operation: 'inline',
      preview,
    },
  };
}

/**
 * Plan a lossless React extraction in two rounds. The first round returns the
 * exact free-variable/import proposal; the second must repeat that proposal as
 * an explicit approval before any source operation is emitted.
 */
export function planExtractComponent(
  input: ComponentExtractionInput,
  index: ComponentIndex,
  suppliedSnapshot?: ComponentSourceSnapshot
): ExtractionResult {
  const snapshot = suppliedSnapshot ?? input.snapshot;
  if (!snapshot)
    return extractionRefusal('missing-source', 'A source snapshot is required for extraction.');
  if (input.kind === 'inline') return planInlineSimpleComponent(input, index, snapshot);
  const analyzed = analyzeSelection(input, index, snapshot);
  if ('status' in analyzed) return analyzed;
  const validated = validateNameAndDestination(input, analyzed, snapshot);
  if ('code' in validated)
    return extractionRefusal(validated.code, validated.message, input.source);
  const proposal = proposalFor(input, analyzed, validated);
  if (input.approvedPropNames === undefined) return { status: 'needs-approval', proposal };
  return planExtraction(input, analyzed, validated, snapshot, input.approvedPropNames);
}
