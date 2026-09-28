# Component Canvas workspace architecture

Status: workspace shell, bounded canvas core, data-only registry generation,
loopback session/frame transport, and the reviewed Next App/Pages renderer
editing surface implemented. In Components mode the singleton Elements panel
is empty until a live component frame is selected; it then shows that frame's
component-rooted element tree and its descendants. Direct frame clicks, tree
selection, and hover stay synchronized, and the shared right-hand CSS dock
renders the existing Tailwind or CSS controls for the selected element. The
reviewed Next setup path remains behind versioned, project-scoped first-use
consent. A read-only preflight shows generated paths before consent; later
ephemeral sessions start automatically while that approval remains current.
Repository-wide typecheck, pattern/LOC checks, and the operator-approved final
gates remain release-validation work.

## Boundaries and trust model

The Components workspace keeps five state boundaries separate:

1. **Catalog data** is the parser/worker-produced component definition, props,
   slots, finite choices, source ranges, and immutable revision.
2. **Test cases/presets** contain only explicit component values and
   presentation settings. Generated defaults are labelled generated and are not
   treated as source defaults. Discrete finite values apply immediately, while
   text, number, and plain-text slot previews are debounced and cancelled when
   the selected preset changes.
3. **Canvas layout** is the versioned `component-canvas` document persisted in
   the approved project settings file. It contains opaque node IDs, preset
   references, positions, frame bounds, order, collapsed state, and an
   independent camera for Focus, Variants, and All Components.
4. **Renderer sessions** are ephemeral canvas-owned resources. A session has
   an opaque ID, random capability token, exact origin, generation, component
   allowlist, source revisions, and negotiated capability flags. It remains
   valid for the mounted Components canvas and is invalidated when that canvas
   exits.
5. **Editor selection** is ephemeral and may enable a write only after the host
   reports the selected descendant together with the selected frame/session
   proof. The component definition remains the only source boundary: every
   style, text, or structural write resolves the child through the current
   indexed definition revision and accepts it only when the returned source
   range and content hash are exact. Missing, ambiguous, dynamic, stale, or
   cross-definition results remain read-only rather than guessing a child
   range.

The catalog panel is a Preview-owned singleton, not a second canvas sidebar.
Preview stays mounted while another workspace mode occupies the main surface;
the panel body is portaled to the document, so its open/closed state, pinning,
selection, and user-resized dimensions survive Preview/Components and other
workspace-mode switches without remounting a duplicate catalog.

Project source is untrusted. The catalog parses bounded source snapshots and
the Components UI never imports project modules. When an adapter is enabled,
the project's own framework runtime owns the generated route/entry in a bounded
iframe or preview surface. Ship Studio receives typed protocol messages and
never mounts returned project HTML or JavaScript in the app webview/Tauri
process.

The main Tauri webview installs an all-frame privilege guard before the
inspector shim. Child project frames cannot use `__TAURI_INTERNALS__` or the
global Tauri invoke surface; the app bridge remains available only to the
trusted top-level Ship Studio frame, while the renderer protocol uses exact
origin and `postMessage` validation for its narrow capabilities.

## Renderer lifecycle

1. A read-only preflight validates the proposed temporary route/entry and shows
   its paths before the first project-scoped consent. Consent is stored with the
   renderer integration version, so a contract change requires approval again.
2. Tauri validates the project path, framework facts, registry allowlist, route
   collision, body bounds, and per-project session count.
3. The host returns protocol v2 session metadata. Every event is checked for
   exact `event.source`, origin, session, frame, token, generation, allowlist,
   and current component revision. Stale, replayed, malformed, or oversized
   messages fail closed. A frame must complete its handshake within the
   bounded ready timeout and continue sending heartbeats; lost heartbeats
   surface an isolated frame error. Generated hosts use an error boundary, and
   repeated failures open a per-frame circuit until the user explicitly retries.
4. The renderer keeps at most six iframe-backed frames loaded. Those slots are
   an access-ordered working set: selecting a canvas card promotes it and the
   six most recently accessed cards remain live. On startup, the same six-slot
   pool is automatically swept across every eligible canvas card: each live
   frame is captured before the next uncached card is promoted. The evicted
   card then renders that exact-input static image without executing project
   code; if capture is unavailable it shows an explicit paused state. Snapshot
   paths are retained only in the bounded, project-scoped in-memory cache and
   are never written into the canvas layout.
5. Closing a project, switching projects, canvas unmount, cancellation, or app
   exit invalidates the session. Cleanup may delete only generated files listed in
   the session manifest whose content hash still matches the recorded hash.
   Changed files are preserved and reported for recovery; broad recursive
   deletion is never permitted.

## CSP and development-origin review

The app's existing Tauri CSP setting remains unchanged (`csp: null` in
`src-tauri/tauri.conf.json`); the renderer work does not add a broad wildcard
relaxation to the privileged Ship Studio document. Renderer origins are still
validated as exact loopback origins in the session manager, and the frame is
sandboxed with only `allow-scripts allow-same-origin` so the project's runtime
can load its own CSS/providers and the inspector can communicate through the
negotiated channel. The parent posts only to the exact session origin, while
the frame validates the parent origin, session, token, generation, frame, and
component identity before accepting editor or accessibility messages. A future
static CSP must be reviewed against the dynamically allocated dev-server port;
it must not turn this into a general remote `frame-src` or `connect-src`
allowlist.

