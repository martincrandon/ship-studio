import type { ProjectType } from '@/lib/static-server';

/** A stable source identity within one indexed project. */
export type ComponentId = string;

/** A stable source invocation identity within one indexed project revision. */
export type ComponentInstanceId = string;

export type ComponentDialect =
  | 'react'
  | 'astro'
  | 'vue'
  | 'svelte'
  | 'shopify'
  | 'web-component'
  | 'react-native'
  | 'flutter';

export type ComponentKind =
  | 'component'
  | 'layout'
  | 'section'
  | 'block'
  | 'snippet'
  | 'custom-element'
  | 'widget';

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

/** All diagnostics are structured so callers never need to parse UI strings. */
export interface ComponentDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  file?: string;
  source?: SourceRef;
}

/**
 * A source range is serialized in UTF-8 bytes, not JavaScript UTF-16 code
 * units. Rust applies mutation edits to bytes, so this distinction is part of
 * the wire contract.
 */
export interface SourceRef {
  file: string;
  start: number;
  end: number;
  line: number;
  column: number;
  contentHash: string;
}

export type StaticPrimitive = string | number | boolean | null;

/** Values which an adapter can print without evaluating project code. */
export type StaticValue =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null'; value: null }
  | { kind: 'array'; value: StaticValue[] }
  | { kind: 'object'; value: Record<string, StaticValue> };

export type StaticExpression = {
  kind: 'static';
  value: StaticValue;
  source: SourceRef;
};

export type DynamicExpression = {
  kind: 'dynamic';
  text: string;
  reason: string;
  source: SourceRef;
};

export type UnsetExpression = {
  kind: 'unset';
};

export type ComponentPropExpression = StaticExpression | DynamicExpression | UnsetExpression;

export interface ComponentPropDescriptor {
  name: string;
  required: boolean;
  typeText: string | null;
  defaultValue: StaticValue | null;
  choices: StaticValue[] | null;
  control: 'text' | 'number' | 'boolean' | 'select' | 'asset' | 'readonly';
  source: SourceRef;
  diagnostics: ComponentDiagnostic[];
}

export interface ComponentSlotDescriptor {
  name: string;
  required: boolean;
  scoped: boolean;
  source: SourceRef;
}

export interface ComponentSlotValue {
  name: string;
  value: ComponentPropExpression | null;
  /** Exact authored slot text when the adapter can expose it losslessly. */
  sourceText?: string;
  /** Direct, statically indexed component children in this slot. */
  children?: ComponentSlotChild[];
}

export interface ComponentSlotChild {
  instanceId: ComponentInstanceId;
  componentId: ComponentId;
  name: string;
  invocation: SourceRef;
}

/**
 * A source-derived signature for the host root returned by a React component.
 * It is intentionally narrower than a runtime boundary: only stable intrinsic
 * roots with static identity attributes are eligible for Next Server
 * Component provenance.
 */
export interface ComponentRenderRoot {
  tag: string;
  classTokens: string[];
  id: string | null;
  source: SourceRef;
}

export interface ComponentDescriptor {
  id: ComponentId;
  dialect: ComponentDialect;
  kind: ComponentKind;
  name: string;
  /** Identifier used inside the definition module, before export aliases. */
  localName: string;
  exportName: string | null;
  description: string | null;
  definition: SourceRef;
  /** True when the source file declares a React `use client` boundary. */
  isClientModule?: boolean;
  /** Stable root signature used by the Next Server Component fallback. */
  renderRoot?: ComponentRenderRoot;
  props: ComponentPropDescriptor[];
  slots: ComponentSlotDescriptor[];
  variantProps: string[];
  usageCount: number;
  capabilities: ComponentCapabilities;
  diagnostics: ComponentDiagnostic[];
}

export interface ComponentInstance {
  id: ComponentInstanceId;
  componentId: ComponentId;
  invocation: SourceRef;
  containingComponentId: ComponentId | null;
  route: string | null;
  props: Record<string, ComponentPropExpression>;
  slots: ComponentSlotValue[];
  /** Exact authored ranges for static slot content, when the adapter can prove them. */
  slotSources?: Record<string, ComponentSlotSource>;
}

