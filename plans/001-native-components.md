# Plan 001: Add code-native Components to Ship Studio

> **Executor instructions**: Follow this plan in order. Treat every numbered
> phase as a separately reviewable delivery; do not implement all phases in one
> pull request. Run each phase's targeted verification before proceeding. Ask
> the operator before running the repository's long full-suite commands, as
> required by `AGENTS.md`. If a STOP condition occurs, stop and report it rather
> than widening the feature or guessing.
>
> **Drift check (run first)**:
> `git diff --stat b552fb21..HEAD -- package.json pnpm-lock.yaml src src-tauri docs`
> Then run `git status --short`. The working tree was already dirty when this
> plan was written, including changes to `src/components/preview/Preview.tsx`,
> `src/lib/edit.ts`, and visual-editor files. Do not overwrite, discard, or fold
> those changes into this feature. If they still exist, use a clean worktree or
> get the owner's explicit coordination before editing overlapping files.

## Status

- **Priority**: P1
- **Effort**: L, split across multiple pull requests
- **Risk**: HIGH
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `b552fb21`, 2026-08-29

## Executive decision

This feature is feasible, provided “Components” means a common Ship Studio
experience over framework-native component definitions rather than a new Ship
Studio runtime. The source project remains the authority: a React component is
still React, an Astro component is still `.astro`, a Vue component is still a
Single-File Component, and a Shopify section or block remains Liquid plus its
schema. Editing a component definition naturally updates all instances because
the framework already supplies that behavior.

The feasible first product is:

1. Detect and catalog native components without running project code.
2. Show definitions, props, slots, usage counts, diagnostics, and source links.
3. Place components through parser-backed source edits.
4. Edit statically-authored instance props when Ship Studio can prove the exact
   invocation site.
5. Enter an explicit **Edit main** mode for structure and style edits that affect
   every instance.
6. Refuse dynamic or ambiguous edits instead of fabricating values or source
   locations.

The first supported visual-editing cohort should be React in Next.js/Vite and
native Astro components. Vue/Nuxt, Svelte/SvelteKit, Shopify, and native Web
Components then plug into the same index and UI through adapters. React Native
and Flutter can have a source catalog later, but Webflow-like click-to-instance
editing is a separate mobile-runtime project because Ship Studio currently
receives only mirrored pixels from those previews.

Do **not** market the initial release as universal Webflow parity. In particular,
an isolated component canvas, arbitrary slot editing, component extraction,
cross-project libraries, and unlinking are later capabilities with stricter
framework-specific prerequisites.

## Why this matters

Ship Studio already exposes a Webflow-like rendered element tree and source-safe
visual edits, but it treats the selected result primarily as DOM. Users cannot
browse their reusable source components, insert them deliberately, edit their
inputs, or reliably understand their usage graph. Adding a framework-aware
component index closes that gap without hiding or replacing the code users and
agents already maintain.

The design also replaces the current component-usage heuristic with a reusable
source graph. That graph becomes shared infrastructure for safe refactors,
“where used,” navigation, instance editing, and future extraction workflows.

## Product vocabulary and invariants

Use these terms consistently in types, UI copy, analytics, and documentation:

- **Definition**: the framework-native source declaration or file that defines
  reusable behavior and markup.
- **Instance**: one statically identifiable invocation, placement, section/block
  entry, or custom-element occurrence in source. A rendered DOM node is not by
  itself an instance. Counts mean source invocation sites; a call inside a loop
  is one source usage with dynamic runtime multiplicity, never a guessed number
  of rendered copies.
- **Prop**: an input declared by the framework. Shopify schema settings map to
  props. Only explicit source values may be displayed.
- **Slot**: a declared insertion point or child-content input. React's `children`
  is the default slot; named React props that accept renderable content remain
  props unless metadata explicitly promotes them.
- **Variant**: an explicit finite-choice prop/settings control. Never infer a
  variant from class names or visual differences. TypeScript literal unions,
  enums, Shopify `select`/`radio` settings, and explicit metadata may provide
  variant choices.
- **Edit instance**: change the exact invocation's statically-authored props or
  slot content.
- **Edit main**: edit the definition. Structure/style/content changes in this
  mode affect all instances by changing native source.
- **Binding confidence**: `exact`, `sourceAnchored`, `ambiguous`, or `none`.
  Writes are permitted only for `exact`; `sourceAnchored` may open the definition
  and support main editing, but must not claim a particular invocation.

Hard invariants:

1. Source code and native framework semantics are authoritative.
2. Ship Studio does not execute project modules, framework config, or arbitrary
   build code to build the catalog.
3. Ship Studio never constructs a route, default prop value, preview, or usage
   that was not returned by a source adapter or the running framework.
4. Every write is path-validated, hash-checked, parsed before commit, and
   fail-closed on ambiguity.
5. Read-only indexing support and write support are separate capabilities.
6. Component support is not gated by Tailwind or the existing style-editor gate.

## Current state in Ship Studio

The executor starts from these facts; confirm them against live code after the
drift check:

- `src-tauri/src/types.rs:9-31` and `src/lib/static-server.ts:11-23` define a
  coarse `ProjectType`: Next.js, SvelteKit, Astro, Nuxt, Vite, static HTML,
  React Native, Flutter, Shopify, Generic, and Unknown. `Vite` deliberately does
  not identify its UI library, and Astro may contain multiple island frameworks.
  Therefore `ProjectType` cannot be the component-adapter discriminator.
- `src-tauri/src/commands/projects/detection.rs:66-230` detects framework
  sentinels and dependencies. `src-tauri/src/utils.rs:1158` resolves an active
  monorepo `workspace_subpath`. Component scanning must begin at that resolved
  workspace. The worker may request statically imported files outside it only
  through a second path-validated Rust read beneath the project root.
- `src/lib/editorGate.ts:21-55` only enables the current visual editor for
  Next.js, Astro, Shopify, and React-flavoured Vite, with a separate CSS mode for
  a smaller cohort. The Components panel needs its own capability gate so a
  read-only catalog can exist even when style editing cannot.
- `src-tauri/src/proxy/mod.rs:69-89` injects
  `src-tauri/src/proxy/select_script.html` into web preview HTML. The script's
  `sig()` at line 394 emits DOM/class/text data and a best-effort source frame.
  `ssSource()` at lines 268-290 uses React development Fiber information, and
  its own comment correctly treats it as a hint rather than authority.
- `src/components/edit/ElementTreePanel.tsx:1-58` and
  `src/hooks/useElementTree.ts` already provide a rendered DOM navigator and a
  selection protocol. Reuse this shell and selection state; do not create a
  second iframe inspector.
