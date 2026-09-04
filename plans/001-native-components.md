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
- **Current implementation branch**: `feature/native-components`
- **Current delivery state**: React/Next/Vite focused-edit vertical slice,
  Astro source-anchored mutation slice, guarded React lifecycle transaction,
  automatic source refresh, and conservative Vue/Svelte/Shopify/Web Component
  plus React Native source adapters and separate native runtime bridge contracts
  implemented; packaged smoke and the operator-approved full test gates are
  complete, with the verified implementation ready to commit

### Verification evidence (updated 2026-09-04)

- `pnpm typecheck` and `pnpm build` pass. The latest production build emitted
  the component worker at 4,842.86 kB and Astro WASM at 5,166.91 kB (1,426.08
  kB gzip); measurements and parser licensing are recorded in
  `docs/internal/components.md` and `docs/internal/components-parser-adr.md`.
- The short repository checks also pass: `pnpm lint`, `pnpm format:check`,
  `pnpm rust:fmt:check`, `pnpm rust:clippy`, `pnpm test:scripts`, `pnpm docs:check`,
  `pnpm check:patterns`, `pnpm check:loc`, and `pnpm check:ui-baseline`.
- Focused adapter/index coverage passes: Vue (2), Svelte (2), Shopify (3), Web
  Components (2), React Native (1), Astro/parser/worker (9), and existing
  index/store coverage (15), for 34 tests in the cross-adapter/runtime runs.
- Focused tree/focus/proxy/editor coverage passes (72 tests); focused mutation,
  refactor, panel, and preview coverage passes (24 tests).
- Focused extraction, static-slot, and explicit-preset coverage passes (11
  tests), including free-variable approval, import-preserving extraction,
  exact React/Vue slot ranges, dynamic-slot refusal, stale/no-op refusal, and
  conservative inline-simple refusal/plan cases.
- Rust component coverage passes for inventory (8), watcher (2), and mutation
  (13), including symlinked-file and symlinked-parent no-follow refusals.
- Focused Edit-main structural coverage passes: `useElementStructure` (19) and
  Rust `edit_structure` (19), including exact definition-range handoff and
  missing-range refusal.
- Focused mobile runtime coverage passes: `mobile-runtime.test.ts` (5) and
  React Native adapter/source-only mutation coverage (1), covering
  authenticated React Native exact/source-anchored binding, source-only
  placement, stale/traversal/ambiguity refusal, Flutter analyzer/Widget
  Inspector binding, and cleanup.
- The dedicated mobile integration plan is checked in at
  `plans/002-mobile-components-runtime.md`; it defines security,
  project-instrumentation, cleanup, compatibility, and device/simulator test
  requirements without routing native pixels through the web DOM bridge.
- `pnpm exec tauri dev` launched the Vite development server and debug Rust
  shell against the Next.js fixture; the preview rendered successfully. The
  packaged smoke used the exact app at
  `src-tauri/target/release/bundle/macos/Ship Studio.app` and loaded the
  worker-backed Components catalog, including `Header` and `Footer` as
  component rows in the Element Tree.
- Operator-approved final gates passed on 2026-09-04: `pnpm check:all`,
  `pnpm test:run` (204 files, 2,071 passed, 4 skipped), and `pnpm rust:test`
  (1,106 passed, 1 ignored). The app-only Tauri package completed with
  `--no-sign`; DMG creation is intentionally outside this app-bundle smoke.

### Feature progress

- [x] Catalog framework-native React components without executing project code.
- [x] Show definitions, explicit props/defaults, slots, usage counts,
  capabilities, diagnostics, and source links.
- [x] Search and group the catalog by framework, folder, and native kind.
- [x] Register Components panel, search, source, usage, placement, and
  main-source actions with `useCommands`.
- [x] Place React components through parser-backed source edits after a proven
  selected source anchor.
- [x] Collect required prop values before placement without inventing defaults.
- [x] Edit statically authored React instance props from an explicitly selected
  exact usage.
- [x] Refuse dynamic, ambiguous, stale, cyclic, colliding, or otherwise unsafe
  source mutations.
- [x] Use the supplied Components icon in Ship Studio's icon system and panel UI.
- [x] Restrict the initial UI cohort to Next.js and React-flavoured Vite.
- [x] Add automatic source watching and incremental catalog refresh; explicit
  refresh remains available when the watcher is unavailable.
- [x] Add complete owner-chain runtime binding with source-hash validation.
- [x] Make **Edit main** retarget visual structure/style mutations to the proven
  definition. Main mode now seeds the revision-bound definition scope when an
  exact usage is available; style, text, and structural writes refuse stale or
  unproven ranges instead of falling back to an invocation.
- [x] Add insertion-position choice and source-diff confirmation; placement now
  requires an explicit before/after/inside choice and an approval before write.
- [x] Add native Astro cataloging, usage graph, and source-anchored binding.
- [x] Add native Astro placement and prop editing.
- [x] Project validated component boundaries into the Element Tree as virtual
  component rows with the Components icon instead of an HTML tag icon.
- [x] Require double-clicking a component row/boundary to enter its children,
  with nested focus breadcrumbs and `Escape` to move back out.
- [x] Add component-aware preview hover/selection presentation using the
  semantic Components green rather than the normal element-selection blue.