export interface ComponentSlotSource extends SourceRef {
  /** Exact authored slot body, when the adapter returned it with the range. */
  text?: string;
}

export interface ComponentImportEdge {
  fromFile: string;
  toFile: string | null;
  importedName: string | null;
  localName: string | null;
  source: SourceRef;
  status: 'resolved' | 'unresolved' | 'external' | 'ambiguous';
  diagnostics: ComponentDiagnostic[];
}

export interface ComponentCapabilities {
  catalog: boolean;
  usageGraph: boolean;
  definitionBinding: boolean;
  instanceBinding: boolean;
  place: boolean;
  editStaticProps: boolean;
  editSlots: boolean;
  editMain: boolean;
  /** A validated runtime boundary can be projected into the Element Tree. */
  componentTreeBoundary: boolean;
  /** Definition writes are proven for the focused visual-editing workflow. */
  focusedVisualEditing: boolean;
  duplicateDefinition: boolean;
  renameDefinition: boolean;
  deleteDefinition: boolean;
  extract: boolean;
  isolatedPreview: boolean;
  /** Lifecycle writes are optional until an adapter proves each operation. */
}

export interface ComponentFrameworkProfile {
  projectType: ProjectType | null;
  primaryDialect: ComponentDialect | null;
  dialects: ComponentDialect[];
  workspaceRoot: string;
  capabilities: Record<ComponentDialect, ComponentCapabilities>;
  diagnostics: ComponentDiagnostic[];
}

export interface SourceFileSnapshot {
  /** Project-relative POSIX path. */
  file: string;
  content: string;
  /** SHA-256 of the complete UTF-8 file contents. */
  contentHash: string;
}

export interface ComponentSourceSnapshot {
  /** Project-relative workspace root, or "." for a project root. */
  workspaceRoot: string;
  /** Deterministic source revision (normally SHA-256 over the inventory). */
  revision: string;
  files: SourceFileSnapshot[];
  partial: boolean;
  diagnostics: ComponentDiagnostic[];
}

export interface SourceFileChange {
  file: string;
  content: string;
  contentHash: string;
  kind?: 'created' | 'changed' | 'deleted';
}

/** Metadata-only event emitted after the Rust source watcher settles a burst. */
export interface ComponentSourceChangeEvent {
  windowLabel: string;
  projectPath: string;
  revision: string;
  changedFiles: string[];
}

export interface ComponentIndex {
  revision: string;
  /** True when source or graph diagnostics mean the catalog may be incomplete. */
  partial: boolean;
  /**
   * Exact project-relative files the worker needs for the next bounded
   * internal-package resolution round. The list is metadata only; the main
   * thread must satisfy it through the validated Rust batch-read command.
   */
  needSources?: string[];
  profile: ComponentFrameworkProfile;
  components: ComponentDescriptor[];
  instances: ComponentInstance[];
  importEdges: ComponentImportEdge[];
  diagnostics: ComponentDiagnostic[];
}

export type BindingConfidence = 'exact' | 'sourceAnchored' | 'ambiguous' | 'none';

export interface RuntimeSourceFrame {
  renderer: ComponentDialect | 'unknown';
  file: string;
  line: number;
  column: number;
  symbolHint: string | null;
  runtimeKey: string | null;
}

export interface SelectionBindingInput {
  file?: string | null;
  line?: number | null;
  column?: number | null;
  symbolHint?: string | null;
  sourceHash?: string | null;
  candidates?: RuntimeSourceFrame[];
}

export interface ComponentBindingCandidate {
  componentId: ComponentId;
  instanceId?: ComponentInstanceId;
  source: SourceRef;
  confidence: Exclude<BindingConfidence, 'none' | 'ambiguous'>;
}