- `src-tauri/src/commands/edit_structure.rs:1-20` implements fail-closed,
  class-anchored insert/duplicate/delete operations through surgical text edits.
  It is useful precedent but not an adequate component parser.
- `src-tauri/src/commands/edit.rs:2641-2850` currently finds component usage by
  scanning upward for PascalCase declarations and searching files for raw
  `<Name` text. It does not resolve imports, aliases, re-exports, namespaces,
  loops, or Vue/Svelte syntax. Retain it during migration, then route its public
  UI consumer to the new index and delete the heuristic only after equivalence
  tests pass.
- `src/hooks/useVisualEditor.ts:420-475` performs the current best-effort usage
  lookup after resolving a selection. `src/components/edit/UsageScope.tsx`
  renders the result. These are the migration seam for index-backed binding and
  usage information.
- `docs/visual-editor-css-mode.md:26-43` establishes the correct reliability
  policy: narrow conventions, typed read-only states, and fail-closed writes.
  Apply the same policy here.
- `src-tauri/Cargo.toml:58-73` already includes `ignore`, `notify`, and `sha2`,
  which cover filtered walking, incremental invalidation, and content hashes.
- `src-tauri/tauri.conf.json:25-36` demonstrates bundled app resources, but the
  preferred parser runtime below is an app-bundled Web Worker and must not need
  the user's Node installation.
- `docs/CONTRIBUTING_PATTERNS.md:29-58` requires shared UI/async/error
  primitives. `CLAUDE.md` additionally requires `useCommands` for every
  user-facing feature, design-token-only CSS, `Result<T, CommandError>`, path
  validation, and tracing on Rust commands.

## What the supported frameworks mean by “component”

This feature should normalize concepts, not syntax. The following rules are
grounded in the frameworks' official documentation and are the adapter contract.

| Project/dialect | Native definition | Inputs/content | Ship Studio interpretation |
|---|---|---|---|
| React, Next.js, Vite React, React Native | Exported function/class/arrow returning JSX, including common `memo`/`forwardRef` wrappers | Read-only props; nested JSX arrives as `children` | Exported renderable declarations are catalogable. Next page/layout/special files are roots, not reusable catalog entries by default. Respect Server/Client boundaries and serializable props. |
| Astro | Each `.astro` file is a component | `Astro.props`, optional `interface Props`, default/named slots | Files outside page routes are catalogable; layouts are a distinct kind. Native Astro and imported island components may coexist, so one project may use multiple adapters. |
| Vue / Nuxt | `.vue` Single-File Components or explicit TS/JS component exports | `defineProps`/Options API; default, named, and scoped slots | Parse SFC blocks with Vue's compiler. Nuxt default auto-import naming is supported; custom component directories are supported only when their configuration is statically readable. |
| Svelte / SvelteKit | `.svelte` component files | Svelte 5 `$props` and snippets/`children`; legacy `export let` and `<slot>` | Support both current and legacy syntax. Route files are roots rather than catalog entries by default. |
| Shopify theme | Sections, theme blocks, section-local blocks, and snippets | Section/block schema settings and nested blocks; snippet variables | Model each native kind separately. Schema settings are props; schema `select`/`radio` choices are variants. JSON templates/section groups are instances of sections. Snippet render sites are instances but do not gain merchant settings. |
| Static HTML | Registered custom elements/templates | Attributes/properties and native slots | Catalog only actual Web Components/custom elements that can be proven from registration/source. Repeated markup is not automatically a component. |
| Flutter | Immutable `Widget` subclasses/functions | Constructor arguments; `child`/`children` conventions | A future Dart adapter can build a source catalog. Visual binding needs Flutter tooling/Widget Inspector integration and is not part of web MVP. |
| Generic/Unknown | Determined from dependencies and source files | Adapter-specific | Return a profile with zero or more detected dialects. Never relabel an unsupported project just to enable UI. |

