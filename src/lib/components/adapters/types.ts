import type * as ts from 'typescript';
import type {
  ComponentBinding,
  ComponentCapabilities,
  ComponentDialect,
  ComponentIndex,
  ComponentImportEdge,
  ComponentInstance,
  ComponentMutationInput,
  ComponentPropDescriptor,
  ComponentSourceSnapshot,
  ComponentTextEdit,
  ComponentDescriptor,
  ComponentDiagnostic,
  ComponentTreeProjection,
  ComponentTreeProjectionInput,
  DeleteComponentInput,
  DuplicateComponentInput,
  RenameComponentInput,
  InsertComponentInput,
  EditComponentPropInput,
  EditComponentSlotInput,
  MutationResult,
  MutationValidationInput,
  MutationValidationResult,
  RefactorResult,
  SelectionBindingInput,
  SourceFileSnapshot,
  SourceRef,
} from '../types';

export interface DetectionContext {
  projectType?: string | null;
  packageJson?: unknown;
  files: readonly SourceFileSnapshot[];
}

export interface DialectDetection {
  detected: boolean;
  confidence: 'high' | 'medium' | 'low';
  diagnostics: ComponentDiagnostic[];
}

export interface ParseContext {
  workspaceRoot: string;
  knownFiles: readonly SourceFileSnapshot[];
}

export interface ResolveContext {
  workspaceRoot: string;
  files: readonly ParsedComponentFile[];
  /** All source/manifest DTOs in the current request, including needSources. */
  sourceFiles?: readonly SourceFileSnapshot[];
}

export interface GraphContext {
  workspaceRoot: string;
  files: readonly ParsedComponentFile[];
  revision: string;
  /** All source/manifest DTOs in the current request, including needSources. */
  sourceFiles?: readonly SourceFileSnapshot[];
}

export interface RawImportEdge {
  fromFile: string;
  source: string;
  importedName: string | null;
  localName: string | null;
  isDefault: boolean;
  isNamespace: boolean;
  sourceRef: SourceRef;
}

export interface ResolvedImportEdge extends RawImportEdge {
  toFile: string | null;
  status: 'resolved' | 'unresolved' | 'external' | 'ambiguous';
  diagnostics: ComponentDiagnostic[];
}

export interface RawJsxAttribute {
  name: string;
  source: SourceRef;
  valueSource: SourceRef | null;
  expressionText: string | null;
  staticValue: import('../types').StaticValue | null;
  dynamicReason: string | null;
}

export interface RawJsxUsage {
  tagName: string;
  localName: string | null;
  namespaceName: string | null;
  invocation: SourceRef;
  attributes: RawJsxAttribute[];
  childrenSource: SourceRef | null;
  /** Exact named-slot bodies discovered in markup invocation syntax. */
  slotSources?: Record<string, SourceRef>;
  containingLocalName: string | null;
  node: ts.JsxElement | ts.JsxSelfClosingElement;
}

export interface ParsedComponentDefinition {
  localName: string;
  exportName: string | null;
  descriptor: ComponentDescriptor;
  declaration: ts.Node;
  props: ComponentPropDescriptor[];
  capabilities: ComponentCapabilities;
  isDefault: boolean;
}

export interface ParsedComponentFile {
  snapshot: SourceFileSnapshot;
  sourceFile: ts.SourceFile;
  components: ParsedComponentDefinition[];
  imports: RawImportEdge[];
  usages: RawJsxUsage[];
  exports: Map<string, string>;
  reExports: RawImportEdge[];
  diagnostics: ComponentDiagnostic[];
}

export interface AdapterGraph {
  components: ComponentDescriptor[];
  instances: ComponentInstance[];
  importEdges: ComponentImportEdge[];
  diagnostics: ComponentDiagnostic[];
}

export interface SelectionBindingInputWithIndex extends SelectionBindingInput {
  index?: ComponentIndex;
}

export interface InsertComponentInputWithContext extends InsertComponentInput {
  snapshot?: ComponentSourceSnapshot;
}

export interface EditComponentPropInputWithContext extends EditComponentPropInput {
  snapshot?: ComponentSourceSnapshot;
}

export interface EditComponentSlotInputWithContext extends EditComponentSlotInput {
  snapshot?: ComponentSourceSnapshot;
}

export interface DuplicateComponentInputWithContext extends DuplicateComponentInput {
  snapshot?: ComponentSourceSnapshot;
}

export interface RenameComponentInputWithContext extends RenameComponentInput {
  snapshot?: ComponentSourceSnapshot;
}

export interface DeleteComponentInputWithContext extends DeleteComponentInput {
  snapshot?: ComponentSourceSnapshot;
}

export interface ComponentAdapter {
  readonly dialect: ComponentDialect;
  /** Capability profile used even when a snapshot has no concrete definition. */
  readonly capabilities?: ComponentCapabilities;
  detect(context: DetectionContext): DialectDetection;
  accepts(path: string): boolean;
  parseFile(file: SourceFileSnapshot, context: ParseContext): ParsedComponentFile;
  resolveImport(edge: RawImportEdge, context: ResolveContext): ResolvedImportEdge;
  buildUsageGraph(files: ParsedComponentFile[], context: GraphContext): AdapterGraph;
  bindSelection(input: SelectionBindingInput, index: ComponentIndex): ComponentBinding;
  /**
   * Optional dialect-specific seam for collecting/normalizing runtime
   * boundaries. The shared projector remains the default so new adapters can
   * participate without owning DOM wrappers or filesystem access.
   */
  projectTree?(input: ComponentTreeProjectionInput, index: ComponentIndex): ComponentTreeProjection;
  planInsert(input: InsertComponentInputWithContext, index: ComponentIndex): MutationResult;
  planPropEdit(input: EditComponentPropInputWithContext, index: ComponentIndex): MutationResult;
  /** Optional static slot edit seam; only adapters with exact slot ranges opt in. */
  planSlotEdit?(input: EditComponentSlotInputWithContext, index: ComponentIndex): MutationResult;
  /** Optional until a dialect can prove a definition-level duplicate transaction. */
  planDuplicate?(input: DuplicateComponentInputWithContext, index: ComponentIndex): RefactorResult;
  /** Optional until a dialect can prove graph-wide definition references. */
  planRename?(input: RenameComponentInputWithContext, index: ComponentIndex): RefactorResult;
  /** Optional until a dialect can prove every destructive definition reference. */
  planDelete?(input: DeleteComponentInputWithContext, index: ComponentIndex): RefactorResult;
  validateMutation(input: MutationValidationInput): MutationValidationResult;
  /**
   * Optional async validation seam for browser/WASM compilers. Adapters with
   * synchronous parser runtimes can rely on `validateMutation` alone.
   */
  validateMutationAsync?(input: MutationValidationInput): Promise<MutationValidationResult>;
}

export interface ReactParseResult {
  parsed: ParsedComponentFile;
  textEdits?: ComponentTextEdit[];
}

export type ReactMutationInput = ComponentMutationInput;