- [x] Let the CSS Editor, Visual Editor, and Agent edit the proven component
  definition from a focused preview context so changes affect every instance.
- [x] Add adapter-backed **Duplicate**, **Rename**, and **Delete** actions to the
  Components panel with reviewed multi-file diffs and guarded transactional
  writes for the conservative React/Next named-export slice. Default exports,
  re-exports, file moves, and source-file deletion remain follow-up planner work.
- [x] Add Vue/Nuxt, Svelte/SvelteKit, Shopify, and Web Component adapters.
- [x] Add extraction, static slot editing, and optional preview presets.
- [x] Add separately designed source/runtime support for React Native and
  Flutter. React Native/Expo has a source-only adapter with parser-backed
  placement/static props plus an opt-in, hash-bound Metro/DevTools bridge;
  Flutter has an analyzer payload validator plus an opt-in Widget
  Inspector/VM Service bridge. Neither advertises web visual binding.
- [x] Run the focused Components tests for each implemented slice.
- [x] Run the mandatory repository test gates after operator approval.
- [x] Commit the verified implementation on `feature/native-components`.

### Immediate next implementation sequence

Do not defer the Webflow-like component navigation/editing work until after the
remaining framework adapters. Once the current React catalog slice is verified,
execute the next deliveries in this order:

- [x] **Next 1 — Phase 3:** component rows in the Element Tree, double-click
  focus navigation, and green component hover/selection presentation.
- [x] **Next 2 — Phase 4:** focused CSS Editor, Visual Editor, and Agent edits
  that target the proven component definition.
- [x] **Next 3 — Phase 5:** finish safe placement/prop mutations, then add
  Duplicate, Rename, and Delete definition refactors.
- [x] **After those — Phase 6+:** additional framework adapters, extraction,
  advanced slots/presets, and mobile runtime integrations.

## Executive decision

This feature is feasible, provided “Components” means a common Ship Studio
experience over framework-native component definitions rather than a new Ship
Studio runtime. The source project remains the authority: a React component is
still React, an Astro component is still `.astro`, a Vue component is still a
Single-File Component, and a Shopify section or block remains Liquid plus its
schema. Editing a component definition naturally updates all instances because
the framework already supplies that behavior.

The feasible first product is:

- [x] Detect and catalog native React components without running project code.
- [x] Show definitions, props, slots, usage counts, diagnostics, and source
  links.
- [x] Place React components through parser-backed source edits.
- [x] Edit statically-authored React instance props when Ship Studio can prove
  the exact invocation site or the user explicitly chooses an exact usage row.
- [x] Enter an explicit **Edit main** mode in which structure and style edits
  target the definition and affect every instance. Main-source navigation,
  persistent context, and hash-checked visual/structural mutation retargeting
  are implemented.
- [x] Refuse dynamic or ambiguous edits instead of fabricating values or source
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
- **Component boundary**: a source-validated association between one indexed
  component instance and one or more rendered host roots. It is a Ship Studio
  navigation projection, never a wrapper added to project markup.
- **Component focus**: the revision-bound state entered by double-clicking an
  exact boundary. It reveals that component's child elements and constrains
  CSS Editor, Visual Editor, and Agent writes to its proven definition.
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
7. Element Tree component boundaries never add or require layout-affecting DOM
   wrappers/markers in the user's application.
8. Duplicate, Rename, and Delete are graph-aware, previewed source refactors;
   no action may leave a known broken import, export, invocation, or usage.

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
- `src/hooks/useElementTree.ts:19-44` currently serializes only DOM node ID,
  tag, class, text, and children. `src/components/edit/ElementTreePanel.tsx:75-90`
  therefore labels every row as an HTML tag/icon. Component rows require a new
  validated projection layer; they cannot be inferred from capitalization or
  DOM shape inside `RowLabel`.
- `src-tauri/src/proxy/select_script.html:3-65` currently hard-codes blue primary
  and hover outlines plus orange affected-element outlines. Introduce an
  explicit selection-kind message/state and semantic color value supplied by
  Ship Studio; do not replace the normal element palette globally.
- `src/components/edit/ElementToolbar.tsx:91-115` derives its label/icon from the
  selected tag. It is the host-side seam for a component-specific green toolbar
  with `ComponentsIcon`, not a reason to add imperative HTML UI inside the
  iframe.
- `src-tauri/src/commands/components/types.rs:65-100` currently represents only
  text edits to existing files. Definition Duplicate/Rename/Delete requires a
  typed create/move/delete extension with the same expected-hash, staging, and
  rollback guarantees; direct filesystem calls from panel handlers are banned.
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

Component-tree projection, focused visual editing, Duplicate, Rename, and
Delete also report independent capabilities. A dialect may support catalog and
rename while lacking trustworthy runtime boundaries, or support source-only
duplicate while destructive delete remains disabled. Never derive these flags
from a single generic “Components supported” value.

## User experience specification

### Components panel

Add **Components** as a peer to the existing Elements and Variables surfaces in
the preview workspace. It is a dockable panel, not a modal.

The panel must provide:

- Search by component name, source path, group, and kind.
- Framework/folder groups with counts and collapsed state.
- A row for each definition showing name, kind, usage count, read-only or error
  state, whether it is placeable, and an accessible overflow menu for supported
  Duplicate/Rename/Delete definition refactors.
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

