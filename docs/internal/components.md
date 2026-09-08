# Components support

This document records the support boundary for Ship Studio's native Components
index. The source project remains authoritative. Ship Studio parses bounded
source snapshots and never executes project modules, framework configuration,
plugins, or the project's Node runtime while building the catalog.

## Support matrix

| Dialect | Catalog / graph | Runtime binding | Source writes | Library ownership / fork | Notes |
| --- | --- | --- | --- | --- | --- |
| React / Next / React-flavoured Vite | Enabled | Exact React Fiber hints; Next Server Component provenance for a unique stable root | Placement, static exact-instance props, focused definition edits, conservative named-export lifecycle | Explicit workspace package exports are read-only in consumers; direct named React exports can be copied through a reviewed local fork | DOM boundaries are projected only after source/hash validation. |
| Native Astro | Enabled | Source-anchored only | Placement and static source-usage props | Package ownership is read-only; local fork is disabled until an Astro transform proves its dependency closure | No exact rendered invocation identity or Element Tree boundary. |
| Vue / Nuxt | Enabled | Source-anchored only | Static source-usage placement/props | Package ownership is read-only; local fork is disabled until a Vue transform proves its dependency closure | `.vue` SFC parsing uses `@vue/compiler-sfc`; route files remain roots. |
| Svelte / SvelteKit | Enabled | Source-anchored only | Static source-usage placement/props | Package ownership is read-only; local fork is disabled until a Svelte transform proves its dependency closure | Supports legacy `export let`, Svelte 5 `$props`, `<slot>`, and snippets at the bounded-source level. |
| Shopify theme | Enabled | Source-anchored only | Conservative Liquid/JSON placement and static values | Package ownership is read-only; no source fork is claimed | Sections, blocks, snippets, schema settings, and JSON section references are distinct kinds. |
| Native Web Components | Enabled | Source-anchored only | Static HTML observed-attribute edits and placement | Package ownership is read-only; no source fork is claimed | A tag enters the catalog only when `customElements.define` is present. |
| React Native / Expo | Source-only | Opt-in source-hash runtime bridge | Source-only placement/static props; visual writes disabled | Package ownership is metadata-only; no source fork is claimed | JSX source is indexed under a separate dialect; native provenance never enters the web DOM protocol. |
| Flutter | Analyzer-backed source-only (opt-in) | Opt-in Widget Inspector/VM Service source-hash bridge | Disabled | Package ownership is metadata-only; no source fork is claimed | Dart grammar/package resolution stays with the analyzer; native provenance is a separate integration. |

## Component Canvas rendering and QA

The Component Canvas is always safe to open: named presets, explicit static
props/slots, finite choices, frame presentation metadata, orphan reporting, and
bounded matrix planning are source-backed UI state. Those features do not imply
that a frame can be rendered in Ship Studio.

Rendered frames and visual/a11y QA require a host-owned isolated renderer. The
host must negotiate protocol `1`, use the same opaque project identity, accept
only a component ID/source revision and explicit static values, and return an
image data URL plus a pixel fingerprint. The host owns the project runtime in
its own preview surface; Ship Studio never imports a component module, runs
framework config, evaluates slot text, or mounts returned project markup in its
own process. Stale or malformed host responses are discarded.

No current web adapter advertises `isolatedPreview`, so the packaged app keeps
rendered frames, baseline capture, pixel comparison, and automated a11y
disabled until a dialect provides that proof. Exact live-usage capture remains
a separate workflow and is never accepted as a Component Canvas baseline: a
baseline requires the isolated host's screenshot path and pixel fingerprint
for the explicit frame. Baselines record the source revision, frame identity,
threshold, and host fingerprint. Legacy baselines without a fingerprint are
shown as unavailable and must be recaptured rather than reported as a match.

Capability flags are the contract behind this table. A useful read-only catalog
does not imply a runtime binding or a write capability. Dynamic values,
ambiguous source matches, stale hashes, unsupported route boundaries, and
unresolved imports remain visible as diagnostics and fail closed.

## Code-native shared libraries

The catalog recognizes a library only when a bounded, project-relative
`package.json` has a literal export that resolves to source already present in
the immutable snapshot and that source contains an indexed definition. Package
names alone are never treated as ownership evidence. The panel groups these
entries under **Library Components** and shows only metadata returned by the
manifest: package name, version when present, repository when present, and
validated package root.

