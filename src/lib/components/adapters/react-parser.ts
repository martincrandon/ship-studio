import ts from 'typescript';
import {
  basenameWithoutExtension,
  componentCapabilities,
  componentKindForFile,
  isNonPlaceableComponent,
  isPascalCase,
  isStaticAssetProp,
  jsxRootIdentifier,
  jsxTagText,
  normalizeProjectPath,
} from './react-helpers';
import {
  dynamicExpressionReason,
  literalChoices,
  parseDiagnosticsForSourceFile,
  sourceRefForNode,
  staticValueFromExpression,
  staticValueFromJsxAttribute,
} from './static-values';
import type {
  ParsedComponentDefinition,
  ParsedComponentFile,
  RawImportEdge,
  RawJsxAttribute,
  RawJsxUsage,
} from './types';
import type {
  ComponentPropDescriptor,
  ComponentRenderRoot,
  ComponentSlotDescriptor,
  SourceFileSnapshot,
  StaticValue,
} from '../types';

export function parseReactFile(
  file: SourceFileSnapshot,
  _knownFiles: readonly SourceFileSnapshot[] = []
): ParsedComponentFile {
  const sourceFile = ts.createSourceFile(
    file.file,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(file.file)
  );
  const diagnostics = parseDiagnosticsForSourceFile(sourceFile, file);
  const imports = collectImports(sourceFile, file);
  const { candidates, exportNames, reExports } = collectComponentCandidates(sourceFile, file);
  const components = candidates
    .filter((candidate) => candidate.exportName !== null || candidate.isDefault)
    .map((candidate) => createDefinition(candidate, sourceFile, file));
  const usages = collectUsages(sourceFile, file, candidates);
  return {
    snapshot: file,
    sourceFile,
    components,
    imports,
    usages,
    exports: exportNames,
    reExports,
    diagnostics,
  };
}

interface Candidate {
  localName: string;
  exportName: string | null;
  declaration: ts.Node;
  initializer?: ts.Expression;
  isDefault: boolean;
}

function scriptKindForPath(file: string): ts.ScriptKind {
  const lower = file.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs'))
    return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function collectComponentCandidates(
  sourceFile: ts.SourceFile,
  file: SourceFileSnapshot
): { candidates: Candidate[]; exportNames: Map<string, string>; reExports: RawImportEdge[] } {
  const candidates: Candidate[] = [];
  const byLocal = new Map<string, Candidate>();
  const exportNames = new Map<string, string>();
  const reExports: RawImportEdge[] = [];
  const add = (candidate: Candidate) => {
    const existing = byLocal.get(candidate.localName);
    if (existing) {
      if (candidate.exportName && !existing.exportName) existing.exportName = candidate.exportName;
      existing.isDefault ||= candidate.isDefault;
      return existing;
    }
    byLocal.set(candidate.localName, candidate);
    candidates.push(candidate);
    return candidate;
  };

  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      isPascalCase(statement.name.text)
    ) {
      if (containsJsx(statement)) {
        const exported = exportModifier(statement, 'default') ?? exportModifier(statement, 'named');
        add({
          localName: statement.name.text,
          exportName:
            exported === 'default' ? 'default' : exported === 'named' ? statement.name.text : null,
          declaration: statement,
          isDefault: exported === 'default',
        });
      }
    } else if (
      ts.isClassDeclaration(statement) &&
      statement.name &&
      isPascalCase(statement.name.text)
    ) {
      if (isReactClass(statement)) {
        const exported = exportModifier(statement, 'default') ?? exportModifier(statement, 'named');
        add({
          localName: statement.name.text,
          exportName:
            exported === 'default' ? 'default' : exported === 'named' ? statement.name.text : null,
          declaration: statement,
          isDefault: exported === 'default',
        });
      }
    } else if (ts.isVariableStatement(statement)) {
      const exported = exportModifier(statement, 'named');
      for (const declaration of statement.declarationList.declarations) {
        if (
          !ts.isIdentifier(declaration.name) ||
          !isPascalCase(declaration.name.text) ||
          !declaration.initializer
        ) {
          continue;
        }
        if (!isComponentInitializer(declaration.initializer)) continue;
        add({
          localName: declaration.name.text,
          exportName: exported === 'named' ? declaration.name.text : null,
          declaration,
          initializer: declaration.initializer,
          isDefault: false,
        });
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      if (ts.isIdentifier(statement.expression)) {
        const candidate = byLocal.get(statement.expression.text);
        if (candidate) {
          candidate.exportName = 'default';
          candidate.isDefault = true;
        } else if (isPascalCase(statement.expression.text)) {
          exportNames.set('default', statement.expression.text);
        }
      } else if (
        (ts.isFunctionExpression(statement.expression) ||
          ts.isArrowFunction(statement.expression)) &&
        containsJsx(statement.expression)
      ) {
        const localName = basenameWithoutExtension(file.file);
        add({
          localName,
          exportName: 'default',
          declaration: statement.expression,
          initializer: statement.expression,
          isDefault: true,
        });
      } else if (ts.isClassExpression(statement.expression) && isReactClass(statement.expression)) {
        const localName = basenameWithoutExtension(file.file);
        add({
          localName,
          exportName: 'default',
          declaration: statement.expression,
          initializer: statement.expression,
          isDefault: true,
        });
      }
    }
    if (ts.isExportDeclaration(statement)) {
      collectExportDeclaration(statement, file, exportNames, reExports);
    }
  }

  for (const statement of sourceFile.statements) {
    if (
      ts.isExportAssignment(statement) &&
      !statement.isExportEquals &&
      ts.isIdentifier(statement.expression)
    ) {
      const candidate = byLocal.get(statement.expression.text);
      if (candidate) {
        candidate.exportName = 'default';
        candidate.isDefault = true;
        exportNames.set('default', candidate.localName);
      }
    }
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const localName = element.propertyName?.text ?? element.name.text;
          const candidate = byLocal.get(localName);
          if (candidate) {
            const exportedName = element.name.text;
            candidate.exportName = exportedName;
            candidate.isDefault ||= exportedName === 'default';
            exportNames.set(exportedName, localName);
          }
        }
      }
    }
  }
  for (const candidate of candidates) {
    if (candidate.exportName) exportNames.set(candidate.exportName, candidate.localName);
  }
  return { candidates, exportNames, reExports };
}

