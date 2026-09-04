# ADR: app-bundled parser runtime for native Components

## Decision

Keep component parsing inside the app-owned worker and pass only immutable,
project-relative source snapshots into it. Load parser libraries from Ship
Studio's bundle; never import project modules, run project config, load project
plugins, or shell out to the project's Node executable.

The parser set for the current roadmap slice is:

| Syntax | Package | Version | License | Loading/role |
| --- | --- | --- | --- | --- |
| TypeScript/JSX | `typescript` | repository-pinned | MIT | Worker-local React parser and literal/range helpers. |
| Astro | `@astrojs/compiler` | `4.0.0` | MIT | Lazy worker compiler; Vite emits `astro.wasm?url`. |
| Vue SFC | `@vue/compiler-sfc` | `3.5.42` | MIT | SFC block/diagnostic parsing; source ranges remain adapter-owned. |
| Svelte | `svelte` | `5.57.0` | MIT | `.svelte` parser; no Svelte project config is loaded. |
| Shopify Liquid | no package | — | — | Bounded Liquid/schema scanner and `JSON.parse` for theme schema. |
| Web Components | no package | — | — | Registration/HTML scanner; TypeScript literal parser for static values. |

The package versions are intentionally explicit so a parser upgrade is a
reviewable compatibility change. Each compiler-backed adapter must keep its
parser behind the worker boundary and expose diagnostics rather than throwing
unstructured UI errors.

## Why this runtime

The app already ships a TypeScript parser, so the worker protocol and cache can
be shared. Astro's compiler is needed for syntax validation that a scanner
cannot safely provide. Vue and Svelte need their own SFC/component grammars;
using a JSX parser for them would misclassify directives, slots, and script
boundaries. Shopify and custom elements benefit from small bounded scanners
because the supported feature is source-anchored and does not require a theme
renderer or browser custom-element registry.

Alternatives rejected:

- executing project builds or configs: unsafe, non-deterministic, and requires
  project dependencies/Node;
- parsing rendered DOM alone: loses component identity and source invocation
  ranges;
- adding DOM markers/wrappers: changes user layout/runtime semantics;
- one universal HTML/JSX parser: cannot faithfully distinguish framework
  directives or prove framework-specific writes;
- bundling every framework compiler eagerly: increases startup cost before the
  user opens Components.

## Bundle and startup evidence

The current Vite production build records:

- component worker JavaScript: 4,842.86 kB;
- Astro WASM asset: 5,166.91 kB, 1,426.08 kB gzip.

Measure a future parser change with the same command and record the generated
artifact sizes and first parser request latency in this ADR's change history.
The worker is lazy-created by `ComponentWorkerClient`; compiler modules are
loaded only when the corresponding request needs them. No project Node process
is part of the measurement.

## Smoke procedure

Run the focused worker test first:

```text
pnpm exec vitest run src/lib/components/component-worker.test.ts
pnpm build
```

For Tauri development, launch the normal desktop development app, open a
project containing one `.tsx` and one `.astro` definition, open Components,
and confirm the worker response reports protocol `1` and the expected source
component IDs. Confirm the app terminal has not started the project's Node
runtime for indexing.

For a packaged smoke, build the platform package using the repository's normal
Tauri release command, install/run it in a temporary test project, perform the
same Components request, and verify the bundled worker can load
`astro.wasm?url`. Record the platform, build revision, worker protocol, and
result in the release checklist. Do not mark the packaged milestone from a
Vite-only build.

## Consequences

Parser output is source evidence, not a runtime guarantee. Exact visual
instance binding remains an adapter capability. Every write still requires
hash/revision validation and a second parser/graph check at the Rust boundary.
When a compiler cannot prove a range or a dialect-specific transform, the UI
must show the source-backed read-only capability and refuse the write.