Library definitions remain read-only in a consumer project. Source navigation
is available, while placement, instance edits, main-source editing, lifecycle
refactors, and slot writes are disabled until the user works in the owning
source project. A React direct named export with no relative imports may be
copied to an explicit project-relative destination. The copy is shown in a
reviewed source diff, uses the normal hash/path/syntax guards, and is detached
from future library updates. Collisions, export identity changes, unsupported dialects, and
relative dependency closures fail closed.

When a previously saved library metadata snapshot differs from the current
snapshot, the panel shows a review containing only known package metadata,
added/removed exports (export renames are not inferred), parsed component-contract changes, and explicit
token/asset/font resource changes. Accepting acknowledges the resolved
metadata; deferring leaves it available for later review. Neither action runs
a package manager or rewrites a dependency or lockfile. Update application is
therefore intentionally limited to a reviewed package-manager plan outside the
component catalog.

Unsupported for this slice: remote registries, package managers other than
literal workspace/project manifests understood by the bounded resolver,
wildcard or computed exports, build-output-only packages, barrel/default/alias
resolution without explicit source evidence, framework-specific transforms
whose dependency closure is not proven, and automatic dependency or lockfile
rewrites. These cases remain unowned/read-only rather than being guessed.

## React / Next.js

- Exported JSX definitions, explicit prop contracts, children slots, imports,
  usages, and usage counts are indexed in an immutable worker snapshot.
- React development Fiber owner frames are hints. They are validated against
  the current source index and source hash before becoming Element Tree
  boundaries.
- Next App Router Server Components with one indexed invocation and one stable
  intrinsic root use source-derived provenance when Fiber owner frames are
  unavailable. Repeated, dynamic, or colliding roots remain ordinary element
  rows. No wrapper or marker is added to user markup.
- Exact boundaries can be selected, focused, nested, and rebound after HMR
  only while component, invocation, route, and source identity still match.
- Focused CSS, Visual, text, structural, and Agent workflows require a child
  range inside the proven definition. A stale hash, route, ambiguity, or
  missing range refuses the write rather than falling back to an invocation or
  guessed file/range. Structural insert/duplicate/delete calls carry the exact
  element span and complete-file hash into Rust, which revalidates the span
  before splicing it.
- React placement shows a hash-bound diff before applying a parser-backed
  before/after/inside edit. Static exact-instance prop edits refuse dynamic
  expressions.
- Dedicated named React definitions support reviewed Duplicate, Rename, and
  Delete plans for the conservative same-directory graph slice. Default
  exports, re-export chains, shared/multi-component files, unresolved aliases,
  file deletion, and other unproven dependency closures remain refused.

### Extraction, slots, and preview presets

The current extraction slice is deliberately a reviewed source transform, not a
generic DOM-to-component converter:

- **Create component from selection** requires one exact JSX source range from
  the current hash-bound snapshot. The planner parses that range and the
  containing component, computes free identifiers and preserved value imports,
  and returns a proposal before emitting any write operation. The user must
  explicitly approve the complete proposed prop-name set. The planned result
  then contains a create-file operation, an import/invocation replacement, and
  before/after source previews. Type-only imports, duplicate names, path/symbol
  collisions, `use client` boundary changes, stale ranges, partial indexes, and
  control-flow/callback/loop/dynamic JSX scopes are refused.
- **Static slots** are edited through exact slot-body ranges returned by the
  adapter. React `children` and explicit default/named markup slots are
  supported where the adapter can prove the range; Vue template slots use the
  compiler-backed SFC source boundary. Replacement text must be static JSX or
  markup. Slot scopes, Liquid/Vue/Svelte control blocks, dynamic slot names,
  spreads, and stale/no-op ranges are read-only with a diagnostic. Whitespace
  outside the slot body is preserved byte-for-byte.
- **Structured slot composition is source-only.** Element Tree slot rows and
  nested child operations are projected from exact, hash-bound `slotSources`
  ranges. They are not rendered preview nodes, and no drop-zone overlay is
  exposed until the preview can return a slot-qualified boundary for the same
  source invocation.

#### Structured slots and live-preview drop zones