### Component boundaries in the Element Tree

The Elements panel must present a component-aware projection of the rendered
tree rather than displaying every component only as its compiled HTML tags.
This projection is navigation state in Ship Studio; it must not insert wrapper
elements, persistent attributes, or Ship Studio-specific component syntax into
the user's project.

- A proven framework component instance appears as one virtual component row.
  Its label is the indexed component name and its icon is the shared
  `ComponentsIcon`, never the underlying root tag icon.
- A component may render one root, a fragment with several roots, a portal, or
  no host node. The adapter returns an explicit boundary mapping. Multi-root
  instances remain one virtual row with several validated host roots; portals
  and unprovable/no-host boundaries remain source-only rather than being
  attached to a guessed DOM parent.
- Children inside a component boundary are opaque by default. A chevron must
  not bypass the boundary: the user double-clicks the component row (or the
  green component boundary in Preview) to enter it and reveal its child
  elements. Single click selects the component as a component.
- Outside focus, a preview double-click on an exact component boundary enters
  component focus before the existing inline-text double-click handler can run.
  Once focused, double-clicking an eligible child text element resumes the
  existing inline text-edit behavior.
- Entering a nested component pushes another focus level. Show a breadcrumb
  such as `Page / Header / NavItem`; `Escape`, the breadcrumb back action,
  route navigation, or closing the relevant project unwinds focus safely.
- While outside a component, the tree shows the component row but not its
  internal DOM. While focused inside it, normal element rows are visible and
  editable, but any nested component remains an opaque component row until it
  is also double-clicked.
- Selecting from the canvas and selecting from the Element Tree must converge
  on the same `ComponentSelection` state. HMR/reindexing rebinds that state by
  component/instance identity and source hash; if it cannot be rebound exactly,
  exit focused editing and show a diagnostic rather than selecting a similarly
  shaped DOM subtree.
- `sourceAnchored`, `ambiguous`, and `none` bindings may show a component label
  and source navigation, but only an `exact` validated boundary may hide/reveal
  child rows or enter definition-focused visual editing.

Represent the tree as a discriminated union rather than adding nullable fields
to every DOM node:

```ts
type ComponentAwareTreeNode =
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
```

The injected preview bridge may collect bounded runtime owner hints for each
host node, but the app/worker must validate them against the current component
index before synthesizing a component row. Runtime framework internals are
hints, not authority. Batch the binding work per tree revision; do not issue one
filesystem or worker request per DOM node.

### Component selection and focused visual editing

Component selection is visually distinct from ordinary element selection:

- Normal element hover/selection remains blue.
- Component hover, component selection, its info toolbar, matching Element Tree
  row, focus breadcrumb, and component-related action affordances use one
  semantic `--accent-component` token backed by Ship Studio's established
  Components green. Do not hard-code a new green in React, CSS, or the injected
  iframe script.
- A selected component boundary uses a solid green outline. Other rendered
  instances affected by definition editing may use a lower-emphasis dashed
  green outline. Do not mix the normal blue primary outline or orange
  same-source-element outline into component selection state.
- The selection toolbar shows `ComponentsIcon`, component name, and relevant
  component actions instead of the root tag/icon. Accessible names must say
  “Selected component: …”, not “Selected element”.
- After double-clicking into the component, retain a subtle green outer boundary
  and focus breadcrumb. An individual child element selected inside that focus
  uses the normal blue element treatment, making “component scope” and “current
  child element” simultaneously legible.
- Respect forced-colors/reduced-motion settings and never rely on green alone:
  the Components icon, label, boundary style, and accessible state text are all
  required.

Focused component editing is the completed form of **Edit main**. It keeps the
running page context but changes the permitted source target:

1. Double-clicking an exact component boundary creates a
   `ComponentFocusSession` containing component ID, instance ID, definition and
   invocation refs, index revision, validated host node IDs, and nested focus
   ancestry.
2. CSS Editor and Visual Editor resolvers must prove that each selected child
   maps inside the focused definition's source range before planning a write.
   They write the definition, never the invocation or an unrelated instance.
3. The Agent receives a structured, bounded focus context (definition path and
   hash, component name/ID, supported capabilities, selected child source ref,
   and explicit instruction that changes affect all usages). Do not send source
   text or absolute paths through analytics, and do not let the Agent infer a
   target from the green outline alone.
4. Instance prop controls remain disabled while definition focus is active.
   Changes to an invocation still require explicit **Edit instance** mode or a
   selected usage row.
5. Any stale hash, HMR identity loss, ambiguous child mapping, route change, or
   unsupported server/client boundary exits or suspends writes and asks the
   user to refresh/re-enter. Never silently fall back to normal element editing.

Register `components.focus`, `components.focusParent`, and
`components.exitFocus` with live capability predicates. Double-click is the
primary spatial gesture, but every focus transition must also be keyboard and
command-palette accessible.

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

### Duplicating, renaming, and deleting definitions

The Components panel provides an overflow/context menu for each definition and
matching command-palette actions:

- `components.duplicateDefinition`
- `components.renameDefinition`
- `components.deleteDefinition`