function collectExportDeclaration(
  statement: ts.ExportDeclaration,
  file: SourceFileSnapshot,
  exportNames: Map<string, string>,
  reExports: RawImportEdge[]
): void {
  if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) return;
  const source = statement.moduleSpecifier.text;
  if (!statement.exportClause) {
    reExports.push({
      fromFile: file.file,
      source,
      importedName: '*',
      localName: null,
      isDefault: false,
      isNamespace: true,
      sourceRef: sourceRefForNode(
        file,
        ts.createSourceFile(file.file, file.content, ts.ScriptTarget.Latest, true),
        statement
      ),
    });
    return;
  }
  if (ts.isNamespaceExport(statement.exportClause)) {
    reExports.push({
      fromFile: file.file,
      source,
      importedName: '*',
      localName: statement.exportClause.name.text,
      isDefault: false,
      isNamespace: true,
      sourceRef: sourceRefForNode(
        file,
        ts.createSourceFile(file.file, file.content, ts.ScriptTarget.Latest, true),
        statement
      ),
    });
    return;
  }
  if (ts.isNamedExports(statement.exportClause)) {
    for (const element of statement.exportClause.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      const exportedName = element.name.text;
      exportNames.set(exportedName, importedName);
      reExports.push({
        fromFile: file.file,
        source,
        importedName,
        localName: exportedName,
        isDefault: importedName === 'default',
        isNamespace: false,
        sourceRef: sourceRefForNode(
          file,
          ts.createSourceFile(file.file, file.content, ts.ScriptTarget.Latest, true),
          element
        ),
      });
    }
  }
}

function exportModifier(node: ts.Node, kind: 'default' | 'named'): 'default' | 'named' | null {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  const isExported =
    modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  if (!isExported) return null;
  if (
    kind === 'default' &&
    modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  ) {
    return 'default';
  }
  return kind === 'named' ? 'named' : null;
}

