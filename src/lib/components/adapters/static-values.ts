import ts from 'typescript';
import { sourceRefFromUtf16Range } from '../ranges';
import type {
  ComponentDiagnostic,
  DynamicExpression,
  SourceRef,
  SourceFileSnapshot,
  StaticExpression,
  StaticValue,
} from '../types';

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Convert a compiler expression only when it is losslessly static. */
export function staticValueFromExpression(expression: ts.Expression): StaticValue | null {
  const node = unwrapExpression(expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { kind: 'string', value: node.text };
  }
  if (ts.isNumericLiteral(node)) {
    const value = Number(node.text);
    return Number.isFinite(value) ? { kind: 'number', value } : null;
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'boolean', value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'boolean', value: false };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: 'null', value: null };
  if (ts.isPrefixUnaryExpression(node)) {
    if (node.operator !== ts.SyntaxKind.MinusToken && node.operator !== ts.SyntaxKind.PlusToken) {
      return null;
    }
    const operand = staticValueFromExpression(node.operand);
    if (!operand || operand.kind !== 'number') return null;
    return {
      kind: 'number',
      value: node.operator === ts.SyntaxKind.MinusToken ? -operand.value : operand.value,
    };
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values: StaticValue[] = [];
    for (const element of node.elements) {
      if (!ts.isExpression(element)) return null;
      const value = staticValueFromExpression(element);
      if (!value) return null;
      values.push(value);
    }
    return { kind: 'array', value: values };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const values: Record<string, StaticValue> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || !property.name) return null;
      const key = propertyNameText(property.name);
      const value = staticValueFromExpression(property.initializer);
      if (key === null || !value) return null;
      values[key] = value;
    }
    return { kind: 'object', value: values };
  }
  return null;
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

export function staticValueFromJsxAttribute(
  attribute: ts.JsxAttribute,
  _file: SourceFileSnapshot,
  _sourceFile: ts.SourceFile
): { value: StaticValue; valueNode: ts.Node | null } | null {
  if (!attribute.initializer) {
    return { value: { kind: 'boolean', value: true }, valueNode: attribute.name };
  }
  if (ts.isStringLiteral(attribute.initializer)) {
    return {
      value: { kind: 'string', value: attribute.initializer.text },
      valueNode: attribute.initializer,
    };
  }
  if (ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) {
    const value = staticValueFromExpression(attribute.initializer.expression);
    return value ? { value, valueNode: attribute.initializer.expression } : null;
  }
  return null;
}

export function sourceRefForNode(
  file: SourceFileSnapshot,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  full = false
): SourceRef {
  const start = full ? node.getFullStart() : node.getStart(sourceFile);
  return sourceRefFromUtf16Range(file.file, file.content, file.contentHash, start, node.end);
}

export function expressionSource(
  file: SourceFileSnapshot,
  sourceFile: ts.SourceFile,
  expression: ts.Expression
): StaticExpression | DynamicExpression {
  const source = sourceRefForNode(file, sourceFile, expression);
  const value = staticValueFromExpression(expression);
  if (value) return { kind: 'static', value, source };
  return {
    kind: 'dynamic',
    text: expression.getText(sourceFile),
    reason: dynamicExpressionReason(expression),
    source,
  };
}

export function dynamicExpressionReason(expression: ts.Expression): string {
  const node = unwrapExpression(expression);
  if (ts.isIdentifier(node)) return 'Identifier values are dynamic unless declared as a literal.';
  if (ts.isCallExpression(node)) return 'Function calls are dynamic.';
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return 'Member expressions are dynamic.';
  }
  if (ts.isConditionalExpression(node)) return 'Conditional expressions are dynamic.';
  if (ts.isSpreadElement(node)) return 'Spread values are dynamic.';
  return 'The expression cannot be proven static without executing project code.';
}

export function literalChoices(type: ts.TypeNode | undefined): StaticValue[] | null {
  if (!type) return null;
  const values: StaticValue[] = [];
  const members = ts.isUnionTypeNode(type) ? type.types : [type];
  for (const member of members) {
    const value = literalTypeValue(member);
    if (!value) return null;
    values.push(value);
  }
  return values.length > 0 ? values : null;
}

function literalTypeValue(type: ts.TypeNode): StaticValue | null {
  if (ts.isLiteralTypeNode(type)) {
    const literal = type.literal;
    if (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) {
      return { kind: 'string', value: literal.text };
    }
    if (ts.isNumericLiteral(literal)) return { kind: 'number', value: Number(literal.text) };
    if (literal.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'boolean', value: true };
    if (literal.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'boolean', value: false };
  }
  return null;
}

export function staticValueToJsx(value: StaticValue, quote = '"'): string {
  switch (value.kind) {
    case 'string': {
      const escaped = value.value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(new RegExp(quote === '"' ? '"' : "'", 'g'), quote === '"' ? '&quot;' : '&apos;');
      return `${quote}${escaped}${quote}`;
    }
    case 'number':
      return `{${String(value.value)}}`;
    case 'boolean':
      return value.value ? '' : '{false}';
    case 'null':
      return '{null}';
    case 'array':
      return `{[${value.value.map((item) => staticValueToExpression(item)).join(', ')}]}`;
    case 'object':
      return `{${JSON.stringify(staticObjectToPlain(value))}}`;
  }
}

function staticValueToExpression(value: StaticValue): string {
  switch (value.kind) {
    case 'string':
      return JSON.stringify(value.value);
    case 'number':
      return String(value.value);
    case 'boolean':
      return String(value.value);
    case 'null':
      return 'null';
    case 'array':
      return `[${value.value.map(staticValueToExpression).join(', ')}]`;
    case 'object':
      return `{${Object.entries(value.value)
        .map(([key, item]) => `${JSON.stringify(key)}: ${staticValueToExpression(item)}`)
        .join(', ')}}`;
  }
}

function staticObjectToPlain(value: Extract<StaticValue, { kind: 'object' }>): unknown {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value.value)) {
    result[key] = staticValueToPlain(item);
  }
  return result;
}

function staticValueToPlain(value: StaticValue): unknown {
  switch (value.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
      return value.value;
    case 'array':
      return value.value.map(staticValueToPlain);
    case 'object':
      return staticObjectToPlain(value);
  }
}

export function parsePropTypes(
  assignment: ts.Expression,
  file: SourceFileSnapshot,
  sourceFile: ts.SourceFile
): { name: string; source: SourceRef; required: boolean; typeText: string | null }[] {
  if (!ts.isObjectLiteralExpression(assignment)) return [];
  return assignment.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property) || !property.name) return [];
    const name = propertyNameText(property.name);
    if (!name) return [];
    const required = !ts.isCallExpression(property.initializer);
    return [
      {
        name,
        source: sourceRefForNode(file, sourceFile, property),
        required,
        typeText: property.initializer.getText(sourceFile),
      },
    ];
  });
}

export function parseDiagnosticsForSourceFile(
  sourceFile: ts.SourceFile,
  file: SourceFileSnapshot
): ComponentDiagnostic[] {
  const diagnostics =
    (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
      .parseDiagnostics ?? [];
  return diagnostics.map((diagnostic) => {
    const start = diagnostic.start ?? 0;
    const length = diagnostic.length ?? 0;
    return {
      code: `tsx-${diagnostic.code}`,
      severity: 'error',
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      file: file.file,
      source: sourceRefFromUtf16Range(
        file.file,
        file.content,
        file.contentHash,
        start,
        start + length
      ),
    };
  });
}