export type ComponentBinding =
  | {
      confidence: 'exact' | 'sourceAnchored';
      componentId: ComponentId;
      instanceId?: ComponentInstanceId;
      source: SourceRef;
      candidates: ComponentBindingCandidate[];
      diagnostics: ComponentDiagnostic[];
    }
  | {
      confidence: 'ambiguous';
      candidates: ComponentBindingCandidate[];
      diagnostics: ComponentDiagnostic[];
    }
  | {
      confidence: 'none';
      candidates: [];
      diagnostics: ComponentDiagnostic[];
    };

/**
 * The raw DOM tree received from the preview bridge. This deliberately lives
 * in the component library rather than importing the visual editor's hook:
 * the component projection is a pure, framework-agnostic navigation layer.
 *
 * `id`/`cls` mirror the current compact Element Tree wire shape. Consumers
 * that already use the more descriptive names may pass
 * `ComponentTreeElementInput` instead; the projection normalizes both.
 */
export interface RawComponentTreeNode {
  id: number;
  tag: string;
  cls: string;
  text: string;
  /** The authored HTML id, when the preview bridge can provide one. */
  idAttr?: string;
  children: RawComponentTreeNode[];
}

export interface ComponentTreeElementInput {
  nodeId: number;
  tag: string;
  className: string;
  text: string;
  children: ComponentTreeElementInput[];
}

export type ComponentTreeNodeInput = RawComponentTreeNode | ComponentTreeElementInput;

/**
 * A source/runtime association proposed for one component boundary. Runtime
 * owner data is only a hint: `projectComponentTree` validates every exact
 * hint against the current immutable index before it can hide DOM children.
 */
export interface ComponentBoundaryHint {
  key?: string;
  componentId?: ComponentId | null;
  instanceId?: ComponentInstanceId | null;
  confidence: BindingConfidence;
  hostNodeIds: readonly number[];
  definition?: SourceRef | null;
  invocation?: SourceRef | null;
  /** An omitted revision is accepted for callers that already hold the index. */
  indexRevision?: string | null;
  diagnostics?: ComponentDiagnostic[];
  /** Convenience shape for callers that already resolved a selection binding. */
  binding?: ComponentBinding;
}

/** A validated boundary safe for projection and focus entry. */
export interface ComponentBoundary {
  key: string;
  componentId: ComponentId;
  instanceId: ComponentInstanceId;
  name: string;
  confidence: 'exact';
  hostNodeIds: number[];
  definition: SourceRef;
  invocation: SourceRef;
  indexRevision: string;
}

export interface ComponentBoundaryValidation {
  status: 'valid' | 'refused';
  boundary?: ComponentBoundary;
  diagnostics: ComponentDiagnostic[];
}

/**
 * The discriminated tree consumed by an Element Tree renderer. A component
 * row is virtual navigation state and never corresponds to an element added
 * to the project DOM. Its children are intentionally empty until its exact
 * boundary is in the focus ancestry.
 */
export type ComponentAwareTreeNode =
  | {
      kind: 'element';
      nodeId: number;
      tag: string;
      className: string;
      text: string;
      children: ComponentAwareTreeNode[];
    }
  | {
      kind: 'component';
      key: string;
      componentId: ComponentId;
      instanceId: ComponentInstanceId;
      name: string;
      confidence: 'exact';
      hostNodeIds: number[];
      definition: SourceRef;
      invocation: SourceRef;
      children: ComponentAwareTreeNode[];
    };

export interface ComponentTreeProjectionInput {
  /** The raw tree (or a tree using the descriptive `nodeId` shape). */
  tree: ComponentTreeNodeInput | null;
  /** Source/runtime boundary hints collected in one batch for this tree. */
  boundaries?: readonly ComponentBoundaryHint[];
  /** Alias useful to callers that call these runtime associations bindings. */
  bindings?: readonly ComponentBoundaryHint[];
  index: ComponentIndex;
  focus?: ComponentFocusSession | null;
  truncated?: boolean;
}