function createDefinition(
  candidate: Candidate,
  sourceFile: ts.SourceFile,
  file: SourceFileSnapshot
): ParsedComponentDefinition {
  const definitionName = candidate.localName;
  const propsContractKnown = hasKnownPropsContract(candidate, sourceFile);
  const placeable = !isNonPlaceableComponent(file.file, definitionName) && propsContractKnown;
  const namedExport =
    placeable && candidate.exportName !== null && candidate.exportName === candidate.localName;
  const capabilities = componentCapabilities(placeable, namedExport, namedExport);
  const props = extractProps(candidate, sourceFile, file);
  const slots: ComponentSlotDescriptor[] = [];
  const children = props.find((prop) => prop.name === 'children');
  if (children) {
    slots.push({
      name: 'children',
      required: children.required,
      scoped: false,
      source: children.source,
    });
  }
  const definition = sourceRefForNode(file, sourceFile, candidate.declaration);
  const renderRoot = renderRootForCandidate(candidate, sourceFile, file);
  const descriptor = {
    id: componentId(file.file, candidate.exportName ?? definitionName),
    dialect: 'react' as const,
    kind: componentKindForFile(file.file, definitionName),
    name: candidate.exportName === 'default' ? basenameWithoutExtension(file.file) : definitionName,
    localName: definitionName,
    exportName: candidate.exportName,
    description: jsDocDescription(candidate.declaration, sourceFile),
    definition,
    isClientModule: hasUseClientDirective(sourceFile),
    ...(renderRoot ? { renderRoot } : {}),
    props,
    slots,
    variantProps: props.filter((prop) => prop.choices !== null).map((prop) => prop.name),
    usageCount: 0,
    capabilities,
    diagnostics: propsContractKnown
      ? []
      : [
          {
            code: 'react-props-unresolved',
            severity: 'warning' as const,
            message:
              'The prop contract could not be resolved without project type-checking, so placement and visual prop edits are disabled.',
            file: file.file,
            source: definition,
          },
        ],
  };
  return {
    localName: definitionName,
    exportName: candidate.exportName,
    descriptor,
    declaration: candidate.declaration,
    props,
    capabilities,
    isDefault: candidate.isDefault,
  };
}

/**
 * Return the one direct intrinsic host root that a component always returns.
 * This is deliberately conservative: conditional roots, fragments with more
 * than one host child, custom-component roots, and unmarked elements cannot
 * safely identify a Server Component in the rendered DOM.
 */
function renderRootForCandidate(
  candidate: Candidate,
  sourceFile: ts.SourceFile,
  file: SourceFileSnapshot
): ComponentRenderRoot | null {
  const expression = renderExpressionForCandidate(candidate, sourceFile);
  const opening = expression ? rootOpeningForExpression(expression) : null;
  if (!opening || !ts.isIdentifier(opening.tagName) || !isIntrinsicTag(opening.tagName)) {
    return null;
  }

  const className = staticJsxAttributeText(opening, 'className', file, sourceFile);
  const id = staticJsxAttributeText(opening, 'id', file, sourceFile);
  const classTokens = className
    ? [
        ...new Set(
          className
            .split(/\s+/)
            .map((token) => token.trim())
            .filter(Boolean)
        ),
      ].sort()
    : [];
  if (!id && classTokens.length === 0) return null;

  return {
    tag: opening.tagName.text.toLowerCase(),
    classTokens,
    id,
    source: sourceRefForNode(file, sourceFile, opening),
  };
}

function renderExpressionForCandidate(
  candidate: Candidate,
  sourceFile: ts.SourceFile
): ts.Expression | null {
  const functionLike = getFunctionLike(candidate);
  if (functionLike?.body) {
    if (!ts.isBlock(functionLike.body)) return unwrapRenderExpression(functionLike.body);
    return singleReturnedExpression(functionLike.body);
  }

  if (ts.isClassDeclaration(candidate.declaration) || ts.isClassExpression(candidate.declaration)) {
    const render = candidate.declaration.members.find(
      (member): member is ts.MethodDeclaration =>
        ts.isMethodDeclaration(member) && member.name.getText(sourceFile) === 'render'
    );
    if (render?.body) return singleReturnedExpression(render.body);
  }
  return null;
}

function singleReturnedExpression(body: ts.Block): ts.Expression | null {
  const returns: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isReturnStatement(node)) {
      if (node.expression) returns.push(node.expression);
      return;
    }
    if (
      node !== body &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isMethodDeclaration(node))
    ) {
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return returns.length === 1 ? returns[0] : null;
}