These are source refactors, not catalog metadata changes. Every action is
adapter-planned from the current immutable index, presents the exact affected
files and source diff before commit, and uses the same guarded Rust mutation
boundary as placement/prop editing. Disable an action when its capability is
not proven, and show the adapter's structured reason.

**Duplicate**:

- Ask for the new framework-valid component name and destination source file.
  Suggest a sibling path from explicit project conventions, but never commit a
  guessed path without user confirmation.
- Create a new native definition with a new source identity and zero usages.
  Rename the copied local/export symbol and preserve only the imports, types,
  styles, and module-private dependencies the adapter can prove are required.
- Do not copy an entire multi-component module, story, test, route root, or
  unrelated export merely because the selected definition shares its file.
  If a safe dependency closure cannot be produced, refuse and offer **Open
  source**.
- Refuse destination collisions, case-insensitive path collisions, invalid
  names, server/client boundary changes, unresolved aliases, or copying across
  unsupported package/workspace boundaries.

**Rename**:

- Rename the actual native definition symbol/export and every statically
  resolved import, re-export, namespace reference, and invocation in one
  graph-aware plan. This is never a display-only label.
- When a dedicated file's basename follows the component name, offer a checked
  **Rename file too** option and preview the proposed path. Update every proven
  relative import path. Do not rename a shared/multi-definition file by default.
- Validate framework naming rules, reserved route/special-file names, symbol and
  path collisions, filename case-only changes, public package exports, and
  unresolved/dynamic references. Refuse if the complete internal reference set
  cannot be proven; do not leave compatibility aliases unless the user
  explicitly requests a separately designed public-API migration.
- After commit, rebuild the index and select the replacement component ID. The
  old ID must disappear and the usage graph/count must be preserved.

**Delete**:

- Show a destructive `ModalFrame` confirmation with component name, definition
  path, exact source-usage count, and affected files. Never delete on a single
  menu click or use only a toast as confirmation.
- A zero-usage component may be deleted by removing its exact declaration or,
  only when the adapter proves the file contains no other retained code, its
  dedicated file. Clean up imports/re-exports made unreachable by that deletion
  only when the graph proves they are now unused.
- When usages remain, the default **Delete** action is blocked and the dialog
  links to **Show usages**. A separate explicit **Remove all usages and delete**
  action may be enabled only when every invocation and cleanup edit is exact,
  static, and previewed. Its confirmation must state that rendered content and
  any children/props at those invocations will be removed.
- Ambiguous, dynamic, external-package, runtime-only, portal-only, or unresolved
  usages block destructive deletion. Never delete the definition while leaving
  known broken imports/invocations, and never guess a replacement component.

Extend the mutation protocol from text edits against existing files to an
explicit transactional union:

```ts
type ComponentFileOperation =
  | { kind: 'edit'; file: string; expectedHash: string; edits: ComponentTextEdit[] }
  | { kind: 'create'; file: string; expectedAbsent: true; contents: string }
  | { kind: 'move'; from: string; to: string; expectedHash: string; expectedAbsent: true }
  | { kind: 'delete'; file: string; expectedHash: string };
```

The final wire shape also carries expected result hashes, dialect/parser
validation tokens, index revision, and expected component/usage graph delta.
Rust canonicalizes every source and destination beneath the active workspace,
rejects ignored/generated/vendor paths and symlink escapes, stages every
operation before commit, preserves permissions/newlines, and rolls the complete
transaction back on failure. Deletions retain a recovery backup until the full
plan and graph convergence succeed. Handle case-only renames explicitly on
case-insensitive filesystems through a validated intermediate sibling path.
Do not shell out to `mv`, `rm`, framework CLIs, formatters, or project Node.

### Webflow features deliberately deferred

- **Create component from selection**: later AST extraction flow; see Phase 7.
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
      /          |             |                \
catalog UI  usage/binding  component-tree   mutation/refactor
                 |          projection          planner
       preview owner hints      |                |
                 +--------------+----------------v
                         Rust hash/path/parse guard
                                    |
                     atomic edit/create/move/delete transaction
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
  componentTreeBoundary: boolean;
  focusedVisualEditing: boolean;
  duplicateDefinition: boolean;
  renameDefinition: boolean;
  deleteDefinition: boolean;
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
  projectTree(input: ComponentTreeProjectionInput, index: ComponentIndex): ComponentTreeProjection;
  planInsert(input: InsertComponentInput, index: ComponentIndex): MutationResult;
  planPropEdit(input: EditComponentPropInput, index: ComponentIndex): MutationResult;
  planDuplicate(input: DuplicateComponentInput, index: ComponentIndex): RefactorResult;
  planRename(input: RenameComponentInput, index: ComponentIndex): RefactorResult;
  planDelete(input: DeleteComponentInput, index: ComponentIndex): RefactorResult;
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

For placement/prop edits, `MutationPlan` contains project-relative files,
expected SHA-256 hashes, sorted non-overlapping text edits, parser/dialect,
expected graph delta, and warnings. Phase 5 generalizes this into the explicit
edit/create/move/delete operation union specified above; both paths use one
validation and transaction boundary.
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