export interface ComponentTreeProjection {
  /** Canonical root for new consumers. */
  tree: ComponentAwareTreeNode | null;
  /** Alias for renderers that call the projected root `root`. */
  root: ComponentAwareTreeNode | null;
  revision: string;
  truncated: boolean;
  /** Only boundaries that passed source/hash/host validation. */
  boundaries: ComponentBoundary[];
  diagnostics: ComponentDiagnostic[];
}

export interface ComponentFocusLevel {
  componentId: ComponentId;
  instanceId: ComponentInstanceId;
  name: string;
  hostNodeIds: number[];
  definition: SourceRef;
  invocation: SourceRef;
  indexRevision: string;
}

/** Revision-bound capability used by focused CSS/Visual/Agent workflows. */
export interface ComponentFocusSession extends ComponentFocusLevel {
  /** Outer-to-inner levels; the current level is represented by the fields above. */
  ancestry: ComponentFocusLevel[];
  /** Route identity is opaque and supplied by the host; it is never inferred. */
  routeKey: string | null;
}

export type ComponentFocusRefusalCode =
  | 'no-index'
  | 'not-exact'
  | 'missing-component'
  | 'missing-instance'
  | 'identity-mismatch'
  | 'stale-revision'
  | 'stale-source'
  | 'invalid-host'
  | 'route-changed'
  | 'not-focused';

export interface ComponentFocusDiagnostic extends ComponentDiagnostic {
  code: ComponentFocusRefusalCode;
}

export type ComponentFocusTransition =
  | { status: 'entered'; session: ComponentFocusSession }
  | { status: 'changed'; session: ComponentFocusSession | null }
  | { status: 'refused'; code: ComponentFocusRefusalCode; diagnostics: ComponentDiagnostic[] };

export interface ComponentTextEdit {
  /** UTF-8 byte offsets into the complete expected source file. */
  start: number;
  end: number;
  text: string;
}

export interface ComponentFileMutation {
  file: string;
  expectedHash: string;
  expectedResultHash: string;
  edits: ComponentTextEdit[];
}

/** Local review data generated from a hash-checked mutation plan. */
export interface ComponentMutationFilePreview {
  file: string;
  beforeHash: string;
  afterHash: string;
  /** A compact, unified source diff. It never leaves the local review UI. */
  diff: string;
  additions: number;
  deletions: number;
}

/** A mutation remains unapplied until the user approves this preview. */
export interface ComponentMutationPreview {
  plan: ComponentMutationPlan;
  files: ComponentMutationFilePreview[];
}

/**
 * Filesystem operations emitted by a pure adapter refactor planner.  The
 * legacy `ComponentFileMutation` shape remains supported for placement and
 * prop edits; lifecycle plans use this explicit union so Rust can stage the
 * complete transaction before touching project source.
 */
export type ComponentFileOperation =
  | ({ kind: 'edit' } & ComponentFileMutation)
  | {
      kind: 'create';
      file: string;
      expectedAbsent: true;
      contents: string;
      expectedResultHash?: string;
    }
  | {
      kind: 'move';
      from: string;
      to: string;
      expectedHash: string;
      expectedAbsent: true;
      expectedResultHash?: string;
    }
  | { kind: 'delete'; file: string; expectedHash: string };

export interface ComponentRefactorFilePreview {
  file: string;
  operation: ComponentFileOperation['kind'];
  beforeHash: string | null;
  afterHash: string | null;
  /** Complete before/after text is local review data, never telemetry data. */
  before?: string;
  after?: string;
}

export interface ComponentRefactorPreview {
  operation: 'duplicate' | 'rename' | 'delete';
  affectedFiles: string[];
  files: ComponentRefactorFilePreview[];
  graphDelta: ComponentGraphDelta;
}

export interface ComponentMutationPlan {
  files: ComponentFileMutation[];
  /** Present for lifecycle plans; omitted by the existing edit-only path. */
  operations?: ComponentFileOperation[];
  dialect?: ComponentDialect;
  parserToken?: string;
  expectedRevision: string;
  expectedGraphDelta?: ComponentGraphDelta;
  warnings?: ComponentDiagnostic[];
}