function rootOpeningForExpression(expression: ts.Expression): ts.JsxOpeningLikeElement | null {
  const node = unwrapRenderExpression(expression);
  if (ts.isJsxElement(node)) return node.openingElement;
  if (ts.isJsxSelfClosingElement(node)) return node;
  if (!ts.isJsxFragment(node)) return null;

  const children = node.children.filter((child) => {
    if (ts.isJsxText(child)) return child.getText().trim().length > 0;
    if (ts.isJsxExpression(child)) return !!child.expression;
    return true;
  });
  if (children.length !== 1) return null;
  const child = children[0];
  if (ts.isJsxElement(child)) return child.openingElement;
  if (ts.isJsxSelfClosingElement(child)) return child;
  return null;
}

function unwrapRenderExpression(expression: ts.Expression): ts.Expression {
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

function staticJsxAttributeText(
  opening: ts.JsxOpeningLikeElement,
  name: string,
  file: SourceFileSnapshot,
  sourceFile: ts.SourceFile
): string | null {
  const attribute = opening.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText(sourceFile) === name
  );
  if (!attribute) return null;
  const value = staticValueFromJsxAttribute(attribute, file, sourceFile)?.value;
  return value?.kind === 'string' ? value.value : null;
}

function hasUseClientDirective(sourceFile: ts.SourceFile): boolean {
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) {
      break;
    }
    if (statement.expression.text === 'use client') return true;
  }
  return false;
}

