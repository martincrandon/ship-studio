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
  isReactSourcePath,
  isRouteSpecialFile,
  normalizeProjectPath,
  resolveModulePath,
} from './adapters/react-helpers';
import { parseDiagnosticsForSourceFile } from './adapters/static-values';
import { REACT_COMPONENT_PLAN_PARSER_TOKEN } from './mutation';
import type {
  ComponentDescriptor,
  ComponentFileMutation,
  ComponentFileOperation,
  ComponentGraphDelta,
  ComponentIndex,
  ComponentRefactorPlan,
  ComponentRefactorPreview,
  ComponentSourceSnapshot,
  DeleteComponentInput,
  ComponentTextEdit,
  DuplicateComponentInput,
  RenameComponentInput,
  RefactorResult,
  SourceFileSnapshot,
} from './types';

const RESERVED_DUPLICATE_NAMES = new Set([
  'Page',
  'Layout',
  'Template',
  'Error',
  'Loading',
  'NotFound',
  'GlobalError',
  'Route',
  'Provider',
  'Context',
  'Boundary',
]);

/**
 * Plan a same-directory React definition duplicate.
 *
 * The first lifecycle slice intentionally copies a dedicated component file
 * instead of trying to rewrite relative imports or shared module exports. The
 * operation is pure and produces a create-only transaction for Rust to guard.
 */