The project-scoped catalog must also be available while the component-aware
Element Tree or a component command is active, even if the Components panel is
closed. Share one worker/index session across these consumers; never build a
second catalog per panel or bind every tree row through an independent request.

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
- `src/lib/components/component-tree.ts`
- `src/lib/components/focus.ts`
- `src/lib/components/refactors.ts`
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
- `src/lib/components/component-tree.test.ts`
- `src/lib/components/refactors.test.ts`
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
- `src/hooks/useComponentFocus.ts`
- `src/hooks/useComponentFocus.test.ts`
- `src/hooks/useComponentCommands.tsx`
- `src/components/edit/ComponentsPanel.tsx`
- `src/components/edit/ComponentsPanel.test.tsx`
- `src/components/edit/ComponentDetails.tsx`
- `src/components/edit/ComponentInstanceControls.tsx`
- `src/components/edit/EditMainBanner.tsx`
- `src/components/edit/ComponentActionsMenu.tsx`
- `src/components/edit/DuplicateComponentModal.tsx`
- `src/components/edit/RenameComponentModal.tsx`
- `src/components/edit/DeleteComponentModal.tsx`
- `src/styles/features/components.css`
- `src-tauri/src/commands/components/mod.rs`
- `src-tauri/src/commands/components/types.rs`
- `src-tauri/src/commands/components/inventory.rs`
- `src-tauri/src/commands/components/graph_guard.rs`
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
  source-frame collection, bounded tree-owner hints, and semantic selection
  presentation;
- `src/hooks/useElementTree.ts`, `src/components/edit/ElementTreePanel.tsx`, and
  `src/components/edit/ElementToolbar.tsx` for the validated component-aware
  tree projection, double-click focus, and component selection toolbar;
- `src/lib/edit.ts`, `src/hooks/useVisualEditor.ts`, and
  `src/components/edit/UsageScope.tsx` to migrate usage/binding;
- the CSS Editor/Visual Editor mutation resolvers and Agent bridge context DTOs
  only where required to enforce a `ComponentFocusSession` target;
- `src/components/preview/Preview.tsx` to host the panel/banners and shared
  project-scoped state;
- `src/styles/features/element-tree.css`,
  `src/styles/features/element-structure.css`, Components styles,
  `src/styles/index.css`, and token files for component focus/selection states;
- `docs/analytics.md` and the existing analytics wrapper for registered events.

Keep each source file within the repository LOC gates. Split types, adapters,
UI, and tests instead of growing `edit.rs` or `Preview.tsx` further.

## Commands the executor will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install parser deps | `pnpm install` | exit 0 and lockfile updated deterministically |
| Target React adapter | `pnpm test:run -- src/lib/components/adapters/react.test.ts` | named suite passes |
| Target proxy behavior | `pnpm test:run -- src/components/edit/selectScript.test.ts` | named suite passes |
| Target component tree/focus | `pnpm test:run -- src/lib/components/component-tree.test.ts src/hooks/useComponentFocus.test.ts src/components/edit/ElementTreePanel.test.tsx` | named suites pass |
| Target lifecycle refactors | `pnpm test:run -- src/lib/components/refactors.test.ts src/components/edit/ComponentsPanel.test.tsx` | named suites pass |
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

- [x] **Phase 0 complete**
  - [x] Add a lazy app-bundled parser Web Worker.
  - [x] Load the TypeScript compiler in the worker without using project Node.
  - [x] Build the worker successfully as a separate production bundle.
  - [x] Add a versioned request/response protocol and worker cancellation.
  - [x] Load and prove the Astro parser/WASM path.
  - [x] Smoke-test the worker in Tauri dev and a packaged Tauri build.
  - [x] Record parser/runtime, bundle-size, startup, and licensing decisions in
    `docs/internal/components.md`.
  - [x] Run the Phase 0 focused tests.

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

- [x] **Phase 1 complete**
  - [x] Add bounded, workspace-scoped Rust source inventory and batch reads.
  - [x] Add normalized component/index/profile DTOs and UTF-8 range utilities.
  - [x] Build immutable, revisioned React indexes in the worker.
  - [x] Resolve common React imports, exports, re-exports, aliases, usages,
    props, defaults, and children slots.
  - [x] Add partial-index diagnostics and fail-closed unsupported states.
  - [x] Bind revisions to the canonical active workspace and restrict reads to
    the tracked snapshot.
  - [x] Add the Rust source watcher and incremental update lifecycle.
  - [x] Add the native Astro adapter.
  - [x] Add internal-package `needSources` resolution rounds.
  - [x] Run the Phase 1 focused frontend and Rust tests.

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

- [x] **Phase 2 complete**
  - [x] Add the Components panel, details, search, framework/folder grouping,
    usages, empty/error/partial states, and explicit refresh.
  - [x] Add the supplied Components icon to the shared icon system.
  - [x] Add `components.open`, `components.search`,
    `components.openSource`, and `components.showUsages` commands.
  - [x] Use shared Buttons, Tabs, fields, dockable-panel shell, async hooks, and
    token-only CSS.
  - [x] Gate Vite availability on proven React project detection rather than
    exposing the React adapter in Vue/Svelte Vite projects.
  - [x] Add panel tests for catalog, loading, busy, required-prop, and
    main-source behavior.
  - [x] Add product analytics for catalog interactions.
  - [x] Add persistent pin/dock, floating position/size, and docked resize
    behavior through `DockablePanel`.
  - [x] Run the Phase 2 focused tests.

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