function componentId(file: string, exportName: string): string {
  return `react:${normalizeProjectPath(file)}#${exportName}`;
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (current: ts.Node) => {
    if (found) return;
    if (
      ts.isJsxElement(current) ||
      ts.isJsxSelfClosingElement(current) ||
      ts.isJsxFragment(current)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function isReactClass(node: ts.ClassDeclaration | ts.ClassExpression): boolean {
  const heritage = node.heritageClauses?.some(
    (clause) =>
      clause.token === ts.SyntaxKind.ExtendsKeyword &&
      clause.types.some((type) => /(?:Component|PureComponent)$/.test(type.expression.getText()))
  );
  if (heritage) return true;
  const render = node.members.find(
    (member): member is ts.MethodDeclaration =>
      ts.isMethodDeclaration(member) && member.name.getText() === 'render'
  );
  return render ? containsJsx(render) : false;
}

function isComponentInitializer(expression: ts.Expression): boolean {
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))
    return containsJsx(expression);
  if (ts.isCallExpression(expression)) {
    const callee = expression.expression.getText();
    if (/(?:^|\.)(?:memo|forwardRef)$/.test(callee)) {
      const inner = expression.arguments[0];
      return !!inner && (isComponentInitializer(inner) || containsJsx(inner));
    }
  }
  return false;
}

function extractProps(
  candidate: Candidate,
  sourceFile: ts.SourceFile,
  file: SourceFileSnapshot
): ComponentPropDescriptor[] {
  const declarations: PropSeed[] = [];
  const functionLike = getFunctionLike(candidate);
  if (functionLike) {
    const parameter = functionLike.parameters[0];
    if (parameter) {
      if (ts.isObjectBindingPattern(parameter.name)) {
        if (parameter.type) {
          declarations.push(...propSeedsFromType(parameter.type, sourceFile));
        }
        for (const element of parameter.name.elements) {
          if (!ts.isBindingElement(element) || element.dotDotDotToken) continue;
          const name = bindingElementName(element);
          if (!name) continue;
          const typeNode = parameter.type && findPropertyType(parameter.type, name, sourceFile);
          declarations.push({
            name,
            required: !element.initializer,
            typeNode,
            defaultValue: element.initializer
              ? staticValueFromExpression(element.initializer)
              : null,
            sourceNode: element.name,
          });
        }
      } else if (parameter.type) {
        declarations.push(...propSeedsFromType(parameter.type, sourceFile));
      }
    }
    if (parameterTypeFromVariable(candidate, sourceFile)) {
      declarations.push(
        ...propSeedsFromType(parameterTypeFromVariable(candidate, sourceFile)!, sourceFile)
      );
    }
  }
  if (ts.isClassDeclaration(candidate.declaration) || ts.isClassExpression(candidate.declaration)) {
    const type = candidate.declaration.heritageClauses
      ?.flatMap((clause) => clause.types)
      .find((heritageType) =>
        /(?:Component|PureComponent)$/.test(heritageType.expression.getText())
      )?.typeArguments?.[0];
    if (type) declarations.push(...propSeedsFromType(type, sourceFile));
  }
  const defaultProps = findDefaultProps(candidate.localName, sourceFile);
  const merged = new Map<string, PropSeed>();
  for (const seed of declarations) {
    const existing = merged.get(seed.name);
    if (existing) {
      existing.typeNode ||= seed.typeNode;
      existing.defaultValue ??= seed.defaultValue;
      existing.required &&= seed.required;
    } else merged.set(seed.name, seed);
  }
  for (const [name, value] of defaultProps) {
    const seed = merged.get(name);
    if (seed) {
      seed.defaultValue = value;
      seed.required = false;
    } else {
      merged.set(name, {
        name,
        required: false,
        typeNode: undefined,
        defaultValue: value,
        sourceNode: candidate.declaration,
      });
    }
  }
  return [...merged.values()].map((seed) => propDescriptor(seed, file, sourceFile));
}

interface PropSeed {
  name: string;
  required: boolean;
  typeNode: ts.TypeNode | undefined;
  defaultValue: StaticValue | null;
  sourceNode: ts.Node;
}

function getFunctionLike(candidate: Candidate): ts.FunctionLikeDeclaration | null {
  if (
    ts.isFunctionDeclaration(candidate.declaration) ||
    ts.isFunctionExpression(candidate.declaration) ||
    ts.isArrowFunction(candidate.declaration)
  ) {
    return candidate.declaration;
  }
  if (ts.isVariableDeclaration(candidate.declaration) && candidate.initializer) {
    const expression = unwrapComponentWrapper(candidate.initializer);
    if (ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) return expression;
  }
  return null;
}

function unwrapComponentWrapper(expression: ts.Expression): ts.Expression {
  if (!ts.isCallExpression(expression)) return expression;
  const callee = expression.expression.getText();
  if (/(?:^|\.)(?:memo|forwardRef)$/.test(callee) && expression.arguments[0]) {
    return unwrapComponentWrapper(expression.arguments[0]);
  }
  return expression;
}

function parameterTypeFromVariable(
  candidate: Candidate,
  _sourceFile: ts.SourceFile
): ts.TypeNode | undefined {
  if (!ts.isVariableDeclaration(candidate.declaration)) return undefined;
  const type = candidate.declaration.type;
  if (!type || !ts.isTypeReferenceNode(type)) return undefined;
  return type.typeArguments?.[0];
}

function propSeedsFromType(type: ts.TypeNode, sourceFile: ts.SourceFile): PropSeed[] {
  const unwrapped = unwrapType(type);
  if (ts.isTypeLiteralNode(unwrapped)) {
    return unwrapped.members.flatMap((member) => {
      if (!ts.isPropertySignature(member) || !member.name) return [];
      const name = propertyName(member.name);
      if (!name) return [];
      return [
        {
          name,
          required: !member.questionToken,
          typeNode: member.type,
          defaultValue: null,
          sourceNode: member,
        },
      ];
    });
  }
  if (ts.isTypeReferenceNode(unwrapped)) {
    const declaration = findNamedTypeDeclaration(unwrapped.typeName, sourceFile);
    if (!declaration) return [];
    if (ts.isInterfaceDeclaration(declaration)) {
      return declaration.members.flatMap((member) => {
        if (!ts.isPropertySignature(member) || !member.name) return [];
        const name = propertyName(member.name);
        if (!name) return [];
        return [
          {
            name,
            required: !member.questionToken,
            typeNode: member.type,
            defaultValue: null,
            sourceNode: member,
          },
        ];
      });
    }
    if (ts.isTypeAliasDeclaration(declaration))
      return propSeedsFromType(declaration.type, sourceFile);
  }
  if (ts.isIntersectionTypeNode(unwrapped))
    return unwrapped.types.flatMap((member) => propSeedsFromType(member, sourceFile));
  return [];
}

function unwrapType(type: ts.TypeNode): ts.TypeNode {
  if (ts.isParenthesizedTypeNode(type) || ts.isTypeOperatorNode(type)) return unwrapType(type.type);
  return type;
}

function findNamedTypeDeclaration(
  name: ts.EntityName,
  sourceFile: ts.SourceFile
): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | null {
  const text = name.getText(sourceFile).split('.').pop() ?? '';
  for (const statement of sourceFile.statements) {
    if (
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
      statement.name.text === text
    ) {
      return statement;
    }
  }
  return null;
}

function findPropertyType(
  type: ts.TypeNode,
  name: string,
  sourceFile: ts.SourceFile
): ts.TypeNode | undefined {
  return propSeedsFromType(type, sourceFile).find((seed) => seed.name === name)?.typeNode;
}

function bindingElementName(element: ts.BindingElement): string | null {
  if (element.propertyName) return propertyName(element.propertyName);
  if (ts.isIdentifier(element.name)) return element.name.text;
  if (ts.isObjectBindingPattern(element.name)) return null;
  return element.name.getText();
}

function hasKnownPropsContract(candidate: Candidate, sourceFile: ts.SourceFile): boolean {
  const functionLike = getFunctionLike(candidate);
  if (functionLike) {
    const parameter = functionLike.parameters[0];
    if (!parameter) return true;
    if (ts.isObjectBindingPattern(parameter.name)) {
      return !!parameter.type && canResolvePropsType(parameter.type, sourceFile);
    }
    if (parameter.type && canResolvePropsType(parameter.type, sourceFile)) return true;
    const variableType = parameterTypeFromVariable(candidate, sourceFile);
    return !!variableType && canResolvePropsType(variableType, sourceFile);
  }

  if (ts.isClassDeclaration(candidate.declaration) || ts.isClassExpression(candidate.declaration)) {
    const propsType = candidate.declaration.heritageClauses
      ?.flatMap((clause) => clause.types)
      .find((heritageType) =>
        /(?:Component|PureComponent)$/.test(heritageType.expression.getText())
      )?.typeArguments?.[0];
    return !!propsType && canResolvePropsType(propsType, sourceFile);
  }

  return true;
}

function canResolvePropsType(
  type: ts.TypeNode,
  sourceFile: ts.SourceFile,
  seen = new Set<ts.Node>()
): boolean {
  const unwrapped = unwrapType(type);
  if (ts.isTypeLiteralNode(unwrapped)) return true;
  if (ts.isIntersectionTypeNode(unwrapped)) {
    return unwrapped.types.every((member) => canResolvePropsType(member, sourceFile, seen));
  }
  if (!ts.isTypeReferenceNode(unwrapped)) return false;
  const wrapper = unwrapped.typeName.getText(sourceFile).split('.').pop();
  if (
    wrapper &&
    ['Readonly', 'PropsWithChildren'].includes(wrapper) &&
    unwrapped.typeArguments?.[0]
  ) {
    return canResolvePropsType(unwrapped.typeArguments[0], sourceFile, seen);
  }
  const declaration = findNamedTypeDeclaration(unwrapped.typeName, sourceFile);
  if (!declaration || seen.has(declaration)) return false;
  seen.add(declaration);
  if (ts.isInterfaceDeclaration(declaration)) {
    return !declaration.heritageClauses?.length;
  }
  return canResolvePropsType(declaration.type, sourceFile, seen);
}

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : null;
}