Official references used for these mappings are in [References](#references).

## Feasibility and release matrix

“Supported” must be reported per capability, not as a single boolean.

| Dialect | Catalog + usage graph | Typed props/slots | Exact visual instance binding | Safe placement/prop writes | Release recommendation |
|---|---:|---:|---:|---:|---|
| React in Next/Vite | High | High for explicit types/literals | Medium; validate React dev Fiber owner frames against AST | High when the invocation is exact and static | Web MVP |
| Native Astro | High | High | Medium for definition, low for repeated invocation identity without markers | High from a selected source anchor; instance props only from chosen usage rows | Web MVP |
| Vue/Nuxt | High | High | Low initially because compiled DOM drops source invocation locations | High once source anchors/import rules exist | Follow-up adapter |
| Svelte/SvelteKit | High | High | Low initially for the same reason | High once source anchors/import rules exist | Follow-up adapter |
| Shopify | High | High from schema | Medium/high for sections with runtime section IDs; lower for snippets | High with Liquid/JSON-aware mutation | Follow-up adapter |
| Native Web Components | Medium | Medium; runtime property semantics may be dynamic | Medium when host custom element is selected | Medium | Follow-up adapter |
| React Native/Expo | High source-only | High | Low until a Metro/devtools bridge exists; current preview is pixels | Medium source-only | Separate mobile epic |
| Flutter | Medium after Dart analyzer integration | High from analyzer | Low until Widget Inspector/VM service integration | Medium source-only | Separate mobile epic |

The main uncertainty is not whether definitions can be indexed; it is whether a
clicked rendered node can be mapped to one exact invocation after a framework
has compiled it. The UI must expose this honestly. A catalog entry can remain
fully useful while its visual binding is read-only.

## User experience specification

### Components panel

Add **Components** as a peer to the existing Elements and Variables surfaces in
the preview workspace. It is a dockable panel, not a modal.

The panel must provide:

- Search by component name, source path, group, and kind.
- Framework/folder groups with counts and collapsed state.
- A row for each definition showing name, kind, usage count, read-only or error
  state, and whether it is placeable.
- Details showing description from explicit JSDoc/framework metadata, source
  file/export, declared props, slots, explicit defaults, variants, capabilities,
  diagnostics, **Open source**, and **Place**.
- Usage rows with exact file/line and known route where the route scanner
  returned one. A dynamic route is shown as source only; Ship Studio must not
  invent a concrete URL.
- No thumbnail unless it was captured from a known running instance. Cache such
  images by definition/content hash and label their source route. Defer
  thumbnails entirely for the first release if this cannot be guaranteed.

Catalog grouping is derived from source folders and native kinds in v1. Do not
create `.shipstudio/components.json` in the MVP. If custom labels, groups,
preview presets, or hidden/pinned state are later requested, add an optional,
versioned metadata file that contains presentation metadata only. Definitions,
props, instances, and usage counts must never be persisted there.

### Selecting and editing an instance

When a user selects rendered content:

1. Preserve the existing DOM selection and style-source resolution.
2. Resolve its component binding through the index.
3. If binding is `exact`, show a component breadcrumb and instance controls.
4. If binding is `sourceAnchored`, identify the definition but say that the
   exact instance could not be proven; offer **Edit main**, **Show usages**, and
   **Open source**, but not instance prop writes.
5. If multiple invocations are plausible, list their source locations and ask
   the user to choose; never pick by DOM order alone.
6. If there is no binding, continue showing the normal element editor.

Instance mode exposes only values written as safe static expressions:

- strings/template-free text, numbers, booleans, `null`, explicit enum/literal
  choices, and project-relative asset strings;
- simple static arrays/objects only after the adapter has a lossless printer and
  tests for comments/trailing commas;
- identifiers, function calls, spreads, ternaries, member expressions, fetched
  data, slot scopes, and other dynamic expressions are read-only with **Open
  source**.

Unset props are displayed as unset. A default is shown only if the definition
explicitly declares one; inferred runtime defaults are prohibited.

### Editing the main definition

**Edit main** is an explicit mode with a persistent banner/breadcrumb:

`Editing main: Button · affects 14 source usages · Exit`

While active:

- existing element/style mutations target the resolved definition source;
- the preview may remain in the context of the selected instance, so providers,
  data, CSS, and app routing remain intact;
- instance prop controls are disabled;
- `Escape`, the banner action, route navigation, or selecting outside the
  definition exits the mode after handling pending edits;
- the exact usage count comes from the current index revision and updates after
  file-change reindexing.

Do not build a universal isolated component canvas in the MVP. Rendering a
definition alone requires framework providers, layouts, global CSS, aliases,
server data, and valid props. A later adapter-specific canvas may be opt-in and
must use explicit preview presets; zero-usage components should show their
catalog/source view until the user places one.

### Placing a component

Support a **Place** action first, then drag/drop once the same mutation endpoint
is stable. Drag/drop is a UI gesture over a source insertion plan; it must not
guess from pixel coordinates.

- User chooses or drags a catalog entry.
- Existing element-tree targeting supplies `before`, `after`, or `inside` plus
  the selected source anchor.
- The target adapter validates that child insertion is legal, resolves/reuses
  an import, checks symbol conflicts and dependency cycles, creates the native
  invocation with only explicit safe defaults, and returns a preview diff.
- The Rust write layer revalidates the plan and commits it.
- HMR reloads the running project, after which the index confirms exactly one
  new usage edge.

If a required prop has no explicit safe default, open a small setup form before
writing. Do not insert `undefined`, placeholder copy, guessed asset paths, or
fabricated data. Cancel leaves source unchanged.

### Webflow features deliberately deferred

- **Create component from selection**: later AST extraction flow; see Phase 6.
- **Blank component**: later framework-native templates, never generic markup.
- **Slots editing**: default static child content can follow prop editing after
  the adapter is stable; named/scoped/render-prop slots require dedicated AST UI.
- **Variants**: finite-choice controls ship with props. Saved multi-prop presets
  require explicit metadata and preview fixtures later.
- **Unlink**: unsupported in general. A future **Inline simple component** may
  exist only for proven pure, local, single-root definitions with a
  semantics-preserving adapter transform.
- **Cross-project libraries/sync**: separate package-management/versioning
  product; do not copy source across projects in this feature.

## Architecture

The shared data flow is:

```text
validated project root + resolved workspace
                |
        Rust source inventory/watch
                |
      app-bundled parser Web Worker
                |
   ComponentIndex snapshot (revisioned)
        /          |           \
 catalog UI   usage/binding   mutation planner
                    |           |
          preview source hint   v
                    +--> Rust hash/path/parse guard --> atomic source write
```

Parsing and framework semantics live behind adapters. Rust remains the security
boundary for filesystem access and writes. The Web Worker keeps heavyweight
compiler packages and indexing work off the React render thread and does not
depend on any runtime installed in the user's project.

### Framework profile: do not extend `ProjectType` for every dialect

Create a separate profile because a project can contain more than one component
dialect:

```ts
export type ComponentDialect =
  | 'react'
  | 'astro'
  | 'vue'
  | 'svelte'
  | 'shopify'
  | 'web-component'
  | 'react-native'
  | 'flutter';

export interface ComponentCapabilities {
  catalog: boolean;
  usageGraph: boolean;
  definitionBinding: boolean;
  instanceBinding: boolean;
  place: boolean;
  editStaticProps: boolean;
  editSlots: boolean;
  editMain: boolean;
  extract: boolean;
  isolatedPreview: boolean;
}

export interface ComponentFrameworkProfile {
  projectType: ProjectType;
  primaryDialect: ComponentDialect | null;
  dialects: ComponentDialect[];
  workspaceRoot: string; // display-safe, project-relative
  capabilities: Record<ComponentDialect, ComponentCapabilities>;
  diagnostics: ComponentDiagnostic[];
}
```

Detect profiles from static manifest/config/source evidence. Vite must inspect
dependencies/plugins to distinguish React/Vue/Svelte. Astro may report `astro`
plus React/Vue/Svelte island dialects. Generic projects may report a dialect but
must not gain preview capabilities unless the existing preview system supports
them.

### Canonical index types

Put shared TypeScript types in `src/lib/components/types.ts`. Use project-relative
POSIX paths in every serialized value.

```ts
export type ComponentId = string;
export type ComponentInstanceId = string;

export interface SourceRef {
  file: string;
  start: number; // UTF-8 byte offset in the hashed source snapshot
  end: number;
  line: number; // 1-based, display only
  column: number; // 1-based, display only
  contentHash: string; // SHA-256 of the complete file
}

export interface ComponentPropDescriptor {
  name: string;
  required: boolean;
  typeText: string | null;
  defaultValue: StaticValue | null; // explicit only
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

export interface ComponentDescriptor {
  id: ComponentId;
  dialect: ComponentDialect;
  kind: 'component' | 'layout' | 'section' | 'block' | 'snippet' | 'custom-element' | 'widget';
  name: string;
  exportName: string | null;
  description: string | null; // explicit source metadata only
  definition: SourceRef;
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
  route: string | null; // only from the existing route scanner
  props: Record<string, StaticExpression | DynamicExpression | UnsetExpression>;
  slots: ComponentSlotValue[];
}

export interface ComponentIndex {
  revision: number;
  profile: ComponentFrameworkProfile;
  components: ComponentDescriptor[];
  instances: ComponentInstance[];
  importEdges: ComponentImportEdge[];
  diagnostics: ComponentDiagnostic[];
}
```

Compiler APIs disagree about offsets: TypeScript/Vue/Svelte commonly expose
UTF-16 string indexes while some parsers expose bytes. Add one tested conversion
utility per parser boundary and serialize UTF-8 byte offsets only; Rust applies
edits to bytes. Include Unicode-before-range fixtures so an apparently correct
ASCII-only implementation cannot ship.

Generate `ComponentId` from dialect + project-relative definition file + export
or local symbol identity. Generate `ComponentInstanceId` from the component ID +
invocation file + byte range. IDs are deterministic within a source revision but
may change on rename/move; never persist them as durable business data.

Every status/error must be a discriminated union. Do not communicate ambiguity
through `null`, exceptions, or user-facing string parsing.

### Adapter contract

Create `src/lib/components/adapters/types.ts` with a pure interface:

```ts
export interface ComponentAdapter {
  readonly dialect: ComponentDialect;
  detect(context: DetectionContext): DialectDetection;
  accepts(path: string): boolean;
  parseFile(file: SourceFileSnapshot, context: ParseContext): ParsedComponentFile;
  resolveImport(edge: RawImportEdge, context: ResolveContext): ResolvedImportEdge;
  buildUsageGraph(files: ParsedComponentFile[], context: GraphContext): AdapterGraph;
  bindSelection(input: SelectionBindingInput, index: ComponentIndex): ComponentBinding;
  planInsert(input: InsertComponentInput, index: ComponentIndex): MutationResult;
  planPropEdit(input: EditComponentPropInput, index: ComponentIndex): MutationResult;
  validateMutation(input: MutationValidationInput): MutationValidationResult;
}
```

Adapters must return structured unsupported/ambiguous diagnostics. They may not
read the filesystem, run commands, import user modules, or write files. Keep AST
objects worker-local; serialized index DTOs contain only ranges and normalized
metadata.

### Parser runtime

Preferred implementation: `src/workers/component-index.worker.ts`, lazily loaded
when the Components panel or a component-aware command is first used. Bundle
Ship Studio-owned, pinned parser packages:

- TypeScript compiler API for JS/TS/JSX/TSX and React/React Native declarations;
- `@astrojs/compiler` for `.astro`;
- `@vue/compiler-sfc` plus compiler-dom for `.vue`;
- `svelte/compiler` for `.svelte` current and legacy syntax;
- Shopify's Liquid HTML parser plus a JSON parser that preserves ranges for
  Liquid and Online Store 2.0 JSON;
- no Dart parser in the web MVP.

The packages are build-time dependencies of Ship Studio, not dependencies added
to user projects. Pin compatible major/minor ranges and record licenses. Do not
resolve a parser from the project's `node_modules`.

Phase 0 must prove these packages load in both Vite dev and a packaged Tauri app,
including Astro's WASM asset. Cap the initial bundle and measure worker startup.
If a parser cannot run in the packaged WebView, STOP and write an ADR comparing
an app-bundled executable sidecar with Rust-native parsers. Never fall back to
the user's `node` binary. Preserve the adapter and message protocol regardless
of runtime choice.

Worker messages are versioned:

```ts
type WorkerRequest =
  | { protocol: 1; id: string; type: 'build'; snapshot: ComponentSourceSnapshot }
  | { protocol: 1; id: string; type: 'update'; changes: SourceFileChange[] }
  | { protocol: 1; id: string; type: 'bind'; input: SelectionBindingInput }
  | { protocol: 1; id: string; type: 'planMutation'; input: ComponentMutationInput };
```

Reject unknown protocol versions. Support cancellation and terminate the worker
when the project session ends. A build/update response may include a bounded
`needSources` list; the main thread must satisfy it only through the validated
batch-read command and must reject a path the worker did not request.

### Rust source inventory, watching, and write guard

Create small modules under `src-tauri/src/commands/components/`:

- `mod.rs` — Tauri commands only;
- `types.rs` — serialized source snapshots, changes, mutation plans, results;
- `inventory.rs` — filtered source discovery and validated incremental reads;
- `watch.rs` — per-window `notify` watcher, debounce, revision events, cleanup;
- `mutation.rs` — validation, hash checks, text edits, parse-token handshake,
  atomic writes, rollback for future multi-file edits;
- unit tests colocated in each module.

Expose typed wrappers from `src/lib/components/client.ts` for:

- `get_component_source_snapshot(projectPath)`;
- `read_component_source_batch(projectPath, relativePaths, expectedRevision)`;
- `start_component_source_watch(windowLabel, projectPath)`;
- `stop_component_source_watch(windowLabel)`;
- `apply_component_mutation(projectPath, plan)`.

All commands return `Result<T, CommandError>`, validate `projectPath`, resolve the
active workspace, validate every file beneath the project root, reject symlink
escapes, and add `#[tracing::instrument]` with paths but never source contents.
Register them in `src-tauri/src/lib.rs` and clean up watchers with the existing
window/project session lifecycle.

Inventory rules:

- The initial snapshot contains the active workspace's conventional
  source/component/page roots plus the static manifest/tsconfig data needed for
  import resolution.
- When the worker finds a statically resolved import into an internal package
  outside the active workspace, it may return a bounded `needSources` request.
  The main thread passes the exact relative candidates to
  `read_component_source_batch`; Rust canonicalizes and validates every path
  beneath the project root before returning contents. Limit resolution rounds
  and detect repeated requests.
- Unused components outside the active workspace are not cataloged in v1. A
  later shared-package catalog must use explicit package/workspace scope rather
  than scanning an entire monorepo without a bound.
- Exclude `.git`, `.shipstudio`, `node_modules`, build/dist/output/coverage,
  generated framework directories, locks, binaries, and files over the cap.
- Honor standard ignore files through the existing `ignore` crate.
- Parse `package.json`, `tsconfig.json`, and workspace manifests as data. Do not
  execute `next.config`, `vite.config`, `astro.config`, `nuxt.config`, or project
  scripts. Support only statically obvious alias/config forms; return diagnostics
  for the rest.
- Set explicit limits for file count, individual bytes, total snapshot bytes,
  index time, and diagnostics count. Surface `partial: true` with reasons when a
  cap is reached.

`MutationPlan` contains project-relative files, expected SHA-256 hashes, sorted
non-overlapping text edits, parser/dialect, expected graph delta, and warnings.
ASTs locate and validate edit ranges; adapters generate only the smallest new
snippet/import text. Never print an entire user file from a compiler AST.
For every commit:

1. Validate all paths and hashes before touching disk.
2. Apply edits to memory from highest byte offset to lowest.
3. Ask the worker to parse and validate the proposed complete contents.
4. Refuse syntax errors, overlapping ranges, import cycles, invalid framework
   boundaries, or a graph delta different from the plan.
5. Write a sibling temporary file preserving newline convention and permissions,
   then rename atomically. For future multi-file plans, stage every file first
   and roll back if any rename fails.
6. Emit changed relative paths so the watcher/HMR/index can converge.

Do not run a formatter on user code. Preserve all untouched bytes.

### Index lifecycle

Create `src/hooks/useComponentCatalog.ts` and a project-scoped provider/store.
The lifecycle is:

1. Ask Rust for a bounded source snapshot.
2. Build in the worker, satisfying bounded `needSources` rounds through Rust,
   then publish one immutable revision.
3. Subscribe to debounced file changes from Rust.
4. Re-read changed files with hashes; incrementally reparse affected files and
   their reverse-import dependants.
5. Swap to the new complete revision; never expose a half-updated graph.
6. After a component mutation, wait for a revision whose hashes and expected
   graph delta match before declaring success.

Store only serializable DTOs in React state. Keep ASTs, compiler programs, and
reverse dependency maps inside the worker. Index errors must not break Preview;
the panel shows a recoverable diagnostic and the existing editor continues.

### Runtime binding

Extend the selection signature with a list of source frames rather than one
unqualified hint:

```ts
export interface RuntimeSourceFrame {
  renderer: 'react' | 'vue' | 'svelte' | 'astro' | 'shopify' | 'unknown';
  file: string;
  line: number;
  column: number;
  symbolHint: string | null;
  runtimeKey: string | null;
}
```

For React, traverse the selected host Fiber's owner chain in development mode.
Collect user-code frames; do not stop at the first frame. Rust/worker validation
must map URLs/chunks through the existing verified source-map path, confirm the
AST at the candidate source range is the expected component invocation or
definition, and reject private-runtime data that does not validate. React Fiber
field names are not a stable API, so failure is a normal `sourceAnchored`/`none`
state, not an exception.

For Astro/Vue/Svelte, do not pretend the rendered DOM retains invocation
identity. Use exact existing source anchors where available for definition/main
editing; otherwise drive instance editing from catalog usage rows. A later dev
transform/bridge may add invocation IDs, but it needs an adapter-specific design
and must not wrap roots or add layout-affecting DOM.

For Shopify sections, validate runtime section identifiers against the active
template/section-group data and source graph. Snippets without a proven render
site remain definition-bound only.

### Framework-specific mutation rules

React / Next.js / Vite React:

- Resolve named/default exports, re-exports, namespace imports, aliases, and
  common `memo`/`forwardRef` wrappers through the TypeScript AST.
- Catalog exported PascalCase declarations that produce JSX. Anonymous default
  exports use the filename for display but retain a distinct source identity.
- Exclude tests, stories, generated files, route pages, route layouts, error/loading
  special files, and providers from default catalog placement; allow a future
  “show roots/internal” filter.
- Parse props from explicit interfaces/types, destructuring, defaults, PropTypes,
  and JSDoc. Never use TypeScript language-service execution that loads project
  plugins.
- Reuse an existing import where possible. Otherwise choose named/default import
  syntax from the actual export and use a relative path unless a statically
  resolved existing alias convention is proven.
- Refuse a symbol collision or dependency cycle.
- In Next App Router, obey `'use client'`. A Client Component cannot import a
  server-only component. Props crossing Server-to-Client boundaries must be
  serializable. Do not insert or remove directives automatically in v1.

Astro:

- Treat `.astro` files outside route roots as native definitions and layouts as
  a separate kind.
- Parse frontmatter imports, `Astro.props`, explicit `Props`, default/named slots,
  and native component invocations.
- Preserve frontmatter fences and insert imports into the existing frontmatter.
  If no frontmatter exists, create the minimal valid fence without reformatting
  the template.
- A foreign-framework island requires the project's installed integration and
  may need a hydration directive. Never guess either; require the user to choose
  an explicit existing directive or keep placement read-only.

Vue / Nuxt:

- Parse `<template>`, `<script>`, `<script setup>`, and `<style>` boundaries with
  Vue's compiler. Preserve the untouched blocks byte-for-byte.
- Support `defineProps`, typed `defineProps`, `withDefaults`, Options API props,
  `defineSlots`, and template slots. Mark runtime-computed declarations read-only.
- Convert camelCase prop declarations to the project's existing template usage
  convention; default to Vue's documented kebab-case template convention only
  when creating a new invocation.
- Support Nuxt's default `components` auto-import directory and path-derived
  names. Custom directories/path prefixes are supported only when parsed from a
  static config form; otherwise insert an explicit import or refuse.

Svelte / SvelteKit:

- Parse both Svelte 5 `$props`/snippet syntax and legacy `export let`/`<slot>`.
- Route `+page`, `+layout`, `+error`, server, and module files are roots/internal,
  not default catalog components.
- Preserve `<script>` context/module boundaries and insert imports into the
  instance script. Refuse placement if creating a script block would conflict
  with syntax the adapter cannot round-trip.
- Treat snippet/render-prop expressions as dynamic unless the adapter has an
  exact static edit range.

Shopify:

- Keep sections, theme blocks, section-local blocks, and snippets as distinct
  `kind` values.
- Parse `{% schema %}` JSON and map explicit settings/defaults/options to props
  and variants. A schema without a default produces an unset prop, not a guess.
- Resolve section instances from JSON templates and section groups. Resolve
  snippet instances from `{% render %}` tags. Never infer instances from rendered
  HTML alone.
- Insert a section by editing the active explicit JSON template/section group;
  insert a snippet with a Liquid `render` tag; insert blocks only where the
  containing schema permits them. Refuse when the active template cannot be
  proven from returned preview state.
- Preserve merchant-managed IDs and ordering; generate an ID only where Shopify's
  file format requires one and validate uniqueness in that file.

Static Web Components:

- Recognize `customElements.define()` registrations and imports that can be
  statically resolved. The custom element tag is the catalog identity.
- Map observed/declared attributes and native `<slot>` names when explicit.
- Place the registered tag only when its registration/import is already loaded
  on the target page or an import can be added safely. Do not inject a global
  runtime.
- Do not convert repeated HTML into a component during catalog scanning.

React Native and Flutter:

- Reuse the React index rules for React Native source, but expose catalog,
  usages, and source-only placement separately from visual binding.
- Do not attach the web `ss:*` protocol to `DeviceMirror`; the current preview is
  a pixel/video stream rather than a DOM.
- Design React Native runtime binding as a separate Metro/devtools bridge with a
  stable protocol and opt-in project transform. Do not depend solely on private
  React internals.
- Design Flutter support around the Dart analyzer for source and Flutter Widget
  Inspector/VM service for runtime identity. Do not write a Dart parser in Rust
  or infer widgets from screenshots.

## Exact file map

Create these paths during the applicable phases:

- `src/lib/components/types.ts`
- `src/lib/components/client.ts`
- `src/lib/components/profile.ts`
- `src/lib/components/index-store.ts`
- `src/lib/components/worker-client.ts`
- `src/lib/components/adapters/types.ts`
- `src/lib/components/adapters/react.ts`
- `src/lib/components/adapters/astro.ts`
- `src/lib/components/adapters/vue.ts`
- `src/lib/components/adapters/svelte.ts`
- `src/lib/components/adapters/shopify.ts`
- `src/lib/components/adapters/web-component.ts`
- `src/lib/components/worker-client.test.ts`
- `src/lib/components/index-store.test.ts`
- `src/lib/components/mutation.test.ts`
- `src/lib/components/adapters/react.test.ts`
- `src/lib/components/adapters/astro.test.ts`
- `src/lib/components/adapters/vue.test.ts`
- `src/lib/components/adapters/svelte.test.ts`
- `src/lib/components/adapters/shopify.test.ts`
- `src/lib/components/adapters/web-component.test.ts`
- `src/workers/component-index.worker.ts`
- `src/hooks/useComponentCatalog.ts`
- `src/hooks/useComponentBinding.ts`
- `src/hooks/useComponentBinding.test.ts`
- `src/hooks/useComponentCommands.tsx`
- `src/components/edit/ComponentsPanel.tsx`
- `src/components/edit/ComponentsPanel.test.tsx`
- `src/components/edit/ComponentDetails.tsx`
- `src/components/edit/ComponentInstanceControls.tsx`
- `src/components/edit/EditMainBanner.tsx`
- `src/styles/features/components.css`
- `src-tauri/src/commands/components/mod.rs`
- `src-tauri/src/commands/components/types.rs`
- `src-tauri/src/commands/components/inventory.rs`
- `src-tauri/src/commands/components/watch.rs`
- `src-tauri/src/commands/components/mutation.rs`
- `src/test/fixtures/components/` with source stored as `.fixture`/`.txt` files so
  fixture projects are not included in the app TypeScript program.
- `docs/internal/components.md` for user/developer behavior after the MVP lands.

Modify only as required:

- `package.json` and `pnpm-lock.yaml` for bundled parser dependencies;
- `src-tauri/src/commands/mod.rs` and `src-tauri/src/lib.rs` for command modules
  and registration;
- `src-tauri/src/proxy/select_script.html` and its existing behavior tests for
  source-frame collection;
- `src/lib/edit.ts`, `src/hooks/useVisualEditor.ts`, and
  `src/components/edit/UsageScope.tsx` to migrate usage/binding;
- `src/components/preview/Preview.tsx` to host the panel/banners and shared
  project-scoped state;
- `src/styles/index.css` and token files only if an existing token cannot express
  the design;
- `docs/analytics.md` and the existing analytics wrapper for registered events.

Keep each source file within the repository LOC gates. Split types, adapters,
UI, and tests instead of growing `edit.rs` or `Preview.tsx` further.

## Commands the executor will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install parser deps | `pnpm install` | exit 0 and lockfile updated deterministically |
| Target React adapter | `pnpm test:run -- src/lib/components/adapters/react.test.ts` | named suite passes |
| Target proxy behavior | `pnpm test:run -- src/components/edit/selectScript.test.ts` | named suite passes |
| Target Rust module | `pnpm rust:test -- commands::components` | component module tests pass |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Full repo gates, only after asking | `pnpm check:all` | exit 0 |
| Frontend suite, only after asking | `pnpm test:run` | all tests pass |
| Backend suite, only after asking | `pnpm rust:test` | all tests pass |

Do not run all three long full-suite commands without first asking the operator.
During implementation, run only the one targeted test needed for the active
phase before asking for the final gates.

## Git workflow

- Start from a clean worktree based on the intended target branch.
- Suggested branches per delivery:
  `feature/components-foundation`, `feature/components-react-astro`, then one
  branch per additional adapter.
- Recent commits use imperative sentence-case messages such as
  `Update icons to use current color`; match that style.
- Commit per phase/logical unit. Do not push or open a PR unless instructed.
- Never discard unrelated working-tree changes.

## Implementation phases

### Phase 0: Prove the parser runtime and write an ADR

Build a non-UI spike of the Web Worker protocol. Load the TypeScript and Astro
parsers first, parse one fixture each, and build a production bundle. Verify the
worker starts under Tauri dev and one packaged build on the executor's platform.
Record bundle-size/startup measurements and the accepted parser-runtime decision
in `docs/internal/components.md` before enabling the feature.

Add the remaining Vue/Svelte/Liquid parsers only after the runtime shape works.
Review package licenses and ensure no parser loads project plugins/config.

**Verify**:
`pnpm test:run -- src/lib/components/worker-client.test.ts && pnpm build` exits
0; the documented packaged-app worker smoke check returns protocol version `1`
and parses TSX/Astro without the project's Node executable.

### Phase 1: Add validated source inventory and immutable read-only indexing

Implement the Rust snapshot/watch commands, worker/store lifecycle, framework
profile, normalized index types, and React/Astro adapters. No UI writes in this
phase. Add a temporary developer-only index dump or test harness rather than a
production button.

The graph must resolve imports/exports, usages, enclosing definitions, routes,
props, and slots for fixture projects. Return diagnostics for unresolved aliases,
dynamic declarations, unsupported syntax, caps, and partial indexes.

**Verify**:
`pnpm test:run -- src/lib/components/index-store.test.ts src/lib/components/adapters/react.test.ts src/lib/components/adapters/astro.test.ts`
passes the definition/usage fixtures, then
`pnpm rust:test -- commands::components::inventory` passes workspace scoping,
ignore, cap, and symlink-escape cases.

### Phase 2: Ship the read-only catalog and usage graph

Implement the Components panel, details, search/groups, usage navigation, error
states, empty states, and commands. Register at least:

- `components.open`
- `components.search`
- `components.openSource`
- `components.showUsages`

Use `useCommands`; use existing Buttons, Tabs, dockable-panel patterns, async
hooks, icons, and design tokens. The panel may be available whenever the profile
has `catalog: true`; it must not depend on `editorGate.ts` returning a style
editor mode.

Add analytics such as `components_panel_opened`, `component_selected`, and
`component_usage_opened` with dialect/capability/status fields but no source
text, prop values, absolute paths, or component names.

**Verify**:
`pnpm test:run -- src/components/edit/ComponentsPanel.test.tsx && pnpm typecheck`
exits 0 and covers loading, populated, partial/error, and read-only states.

### Phase 3: Add proven runtime binding and Edit main for React/Astro

Extend the selection protocol to emit candidate source frames, validate those
frames against the index, and return binding confidence. Integrate the result
with `useVisualEditor`, the existing Usage scope, and a new Edit-main banner.

Keep the old `find_component_usage` command during rollout behind a fallback or
feature flag. Once index-backed output covers its supported fixtures, migrate
all call sites and remove the heuristic plus its duplicate TS types/tests.

Do not permit instance writes in this phase. Main editing may reuse existing
structure/style engines only where their source resolver independently returns
an exact target.

**Verify**:
`pnpm test:run -- src/components/edit/selectScript.test.ts src/hooks/useComponentBinding.test.ts`
passes exact React owner-chain, source-anchored Astro, ambiguous invocation,
invalid runtime-data, and no-framework cases.

### Phase 4: Add safe placement and static instance-prop editing

Implement adapter mutation planning and the Rust guard. Start with React and
native Astro. First expose **Place** on a selected exact source anchor; add
drag/drop only after mutation tests establish the same endpoint is deterministic.

Implement string/number/boolean/literal-union prop controls. Require exact
invocation binding or an explicitly selected usage row. Show a source diff and
required-prop form before commit. Disable dynamic expressions with a reason.

Register:

- `components.placeSelected`
- `components.editMain`
- `components.exitMain`

**Verify**:
`pnpm test:run -- src/lib/components/mutation.test.ts && pnpm rust:test -- commands::components::mutation`
passes import reuse/insertion, collision/cycle refusal, stale hash,
syntax-error rollback, required/dynamic prop, and +1 graph-delta cases.

### Phase 5: Add Vue/Nuxt, Svelte/SvelteKit, Shopify, and Web Components

Deliver each adapter in its own pull request and keep capability flags off until
its fixture corpus passes. Do not wait for exact visual instance binding to ship
a useful catalog; usage-row-driven placement/prop editing is acceptable and must
be labelled accurately.

Recommended order:

1. Vue/Nuxt;
2. Svelte/SvelteKit;
3. Shopify themes;
4. native Web Components/static HTML.

For each adapter, add profile detection, definition/usage/props/slots parsing,
mutation planning, fixtures, UI labels, capability defaults, and docs. Never
copy React-specific assumptions into a non-React adapter.

**Verify**: for each PR, run its exact adapter file, for example
`pnpm test:run -- src/lib/components/adapters/vue.test.ts src/components/edit/ComponentsPanel.test.tsx`;
replace `vue` with `svelte`, `shopify`, or `web-component` for later PRs.

### Phase 6: Add extraction, slots, and optional preview presets

Only begin after placement and prop writes have production evidence.

For **Create component from selection**, locate one exact AST subtree, compute
free variables/imports, propose a framework-native file/export/import/invocation
diff, and make the user approve proposed prop names. Refuse control-flow-spanning
selections, loop variables, dynamic scopes, multiple source files, server/client
boundary changes, or any transform without a lossless printer.

Add static default-slot editing first. Named/scoped slots follow per adapter.
If preview presets are approved, introduce versioned presentation metadata with
explicit props/slots and orphan reconciliation. Never render arbitrary defaults.

Do not add general unlink. Consider a narrowly named **Inline simple component**
only if an adapter proves semantic preservation and has adversarial tests.

**Verify**: one focused extraction test per enabled adapter proves exact
before/after source, free-variable props, import preservation, replacement usage,
stale-source rollback, and every refusal case.

### Phase 7: Treat mobile as separate runtime integrations

React Native/Expo may reuse source indexing and source-only placement after its
own fixtures pass. A visual bridge requires an opt-in Metro transform/devtools
protocol that returns component/instance IDs tied to source hashes.

Flutter requires a Dart-analyzer source service and Widget Inspector/VM-service
runtime bridge. Write a new dedicated plan before implementing either bridge.
Do not infer component identity from mirrored screenshots or coordinates.

**Verify**: this phase is not complete until its separate plan defines security,
project instrumentation, cleanup, version compatibility, and device/simulator
tests. Source-only catalog support must be labelled source-only.

## Test plan

Use fixture projects that never install dependencies or access the network.
Store source samples with non-compiling fixture extensions/text so the main
TypeScript program does not include them.

Parser/index cases:

- default/named/aliased/namespace/re-exported components;
- anonymous defaults, nested/local components, `memo`, `forwardRef`, class
  components, async Server Components;
- JSX in loops/conditionals, spread props, dynamic components, duplicate names;
- Next App/Pages routers, `'use client'`, server-only imports, serializability;
- Astro props/frontmatter/default and named slots/islands/layouts;
- Vue Options/Composition/`script setup`, defaults, kebab-case, named/scoped slots,
  default and custom Nuxt component paths;
- Svelte 5 and legacy syntax, snippets, route roots;
- Shopify sections/theme blocks/local blocks/snippets/schema/JSON templates;
- custom-element registrations/attributes/slots;
- monorepo workspace path, reachable internal package, unresolved alias, symlink
  escape, ignored/generated/oversized files;
- malformed syntax and partial-index diagnostics.

Mutation cases:

- exact before/after bytes with comments, Unicode, CRLF/LF, trailing newline,
  quote style, indentation, and existing imports preserved;
- import reuse and insertion, alias conflicts, dependency cycles;
- required prop with/without explicit default;
- every allowed static expression and every dynamic read-only expression;
- stale hash, changed range, overlapping edits, parse failure, write failure, and
  no-write/rollback guarantees;
- expected graph delta and incremental reindex convergence;
- Next client/server refusal, Astro island hydration refusal, Nuxt auto-import
  uncertainty, Svelte script-block conflict, Shopify invalid block/template.

Runtime/UI cases:

- component panel loading/empty/partial/error/populated states;
- search/group/capability badges and keyboard accessibility;
- exact/source-anchored/ambiguous/none binding;
- Edit-main enter/exit/navigation/pending-edit behavior;
- no prop controls for a non-exact invocation;
- no invented route/default/thumbnail;
- existing visual editor and static HTML behavior remain unchanged when no
  component adapter is active;
- command palette entries appear only when their capability is available.

Before final completion, ask the operator and then run the three mandatory repo
gates from `AGENTS.md`: `pnpm check:all`, `pnpm test:run`, and `pnpm rust:test`.

## Rollout and observability

Ship read-only indexing behind a local feature flag first. Enable writes per
dialect/capability, not with one global “Components supported” switch.

Track only non-sensitive metrics:

- profile/dialect detection and partial-index reason;
- index duration, file count buckets, cache hit, worker crash/restart;
- binding confidence distribution;
- placement/prop/main-edit attempted/succeeded/refused with reason category;
- mutation stale-hash/parse/rollback failures.

Never record absolute paths, source text, component/export names, prop names or
values, route parameters, merchant IDs, or project package names.

Add structured tracing around inventory, parse request duration, graph size,
binding, and mutation validation. A worker crash should restart once and rebuild
from the latest snapshot; repeated failure disables Components for that project
session with a diagnostic while leaving Preview and code editing operational.

## Done criteria

The whole plan is complete only when all of the following hold:

- [ ] Ship Studio detects component dialects independently from coarse
  `ProjectType`, including multi-dialect Astro and React-flavoured Vite.
- [ ] React/Next/Vite and native Astro have a read-only catalog, exact source
  usage graph, props/slots metadata, and honest capability diagnostics.
- [ ] React/Astro placement and static prop edits use parser-backed, hash-checked,
  fail-closed source mutations.
- [ ] Edit-main mode is explicit and existing visual edits target a proven
  definition source.
- [ ] Vue/Nuxt, Svelte/SvelteKit, Shopify, and native Web Components have their
  adapter capabilities enabled only to the level proven by fixtures.
- [ ] React Native/Flutter are not advertised as visually bound until separate
  runtime bridges exist.
- [ ] No feature path executes project code/config or depends on project Node.
- [ ] No dynamic value, route, default, thumbnail, usage, or source target is
  inferred and presented as fact.
- [ ] Parser, graph, mutation, runtime binding, and UI refusal cases are tested.
- [ ] Every user-facing action is registered with `useCommands`; UI uses shared
  primitives and design tokens.
- [ ] All Rust commands use `CommandError`, validation, tracing, bounded work,
  and safe cleanup.
- [ ] `pnpm check:all`, `pnpm test:run`, and `pnpm rust:test` pass after operator
  approval to run the long suites.
- [ ] `docs/internal/components.md` documents support levels and limitations.
- [ ] `plans/README.md` marks this plan `DONE` only after all separately shipped
  phases are complete; otherwise record phase progress in this plan.

## STOP conditions

Stop and report rather than improvising if:

- overlapping uncommitted user changes remain in an in-scope file;
- the bundled parser worker cannot load in a packaged Tauri build;
- an implementation would require the user's Node installation or executing
  project config/modules;
- a framework parser cannot return trustworthy source ranges for the intended
  write;
- runtime data cannot be validated against the indexed AST/source hash;
- an edit requires guessing a dynamic prop, route, hydration directive, provider,
  import alias, Shopify template, block permission, or client/server boundary;
- a requested write spans more files than the mutation layer can roll back;
- component support requires weakening `validate_project_path`, following a
  symlink outside the project root, or scanning vendor/build output;
- the active framework version falls outside the adapter's tested syntax range;
- a phase's focused verification fails twice after a reasonable correction;
- meeting a phase requires broad refactoring of the existing visual editor rather
  than using the adapter seams described here.

## Maintenance notes

- Treat parser compatibility like a compiler feature: record fixture versions
  and update adapters before raising parser majors.
- React/Vue/Svelte runtime internals are hints, not APIs. Keep binding validation
  source-based and expect confidence to degrade safely after framework updates.
- Component IDs are source identities, not persistent UUIDs. Any later metadata
  layer needs orphan detection and an explicit reassociation UI.
- Import graph correctness is central. Review alias, re-export, cycle, and
  monorepo changes more closely than catalog rendering.
- Keep adapters pure and mutation writes centralized. A framework adapter must
  never gain direct filesystem access.
- Review every new control against the “never assume data” invariant.
- A future isolated canvas should be a separate plan with provider/harness APIs,
  explicit preview props, CSS loading, and framework-server constraints.

## References

Webflow behavior being adapted:

- [Webflow Components overview](https://help.webflow.com/hc/en-us/articles/33961303934611-Components-overview)
- [Webflow Designer API: Components overview](https://developers.webflow.com/designer/reference/components-overview)

Framework source models:

- [React: Passing props to a component](https://react.dev/learn/passing-props-to-a-component)
- [Next.js project structure](https://nextjs.org/docs/app/getting-started/project-structure)
- [Next.js Server and Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components)
- [Next.js `use client` directive](https://nextjs.org/docs/app/api-reference/directives/use-client)
- [Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Vue Single-File Components](https://vuejs.org/guide/scaling-up/sfc.html)
- [Vue props](https://vuejs.org/guide/components/props)
- [Vue slots](https://vuejs.org/guide/components/slots.html)
- [Nuxt components directory](https://nuxt.com/docs/4.x/directory-structure/app/components)
- [Nuxt auto-imports](https://nuxt.com/docs/4.x/guide/concepts/auto-imports)
- [Svelte `$props`](https://svelte.dev/docs/svelte/$props)
- [Svelte `{@render}`](https://svelte.dev/docs/svelte/@render)
- [Shopify theme architecture](https://shopify.dev/docs/storefronts/themes/architecture)
- [Shopify theme blocks](https://shopify.dev/docs/storefronts/themes/architecture/blocks)
- [React Native components and APIs](https://reactnative.dev/docs/components-and-apis)
- [Flutter `Widget` class](https://api.flutter.dev/flutter/widgets/Widget-class.html)
- [Flutter UI fundamentals](https://docs.flutter.dev/ui)
- [MDN Web Components](https://developer.mozilla.org/en-US/docs/Web/API/Web_components)
- [MDN templates and slots](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_templates_and_slots)