### Phase 3: Make Components first-class in the Element Tree and Preview

- [x] **Phase 3 complete — immediate next product milestone**
  - [x] Add `exact`, `sourceAnchored`, `ambiguous`, and `none` binding states.
  - [x] Normalize common runtime source URLs and downgrade line-only hints
    instead of claiming an exact instance.
  - [x] Add Next App Router Server Component provenance for unambiguous,
    static single-host boundaries without adding DOM wrappers or markers to the
    user's application.
  - [x] Add batched, source-validated component boundary projection over the
    raw DOM Element Tree.
  - [x] Render virtual component rows with `ComponentsIcon` and opaque children.
  - [x] Add double-click/keyboard entry, nested focus breadcrumbs, and safe
    `Escape`/navigation exit behavior.
  - [x] Add semantic green hover/selection/focus states in the iframe, Element
    Tree, and component toolbar without changing normal blue element selection.
  - [x] Add `components.focus`, `components.focusParent`, and
    `components.exitFocus` commands with live predicates.
  - [x] Run the Phase 3 focused tree, proxy, and accessibility tests.

Implement this phase immediately after the read-only catalog. It is intentionally
read/navigation-first: users should see and enter real Components in the Element
Tree before later adapter expansion or extraction work. Do not wait for every
definition mutation to be finished before shipping the validated tree projection
and green component selection state.

Do not hide DOM children until the parent has validated runtime hints against
the current source index; an unvalidated boundary remains ordinary element
rows. This phase may enter a read-only focus session, but it must keep CSS,
Visual, and Agent writes disabled until Phase 4 proves their definition target.

**Verify**:
`pnpm test:run -- src/lib/components/component-tree.test.ts src/hooks/useComponentFocus.test.ts src/components/edit/ElementTreePanel.test.tsx src/components/edit/selectScript.test.ts`
passes component/icon projection, single/multi-root and nested boundaries,
double-click/keyboard focus, stale/ambiguous refusal, blue/green selection,
forced-colors labels, and unchanged project DOM/layout cases.

### Phase 4: Enable focused component editing in CSS, Visual, and Agent workflows

- [x] **Phase 4 complete — follows Phase 3 directly**
  - [x] Disable instance writes unless an exact usage is explicitly selected.
  - [x] Add persistent main-source context, usage-impact copy, and source
    navigation.
  - [x] Emit the complete React Fiber owner-frame chain with source hashes.
  - [x] Integrate index-backed binding with all legacy Usage Scope call sites.
  - [x] Retarget CSS Editor and Visual Editor mutations to an exact focused
    definition source range.
  - [x] Pass a structured, hash-bound component focus context to the Agent and
    prevent fallback to guessed files/ranges.
  - [x] Preserve the green outer focus boundary while child-element selection
    and editing use the normal blue element treatment.
  - [x] Add exact HMR rebind plus safe stale-hash, route, and ambiguity exits.
  - [x] Add Astro definition/source-anchored binding without pretending exact
    rendered invocation identity.
  - [x] Run the Phase 4 focused binding/editor/Agent tests.

Extend the selection protocol to emit candidate source frames, validate those
frames against the index, and return binding confidence. Integrate the result
with `useVisualEditor`, the CSS Editor, existing Usage scope, Element Tree focus,
and the Agent context DTO.

Keep the old `find_component_usage` command during rollout behind a fallback or
feature flag. Once index-backed output covers its supported fixtures, migrate
all call sites and remove the heuristic plus its duplicate TS types/tests.

Each editor must independently prove that its planned source range is inside
the focused definition at the current revision. Agent focus is enabled only
after the same DTO is enforced by local editor resolvers; the Agent is not a
bypass around binding or mutation validation.

**Verify**:
`pnpm test:run -- src/components/edit/selectScript.test.ts src/hooks/useComponentBinding.test.ts src/hooks/useComponentFocus.test.ts`
passes exact React owner-chain, source-anchored Astro, focused CSS/Visual/Agent
targets, nested focus, HMR rebind, ambiguous/stale refusal, and no-framework
cases.

### Phase 5: Complete safe mutations and definition lifecycle actions