function findDefaultProps(localName: string, sourceFile: ts.SourceFile): Map<string, StaticValue> {
  const values = new Map<string, StaticValue>();
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression))
      continue;
    const { left, operatorToken, right } = statement.expression;
    if (operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isPropertyAccessExpression(left))
      continue;
    if (left.expression.getText(sourceFile) !== localName || left.name.text !== 'defaultProps')
      continue;
    if (!ts.isObjectLiteralExpression(right)) continue;
    for (const property of right.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = propertyName(property.name);
      const value = staticValueFromExpression(property.initializer);
      if (name && value) values.set(name, value);
    }
  }
  return values;
}

function propDescriptor(
  seed: PropSeed,
  file: SourceFileSnapshot,
  sourceFile: ts.SourceFile
): ComponentPropDescriptor {
  const typeText = seed.typeNode?.getText(sourceFile) ?? null;
  const choices = literalChoices(seed.typeNode);
  let control: ComponentPropDescriptor['control'] = 'readonly';
  if (choices) control = 'select';
  else if (typeText && /boolean/i.test(typeText)) control = 'boolean';
  else if (typeText && /(?:number|bigint)/i.test(typeText)) control = 'number';
  else if (typeText && /string/i.test(typeText))
    control = isStaticAssetProp(seed.name) ? 'asset' : 'text';
  return {
    name: seed.name,
    required: seed.required && seed.defaultValue === null,
    typeText,
    defaultValue: seed.defaultValue,
    choices,
    control,
    source: sourceRefForNode(file, sourceFile, seed.sourceNode),
    diagnostics: [],
  };
}