/** Relative source paths committed by the guarded Rust mutation command. */
export interface AppliedComponentMutation {
  changedFiles: string[];
}

export interface ComponentGraphDelta {
  componentId: ComponentId;
  usagesBefore: number;
  usagesAfter: number;
  delta: number;
  /** Lifecycle planners may describe the source identity created/removed. */
  createdComponentId?: ComponentId;
  removedComponentId?: ComponentId;
  createdUsages?: number;
}

export type MutationRefusalCode =
  | 'missing-source'
  | 'missing-anchor'
  | 'ambiguous-anchor'
  | 'not-placeable'
  | 'required-prop'
  | 'dynamic-expression'
  | 'unknown-prop'
  | 'unsupported'
  | 'symbol-collision'
  | 'dependency-cycle'
  | 'stale-source'
  | 'invalid-range'
  | 'syntax-error'
  | 'missing-slot'
  | 'dynamic-slot'
  | 'missing-prop-approval'
  | 'no-op';

export type ExtractionRefusalCode =
  | 'missing-source'
  | 'stale-source'
  | 'partial-snapshot'
  | 'unsupported'
  | 'invalid-name'
  | 'path-collision'
  | 'invalid-range'
  | 'dynamic-scope'
  | 'dynamic-expression'
  | 'missing-prop-approval'
  | 'symbol-collision'
  | 'server-client-boundary'
  | 'syntax-error'
  | 'no-op';

export type RefactorRefusalCode =
  | 'missing-source'
  | 'stale-source'
  | 'incomplete-graph'
  | 'unresolved-usage'
  | 'ambiguous-usage'
  | 'dynamic-usage'
  | 'shared-file'
  | 'unsafe-dependency-closure'
  | 'invalid-name'
  | 'reserved-name'
  | 'path-collision'
  | 'symbol-collision'
  | 'case-only-rename'
  | 'public-api'
  | 'cross-workspace'
  | 'usages-remain'
  | 'unsupported'
  | 'invalid-range'
  | 'syntax-error'
  | 'no-op';

export interface DuplicateComponentInput {
  kind?: 'duplicate';
  componentId: ComponentId;
  newName: string;
  /** User-confirmed project-relative destination source file. */
  destinationFile: string;
  snapshot?: ComponentSourceSnapshot;
}

export interface RenameComponentInput {
  kind?: 'rename';
  componentId: ComponentId;
  newName: string;
  /** Moving a dedicated file is opt-in; shared files always refuse. */
  renameFile?: boolean;
  snapshot?: ComponentSourceSnapshot;
}

export interface DeleteComponentInput {
  kind?: 'delete';
  componentId: ComponentId;
  /** Destructive all-usage removal must be separately confirmed by the UI. */
  removeAllUsages?: boolean;
  deleteFile?: boolean;
  snapshot?: ComponentSourceSnapshot;
}

export interface ComponentRefactorPlan extends ComponentMutationPlan {
  operation: 'duplicate' | 'rename' | 'delete';
  preview: ComponentRefactorPreview;
}

export type RefactorResult =
  | { status: 'planned'; plan: ComponentRefactorPlan }
  | {
      status: 'refused';
      code: RefactorRefusalCode;
      message: string;
      diagnostics: ComponentDiagnostic[];
    };

export type MutationResult =
  | { status: 'planned'; plan: ComponentMutationPlan }
  | {
      status: 'refused';
      code: MutationRefusalCode;
      message: string;
      diagnostics: ComponentDiagnostic[];
    };

export interface ComponentInsertionAnchor {
  file: string;
  line: number;
  column?: number | null;
  /** The source/rendered element text used to disambiguate the line anchor. */
  html: string;
  position: 'before' | 'after' | 'inside';
}

export interface InsertComponentInput {
  kind: 'insert';
  componentId: ComponentId;
  anchor: ComponentInsertionAnchor;
  /** Explicit values only; defaults are read from the component descriptor. */
  props?: Record<string, StaticValue>;
  snapshot?: ComponentSourceSnapshot;
  /** Lower-level exact AST range for callers with a validated source anchor. */
  targetRange?: { start: number; end: number; openingEnd?: number; closingStart?: number };
}