The live-preview drop-zone indicator is intentionally disabled. The current
`ss:tree` bridge payload contains only ephemeral DOM node IDs and bounded
tag/class/text data. React's optional Fiber stack hint can source/hash-bind a
component invocation to rendered host node(s), but it carries no slot name or
slot-body range. `ComponentBoundary` likewise records only component host
nodes; `projectComponentTree` synthesizes slot rows from source and has no
slot-to-host boundary to paint or accept a drop. Vue, Svelte, Shopify, and Web
Components are source-anchored and return no runtime component boundaries.

Mapping a preview drop to a slot without this evidence would invent runtime
identity, so the UI fails closed rather than displaying an unproven drop zone.
Enabling it requires a versioned host-protocol extension that returns a
source/hash-bound, slot-qualified rendered boundary for the active preview
tree, with stale and ambiguous mappings rejected. Until then, use the Element
Tree structured controls or the labelled advanced source editor. Shopify's
`editSlots` capability remains conservative: `content_for "blocks"` is
runtime-generated and has no exact authored instance slot range, so plans
refuse with `missing-slot`.
- **Preview presets** are optional presentation metadata stored under the
  versioned `ship-studio.component-presets.v1` key supplied by the host. A
  preset contains only explicit static props and slot strings plus the component
  ID/dialect; it never invents defaults or executes component code. On reload,
  presets are reconciled against the current immutable index. Missing or renamed
  component IDs, dialect changes, and unknown props/slots become orphaned
  records rather than being retargeted silently. Unknown future versions are
  rejected at the v1 storage boundary; the caller must preserve those raw
  records and perform an explicit migration before presenting them.
- **Inline simple component** is the only unlink-like operation in this slice.
  It is named explicitly because it is not general unlink: the React adapter
  accepts only one exact local invocation whose parameterless definition returns
  one static intrinsic JSX root, with no props or slots. It replaces the exact
  invocation with the authored root and leaves the definition in place. Wrapped
  `memo`/`forwardRef` forms are accepted only when their inner function meets
  the same rule. Dynamic roots, custom components, event handlers, expressions,
  multiple returns, cross-file definitions, and components with a boundary
  contract are refused. The plan is still hash/revision checked and reviewed
  before apply.

The implementation lives in the worker-facing extraction, slot, and preset
modules. Keep the proposal/preview/apply sequence intact when adding another
adapter: a component operation is not complete when it merely produces a
rendered result; it must also prove the exact source edit and expected graph
delta.

### Mobile runtime integrations

React Native/Expo and Flutter are intentionally separate from the web preview.
The contract and host validators live in
[`plans/002-mobile-components-runtime.md`](../../plans/002-mobile-components-runtime.md),
`src/lib/components/mobile-runtime.ts`, and
`src/lib/components/flutter-analyzer.ts`.

- React Native/Expo remains source-only by default. Parser-backed placement and
  static props are available from explicit source usage rows under a separate
  `react-native-component-plan-v1` mutation token; visual writes remain
  disabled. An opt-in Metro/DevTools integration can emit definition and
  invocation ranges through runtime protocol `1`. The host accepts a native
  runtime event only after a host-issued session token, renderer check, current
  source hash, and exact index lookup. Definition-only events stay
  source-anchored; no DOM boundary is projected into the Element Tree and no
  pixel coordinate is treated as identity.
- Flutter source records are accepted only from the versioned Dart analyzer
  payload. The analyzer owns Dart grammar and package resolution; Ship Studio
  validates its ranges against the current snapshot before indexing. A paired
  Widget Inspector/VM Service event can become an exact mobile binding only
  when its definition and invocation ranges match the same immutable index.
- Both integrations clear bindings on reload, route change, disconnect, and
  disposal. Unsupported protocol/tool versions, stale hashes, traversal paths,
  missing invocations, renderer/session mismatches, and ambiguity remain
  read-only diagnostics. DeviceMirror continues to be a pixel/input surface and
  does not load the browser `ss:*` protocol.

## Native Astro

- `.astro` definitions outside `pages` are catalogued; layouts are labelled as
  layouts and route files remain page-owned source.
- Frontmatter relative imports, native component tags, `Astro.props`, explicit
  `Props`, default values, and default/named slots are indexed without running
  Astro or project code.
- `@astrojs/compiler` 4.0.0 is loaded lazily in the component worker through
  the app-bundled `astro.wasm?url` asset. The compiler validates the planned
  post-edit document; the source index itself still preserves source anchors
  so it can function without a project build.