- [x] **Phase 5 complete — finish before additional framework adapters**
  - [x] Add React placement planning with import reuse/insertion and
    collision/cycle/self-recursion refusal.
  - [x] Add exact AST range validation, Unicode-safe byte offsets, minimal text
    edits, and expected revision/content hashes.
  - [x] Add guarded Rust multi-file staging, size bounds, rollback, and recovery
    backups.
  - [x] Add required-prop setup and string/number/boolean/literal-choice inputs.
  - [x] Add dirty-only static instance-prop editing and dynamic-value reasons.
  - [x] Enable Place only when edit mode has a selected source-backed target.
  - [x] Add `components.placeSelected`, `components.editMain`, and
    `components.exitMain` command IDs with capability predicates.
  - [x] Add before/after/inside placement selection and source-diff approval.
  - [x] Revalidate parser dialect and expected graph delta at the Rust boundary.
  - [x] Add the React/Next Duplicate menu, modal, command, source preview, and
    capability diagnostics for dedicated same-directory definitions.
  - [x] Add the React/Next named-export Rename menu, modal, command, reviewed
    multi-file source preview, and capability diagnostics. Keep default exports,
    re-export chains, shadowed bindings, and file moves refused until their
    dependency resolver can prove the complete edit set.
  - [x] Add the React/Next named-export Delete menu, destructive confirmation,
    command, reviewed multi-file source preview, and capability diagnostics.
    The first slice removes the exact definition/usages and keeps the source
    file; default exports, re-exports, non-JSX references, and file deletion
    remain planner-disabled until their dependency closure and review UX are
    implemented.
  - [x] Extend the Rust transaction boundary with a guarded create-only
    operation, no-overwrite commit, source-path validation, and graph checks.
  - [x] Extend the Rust transaction boundary to guarded edit/create/move/delete
    operations with complete pre-commit staging, rollback, and recovery backups;
    migrate lifecycle refactors from the legacy edit-only payload.
  - [x] Reindex after a completed Duplicate and verify the expected component ID
    and usage-graph delta before reporting success.
  - [x] Add native Astro mutation planning.
  - [x] Add OS-handle/no-follow protection for hostile external filesystem races.
  - [x] Run the Phase 5 focused mutation/refactor frontend and Rust tests.

Finish the existing React placement and static-prop vertical slice first, then
implement Duplicate, Rename, and Delete before starting Vue/Svelte/Shopify/Web
Component adapters. Duplicate proves create-file transactions without changing
references; Rename adds graph-wide reference edits and the guarded move boundary;
Delete is last because it is destructive.

Implement string/number/boolean/literal-union prop controls only for exact
invocations or explicitly selected usage rows. Every placement and lifecycle
action presents its diff, carries an expected graph delta, and stays behind
per-definition capabilities. Do not enable a refactor merely because its panel
control exists.

**Verify**:
`pnpm test:run -- src/lib/components/mutation.test.ts src/lib/components/refactors.test.ts src/components/edit/ComponentsPanel.test.tsx && pnpm rust:test -- commands::components::mutation`
passes placement/prop cases, duplicate/rename/delete graph updates, exact diff
previews, create/move/delete rollback, collisions, unresolved usages, stale
hashes, syntax failures, destructive confirmation, and expected graph deltas.

### Phase 6: Add Vue/Nuxt, Svelte/SvelteKit, Shopify, and Web Components

- [x] **Phase 6 complete**
  - [x] Vue/Nuxt adapter.
  - [x] Svelte/SvelteKit adapter.
  - [x] Shopify adapter.
  - [x] Native Web Components/static HTML adapter.

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

### Phase 7: Add extraction, slots, and optional preview presets

- [x] **Phase 7 complete**
  - [x] Create component from selection.
  - [x] Static default-slot editing.
  - [x] Named/scoped slot editing per capable adapter.
  - [x] Optional explicit preview presets.
  - [x] Proven-safe inline-simple-component transform, if approved.

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

**Verify**: `pnpm exec vitest run
src/lib/components/extraction.test.ts src/lib/components/slots.test.ts
src/lib/components/presets.test.ts` — 11 tests passed on 2026-09-04. React
extraction is the only enabled create-from-selection adapter; Vue named/default
slot coverage and dynamic/refusal cases are included in the slot suite. The
worker and Rust apply paths retain the existing focused mutation verification.

### Phase 8: Treat mobile as separate runtime integrations

- [x] **Phase 8 complete**
  - [x] React Native/Expo source-only adapter and fixtures.
  - [x] Separate Metro/devtools runtime-binding plan and bridge.
  - [x] Separate Flutter analyzer/Widget Inspector plan and bridge.

React Native/Expo may reuse source indexing and source-only placement after its
own fixtures pass. A visual bridge requires an opt-in Metro transform/devtools
protocol that returns component/instance IDs tied to source hashes.

Flutter requires a Dart-analyzer source service and Widget Inspector/VM-service
runtime bridge. Write a new dedicated plan before implementing either bridge.
Do not infer component identity from mirrored screenshots or coordinates.

**Verify**: `pnpm exec vitest run src/lib/components/mobile-runtime.test.ts
src/lib/components/adapters/react-native.test.ts` — 6 tests passed on
2026-09-04. The separate plan defines security, project
instrumentation, cleanup, version compatibility, and the iOS/Android
device/simulator matrix. Source-only catalog support remains labelled
source-only; live native builds are an explicit release validation, not an
implicit claim of the web preview.

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

Definition-lifecycle cases:

- duplicate a dedicated component, a component with imports/types/styles, and a
  component whose module-private dependency closure is unsafe to copy;
- duplicate name/path/case-insensitive collision, reserved framework name,
  multi-component module, unresolved alias, and cross-workspace refusal;
- rename named/default exports, aliased imports, re-exports, namespace usage,
  JSX invocations, matching dedicated filenames, relative import paths, and a
  filename case-only change;
- rename collision, unresolved/dynamic reference, shared file, route-special
  filename, public package export, stale revision, and partial-index refusal;
- delete zero-usage declaration, safe dedicated file, and exact all-usage plan;
- block delete with remaining, ambiguous, dynamic, external, portal-only, or
  unresolved usages and verify no file is removed;
- transactional create/move/delete staging, permission/newline preservation,
  expected graph deltas, rollback after each possible operation failure, and
  retained recovery backup when external writes make rollback unsafe.