export interface EditComponentPropInput {
  kind: 'prop';
  instanceId: ComponentInstanceId;
  propName: string;
  /** Defaults to `set` for backwards-compatible callers that predate reset. */
  operation?: 'set' | 'remove';
  /** Required for `set`; omitted for `remove`. */
  value?: StaticValue;
  snapshot?: ComponentSourceSnapshot;
}

export interface EditComponentSlotInput {
  kind: 'slot';
  instanceId: ComponentInstanceId;
  /** React uses `children`; markup adapters use `default` plus explicit names. */
  slotName: string;
  /** Defaults to `replace`; structured composition uses the other operations. */
  operation?: 'replace' | 'insert' | 'remove' | 'reorder';
  /** Replacement source for the slot body. It must be static JSX/markup. */
  replacementSource?: string;
  /** Existing indexed definition to place into a static slot. */
  componentId?: ComponentId;
  /** Existing indexed child to remove or move. */
  childInstanceId?: ComponentInstanceId;
  /** Existing indexed child before which an inserted/moved child is placed. */
  beforeChildInstanceId?: ComponentInstanceId;
  /** Explicit placement values for a structured slot insertion. */
  props?: Record<string, StaticValue>;
  snapshot?: ComponentSourceSnapshot;
}

export interface ExtractComponentInput {
  kind?: 'extract';
  /** Exact source span of one JSX subtree selected in the preview. */
  source: SourceRef;
  componentName: string;
  /** User-confirmed project-relative destination beside the source module. */
  destinationFile: string;
  /** Omit on the proposal round; supply the complete approved set to plan. */
  approvedPropNames?: string[];
  snapshot?: ComponentSourceSnapshot;
}

/** Narrow source-only unlink transform; it never deletes the original definition. */
export interface InlineSimpleComponentInput {
  kind: 'inline';
  instanceId: ComponentInstanceId;
  snapshot?: ComponentSourceSnapshot;
}

export type ComponentExtractionInput = ExtractComponentInput | InlineSimpleComponentInput;

export interface ComponentExtractionProposal {
  operation: 'extract' | 'inline';
  componentName: string;
  destinationFile: string;
  source: SourceRef;
  /** Free variables that must cross the new component boundary. */
  proposedPropNames: string[];
  /** Imported bindings that will be preserved in the new source file. */
  preservedImports: string[];
  diagnostics: ComponentDiagnostic[];
}

export interface ComponentExtractionFilePreview {
  file: string;
  operation: ComponentFileOperation['kind'];
  beforeHash: string | null;
  afterHash: string | null;
  before?: string;
  after?: string;
}

export interface ComponentExtractionPreview {
  operation: 'extract' | 'inline';
  componentName: string;
  destinationFile: string;
  proposedPropNames: string[];
  preservedImports: string[];
  affectedFiles: string[];
  files: ComponentExtractionFilePreview[];
  graphDelta: ComponentGraphDelta;
}

export interface ComponentExtractionPlan extends ComponentMutationPlan {
  operation: 'extract' | 'inline';
  preview: ComponentExtractionPreview;
}

export type ExtractionResult =
  | { status: 'needs-approval'; proposal: ComponentExtractionProposal }
  | { status: 'planned'; plan: ComponentExtractionPlan }
  | {
      status: 'refused';
      code: ExtractionRefusalCode;
      message: string;
      diagnostics: ComponentDiagnostic[];
    };

export type ComponentMutationInput =
  | InsertComponentInput
  | EditComponentPropInput
  | EditComponentSlotInput;

export interface MutationValidationInput {
  plan: ComponentMutationPlan;
  snapshot: ComponentSourceSnapshot;
}

export type MutationValidationResult =
  | { status: 'valid'; diagnostics: ComponentDiagnostic[] }
  | { status: 'invalid'; diagnostics: ComponentDiagnostic[] };