export function planDuplicateComponent(
  input: DuplicateComponentInput,
  index: ComponentIndex,
  suppliedSnapshot?: ComponentSourceSnapshot
): RefactorResult {
  const snapshot = suppliedSnapshot ?? input.snapshot;
  if (!snapshot)
    return refuse('missing-source', 'A source snapshot is required to duplicate a component.');
  if (snapshot.partial || index.partial) {
    return refuse(
      'incomplete-graph',
      'The component graph is incomplete, so duplicating a definition is disabled until the catalog is refreshed.'
    );
  }

  const component = index.components.find((candidate) => candidate.id === input.componentId);
  if (!component)
    return refuse('unsupported', 'The requested component is not in the current index.');
  if (component.dialect !== 'react') {
    return refuse(
      'unsupported',
      'Definition duplication is currently available for React components only.'
    );
  }
  if (component.kind === 'layout' || isRouteSpecialFile(component.definition.file)) {
    return refuse(
      'unsupported',
      'Route and layout definitions cannot be duplicated as reusable components.'
    );
  }

  const newName = input.newName.trim();
  if (!isPascalCase(newName)) {
    return refuse(
      'invalid-name',
      'The duplicate name must be a PascalCase JSX component identifier.'
    );
  }
  if (RESERVED_DUPLICATE_NAMES.has(newName)) {
    return refuse('reserved-name', `The component name "${newName}" is reserved by the framework.`);
  }
  if (newName === component.localName) {
    return refuse('no-op', 'The duplicate needs a different component name.');
  }

  const sourceFile = findSnapshotFile(snapshot, component.definition.file);
  if (!sourceFile) {
    return refuse(
      'missing-source',
      `The definition file ${component.definition.file} is not in the source snapshot.`
    );
  }
  if (sourceFile.contentHash !== component.definition.contentHash) {
    return refuse('stale-source', 'The component source changed after the catalog was built.');
  }
  if (!isReactSourcePath(sourceFile.file)) {
    return refuse(
      'unsupported',
      'The React duplicate planner requires a TypeScript or JavaScript definition file.'
    );
  }

  const definitionsInFile = index.components.filter(
    (candidate) =>
      normalizeProjectPath(candidate.definition.file) === normalizeProjectPath(sourceFile.file)
  );
  if (definitionsInFile.length !== 1) {
    return refuse(
      'shared-file',
      'This definition shares its source file with another catalogued component, so a safe duplicate is not available yet.'
    );
  }

  const destinationFile = normalizeProjectPath(input.destinationFile);
  if (destinationFile === '.' || destinationFile !== input.destinationFile.replace(/^\.\//, '')) {
    return refuse(
      'cross-workspace',
      'The duplicate destination must be a normalized project-relative path.'
    );
  }
  if (!isReactSourcePath(destinationFile)) {
    return refuse(
      'unsupported',
      'The duplicate destination must use a supported React source extension.'
    );
  }
  if (extensionOf(destinationFile) !== extensionOf(sourceFile.file)) {
    return refuse('unsupported', 'The duplicate must keep the original source file extension.');
  }
  if (directoryOf(destinationFile) !== directoryOf(sourceFile.file)) {
    return refuse(
      'unsafe-dependency-closure',
      'The first duplicate transaction keeps relative imports safe by requiring the new file to stay beside its source definition.'
    );
  }
  if (basenameWithoutExtension(destinationFile) !== newName) {
    return refuse(
      'invalid-name',
      `The destination filename must be ${newName}${extensionOf(sourceFile.file)} so the new definition has one unambiguous identity.`
    );
  }
  if (snapshot.files.some((file) => normalizeProjectPath(file.file) === destinationFile)) {
    return refuse(
      'path-collision',
      `The destination file ${destinationFile} already exists in the source snapshot.`
    );
  }

  const source = createSourceFile(sourceFile);
  const declaration = findDefinitionNode(source, sourceFile.content, component);
  if (!declaration || !isDirectlyExported(declaration, component)) {
    return refuse(
      'public-api',
      'Only a directly exported component in a dedicated source file can be duplicated safely right now.'
    );
  }
  const identifier = declarationName(declaration);
  if (!identifier || identifier.text !== component.localName) {
    return refuse(
      'unsupported',
      'The component declaration could not be matched to its indexed local name.'
    );
  }

  const topLevelNames = topLevelBindingNames(source);
  if (topLevelNames.has(newName)) {
    return refuse(
      'symbol-collision',
      `The name "${newName}" is already bound in the definition file.`
    );
  }
  if (hasNestedBinding(declaration, component.localName)) {
    return refuse(
      'unsupported',
      'The definition contains a nested binding with the same name, so renaming the copied declaration could change its meaning.'
    );
  }
  if (hasIdentifier(declaration, newName)) {
    return refuse(
      'symbol-collision',
      `The name "${newName}" is already used inside the definition and cannot be introduced conservatively.`
    );
  }

  const start = utf16OffsetToUtf8ByteOffset(sourceFile.content, identifier.getStart(source));
  const end = utf16OffsetToUtf8ByteOffset(sourceFile.content, identifier.end);
  const contents = applyTextEdits(sourceFile.content, [{ start, end, text: newName }]);
  if (contents === null) {
    return refuse(
      'invalid-range',
      'The component declaration range is not a safe UTF-8 source edit.'
    );
  }
  if (contents === sourceFile.content)
    return refuse('no-op', 'The duplicate source would be identical to the original.');

  const createdComponentId = `react:${destinationFile}#${component.exportName === 'default' ? 'default' : newName}`;
  const graphDelta: ComponentGraphDelta = {
    componentId: component.id,
    usagesBefore: component.usageCount,
    usagesAfter: component.usageCount,
    delta: 0,
    createdComponentId,
    createdUsages: 0,
  };
  const operation: ComponentFileOperation = {
    kind: 'create',
    file: destinationFile,
    expectedAbsent: true,
    contents,
    expectedResultHash: sha256(contents),
  };
  const preview: ComponentRefactorPreview = {
    operation: 'duplicate',
    affectedFiles: [destinationFile],
    files: [
      {
        file: destinationFile,
        operation: 'create',
        beforeHash: null,
        afterHash: sha256(contents),
        after: contents,
      },
    ],
    graphDelta,
  };
  const plan: ComponentRefactorPlan = {
    files: [],
    operations: [operation],
    dialect: 'react',
    parserToken: REACT_COMPONENT_PLAN_PARSER_TOKEN,
    expectedRevision: snapshot.revision,
    expectedGraphDelta: graphDelta,
    operation: 'duplicate',
    preview,
  };
  return { status: 'planned', plan };
}

/**
 * Plan a graph-aware rename for a dedicated, directly named React export.
 *
 * The first rename slice deliberately keeps the definition file in place. It
 * updates direct named imports, namespace member references, self references,
 * and the resolved JSX usages those imports produce. Re-export chains, file
 * moves, default-export renames, and ambiguous bindings remain refused until
 * their dependency resolver can prove the complete edit set.
 */
export function planRenameComponent(
  input: RenameComponentInput,
  index: ComponentIndex,
  suppliedSnapshot?: ComponentSourceSnapshot
): RefactorResult {
  const snapshot = suppliedSnapshot ?? input.snapshot;
  if (!snapshot)
    return refuse('missing-source', 'A source snapshot is required to rename a component.');
  if (snapshot.partial || index.partial) {
    return refuse(
      'incomplete-graph',
      'The component graph is incomplete, so renaming is disabled until the catalog is refreshed.'
    );
  }

  const component = index.components.find((candidate) => candidate.id === input.componentId);
  if (!component)
    return refuse('unsupported', 'The requested component is not in the current index.');
  if (component.dialect !== 'react') {
    return refuse(
      'unsupported',
      'Definition renaming is currently available for React components only.'
    );
  }
  if (component.kind === 'layout' || isRouteSpecialFile(component.definition.file)) {
    return refuse(
      'unsupported',
      'Route and layout definitions cannot be renamed as reusable components.'
    );
  }
  if (input.renameFile) {
    return refuse(
      'unsupported',
      'Renaming the definition file is not enabled until guarded move operations are available.'
    );
  }

  const newName = input.newName.trim();
  if (!isPascalCase(newName)) {
    return refuse('invalid-name', 'The new component name must be a PascalCase JSX identifier.');
  }
  if (RESERVED_DUPLICATE_NAMES.has(newName)) {
    return refuse('reserved-name', `The component name "${newName}" is reserved by the framework.`);
  }
  if (newName === component.localName) {
    return refuse('no-op', 'The component already has that name.');
  }
  if (component.exportName !== component.localName || component.exportName === 'default') {
    return refuse(
      'public-api',
      'Only a directly named export can be renamed safely in the current React refactor slice.'
    );
  }

  const sourceFile = findSnapshotFile(snapshot, component.definition.file);
  if (!sourceFile) {
    return refuse(
      'missing-source',
      `The definition file ${component.definition.file} is not in the source snapshot.`
    );
  }
  if (sourceFile.contentHash !== component.definition.contentHash) {
    return refuse('stale-source', 'The component source changed after the catalog was built.');
  }
  if (!isReactSourcePath(sourceFile.file)) {
    return refuse(
      'unsupported',
      'The React rename planner requires a TypeScript or JavaScript definition file.'
    );
  }

  const definitionsInFile = index.components.filter(
    (candidate) =>
      normalizeProjectPath(candidate.definition.file) === normalizeProjectPath(sourceFile.file)
  );
  if (definitionsInFile.length !== 1) {
    return refuse(
      'shared-file',
      'This definition shares its source file with another catalogued component, so a safe rename is not available yet.'
    );
  }

  const source = createSourceFile(sourceFile);
  const declaration = findDefinitionNode(source, sourceFile.content, component);
  const identifier = declaration ? declarationName(declaration) : null;
  if (!declaration || !identifier || identifier.text !== component.localName) {
    return refuse(
      'public-api',
      'The component must be a named declaration with a directly exported identifier.'
    );
  }
  if (!isDirectlyExported(declaration, component)) {
    return refuse(
      'public-api',
      'Only a directly exported component can be renamed without a public-API migration.'
    );
  }

  const topLevelNames = topLevelBindingNames(source);
  if (topLevelNames.has(newName)) {
    return refuse(
      'symbol-collision',
      `The name "${newName}" is already bound in the definition file.`
    );
  }
  if (hasNestedBinding(declaration, component.localName)) {
    return refuse(
      'ambiguous-usage',
      'The definition contains a nested binding with the current name, so its self references cannot be renamed safely.'
    );
  }
  if (hasIdentifier(declaration, newName)) {
    return refuse(
      'symbol-collision',
      `The name "${newName}" is already used inside the definition.`
    );
  }

  const filesByPath = new Map(
    snapshot.files.map((file) => [normalizeProjectPath(file.file), file] as const)
  );
  const targetFile = normalizeProjectPath(sourceFile.file);
  if (hasTargetReexport(snapshot.files, targetFile, component.exportName)) {
    return refuse(
      'unsafe-dependency-closure',
      'This component is exposed through a re-export chain. Rename is disabled until every barrel reference can be proven.'
    );
  }

  const editsByFile = new Map<string, ComponentTextEdit[]>();
  const addEdit = (file: string, edit: ComponentTextEdit) => {
    const edits = editsByFile.get(file) ?? [];
    edits.push(edit);
    editsByFile.set(file, edits);
  };

  for (const node of renameableIdentifiers(source, declaration, component.localName)) {
    addEdit(targetFile, nodeEdit(sourceFile, source, node, newName));
  }

  const directImportFiles = new Set<string>();
  const localBindingsToRename = new Map<string, Set<string>>();
  const namespaceBindings = new Map<string, Set<string>>();
  for (const file of snapshot.files) {
    const parsed = createSourceFile(file);
    const filePath = normalizeProjectPath(file.file);
    for (const statement of parsed.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const resolution = resolveModulePath(
        filePath,
        statement.moduleSpecifier.text,
        snapshot.files
      );
      if (resolution.file !== targetFile) continue;
      directImportFiles.add(filePath);
      const clause = statement.importClause;
      const namedBindings = clause?.namedBindings;
      if (!namedBindings) continue;
      if (ts.isNamespaceImport(namedBindings)) {
        const bindings = namespaceBindings.get(filePath) ?? new Set<string>();
        bindings.add(namedBindings.name.text);
        namespaceBindings.set(filePath, bindings);
        continue;
      }
      for (const specifier of namedBindings.elements) {
        const importedName = (specifier.propertyName ?? specifier.name).text;
        if (importedName !== component.exportName) continue;
        addEdit(
          filePath,
          nodeEdit(file, parsed, specifier.propertyName ?? specifier.name, newName)
        );
        if (!specifier.propertyName && specifier.name.text === component.localName) {
          const bindings = localBindingsToRename.get(filePath) ?? new Set<string>();
          bindings.add(specifier.name.text);
          localBindingsToRename.set(filePath, bindings);
        }
      }
    }
  }

  for (const [filePath, names] of localBindingsToRename) {
    const file = filesByPath.get(filePath);
    if (!file) return refuse('missing-source', `The imported source file ${filePath} is missing.`);
    const parsed = createSourceFile(file);
    if (topLevelBindingNames(parsed).has(newName)) {
      return refuse('symbol-collision', `The name "${newName}" is already bound in ${filePath}.`);
    }
    for (const name of names) {
      if (hasBindingNamedOutsideImports(parsed, name) || hasShorthandReference(parsed, name)) {
        return refuse(
          'ambiguous-usage',
          `The import binding "${name}" has a shadowed or shorthand reference in ${filePath}.`
        );
      }
      for (const node of renameableIdentifiers(parsed, parsed, name)) {
        addEdit(filePath, nodeEdit(file, parsed, node, newName));
      }
    }
  }

  for (const [filePath, namespaces] of namespaceBindings) {
    const file = filesByPath.get(filePath);
    if (!file) return refuse('missing-source', `The imported source file ${filePath} is missing.`);
    const parsed = createSourceFile(file);
    for (const namespace of namespaces) {
      for (const node of namespacePropertyIdentifiers(parsed, namespace, component.exportName)) {
        addEdit(filePath, nodeEdit(file, parsed, node, newName));
      }
    }
  }

  for (const instance of index.instances.filter((item) => item.componentId === component.id)) {
    const invocationFile = normalizeProjectPath(instance.invocation.file);
    if (invocationFile !== targetFile && !directImportFiles.has(invocationFile)) {
      return refuse(
        'unsafe-dependency-closure',
        `The usage in ${instance.invocation.file} is not backed by a direct import that can be renamed safely.`
      );
    }
  }

  const mutations: ComponentFileMutation[] = [];
  const previews: ComponentRefactorPreview['files'] = [];
  for (const [filePath, edits] of editsByFile) {
    const file = filesByPath.get(filePath);
    if (!file) return refuse('missing-source', `The source file ${filePath} is missing.`);
    const sorted = dedupeEdits(edits);
    const after = applyTextEdits(file.content, sorted);
    if (after === null) {
      return refuse(
        'invalid-range',
        `The planned rename edits overlap or split a UTF-8 code point in ${filePath}.`
      );
    }
    if (after === file.content) continue;
    const afterHash = sha256(after);
    mutations.push({
      file: filePath,
      expectedHash: file.contentHash,
      expectedResultHash: afterHash,
      edits: sorted,
    });
    previews.push({
      file: filePath,
      operation: 'edit',
      beforeHash: file.contentHash,
      afterHash,
      before: file.content,
      after,
    });
  }
  mutations.sort((left, right) => left.file.localeCompare(right.file));
  previews.sort((left, right) => left.file.localeCompare(right.file));
  if (mutations.length === 0)
    return refuse('no-op', 'No safe source references were found to rename.');

  const graphDelta: ComponentGraphDelta = {
    componentId: component.id,
    usagesBefore: component.usageCount,
    usagesAfter: 0,
    delta: -component.usageCount,
    createdComponentId: `react:${targetFile}#${newName}`,
    createdUsages: component.usageCount,
    removedComponentId: component.id,
  };
  const preview: ComponentRefactorPreview = {
    operation: 'rename',
    affectedFiles: mutations.map((mutation) => mutation.file),
    files: previews,
    graphDelta,
  };
  const operations: ComponentFileOperation[] = mutations.map((mutation) => ({
    kind: 'edit' as const,
    ...mutation,
  }));
  const plan: ComponentRefactorPlan = {
    files: [],
    operations,
    dialect: 'react',
    parserToken: REACT_COMPONENT_PLAN_PARSER_TOKEN,
    expectedRevision: snapshot.revision,
    expectedGraphDelta: graphDelta,
    operation: 'rename',
    preview,
  };
  return { status: 'planned', plan };
}

/**
 * Plan a reviewed removal for a dedicated, directly named React export.
 *
 * This first delete slice keeps the source file in place and removes only
 * statically resolved JSX invocations plus the imports that exclusively bind
 * those invocations. File deletion, default exports, re-export chains, and
 * value/type references outside JSX remain refused until the full lifecycle
 * transaction can prove those cases without guessing.
 */
export function planDeleteComponent(
  input: DeleteComponentInput,
  index: ComponentIndex,
  suppliedSnapshot?: ComponentSourceSnapshot
): RefactorResult {
  const snapshot = suppliedSnapshot ?? input.snapshot;
  if (!snapshot)
    return refuse('missing-source', 'A source snapshot is required to delete a component.');
  if (snapshot.partial || index.partial) {
    return refuse(
      'incomplete-graph',
      'The component graph is incomplete, so deletion is disabled until the catalog is refreshed.'
    );
  }

  const component = index.components.find((candidate) => candidate.id === input.componentId);
  if (!component)
    return refuse('unsupported', 'The requested component is not in the current index.');
  if (component.dialect !== 'react') {
    return refuse(
      'unsupported',
      'Definition deletion is currently available for React components only.'
    );
  }
  if (component.kind === 'layout' || isRouteSpecialFile(component.definition.file)) {
    return refuse(
      'unsupported',
      'Route and layout definitions cannot be deleted as reusable components.'
    );
  }
  if (input.deleteFile) {
    return refuse(
      'unsupported',
      'Deleting the definition file is not enabled until guarded file-delete operations are available.'
    );
  }
  if (input.removeAllUsages !== true) {
    return refuse(
      'usages-remain',
      'Deletion requires explicit confirmation to remove every statically resolved usage.'
    );
  }
  if (component.exportName !== component.localName || component.exportName === 'default') {
    return refuse(
      'public-api',
      'Only a directly named export can be deleted safely in the current React refactor slice.'
    );
  }

  const sourceFile = findSnapshotFile(snapshot, component.definition.file);
  if (!sourceFile) {
    return refuse(
      'missing-source',
      `The definition file ${component.definition.file} is not in the source snapshot.`
    );
  }
  if (sourceFile.contentHash !== component.definition.contentHash) {
    return refuse('stale-source', 'The component source changed after the catalog was built.');
  }
  if (!isReactSourcePath(sourceFile.file)) {
    return refuse(
      'unsupported',
      'The React delete planner requires a TypeScript or JavaScript definition file.'
    );
  }

  const definitionsInFile = index.components.filter(
    (candidate) =>
      normalizeProjectPath(candidate.definition.file) === normalizeProjectPath(sourceFile.file)
  );
  if (definitionsInFile.length !== 1) {
    return refuse(
      'shared-file',
      'This definition shares its source file with another catalogued component, so a safe delete is not available yet.'
    );
  }

  const source = createSourceFile(sourceFile);
  const declaration = findDefinitionNode(source, sourceFile.content, component);
  const deletionNode = declaration ? definitionDeletionNode(declaration) : null;
  if (!declaration || !deletionNode || !declarationName(declaration)) {
    return refuse(
      'public-api',
      'The component must be a directly exported function, class, or single variable declaration.'
    );
  }
  if (!isDirectlyExported(declaration, component)) {
    return refuse(
      'public-api',
      'Only a directly exported component can be deleted without a public-API migration.'
    );
  }

  const filesByPath = new Map(
    snapshot.files.map((file) => [normalizeProjectPath(file.file), file] as const)
  );
  const targetFile = normalizeProjectPath(sourceFile.file);
  if (hasTargetReexport(snapshot.files, targetFile, component.exportName)) {
    return refuse(
      'unsafe-dependency-closure',
      'This component is exposed through a re-export chain. Delete is disabled until every barrel reference can be proven.'
    );
  }

  const instances = index.instances.filter((item) => item.componentId === component.id);
  if (instances.length !== component.usageCount) {
    return refuse(
      'incomplete-graph',
      'The indexed usage count does not match its resolved invocation list, so deletion cannot prove every reference.'
    );
  }

  const instanceRangesByFile = new Map<string, SourceRange[]>();
  for (const instance of instances) {
    const filePath = normalizeProjectPath(instance.invocation.file);
    const range = {
      start: instance.invocation.start,
      end: instance.invocation.end,
    };
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.end <= range.start
    ) {
      return refuse(
        'invalid-range',
        `The resolved invocation range in ${instance.invocation.file} is not a safe source edit.`
      );
    }
    const ranges = instanceRangesByFile.get(filePath) ?? [];
    ranges.push(range);
    instanceRangesByFile.set(filePath, ranges);
  }
  for (const [filePath, ranges] of instanceRangesByFile) {
    const sorted = [...ranges].sort(
      (left, right) => left.start - right.start || left.end - right.end
    );
    for (let index = 1; index < sorted.length; index += 1) {
      if (rangesOverlap(sorted[index - 1], sorted[index])) {
        return refuse(
          'ambiguous-usage',
          `Nested or overlapping ${component.name} invocations in ${filePath} cannot be removed conservatively.`
        );
      }
    }
  }

  const definitionRange = nodeRange(sourceFile, source, deletionNode);
  const editsByFile = new Map<string, ComponentTextEdit[]>();
  const addEdit = (file: string, edit: ComponentTextEdit) => {
    const edits = editsByFile.get(file) ?? [];
    edits.push(edit);
    editsByFile.set(file, edits);
  };
  addEdit(targetFile, nodeEdit(sourceFile, source, deletionNode, ''));

  for (const instance of instances) {
    const filePath = normalizeProjectPath(instance.invocation.file);
    const range = { start: instance.invocation.start, end: instance.invocation.end };
    if (filePath === targetFile && rangeWithin(range, definitionRange)) continue;
    if (filePath === targetFile && rangesOverlap(range, definitionRange)) {
      return refuse(
        'ambiguous-usage',
        `The definition and a resolved ${component.name} invocation partially overlap in ${filePath}.`
      );
    }
    addEdit(filePath, { start: range.start, end: range.end, text: '' });
  }

  const directImportFiles = new Set<string>();
  const namedImports: {
    filePath: string;
    source: ts.SourceFile;
    file: SourceFileSnapshot;
    statement: ts.ImportDeclaration;
    specifier: ts.ImportSpecifier;
    local: string;
  }[] = [];
  const namespaceImports: {
    filePath: string;
    source: ts.SourceFile;
    file: SourceFileSnapshot;
    statement: ts.ImportDeclaration;
    local: string;
  }[] = [];
  for (const file of snapshot.files) {
    const parsed = createSourceFile(file);
    const filePath = normalizeProjectPath(file.file);
    for (const statement of parsed.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const resolution = resolveModulePath(
        filePath,
        statement.moduleSpecifier.text,
        snapshot.files
      );
      if (resolution.file !== targetFile) continue;
      const namedBindings = statement.importClause?.namedBindings;
      if (!namedBindings) continue;
      if (ts.isNamespaceImport(namedBindings)) {
        directImportFiles.add(filePath);
        namespaceImports.push({
          filePath,
          source: parsed,
          file,
          statement,
          local: namedBindings.name.text,
        });
        continue;
      }
      if (!ts.isNamedImports(namedBindings)) continue;
      for (const specifier of namedBindings.elements) {
        const importedName = (specifier.propertyName ?? specifier.name).text;
        if (importedName !== component.exportName) continue;
        directImportFiles.add(filePath);
        namedImports.push({
          filePath,
          source: parsed,
          file,
          statement,
          specifier,
          local: specifier.name.text,
        });
      }
    }
  }

  for (const instance of instances) {
    const invocationFile = normalizeProjectPath(instance.invocation.file);
    if (invocationFile !== targetFile && !directImportFiles.has(invocationFile)) {
      return refuse(
        'unsafe-dependency-closure',
        `The usage in ${instance.invocation.file} is not backed by a direct import that can be removed safely.`
      );
    }
  }

  for (const binding of namedImports) {
    if (hasBindingNamedOutsideImports(binding.source, binding.local)) {
      return refuse(
        'ambiguous-usage',
        `The import binding "${binding.local}" is shadowed in ${binding.filePath}.`
      );
    }
    if (hasShorthandReference(binding.source, binding.local)) {
      return refuse(
        'ambiguous-usage',
        `The import binding "${binding.local}" is used as a shorthand value in ${binding.filePath}.`
      );
    }
    const ranges = instanceRangesByFile.get(binding.filePath) ?? [];
    for (const reference of renameableIdentifiers(binding.source, binding.source, binding.local)) {
      const referenceRange = nodeRange(binding.file, binding.source, reference);
      if (
        !rangeWithin(
          referenceRange,
          definitionRangeForFile(binding.filePath, targetFile, definitionRange)
        ) &&
        !ranges.some((range) => rangeWithin(referenceRange, range))
      ) {
        return refuse(
          'unsafe-dependency-closure',
          `The import binding "${binding.local}" has a non-JSX reference in ${binding.filePath}.`
        );
      }
    }
    addEdit(
      binding.filePath,
      importSpecifierDeletionEdit(
        binding.file,
        binding.source,
        binding.statement,
        binding.specifier
      )
    );
  }

  for (const binding of namespaceImports) {
    if (hasBindingNamedOutsideImports(binding.source, binding.local)) {
      return refuse(
        'ambiguous-usage',
        `The namespace import "${binding.local}" is shadowed in ${binding.filePath}.`
      );
    }
    const ranges = instanceRangesByFile.get(binding.filePath) ?? [];
    for (const reference of renameableIdentifiers(binding.source, binding.source, binding.local)) {
      const referenceRange = nodeRange(binding.file, binding.source, reference);
      if (!ranges.some((range) => rangeWithin(referenceRange, range))) {
        return refuse(
          'unsafe-dependency-closure',
          `The namespace import "${binding.local}" has a non-JSX reference in ${binding.filePath}.`
        );
      }
    }
  }

  const mutations: ComponentFileMutation[] = [];
  const previews: ComponentRefactorPreview['files'] = [];
  for (const [filePath, edits] of editsByFile) {
    const file = filesByPath.get(filePath);
    if (!file) return refuse('missing-source', `The source file ${filePath} is missing.`);
    const sorted = dedupeEdits(edits);
    const after = applyTextEdits(file.content, sorted);
    if (after === null) {
      return refuse(
        'invalid-range',
        `The planned delete edits overlap or split a UTF-8 code point in ${filePath}.`
      );
    }
    if (after === file.content) continue;
    const afterHash = sha256(after);
    const diagnostics = parseDiagnosticsForSourceFile(
      createSourceFile({ ...file, content: after, contentHash: afterHash }),
      { ...file, content: after, contentHash: afterHash }
    );
    if (diagnostics.length > 0) {
      return refuse(
        'syntax-error',
        `Removing ${component.name} would leave invalid TypeScript or JSX syntax in ${filePath}.`
      );
    }
    mutations.push({
      file: filePath,
      expectedHash: file.contentHash,
      expectedResultHash: afterHash,
      edits: sorted,
    });
    previews.push({
      file: filePath,
      operation: 'edit',
      beforeHash: file.contentHash,
      afterHash,
      before: file.content,
      after,
    });
  }
  mutations.sort((left, right) => left.file.localeCompare(right.file));
  previews.sort((left, right) => left.file.localeCompare(right.file));
  if (mutations.length === 0)
    return refuse('no-op', 'No safe source references were found to delete.');

  const graphDelta: ComponentGraphDelta = {
    componentId: component.id,
    usagesBefore: component.usageCount,
    usagesAfter: 0,
    delta: -component.usageCount,
    removedComponentId: component.id,
  };
  const preview: ComponentRefactorPreview = {
    operation: 'delete',
    affectedFiles: mutations.map((mutation) => mutation.file),
    files: previews,
    graphDelta,
  };
  const operations: ComponentFileOperation[] = mutations.map((mutation) => ({
    kind: 'edit' as const,
    ...mutation,
  }));
  const plan: ComponentRefactorPlan = {
    files: [],
    operations,
    dialect: 'react',
    parserToken: REACT_COMPONENT_PLAN_PARSER_TOKEN,
    expectedRevision: snapshot.revision,
    expectedGraphDelta: graphDelta,
    operation: 'delete',
    preview,
  };
  return { status: 'planned', plan };
}