The TypeScript `RendererSessionManager` owns cancellation, per-project session
caps, replay rejection, message-rate bounds, and project invalidation. The Rust
`components::renderer` module mirrors the security critical session and cleanup
invariants for future Tauri commands: loopback origins only, bounded allowlists,
opaque UUID credentials, a token-authenticated loopback frame endpoint, atomic
manifests, and hash-checked cleanup. Neither layer accepts a source path or
module specifier as a frame request.

## Edit semantics and supported inputs

Visual changes from an isolated frame are **Edit main** operations: they modify
the validated component definition and therefore affect every use and every
canvas variant. Props, plain-text children, breakpoint, locale, background,
and frame dimensions remain test-case/presentation data and do not write CSS or
component source. Complex JSX, arbitrary JSON, dynamic expressions, free-text
matrices, number ranges, unknown children, provider inference, and arbitrary
imports are rejected rather than evaluated.

The inspector is enabled only when the selected live Next frame has a
negotiated editing capability, the current project passes the canonical editor
gate, and the selected element's source target is revalidated against the frame
session, component definition, indexed revision, file hash, and byte bounds.
Tailwind class writes, CSS cascade writes, inline text edits, and supported
structural edits reuse the existing hash/range-checked commands and the frame
host receives only exact-origin, session-bound mutation messages. The resolver
must return one exact child target inside the selected definition at action
time; source ambiguity, dynamic/unresolvable JSX, stale revisions/hashes, and
out-of-boundary targets fail closed. Edit main is still the first-write
confirmation boundary, so controls can be inspected read-only before the user
confirms a source mutation.

| Project dialect | Phase-one status | Notes |
| --- | --- | --- |
| Next App Router | Supported behind explicit setup | Generated host inherits root layout/providers and the fixture acceptance covers server/client boundaries. |
| Next Pages Router | Supported behind explicit setup | Generated host passes through `_app`; custom base path, locale, asset prefix, or middleware remains fail-closed. |
| React/Vite | Catalog-only | Requires a separately reviewed runtime/plugin contract; no Vite config mutation. |
| Astro, Vue, Svelte, Shopify, Web Components, native mobile | Catalog-only | A future adapter needs its own reviewed protocol and acceptance matrix. |

The current catalog-only state is a supported product state, not a renderer
error. It still supports browsing definitions and opening source. Once a
framework-hosted frame is live, the QA panel can capture the visible active
iframe through the existing native window-capture and
`crop_and_save_screenshot` path. It keeps only the returned project screenshot
path; it does not retain raw image bytes in the renderer or browser storage.
The same live frame can run a bounded accessibility pass inside the project
runtime. Results cross the session boundary only after exact origin, frame,
capability, and request checks; each finding is capped and carries a stable
DOM-path reference when one is available.

In development builds, the canvas exposes bounded counters for mounted logical
nodes, live iframes, input-to-transform latency, and camera long-frame counts
through the QA inspector and `data-renderer-*` attributes. These counters are
diagnostics only; the request/concurrency target remains centralized and the
1/6/25/100-node runtime benchmark remains a release prerequisite. The focused
`renderer-benchmark.test.ts` fixture exercises those four counts with exact
revision-keyed cached snapshots and records lifecycle CPU time plus process heap
delta when the test runtime exposes it. It runs in the Vitest/Node process, so it
has no display-scaling assumption and is not a substitute for the real framework
iframe benchmark. Its default scheduler still measures six live requests for
the 6/25/100-node cases (one for the single-node case); browser/runtime memory
and CPU evidence remains open before broader renderer rollout; the reviewed
Next editing gate is enabled only after the generated-host fixture acceptance.

The Vite spike is intentionally fail-closed: a source snapshot and static
registry do not prove that the detected dev server will transform and serve a
generated `.shipstudio/component-renderer` entry with the project's aliases,
base URL, CSS, assets, plugins, and HMR behavior. Until a separately reviewed
plugin/config contract exists, Vite remains catalog-only and setup explains the
required remediation. Ship Studio does not edit `vite.config.*` or emulate
Vite module loading.

## Flags and telemetry

`src/lib/components/feature-flags.ts` is the release gate. The reviewed Next
App/Pages renderer and its descendant editing capability are enabled, while
React/Vite rendering and editing remain off. The Next editing flag is consumed
only by the Next component-renderer session after parser-proven inspector
availability; the adapter-specific gate, exact-origin protocol envelope,
source-boundary resolver, and Edit-main confirmation remain mandatory. Enabling
the Next path exposes a read-only plan before first-use consent; it does not
write a route or execute project code until the user approves that versioned
integration. Later sessions start automatically from the stored approval.
Telemetry names are intentionally bounded: workspace open, scope change,
layout change, session/frame status, and Edit main lifecycle. Events must not
include source contents, props, tokens, local paths, rendered HTML, component
names, or project package names; counts use fixed buckets.