function jsDocDescription(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  const fullStart = node.getFullStart();
  const leading = sourceFile.text.slice(fullStart, node.getStart(sourceFile));
  const match = leading.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return null;
  const text = match[1]
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, '').trim())
    .filter((line) => line && !line.startsWith('@'))
    .join(' ')
    .trim();
  return text || null;
}

function collectImports(sourceFile: ts.SourceFile, file: SourceFileSnapshot): RawImportEdge[] {
  const imports: RawImportEdge[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly) continue;
      const source = statement.moduleSpecifier.text;
      if (clause.name) {
        imports.push({
          fromFile: file.file,
          source,
          importedName: 'default',
          localName: clause.name.text,
          isDefault: true,
          isNamespace: false,
          sourceRef: sourceRefForNode(file, sourceFile, clause.name),
        });
      }
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        imports.push({
          fromFile: file.file,
          source,
          importedName: '*',
          localName: clause.namedBindings.name.text,
          isDefault: false,
          isNamespace: true,
          sourceRef: sourceRefForNode(file, sourceFile, clause.namedBindings),
        });
      } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (element.isTypeOnly) continue;
          imports.push({
            fromFile: file.file,
            source,
            importedName: element.propertyName?.text ?? element.name.text,
            localName: element.name.text,
            isDefault: false,
            isNamespace: false,
            sourceRef: sourceRefForNode(file, sourceFile, element),
          });
        }
      }
    }
  }
  return imports;
}

function collectUsages(
  sourceFile: ts.SourceFile,
  file: SourceFileSnapshot,
  candidates: readonly Candidate[]
): RawJsxUsage[] {
  const usages: RawJsxUsage[] = [];
  const definitions = candidates.map((candidate) => ({
    name: candidate.localName,
    start: candidate.declaration.getStart(sourceFile),
    end: candidate.declaration.end,
  }));
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = opening.tagName;
      if (!isIntrinsicTag(tag)) {
        const containing =
          definitions
            .filter((definition) => definition.start <= node.pos && definition.end >= node.end)
            .sort((left, right) => right.start - left.start)[0]?.name ?? null;
        usages.push({
          tagName: jsxTagText(tag),
          localName: jsxRootIdentifier(tag),
          namespaceName: ts.isPropertyAccessExpression(tag)
            ? jsxRootIdentifier(tag as ts.JsxTagNameExpression)
            : null,
          invocation: sourceRefForNode(file, sourceFile, node),
          attributes: collectAttributes(opening, file, sourceFile),
          childrenSource: collectChildrenSource(node, file, sourceFile),
          containingLocalName: containing,
          node,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return usages;
}

function isIntrinsicTag(tag: ts.JsxTagNameExpression): boolean {
  if (ts.isIdentifier(tag)) return /^[a-z]/.test(tag.text);
  return false;
}

function collectAttributes(
  opening: ts.JsxOpeningLikeElement,
  file: SourceFileSnapshot,
  sourceFile: ts.SourceFile
): RawJsxAttribute[] {
  return opening.attributes.properties.flatMap((property) => {
    if (!ts.isJsxAttribute(property)) return [];
    const name = property.name.getText(sourceFile);
    const staticResult = staticValueFromJsxAttribute(property, file, sourceFile);
    const expression =
      property.initializer && ts.isJsxExpression(property.initializer)
        ? property.initializer.expression
        : undefined;
    return [
      {
        name,
        source: sourceRefForNode(file, sourceFile, property),
        valueSource: staticResult?.valueNode
          ? sourceRefForNode(file, sourceFile, staticResult.valueNode)
          : null,
        expressionText: expression?.getText(sourceFile) ?? null,
        staticValue: staticResult?.value ?? null,
        dynamicReason: staticResult
          ? null
          : expression
            ? dynamicExpressionReason(expression)
            : 'Unsupported JSX attribute value.',
      },
    ];
  });
}

function collectChildrenSource(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
  file: SourceFileSnapshot,
  sourceFile: ts.SourceFile
): import('../types').SourceRef | null {
  if (!ts.isJsxElement(node) || node.children.length === 0) return null;
  const first = node.children[0];
  const last = node.children[node.children.length - 1];
  return sourceRefForNode(file, sourceFile, {
    getStart: () => first.getStart(sourceFile),
    end: last.end,
  } as ts.Node);
}