interface SourceRange {
  start: number;
  end: number;
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
  switch (extensionOf(file)) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function findDefinitionNode(
  source: ts.SourceFile,
  content: string,
  component: ComponentDescriptor
): ts.Node | null {
  const start = utf8ByteOffsetToUtf16Offset(content, component.definition.start);
  const end = utf8ByteOffsetToUtf16Offset(content, component.definition.end);
  if (start === null || end === null) return null;
  let match: ts.Node | null = null;
  const visit = (node: ts.Node) => {
    if (node.getStart(source) === start && node.end === end) match = node;
    if (!match) ts.forEachChild(node, visit);
  };
  visit(source);
  return match;
}

function declarationName(node: ts.Node): ts.Identifier | null {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return node.name ?? null;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name;
  return null;
}

function definitionDeletionNode(node: ts.Node): ts.Node | null {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return node;
  if (!ts.isVariableDeclaration(node) || !ts.isVariableStatement(node.parent.parent)) return null;
  return node.parent.parent.declarationList.declarations.length === 1 ? node.parent.parent : null;
}

function isDirectlyExported(node: ts.Node, component: ComponentDescriptor): boolean {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  }
  if (!ts.isVariableDeclaration(node) || !ts.isVariableStatement(node.parent.parent)) return false;
  if (component.exportName === 'default') return false;
  const statement = node.parent.parent;
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function hasNestedBinding(node: ts.Node, name: string): boolean {
  let unsafe = false;
  const visit = (current: ts.Node) => {
    if (current !== node && bindingNames(current).includes(name)) unsafe = true;
    if (!unsafe) ts.forEachChild(current, visit);
  };
  visit(node);
  return unsafe;
}

function bindingNames(node: ts.Node): string[] {
  if (ts.isParameter(node)) return boundNames(node.name);
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
    return [node.name.text];
  }
  if (ts.isVariableDeclaration(node)) return boundNames(node.name);
  return [];
}