`src/lib/components/renderer-registry.ts` produces only a deterministic,
data-only registry from parser-proven React definitions. It rejects unsupported
dialects, unsafe paths, parser errors, ambiguous exports, and non-catalog
definitions. An adapter may turn an approved entry into a framework import only
inside the project's reviewed runtime host.

`src/lib/components/next-renderer-adapter.ts` produces a reviewable Next App
Router or Pages Router host plan with collision-safe route names, literal
registry imports, a server route/client shell split, explicit decorator and
stylesheet choices, and a bounded frame fetch. The plan is not enabled by
itself: writing it into a project requires a current project-scoped consent
record validated by Tauri and the adapter acceptance matrix.

For Pages Router projects, setup also inspects the source snapshot for custom
`basePath`, `assetPrefix`, locale routing, locale-like dynamic route segments,
and middleware. These facts are never evaluated. Any detected customization
keeps the plan catalog-only and surfaces the exact review guidance; setup never
rewrites middleware or silently assumes that the generated route is reachable.

## Architecture decision: host-native runtime plus bounded frames

The implementation uses framework-native hosts and bounded iframes because the
project's CSS, root layout, providers, server/client split, aliases, and HMR
semantics belong to the project's runtime. Importing project modules into the
Ship Studio webview would execute arbitrary project code in the privileged app
process, silently lose provider context, and make source identity impossible to
prove. A host-owned session preserves the runtime boundary while the v2
protocol limits inputs and validates every response.

Grida was inspected at commit `f6110ab6921fe50c1471cf8e077cb353c5569ad9` for
cursor-origin zoom, wheel/pinch discrimination, fit behavior, keyboard
shortcuts, and cancellable camera interpolation. There is no Grida runtime or
build dependency here, and no wholesale scene-engine port; the canvas uses a
small DOM world layer for bounded component frames. If code is ever copied
from Grida, the Apache-2.0 attribution and modified-file notice must be kept.

## Maintenance note for future adapters

An adapter must implement session preparation, static registry generation,
explicit setup review, host event validation, source-revision binding,
snapshot keys, cleanup/recovery, and its acceptance matrix without changing
the canvas document or editor target contracts. If it needs arbitrary module
execution in Ship Studio, user-config overwrites, or weaker origin security,
it is stopped and requires a separate architecture proposal.

## Implementation log

- Slice 1: Components workspace navigation, typed Cmd+K actions, catalog browser,
  and modal deprecation are implemented.
- Slice 2: Versioned canvas document, project-scoped persistence, deterministic
  layout, bounded variant expansion, camera gestures, and inspector states are
  implemented.
- Slice 3: Protocol v2 validation, replay/rate bounds, TypeScript session
  lifecycle, data-only React registry generation, Rust session store,
  token-authenticated loopback frame transport, reviewed host-file setup, and
  hash-checked cleanup manifest primitives are implemented and unit-tested.
- Slice 4 delivered: Next host planning, the explicit setup flow, the generic
  editable-surface validation contract, and the descendant-scoped inspector
  bridge are implemented. The generated App/Pages fixture acceptance covers
  tree, selection, hover, dirty refresh, editor previews, guarded writes, HMR
  reselect, identity rejection, cleanup, and the six-frame bound. CSS cascade,
  inline text, and supported structure edits reuse the exact resolver boundary;
  unsupported or unproven source mappings remain fail-closed.
- Focused UI coverage now exercises the canvas frame's unsupported,
  workspace-level renderer consent, paused, and live-frame states. The visual editor hook suite
  also proves negotiated component-frame origin/identity validation and
  mutation routing; these checks do not replace real framework-runtime QA.
- RendererFrameHost coverage verifies the sandbox/referrer policy and rejects
  messages from a hostile origin before they can reach workspace state.
- The focused Rust IPC-isolation regression test passes; the full Rust suite
  remains approval-dependent.
- The pinned Next App Router, Next Pages Router, and Vite fixture projects each
  pass a bounded production-build smoke check in an isolated temporary install.
  This proves the fixture inputs and dependency manifests are buildable; it
  does not claim generated-host route reachability, HMR, or full acceptance.
- Generated Next App Router and Pages Router hosts now pass authenticated
  runtime smoke checks through their fixture dev servers and the browser-like
  generated-host acceptance. Route segments avoid the underscore private-folder
  convention; Vite generated-host runtime, HMR, and full security acceptance
  remain out of scope for this release.
- Astro readiness is explicit in the UI: Astro nodes remain catalog-only until
  a reviewed Astro adapter exists, with the runtime/integration boundary named
  in the remediation reason.
- The Vite spike is implemented as a fail-closed assessment; it requires a
  separately reviewed plugin/config approach before any generated Vite entry.
- Remaining release validation: repository typecheck, pattern/LOC checks,
  operator-approved full frontend/Rust/CI gates, packaged platform QA, and
  continued acceptance coverage for future non-Next adapters. React, Vite,
  Astro, Vue, Svelte, Shopify, Web Components, and native mobile previews
  remain catalog-only for this DOM editing surface.