Runtime/UI cases:

- component panel loading/empty/partial/error/populated states;
- search/group/capability badges and keyboard accessibility;
- exact/source-anchored/ambiguous/none binding;
- component-aware Element Tree projection for single-root, fragment/multi-root,
  nested, repeated, conditional, portal, and no-host components;
- component rows always use `ComponentsIcon`; their children remain hidden until
  double-click/Enter focus and nested focus unwinds one level at a time;
- green component hover/selection/toolbar/tree state, normal blue child-element
  selection inside a persistent green focus boundary, and forced-colors labels;
- HMR exact rebind, stale source-hash exit, route-navigation exit, ambiguous
  boundary refusal, and no wrappers/layout changes in project DOM;
- Edit-main enter/exit/navigation/pending-edit behavior;
- CSS Editor, Visual Editor, and Agent edits from focus target only the exact
  definition and affect its indexed usages; invocation props remain disabled;
- Duplicate/Rename/Delete menus, commands, keyboard access, busy/error states,
  exact diff review, destructive usage-count confirmation, and post-refactor
  selection/reindex behavior;
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
- component boundary projection/focus entered/exited/refused with reason and
  bounded count buckets;
- placement/prop/main-edit attempted/succeeded/refused with reason category;
- definition duplicate/rename/delete attempted/succeeded/refused with dialect,
  capability, operation-count bucket, and reason category;
- mutation stale-hash/parse/rollback failures.

Never record absolute paths, source text, component/export names, prop names or
values, route parameters, merchant IDs, or project package names.

Add structured tracing around inventory, parse request duration, graph size,
binding, and mutation validation. A worker crash should restart once and rebuild
from the latest snapshot; repeated failure disables Components for that project
session with a diagnostic while leaving Preview and code editing operational.

## Done criteria

The whole plan is complete only when all of the following hold:

- [x] Ship Studio detects component dialects independently from coarse
  `ProjectType`, including multi-dialect Astro and React-flavoured Vite.
- [x] React/Next/Vite and native Astro have a read-only catalog, exact source
  usage graph, props/slots metadata, and honest capability diagnostics.
- [x] React/Astro placement and static prop edits use parser-backed, hash-checked,
  fail-closed source mutations.
- [x] Edit-main mode is explicit and existing visual edits target a proven
  definition source.
- [x] Exact component instances appear as virtual `ComponentsIcon` rows in the
  Element Tree, with opaque children until an accessible double-click/enter
  focus transition.
- [x] Component hover/selection/focus is consistently green and labelled as a
  component, while ordinary child-element selection remains blue.
- [x] CSS Editor, Visual Editor, and Agent focused edits are hash-bound to the
  proven component definition and cannot fall back to an invocation or guessed
  source target.
- [x] Duplicate, Rename, and Delete are adapter-planned source refactors with
  reviewed diffs, exact graph deltas, transactional create/move/delete support,
  and fail-closed ambiguity/destructive safeguards.
- [x] Vue/Nuxt, Svelte/SvelteKit, Shopify, and native Web Components have their
  adapter capabilities enabled only to the level proven by fixtures.
- [x] React Native/Flutter are not advertised as visually bound until separate
  runtime bridges exist.
- [x] No feature path executes project code/config or depends on project Node.
- [x] No dynamic value, route, default, thumbnail, usage, or source target is
  inferred and presented as fact.
- [x] Parser, graph, mutation, runtime binding, and UI refusal cases are tested.
- [x] Every currently implemented user-facing action is registered with
  `useCommands`; UI uses shared
  primitives and design tokens.
- [x] All implemented Rust commands use `CommandError`, validation, tracing,
  bounded work, and safe cleanup.
- [x] `pnpm check:all`, `pnpm test:run`, and `pnpm rust:test` pass after operator
  approval to run the long suites.
- [x] `docs/internal/components.md` documents support levels and limitations.
- [x] `plans/README.md` marks this plan `DONE` only after all separately shipped
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
- a component boundary would require inserting a wrapper/marker that changes
  layout, hydration, accessibility, or framework semantics;
- a multi-root/nested/runtime component cannot be projected into the Element
  Tree without guessing its host ownership;
- focused CSS/Visual/Agent editing cannot prove that the requested source range
  lies inside the selected definition at the current revision;
- an edit requires guessing a dynamic prop, route, hydration directive, provider,
  import alias, Shopify template, block permission, or client/server boundary;
- a requested write spans more files than the mutation layer can roll back;
- Duplicate/Rename/Delete encounters an unresolved import/export/usage,
  shared-file dependency, external package boundary, or public API that prevents
  a complete graph-aware refactor;
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
- Keep the raw DOM snapshot separate from the component-aware tree projection.
  Changing framework owner hints must never make the injected bridge authoritative
  or leak AST/index responsibilities into the iframe.
- Treat `ComponentFocusSession` as a revision-bound capability, not durable UI
  state. Every HMR/index change must revalidate it before any editor or Agent
  write remains enabled.
- Definition lifecycle operations are refactors, not filesystem conveniences.
  Review graph completeness, case-insensitive paths, shared modules, and rollback
  behavior more closely than the Duplicate/Rename/Delete menu presentation.
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