function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const names: string[] = [];
  name.elements.forEach((element) => {
    if (ts.isBindingElement(element)) names.push(...boundNames(element.name));
  });
  return names;
}

function hasIdentifier(node: ts.Node, name: string): boolean {
  let found = false;
  const visit = (current: ts.Node) => {
    if (current !== node && ts.isIdentifier(current) && current.text === name) found = true;
    if (!found) ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function topLevelBindingNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) names.add(clause.name.text);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        names.add(clause.namedBindings.name.text);
      } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        clause.namedBindings.elements.forEach((element) => names.add(element.name.text));
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      statement.declarationList.declarations.forEach((declaration) =>
        boundNames(declaration.name).forEach((name) => names.add(name))
      );
      continue;
    }
    if (
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

function nodeEdit(
  file: SourceFileSnapshot,
  source: ts.SourceFile,
  node: ts.Node,
  text: string
): ComponentTextEdit {
  return {
    start: utf16OffsetToUtf8ByteOffset(file.content, node.getStart(source)),
    end: utf16OffsetToUtf8ByteOffset(file.content, node.end),
    text,
  };
}

function nodeRange(file: SourceFileSnapshot, source: ts.SourceFile, node: ts.Node): SourceRange {
  return {
    start: utf16OffsetToUtf8ByteOffset(file.content, node.getStart(source)),
    end: utf16OffsetToUtf8ByteOffset(file.content, node.end),
  };
}

function rangeWithin(range: SourceRange, container: SourceRange | null): boolean {
  return (
    container !== null &&
    range.start >= container.start &&
    range.end <= container.end &&
    range.end > range.start
  );
}

function rangesOverlap(left: SourceRange, right: SourceRange): boolean {
  return left.start < right.end && right.start < left.end;
}

function definitionRangeForFile(
  filePath: string,
  targetFile: string,
  definitionRange: SourceRange
): SourceRange | null {
  return filePath === targetFile ? definitionRange : null;
}

function importSpecifierDeletionEdit(
  file: SourceFileSnapshot,
  source: ts.SourceFile,
  statement: ts.ImportDeclaration,
  specifier: ts.ImportSpecifier
): ComponentTextEdit {
  const namedBindings = statement.importClause?.namedBindings;
  if (!namedBindings || !ts.isNamedImports(namedBindings)) {
    return nodeEdit(file, source, specifier, '');
  }
  const elements = namedBindings.elements;
  const index = elements.indexOf(specifier);
  if (index < 0) return nodeEdit(file, source, specifier, '');
  if (elements.length === 1) {
    if (statement.importClause?.name) {
      return {
        start: utf16OffsetToUtf8ByteOffset(file.content, statement.importClause.name.end),
        end: utf16OffsetToUtf8ByteOffset(file.content, namedBindings.end),
        text: '',
      };
    }
    return nodeEdit(file, source, statement, '');
  }
  if (index < elements.length - 1) {
    return {
      start: utf16OffsetToUtf8ByteOffset(file.content, specifier.getStart(source)),
      end: utf16OffsetToUtf8ByteOffset(file.content, elements[index + 1].getStart(source)),
      text: '',
    };
  }
  return {
    start: utf16OffsetToUtf8ByteOffset(file.content, elements[index - 1].end),
    end: utf16OffsetToUtf8ByteOffset(file.content, specifier.end),
    text: '',
  };
}

function renameableIdentifiers(
  source: ts.SourceFile,
  root: ts.Node,
  name: string
): ts.Identifier[] {
  const identifiers: ts.Identifier[] = [];
  const visit = (node: ts.Node) => {
    // Import specifiers are handled from their AST shape so an imported name
    // and a local alias can be treated independently.
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && node.text === name && isRenameableIdentifier(node)) {
      identifiers.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root === source ? source : root);
  return identifiers;
}

function isRenameableIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (
    (ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isJsxAttribute(parent) && parent.name === node) return false;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) {
    return false;
  }
  if (ts.isEnumMember(parent) && parent.name === node) return false;
  return true;
}

function isBindingPosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name === node) {
    return true;
  }
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.name === node) return true;
  if (ts.isTypeParameterDeclaration(parent) && parent.name === node) return true;
  if (ts.isCatchClause(parent) && parent.variableDeclaration?.name === node) return true;
  return false;
}

function hasBindingNamedOutsideImports(source: ts.SourceFile, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found || ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && node.text === name && isBindingPosition(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function hasShorthandReference(source: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found || ts.isImportDeclaration(node)) return;
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function namespacePropertyIdentifiers(
  source: ts.SourceFile,
  namespace: string,
  property: string
): ts.Identifier[] {
  const identifiers: ts.Identifier[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node)) {
      if (
        ts.isIdentifier(node.name) &&
        node.name.text === property &&
        propertyAccessRoot(node.expression) === namespace
      ) {
        identifiers.push(node.name);
      }
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
      const member = jsxMemberTail(tagName);
      if (member?.root === namespace && member.name.text === property) {
        identifiers.push(member.name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return identifiers;
}

function propertyAccessRoot(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return propertyAccessRoot(expression.expression);
  return null;
}

function jsxMemberTail(
  tagName: ts.JsxTagNameExpression
): { root: string; name: ts.Identifier } | null {
  if (!ts.isPropertyAccessExpression(tagName) || !ts.isIdentifier(tagName.name)) return null;
  const root = jsxMemberRoot(tagName.expression as ts.JsxTagNameExpression);
  return root ? { root, name: tagName.name } : null;
}

function jsxMemberRoot(tagName: ts.JsxTagNameExpression): string | null {
  if (ts.isIdentifier(tagName)) return tagName.text;
  if (ts.isPropertyAccessExpression(tagName)) {
    return jsxMemberRoot(tagName.expression as ts.JsxTagNameExpression);
  }
  return null;
}

function hasTargetReexport(
  files: readonly SourceFileSnapshot[],
  targetFile: string,
  targetExport: string | null
): boolean {
  const parsedByPath = new Map(
    files.map((file) => [normalizeProjectPath(file.file), createSourceFile(file)] as const)
  );
  const reachesTarget = (filePath: string, seen: Set<string>): boolean => {
    if (filePath === targetFile) return true;
    if (seen.has(filePath)) return false;
    seen.add(filePath);
    const source = parsedByPath.get(filePath);
    if (!source) return false;
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement)) continue;
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const resolved = resolveModulePath(filePath, statement.moduleSpecifier.text, files);
        if (resolved.file && reachesTarget(resolved.file, new Set(seen))) return true;
      }
    }
    return false;
  };

  for (const [filePath, source] of parsedByPath) {
    if (filePath === targetFile) continue;
    const targetLocals = directTargetImportLocals(
      filePath,
      source,
      files,
      targetFile,
      targetExport
    );
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement)) continue;
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const resolved = resolveModulePath(filePath, statement.moduleSpecifier.text, files);
        if (resolved.file && reachesTarget(resolved.file, new Set())) return true;
      } else if (
        targetLocals.size > 0 &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.some((element) =>
          targetLocals.has((element.propertyName ?? element.name).text)
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function directTargetImportLocals(
  filePath: string,
  source: ts.SourceFile,
  files: readonly SourceFileSnapshot[],
  targetFile: string,
  targetExport: string | null
): Set<string> {
  const locals = new Set<string>();
  if (!targetExport) return locals;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const resolved = resolveModulePath(filePath, statement.moduleSpecifier.text, files);
    if (resolved.file !== targetFile || !statement.importClause?.namedBindings) continue;
    const bindings = statement.importClause.namedBindings;
    if (!ts.isNamedImports(bindings)) continue;
    for (const specifier of bindings.elements) {
      const importedName = (specifier.propertyName ?? specifier.name).text;
      if (importedName === targetExport) locals.add(specifier.name.text);
    }
  }
  return locals;
}

function dedupeEdits(edits: readonly ComponentTextEdit[]): ComponentTextEdit[] {
  const unique = new Map<string, ComponentTextEdit>();
  for (const edit of edits) {
    unique.set(`${edit.start}:${edit.end}:${edit.text}`, { ...edit });
  }
  return [...unique.values()].sort(
    (left, right) => left.start - right.start || left.end - right.end
  );
}

function directoryOf(file: string): string {
  const normalized = normalizeProjectPath(file);
  const slash = normalized.lastIndexOf('/');
  return slash < 0 ? '' : normalized.slice(0, slash);
}

function extensionOf(file: string): string {
  const normalized = normalizeProjectPath(file);
  const dot = normalized.lastIndexOf('.');
  return dot < 0 ? '' : normalized.slice(dot).toLowerCase();
}

function refuse(
  code: Extract<RefactorResult, { status: 'refused' }>['code'],
  message: string
): Extract<RefactorResult, { status: 'refused' }> {
  return {
    status: 'refused',
    code,
    message,
    diagnostics: [{ code: `refactor-${code}`, severity: 'warning', message }],
  };
}
