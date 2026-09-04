# Components support

This document records the support boundary for Ship Studio's native Components
index. The source project remains authoritative. Ship Studio parses bounded
source snapshots and never executes project modules, framework configuration,
plugins, or the project's Node runtime while building the catalog.

## Support matrix

| Dialect | Catalog / graph | Runtime binding | Source writes | Notes |
| --- | --- | --- | --- | --- |
| React / Next / React-flavoured Vite | Enabled | Exact React Fiber hints; Next Server Component provenance for a unique stable root | Placement, static exact-instance props, focused definition edits, conservative named-export lifecycle | DOM boundaries are projected only after source/hash validation. |
| Native Astro | Enabled | Source-anchored only | Placement and static source-usage props | No exact rendered invocation identity or Element Tree boundary. |
| Vue / Nuxt | Enabled | Source-anchored only | Static source-usage placement/props | `.vue` SFC parsing uses `@vue/compiler-sfc`; route files remain roots. |
| Svelte / SvelteKit | Enabled | Source-anchored only | Static source-usage placement/props | Supports legacy `export let`, Svelte 5 `$props`, `<slot>`, and snippets at the bounded-source level. |
| Shopify theme | Enabled | Source-anchored only | Conservative Liquid/JSON placement and static values | Sections, blocks, snippets, schema settings, and JSON section references are distinct kinds. |
| Native Web Components | Enabled | Source-anchored only | Static HTML observed-attribute edits and placement | A tag enters the catalog only when `customElements.define` is present. |
| React Native / Expo | Source-only | Opt-in source-hash runtime bridge | Source-only placement/static props; visual writes disabled | JSX source is indexed under a separate dialect; native provenance never enters the web DOM protocol. |
| Flutter | Analyzer-backed source-only (opt-in) | Opt-in Widget Inspector/VM Service source-hash bridge | Disabled | Dart grammar/package resolution stays with the analyzer; native provenance is a separate integration. |

Capability flags are the contract behind this table. A useful read-only catalog
does not imply a runtime binding or a write capability. Dynamic values,
ambiguous source matches, stale hashes, unsupported route boundaries, and
unresolved imports remain visible as diagnostics and fail closed.

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