- Astro runtime binding is source-anchored only. Rendered DOM does not retain a
  stable invocation marker, so Astro instances are not presented as exact
  runtime selections and are not projected as component boundaries.
- Placement and static prop edits are allowed only for parser-backed source
  rows, carry `astro-component-plan-v1`, expected hashes/revisions, and are
  checked again by the Rust graph guard before commit. Islands, dynamic
  expressions, and hydration/runtime identity are not silently inferred.

## Vue, Svelte, Shopify, and Web Components

These adapters share only the transport and immutable graph plumbing; they do
not pretend to be React. Their source parsers preserve byte-backed ranges and
their capabilities are deliberately conservative.

- Vue parses SFC template/script boundaries with `@vue/compiler-sfc` 3.5.42,
  `defineProps`/Options API declarations, type members, defaults, kebab-case
  imports, named slots, and compiler diagnostics. Nuxt auto-imports are not
  invented when no static import/config evidence exists.
- Svelte parses `.svelte` template boundaries with `svelte` 5.57.0, legacy
  `export let`, `$props` destructuring, type members, slots, snippets, and
  parser errors. Route roots are not catalog definitions.
- Shopify treats section/block/snippet files as native definitions, parses
  JSON schema settings into prop controls/choices, recognizes Liquid render or
  section sites and JSON section types, and does not create imports for theme
  names. Invalid schema JSON makes the index partial.
- Web Components require a `customElements.define('x-name', ...)` registration
  before cataloging a definition. `observedAttributes` become props and native
  `<x-name>` HTML occurrences become source-anchored instances. Unregistered
  custom-looking tags remain ordinary HTML.

For all four dialects, source-anchored usage rows may plan a minimal static
edit when the adapter proves the source range. Compiled DOM instance identity,
framework-specific lifecycle refactors, scoped-style semantics, and dynamic
bindings remain disabled until their own runtime/parser evidence exists.

## Source watching and worker lifecycle

The Rust watcher is scoped by window and validated project root. It filters
generated/dependency/style trees, debounces bursts for 250 ms, re-snapshots the
bounded workspace, and emits only `{ windowLabel, projectPath, revision,
changedFiles }`. The frontend compares immutable snapshots, invalidates only
changed parser-cache entries, updates the worker graph, and falls back to an
explicit refresh if the watcher is unavailable. Internal package source
requests are resolved in at most three bounded rounds of at most 64 files.

The worker protocol is versioned (`1`) and supports cancellation tombstones.
Compiler-backed validation is asynchronous, so a superseded build cannot
publish a stale index. A worker failure rejects pending requests and leaves
the normal Preview/code paths available.

## Safety contract

Every source write carries an expected revision and complete content hashes.
The Rust command validates project-relative paths, re-reads all targets, uses
bounded staging and recovery backups, verifies the expected graph delta, and
commits only after the parser/dialect token and source ranges still match.
Unix commits use no-follow file/directory handles where available to reduce
symlink/race attacks; a hostile parent or changed target is refused.

The component index is disposable UI state. A revision change suspends focused
writes until the same exact boundary is rebound. Component names, prop values,
source text, absolute paths, merchant IDs, and project package names are not
sent to analytics. Metrics use dialect/capability/status/reason categories and
bounded count buckets only.

## Parser/runtime decision and measurements

The parser runtime is app-owned and worker-local:

- TypeScript is already bundled for the React parser.
- `@astrojs/compiler` 4.0.0 (MIT) is lazy-loaded with its WASM asset.
- `@vue/compiler-sfc` 3.5.42 (MIT) parses Vue SFC blocks.
- `svelte` 5.57.0 (MIT) provides the Svelte parser.
- Shopify Liquid and Web Component syntax use bounded local scanners plus
  JSON/TypeScript literal parsing because the supported source-anchored slice
  does not require a theme renderer or browser custom-element registry.

The current Vite production build measured 4,842.86 kB for the
`component-worker` JavaScript chunk and 5,166.91 kB for the Astro WASM asset
(1,426.08 kB gzip for the latter). These are build artifacts, not runtime
network downloads. The lazy parser keeps the initial editor path from paying
the compiler cost until a Components worker request needs it.

The exact package/version, licensing, alternatives, and dev/packaged smoke
procedure are recorded in [the parser ADR](./components-parser-adr.md).
Packaged-app smoke remains a release check: run the documented procedure on
the executor's platform before claiming a packaged worker validation milestone.
